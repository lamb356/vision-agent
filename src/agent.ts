import type { Page } from "playwright";
import type {
  AgentConfig,
  CombinedResult,
  StepResult,
  VerifyResult,
  GeminiSchema,
} from "./types.js";
import { callGemini, callGeminiParallel } from "./gemini.js";
import {
  COMBINED_PROMPT,
  START_PROMPT,
  combinedSchema,
  startSchema,
} from "./prompts.js";
import {
  screenshot,
  clickAt,
  typeText,
  pressEscape,
  waitForStability,
  extractCodesFromDOM,
} from "./browser.js";

const STEP_DEADLINE_MS = 45000;
const MAX_STEP_ATTEMPTS = 5;
const DISMISS_TIME_CAP_MS = 2500;
const MAX_DISMISS_ROUNDS = 3;
const MAX_SCOUT_BATCHES = 1;
const MAX_SCOUT_ACTIONS = 25;
const SCROLL_SWEEPS = 5;
const RADIO_BRUTEFORCE_LIMIT = 8;
const RUN_DEADLINE_MS = 10 * 60 * 1000;
const MAX_VISION_SKILL_TURNS = 12;
const MAX_STATE_REPEAT = 3;
const MAX_SCROLL_SEARCH_SWEEPS = 16;
const SCROLL_SEARCH_STEP_RATIO = 0.8;

const PRIMARY_SCOUT_PROMPT = `You are the PRIMARY solver for a browser-navigation challenge step.

Important:
- A 6-character code may NOT exist yet. Many steps require scrolling/clicking to reveal the code.
- There is no penalty for wrong clicks; controlled brute-force is allowed.
- Avoid obvious traps/popups like "You have won a prize!" unless your goal is to close them.

You receive:
- A screenshot
- A DOM snapshot with data-agent-eid on elements
- clickables include: eid, text/ariaLabel, visible, bbox=[x,y,w,h] in screenshot coordinates (viewport)

Goal:
- Reveal a valid code, then output a submit_code action; OR
- Navigate/modify the page state so the code becomes visible.

Valid code format:
- Exactly 6 alphanumeric characters and MUST contain at least 1 digit.
- Example: A1B2C3
- Invalid: REVEAL (no digit)

Return JSON with: { actions: AgentAction[], confidence: number }

AgentAction schema:
- { type: "dismiss_overlays" }
- { type: "click_eid", eid: string }
- { type: "type_eid", eid: string, text: string }
- { type: "check_eid", eid: string }
- { type: "select_eid_by_index", eid: string, index: number }
- { type: "scroll_eid_to_bottom", eid: string }
- { type: "press_key", key: "Enter" | "Escape" | "Tab" | "PageDown" | "End" }
- { type: "submit_code", code: string }

Rules:
- Use ONLY EIDs from the snapshot.
- Prefer actions that match the screenshot: choose the clickable whose bbox matches the button you intend to press.
- If the UI says to scroll, use press_key PageDown/End and/or scroll_eid_to_bottom on a page-level scrollable.
- You may output up to 25 actions.
- Keep the plan coherent and ordered (sequence matters).`;

const VISION_SKILL_PROMPT = `You are a deterministic vision-first browser navigation skill router.

Mission:
- Use the screenshot as the primary input.
- Use DOM JSON only as a compact supplement.
- Output EXACTLY ONE skill object per turn.

Context:
- Keep pushing the state forward one step at a time.
- Decoding is done by Playwright; you only choose a safe skill.

Allowed skills:
- scroll_search: scroll down the main page in small increments to reveal hidden content.
- click_candidate: click exactly one visible candidate EID (from top candidates list).
- submit_code: submit a 6-char alphanumeric code only if valid.
- explore: strategy switch when stuck (state repeated).

When choosing click_candidate, prefer the candidate from the Top-K list and avoid obvious traps.
When stuck (same state seen repeatedly), favor explore.

Return JSON matching:
{
  "skill": "<one of skills>",
  "params": {
    "eid": "<EID for click_candidate>",
    "code": "<6-char code for submit_code>",
    "maxScrolls": "<optional number>"
  },
  "reasoning": "short reason"
}

Reasoning should be brief and mention confidence, blockers, and why the chosen skill is safest.
`;

const VISION_SKILL_FEW_SHOT_EXAMPLES = `
Example decisions:
1) UI hints say "keep scrolling"; button list is long/uncertain.
{"skill":"scroll_search","params":{"maxScrolls":8},"reasoning":"Scrolling is required to reveal target below the fold."}

2) "Wrong Button" or popup text is visible; a close control is present.
{"skill":"explore","params":{},"reasoning":"Need to resolve popup pressure by switching strategy and probing alternatives."}

3) Vision shows one clear target candidate at bottom and it looks top-most/clickable.
{"skill":"click_candidate","params":{"eid":"E023"},"reasoning":"Best candidate is a standalone action target, no known blockers."}

4) A 6-char code is clearly visible near code-entry text.
{"skill":"submit_code","params":{"code":"A1B2C3"},"reasoning":"Code is present and ready to submit."}
`;

interface DOMSnapshot {
  url: string;
  stepHintText: string;
  codesFound: string[];
  activeDialogEid: string | null;
  dialogs: Array<{
    eid: string;
    visible: boolean;
    scrollable: boolean;
    textExcerpt: string;
    radioCount: number;
    checkboxCount: number;
    selectCount: number;
    buttons: Array<{ eid: string; text: string }>;
  }>;
  inputs: Array<{ eid: string; kind: string; placeholder: string }>;
  clickables: Array<{
    eid: string;
    tag: string;
    text: string;
    ariaLabel: string;
    inDialog: string | null;
    visible: boolean;
    topmostAtCenter: boolean;
    bbox: [number, number, number, number]; // [x,y,w,h] in viewport coords
  }>;
  scrollables: Array<{ eid: string; inDialog: string | null }>;
  features: {
    hasDialog: boolean;
    hasRadios: boolean;
    hasCheckboxes: boolean;
    hasSelects: boolean;
    hasScrollable: boolean;
    hasRevealText: boolean;
    hasClickHereText: boolean;
    hasCodeVisible: boolean;
    totalButtons: number;
    totalInputs: number;
  };
}

type AgentAction =
  | { type: "dismiss_overlays" }
  | { type: "click_eid"; eid: string }
  | { type: "type_eid"; eid: string; text: string }
  | { type: "check_eid"; eid: string }
  | { type: "select_eid_by_index"; eid: string; index: number }
  | { type: "scroll_eid_to_bottom"; eid: string }
  | { type: "press_key"; key: "Enter" | "Escape" | "Tab" | "PageDown" | "End" }
  | { type: "submit_code"; code: string };

interface ExecResult {
  success: boolean;
  codeFound: string | null;
  trapDetected: boolean;
  dialogDismissed: boolean;
}

interface Skill {
  id: string;
  match(snap: DOMSnapshot): boolean;
  run(page: Page, snap: DOMSnapshot, deadline: number, exclude?: Set<string>): Promise<SkillResult>;
}

interface SkillResult {
  code: string | null;
  actions_taken: number;
  elapsed_ms: number;
}

interface SkillLog {
  step: number;
  attempt: number;
  features: DOMSnapshot["features"];
  skillId: string;
  success: boolean;
  elapsed_ms: number;
  codeFound: string | null;
}

interface ScoutResult {
  actions: AgentAction[];
  confidence: number;
}

type VisionSkill = "scroll_search" | "click_candidate" | "submit_code" | "explore";

interface VisionSkillDecision {
  skill: VisionSkill;
  params: {
    eid?: string;
    code?: string;
    maxScrolls?: number;
  };
  reasoning: string;
}

const VISION_MAX_TOP_CANDIDATES = 8;

interface VisionSkillPlanState {
  stepSignature: string;
  repeatCount: number;
  stuck: boolean;
}

interface VisionSkillResult {
  success: boolean;
  code: string | null;
  changed: boolean;
  clickedEid: string | null;
  elapsed_ms: number;
}

interface CandidateForClick {
  eid: string;
  text: string;
  ariaLabel: string;
  visible: boolean;
  inDialog: string | null;
  score: number;
  topmostAtCenter: boolean;
  bbox: [number, number, number, number];
}

const visionSkillSchema: GeminiSchema = {
  type: "OBJECT",
  properties: {
    skill: {
      type: "STRING",
      enum: ["scroll_search", "click_candidate", "submit_code", "explore"],
      description: "Single skill for this turn.",
    },
    params: {
      type: "OBJECT",
      properties: {
        eid: { type: "STRING" },
        code: { type: "STRING" },
        maxScrolls: { type: "INTEGER" },
      },
    },
    reasoning: { type: "STRING" },
  },
  required: ["skill", "params", "reasoning"],
};

const stateRepeatLog: Map<string, number> = new Map();
const globalFailedCodes: Set<string> = new Set();

const scoutSchema: GeminiSchema = {
  type: "OBJECT",
  properties: {
    actions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: {
            type: "STRING",
            enum: [
              "click_eid",
              "type_eid",
              "check_eid",
              "select_eid_by_index",
              "scroll_eid_to_bottom",
              "press_key",
              "submit_code",
            ],
          },
          eid: { type: "STRING" },
          text: { type: "STRING" },
          index: { type: "INTEGER" },
          key: { type: "STRING" },
          code: { type: "STRING" },
        },
        required: ["type"],
      },
    },
    confidence: { type: "NUMBER" },
  },
  required: ["actions", "confidence"],
};

const skillLogs: SkillLog[] = [];

export function getSkillLogs(): SkillLog[] {
  return skillLogs;
}

function now(): number {
  return Date.now();
}

function withinDeadline(deadline: number): boolean {
  return now() < deadline;
}

function clampText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

// Extract codes ONLY from visible text (innerText), not attributes/hidden DOM.
// This prevents phantom codes like BJK5AQ that come from data-* attributes or hidden nodes.
interface VisibleCodeCandidate {
  code: string;
  context: string;
}

const CODE_CONTEXT_HINTS = /\\b(code|enter|submit|verification|verify|access|passcode|otp)\\b/i;
const CSS_UNIT_SUFFIX_RE = /^(?=.*\d)[A-Za-z0-9]+(px|ms|pt|em|rem|vh|vw|deg|ch|cm|mm|in|ex|s)$/i;
const UNIT_SUFFIX_ONLY_RE = /^(\d+)(px|ms|pt|em|rem|vh|vw|deg|ch|cm|mm|in|ex|s)$/i;

