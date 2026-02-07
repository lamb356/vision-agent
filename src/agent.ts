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

const STEP_DEADLINE_MS = 15000;
const MAX_STEP_ATTEMPTS = 2;
const DISMISS_TIME_CAP_MS = 2500;
const MAX_DISMISS_ROUNDS = 3;
const MAX_SCOUT_BATCHES = 1;
const MAX_SCOUT_ACTIONS = 25;
const SCROLL_SWEEPS = 5;
const RADIO_BRUTEFORCE_LIMIT = 8;
const RUN_DEADLINE_MS = 10 * 60 * 1000;

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
              "dismiss_overlays",
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
const EXTRACT_VISIBLE_CODES_SCRIPT = `(function() {
  var text = (document.body ? document.body.innerText : "") || "";
  var re = /\\b(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{6}\\b/g;
  var out = [];
  var seen = {};
  var m;
  while ((m = re.exec(text)) && out.length < 25) {
    var c = m[0];
    if (!seen[c]) { seen[c] = true; out.push(c); }
  }
  return out;
})()`;

async function extractVisibleCodes(page: Page): Promise<string[]> {
  return (await page.evaluate(EXTRACT_VISIBLE_CODES_SCRIPT)) as string[];
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
    .filter((code) => /^(?=.*[0-9])[A-Za-z0-9]{6}$/.test(code))
    .filter((code) => !exclude || !exclude.has(code));
  if (normalized.length > 0) return normalized[0];
  return null;
}

