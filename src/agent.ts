import type { Locator, Page } from "playwright";
import type {
  AgentConfig,
  Coordinate,
  CodeResult,
  CombinedResult,
  SubmitTargets,
  VerifyResult,
  PageAnalysis,
  StepResult,
} from "./types.js";
import { callGemini, callGeminiParallel } from "./gemini.js";
import {
  CODE_PROMPT,
  COMBINED_PROMPT,
  SUBMIT_TARGETS_PROMPT,
  START_PROMPT,
  ANALYZE_PAGE_PROMPT,
  submitTargetsWithFailedPrompt,
  combinedSchema,
  codeSchema,
  submitTargetsSchema,
  startSchema,
  analyzePageSchema,
} from "./prompts.js";
import {
  screenshot,
  clickAt,
  tripleClickAt,
  typeText,
  pressEscape,
  waitForStability,
  extractCodesFromDOM,
  scrollInModal,
} from "./browser.js";

const MAX_DISTRACTOR_ROUNDS = 5;
const MAX_STEP_ATTEMPTS = 5;

interface StartResult {
  start_button: Coordinate;
  found: boolean;
}

export async function runStartPhase(
  page: Page,
  config: AgentConfig
): Promise<void> {
  console.log("\n--- START PHASE ---");

  await waitForStability(page, 1000);
  const startUrl = page.url();

  const MAX_START_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
    console.log(`  Start attempt ${attempt}/${MAX_START_ATTEMPTS}`);

    // Strategy 1: CSS selector — find button/element with START text
    const selectorCandidates = [
      'button:has-text("Start")',
      'a:has-text("Start")',
      '[role="button"]:has-text("Start")',
      'text=/START|Start|BEGIN|Begin/',
    ];

    let clickedViaSelector = false;
    for (const selector of selectorCandidates) {
      const count = await page.locator(selector).count().catch(() => 0);
      if (count > 0) {
        console.log(`  Found START via selector: ${selector}`);
        await page.locator(selector).first().click();
        clickedViaSelector = true;
        break;
      }
    }

    // Strategy 2: Vision coordinate click as fallback
    if (!clickedViaSelector) {
      console.log("  No selector match, using vision coordinates...");
      const img = await screenshot(page, `start-a${attempt}`);
      const { parsed: result } = await callGemini<StartResult>(
        config.apiKey,
        START_PROMPT,
        img,
        startSchema,
        256
      );

      if (result.found) {
        console.log(`  Found START at (${result.start_button.x}, ${result.start_button.y})`);
        await clickAt(page, result.start_button.x, result.start_button.y);
      } else {
        console.log("  No START button found, clicking center...");
        await clickAt(page, 640, 400);
      }
    }

    // Wait and verify the page actually changed
    await waitForStability(page, 1500);

    const urlChanged = page.url() !== startUrl;
    const hasStepContent = await page.locator("text=/[Ss]tep/").count().catch(() => 0) > 0;
    const hasInput = await page.locator("input").count().catch(() => 0) > 0;

    if (urlChanged || hasStepContent || hasInput) {
      console.log(`  Page changed! (url=${urlChanged}, step=${hasStepContent}, input=${hasInput})`);
      await screenshot(page, `start-confirmed`);
      console.log("  Start phase complete.");
      return;
    }

    console.log("  Page hasn't changed, retrying...");
    await screenshot(page, `start-a${attempt}-nochange`);
  }

  console.log("  WARNING: Start phase may have failed after all attempts, proceeding anyway...");
}

/**
 * Pure DOM-based distractor dismissal. No vision calls — just click all
 * dismiss/close/accept buttons we can find. Fast and reliable.
 */
async function dismissDistractors(
  page: Page,
  _config: AgentConfig
): Promise<void> {
  // SAFE selectors only — no has-text selectors (they match decoy trap buttons)
  const dismissSelectors = [
    '[aria-label="Close"]',
    '[aria-label="Dismiss"]',
    '[aria-label="close"]',
    '[aria-label*="close" i]',
    '[aria-label*="dismiss" i]',
    '[aria-label*="exit" i]',
    '.close-button',
    '.close-btn',
    '.dismiss-button',
    '.dismiss-btn',
    '.modal-close',
    '.btn-close',
    'button.close',
    '[data-dismiss="modal"]',
    '[data-bs-dismiss="modal"]',
    '[data-dismiss]',
    '[data-bs-dismiss]',
  ];

  for (let round = 0; round < MAX_DISTRACTOR_ROUNDS; round++) {
    let dismissed = 0;

    for (const sel of dismissSelectors) {
      // Re-check count each time as DOM changes after clicks
      const count = await page.locator(sel).count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        try {
          const loc = page.locator(sel).nth(i);
          if (await loc.isVisible({ timeout: 200 }).catch(() => false)) {
            await loc.click({ timeout: 500 });
            dismissed++;
            console.log(`    DOM dismiss: ${sel}`);
            await waitForStability(page, 100);
          }
        } catch { /* element may have disappeared */ }
      }
    }

    // Also press Escape
    await pressEscape(page);
    await waitForStability(page, 100);

    if (dismissed === 0) {
      console.log(`  Distractors clear (round ${round + 1})`);
      return;
    }

    console.log(`  Dismissed ${dismissed} overlay(s) (round ${round + 1})`);
  }

  console.log("  Proceeding despite remaining overlays");
}

const DOM_SCORE_THRESHOLD = 50;

/**
 * Try to extract a 6-char code via DOM scraping first, then vision.
 * Returns the code or null.
 */