const EXTRACT_VISIBLE_CODES_SCRIPT = `(function() {
  var text = (document.body ? document.body.innerText : "") || "";
  var re = /\\b[A-Za-z0-9]{6}\\b/g;
  var out = [];
  var seen = {};
  var m;

  while ((m = re.exec(text)) && out.length < 40) {
    var idx = m.index;
    var c = m[0];
    if (seen[c]) continue;
    seen[c] = true;

    var start = Math.max(0, idx - 90);
    var end = Math.min(text.length, idx + c.length + 90);
    out.push({
      code: c,
      context: (text.substring(start, end) || "").toLowerCase(),
    });
  }
  return out;
})()`;

async function extractVisibleCodesWithContext(page: Page): Promise<VisibleCodeCandidate[]> {
  return (await page.evaluate(EXTRACT_VISIBLE_CODES_SCRIPT)) as VisibleCodeCandidate[];
}

async function extractVisibleCodes(page: Page): Promise<string[]> {
  const found = await extractVisibleCodesWithContext(page);
  return found.map((item) => item.code);
}

function isPlausibleCodeCandidate(code: string): boolean {
  const normalized = code.trim();
  if (!/^[A-Za-z0-9]{6}$/.test(normalized)) return false;
  if (!/(?=.*[A-Za-z])(?=.*[0-9])/.test(normalized)) return false;
  if (/^#?[0-9a-fA-F]{6}$/.test(normalized)) return false;
  if (CSS_UNIT_SUFFIX_RE.test(normalized.toLowerCase())) return false;
  if (UNIT_SUFFIX_ONLY_RE.test(normalized.toLowerCase())) return false;
  if (/^\d+[a-z]{1,3}$/i.test(normalized)) return false;
  if (normalized.toUpperCase().includes("PASS")) return false;
  return true;
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

// Log the DOM source of a phantom code once (debugging where it comes from)
const loggedDomOnlyCodes = new Set<string>();

async function logDomOnlyCodeSourceOnce(page: Page, code: string): Promise<void> {
  if (loggedDomOnlyCodes.has(code)) return;
  loggedDomOnlyCodes.add(code);

  const hits = await page
    .evaluate(`(function() {
      var code = ${JSON.stringify(code)};
      var out = [];
      var all = Array.from(document.querySelectorAll("*"));

      function isVisible(el) {
        var s = window.getComputedStyle(el);
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
      }

      for (var i = 0; i < all.length && out.length < 8; i++) {
        var el = all[i];
        var tag = (el.tagName || "").toLowerCase();
        var eid = el.getAttribute("data-agent-eid") || "";

        var text = (el.textContent || "");
        if (text && text.indexOf(code) !== -1) {
          out.push({ kind: "text", tag: tag, eid: eid, visible: isVisible(el), snippet: text.trim().slice(0, 180) });
          continue;
        }

        if (el.attributes) {
          for (var j = 0; j < el.attributes.length; j++) {
            var a = el.attributes[j];
            if (a && a.value && String(a.value).indexOf(code) !== -1) {
              out.push({ kind: "attr", tag: tag, eid: eid, visible: isVisible(el), attr: a.name, value: String(a.value).slice(0, 180) });
              break;
            }
          }
        }
      }
      return out;
    })()`)
    .catch(() => null);

  console.log(`[DOM_CODE_SOURCE] ${code} ${JSON.stringify(hits)}`);
}

function pickCode(codes: Array<{ code: string; score: number }>, exclude?: Set<string>): string | null {
  const normalized = codes
    .map((c) => c.code.trim())
    .filter((code) => isPlausibleCodeCandidate(code))
    .filter((code) => !exclude || !exclude.has(code));
  if (normalized.length > 0) return normalized[0];
  return null;
}

async function checkForCode(page: Page, exclude?: Set<string>): Promise<string | null> {
  const visible = await extractVisibleCodesWithContext(page).catch(() => []);
  const contextual = visible
    .filter((item) => isPlausibleCodeCandidate(item.code))
    .filter((item) => !exclude || !exclude.has(item.code))
    .filter((item) => CODE_CONTEXT_HINTS.test(item.context));
  if (contextual.length > 0) return contextual[0].code;

  const anywhere = visible
    .map((item) => item.code)
    .filter((code) => isPlausibleCodeCandidate(code))
    .filter((code) => !exclude || !exclude.has(code));
  if (anywhere.length > 0) return anywhere[0];

  // Debug: if extractCodesFromDOM is finding something that innerText doesn't contain,
  // log where it's coming from once (this is how you catch phantom data-attribute codes).
  const domCodes = await extractCodesFromDOM(page).catch(() => []);
  const domCandidate = pickCode(domCodes, exclude);
  if (domCandidate) {
    await logDomOnlyCodeSourceOnce(page, domCandidate);
  }

  return null;
}

interface HiddenCodeCandidate {
  code: string;
  tagName: string;
  className: string;
}

interface HiddenCodeScanResult {
  candidates: HiddenCodeCandidate[];
  scanned: number;
  rawMatches: number;
  filteredMatches: number;
}

async function extractHiddenCodesFromDOM(page: Page): Promise<HiddenCodeScanResult> {
  const found = await page.evaluate(() => {
    var forbidden: Record<string, boolean> = {
      submit: true,
      cancel: true,
      button: true,
      scroll: true,
      cookie: true,
      consent: true,
      warning: true,
      alert: true,
      next: true,
      proceed: true,
      advance: true,
      retry: true,
      close: true,
      confirm: true,
    };

    var re = /\\b[A-Za-z0-9]{6}\\b/g;
    var out = [];
    var seen: Record<string, true> = {};
    var nodes = Array.from(document.querySelectorAll("*"));
    var scanned = 0;
    var rawMatches = 0;
    var filteredMatches = 0;

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node) continue;
      scanned += 1;

      var snippets = [];
      if (node.textContent) snippets.push(node.textContent);
      if ((node as any).innerText) snippets.push((node as any).innerText);
      if ((node as any).value) snippets.push(String((node as any).value));

      if (node.attributes) {
        for (var j = 0; j < node.attributes.length; j++) {
          var attr = node.attributes[j];
          if (attr && /^data-/i.test(attr.name)) {
            snippets.push(String(attr.value || ""));
          }
        }
      }

      for (var s = 0; s < snippets.length; s++) {
        var text = snippets[s];
        if (!text) continue;
        var m;
        while ((m = re.exec(text)) !== null) {
          var code = String(m[0]).toUpperCase();
          rawMatches += 1;

          if (!/[A-Z]/.test(code) || !/[0-9]/.test(code)) {
            continue;
          }
          if (/^#?[0-9a-fA-F]{6}$/.test(code)) {
            continue;
          }
          if (forbidden[code.toLowerCase()]) {
            continue;
          }

          if (seen[code]) continue;
          seen[code] = true;
          filteredMatches += 1;
          out.push({
            code,
            tagName: (node.tagName || "").toLowerCase(),
            className: ((node.className || "") as any).toString()
          });
        }
        re.lastIndex = 0;
      }
    }

    return {
      candidates: out,
      scanned,
      rawMatches,
      filteredMatches
    };
  });

  return (found as HiddenCodeScanResult) || {
    candidates: [],
    scanned: 0,
    rawMatches: 0,
    filteredMatches: 0,
  };
}

async function detectTrap(page: Page): Promise<boolean> {
  const count = await page.locator("text=/Wrong Button|Wrong Choice|decoy/i").count().catch(() => 0);
  return count > 0;
}

async function getActiveDialogEid(page: Page): Promise<string | null> {
  return page.evaluate(`(function() {
    var dialogSelectors = [
      '[role="dialog"]', '.modal', '[class*="modal"]',
      '[class*="dialog"]', '.overlay', '.popup'
    ];
    var candidates = Array.from(
      document.querySelectorAll(dialogSelectors.join(","))
    ).filter(function(el) { return el.getAttribute("data-agent-eid"); });
    var visible = candidates.filter(function(el) {
      var style = window.getComputedStyle(el);
      var rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 &&
        style.display !== "none" && style.visibility !== "hidden" &&
        style.opacity !== "0";
    });
    if (visible.length === 0) return null;
    var sorted = visible.sort(function(a, b) {
      var za = Number(window.getComputedStyle(a).zIndex || 0);
      var zb = Number(window.getComputedStyle(b).zIndex || 0);
      return zb - za;
    });
    return sorted[0] ? sorted[0].getAttribute("data-agent-eid") : null;
  })()`) as Promise<string | null>;
}

async function injectEIDs(page: Page): Promise<number> {
  return page.evaluate(`(function() {
    var selectors = [
      'button', 'a', '[role="button"]', 'input[type="submit"]',
      'input[type="button"]', 'input', 'select', 'textarea',
      '[role="dialog"]', '.modal', '[class*="modal"]', '[class*="dialog"]',
      '.overlay', '.popup', '[onclick]'
    ];
    var elements = new Set();
    selectors.forEach(function(sel) {
      document.querySelectorAll(sel).forEach(function(el) { elements.add(el); });
    });
    document.querySelectorAll("*").forEach(function(el) {
      if (el.scrollHeight > el.clientHeight + 20) { elements.add(el); }
    });
    if (!window.__agentEidCounter) window.__agentEidCounter = 0;
    var assigned = 0;
    elements.forEach(function(el) {
      if (el.getAttribute("data-agent-eid")) return;
      window.__agentEidCounter += 1;
      var eid = "E" + String(window.__agentEidCounter).padStart(3, "0");
      el.setAttribute("data-agent-eid", eid);
      assigned += 1;
    });
    return assigned;
  })()`) as Promise<number>;
}