async function checkForCode(page: Page, exclude?: Set<string>): Promise<string | null> {
  // Only accept codes that appear in visible text (innerText).
  const visible = await extractVisibleCodes(page).catch(() => []);
  const candidate =
    visible
      .map((c) => c.trim())
      .find((code) => /^(?=.*[0-9])[A-Za-z0-9]{6}$/.test(code) && (!exclude || !exclude.has(code))) ?? null;

  if (candidate) return candidate;

  // Debug: if extractCodesFromDOM is finding something that innerText doesn't contain,
  // log where it's coming from once (this is how you catch phantom data-attribute codes).
  const domCodes = await extractCodesFromDOM(page).catch(() => []);
  const domCandidate = pickCode(domCodes, exclude);
  if (domCandidate) {
    await logDomOnlyCodeSourceOnce(page, domCandidate);
  }

  return null;
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
    .filter((code) => /^(?=.*[0-9])[A-Za-z0-9]{6}$/.test(code));

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

async function dismissOverlays(page: Page, deadline: number): Promise<void> {
  // Nuclear overlay removal: forcefully remove blocking overlays from DOM
  await page.evaluate(`(function() {
    var all = document.querySelectorAll("*");
    var vw = window.innerWidth || 1;
    var vh = window.innerHeight || 1;
    var vArea = vw * vh;

    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var style = window.getComputedStyle(el);
      var pos = style.position;
      if (pos !== "fixed" && pos !== "absolute") continue;

      var z = parseInt(style.zIndex, 10);
      if (isNaN(z) || z <= 99) continue;

      // don't remove real interactive containers
      if (el.querySelector("input, textarea, select")) continue;

      var text = (el.innerText || "").toLowerCase();
      if (/step\\s+\\d/.test(text)) continue;

      var rect = el.getBoundingClientRect();
      var area = Math.max(0, rect.width) * Math.max(0, rect.height);
      var big = area > vArea * 0.2;

      var hasKeyword = /prize|won|congratulations|winner|reward|alert/i.test(text);
      var semiTransparent = (parseFloat(style.opacity) < 1);

      var dominated = hasKeyword || (semiTransparent && big);
      var isBackdrop = big && el.children.length === 0 && text.trim().length === 0;

      if (dominated || isBackdrop) {
        el.remove();
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

async function solveStep(
  page: Page,
  config: AgentConfig,
  stepNumber: number,
  attempt: number
): Promise<{ success: boolean; error?: string }>
{
  const deadline = now() + STEP_DEADLINE_MS;
  const triedCodes = new Set<string>();

  const isValidCode = (code: string) => /^(?=.*[0-9])[A-Za-z0-9]{6}$/.test(code.trim());

  await injectEIDs(page);
  await dismissOverlays(page, Math.min(deadline, now() + DISMISS_TIME_CAP_MS));

  // Phase 0: immediate code check (fast path)
  const domCode = await checkForCode(page, triedCodes);
  if (domCode) {
    await submitCodeSafe(page, domCode, deadline);
    const verify = await verifyStep(page, stepNumber);
    if (verify.advanced || verify.completed) return { success: true };
    triedCodes.add(domCode);
    console.log(`  [STALE] code ${domCode} failed, added to triedCodes`);
  }

  // Phase 1: SCOUTS FIRST (navigation/reveal/progress)
  if (withinDeadline(deadline) && MAX_SCOUT_BATCHES > 0) {
    for (let batch = 0; batch < MAX_SCOUT_BATCHES && withinDeadline(deadline); batch += 1) {
      await injectEIDs(page);
      const scoutSnap = await captureDOMSnapshot(page);
      const scoutActions = await buildScoutActions(page, config, scoutSnap);

      for (const action of scoutActions) {
        if (!withinDeadline(deadline)) break;

        if (action.type === "submit_code") {
          const candidate = action.code.trim();

          // IMPORTANT: filter scout-provided codes (prevents "REVEAL" etc)
          if (!isValidCode(candidate)) {
            console.log(`  [SCOUT] Ignoring invalid code "${action.code}"`);
            continue;
          }
          if (triedCodes.has(candidate)) continue;

          await submitCodeSafe(page, candidate, deadline);
          const verify = await verifyStep(page, stepNumber);
          if (verify.advanced || verify.completed) return { success: true };

          triedCodes.add(candidate);
          console.log(`  [STALE] code ${candidate} failed, added to triedCodes`);
          continue;
        }

        const exec = await executeAction(page, action);

        // prize/alert traps spawn constantly; clean quickly
        await dismissOverlays(page, Math.min(deadline, now() + 600));

        // sometimes navigation advances without code appearing yet
        const verifyAfterAction = await verifyStep(page, stepNumber);
        if (verifyAfterAction.advanced || verifyAfterAction.completed) return { success: true };

        if (exec.codeFound && !triedCodes.has(exec.codeFound)) {
          await submitCodeSafe(page, exec.codeFound, deadline);
          const verify = await verifyStep(page, stepNumber);
          if (verify.advanced || verify.completed) return { success: true };

          triedCodes.add(exec.codeFound);
          console.log(`  [STALE] code ${exec.codeFound} failed, added to triedCodes`);
        }

        if (exec.trapDetected) break;
      }

      // post-batch check in case code appeared but was missed
      const codeAfter = await checkForCode(page, triedCodes);
      if (codeAfter && withinDeadline(deadline)) {
        await submitCodeSafe(page, codeAfter, deadline);
        const verify = await verifyStep(page, stepNumber);
        if (verify.advanced || verify.completed) return { success: true };

        triedCodes.add(codeAfter);
        console.log(`  [STALE] code ${codeAfter} failed, added to triedCodes`);
      }
    }
  }

  // Phase 2: skills as accelerators (known patterns) AFTER scouts
  let snap = await captureDOMSnapshot(page);
  for (const skill of skills) {
    if (!withinDeadline(deadline)) break;
    const result = await runSkill(page, snap, deadline, skill, stepNumber, attempt, triedCodes);
    if (result.code && !triedCodes.has(result.code)) {
      await submitCodeSafe(page, result.code, deadline);
      const verify = await verifyStep(page, stepNumber);
      if (verify.advanced || verify.completed) return { success: true };

      triedCodes.add(result.code);
      console.log(`  [STALE] code ${result.code} failed, added to triedCodes`);
      snap = await captureDOMSnapshot(page);
      continue;
    }
    if (!withinDeadline(deadline)) break;
    snap = await captureDOMSnapshot(page);
  }

  // Phase 3: vision fallback LAST
  if (withinDeadline(deadline)) {
    const img = await screenshot(page, `combined-step-${stepNumber}`);
    const { parsed } = await callGemini<CombinedResult>(
      config.apiKey,
      COMBINED_PROMPT,
      img,
      combinedSchema,
      256
    );

    const candidate = (parsed.code || "").trim();
    if (candidate && candidate !== "NONE" && isValidCode(candidate) && !triedCodes.has(candidate)) {
      try {
        await submitCodeSafe(page, candidate, deadline);
        const verify = await verifyStep(page, stepNumber);
        if (verify.advanced || verify.completed) return { success: true };

        triedCodes.add(candidate);
        console.log(`  [STALE] code ${candidate} failed, added to triedCodes`);
      } catch {
        console.log(`  [WARN] Vision fallback submit failed for step ${stepNumber}`);
      }
    } else if (candidate && candidate !== "NONE" && !isValidCode(candidate)) {
      console.log(`  [VISION] Ignoring invalid code "${candidate}"`);
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
    }
  }

  console.log(`[SKILL_LOGS_JSON] ${JSON.stringify(skillLogs)}`);
  return results;
}
