import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

const DEBUG_DIR = "debug";

export interface BrowserInstance {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export async function launchBrowser(
  headed: boolean
): Promise<BrowserInstance> {
  const browser = await chromium.launch({ headless: !headed });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: "recordings/", size: { width: 1280, height: 800 } },
  });

  const page = await context.newPage();
  return { browser, context, page };
}

export async function screenshot(page: Page, label?: string): Promise<string> {
  const buffer = await page.screenshot({ fullPage: false });
  const base64 = buffer.toString("base64");

  // Save to debug/ with timestamp
  if (label) {
    await mkdir(DEBUG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = join(DEBUG_DIR, `${ts}_${label}.png`);
    await writeFile(filename, buffer);
    console.log(`  [SCREENSHOT] ${filename}`);
  }

  return base64;
}

export async function clickAt(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.click(x, y);
}

export async function tripleClickAt(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.click(x, y, { clickCount: 3 });
}

export async function typeText(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 30 });
}

export async function pressEscape(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
}

export async function navigateTo(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "networkidle" });
}

export async function waitForStability(page: Page, ms: number = 500): Promise<void> {
  await page.waitForTimeout(ms);
}

/**
 * Search DOM for 6-character alphanumeric codes.
 * Checks: visible text, hidden elements, data attributes, input values.
 */
// String-based evaluate to avoid tsx injecting __name helpers into the browser context
const DOM_EXTRACT_SCRIPT = `
(function() {
  var codes = {};
  var codePattern = /\\b[A-Za-z0-9]{6}\\b/g;
  var m;

  // 1. All visible text content
  var bodyText = document.body ? document.body.innerText : "";
  while ((m = codePattern.exec(bodyText)) !== null) { codes[m[0]] = 1; }

  // 2. Hidden elements + data attributes + input values
  var allEls = document.querySelectorAll("*");
  for (var i = 0; i < allEls.length; i++) {
    var el = allEls[i];
    var style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" ||
        style.opacity === "0" || el.hidden) {
      var text = el.textContent || "";
      codePattern.lastIndex = 0;
      while ((m = codePattern.exec(text)) !== null) { codes[m[0]] = 1; }
    }
    for (var j = 0; j < el.attributes.length; j++) {
      var attr = el.attributes[j];
      if (attr.name.indexOf("data-") === 0) {
        codePattern.lastIndex = 0;
        while ((m = codePattern.exec(attr.value)) !== null) { codes[m[0]] = 1; }
      }
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      codePattern.lastIndex = 0;
      var val = el.value || "";
      while ((m = codePattern.exec(val)) !== null) { codes[m[0]] = 1; }
    }
  }

  // Filter — expanded exclude list
  var excludeWords = [
    "submit","cancel","button","hidden","scroll","normal","center",
    "middle","inline","return","reveal","cookie","accept","please",
    "select","option","choice","moving","loaded","filler","tempor",
    "labore","dolore","aliqua","veniam","cillum","fugiat","mollit",
    "beatae","string","number","object","window","module","export",
    "import","static","public","script","screen","cursor","border",
    "margin","layout","height","before","filter","shadow","bottom",
    "nowrap","repeat","italic","notice","dialog","choose","answer",
    "change","remove","create","update","delete","insert","search",
    "enable","closed","toggle","switch","result","verify","pickup",
    "random","sample","styles","classe","colors","values","params",
    "action","target","source","output","config","struct","render",
    "design","simple","custom","unique","active","parent","inputs",
    "events","stored","loaded","copied","failed","passed","signed",
    "loggin","picker","widget","portal","modals","alerts","toasts",
    "expand","shrink","rotate","resize","ground","placed","linked"
  ];
  var excludeSet = {};
  for (var k = 0; k < excludeWords.length; k++) { excludeSet[excludeWords[k]] = 1; }
  var cssUnitPattern = /\\d+(px|em|ms|rem|vh|vw|pt|ch)$/i;

  var candidates = [];
  var keys = Object.keys(codes);
  for (var k = 0; k < keys.length; k++) {
    var c = keys[k];
    if (excludeSet[c.toLowerCase()]) continue;
    if (cssUnitPattern.test(c)) continue;
    candidates.push(c);
  }

  // Score: mixed alphanumeric > uppercase+digit > pure upper > pure digit > pure lower
  function scoreCode(c) {
    var s = 0;
    var hasDigit = /[0-9]/.test(c);
    var hasUpper = /[A-Z]/.test(c);
    var hasLower = /[a-z]/.test(c);
    var digitCount = (c.match(/[0-9]/g) || []).length;
    var upperCount = (c.match(/[A-Z]/g) || []).length;
    if (hasDigit && (hasUpper || hasLower)) s += 100;
    if (hasDigit && hasUpper && !hasLower) s += 50;
    s += digitCount * 15;
    s += upperCount * 10;
    // Pure lowercase = almost certainly a word
    if (!hasDigit && !hasUpper) s -= 200;
    // Title Case (e.g. "Notice", "Dialog") = very likely a word
    if (hasUpper && hasLower && !hasDigit && upperCount === 1 && /^[A-Z]/.test(c)) s -= 150;
    // Pure uppercase no digits = might be abbreviation but less likely a code
    if (hasUpper && !hasLower && !hasDigit) s -= 20;
    // Pure digits = could be a code but less likely than mixed
    if (!hasUpper && !hasLower) s += 20;
    return s;
  }

  // Return [{code, score}] so caller can apply threshold
  candidates.sort(function(a, b) { return scoreCode(b) - scoreCode(a); });
  var result = [];
  for (var k = 0; k < candidates.length; k++) {
    result.push({ code: candidates[k], score: scoreCode(candidates[k]) });
  }
  return result;
})()
`;

export interface DOMCodeCandidate {
  code: string;
  score: number;
}

export async function extractCodesFromDOM(page: Page): Promise<DOMCodeCandidate[]> {
  return page.evaluate(DOM_EXTRACT_SCRIPT) as Promise<DOMCodeCandidate[]>;
}

/**
 * Scroll within a modal/element at the given coordinates.
 */
export async function scrollInModal(page: Page, x: number, y: number, deltaY: number = 300): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, deltaY);
}

export async function closeBrowser(instance: BrowserInstance): Promise<void> {
  // context.close() finalizes video recording
  await instance.context.close();
  await instance.browser.close();
}