async function tryExtractCode(
  page: Page,
  config: AgentConfig,
  label: string
): Promise<string | null> {
  // Strategy 1: DOM extraction (fast, checks hidden elements + data attributes)
  const domCodes = await extractCodesFromDOM(page);
  if (domCodes.length > 0) {
    const top5 = domCodes.slice(0, 5).map((c) => `${c.code}(${c.score})`).join(", ");
    console.log(`  DOM found ${domCodes.length} candidate(s), top: ${top5}`);

    // Only use DOM code if score is above threshold (mixed alphanumeric)
    const best = domCodes[0];
    if (best && best.score >= DOM_SCORE_THRESHOLD) {
      console.log(`  Using DOM-extracted code: ${best.code} (score=${best.score})`);
      return best.code;
    }
    console.log(`  Best DOM score ${best?.score ?? 0} < ${DOM_SCORE_THRESHOLD}, falling through to vision`);
  }

  // Strategy 2: Vision extraction
  const img = await screenshot(page, label);
  const { parsed, raw } = await callGemini<CodeResult>(
    config.apiKey,
    CODE_PROMPT,
    img,
    codeSchema,
    0
  );

  if (parsed.code !== "NONE" && parsed.code.length === 6) {
    console.log(`  Vision-extracted code: ${parsed.code} (confidence: ${parsed.confidence})`);
    return parsed.code;
  }

  console.log(`  Code extraction returned "${parsed.code}" — raw response:`);
  console.log(JSON.stringify(raw, null, 2));
  return null;
}

/**
 * Try clicking a button/element by text using Playwright's built-in locators.
 * Uses getByRole + getByText which catch divs/spans styled as buttons.
 * Returns true if something was clicked.
 */
async function domClick(page: Page, textHints: string[]): Promise<boolean> {
  for (const hint of textHints) {
    // Strategy 1: getByRole('button') — catches <button>, [role="button"], <input type="submit">
    try {
      const loc = page.getByRole("button", { name: hint, exact: false });
      if (await loc.first().isVisible({ timeout: 300 }).catch(() => false)) {
        await loc.first().click({ timeout: 1000, trial: true });
        await loc.first().click({ timeout: 1000 });
        console.log(`    DOM click (role): "${hint}"`);
        await waitForStability(page, 150);
        return true;
      }
    } catch { /* not found */ }

    // Strategy 2: getByText — catches any element with matching text (spans, divs, etc.)
    try {
      const loc = page.getByText(hint, { exact: false }).first();
      if (await loc.isVisible({ timeout: 300 }).catch(() => false)) {
        await loc.click({ timeout: 1000, trial: true });
        await loc.click({ timeout: 1000 });
        console.log(`    DOM click (text): "${hint}"`);
        await waitForStability(page, 150);
        return true;
      }
    } catch { /* not found */ }

    // Strategy 3: CSS button:has-text
    try {
      const loc = page.locator(`button:has-text("${hint}")`).first();
      if (await loc.isVisible({ timeout: 300 }).catch(() => false)) {
        await loc.click({ timeout: 1000, trial: true });
        await loc.click({ timeout: 1000 });
        console.log(`    DOM click (css-button): "${hint}"`);
        await waitForStability(page, 150);
        return true;
      }
    } catch { /* not found */ }

    // Strategy 4: CSS [role="button"]:has-text — for styled divs
    try {
      const loc = page.locator(`[role="button"]:has-text("${hint}")`).first();
      if (await loc.isVisible({ timeout: 300 }).catch(() => false)) {
        await loc.click({ timeout: 1000, trial: true });
        await loc.click({ timeout: 1000 });
        console.log(`    DOM click (css-role): "${hint}"`);
        await waitForStability(page, 150);
        return true;
      }
    } catch { /* not found */ }

    // Strategy 5: links
    try {
      const loc = page.getByRole("link", { name: hint, exact: false });
      if (await loc.first().isVisible({ timeout: 300 }).catch(() => false)) {
        await loc.first().click({ timeout: 1000, trial: true });
        await loc.first().click({ timeout: 1000 });
        console.log(`    DOM click (link): "${hint}"`);
        await waitForStability(page, 150);
        return true;
      }
    } catch { /* not found */ }
  }
  return false;
}

/**
 * Select a radio button by label text hints. Tries "correct" first,
 * then falls back to the description from vision.
 */
