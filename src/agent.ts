import type { Page } from "playwright";
import type {
  AgentConfig,
  Coordinate,
  CodeResult,
  SubmitTargets,
  VerifyResult,
  PageAnalysis,
  StepResult,
} from "./types.js";
import { callGemini } from "./gemini.js";
import {
  CODE_PROMPT,
  SUBMIT_TARGETS_PROMPT,
  START_PROMPT,
  ANALYZE_PAGE_PROMPT,
  submitTargetsWithFailedPrompt,
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

const MAX_DISTRACTOR_ROUNDS = 3;
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
  // Ordered by priority: most specific first
  const dismissSelectors = [
    // Cookie consent
    'button:has-text("Accept")',
    'button:has-text("Accept All")',
    'button:has-text("Got it")',
    'button:has-text("I Agree")',
    'button:has-text("Agree")',
    // Dismiss/close
    'button:has-text("Dismiss")',
    'button:has-text("Close")',
    'button:has-text("OK")',
    'button:has-text("×")',
    'button:has-text("✕")',
    'button:has-text("X")',
    // ARIA / class based
    '[aria-label="Close"]',
    '[aria-label="Dismiss"]',
    '[aria-label="close"]',
    '.close-button',
    '.close-btn',
    '.dismiss-button',
    '.dismiss-btn',
    '.modal-close',
    '.btn-close',
    // Generic close icons (often an X in a corner)
    'button.close',
    '[data-dismiss="modal"]',
    '[data-bs-dismiss="modal"]',
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
            await waitForStability(page, 200);
          }
        } catch { /* element may have disappeared */ }
      }
    }

    // Also press Escape
    await pressEscape(page);
    await waitForStability(page, 200);

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
    1024
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
        await loc.first().click({ timeout: 1000 });
        console.log(`    DOM click (role): "${hint}"`);
        await waitForStability(page, 300);
        return true;
      }
    } catch { /* not found */ }

    // Strategy 2: getByText — catches any element with matching text (spans, divs, etc.)
    try {
      const loc = page.getByText(hint, { exact: false }).first();
      if (await loc.isVisible({ timeout: 300 }).catch(() => false)) {
        await loc.click({ timeout: 1000 });
        console.log(`    DOM click (text): "${hint}"`);
        await waitForStability(page, 300);
        return true;
      }
    } catch { /* not found */ }

    // Strategy 3: CSS button:has-text
    try {
      const loc = page.locator(`button:has-text("${hint}")`).first();
      if (await loc.isVisible({ timeout: 300 }).catch(() => false)) {
        await loc.click({ timeout: 1000 });
        console.log(`    DOM click (css-button): "${hint}"`);
        await waitForStability(page, 300);
        return true;
      }
    } catch { /* not found */ }

    // Strategy 4: CSS [role="button"]:has-text — for styled divs
    try {
      const loc = page.locator(`[role="button"]:has-text("${hint}")`).first();
      if (await loc.isVisible({ timeout: 300 }).catch(() => false)) {
        await loc.click({ timeout: 1000 });
        console.log(`    DOM click (css-role): "${hint}"`);
        await waitForStability(page, 300);
        return true;
      }
    } catch { /* not found */ }

    // Strategy 5: links
    try {
      const loc = page.getByRole("link", { name: hint, exact: false });
      if (await loc.first().isVisible({ timeout: 300 }).catch(() => false)) {
        await loc.first().click({ timeout: 1000 });
        console.log(`    DOM click (link): "${hint}"`);
        await waitForStability(page, 300);
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
        await waitForStability(page, 300);
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
        await waitForStability(page, 300);
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
        await waitForStability(page, 300);
        return true;
      }
    } catch { /* skip */ }
  }

  // Strategy 4: Last resort — click the second radio (often the "correct" one in challenges)
  if (radioCount >= 2) {
    try {
      await radios.nth(1).click({ timeout: 1000 });
      console.log(`    DOM radio fallback: clicked radio[1] of ${radioCount}`);
      await waitForStability(page, 300);
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
    await waitForStability(page, 400);
  }
  return scrolled;
}

/**
 * Analyze page with vision model, then execute actions via DOM selectors.
 * Vision tells us WHAT to do. DOM selectors EXECUTE it reliably.
 */