// String-based evaluate to avoid tsx injecting __name helpers into the browser context
const CAPTURE_DOM_SNAPSHOT_SCRIPT = `(function() {
  var dialogSelectors = [
    '[role="dialog"]',
    '.modal',
    '[class*="modal"]',
    '[class*="dialog"]',
    '.overlay',
    '.popup'
  ];

  var buttonSelectors = [
    'button',
    '[role="button"]',
    'input[type="button"]',
    'input[type="submit"]',
    'a'
  ];

  function isVisible(el) {
    var style = window.getComputedStyle(el);
    var rect = el.getBoundingClientRect();
    var vw = window.innerWidth || 0;
    var vh = window.innerHeight || 0;
    var inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;

    return (
      rect.width > 0 &&
      rect.height > 0 &&
      inViewport &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  }

  function textOf(el) {
    if (!el) return "";
    return (el.innerText || el.textContent || "").trim();
  }

  function truncate(text, maxLen) {
    return text.length > maxLen ? text.slice(0, maxLen) : text;
  }

  function isTopmostAtPoint(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var cx = rect.x + rect.width / 2;
    var cy = rect.y + rect.height / 2;
    if (!isFinite(cx) || !isFinite(cy)) return false;
    var top = document.elementFromPoint(cx, cy);
    return top === el || (top && el.contains(top));
  }

  var dialogElements = Array.from(
    document.querySelectorAll(dialogSelectors.join(","))
  ).filter(function(el) { return el.getAttribute("data-agent-eid"); });

  var visibleDialogs = dialogElements.filter(isVisible);

  var sortedDialogs = visibleDialogs.slice().sort(function(a, b) {
    var za = Number(window.getComputedStyle(a).zIndex || 0);
    var zb = Number(window.getComputedStyle(b).zIndex || 0);
    return zb - za;
  });

  var activeDialogEid = sortedDialogs[0] ? sortedDialogs[0].getAttribute("data-agent-eid") : null;

  var dialogs = dialogElements.map(function(dialog) {
    var eid = dialog.getAttribute("data-agent-eid") || "";
    var buttons = Array.from(
      dialog.querySelectorAll(buttonSelectors.join(","))
    )
      .filter(function(btn) { return btn.getAttribute("data-agent-eid"); })
      .map(function(btn) {
        return {
          eid: btn.getAttribute("data-agent-eid") || "",
          text: truncate(textOf(btn), 60)
        };
      });

    var radios = dialog.querySelectorAll('input[type="radio"]').length;
    var checkboxes = dialog.querySelectorAll('input[type="checkbox"]').length;
    var selects = dialog.querySelectorAll('select').length;

    return {
      eid: eid,
      visible: isVisible(dialog),
      scrollable: dialog.scrollHeight > dialog.clientHeight + 20,
      textExcerpt: truncate(textOf(dialog), 300),
      radioCount: radios,
      checkboxCount: checkboxes,
      selectCount: selects,
      buttons: buttons
    };
  });

  var inputs = Array.from(
    document.querySelectorAll('input, select, textarea')
  )
    .filter(function(el) { return el.getAttribute("data-agent-eid"); })
    .map(function(el) {
      var tag = el.tagName.toLowerCase();
      var kind = tag === "input" ? (el.type || "text") : tag;
      return {
        eid: el.getAttribute("data-agent-eid") || "",
        kind: kind,
        placeholder: truncate(
          (el.placeholder || el.getAttribute("aria-label") || ""),
          80
        )
      };
    });

  var clickables = Array.from(
    document.querySelectorAll(buttonSelectors.join(","))
  )
    .filter(function(el) { return el.getAttribute("data-agent-eid"); })
    .map(function(el) {
      var parent = el.parentElement;
      var inDialog = null;
      while (parent) {
        if (dialogSelectors.some(function(sel) { return parent && parent.matches(sel); })) {
          inDialog = parent.getAttribute("data-agent-eid");
          break;
        }
        parent = parent.parentElement;
      }

      var rect = el.getBoundingClientRect();

      return {
        eid: el.getAttribute("data-agent-eid") || "",
        tag: el.tagName.toLowerCase(),
        text: truncate(textOf(el), 80),
        ariaLabel: truncate(el.getAttribute("aria-label") || "", 80),
        inDialog: inDialog,
        visible: isVisible(el),
        topmostAtCenter: isTopmostAtPoint(el),
        bbox: [
          Math.round(rect.x),
          Math.round(rect.y),
          Math.round(rect.width),
          Math.round(rect.height)
        ]
      };
    });

  var scrollables = Array.from(document.querySelectorAll("*"))
    .filter(function(el) { return el.getAttribute("data-agent-eid"); })
    .filter(function(el) { return el.scrollHeight > el.clientHeight + 20; })
    .map(function(el) {
      var parent = el.parentElement;
      var inDialog = null;
      while (parent) {
        if (dialogSelectors.some(function(sel) { return parent && parent.matches(sel); })) {
          inDialog = parent.getAttribute("data-agent-eid");
          break;
        }
        parent = parent.parentElement;
      }
      return { eid: el.getAttribute("data-agent-eid") || "", inDialog: inDialog };
    });

  var bodyText = truncate((document.body ? document.body.innerText : "").trim(), 800);
  var hasCodeVisible = /\\b(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{6}\\b/.test(bodyText);
  var hasRevealText = /(reveal|show|unlock|display)/i.test(bodyText);
  var hasClickHereText = /(click here|click\\s+\\d+\\s+times)/i.test(bodyText);

  return {
    url: window.location.href,
    stepHintText: truncate(bodyText, 200),
    activeDialogEid: activeDialogEid,
    dialogs: dialogs,
    inputs: inputs,
    clickables: clickables,
    scrollables: scrollables,
    features: {
      hasDialog: visibleDialogs.length > 0,
      hasRadios: document.querySelectorAll('input[type="radio"]').length > 0,
      hasCheckboxes: document.querySelectorAll('input[type="checkbox"]').length > 0,
      hasSelects: document.querySelectorAll('select').length > 0,
      hasScrollable: scrollables.length > 0,
      hasRevealText: hasRevealText,
      hasClickHereText: hasClickHereText,
      hasCodeVisible: hasCodeVisible,
      totalButtons: document.querySelectorAll(buttonSelectors.join(",")).length,
      totalInputs: document.querySelectorAll('input, select, textarea').length
    }
  };
})()`;

async function captureDOMSnapshot(page: Page): Promise<DOMSnapshot> {
  const codeList = (await extractVisibleCodes(page))
    .map((c) => c.trim())
    .filter(isPlausibleCodeCandidate);

  const snapshot = await page.evaluate(CAPTURE_DOM_SNAPSHOT_SCRIPT) as any;

  return {
    ...snapshot,
    codesFound: codeList,
    stepHintText: clampText(snapshot.stepHintText, 200),
    dialogs: snapshot.dialogs.map((d: any) => ({
      ...d,
      textExcerpt: clampText(d.textExcerpt, 300),
      buttons: d.buttons.map((b: any) => ({
        ...b,
        text: clampText(b.text, 60),
      })),
    })),
    inputs: snapshot.inputs.map((i: any) => ({
      ...i,
      placeholder: clampText(i.placeholder, 80),
    })),
    clickables: snapshot.clickables.map((c: any) => ({
      ...c,
      text: clampText(c.text, 80),
      ariaLabel: clampText(c.ariaLabel, 80),
    })),
  };
}

async function executeAction(page: Page, action: AgentAction): Promise<ExecResult> {
  const beforeDialog = await getActiveDialogEid(page);
  let success = true;

  try {
    if (action.type === "dismiss_overlays") {
      await dismissOverlays(page, now() + DISMISS_TIME_CAP_MS);
    } else if (action.type === "click_eid") {
      try {
        await page
          .locator(`[data-agent-eid="${action.eid}"]`)
          .click({ timeout: 800 });
      } catch {
        return { success: false, codeFound: null, trapDetected: false, dialogDismissed: false };
      }
    } else if (action.type === "type_eid") {
      await page
        .locator(`[data-agent-eid="${action.eid}"]`)
        .click({ timeout: 800 });
      await typeText(page, action.text);
    } else if (action.type === "check_eid") {
      const loc = page.locator(`[data-agent-eid="${action.eid}"]`);
      await loc.click({ timeout: 800 });
    } else if (action.type === "select_eid_by_index") {
      await page
        .locator(`[data-agent-eid="${action.eid}"]`)
        .selectOption({ index: action.index });
    } else if (action.type === "scroll_eid_to_bottom") {
      await page.evaluate(`(function(eid) {
        var el = document.querySelector('[data-agent-eid="' + eid + '"]');
        if (el) { el.scrollTop = el.scrollHeight; }
      })("${action.eid}")`);
    } else if (action.type === "press_key") {
      await page.keyboard.press(action.key);
    } else if (action.type === "submit_code") {
      // handled elsewhere
    }
  } catch {
    success = false;
  }

  const codeFound = await checkForCode(page);
  const trapDetected = await detectTrap(page);
  const afterDialog = await getActiveDialogEid(page);

  return {
    success,
    codeFound,
    trapDetected,
    dialogDismissed: beforeDialog !== null && afterDialog === null,
  };
}

async function restoreOverlayShields(page: Page): Promise<void> {
  await page.evaluate(`(function() {
    var shielded = document.querySelectorAll('[data-overlay-shield="1"]');
    for (var i = 0; i < shielded.length; i++) {
      var node = shielded[i];
      if (!(node instanceof HTMLElement)) continue;
      var previousVisibility = node.getAttribute("data-overlay-shield-old-visibility");
      if (previousVisibility && previousVisibility.length > 0) {
        node.style.visibility = previousVisibility;
      } else {
        node.style.removeProperty("visibility");
      }
      node.removeAttribute("data-overlay-shield");
      node.removeAttribute("data-overlay-shield-old-visibility");
      node.removeAttribute("data-overlay-shield-old-pointer-events");
    }
  })()`).catch(() => undefined);
}

async function nukeOverlays(page: Page): Promise<number> {
  return page
    .evaluate(() => {
    var all = document.querySelectorAll("*");
    var vw = window.innerWidth || 1;
    var vh = window.innerHeight || 1;
    var vArea = vw * vh;
    var decoyPattern = /cookie|consent|newsletter|subscribe|warning|alert|limited time|special offer/i;
    var codePattern = /\\b[A-Z0-9]{6}\\b/i;
    var skipped = [];
    var nuked = 0;

    for (var i = 0; i < all.length; i++) {
      var el = all[i] as HTMLElement;
      if (el.closest("body") !== document.body) continue;

      var style = window.getComputedStyle(el);
      var position = style.position;
      if (position !== "fixed" && position !== "absolute") continue;
      if (el.dataset && el.dataset.nuked === "true") continue;

      var rect = el.getBoundingClientRect();
      var area = Math.max(0, rect.width) * Math.max(0, rect.height);
      var big = area > vArea * 0.3;
      var text = (el.textContent || "").toUpperCase();
      var z = parseInt(style.zIndex || "0", 10);
      var highZ = !isNaN(z) && z > 100;
      var decoy = decoyPattern.test(text) && (position === "fixed" || position === "absolute" || highZ);

      if (big || decoy) {
        if (codePattern.test(text)) {
          var tag = (el.tagName || "unknown").toLowerCase();
          var classes = (el.className || "").toString().trim().replace(/\\s+/g, ".");
          skipped.push(classes ? `${tag}.${classes}` : tag);
          continue;
        }
        var current = el.style.display || "";
        if (current !== "none") {
          el.style.display = "none";
          el.dataset.nuked = "true";
          nuked += 1;
        }
      }
    }

    return { nuked, skipped };
  })
    .then((result) => {
      const typed = result as { nuked: number; skipped: string[] } | null;
      if (typed && typed.skipped && typed.skipped.length > 0) {
        console.log(`[NUKE_SKIP] preserving potential code elements: ${typed.skipped.join(", ")}`);
      }
      return typed?.nuked ?? 0;
    })
    .catch(() => 0);
}