async function domSelectRadio(page: Page, description: string): Promise<boolean> {
  // Extract quoted text or key phrases from the description
  const quotedMatch = description.match(/['"]([^'"]+)['"]/);
  const hintText = quotedMatch ? quotedMatch[1] : description;

  // Strategy 1: Look for radio whose label contains "correct" (case-insensitive)
  const correctSelectors = [
    'label:has-text("Correct") input[type="radio"]',
    'label:has-text("correct") input[type="radio"]',
    'input[type="radio"][value*="correct" i]',
    'label:has-text("Correct")',
    'label:has-text("correct")',
  ];
  for (const sel of correctSelectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 300 }).catch(() => false)) {
        await loc.click({ timeout: 1000 });
        console.log(`    DOM radio (correct): ${sel}`);
        await waitForStability(page, 150);
        return true;
      }
    } catch { /* not found */ }
  }

  // Strategy 2: Match the description text from vision
  const labelSelectors = [
    `label:has-text("${hintText}") input[type="radio"]`,
    `label:has-text("${hintText}")`,
    `text="${hintText}"`,
  ];
  for (const sel of labelSelectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 300 }).catch(() => false)) {
        await loc.click({ timeout: 1000 });
        console.log(`    DOM radio (hint): ${sel}`);
        await waitForStability(page, 150);
        return true;
      }
    } catch { /* not found */ }
  }

  // Strategy 3: Just click all visible radios and pick the "correct"-looking one
  // Enumerate all radio labels, look for keywords
  const radios = page.locator('input[type="radio"]');
  const radioCount = await radios.count().catch(() => 0);
  for (let i = 0; i < radioCount; i++) {
    try {
      const radio = radios.nth(i);
      // Get the label text via the parent or associated label
      const labelText = await radio.evaluate((el: HTMLInputElement) => {
        const label = el.closest("label") || (el.id ? document.querySelector(`label[for="${el.id}"]`) : null);
        return label?.textContent?.trim() || "";
      });

      const lower = labelText.toLowerCase();
      if (lower.includes("correct") || lower.includes("option b") || lower.includes("right")) {
        await radio.click({ timeout: 1000 });
        console.log(`    DOM radio selected: "${labelText}"`);
        await waitForStability(page, 150);
        return true;
      }
    } catch { /* skip */ }
  }

  // Strategy 4: Last resort — click the second radio (often the "correct" one in challenges)
  if (radioCount >= 2) {
    try {
      await radios.nth(1).click({ timeout: 1000 });
      console.log(`    DOM radio fallback: clicked radio[1] of ${radioCount}`);
      await waitForStability(page, 150);
      return true;
    } catch { /* skip */ }
  }

  return false;
}

/**
 * Scroll inside the topmost modal/scrollable container.
 */
async function domScrollModal(page: Page, direction: "down" | "up" = "down"): Promise<boolean> {
  const scrolled = await page.evaluate((dir: string) => {
    // Find the most likely scrollable modal
    const candidates = document.querySelectorAll(
      '.modal, .modal-body, .modal-content, [role="dialog"], .dialog, .overlay, .popup, [class*="modal"], [class*="dialog"], [class*="scroll"]'
    );
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i] as HTMLElement;
      if (el.scrollHeight > el.clientHeight) {
        el.scrollBy({ top: dir === "down" ? 300 : -300, behavior: "smooth" });
        return true;
      }
    }
    // Fallback: scroll any element with overflow
    const all = document.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      const el = all[i] as HTMLElement;
      const style = window.getComputedStyle(el);
      if ((style.overflowY === "auto" || style.overflowY === "scroll") &&
          el.scrollHeight > el.clientHeight + 10 && el.clientHeight > 50) {
        el.scrollBy({ top: dir === "down" ? 300 : -300, behavior: "smooth" });
        return true;
      }
    }
    return false;
  }, direction);

  if (scrolled) {
    console.log(`    DOM scroll modal: ${direction}`);
    await waitForStability(page, 250);
  }
  return scrolled;
}

async function getActiveDialog(page: Page): Promise<Locator | null> {
  const dialogSelector = [
    '[role="dialog"]',
    '.modal',
    '[class*="modal"]',
    '[class*="dialog"]',
    '.overlay',
    '.popup',
  ].join(", ");

  const dialogs = page.locator(dialogSelector);
  const count = await dialogs.count().catch(() => 0);
  if (count === 0) {
    return null;
  }

  let bestIndex = -1;
  let bestScore = -1;
  for (let i = 0; i < count; i++) {
    const loc = dialogs.nth(i);
    const visible = await loc.isVisible({ timeout: 100 }).catch(() => false);
    if (!visible) continue;
    const metrics = await loc.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const zIndex = parseInt(style.zIndex || "0", 10);
      const area = rect.width * rect.height;
      return {
        zIndex: Number.isFinite(zIndex) ? zIndex : 0,
        area,
      };
    });
    const score = metrics.zIndex * 1_000_000 + metrics.area;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestIndex === -1) {
    return null;
  }

  return dialogs.nth(bestIndex);
}

async function scrollAllScrollables(root: Locator, maxSweeps: number): Promise<boolean> {
  let anyChanged = false;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    const changed = await root.evaluate((el) => {
      const nodes = Array.from(el.querySelectorAll<HTMLElement>("*"));
      let didScroll = false;
      for (const node of nodes) {
        const style = window.getComputedStyle(node);
        if ((style.overflowY === "auto" || style.overflowY === "scroll") &&
            node.scrollHeight > node.clientHeight + 5) {
          const before = node.scrollTop;
          node.scrollTop = node.scrollHeight;
          if (node.scrollTop !== before) {
            didScroll = true;
          }
        }
      }
      return didScroll;
    });
    anyChanged = anyChanged || changed;
    if (!changed) break;
    await waitForStability(root.page(), 100);
  }
  return anyChanged;
}

async function clickSubmitInDialog(dialog: Locator, page: Page, deadline: number): Promise<boolean> {
  if (Date.now() >= deadline) return false;

  const submitLocators = [
    dialog.getByRole("button", { name: /submit|continue|next|confirm|proceed|done|ok/i }),
    dialog.locator('button:has-text("Submit"), button:has-text("Continue"), button:has-text("Next")'),
    dialog.locator('input[type="submit"], button[type="submit"]'),
  ];

  for (const loc of submitLocators) {
    if (Date.now() >= deadline) return false;
    try {
      if (await loc.first().isVisible({ timeout: 150 }).catch(() => false)) {
        await loc.first().click({ timeout: 800 });
        console.log("    Dialog submit clicked");
        await waitForStability(page, 150);
        return !await dialog.isVisible({ timeout: 150 }).catch(() => false);
      }
    } catch { /* try next */ }
  }

  try {
    const anyButton = dialog.locator('button, [role="button"], input[type="submit"], input[type="button"], a').first();
    if (await anyButton.isVisible({ timeout: 150 }).catch(() => false)) {
      await anyButton.click({ timeout: 800 }).catch(() => {});
      console.log("    Dialog fallback button clicked");
      await waitForStability(page, 150);
      return !await dialog.isVisible({ timeout: 150 }).catch(() => false);
    }
  } catch { /* no-op */ }

  try {
    await page.keyboard.press("Enter");
    await waitForStability(page, 150);
  } catch { /* no-op */ }

  return !await dialog.isVisible({ timeout: 150 }).catch(() => false);
}

