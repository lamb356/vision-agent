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

const STEP_DEADLINE_MS = 9000;
const MAX_STEP_ATTEMPTS = 5;
const DISMISS_TIME_CAP_MS = 2500;
const MAX_DISMISS_ROUNDS = 3;
const MAX_SCOUT_BATCHES = 1;
const MAX_SCOUT_ACTIONS = 12;
const SCROLL_SWEEPS = 5;
const RADIO_BRUTEFORCE_LIMIT = 8;
const RUN_DEADLINE_MS = 5 * 60 * 1000;

const MODAL_SCOUT_PROMPT = `You are a browser automation scout. You receive a DOM snapshot with data-agent-eid values and a screenshot.
Focus on dialogs/modals, radios, scrolling, and submit buttons. If you can see the 6-character code, return a submit_code action.

Return JSON with: { actions: AgentAction[], confidence: number }
AgentAction schema:
- { type: "dismiss_overlays" }
- { type: "click_eid", eid: string }
- { type: "type_eid", eid: string, text: string }
- { type: "check_eid", eid: string }
- { type: "select_eid_by_index", eid: string, index: number }
- { type: "scroll_eid_to_bottom", eid: string }
- { type: "press_key", key: "Enter" | "Escape" | "Tab" }
- { type: "submit_code", code: string }

Use ONLY EIDs from the snapshot. Keep actions minimal.`;

const REVEAL_SCOUT_PROMPT = `You are a browser automation scout. You receive a DOM snapshot with data-agent-eid values and a screenshot.
Focus on reveal/show/unlock/display controls, hidden panels, or unusual UI patterns. If you can see the 6-character code, return a submit_code action.

Return JSON with: { actions: AgentAction[], confidence: number }
AgentAction schema:
- { type: "dismiss_overlays" }
- { type: "click_eid", eid: string }
- { type: "type_eid", eid: string, text: string }
- { type: "check_eid", eid: string }
- { type: "select_eid_by_index", eid: string, index: number }
- { type: "scroll_eid_to_bottom", eid: string }
- { type: "press_key", key: "Enter" | "Escape" | "Tab" }
- { type: "submit_code", code: string }

Use ONLY EIDs from the snapshot. Keep actions minimal.`;

const FORM_SCOUT_PROMPT = `You are a browser automation scout. You receive a DOM snapshot with data-agent-eid values and a screenshot.
Focus on inputs, selects, checkboxes, and form submission. If you can see the 6-character code, return a submit_code action.

Return JSON with: { actions: AgentAction[], confidence: number }
AgentAction schema:
- { type: "dismiss_overlays" }
- { type: "click_eid", eid: string }
- { type: "type_eid", eid: string, text: string }
- { type: "check_eid", eid: string }
- { type: "select_eid_by_index", eid: string, index: number }
- { type: "scroll_eid_to_bottom", eid: string }
- { type: "press_key", key: "Enter" | "Escape" | "Tab" }
- { type: "submit_code", code: string }

Use ONLY EIDs from the snapshot. Keep actions minimal.`;

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
  | { type: "press_key"; key: "Enter" | "Escape" | "Tab" }
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
  run(page: Page, snap: DOMSnapshot, deadline: number): Promise<SkillResult>;
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

function pickCode(codes: Array<{ code: string; score: number }>): string | null {
  const normalized = codes
    .map((c) => c.code.trim())
    .filter((code) => /^[A-Za-z0-9]{6}$/.test(code));
  if (normalized.length > 0) return normalized[0];
  return null;
}

async function checkForCode(page: Page): Promise<string | null> {
  const codes = await extractCodesFromDOM(page);
  return pickCode(codes);
}

async function detectTrap(page: Page): Promise<boolean> {
  const count = await page.locator("text=/Wrong Button|Wrong Choice|decoy/i").count().catch(() => 0);
  return count > 0;
}