async function dismissOverlays(page: Page, deadline: number): Promise<void> {
  // Reversible overlay cleanup: click close controls + Escape, fallback to visibility shim.
  await page.evaluate(`(function() {
    var toDisable = [];
    var all = document.querySelectorAll("*");
    var vw = window.innerWidth || 1;
    var vh = window.innerHeight || 1;
    var vArea = vw * vh;

    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var style = window.getComputedStyle(el);
      if (style.position !== "fixed" && style.position !== "absolute") continue;

      if (el.closest("body") !== document.body) continue;

      var z = parseInt(style.zIndex || "0", 10);
      if (isNaN(z) || z < 90) continue;

      var text = (el.innerText || "").toLowerCase();
      var rect = el.getBoundingClientRect();
      var area = Math.max(0, rect.width) * Math.max(0, rect.height);
      var big = area > vArea * 0.2;
      var hasKeyword = /prize|won|congratulations|winner|reward|alert|wrong button|wrong choice|prize popup/i.test(text);
      var semiTransparent = (parseFloat(style.opacity || "1") < 1);
      var isBackdrop = big && el.children.length === 0 && text.length < 60;

      if ((hasKeyword || isBackdrop || (semiTransparent && big)) && big) {
        toDisable.push(el);
      }
    }

    for (var j = 0; j < toDisable.length; j++) {
      var overlay = toDisable[j];
      var closeText = overlay.querySelector('button[aria-label="Close"], [aria-label*="close" i], .close-button, .btn-close, [data-dismiss], [data-bs-dismiss]');
      if (closeText) {
        try { closeText.click(); } catch (_) {}
      }

      if (overlay.dataset && overlay.dataset.overlayShield === "1") continue;

      var oldVisibility = overlay.style.visibility || "";
      var usedSemanticClose = false;
      if (closeText) {
        try { closeText.click(); usedSemanticClose = true; } catch (_) {}
      }

      if (!usedSemanticClose) {
        overlay.style.visibility = "hidden";
        if (overlay instanceof HTMLElement) {
          overlay.dataset.overlayShield = "1";
          overlay.dataset.overlayShieldOldVisibility = oldVisibility;
        }
      }
    }
  })()`).catch(() => undefined);

  const dismissSelectors = [
    // aria / common classes
    '[aria-label*="close" i]',
    '[aria-label*="dismiss" i]',
    '[aria-label*="exit" i]',
    '.close-button',
    '.close-btn',
    '.dismiss-button',
    '.dismiss-btn',
    '.modal-close',
    '.btn-close',
    '[data-dismiss]',
    '[data-bs-dismiss]',

    // explicit button text (prize/alert popups often use these)
    'button:has-text("Close")',
    'button:has-text("OK")',
    'button:has-text("Ok")',
    'button:has-text("Got it")',
    'button:has-text("No thanks")',
    'button:has-text("×")',
    'button:has-text("X")',
  ];

  for (let round = 0; round < MAX_DISMISS_ROUNDS && withinDeadline(deadline); round += 1) {
    let dismissed = 0;
    for (const sel of dismissSelectors) {
      if (!withinDeadline(deadline)) break;
    const loc = page.locator(sel);
    const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count && withinDeadline(deadline); i += 1) {
        const target = loc.nth(i);
        if (await target.isVisible({ timeout: 200 }).catch(() => false)) {
          await target.click({ timeout: 500 }).catch(() => undefined);
          dismissed += 1;
          await waitForStability(page, 150);
        }
      }
    }
    await pressEscape(page);
    await waitForStability(page, 150);

    if (dismissed === 0) return;
  }
}

async function selectSubmitButton(
  page: Page,
  inputEid?: string | null
): Promise<string | null> {
  const eidArg = inputEid ?? "";
  return page.evaluate(`(function() {
    var inputEl = null;
    var inputEid = "${eidArg}";
    if (inputEid) {
      inputEl = document.querySelector('[data-agent-eid="' + inputEid + '"]');
    }

    function isVis(el) {
      var s = window.getComputedStyle(el);
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    }

    // (a) If input is inside a <form>, pick first visible submit in that form
    if (inputEl) {
      var form = inputEl.closest("form");
      if (form) {
        var formBtns = form.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])');
        for (var i = 0; i < formBtns.length; i++) {
          if (isVis(formBtns[i]) && formBtns[i].getAttribute("data-agent-eid")) {
            return formBtns[i].getAttribute("data-agent-eid");
          }
        }
      }
    }

    function isTopmost(el) {
      var r = el.getBoundingClientRect();
      var cx = r.x + r.width / 2;
      var cy = r.y + r.height / 2;
      if (!isFinite(cx) || !isFinite(cy)) return false;
      var top = document.elementFromPoint(cx, cy);
      return top === el || (top && el.contains(top));
    }

    // Gather all visible buttons with EIDs
    var allBtns = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]'));
    var visibleAll = allBtns.filter(function(b) { return isVis(b) && b.getAttribute("data-agent-eid"); });
    var visibleTop = visibleAll.filter(function(b) { return isTopmost(b); });

    // Prefer truly clickable (topmost) buttons if we have any
    var visible = visibleTop.length > 0 ? visibleTop : visibleAll;

    var kw = /submit|confirm|continue|next|send|ok|go/i;
    var prioritized = visible.filter(function(b) {
      var t = (b.innerText || b.textContent || "").trim();
      return kw.test(t) || kw.test(b.getAttribute("aria-label") || "");
    });

    // (b) If we have an input, pick closest button by bounding-box distance
    if (inputEl && visible.length > 0) {
      var ir = inputEl.getBoundingClientRect();
      var pool = prioritized.length > 0 ? prioritized : visible;
      pool.sort(function(a, b) {
        var ar = a.getBoundingClientRect(); var br = b.getBoundingClientRect();
        var da = Math.hypot(ar.x + ar.width/2 - ir.x - ir.width/2, ar.y + ar.height/2 - ir.y - ir.height/2);
        var db = Math.hypot(br.x + br.width/2 - ir.x - ir.width/2, br.y + br.height/2 - ir.y - ir.height/2);
        return da - db;
      });
      return pool[0].getAttribute("data-agent-eid");
    }

    if (prioritized.length > 0) return prioritized[0].getAttribute("data-agent-eid");
    if (visible.length > 0) return visible[0].getAttribute("data-agent-eid");
    return null;
  })()`) as Promise<string | null>;
}

function selectInputEid(snap: DOMSnapshot): string | null {
  const input = snap.inputs.find((i) =>
    i.kind === "text" || i.kind === "" || i.kind === "search" || i.kind === "email"
  );
  if (input) return input.eid;
  return snap.inputs.find((i) => i.kind !== "hidden")?.eid ?? null;
}

async function submitCodeWithSnapshot(
  page: Page,
  snap: DOMSnapshot,
  code: string
): Promise<void> {
  const inputEid = selectInputEid(snap);
  console.log(`  [SUBMIT] code="${code}" inputEid=${inputEid ?? "no input EID found"}`);
  if (inputEid) {
    const locator = page.locator(`[data-agent-eid="${inputEid}"]`);
    await locator.click({ timeout: 800 }).catch(() => undefined);
    await locator.click({ clickCount: 3, timeout: 800 }).catch(() => undefined);
    await typeText(page, code);
  } else {
    await typeText(page, code);
  }

  const submitEid = await selectSubmitButton(page, inputEid);
  console.log(`  [SUBMIT] submitEid=${submitEid ?? "no submit EID found"}`);
  if (submitEid) {
    const submitLoc = page.locator(`[data-agent-eid="${submitEid}"]`);
    try {
      await submitLoc.click({ timeout: 800 });
      console.log(`  [SUBMIT] click succeeded`);
    } catch {
      console.log(`  [SUBMIT] click failed, dismissing overlays and retrying`);
      await dismissOverlays(page, now() + DISMISS_TIME_CAP_MS);
      try {
        await submitLoc.click({ timeout: 800 });
        console.log(`  [SUBMIT] retry click succeeded`);
      } catch {
        console.log(`  [SUBMIT] retry failed, attempting JS click`);

        const jsClicked = await page
          .evaluate(`(function(eid) {
            var el = document.querySelector('[data-agent-eid="' + eid + '"]');
            if (!el) return false;
            try { el.click(); return true; } catch (e) { return false; }
          })("${submitEid}")`)
          .catch(() => false);

        if (jsClicked) {
          console.log(`  [SUBMIT] JS click dispatched`);
        } else {
          console.log(`  [SUBMIT] JS click failed, pressing Enter fallback`);
          if (inputEid) {
            await page.locator(`[data-agent-eid="${inputEid}"]`).press("Enter").catch(() => undefined);
          } else {
            await page.keyboard.press("Enter").catch(() => undefined);
          }
        }
      }
    }
  } else {
    console.log(`  [SUBMIT] no submit button, pressing Enter`);
    if (inputEid) {
      await page.locator(`[data-agent-eid="${inputEid}"]`).press("Enter").catch(() => undefined);
    } else {
      await page.keyboard.press("Enter").catch(() => undefined);
    }
  }

  await waitForStability(page, 300);
}

async function submitCodeSafe(page: Page, code: string, deadline: number): Promise<void> {
  await injectEIDs(page);
  const snap = await captureDOMSnapshot(page);
  await dismissOverlays(page, Math.min(deadline, now() + DISMISS_TIME_CAP_MS));
  await submitCodeWithSnapshot(page, snap, code);
}