async function solveRadioModalBruteforce(page: Page, deadline: number): Promise<boolean> {
  const dialog = await getActiveDialog(page);
  if (!dialog) return false;

  console.log("  Radio modal detected, attempting brute-force solve");
  await scrollAllScrollables(dialog, 6);

  const correctSelectors = [
    'label:has-text("Correct") input[type="radio"]',
    'label:has-text("correct") input[type="radio"]',
    'input[type="radio"][value*="correct" i]',
    'label:has-text("Correct")',
    'label:has-text("correct")',
  ];

  for (const sel of correctSelectors) {
    if (Date.now() >= deadline) return false;
    const loc = dialog.locator(sel).first();
    if (await loc.isVisible({ timeout: 150 }).catch(() => false)) {
      await loc.click({ timeout: 800 }).catch(() => {});
      console.log(`    Dialog radio selected via: ${sel}`);
      if (await clickSubmitInDialog(dialog, page, deadline)) return true;
      const code = await domOnlyCodeCheck(page);
      if (code) return true;
    }
  }

  const radios = dialog.locator('input[type="radio"]');
  const radioCount = await radios.count().catch(() => 0);
  for (let i = 0; i < radioCount; i++) {
    if (Date.now() >= deadline) return false;
    const radio = radios.nth(i);
    if (!await radio.isVisible({ timeout: 150 }).catch(() => false)) {
      continue;
    }
    await radio.click({ timeout: 800 }).catch(() => {});
    console.log(`    Dialog radio clicked index=${i}`);
    if (await clickSubmitInDialog(dialog, page, deadline)) return true;
    const code = await domOnlyCodeCheck(page);
    if (code) return true;
  }

  return false;
}

async function actionSpaceExplorer(page: Page, deadline: number): Promise<string | null> {
  const clickable = page.locator('button, [role="button"], a, input[type="button"], input[type="submit"]');
  const count = await clickable.count().catch(() => 0);
  if (count === 0) return null;

  const candidates: Array<{ index: number; score: number; text: string }> = [];
  for (let i = 0; i < count; i++) {
    if (Date.now() >= deadline) break;
    const loc = clickable.nth(i);
    const visible = await loc.isVisible({ timeout: 100 }).catch(() => false);
    if (!visible) continue;
    const text = (await loc.textContent().catch(() => ""))?.trim() ?? "";
    const lower = text.toLowerCase();
    if (lower.includes("close") || lower.includes("dismiss") || lower.includes("accept") || lower.includes("got it")) {
      continue;
    }
    let score = 0;
    if (/reveal|show|code/.test(lower)) score += 50;
    if (/submit|continue|next|confirm|proceed|done/.test(lower)) score += 30;
    if (lower.length > 0) score += Math.min(lower.length, 20);
    candidates.push({ index: i, score, text });
  }

  candidates.sort((a, b) => b.score - a.score);
  for (const candidate of candidates) {
    if (Date.now() >= deadline) break;
    const loc = clickable.nth(candidate.index);
    if (!await loc.isVisible({ timeout: 100 }).catch(() => false)) {
      continue;
    }
    console.log(`    Action explorer click: "${candidate.text || "unnamed"}"`);
    await loc.click({ timeout: 800 }).catch(() => {});
    await waitForStability(page, 120);
    const code = await domOnlyCodeCheck(page);
    if (code) return code;
  }

  return null;
}

/**
 * Execute vision-recommended actions via DOM selectors.
 */
async function executeAnalysisActions(
  page: Page,
  analysis: PageAnalysis
): Promise<void> {
  console.log(`  Page: ${analysis.page_description}`);
  console.log(`  Modal: ${analysis.has_modal} | Code visible: ${analysis.has_code_visible} | Elements: ${analysis.interactive_elements}`);

  if (analysis.recommended_actions.length === 0) {
    console.log(`  No recommended actions`);
    return;
  }

  // Execute actions using DOM selectors (not coordinates)
  for (const action of analysis.recommended_actions) {
    console.log(`    Vision says: ${action.action} — ${action.description}`);

    switch (action.action) {
      case "click": {
        const desc = action.description;
        const hints = extractButtonHints(desc);
        const clicked = await domClick(page, hints);
        if (!clicked) {
          console.log(`    DOM click failed, falling back to coords (${action.target.x},${action.target.y})`);
          await clickAt(page, action.target.x, action.target.y);
          await waitForStability(page, 200);
        }
        break;
      }

      case "select_radio": {
        const selected = await domSelectRadio(page, action.description);
        if (!selected) {
          console.log(`    DOM radio failed, falling back to coords (${action.target.x},${action.target.y})`);
          await clickAt(page, action.target.x, action.target.y);
          await waitForStability(page, 200);
        }
        break;
      }

      case "scroll_modal": {
        const scrolled = await domScrollModal(page, "down");
        if (!scrolled) {
          await scrollInModal(page, action.target.x, action.target.y, 300);
          await waitForStability(page, 250);
        }
        break;
      }

      case "scroll_down":
        if (!await domScrollModal(page, "down")) {
          await page.mouse.wheel(0, 300);
          await waitForStability(page, 250);
        }
        break;

      case "scroll_up":
        if (!await domScrollModal(page, "up")) {
          await page.mouse.wheel(0, -300);
          await waitForStability(page, 250);
        }
        break;

      case "type_text":
        if (action.text_to_type) {
          try {
            const input = page.locator('input[type="text"]:visible, input:not([type]):visible, textarea:visible').first();
            await input.fill(action.text_to_type);
            console.log(`    DOM typed: "${action.text_to_type}"`);
            await waitForStability(page, 150);
          } catch {
            await clickAt(page, action.target.x, action.target.y);
            await waitForStability(page, 100);
            await typeText(page, action.text_to_type);
            await waitForStability(page, 150);
          }
        }
        break;
    }
  }

  await domClick(page, ["Submit", "Next", "Continue", "Confirm", "Proceed", "Done"]);
}