async function analyzeAndInteract(
  page: Page,
  config: AgentConfig,
  stepNumber: number,
  round: number
): Promise<PageAnalysis> {
  const img = await screenshot(page, `step${stepNumber}-analyze-r${round}`);
  const { parsed: analysis } = await callGemini<PageAnalysis>(
    config.apiKey,
    ANALYZE_PAGE_PROMPT,
    img,
    analyzePageSchema,
    2048
  );

  console.log(`  Page: ${analysis.page_description}`);
  console.log(`  Modal: ${analysis.has_modal} | Code visible: ${analysis.has_code_visible} | Elements: ${analysis.interactive_elements}`);

  if (analysis.recommended_actions.length === 0) {
    console.log(`  No recommended actions`);
    return analysis;
  }

  // Execute actions using DOM selectors (not coordinates)
  for (const action of analysis.recommended_actions) {
    console.log(`    Vision says: ${action.action} — ${action.description}`);

    switch (action.action) {
      case "click": {
        // Extract button text from the description
        const desc = action.description;
        const hints = extractButtonHints(desc);
        const clicked = await domClick(page, hints);
        if (!clicked) {
          // Fallback to coordinate click
          console.log(`    DOM click failed, falling back to coords (${action.target.x},${action.target.y})`);
          await clickAt(page, action.target.x, action.target.y);
          await waitForStability(page, 400);
        }
        break;
      }

      case "select_radio": {
        const selected = await domSelectRadio(page, action.description);
        if (!selected) {
          console.log(`    DOM radio failed, falling back to coords (${action.target.x},${action.target.y})`);
          await clickAt(page, action.target.x, action.target.y);
          await waitForStability(page, 300);
        }
        break;
      }

      case "scroll_modal": {
        const scrolled = await domScrollModal(page, "down");
        if (!scrolled) {
          // Fallback to mouse wheel at coordinates
          await scrollInModal(page, action.target.x, action.target.y, 300);
          await waitForStability(page, 400);
        }
        break;
      }

      case "scroll_down":
        if (!await domScrollModal(page, "down")) {
          await page.mouse.wheel(0, 300);
          await waitForStability(page, 400);
        }
        break;

      case "scroll_up":
        if (!await domScrollModal(page, "up")) {
          await page.mouse.wheel(0, -300);
          await waitForStability(page, 400);
        }
        break;

      case "type_text":
        if (action.text_to_type) {
          // Find visible input and type into it
          try {
            const input = page.locator('input[type="text"]:visible, input:not([type]):visible, textarea:visible').first();
            await input.fill(action.text_to_type);
            console.log(`    DOM typed: "${action.text_to_type}"`);
            await waitForStability(page, 200);
          } catch {
            await clickAt(page, action.target.x, action.target.y);
            await waitForStability(page, 100);
            await typeText(page, action.text_to_type);
            await waitForStability(page, 200);
          }
        }
        break;
    }
  }

  // After executing all vision-recommended actions, also try common patterns:
  // If there's a modal with a Submit/Next/Continue button, click it
  await domClick(page, ["Submit", "Next", "Continue", "Confirm", "Proceed", "Done"]);

  return analysis;
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
  await waitForStability(page, 500);

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
    await waitForStability(page, 400);
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
  await waitForStability(page, 1500);
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

const MAX_INTERACTION_ROUNDS = 4;

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

const DOM_FIRST_TIMEOUT_MS = 15000;

/**
 * DOM-first solve: try every common interaction pattern via DOM selectors.
 * No vision calls. Returns code if found, null otherwise.
 * Hard timeout of 15 seconds — bail to vision if DOM can't solve it fast.
 */
async function domFirstSolve(page: Page): Promise<string | null> {
  console.log(`  DOM-first solve (${DOM_FIRST_TIMEOUT_MS / 1000}s timeout)...`);
  const deadline = Date.now() + DOM_FIRST_TIMEOUT_MS;

  const expired = () => Date.now() >= deadline;

  // 1. Scroll to top
  await page.evaluate(() => window.scrollTo(0, 0));
  await waitForStability(page, 200);
  if (expired()) { console.log(`  DOM-first: timeout`); return null; }

  // 2. Click reveal/show buttons
  const revealClicked = await domClick(page, [
    "Reveal Code", "Reveal", "Show Code", "Show", "Get Code", "Generate Code",
    "View Code", "Display Code", "Unlock",
  ]);
  if (revealClicked) {
    await waitForStability(page, 600);
    const code = await domOnlyCodeCheck(page);
    if (code) return code;
  }
  if (expired()) { console.log(`  DOM-first: timeout`); return null; }

  // 3. Look for "click here" / "click N times" patterns and click them
  try {
    const clickHereEl = page.getByText(/click here/i).first();
    if (await clickHereEl.isVisible({ timeout: 300 }).catch(() => false)) {
      console.log(`    Clicking "click here" element`);
      await clickHereEl.click();
      await waitForStability(page, 300);
      await clickHereEl.click().catch(() => {});
      await waitForStability(page, 300);
      await clickHereEl.click().catch(() => {});
      await waitForStability(page, 400);
      const code = await domOnlyCodeCheck(page);
      if (code) return code;
    }
  } catch { /* not found */ }
  if (expired()) { console.log(`  DOM-first: timeout`); return null; }

  // Check for "click X times" pattern
  try {
    const clickTimesEl = page.getByText(/click.*times/i).first();
    if (await clickTimesEl.isVisible({ timeout: 300 }).catch(() => false)) {
      const text = await clickTimesEl.textContent().catch(() => "") || "";
      const numMatch = text.match(/(\d+)\s*times/i);
      const times = numMatch ? parseInt(numMatch[1], 10) : 3;
      console.log(`    Found "click ${times} times" — clicking`);
      for (let i = 0; i < Math.min(times, 10); i++) {
        await clickTimesEl.click().catch(() => {});
        await waitForStability(page, 150);
        if (expired()) break;
      }
      await waitForStability(page, 400);
      const code = await domOnlyCodeCheck(page);
      if (code) return code;
    }
  } catch { /* not found */ }
  if (expired()) { console.log(`  DOM-first: timeout`); return null; }

  // 4. Handle modals with radio buttons: select "correct" one, click Submit
  const radioSelected = await domSelectRadio(page, "correct");
  if (radioSelected) {
    await waitForStability(page, 300);
    const submitted = await domClick(page, [
      "Submit", "Continue", "Next", "Confirm", "Done", "OK", "Proceed",
    ]);
    if (submitted) {
      await waitForStability(page, 600);
      const code = await domOnlyCodeCheck(page);
      if (code) return code;
    }
  }
  if (expired()) { console.log(`  DOM-first: timeout`); return null; }

  // 5. Scroll modal containers to bottom to reveal hidden content
  const scrolled = await domScrollModal(page, "down");
  if (scrolled) {
    await waitForStability(page, 400);
    const code = await domOnlyCodeCheck(page);
    if (code) return code;

    if (!expired()) {
      const radioAfterScroll = await domSelectRadio(page, "correct");
      if (radioAfterScroll) {
        await waitForStability(page, 300);
        await domClick(page, ["Submit", "Continue", "Next", "Confirm", "Done"]);
        await waitForStability(page, 600);
        const code2 = await domOnlyCodeCheck(page);
        if (code2) return code2;
      }
    }

    if (!expired()) {
      await domScrollModal(page, "down");
      await waitForStability(page, 400);
      const code3 = await domOnlyCodeCheck(page);
      if (code3) return code3;
    }
  }
  if (expired()) { console.log(`  DOM-first: timeout`); return null; }

  // 6. Try clicking any visible "Submit" / "Next" / "Continue" (even without radio)
  const anySubmit = await domClick(page, [
    "Submit", "Continue", "Next", "Proceed", "Confirm", "Done", "OK", "Go",
  ]);
  if (anySubmit) {
    await waitForStability(page, 600);
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
    await waitForStability(page, 300);
    await domClick(page, ["Submit", "Continue", "Next", "Confirm"]);
    await waitForStability(page, 600);
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
    await waitForStability(page, 300);
    await domClick(page, ["Submit", "Continue", "Next", "Confirm"]);
    await waitForStability(page, 600);
    const code = await domOnlyCodeCheck(page);
    if (code) return code;
  }

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
      code = await tryExtractCode(page, config, `step${stepNumber}-a${attempt}-vision`);
    }

    if (!code) {
      for (let round = 0; round < MAX_INTERACTION_ROUNDS; round++) {
        // Analyze page and execute recommended interactions
        const analysis = await analyzeAndInteract(page, config, stepNumber, round);

        // If vision found a code during analysis, use it
        if (analysis.has_code_visible && analysis.code !== "NONE" && analysis.code.length === 6) {
          code = analysis.code;
          console.log(`  Code found via analysis: ${code}`);
          break;
        }

        // Check DOM again after interactions
        code = await tryExtractCode(page, config, `step${stepNumber}-a${attempt}-post-interact-r${round}`);
        if (code) {
          console.log(`  Code found after interaction round ${round}: ${code}`);
          break;
        }

        // If no actions were recommended, we're stuck
        if (analysis.recommended_actions.length === 0) {
          console.log(`  No more actions to try, scrolling page...`);
          await page.mouse.wheel(0, 300);
          await waitForStability(page, 500);

          // One more DOM check after scroll
          code = await tryExtractCode(page, config, `step${stepNumber}-a${attempt}-scrolled-r${round}`);
          if (code) break;

          // Scroll back up
          await page.evaluate(() => window.scrollTo(0, 0));
          await waitForStability(page, 300);
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
    await waitForStability(page, 500);
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