async function getActiveDialogEid(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const dialogSelectors = [
      '[role="dialog"]',
      '.modal',
      '[class*="modal"]',
      '[class*="dialog"]',
      '.overlay',
      '.popup',
    ];
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(dialogSelectors.join(","))
    ).filter((el) => el.getAttribute("data-agent-eid"));

    const visible = candidates.filter((el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    });

    if (visible.length === 0) return null;

    const sorted = visible.sort((a, b) => {
      const za = Number(window.getComputedStyle(a).zIndex || 0);
      const zb = Number(window.getComputedStyle(b).zIndex || 0);
      return zb - za;
    });

    return sorted[0]?.getAttribute("data-agent-eid") || null;
  });
}

async function injectEIDs(page: Page): Promise<number> {
  return page.evaluate(() => {
    const selectors = [
      'button',
      'a',
      '[role="button"]',
      'input[type="submit"]',
      'input[type="button"]',
      'input',
      'select',
      'textarea',
      '[role="dialog"]',
      '.modal',
      '[class*="modal"]',
      '[class*="dialog"]',
      '.overlay',
      '.popup',
      '[onclick]',
    ];

    const elements = new Set<HTMLElement>();
    selectors.forEach((sel) => {
      document.querySelectorAll<HTMLElement>(sel).forEach((el) => elements.add(el));
    });

    document.querySelectorAll<HTMLElement>("*").forEach((el) => {
      if (el.scrollHeight > el.clientHeight + 20) {
        elements.add(el);
      }
    });

    let count = 0;
    elements.forEach((el) => {
      count += 1;
      const eid = `E${String(count).padStart(3, "0")}`;
      el.setAttribute("data-agent-eid", eid);
    });

    return count;
  });
}