/**
 * Extract plausible button text hints from a vision action description.
 * e.g. "Click the Accept button" → ["Accept"]
 * e.g. "Click Submit inside the modal" → ["Submit"]
 */
function extractButtonHints(description: string): string[] {
  const hints: string[] = [];

  // Look for quoted text
  const quoted = description.match(/['"]([^'"]+)['"]/g);
  if (quoted) {
    for (const q of quoted) {
      hints.push(q.replace(/['"]/g, ""));
    }
  }

  // Look for common button keywords in the description
  const keywords = [
    "Accept", "Accept All", "Dismiss", "Close", "OK", "Got it",
    "Submit", "Next", "Continue", "Confirm", "Proceed", "Done",
    "Yes", "No", "Cancel", "Agree", "I Agree",
  ];
  for (const kw of keywords) {
    if (description.toLowerCase().includes(kw.toLowerCase())) {
      hints.push(kw);
    }
  }

  // If nothing found, use the full description as a hint
  if (hints.length === 0) {
    hints.push(description);
  }

  return hints;
}

/**
 * Submit a code using DOM selectors first, vision coordinates as fallback.
 * Returns true if submission was attempted.
 */
async function domSubmitCode(
  page: Page,
  config: AgentConfig,
  code: string,
  stepNumber: number,
  attempt: number,
  failedCoords: Coordinate[]
): Promise<boolean> {
  console.log(`  Submitting code: ${code}`);

  // --- Find input via DOM ---
  const inputSelectors = [
    'input[placeholder*="code" i]',
    'input[placeholder*="char" i]',
    'input[placeholder*="enter" i]',
    'input[placeholder*="verification" i]',
    'input[type="text"]',
    'input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="submit"]):not([type="button"])',
  ];

  let inputEl: ReturnType<Page["locator"]> | null = null;
  for (const sel of inputSelectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 300 }).catch(() => false)) {
        // Scroll input into view first — page may have scrolled away
        await loc.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
        await loc.fill(code);
        console.log(`    DOM input filled via: ${sel}`);
        inputEl = loc;
        break;
      }
    } catch { /* try next */ }
  }

  if (!inputEl) {
    // Fallback: vision-based input finding
    console.log(`    DOM input not found, trying vision...`);
    const img = await screenshot(page, `step${stepNumber}-a${attempt}-targets`);
    const prompt = failedCoords.length > 0
      ? submitTargetsWithFailedPrompt(failedCoords)
      : SUBMIT_TARGETS_PROMPT;

    const { parsed } = await callGemini<SubmitTargets>(
      config.apiKey,
      prompt,
      img,
      submitTargetsSchema,
      512
    );

    if (parsed.input_location.x === 0 && parsed.input_location.y === 0) {
      console.log(`    Vision also couldn't find input`);
      return false;
    }

    await tripleClickAt(page, parsed.input_location.x, parsed.input_location.y);
    await waitForStability(page, 100);
    await typeText(page, code);
    console.log(`    Vision input at (${parsed.input_location.x},${parsed.input_location.y})`);
  }

  // Wait for dynamic submit buttons to appear after input is filled
  await waitForStability(page, 300);

  // --- Find and click submit via DOM ---
  const trySubmitSelectors = async (): Promise<boolean> => {
    // Playwright built-in locators (most robust)
    const roleLocators: Array<{ loc: ReturnType<Page["locator"]>; label: string }> = [
      { loc: page.getByRole("button", { name: /submit/i }), label: "role:submit" },
      { loc: page.getByRole("button", { name: /verify/i }), label: "role:verify" },
      { loc: page.getByRole("button", { name: /check/i }), label: "role:check" },
      { loc: page.getByText("Submit Code", { exact: false }), label: "text:Submit Code" },
      { loc: page.getByText("Submit", { exact: false }), label: "text:Submit" },
      { loc: page.locator("button").filter({ hasText: /submit/i }), label: "filter:submit" },
    ];
    for (const { loc, label } of roleLocators) {
      try {
        if (await loc.first().isVisible({ timeout: 300 }).catch(() => false)) {
          await loc.first().scrollIntoViewIfNeeded({ timeout: 500 }).catch(() => {});
          await loc.first().click({ timeout: 1000 });
          console.log(`    DOM submit clicked via: ${label}`);
          return true;
        }
      } catch { /* try next */ }
    }

    // CSS selectors
    const cssSelectors = [
      'button:has-text("Submit Code")',
      'button:has-text("Submit")',
      'input[type="submit"]',
      'button[type="submit"]',
      'button:has-text("Verify")',
      'button:has-text("Check")',
      'button:has-text("Go")',
      'button:has-text("Enter")',
    ];
    for (const sel of cssSelectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 300 }).catch(() => false)) {
          await loc.scrollIntoViewIfNeeded({ timeout: 500 }).catch(() => {});
          await loc.click({ timeout: 1000 });
          console.log(`    DOM submit clicked via: ${sel}`);
          return true;
        }
      } catch { /* try next */ }
    }
    return false;
  };

  let submitFound = await trySubmitSelectors();

  // Fallback 1: Press Enter on the input field
  if (!submitFound && inputEl) {
    console.log(`    DOM submit not found, pressing Enter on input...`);
    try {
      await inputEl.press("Enter");
      console.log(`    Pressed Enter on input`);
      submitFound = true;
    } catch { /* input may have detached */ }
  }

  // Fallback 2: Scroll down 200px from input area and retry selectors
  if (!submitFound) {
    console.log(`    Still no submit — scrolling down and retrying...`);
    await page.mouse.wheel(0, 200);
    await waitForStability(page, 250);
    submitFound = await trySubmitSelectors();
  }

  if (!submitFound) {
    // Fallback 3: vision-based submit
    console.log(`    DOM submit not found, trying vision...`);
    const img = await screenshot(page, `step${stepNumber}-a${attempt}-submit-fallback`);
    const prompt = failedCoords.length > 0
      ? submitTargetsWithFailedPrompt(failedCoords)
      : SUBMIT_TARGETS_PROMPT;

    const { parsed } = await callGemini<SubmitTargets>(
      config.apiKey,
      prompt,
      img,
      submitTargetsSchema,
      512
    );

    if (parsed.submit_button.x === 0 && parsed.submit_button.y === 0) {
      console.log(`    Vision also couldn't find submit button`);
      return false;
    }

    await clickAt(page, parsed.submit_button.x, parsed.submit_button.y);
    console.log(`    Vision submit at (${parsed.submit_button.x},${parsed.submit_button.y})`);
    failedCoords.push(parsed.submit_button);
  }

  // Wait for page transition after submit
  await waitForStability(page, 1000);
  return true;
}