async function verifyStep(page: Page, expectedStep: number): Promise<VerifyResult> {
  const bodyText = await page.evaluate("document.body ? document.body.innerText : ''") as string;
  const match = bodyText.match(/Step\s+(\d+)\s+of\s+30/i);
  const current_step = match ? Number(match[1]) : expectedStep;
  const completed = /(congratulations|completed|well done)/i.test(bodyText);
  return {
    current_step,
    advanced: current_step > expectedStep || completed,
    error_message: "",
    completed,
  };
}

async function getRadioOptionsInDialog(
  page: Page,
  dialogEid: string
): Promise<Array<{ eid: string; label: string }>> {
  return page.evaluate(`(function() {
    var dialog = document.querySelector('[data-agent-eid="${dialogEid}"]');
    if (!dialog) return [];
    var radios = Array.from(dialog.querySelectorAll('input[type="radio"]'))
      .filter(function(radio) { return radio.getAttribute("data-agent-eid"); })
      .map(function(radio) {
        var labelText = "";
        if (radio.id) {
          var label = dialog.querySelector('label[for="' + radio.id + '"]');
          if (label) labelText = (label.textContent || "").trim();
        }
        if (!labelText) {
          var parentLabel = radio.closest("label");
          if (parentLabel) labelText = (parentLabel.textContent || "").trim();
        }
        return {
          eid: radio.getAttribute("data-agent-eid") || "",
          label: labelText
        };
      });
    return radios;
  })()`) as Promise<Array<{ eid: string; label: string }>>;
}

async function selectLastOption(page: Page, eid: string): Promise<void> {
  const count = await page.evaluate(`(function() {
    var select = document.querySelector('[data-agent-eid="${eid}"]');
    return select && select.options ? select.options.length : 0;
  })()`) as number;

  if (count > 0) {
    await page
      .locator(`[data-agent-eid="${eid}"]`)
      .selectOption({ index: count - 1 });
  }
}

async function runSkill(
  page: Page,
  snap: DOMSnapshot,
  deadline: number,
  skill: Skill,
  stepNumber: number,
  attempt: number,
  exclude?: Set<string>
): Promise<SkillResult> {
  const start = now();
  let result: SkillResult = { code: null, actions_taken: 0, elapsed_ms: 0 };
  if (!skill.match(snap)) {
    result.elapsed_ms = now() - start;
    return result;
  }

  result = await skill.run(page, snap, deadline, exclude);

  const log: SkillLog = {
    step: stepNumber,
    attempt,
    features: snap.features,
    skillId: skill.id,
    success: Boolean(result.code),
    elapsed_ms: result.elapsed_ms,
    codeFound: result.code,
  };
  skillLogs.push(log);
  console.log(`[SKILL_LOG] ${JSON.stringify(log)}`);
  return result;
}

const DirectCodeSkill: Skill = {
  id: "direct_code",
  match: (snap) => snap.codesFound.length > 0,
  run: async (_page, snap, _deadline, exclude) => ({
    code: snap.codesFound.filter((c) => !exclude || !exclude.has(c))[0] ?? null,
    actions_taken: 0,
    elapsed_ms: 0,
  }),
};

const OverlayCleanerSkill: Skill = {
  id: "overlay_cleaner",
  match: () => true,
  run: async (page, _snap, deadline) => {
    const start = now();
    let actions = 0;
    await dismissOverlays(page, Math.min(deadline, now() + DISMISS_TIME_CAP_MS));
    actions += 1;
    const code = await checkForCode(page);
    return { code, actions_taken: actions, elapsed_ms: now() - start };
  },
};

const RevealButtonSkill: Skill = {
  id: "reveal_button",
  match: (snap) => snap.clickables.some((c) => /reveal|show|code|unlock|display/i.test(c.text + c.ariaLabel)),
  run: async (page, snap, deadline) => {
    const start = now();
    let actions = 0;

    const ariaLoc = page.locator('[aria-label*="reveal" i], [aria-label*="show" i], [aria-label*="unlock" i], [aria-label*="display" i]');
    const ariaCount = await ariaLoc.count().catch(() => 0);
    for (let i = 0; i < ariaCount && withinDeadline(deadline); i += 1) {
      await ariaLoc.nth(i).click({ timeout: 800 }).catch(() => undefined);
      actions += 1;
      const code = await checkForCode(page);
      if (code) {
        return { code, actions_taken: actions, elapsed_ms: now() - start };
      }
      if (await detectTrap(page)) break;
    }

    for (const clickable of snap.clickables) {
      if (!withinDeadline(deadline)) break;
      if (!/reveal|show|code|unlock|display/i.test(clickable.text + clickable.ariaLabel)) continue;
      const exec = await executeAction(page, { type: "click_eid", eid: clickable.eid });
      actions += 1;
      if (exec.codeFound) {
        return { code: exec.codeFound, actions_taken: actions, elapsed_ms: now() - start };
      }
      if (exec.trapDetected) break;
    }

    return { code: null, actions_taken: actions, elapsed_ms: now() - start };
  },
};

const DialogRadioSkill: Skill = {
  id: "dialog_radio",
  match: (snap) => {
    if (!snap.activeDialogEid) return false;
    const dialog = snap.dialogs.find((d) => d.eid === snap.activeDialogEid);
    return Boolean(dialog && dialog.radioCount > 0);
  },
  run: async (page, snap, deadline) => {
    const start = now();
    let actions = 0;
    const dialogEid = snap.activeDialogEid;
    if (!dialogEid) return { code: null, actions_taken: 0, elapsed_ms: now() - start };

    const scrollables = snap.scrollables.filter((s) => s.inDialog === dialogEid || s.eid === dialogEid);
    for (const scrollable of scrollables) {
      if (!withinDeadline(deadline)) break;
      await executeAction(page, { type: "scroll_eid_to_bottom", eid: scrollable.eid });
      actions += 1;
    }

    const radios = await getRadioOptionsInDialog(page, dialogEid);
    const prioritized = radios.find((r) => /correct/i.test(r.label));
    const ordered = prioritized ? [prioritized, ...radios.filter((r) => r !== prioritized)] : radios;

    for (const radio of ordered.slice(0, RADIO_BRUTEFORCE_LIMIT)) {
      if (!withinDeadline(deadline)) break;
      const exec = await executeAction(page, { type: "click_eid", eid: radio.eid });
      actions += 1;
      if (exec.codeFound) {
        return { code: exec.codeFound, actions_taken: actions, elapsed_ms: now() - start };
      }
      if (exec.trapDetected) break;

      const submitEid = await selectSubmitButton(page);
      if (submitEid) {
        const submitResult = await executeAction(page, { type: "click_eid", eid: submitEid });
        actions += 1;
        if (submitResult.codeFound) {
          return { code: submitResult.codeFound, actions_taken: actions, elapsed_ms: now() - start };
        }
        if (submitResult.trapDetected) break;
      }
    }

    return { code: null, actions_taken: actions, elapsed_ms: now() - start };
  },
};

const DialogScrollSkill: Skill = {
  id: "dialog_scroll",
  match: (snap) => {
    if (!snap.activeDialogEid) return false;
    return snap.scrollables.some((s) => s.inDialog === snap.activeDialogEid);
  },
  run: async (page, snap, deadline) => {
    const start = now();
    let actions = 0;
    const dialogEid = snap.activeDialogEid;
    if (!dialogEid) return { code: null, actions_taken: 0, elapsed_ms: now() - start };

    const scrollables = snap.scrollables.filter((s) => s.inDialog === dialogEid || s.eid === dialogEid);
    for (const scrollable of scrollables) {
      for (let sweep = 0; sweep < SCROLL_SWEEPS && withinDeadline(deadline); sweep += 1) {
        await executeAction(page, { type: "scroll_eid_to_bottom", eid: scrollable.eid });
        actions += 1;
        const code = await checkForCode(page);
        if (code) {
          return { code, actions_taken: actions, elapsed_ms: now() - start };
        }
      }
    }

    return { code: null, actions_taken: actions, elapsed_ms: now() - start };
  },
};

const ClickHereSkill: Skill = {
  id: "click_here",
  match: (snap) => snap.features.hasClickHereText,
  run: async (page, snap, deadline) => {
    const start = now();
    let actions = 0;

    const bodyText = await page.evaluate("document.body ? document.body.innerText : ''") as string;
    const match = bodyText.match(/click\s+(\d+)\s+times/i);
    const clickCount = match ? Math.min(Number(match[1]), 6) : 3;

    const target = snap.clickables.find((c) => /click here/i.test(c.text + c.ariaLabel));
    if (!target) return { code: null, actions_taken: 0, elapsed_ms: now() - start };

    for (let i = 0; i < clickCount && withinDeadline(deadline); i += 1) {
      const exec = await executeAction(page, { type: "click_eid", eid: target.eid });
      actions += 1;
      if (exec.codeFound) {
        return { code: exec.codeFound, actions_taken: actions, elapsed_ms: now() - start };
      }
      if (exec.trapDetected) break;
    }

    return { code: null, actions_taken: actions, elapsed_ms: now() - start };
  },
};

const CheckboxSkill: Skill = {
  id: "checkbox",
  match: (snap) => snap.features.hasCheckboxes,
  run: async (page, snap, deadline) => {
    const start = now();
    let actions = 0;

    const checkboxes = await page.locator('input[type="checkbox"]').all();
    for (const checkbox of checkboxes) {
      if (!withinDeadline(deadline)) break;
      if (await checkbox.isVisible().catch(() => false)) {
        await checkbox.click({ timeout: 800 }).catch(() => undefined);
        actions += 1;
        const code = await checkForCode(page);
        if (code) return { code, actions_taken: actions, elapsed_ms: now() - start };
        if (await detectTrap(page)) break;
      }
    }

    const submitEid = await selectSubmitButton(page);
    if (submitEid) {
      const exec = await executeAction(page, { type: "click_eid", eid: submitEid });
      actions += 1;
      if (exec.codeFound) {
        return { code: exec.codeFound, actions_taken: actions, elapsed_ms: now() - start };
      }
    }

    return { code: null, actions_taken: actions, elapsed_ms: now() - start };
  },
};