async function captureDOMSnapshot(page: Page): Promise<DOMSnapshot> {
  const codesFound = await extractCodesFromDOM(page);
  const codeList = codesFound.map((c) => c.code).filter((code) => code.length > 0);

  const snapshot = await page.evaluate(() => {
    const dialogSelectors = [
      '[role="dialog"]',
      '.modal',
      '[class*="modal"]',
      '[class*="dialog"]',
      '.overlay',
      '.popup',
    ];

    const buttonSelectors = [
      'button',
      '[role="button"]',
      'input[type="button"]',
      'input[type="submit"]',
      'a',
    ];

    const isVisible = (el: HTMLElement) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    };

    const textOf = (el: HTMLElement | null) => {
      if (!el) return "";
      return (el.innerText || el.textContent || "").trim();
    };

    const truncate = (text: string, maxLen: number) =>
      text.length > maxLen ? text.slice(0, maxLen) : text;

    const dialogElements = Array.from(
      document.querySelectorAll<HTMLElement>(dialogSelectors.join(","))
    ).filter((el) => el.getAttribute("data-agent-eid"));

    const visibleDialogs = dialogElements.filter(isVisible);

    const sortedDialogs = [...visibleDialogs].sort((a, b) => {
      const za = Number(window.getComputedStyle(a).zIndex || 0);
      const zb = Number(window.getComputedStyle(b).zIndex || 0);
      return zb - za;
    });

    const activeDialogEid =
      sortedDialogs[0]?.getAttribute("data-agent-eid") ?? null;

    const dialogs = dialogElements.map((dialog) => {
      const eid = dialog.getAttribute("data-agent-eid") || "";
      const buttons = Array.from(
        dialog.querySelectorAll<HTMLElement>(buttonSelectors.join(","))
      )
        .filter((btn) => btn.getAttribute("data-agent-eid"))
        .map((btn) => ({
          eid: btn.getAttribute("data-agent-eid") || "",
          text: truncate(textOf(btn), 60),
        }));

      const radios = dialog.querySelectorAll('input[type="radio"]').length;
      const checkboxes = dialog.querySelectorAll('input[type="checkbox"]').length;
      const selects = dialog.querySelectorAll('select').length;

      return {
        eid,
        visible: isVisible(dialog),
        scrollable: dialog.scrollHeight > dialog.clientHeight + 20,
        textExcerpt: truncate(textOf(dialog), 300),
        radioCount: radios,
        checkboxCount: checkboxes,
        selectCount: selects,
        buttons,
      };
    });

    const inputs = Array.from(
      document.querySelectorAll<HTMLElement>('input, select, textarea')
    )
      .filter((el) => el.getAttribute("data-agent-eid"))
      .map((el) => {
        const tag = el.tagName.toLowerCase();
        const kind = tag === "input" ? (el as HTMLInputElement).type || "text" : tag;
        return {
          eid: el.getAttribute("data-agent-eid") || "",
          kind,
          placeholder: truncate(
            (el as HTMLInputElement).placeholder || el.getAttribute("aria-label") || "",
            80
          ),
        };
      });

    const clickables = Array.from(
      document.querySelectorAll<HTMLElement>(buttonSelectors.join(","))
    )
      .filter((el) => el.getAttribute("data-agent-eid"))
      .map((el) => {
        let parent = el.parentElement;
        let inDialog: string | null = null;
        while (parent) {
          if (dialogSelectors.some((sel) => parent?.matches(sel))) {
            inDialog = parent.getAttribute("data-agent-eid");
            break;
          }
          parent = parent.parentElement;
        }
        return {
          eid: el.getAttribute("data-agent-eid") || "",
          tag: el.tagName.toLowerCase(),
          text: truncate(textOf(el), 80),
          ariaLabel: truncate(el.getAttribute("aria-label") || "", 80),
          inDialog,
        };
      });

    const scrollables = Array.from(document.querySelectorAll<HTMLElement>("*"))
      .filter((el) => el.getAttribute("data-agent-eid"))
      .filter((el) => el.scrollHeight > el.clientHeight + 20)
      .map((el) => {
        let parent = el.parentElement;
        let inDialog: string | null = null;
        while (parent) {
          if (dialogSelectors.some((sel) => parent?.matches(sel))) {
            inDialog = parent.getAttribute("data-agent-eid");
            break;
          }
          parent = parent.parentElement;
        }
        return { eid: el.getAttribute("data-agent-eid") || "", inDialog };
      });

    const bodyText = truncate((document.body?.innerText || "").trim(), 800);
    const hasCodeVisible = /[A-Za-z0-9]{6}/.test(bodyText);
    const hasRevealText = /(reveal|show|unlock|display)/i.test(bodyText);
    const hasClickHereText = /(click here|click\s+\d+\s+times)/i.test(bodyText);

    return {
      url: window.location.href,
      stepHintText: truncate(bodyText, 200),
      activeDialogEid,
      dialogs,
      inputs,
      clickables,
      scrollables,
      features: {
        hasDialog: visibleDialogs.length > 0,
        hasRadios: document.querySelectorAll('input[type="radio"]').length > 0,
        hasCheckboxes: document.querySelectorAll('input[type="checkbox"]').length > 0,
        hasSelects: document.querySelectorAll('select').length > 0,
        hasScrollable: scrollables.length > 0,
        hasRevealText,
        hasClickHereText,
        hasCodeVisible,
        totalButtons: document.querySelectorAll(buttonSelectors.join(",")).length,
        totalInputs: document.querySelectorAll('input, select, textarea').length,
      },
    };
  });

  return {
    ...snapshot,
    codesFound: codeList,
    stepHintText: clampText(snapshot.stepHintText, 200),
    dialogs: snapshot.dialogs.map((d) => ({
      ...d,
      textExcerpt: clampText(d.textExcerpt, 300),
      buttons: d.buttons.map((b) => ({
        ...b,
        text: clampText(b.text, 60),
      })),
    })),
    inputs: snapshot.inputs.map((i) => ({
      ...i,
      placeholder: clampText(i.placeholder, 80),
    })),
    clickables: snapshot.clickables.map((c) => ({
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
      await page
        .locator(`[data-agent-eid="${action.eid}"]`)
        .click({ timeout: 800 });
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
      await page.evaluate((eid) => {
        const el = document.querySelector<HTMLElement>(`[data-agent-eid="${eid}"]`);
        if (el) {
          el.scrollTop = el.scrollHeight;
        }
      }, action.eid);
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
  const dismissSelectors = [
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
  snap: DOMSnapshot
): Promise<string | null> {
  const activeDialog = snap.activeDialogEid;
  if (activeDialog) {
    const dialog = snap.dialogs.find((d) => d.eid === activeDialog);
    const candidates = dialog?.buttons ?? [];
    const prioritized = candidates.find((b) => /submit|confirm|continue|next/i.test(b.text));
    if (prioritized) return prioritized.eid;
    if (candidates.length > 0) return candidates[0].eid;
  }

  const global = snap.clickables
    .filter((c) => c.tag === "button")
    .find((c) => /submit|confirm|continue|next/i.test(c.text || c.ariaLabel));
  if (global) return global.eid;

  return snap.clickables.find((c) => c.tag === "button")?.eid ?? null;
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
  if (inputEid) {
    const locator = page.locator(`[data-agent-eid="${inputEid}"]`);
    await locator.click({ timeout: 800 }).catch(() => undefined);
    await locator.click({ clickCount: 3, timeout: 800 }).catch(() => undefined);
    await typeText(page, code);
  } else {
    await typeText(page, code);
  }

  const submitEid = await selectSubmitButton(page, snap);
  if (submitEid) {
    await page.locator(`[data-agent-eid="${submitEid}"]`).click({ timeout: 800 });
  } else {
    await page.keyboard.press("Enter");
  }

  await waitForStability(page, 300);
}

async function verifyStep(page: Page, expectedStep: number): Promise<VerifyResult> {
  const bodyText = await page.evaluate(() => document.body?.innerText || "");
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
  return page.evaluate((eid) => {
    const dialog = document.querySelector<HTMLElement>(`[data-agent-eid="${eid}"]`);
    if (!dialog) return [];
    const radios = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
      .filter((radio) => radio.getAttribute("data-agent-eid"))
      .map((radio) => {
        let labelText = "";
        if (radio.id) {
          const label = dialog.querySelector(`label[for="${radio.id}"]`);
          if (label) labelText = (label.textContent || "").trim();
        }
        if (!labelText) {
          const parentLabel = radio.closest("label");
          if (parentLabel) labelText = (parentLabel.textContent || "").trim();
        }
        return {
          eid: radio.getAttribute("data-agent-eid") || "",
          label: labelText,
        };
      });
    return radios;
  }, dialogEid);
}

async function selectLastOption(page: Page, eid: string): Promise<void> {
  const count = await page.evaluate((eidValue) => {
    const select = document.querySelector<HTMLSelectElement>(`[data-agent-eid="${eidValue}"]`);
    return select?.options?.length ?? 0;
  }, eid);

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
  attempt: number
): Promise<SkillResult> {
  const start = now();
  let result: SkillResult = { code: null, actions_taken: 0, elapsed_ms: 0 };
  if (!skill.match(snap)) {
    result.elapsed_ms = now() - start;
    return result;
  }

  result = await skill.run(page, snap, deadline);

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
  run: async (_page, snap) => ({
    code: snap.codesFound[0] ?? null,
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

    const scrollables = snap.scrollables.filter((s) => s.inDialog === dialogEid);
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

      const submitEid = await selectSubmitButton(page, snap);
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

    const scrollables = snap.scrollables.filter((s) => s.inDialog === dialogEid);
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

    const bodyText = await page.evaluate(() => document.body?.innerText || "");
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

    const submitEid = await selectSubmitButton(page, snap);
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

    const submitEid = await selectSubmitButton(page, snap);
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

async function buildScoutActions(
  page: Page,
  config: AgentConfig,
  snap: DOMSnapshot
): Promise<AgentAction[]> {
  const snapshotJson = clampText(JSON.stringify(snap), 4000);
  const img = await screenshot(page, "scout");
  const calls = [
    { prompt: `${MODAL_SCOUT_PROMPT}\n\nSNAPSHOT:\n${snapshotJson}`, schema: scoutSchema, thinkingBudget: 128 },
    { prompt: `${REVEAL_SCOUT_PROMPT}\n\nSNAPSHOT:\n${snapshotJson}`, schema: scoutSchema, thinkingBudget: 128 },
    { prompt: `${FORM_SCOUT_PROMPT}\n\nSNAPSHOT:\n${snapshotJson}`, schema: scoutSchema, thinkingBudget: 128 },
  ];

  const results = await callGeminiParallel<[ScoutResult, ScoutResult, ScoutResult]>(
    config.apiKey,
    calls,
    img
  );

  const actions = results.flatMap((r) => r.parsed.actions || []);
  const activeDialog = snap.activeDialogEid;

  const unique = new Map<string, AgentAction>();
  for (const action of actions) {
    const key = `${action.type}-${"eid" in action ? action.eid : ""}-${"code" in action ? action.code : ""}`;
    if (!unique.has(key)) unique.set(key, action);
  }

  const prioritized = Array.from(unique.values()).sort((a, b) => {
    const inDialog = (action: AgentAction) => {
      if (!activeDialog) return false;
      if (action.type === "click_eid" || action.type === "type_eid" || action.type === "check_eid" || action.type === "select_eid_by_index" || action.type === "scroll_eid_to_bottom") {
        return snap.clickables.some((c) => c.eid === action.eid && c.inDialog === activeDialog)
          || snap.scrollables.some((s) => s.eid === action.eid && s.inDialog === activeDialog)
          || snap.inputs.some((i) => i.eid === action.eid);
      }
      return false;
    };
    return Number(inDialog(b)) - Number(inDialog(a));
  });

  console.log(`[SCOUT_LOG] ${JSON.stringify({ actionCount: prioritized.length })}`);
  return prioritized.slice(0, MAX_SCOUT_ACTIONS);
}

async function solveStep(
  page: Page,
  config: AgentConfig,
  stepNumber: number,
  attempt: number
): Promise<{ success: boolean; error?: string }>
{
  const deadline = now() + STEP_DEADLINE_MS;

  await injectEIDs(page);
  await dismissOverlays(page, Math.min(deadline, now() + DISMISS_TIME_CAP_MS));

  const domCode = await checkForCode(page);
  if (domCode) {
    const snap = await captureDOMSnapshot(page);
    await submitCodeWithSnapshot(page, snap, domCode);
    const verify = await verifyStep(page, stepNumber);
    if (verify.advanced || verify.completed) return { success: true };
  }

  let snap = await captureDOMSnapshot(page);

  for (const skill of skills) {
    if (!withinDeadline(deadline)) break;
    const result = await runSkill(page, snap, deadline, skill, stepNumber, attempt);
    if (result.code) {
      await submitCodeWithSnapshot(page, snap, result.code);
      const verify = await verifyStep(page, stepNumber);
      if (verify.advanced || verify.completed) return { success: true };
    }
    if (!withinDeadline(deadline)) break;
    snap = await captureDOMSnapshot(page);
  }

  if (withinDeadline(deadline) && MAX_SCOUT_BATCHES > 0) {
    await injectEIDs(page);
    snap = await captureDOMSnapshot(page);
    const scoutActions = await buildScoutActions(page, config, snap);
    for (const action of scoutActions) {
      if (!withinDeadline(deadline)) break;
      if (action.type === "submit_code") {
        await submitCodeWithSnapshot(page, snap, action.code);
      } else {
        const exec = await executeAction(page, action);
        if (exec.codeFound) {
          await submitCodeWithSnapshot(page, snap, exec.codeFound);
        }
        if (exec.trapDetected) break;
      }
      const verify = await verifyStep(page, stepNumber);
      if (verify.advanced || verify.completed) return { success: true };
    }
  }

  if (withinDeadline(deadline)) {
    const img = await screenshot(page, `combined-step-${stepNumber}`);
    const { parsed } = await callGemini<CombinedResult>(
      config.apiKey,
      COMBINED_PROMPT,
      img,
      combinedSchema,
      256
    );

    if (parsed.code && parsed.code !== "NONE") {
      const latestSnap = await captureDOMSnapshot(page);
      await submitCodeWithSnapshot(page, latestSnap, parsed.code);
      const verify = await verifyStep(page, stepNumber);
      if (verify.advanced || verify.completed) return { success: true };
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