/**
 * DOM-based step verification. Reads "Step N of 30" text from the page.
 * Falls back to checking for completion/error indicators.
 */
async function verifyStep(
  page: Page,
  expectedStep: number
): Promise<VerifyResult> {
  // Try to read "Step N of 30" from DOM
  const stepText = await page.evaluate(() => {
    var body = document.body ? document.body.innerText : "";
    var m = body.match(/[Ss]tep\s+(\d+)\s+(?:of|\/)\s*30/);
    return m ? m[1] : null;
  });

  if (stepText) {
    const currentStep = parseInt(stepText, 10);
    console.log(`  DOM verify: Step ${currentStep} of 30 (expected > ${expectedStep})`);
    return {
      current_step: currentStep,
      advanced: currentStep > expectedStep,
      error_message: "",
      completed: currentStep > 30,
    };
  }

  // Check for completion indicators
  const completedText = await page.evaluate(() => {
    var body = (document.body ? document.body.innerText : "").toLowerCase();
    if (body.includes("congratulations") || body.includes("completed") ||
        body.includes("well done") || body.includes("all 30")) {
      return "completed";
    }
    // Check for error
    var m = body.match(/(incorrect|wrong|invalid|try again|error)[^.]*\./i);
    return m ? m[0] : null;
  });

  if (completedText === "completed") {
    console.log(`  DOM verify: Challenge completed!`);
    return { current_step: 31, advanced: true, error_message: "", completed: true };
  }

  if (completedText) {
    console.log(`  DOM verify: Error — "${completedText}"`);
    return { current_step: expectedStep, advanced: false, error_message: completedText, completed: false };
  }

  // Fallback: check if any step number is visible at all
  const anyStep = await page.evaluate(() => {
    var body = document.body ? document.body.innerText : "";
    var m = body.match(/[Ss]tep\s+(\d+)/);
    return m ? m[1] : null;
  });

  if (anyStep) {
    const current = parseInt(anyStep, 10);
    console.log(`  DOM verify (loose): Step ${current}`);
    return {
      current_step: current,
      advanced: current > expectedStep,
      error_message: "",
      completed: false,
    };
  }

  console.log(`  DOM verify: Could not determine step number`);
  return { current_step: expectedStep, advanced: false, error_message: "", completed: false };
}

const MAX_INTERACTION_ROUNDS = 2;

/**
 * DOM-only code check — no vision calls. Returns code or null.
 */
async function domOnlyCodeCheck(page: Page): Promise<string | null> {
  const domCodes = await extractCodesFromDOM(page);
  if (domCodes.length > 0) {
    const best = domCodes[0];
    if (best && best.score >= DOM_SCORE_THRESHOLD) {
      console.log(`  DOM code: ${best.code} (score=${best.score})`);
      return best.code;
    }
  }
  return null;
}

const DOM_FIRST_TIMEOUT_MS = 9000;

/**
 * DOM-first solve: try every common interaction pattern via DOM selectors.
 * No vision calls. Returns code if found, null otherwise.
 * Hard timeout of 9 seconds — bail to vision if DOM can't solve it fast.
 */