const DropdownSkill: Skill = {
  id: "dropdown",
  match: (snap) => snap.features.hasSelects,
  run: async (page, snap, deadline) => {
    const start = now();
    let actions = 0;

    for (const input of snap.inputs.filter((i) => i.kind === "select")) {
      if (!withinDeadline(deadline)) break;
      await selectLastOption(page, input.eid);
      actions += 1;
      const code = await checkForCode(page);
      if (code) return { code, actions_taken: actions, elapsed_ms: now() - start };
      if (await detectTrap(page)) break;
    }

    const submitEid = await selectSubmitButton(page);
    if (submitEid) {
      const exec = await executeAction(page, { type: "click_eid", eid: submitEid });
      actions += 1;
      if (exec.codeFound) {
        return { code: exec.codeFound, actions_taken: actions, elapsed_ms: now() - start };
      }
    }

    return { code: null, actions_taken: actions, elapsed_ms: now() - start };
  },
};

const skills: Skill[] = [
  DirectCodeSkill,
  OverlayCleanerSkill,
  RevealButtonSkill,
  DialogRadioSkill,
  DialogScrollSkill,
  ClickHereSkill,
  CheckboxSkill,
  DropdownSkill,
];

function compactSnapshot(snap: DOMSnapshot): string {
  const kwPriority = /submit|reveal|show|close|dismiss|confirm|continue|next|code|unlock/i;
  const prioritized = snap.clickables.filter((c) => kwPriority.test(c.text + c.ariaLabel));
  const rest = snap.clickables.filter((c) => !kwPriority.test(c.text + c.ariaLabel));
  const clickables = [...prioritized, ...rest].slice(0, 60);

  const compact: Record<string, unknown> = {
    url: snap.url,
    stepHintText: snap.stepHintText,
    codesFound: snap.codesFound,
    activeDialogEid: snap.activeDialogEid,
    dialogs: snap.dialogs.filter((d) => d.visible).slice(0, 3),
    inputs: snap.inputs.slice(0, 25),
    clickables,
    scrollables: snap.scrollables.slice(0, 25),
    features: snap.features,
  };
  return JSON.stringify(compact);
}

async function buildScoutActions(
  page: Page,
  config: AgentConfig,
  snap: DOMSnapshot
): Promise<AgentAction[]> {
  const snapshotJson = compactSnapshot(snap);
  const img = await screenshot(page, "scout");

  // Run 3 identical primary scouts for redundancy, then pick highest-confidence plan.
  const calls = [
    { prompt: `${PRIMARY_SCOUT_PROMPT}\n\nSNAPSHOT:\n${snapshotJson}`, schema: scoutSchema, thinkingBudget: 128 },
    { prompt: `${PRIMARY_SCOUT_PROMPT}\n\nSNAPSHOT:\n${snapshotJson}`, schema: scoutSchema, thinkingBudget: 128 },
    { prompt: `${PRIMARY_SCOUT_PROMPT}\n\nSNAPSHOT:\n${snapshotJson}`, schema: scoutSchema, thinkingBudget: 128 },
  ];

  const results = await callGeminiParallel<[ScoutResult, ScoutResult, ScoutResult]>(
    config.apiKey,
    calls,
    img
  );

  // DEBUG: log the full Gemini outputs (before we filter hallucinated EIDs / cap repeats)
  console.log(`[SCOUT_RAW_RESULTS] ${JSON.stringify(results)}`);

  const candidates = results
    .map((r) => r.parsed)
    .filter((p): p is ScoutResult => Boolean(p && Array.isArray(p.actions)));

  const best = candidates.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];

  const rawActions = best?.actions ?? [];

  // Filter hallucinated EIDs but preserve order (sequence matters)
  const knownEids = new Set<string>([
    ...snap.clickables.map((c) => c.eid),
    ...snap.inputs.map((i) => i.eid),
    ...snap.scrollables.map((s) => s.eid),
    ...snap.dialogs.map((d) => d.eid),
  ]);

  const filtered: AgentAction[] = [];

  // Allow repeats (e.g. many PageDown presses), but cap obvious loops.
  const repeatCounts = new Map<string, number>();

  const repeatKey = (action: AgentAction): string => {
    if (action.type === "press_key") return `${action.type}-${action.key}`;
    if (action.type === "submit_code") return `${action.type}-${action.code}`;
    // @ts-ignore
    if (action.eid) return `${action.type}-${action.eid}`;
    return action.type;
  };

  const repeatCap = (action: AgentAction): number => {
    if (action.type === "submit_code") return 1;
    if (action.type === "dismiss_overlays") return 3;
    if (action.type === "press_key") return 15;           // keep many PageDowns
    if (action.type === "click_eid") return 8;            // allow brute-force clicking
    if (action.type === "scroll_eid_to_bottom") return 8;
    if (action.type === "check_eid") return 6;
    return 3; // type_eid / select_eid_by_index
  };

  for (const action of rawActions) {
    const needsEid =
      action.type === "click_eid" ||
      action.type === "type_eid" ||
      action.type === "check_eid" ||
      action.type === "select_eid_by_index" ||
      action.type === "scroll_eid_to_bottom";

    if (needsEid) {
      // @ts-ignore - narrowed by action.type at runtime
      if (!action.eid || !knownEids.has(action.eid)) continue;
    }

    if (action.type === "type_eid") {
      // @ts-ignore
      if (typeof action.text !== "string") continue;
    }

    if (action.type === "select_eid_by_index") {
      // @ts-ignore
      if (typeof action.index !== "number") continue;
    }

    if (action.type === "submit_code") {
      // @ts-ignore
      if (typeof action.code !== "string") continue;
    }

    const k = repeatKey(action);
    const n = (repeatCounts.get(k) ?? 0) + 1;
    if (n > repeatCap(action)) continue;
    repeatCounts.set(k, n);

    filtered.push(action);
  }

  console.log(`[SCOUT_LOG] ${JSON.stringify({ confidence: best?.confidence ?? 0, rawCount: rawActions.length, actionCount: filtered.length })}`);
  return filtered.slice(0, MAX_SCOUT_ACTIONS);
}

function buildStateSignature(snap: DOMSnapshot, scrollY: number): string {
  return JSON.stringify({
    url: snap.url,
    stepHint: snap.stepHintText.slice(0, 90).toLowerCase(),
    activeDialog: snap.activeDialogEid ?? "none",
    codeCount: snap.codesFound.length,
    visibleButtons: snap.clickables.filter((c) => c.visible).length,
    totalButtons: snap.features.totalButtons,
    totalInputs: snap.features.totalInputs,
    hasCodeVisible: snap.features.hasCodeVisible,
    hasRevealText: snap.features.hasRevealText,
    scrollBucket: Math.round(scrollY / 50),
  });
}

async function readScrollY(page: Page): Promise<number> {
  return page.evaluate("Math.max(0, Math.round(window.scrollY || 0))") as Promise<number>;
}

function scoreCandidateForVision(c: DOMSnapshot["clickables"][number]): number {
  let score = 0;
  const signal = `${c.text} ${c.ariaLabel}`.toLowerCase();

  if (c.visible) score += 4;
  if (c.topmostAtCenter) score += 3;

  if (/(navigation|continue|next|proceed|advance|go|open|submit|confirm|send|code|start)/i.test(signal)) score += 3;
  if (/(wrong|wrong button|wrong choice|alert|prize|won|decoy|try this|click here|next page)/i.test(signal)) score -= 3;

  return score;
}