async function domFirstSolve(page: Page): Promise<string | null> {
  console.log(`  DOM-first solve (${DOM_FIRST_TIMEOUT_MS / 1000}s timeout)...`);
  const deadline = Date.now() + DOM_FIRST_TIMEOUT_MS;

  const expired = () => Date.now() >= deadline;

  // 1. Scroll to top
  await page.evaluate(() => window.scrollTo(0, 0));
  await waitForStability(page, 150);
  if (expired()) { console.log(`  DOM-first: timeout`); return null; }

  // 2. Check DOM for code (already visible)
  const initialCode = await domOnlyCodeCheck(page);
  if (initialCode) return initialCode;

  // 3. Click reveal/show buttons (including aria/data-action variants)
  const revealSelectors = [
    '[aria-label*="reveal" i]',
    '[aria-label*="show" i]',
    '[data-action*="reveal" i]',
    '[data-testid*="reveal" i]',
    '[data-testid*="show" i]',
  ];
  for (const sel of revealSelectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 200 }).catch(() => false)) {
      await loc.click({ timeout: 1000 });
      await waitForStability(page, 250);
      const code = await domOnlyCodeCheck(page);
      if (code) return code;
    }
    if (expired()) { console.log(`  DOM-first: timeout`); return null; }
  }

  // 4. Click reveal/show buttons by text
  const revealClicked = await domClick(page, [
    "Reveal Code", "Reveal", "Show Code", "Show", "Get Code", "Generate Code",
    "View Code", "Display Code", "Unlock",
  ]);
  if (revealClicked) {
    await waitForStability(page, 300);
    const code = await domOnlyCodeCheck(page);
    if (code) return code;
  }
  if (expired()) { console.log(`  DOM-first: timeout`); return null; }

  // 5. Handle modals with radio buttons: scoped brute-force solve
  if (await solveRadioModalBruteforce(page, deadline)) {
    const code = await domOnlyCodeCheck(page);
    if (code) return code;
  }
  if (expired()) { console.log(`  DOM-first: timeout`); return null; }

  // 6. Try clicking any visible "Submit" / "Next" / "Continue" (even without radio)
  const anySubmit = await domClick(page, [
    "Submit", "Continue", "Next", "Proceed", "Confirm", "Done", "OK", "Go",
  ]);
  if (anySubmit) {
    await waitForStability(page, 300);
    const code = await domOnlyCodeCheck(page);
    if (code) return code;
  }
  if (expired()) { console.log(`  DOM-first: timeout`); return null; }

  // 7. Try checkboxes (check all visible ones)
  const checkboxes = page.locator('input[type="checkbox"]');
  const cbCount = await checkboxes.count().catch(() => 0);
  if (cbCount > 0) {
    console.log(`    Found ${cbCount} checkboxes, checking all`);
    for (let i = 0; i < cbCount; i++) {
      try {
        const cb = checkboxes.nth(i);
        if (await cb.isVisible({ timeout: 200 }).catch(() => false)) {
          await cb.check({ timeout: 500 }).catch(() => {});
        }
      } catch { /* skip */ }
      if (expired()) break;
    }
    await waitForStability(page, 200);
    await domClick(page, ["Submit", "Continue", "Next", "Confirm"]);
    await waitForStability(page, 300);
    const code = await domOnlyCodeCheck(page);
    if (code) return code;
  }
  if (expired()) { console.log(`  DOM-first: timeout`); return null; }

  // 8. Try dropdowns / selects — pick the last option (often the "correct" one)
  const selects = page.locator("select");
  const selCount = await selects.count().catch(() => 0);
  if (selCount > 0) {
    console.log(`    Found ${selCount} select(s)`);
    for (let i = 0; i < selCount; i++) {
      try {
        const sel = selects.nth(i);
        const options = await sel.locator("option").allTextContents();
        const lastVal = options.filter((o) => o.trim()).pop();
        if (lastVal) {
          await sel.selectOption({ label: lastVal.trim() });
          console.log(`    Selected: "${lastVal.trim()}"`);
        }
      } catch { /* skip */ }
      if (expired()) break;
    }
    await waitForStability(page, 200);
    await domClick(page, ["Submit", "Continue", "Next", "Confirm"]);
    await waitForStability(page, 300);
    const code = await domOnlyCodeCheck(page);
    if (code) return code;
  }

  // 9. "Click here" / "click N times" patterns (cap to ~2s total)
  const clickHereDeadline = Date.now() + 2000;
  try {
    const clickTimesEl = page.getByText(/click.*times/i).first();
    if (await clickTimesEl.isVisible({ timeout: 200 }).catch(() => false)) {
      const text = await clickTimesEl.textContent().catch(() => "") || "";
      const numMatch = text.match(/(\\d+)\\s*times/i);
      const times = numMatch ? parseInt(numMatch[1], 10) : 2;
      console.log(`    Found "click ${times} times" — clicking`);
      for (let i = 0; i < Math.min(times, 6); i++) {
        await clickTimesEl.click().catch(() => {});
        await waitForStability(page, 120);
        if (Date.now() >= clickHereDeadline) break;
      }
      await waitForStability(page, 200);
      const code = await domOnlyCodeCheck(page);
      if (code) return code;
    }
  } catch { /* not found */ }

  try {
    const clickHereEl = page.getByText(/click here/i).first();
    if (await clickHereEl.isVisible({ timeout: 200 }).catch(() => false)) {
      console.log(`    Clicking "click here" element (capped)`);
      await clickHereEl.click().catch(() => {});
      await waitForStability(page, 150);
      const code = await domOnlyCodeCheck(page);
      if (code) return code;
    }
  } catch { /* not found */ }

  // 10. Action-space explorer (bounded, LLM-free)
  const exploreDeadline = Math.min(deadline, Date.now() + 3000);
  const exploreCode = await actionSpaceExplorer(page, exploreDeadline);
  if (exploreCode) return exploreCode;

  console.log(`  DOM-first solve: no code found`);
  return null;
}

export async function runStep(
  page: Page,
  config: AgentConfig,
  stepNumber: number
): Promise<StepResult> {
  const startTime = Date.now();
  console.log(`\n--- STEP ${stepNumber} ---`);

  const failedSubmitCoords: Coordinate[] = [];

  for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      console.log(`  Attempt ${attempt}/${MAX_STEP_ATTEMPTS}`);
    }

    // Phase 1: Dismiss distractors (DOM-only, fast)
    await dismissDistractors(page, config);

    // Phase 2: Quick DOM code check (no vision)
    let code = await domOnlyCodeCheck(page);

    // Phase 3: DOM-first solve — try all common patterns without vision
    if (!code) {
      code = await domFirstSolve(page);
    }

    // Phase 4: Vision fallback — only if DOM couldn't solve it
    if (!code) {
      console.log(`  DOM-first failed — falling back to vision`);
      for (let round = 0; round < MAX_INTERACTION_ROUNDS; round++) {
        const img = await screenshot(page, `step${stepNumber}-a${attempt}-r${round}`);
        const [combinedResult, analysisResult] = await callGeminiParallel<[CombinedResult, PageAnalysis]>(
          config.apiKey,
          [
            { prompt: COMBINED_PROMPT, schema: combinedSchema, thinkingBudget: 0 },
            { prompt: ANALYZE_PAGE_PROMPT, schema: analyzePageSchema, thinkingBudget: 0 },
          ],
          img
        );

        const combined = combinedResult.parsed;
        const analysis = analysisResult.parsed;

        if (combined.code !== "NONE" && combined.code.length === 6) {
          code = combined.code;
          console.log(`  Code found via combined vision: ${code}`);
          break;
        }

        if (analysis.has_code_visible && analysis.code !== "NONE" && analysis.code.length === 6) {
          code = analysis.code;
          console.log(`  Code found via analysis: ${code}`);
          break;
        }

        await executeAnalysisActions(page, analysis);
        code = await domOnlyCodeCheck(page);
        if (code) {
          console.log(`  Code found after interaction round ${round}: ${code}`);
          break;
        }

        if (analysis.recommended_actions.length === 0) {
          console.log(`  No more actions to try, scrolling page...`);
          await page.mouse.wheel(0, 300);
          await waitForStability(page, 300);
          code = await domOnlyCodeCheck(page);
          if (code) break;
          await page.evaluate(() => window.scrollTo(0, 0));
          await waitForStability(page, 200);
          break;
        }
      }
    }

    if (!code) {
      console.log(`  Could not find code on attempt ${attempt}`);
      continue;
    }

    // Phase 5: Submit code (DOM-first, vision fallback)
    const submitted = await domSubmitCode(page, config, code, stepNumber, attempt, failedSubmitCoords);
    if (!submitted) {
      console.log(`  Could not submit code`);
      continue;
    }

    // Phase 6: Verify (DOM-based)
    await waitForStability(page, 300);
    const verification = await verifyStep(page, stepNumber);

    if (verification.completed) {
      console.log("  CHALLENGE COMPLETED!");
      return {
        step: stepNumber,
        success: true,
        elapsed_ms: Date.now() - startTime,
        attempts: attempt,
      };
    }

    if (verification.advanced || verification.current_step > stepNumber) {
      console.log(`  Step ${stepNumber} passed! (now on step ${verification.current_step})`);
      return {
        step: stepNumber,
        success: true,
        elapsed_ms: Date.now() - startTime,
        attempts: attempt,
      };
    }

    // Step didn't advance
    if (verification.error_message) {
      console.log(`  Error: ${verification.error_message}`);
    }
  }

  console.log(`  Step ${stepNumber} FAILED after ${MAX_STEP_ATTEMPTS} attempts`);
  return {
    step: stepNumber,
    success: false,
    elapsed_ms: Date.now() - startTime,
    attempts: MAX_STEP_ATTEMPTS,
    error: "Max attempts exceeded",
  };
}

export async function runAgent(
  page: Page,
  config: AgentConfig
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const totalStart = Date.now();

  await runStartPhase(page, config);

  for (let step = 1; step <= 30; step++) {
    const elapsed = (Date.now() - totalStart) / 1000;
    if (elapsed > 290) {
      console.log(`\n  WARNING: Approaching 5min limit (${elapsed.toFixed(0)}s elapsed)`);
    }
    if (elapsed > 300) {
      console.log(`\n  HARD STOP: 5min limit reached`);
      break;
    }

    const result = await runStep(page, config, step);
    results.push(result);

    if (result.success) {
      const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
      console.log(`  [${totalElapsed}s total] Step ${step} complete in ${result.elapsed_ms}ms`);
    }

    // Check if challenge was completed (verify returns completed=true)
    // This is signaled by runStep seeing verification.completed
    // and we can detect it if step result indicates completion
  }

  const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
  const successful = results.filter((r) => r.success).length;
  console.log(`\n=== RESULTS ===`);
  console.log(`  Steps completed: ${successful}/30`);
  console.log(`  Total time: ${totalElapsed}s`);
  console.log(`  Avg per step: ${(parseFloat(totalElapsed) / successful).toFixed(1)}s`);

  return results;
}