function buildTopCandidates(snap: DOMSnapshot): CandidateForClick[] {
  return snap.clickables
    .filter((c) => c.visible)
    .map((c) => ({
      eid: c.eid,
      text: c.text,
      ariaLabel: c.ariaLabel,
      visible: c.visible,
      inDialog: c.inDialog,
      topmostAtCenter: c.topmostAtCenter,
      score: scoreCandidateForVision(c),
      bbox: c.bbox,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, VISION_MAX_TOP_CANDIDATES);
}

async function captureVisionScreenshot(
  page: Page,
  candidates: CandidateForClick[],
  label: string
): Promise<string> {
  await nukeOverlays(page).catch(() => undefined);

  await page.evaluate((items: CandidateForClick[]) => {
    const previous = document.querySelectorAll('[data-som-overlay="1"]');
    previous.forEach((node) => node.remove());

    const layer = document.createElement("div");
    layer.setAttribute("data-som-overlay", "1");
    layer.style.position = "fixed";
    layer.style.inset = "0";
    layer.style.pointerEvents = "none";
    layer.style.zIndex = "2147483647";

    for (const item of items) {
      const box = item.bbox;
      if (!box || box[2] <= 0 || box[3] <= 0) continue;
      const x = Math.max(0, Math.round(box[0]));
      const y = Math.max(0, Math.round(box[1]));
      const w = Math.max(1, Math.round(box[2]));
      const h = Math.max(1, Math.round(box[3]));

      const rect = document.createElement("div");
      rect.style.position = "fixed";
      rect.style.left = `${x}px`;
      rect.style.top = `${y}px`;
      rect.style.width = `${w}px`;
      rect.style.height = `${h}px`;
      rect.style.border = "2px solid #ff6f00";
      rect.style.boxSizing = "border-box";
      rect.style.background = "rgba(255, 111, 0, 0.08)";
      rect.style.color = "#ff6f00";
      rect.style.font = "bold 12px Arial, sans-serif";
      rect.style.textShadow = "0 0 3px rgba(0,0,0,0.7)";

      const tag = document.createElement("div");
      tag.textContent = item.eid;
      tag.style.position = "absolute";
      tag.style.left = "2px";
      tag.style.top = "2px";
      tag.style.fontWeight = "700";
      tag.style.fontSize = "11px";
      tag.style.color = "#111";
      tag.style.background = "#ff6f00";
      tag.style.padding = "1px 3px";
      rect.appendChild(tag);
      layer.appendChild(rect);
    }

    document.body.appendChild(layer);
  }, candidates).catch(() => undefined);

  const encoded = await screenshot(page, label);
  await page.evaluate(`(function() { var nodes = document.querySelectorAll('[data-som-overlay="1"]'); nodes.forEach((n) => n.remove()); })()`)
    .catch(() => undefined);
  return encoded;
}

function buildVisionPrompt(
  snap: DOMSnapshot,
  stepNumber: number,
  attempt: number,
  turn: number,
  state: VisionSkillPlanState,
  candidates: CandidateForClick[],
  failedCodes: string[]
): string {
  const payload = {
    mission: "Pick exactly one safe skill for this turn.",
    step_number: stepNumber,
    attempt,
    turn,
    state_repeat_count: state.repeatCount,
    stuck: state.stuck,
    step_hint: snap.stepHintText.slice(0, 180),
    visible_codes: snap.codesFound.slice(0, 6),
    features: snap.features,
    failedCodes: failedCodes.slice(0, 12),
    top_candidates: candidates,
  };

  const failedLine = failedCodes.length > 0
    ? `\n\nPreviously failed codes (do NOT re-submit these): ${failedCodes.join(", ")}`
    : "\n\nPreviously failed codes (do NOT re-submit these): none";

  return `${VISION_SKILL_PROMPT}\n\n${VISION_SKILL_FEW_SHOT_EXAMPLES}${failedLine}\n\nSTATE_JSON:\n${JSON.stringify(payload)}`;
}

function sanitizeVisionDecision(
  parsed: VisionSkillDecision,
  snap: DOMSnapshot,
  state: VisionSkillPlanState,
  triedCodes?: Set<string>,
  forceNonSubmit?: boolean,
  consecutiveScrollFails?: number
): VisionSkillDecision {
  const valid = new Set<VisionSkill>([
    "scroll_search",
    "click_candidate",
    "submit_code",
    "explore",
  ]);
  const knownEids = new Set(snap.clickables.map((c) => c.eid));

  if (!valid.has(parsed.skill)) {
    parsed.skill = state.stuck ? "explore" : "scroll_search";
    parsed.params = {};
  }

  if (parsed.skill === "scroll_search") {
    if (consecutiveScrollFails !== undefined && consecutiveScrollFails >= 2) {
      const candidates = buildTopCandidates(snap);
      const fallback = candidates[0]?.eid ? "click_candidate" : "explore";
      parsed.skill = fallback;
      parsed.params = fallback === "click_candidate" ? { eid: candidates[0].eid } : {};
      console.log("[SCROLL_CAP] scroll_search capped after 2 fails, overriding to " + fallback);
    }

    const max = parsed.params?.maxScrolls ?? MAX_SCROLL_SEARCH_SWEEPS;
    parsed.params.maxScrolls = Math.max(1, Math.min(MAX_SCROLL_SEARCH_SWEEPS, max));
  }

  if (parsed.skill === "click_candidate") {
    const candidates = buildTopCandidates(snap);
    const desired = parsed.params?.eid?.trim();
    if (!desired || !knownEids.has(desired)) {
      parsed.params.eid = candidates[0]?.eid;
      if (!parsed.params.eid) {
        parsed.skill = state.stuck ? "explore" : "scroll_search";
      }
    }
  }

  if (parsed.skill === "submit_code") {
    const code = (parsed.params?.code ?? "").trim().toUpperCase();
    const tried = triedCodes ? triedCodes.has(code) : false;
    if (!isPlausibleCodeCandidate(code) || Boolean(forceNonSubmit) || tried) {
      const candidates = buildTopCandidates(snap);
      if (candidates[0]?.eid) {
        parsed.skill = "click_candidate";
        parsed.params = { eid: candidates[0].eid };
      } else {
        parsed.skill = "scroll_search";
        parsed.params = {};
      }
    } else {
      parsed.params.code = code;
    }
  }

  parsed.reasoning = parsed.reasoning?.trim() || `fallback: ${parsed.skill}`;
  return parsed;
}

async function chooseVisionSkill(
  page: Page,
  config: AgentConfig,
  snap: DOMSnapshot,
  stepNumber: number,
  attempt: number,
  turn: number,
  state: VisionSkillPlanState,
  triedCodes: Set<string>,
  forceNonSubmit?: boolean,
  consecutiveScrollFails?: number
): Promise<VisionSkillDecision> {
  const candidates = buildTopCandidates(snap);
  if (state.stuck) {
    return {
      skill: "explore",
      params: {},
      reasoning: "state repeated; switching strategy",
    };
  }

  try {
    const failedCodes = Array.from(triedCodes).filter(isPlausibleCodeCandidate);
    const prompt = buildVisionPrompt(
      snap,
      stepNumber,
      attempt,
      turn,
      state,
      candidates,
      failedCodes
    );
    const img = await captureVisionScreenshot(
      page,
      candidates,
      `vision-step-${stepNumber}-a${attempt}-t${turn}`
    );
    const raw = await callGemini<VisionSkillDecision>(
      config.apiKey,
      prompt,
      img,
      visionSkillSchema,
      256
    );

    const parsed = sanitizeVisionDecision(raw.parsed, snap, state, triedCodes, forceNonSubmit, consecutiveScrollFails);
    return parsed;
  } catch (err) {
    console.log(`  [VISION_DECISION] fallback decision due to Gemini error: ${err instanceof Error ? err.message : `${err}`}`);
    return {
      skill: candidates[0]?.eid ? "click_candidate" : "scroll_search",
      params: candidates[0]?.eid ? { eid: candidates[0].eid } : {},
      reasoning: "fallback after Vision model failure",
    };
  }
}

async function runVisionSkill(
  page: Page,
  decision: VisionSkillDecision,
  snap: DOMSnapshot,
  deadline: number,
  turn: number,
  triedCodes: Set<string>,
  beforeSignature: string,
  exploredPass: number,
  triedEids: Set<string>
): Promise<VisionSkillResult> {
  const start = now();
  const result: VisionSkillResult = {
    success: false,
    code: null,
    changed: false,
    clickedEid: null,
    elapsed_ms: 0,
  };

  if (decision.skill === "scroll_search") {
    const maxScrolls = Math.min(MAX_SCROLL_SEARCH_SWEEPS, Math.max(1, decision.params.maxScrolls ?? 6));
    let lastSignature = beforeSignature;
    for (let i = 0; i < maxScrolls && withinDeadline(deadline); i += 1) {
      const beforeY = await readScrollY(page);
      const viewport = (await page.evaluate("Math.max(1, Math.round(window.innerHeight || 1))")) as number;
      const delta = Math.max(160, Math.round(viewport * SCROLL_SEARCH_STEP_RATIO));
      await page.mouse.wheel(0, delta);
      await waitForStability(page, 170);
      await dismissOverlays(page, Math.min(deadline, now() + 700));

      const found = await checkForCode(page, triedCodes);
      if (found) {
        result.success = true;
        result.code = found;
        result.changed = true;
        result.elapsed_ms = now() - start;
        return result;
      }

      const afterSnap = await captureDOMSnapshot(page);
      const currentSig = buildStateSignature(afterSnap, await readScrollY(page));
      result.changed = result.changed || currentSig !== lastSignature;
      lastSignature = currentSig;

      const afterY = await readScrollY(page);
      if (afterY <= beforeY) {
        console.log("  [SCROLL_SEARCH] reached bottom or blocked");
        break;
      }
    }

    result.elapsed_ms = now() - start;
    return result;
  }

  if (decision.skill === "click_candidate") {
    const eid = decision.params.eid?.trim();
    if (!eid) {
      result.elapsed_ms = now() - start;
      return result;
    }

    const candidate = snap.clickables.find((c) => c.eid === eid);
    if (!candidate || !candidate.visible) {
      result.elapsed_ms = now() - start;
      return result;
    }

    if (!candidate.topmostAtCenter) {
      await dismissOverlays(page, Math.min(deadline, now() + 1200));
      await waitForStability(page, 100);
    }

    result.success = true;
    triedEids.add(eid);
    result.clickedEid = eid;
    try {
      await page.locator(`[data-agent-eid="${eid}"]`).click({ timeout: 900 });
    } catch {
      const jsClicked = await page
        .evaluate(`(function(eid) {
          var el = document.querySelector('[data-agent-eid="' + eid + '"]');
          if (!el) return false;
          try { el.click(); return true; } catch (e) { return false; }
        })("${eid}")`)
        .catch(() => false);
      if (!jsClicked) {
        await page.keyboard.press("Enter").catch(() => undefined);
      }
    }
    await waitForStability(page, 250);

    const code = await checkForCode(page, triedCodes);
    if (code) {
      result.code = code;
    }
    result.changed = true;
    result.elapsed_ms = now() - start;
    return result;
  }

  if (decision.skill === "submit_code") {
    const code = (decision.params.code || "").trim().toUpperCase();
    if (isPlausibleCodeCandidate(code)) {
      result.success = true;
      result.code = code;
      result.changed = true;
    }
    result.elapsed_ms = now() - start;
    return result;
  }

  // explore fallback strategy
  const strategy = Math.max(1, exploredPass);
  await restoreOverlayShields(page);

  if (strategy === 1) {
    await page
      .evaluate(`(function() {
        var scrolling = document.scrollingElement || document.documentElement || document.body;
        if (scrolling) scrolling.scrollTo(0, scrolling.scrollHeight || 0);
      })()`)
      .catch(() => undefined);
  } else if (strategy === 2) {
    const ranked = buildTopCandidates(snap);
    const candidate = ranked.find((item) => !triedEids.has(item.eid));
    if (candidate) {
      result.success = true;
      result.clickedEid = candidate.eid;
      triedEids.add(candidate.eid);
      try {
        await page.locator(`[data-agent-eid="${candidate.eid}"]`).click({ timeout: 900 });
      } catch {
        const jsClicked = await page
          .evaluate(`(function(eid) {
            var el = document.querySelector('[data-agent-eid="' + eid + '"]');
            if (!el) return false;
            try { el.click(); return true; } catch (e) { return false; }
          })("${candidate.eid}")`)
          .catch(() => false);
        if (!jsClicked) {
          await page.keyboard.press("Enter").catch(() => undefined);
        }
      }
    }
  } else if (strategy === 3) {
    for (let i = 0; i < 3; i += 1) {
      await pressEscape(page).catch(() => undefined);
      await waitForStability(page, 70);
    }
    await page.evaluate(`(function() {
      var scrolling = document.scrollingElement || document.documentElement || document.body;
      if (!scrolling) return;
      var target = Math.max(0, Math.floor((scrolling.scrollHeight - window.innerHeight) / 2));
      scrolling.scrollTo(0, target);
    })()`).catch(() => undefined);
  } else {
    const maxScrollY = await page
      .evaluate(() => {
        var scrolling = document.scrollingElement || document.documentElement || document.body;
        if (!scrolling) return 0;
        return Math.max(0, scrolling.scrollHeight - window.innerHeight);
      })
      .catch(() => 0) as number;
    const randomY = maxScrollY > 0 ? Math.floor(Math.random() * (maxScrollY + 1)) : 0;
    await page
      .evaluate(`(function(y) {
        var scrolling = document.scrollingElement || document.documentElement || document.body;
        if (scrolling) scrolling.scrollTo(0, y);
      })(${randomY})`)
      .catch(() => undefined);
    await dismissOverlays(page, Math.min(deadline, now() + 900));
  }

  await waitForStability(page, 180);
  const after = await captureDOMSnapshot(page);
  result.changed = buildStateSignature(after, await readScrollY(page)) !== beforeSignature;
  result.success = result.success || result.changed;
  result.elapsed_ms = now() - start;
  return result;
}

async function solveStep(
  page: Page,
  config: AgentConfig,
  stepNumber: number,
  attempt: number
): Promise<{ success: boolean; error?: string }> {
  const deadline = now() + STEP_DEADLINE_MS;
  const triedCodes = new Set<string>(globalFailedCodes);
  const triedEids = new Set<string>();
  let explorePass = 0;
  let forceNonSubmit = false;
  let consecutiveScrollFails = 0;
  stateRepeatLog.clear();

  const preLoopScan = await extractHiddenCodesFromDOM(page).catch(() => ({
    candidates: [],
    scanned: 0,
    rawMatches: 0,
    filteredMatches: 0,
  }));
  console.log(`[DOM_SCAN] scanned ${preLoopScan.scanned} elements, found ${preLoopScan.rawMatches} raw matches, ${preLoopScan.filteredMatches} after filtering`);
  const freshHiddenCode = preLoopScan.candidates.find((candidate) => !triedCodes.has(candidate.code));
  if (freshHiddenCode) {
    const normalizedCode = normalizeCode(freshHiddenCode.code);
    const classes = freshHiddenCode.className
      .split(/\s+/)
      .filter(Boolean)
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .join(".");
    const tagRef = classes ? `${freshHiddenCode.tagName}.${classes}` : freshHiddenCode.tagName;
    console.log(`  [DOM_HIDDEN_CODE] found code ${normalizedCode} in hidden element ${tagRef}`);

    await submitCodeSafe(page, normalizedCode, deadline);
    const verify = await verifyStep(page, stepNumber);
    if (verify.advanced || verify.completed) return { success: true };
    triedCodes.add(normalizedCode);
    globalFailedCodes.add(normalizedCode);
    console.log(`  [STALE] code ${normalizedCode} failed, added to triedCodes`);
    await waitForStability(page, 100);
  }

  for (let turn = 1; turn <= MAX_VISION_SKILL_TURNS && withinDeadline(deadline); turn += 1) {
    await restoreOverlayShields(page);
    await injectEIDs(page);
    await dismissOverlays(page, Math.min(deadline, now() + DISMISS_TIME_CAP_MS));

    const snap = await captureDOMSnapshot(page);
    const verifyBefore = await verifyStep(page, stepNumber);
    if (verifyBefore.advanced || verifyBefore.completed) {
      return { success: true };
    }

    if (snap.features.hasCodeVisible) {
      const visibleScan = await extractHiddenCodesFromDOM(page).catch(() => ({
        candidates: [],
        scanned: 0,
        rawMatches: 0,
        filteredMatches: 0,
      }));
      console.log(`[DOM_SCAN] scanned ${visibleScan.scanned} elements, found ${visibleScan.rawMatches} raw matches, ${visibleScan.filteredMatches} after filtering`);

      const freshVisibleCode = visibleScan.candidates.find((candidate) => !triedCodes.has(candidate.code));
      if (freshVisibleCode) {
        const normalizedCode = normalizeCode(freshVisibleCode.code);
        console.log(`  [VISIBLE_CODE_EXTRACT] found fresh code ${normalizedCode}, submitting directly`);
        await submitCodeSafe(page, normalizedCode, deadline);
        const visibleVerify = await verifyStep(page, stepNumber);
        if (visibleVerify.advanced || visibleVerify.completed) return { success: true };
        triedCodes.add(normalizedCode);
        globalFailedCodes.add(normalizedCode);
        console.log(`  [STALE] code ${normalizedCode} failed, added to triedCodes`);
        await waitForStability(page, 100);
        continue;
      }
    }

    const immediateCode = await checkForCode(page, triedCodes);
    if (immediateCode) {
      const normalizedCode = normalizeCode(immediateCode);
      console.log(`  [VISION_FASTPATH] code found before decision: ${normalizedCode}`);
      if (triedCodes.has(normalizedCode)) {
        console.log(`  [FASTPATH_SKIP] code ${normalizedCode} already tried`);
        forceNonSubmit = true;
      } else {
        await submitCodeSafe(page, normalizedCode, deadline);
        const verify = await verifyStep(page, stepNumber);
        if (verify.advanced || verify.completed) return { success: true };
        triedCodes.add(normalizedCode);
        globalFailedCodes.add(normalizedCode);
        console.log(`  [STALE] code ${normalizedCode} failed, added to triedCodes`);
      }
      await waitForStability(page, 100);
    }

    const currentSignature = buildStateSignature(snap, await readScrollY(page));
    const repeats = (stateRepeatLog.get(currentSignature) ?? 0) + 1;
    stateRepeatLog.set(currentSignature, repeats);

    const state: VisionSkillPlanState = {
      stepSignature: currentSignature,
      repeatCount: repeats,
      stuck: repeats >= MAX_STATE_REPEAT,
    };

    const decision = await chooseVisionSkill(
      page,
      config,
      snap,
      stepNumber,
      attempt,
      turn,
      state,
      triedCodes,
      forceNonSubmit,
      consecutiveScrollFails
    );
    forceNonSubmit = false;

    if (decision.skill === "explore") {
      explorePass += 1;
    }

    console.log(`[VISION_DECISION] turn=${turn} step=${stepNumber} attempt=${attempt} skill=${decision.skill} reasoning=${decision.reasoning}`);

    const result = await runVisionSkill(
      page,
      decision,
      snap,
      deadline,
      turn,
      triedCodes,
      currentSignature,
      explorePass,
      triedEids
    );

    const skillLog: SkillLog = {
      step: stepNumber,
      attempt,
      features: snap.features,
      skillId: decision.skill,
      success: result.success,
      elapsed_ms: result.elapsed_ms,
      codeFound: result.code,
    };
    skillLogs.push(skillLog);
    console.log(`[VISION_SKILL] ${JSON.stringify(skillLog)}`);

    if (result.code) {
      const normalizedCode = normalizeCode(result.code);
      if (triedCodes.has(normalizedCode)) {
        console.log(`  [STALE_SKIP] code ${normalizedCode} already tried, skipping`);
        forceNonSubmit = true;
        await waitForStability(page, 120);
        continue;
      }

      console.log(`  [VISION_CODE] submitting returned code ${normalizedCode}`);
      await submitCodeSafe(page, normalizedCode, deadline);
      const verify = await verifyStep(page, stepNumber);
      if (verify.advanced || verify.completed) return { success: true };
      triedCodes.add(normalizedCode);
      globalFailedCodes.add(normalizedCode);
      console.log(`  [STALE] code ${normalizedCode} failed, added to triedCodes`);
      await waitForStability(page, 100);
    }

    if (decision.skill === "scroll_search") {
      if (!result.success) {
        consecutiveScrollFails += 1;
      } else {
        consecutiveScrollFails = 0;
      }
    } else if (result.success) {
      consecutiveScrollFails = 0;
    }

    const verifyAfter = await verifyStep(page, stepNumber);
    if (verifyAfter.advanced || verifyAfter.completed) {
      return { success: true };
    }

    const postSnap = await captureDOMSnapshot(page);
    const postSignature = buildStateSignature(postSnap, await readScrollY(page));
    if (!result.changed && postSignature === currentSignature) {
      console.log(`  [VISION_LOOP] turn=${turn} no state change`);
    }

    if (turn === MAX_VISION_SKILL_TURNS && !result.changed) {
      console.log(`  [VISION_WARN] no change after max turns for step ${stepNumber}`);
    }
  }

  return { success: false, error: "Step deadline exceeded" };
}

export async function runStartPhase(page: Page, config: AgentConfig): Promise<void> {
  console.log("\n--- START PHASE ---");
  await waitForStability(page, 800);

  const startUrl = config.url;
  if (page.url() !== startUrl) {
    await page.goto(startUrl, { waitUntil: "domcontentloaded" });
  }

  const selectorCandidates = [
    'button:has-text("Start")',
    'a:has-text("Start")',
    '[role="button"]:has-text("Start")',
    'text=/START|Start|BEGIN|Begin/',
  ];

  for (const selector of selectorCandidates) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) {
      await page.locator(selector).first().click().catch(() => undefined);
      await waitForStability(page, 1200);
      return;
    }
  }

  const img = await screenshot(page, "start");
  const { parsed } = await callGemini<{ start_button: { x: number; y: number }; found: boolean }>(
    config.apiKey,
    START_PROMPT,
    img,
    startSchema,
    256
  );
  if (parsed.found) {
    await clickAt(page, parsed.start_button.x, parsed.start_button.y);
  } else {
    await clickAt(page, 640, 400);
  }
  await waitForStability(page, 1200);
}

export async function runStep(
  page: Page,
  config: AgentConfig,
  stepNumber: number
): Promise<StepResult> {
  const start = now();
  let attempts = 0;
  let error: string | undefined;

  for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt += 1) {
      attempts = attempt;
      const result = await solveStep(page, config, stepNumber, attempt);
    if (result.success) {
      return {
        step: stepNumber,
        success: true,
        elapsed_ms: now() - start,
        attempts,
      };
    }
    error = result.error;
  }

  return {
    step: stepNumber,
    success: false,
    elapsed_ms: now() - start,
    attempts,
    error,
  };
}

export async function runAgent(page: Page, config: AgentConfig): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const runDeadline = now() + RUN_DEADLINE_MS;

  await runStartPhase(page, config);

  for (let step = 1; step <= 30; step += 1) {
    if (!withinDeadline(runDeadline)) break;
    console.log(`\n--- STEP ${step} ---`);
    const result = await runStep(page, config, step);
    results.push(result);
    if (!result.success) {
      console.log(`Step ${step} failed: ${result.error ?? "unknown"}`);
      break;
    }
  }

  console.log(`[SKILL_LOGS_JSON] ${JSON.stringify(skillLogs)}`);
  return results;
}
