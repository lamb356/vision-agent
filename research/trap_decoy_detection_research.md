# Trap/Decoy Detection and Code/Text Extraction Research Report

## Executive Summary

This report provides comprehensive research on solving two specific problems in browser automation:
1. **Problem 2**: Phantom code extraction (false positives from CSS values like "1500ms", "1179px")
2. **Problem 4**: Decoy button identification (finding the real button among 25-40 decoys)

## Research Findings

### 1. Trap/Decoy Detection Techniques

#### 1.1 Common Decoy Patterns in Adversarial Web Interfaces

Based on research from bot detection literature [^75^][^76^][^77^], adversarial web interfaces use several trap mechanisms:

**Honeypot Elements:**
- Hidden form fields (display:none, visibility:hidden)
- Elements positioned off-screen (left: -9999px)
- Zero-opacity elements
- Elements with `tabindex="-1"`
- Elements inside `<noscript>` tags

**Stacked Elements:**
- Multiple clickable elements at the same coordinates
- Transparent overlays covering real buttons
- Z-index manipulation to hide real elements

**Visual Deception:**
- Buttons that look real but have no href/action
- Fake navigation elements
- Misleading labels ("Click Here" on trap elements)

#### 1.2 DOM-Level Indicators of Traps

From the research on bot detection [^75^][^76^][^104^]:

| Indicator | Real Element | Decoy/Trap |
|-----------|--------------|------------|
| Event Listeners | Has meaningful handlers | Empty or suspicious handlers |
| href attribute | Valid URL or javascript:void(0) | Missing, #, or javascript:; |
| data-* attributes | Functional data | Random/obfuscated values |
| aria-hidden | false or absent | true |
| tabindex | 0 or positive | -1 (unfocusable) |
| pointer-events | auto | none (click passes through) |
| cursor style | pointer | default |

#### 1.3 Visual Signals of Real vs Decoy Buttons

Based on computer vision research [^84^][^88^][^93^]:

**Real Button Characteristics:**
- Prominent color (often brand color or high contrast)
- Appropriate size (not too small, not full-width unless expected)
- Clear, actionable text ("Next", "Submit", "Continue")
- Proper padding and margins
- Visible border or shadow indicating interactivity
- Positioned in expected locations (bottom of forms, navigation areas)

**Decoy Button Characteristics:**
- Very small size (hard to click intentionally)
- Extremely large size (covers entire screen)
- Mismatched colors (low contrast, same as background)
- Generic text ("Button", "Click", no text)
- Positioned in unusual locations
- No visual feedback on hover/focus

---

### 2. Robust Code Extraction Strategies

#### 2.1 OCR vs DOM Text Extraction

Research comparison [^105^][^106^][^110^]:

| Factor | DOM Extraction | OCR (Screenshot) |
|--------|---------------|------------------|
| Speed | Fast (0.1-0.5s) | Slow (1-3s) |
| Accuracy | 100% (if element exists) | 95-99% |
| CSS Values | Included in DOM | Only visible text |
| Hidden Content | Can be extracted | Not visible |
| Anti-Detection | Lower | Higher |

**Recommendation**: Use DOM extraction with intelligent filtering, not OCR, for this use case.

#### 2.2 Context-Aware Regex Patterns

The problem: Simple regex `[a-zA-Z0-9]{6}` matches CSS values like "1500ms", "1179px", "1981px".

**Solution: Multi-layer filtering approach**

```
Layer 1: Extract all 6-char alphanumeric strings
Layer 2: Filter out CSS units (ms, px, pt, em, rem, %, s)
Layer 3: Filter by context (parent element, surrounding text)
Layer 4: Validate format (real codes often have specific patterns)
Layer 5: Deduplicate and rank by confidence
```

#### 2.3 False Positive Patterns to Exclude

| Pattern | Example | Filter Rule |
|---------|---------|-------------|
| Time values | 1500ms, 2.5s | Ends with ms, s, sec |
| Pixel values | 1179px, 100px | Ends with px |
| Point values | 12pt, 14pt | Ends with pt |
| EM values | 1.5em, 2em | Ends with em, rem |
| Percentages | 100%, 50% | Ends with % |
| Hex colors | #FF0000, #fff | Starts with # |
| RGB values | rgb(255,0,0) | Contains rgb/rgba/hsl |
| Numbers only | 123456 | All digits (if codes need letters) |

---

### 3. Visual Analysis for Button Identification

#### 3.1 Scoring System for Button Classification

Based on visual testing research [^88^][^91^][^93^]:

```
Score = Σ(weight_i × feature_i)

Features:
- Visibility (0-1): Is element actually visible?
- Clickability (0-1): Does it have proper event handlers?
- Text Quality (0-1): Does text indicate navigation purpose?
- Position Score (0-1): Is it in expected location?
- Size Appropriateness (0-1): Is size reasonable?
- Color Contrast (0-1): Is it visually prominent?
- Z-Index (0-1): Is it on top (not covered)?
```

#### 3.2 Context Clues from Page Instructions

When page says "Keep scrolling to find the navigation button":
- The real button is likely below the fold
- May require scrolling to become visible
- Could be at the bottom of a long page
- May appear after certain conditions are met

---

## TypeScript Implementation

### Complete Solution for Problem 2: Phantom Code Extraction

```typescript
import { Page, ElementHandle } from 'playwright';

interface ExtractedCode {
  code: string;
  confidence: number;
  source: string;
  context: string;
}

interface CodeExtractionConfig {
  minLength: number;
  maxLength: number;
  requireDigit: boolean;
  requireLetter: boolean;
  excludedUnits: string[];
  excludedPatterns: RegExp[];
}

const DEFAULT_CONFIG: CodeExtractionConfig = {
  minLength: 6,
  maxLength: 6,
  requireDigit: true,
  requireLetter: true,
  excludedUnits: ['ms', 'px', 'pt', 'em', 'rem', 's', 'sec', '%', 'vh', 'vw', 'deg'],
  excludedPatterns: [
    /^#?[0-9a-fA-F]{6}$/,  // Hex colors
    /^[0-9]{6}$/,           // Numbers only
    /^rgb/,                 // RGB values
    /^hsl/,                 // HSL values
    /^[0-9]+\.[0-9]+/,      // Decimal numbers
  ]
};

/**
 * Extract 6-character codes from page with intelligent filtering
 * to exclude CSS values and false positives
 */
export class CodeExtractor {
  private config: CodeExtractionConfig;

  constructor(config: Partial<CodeExtractionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Main extraction method - returns validated codes with confidence scores
   */
  async extractCodes(page: Page): Promise<ExtractedCode[]> {
    const candidates: ExtractedCode[] = [];

    // Method 1: Extract from visible text content only
    const textCodes = await this.extractFromVisibleText(page);
    candidates.push(...textCodes);

    // Method 2: Extract from specific data attributes
    const attrCodes = await this.extractFromDataAttributes(page);
    candidates.push(...attrCodes);

    // Method 3: Extract from meta tags
    const metaCodes = await this.extractFromMetaTags(page);
    candidates.push(...metaCodes);

    // Filter and rank results
    return this.filterAndRank(candidates);
  }

  /**
   * Extract codes from visible text only (excludes CSS in style attributes)
   */
  private async extractFromVisibleText(page: Page): Promise<ExtractedCode[]> {
    return page.evaluate((config) => {
      const results: ExtractedCode[] = [];
      const seen = new Set<string>();

      // Get all text nodes from visible elements (not style/script tags)
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            
            // Skip script, style, noscript tags
            const tagName = parent.tagName.toLowerCase();
            if (['script', 'style', 'noscript', 'template'].includes(tagName)) {
              return NodeFilter.FILTER_REJECT;
            }
            
            // Skip hidden elements
            const style = window.getComputedStyle(parent);
            if (style.display === 'none' || style.visibility === 'hidden') {
              return NodeFilter.FILTER_REJECT;
            }
            
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      const codeRegex = new RegExp(
        `\\b[a-zA-Z0-9]{${config.minLength},${config.maxLength}}\\b`, 
        'g'
      );

      let textNode: Text | null;
      while (textNode = walker.nextNode() as Text) {
        const text = textNode.textContent || '';
        const matches = text.match(codeRegex) || [];
        
        for (const match of matches) {
          if (!seen.has(match)) {
            seen.add(match);
            results.push({
              code: match,
              confidence: 0.7,
              source: 'visible_text',
              context: text.substring(0, 100)
            });
          }
        }
      }

      return results;
    }, this.config);
  }

  /**
   * Extract from data-* attributes commonly used for codes
   */
  private async extractFromDataAttributes(page: Page): Promise<ExtractedCode[]> {
    return page.evaluate((config) => {
      const results: ExtractedCode[] = [];
      const seen = new Set<string>();

      // Common attribute names that might contain codes
      const codeAttrs = [
        'data-code', 'data-token', 'data-key', 'data-id',
        'data-value', 'data-secret', 'data-answer'
      ];

      const codeRegex = new RegExp(
        `^[a-zA-Z0-9]{${config.minLength},${config.maxLength}}$`
      );

      for (const attr of codeAttrs) {
        const elements = document.querySelectorAll(`[${attr}]`);
        elements.forEach(el => {
          const value = el.getAttribute(attr);
          if (value && codeRegex.test(value) && !seen.has(value)) {
            seen.add(value);
            results.push({
              code: value,
              confidence: 0.9, // Higher confidence for data attributes
              source: `attr:${attr}`,
              context: el.tagName
            });
          }
        });
      }

      return results;
    }, this.config);
  }

  /**
   * Extract from meta tags
   */
  private async extractFromMetaTags(page: Page): Promise<ExtractedCode[]> {
    return page.evaluate((config) => {
      const results: ExtractedCode[] = [];
      const codeRegex = new RegExp(
        `^[a-zA-Z0-9]{${config.minLength},${config.maxLength}}$`
      );

      const metaTags = document.querySelectorAll('meta');
      metaTags.forEach(meta => {
        const content = meta.getAttribute('content');
        if (content && codeRegex.test(content)) {
          results.push({
            code: content,
            confidence: 0.6,
            source: 'meta_tag',
            context: meta.getAttribute('name') || 'unknown'
          });
        }
      });

      return results;
    }, this.config);
  }

  /**
   * Filter out false positives and rank by confidence
   */
  private filterAndRank(candidates: ExtractedCode[]): ExtractedCode[] {
    const filtered: ExtractedCode[] = [];

    for (const candidate of candidates) {
      const code = candidate.code;

      // Check 1: Must contain at least one digit if required
      if (this.config.requireDigit && !/\d/.test(code)) {
        continue;
      }

      // Check 2: Must contain at least one letter if required
      if (this.config.requireLetter && !/[a-zA-Z]/.test(code)) {
        continue;
      }

      // Check 3: Exclude CSS units
      const lowerCode = code.toLowerCase();
      for (const unit of this.config.excludedUnits) {
        if (lowerCode.endsWith(unit)) {
          candidate.confidence -= 0.5;
          break;
        }
      }

      // Check 4: Exclude pattern matches
      for (const pattern of this.config.excludedPatterns) {
        if (pattern.test(code)) {
          candidate.confidence -= 0.7;
          break;
        }
      }

      // Check 5: Context validation - boost confidence for good contexts
      if (this.isGoodContext(candidate.context)) {
        candidate.confidence += 0.2;
      }

      // Only keep codes with positive confidence
      if (candidate.confidence > 0.5) {
        filtered.push(candidate);
      }
    }

    // Sort by confidence descending
    return filtered.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Check if the context suggests this is a real code
   */
  private isGoodContext(context: string): boolean {
    const goodIndicators = [
      'code', 'token', 'key', 'secret', 'verify', 'confirm',
      'enter', 'input', 'submit', 'validation'
    ];
    const lowerContext = context.toLowerCase();
    return goodIndicators.some(ind => lowerContext.includes(ind));
  }
}
```

### Complete Solution for Problem 4: Decoy Button Identification

```typescript
import { Page, ElementHandle } from 'playwright';

interface ButtonScore {
  element: ElementHandle<Element>;
  score: number;
  reasons: string[];
  metadata: ButtonMetadata;
}

interface ButtonMetadata {
  text: string;
  isVisible: boolean;
  isClickable: boolean;
  hasHref: boolean;
  hasEventListeners: boolean;
  size: { width: number; height: number };
  position: { x: number; y: number };
  zIndex: number;
  colorContrast: number;
  isInViewport: boolean;
}

interface DecoyDetectorConfig {
  minButtonSize: { width: number; height: number };
  maxButtonSize: { width: number; height: number };
  requireVisible: boolean;
  requireClickable: boolean;
  navigationKeywords: string[];
  trapKeywords: string[];
}

const DEFAULT_DECOY_CONFIG: DecoyDetectorConfig = {
  minButtonSize: { width: 60, height: 30 },
  maxButtonSize: { width: 400, height: 150 },
  requireVisible: true,
  requireClickable: true,
  navigationKeywords: [
    'next', 'continue', 'proceed', 'submit', 'confirm', 'go',
    'navigate', 'forward', 'advance', 'enter', 'access'
  ],
  trapKeywords: [
    'trap', 'decoy', 'fake', 'test', 'honeypot', 'bait'
  ]
};

/**
 * Detects and identifies the real button among decoys/traps
 */
export class DecoyButtonDetector {
  private config: DecoyDetectorConfig;

  constructor(config: Partial<DecoyDetectorConfig> = {}) {
    this.config = { ...DEFAULT_DECOY_CONFIG, ...config };
  }

  /**
   * Find the most likely real button from all buttons on the page
   */
  async findRealButton(page: Page): Promise<ElementHandle<Element> | null> {
    // Get all buttons and button-like elements
    const buttons = await page.$$(`
      button:not([disabled]),
      a[href]:not([disabled]),
      [role="button"]:not([disabled]),
      input[type="submit"]:not([disabled]),
      input[type="button"]:not([disabled])
    `);

    if (buttons.length === 0) {
      return null;
    }

    // Score each button
    const scoredButtons: ButtonScore[] = [];
    for (const button of buttons) {
      const score = await this.scoreButton(page, button);
      scoredButtons.push(score);
    }

    // Sort by score descending
    scoredButtons.sort((a, b) => b.score - a.score);

    // Log analysis for debugging
    console.log('Button analysis:');
    scoredButtons.forEach((b, i) => {
      console.log(`${i + 1}. Score: ${b.score.toFixed(2)} - "${b.metadata.text}"`);
      console.log(`   Reasons: ${b.reasons.join(', ')}`);
    });

    // Return the highest scoring button
    return scoredButtons[0]?.element || null;
  }

  /**
   * Score a single button based on multiple heuristics
   */
  private async scoreButton(page: Page, element: ElementHandle<Element>): Promise<ButtonScore> {
    const metadata = await this.extractMetadata(page, element);
    const reasons: string[] = [];
    let score = 0;

    // Factor 1: Visibility (critical)
    if (metadata.isVisible) {
      score += 2;
      reasons.push('visible');
    } else if (this.config.requireVisible) {
      score -= 5;
      reasons.push('hidden');
    }

    // Factor 2: Clickability (critical)
    if (metadata.isClickable) {
      score += 2;
      reasons.push('clickable');
    } else if (this.config.requireClickable) {
      score -= 5;
      reasons.push('not-clickable');
    }

    // Factor 3: Has valid href or action
    if (metadata.hasHref) {
      score += 1.5;
      reasons.push('has-href');
    }

    // Factor 4: Size appropriateness
    const sizeScore = this.scoreSize(metadata.size);
    score += sizeScore;
    if (sizeScore > 0) reasons.push('good-size');
    else if (sizeScore < 0) reasons.push('bad-size');

    // Factor 5: Text content analysis
    const textScore = this.scoreText(metadata.text);
    score += textScore;
    if (textScore > 0) reasons.push('good-text');
    else if (textScore < 0) reasons.push('suspicious-text');

    // Factor 6: Position (prefer buttons in lower part of page for navigation)
    if (metadata.position.y > 500) {
      score += 0.5;
      reasons.push('lower-position');
    }

    // Factor 7: Z-index (prefer elements on top)
    if (metadata.zIndex > 0) {
      score += 0.5;
      reasons.push('on-top');
    }

    // Factor 8: Color contrast (prefer prominent buttons)
    if (metadata.colorContrast > 3) {
      score += 0.5;
      reasons.push('high-contrast');
    }

    // Factor 9: In viewport
    if (metadata.isInViewport) {
      score += 1;
      reasons.push('in-viewport');
    }

    // Factor 10: Check for trap indicators in element or ancestors
    const isTrap = await this.checkForTrapIndicators(element);
    if (isTrap) {
      score -= 3;
      reasons.push('possible-trap');
    }

    return { element, score, reasons, metadata };
  }

  /**
   * Extract comprehensive metadata about a button
   */
  private async extractMetadata(
    page: Page, 
    element: ElementHandle<Element>
  ): Promise<ButtonMetadata> {
    return element.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const text = el.textContent?.trim() || 
                   (el as HTMLInputElement).value?.trim() || 
                   '';

      // Check visibility
      const isVisible = style.display !== 'none' && 
                        style.visibility !== 'hidden' &&
                        style.opacity !== '0' &&
                        rect.width > 0 && 
                        rect.height > 0;

      // Check clickability
      const isClickable = style.pointerEvents !== 'none' &&
                          !el.hasAttribute('disabled');

      // Check href
      const hasHref = el.hasAttribute('href') &&
                      el.getAttribute('href') !== '#' &&
                      el.getAttribute('href') !== 'javascript:void(0)';

      // Check for event listeners (approximation)
      const hasEventListeners = el.onclick !== null ||
                                el.getAttribute('onclick') !== null;

      // Calculate color contrast (simplified)
      const bgColor = style.backgroundColor;
      const color = style.color;
      const colorContrast = bgColor !== color ? 4 : 1;

      // Check if in viewport
      const isInViewport = rect.top >= 0 &&
                           rect.left >= 0 &&
                           rect.bottom <= window.innerHeight &&
                           rect.right <= window.innerWidth;

      return {
        text,
        isVisible,
        isClickable,
        hasHref,
        hasEventListeners,
        size: { width: rect.width, height: rect.height },
        position: { x: rect.x, y: rect.y },
        zIndex: parseInt(style.zIndex) || 0,
        colorContrast,
        isInViewport
      };
    });
  }

  /**
   * Score button based on size
   */
  private scoreSize(size: { width: number; height: number }): number {
    const { minButtonSize, maxButtonSize } = this.config;

    // Too small - likely a trap
    if (size.width < minButtonSize.width || size.height < minButtonSize.height) {
      return -2;
    }

    // Too large - likely a trap
    if (size.width > maxButtonSize.width || size.height > maxButtonSize.height) {
      return -1.5;
    }

    // Good size range
    if (size.width >= 80 && size.width <= 200 &&
        size.height >= 35 && size.height <= 60) {
      return 1;
    }

    return 0;
  }

  /**
   * Score button based on text content
   */
  private scoreText(text: string): number {
    const lowerText = text.toLowerCase();
    let score = 0;

    // Check for navigation keywords (positive)
    for (const keyword of this.config.navigationKeywords) {
      if (lowerText.includes(keyword)) {
        score += 1;
      }
    }

    // Check for trap keywords (negative)
    for (const keyword of this.config.trapKeywords) {
      if (lowerText.includes(keyword)) {
        score -= 2;
      }
    }

    // Generic text is suspicious
    if (text === 'Button' || text === 'Click' || text === '') {
      score -= 1;
    }

    // Very long text is suspicious
    if (text.length > 50) {
      score -= 0.5;
    }

    return score;
  }

  /**
   * Check for trap indicators in element and ancestors
   */
  private async checkForTrapIndicators(element: ElementHandle<Element>): Promise<boolean> {
    return element.evaluate((el) => {
      // Check element and up to 3 ancestors
      let current: Element | null = el;
      let depth = 0;

      while (current && depth < 4) {
        // Check for honeypot indicators
        if (current.className.includes('honeypot') ||
            current.className.includes('trap') ||
            current.className.includes('decoy') ||
            current.id.includes('honeypot') ||
            current.id.includes('trap')) {
          return true;
        }

        // Check for aria-hidden
        if (current.getAttribute('aria-hidden') === 'true') {
          return true;
        }

        // Check for negative tabindex
        if (current.getAttribute('tabindex') === '-1') {
          return true;
        }

        // Check style for hidden positioning
        const style = (current as HTMLElement).style;
        if (style.position === 'absolute' && 
            (style.left === '-9999px' || style.top === '-9999px')) {
          return true;
        }

        current = current.parentElement;
        depth++;
      }

      return false;
    });
  }

  /**
   * Scroll to find navigation button as instructed by page
   */
  async scrollToFindButton(page: Page, maxScrolls: number = 10): Promise<ElementHandle<Element> | null> {
    for (let i = 0; i < maxScrolls; i++) {
      // Try to find button at current scroll position
      const button = await this.findRealButton(page);
      if (button) {
        const isVisible = await button.isVisible();
        if (isVisible) {
          return button;
        }
      }

      // Scroll down
      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 0.8);
      });

      // Wait for any lazy-loaded content
      await page.waitForTimeout(500);
    }

    return null;
  }
}
```

### Combined Usage Example

```typescript
import { chromium } from 'playwright';
import { CodeExtractor } from './code-extractor';
import { DecoyButtonDetector } from './decoy-detector';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto('https://example-challenge.com');

    // Problem 2: Extract codes with filtering
    const codeExtractor = new CodeExtractor({
      minLength: 6,
      maxLength: 6,
      requireDigit: true,
      requireLetter: true
    });

    const codes = await codeExtractor.extractCodes(page);
    console.log('Extracted codes:', codes);

    // Use the highest confidence code
    if (codes.length > 0) {
      const bestCode = codes[0];
      console.log(`Using code: ${bestCode.code} (confidence: ${bestCode.confidence})`);
      // Submit code...
    }

    // Problem 4: Find real button among decoys
    const buttonDetector = new DecoyButtonDetector();
    
    // If page says "Keep scrolling..."
    const realButton = await buttonDetector.scrollToFindButton(page, 10);
    
    if (realButton) {
      await realButton.click();
      console.log('Clicked the real button!');
    } else {
      console.log('Could not identify real button');
    }

  } finally {
    await browser.close();
  }
}

main();
```

---

## Additional Strategies

### 1. Hybrid DOM + Visual Approach

For maximum reliability, combine DOM analysis with visual verification:

```typescript
async function verifyButtonVisually(page: Page, element: ElementHandle): Promise<boolean> {
  // Take screenshot of element
  const screenshot = await element.screenshot();
  
  // Use simple heuristics on screenshot
  // - Check if element has reasonable dimensions
  // - Verify it's not a 1x1 pixel trap
  // - Confirm it has visible content
  
  const box = await element.boundingBox();
  if (!box) return false;
  
  return box.width >= 10 && box.height >= 10;
}
```

### 2. Pre-submission Code Validation

Before submitting extracted codes:

```typescript
function validateCode(code: string): { valid: boolean; reason?: string } {
  // Must be exactly 6 chars
  if (code.length !== 6) {
    return { valid: false, reason: 'Length not 6' };
  }

  // Must contain at least 1 digit and 1 letter
  if (!/\d/.test(code) || !/[a-zA-Z]/.test(code)) {
    return { valid: false, reason: 'Missing digit or letter' };
  }

  // Exclude known CSS patterns
  const cssPatterns = [/\d{4}ms/, /\d{3,4}px/, /\d+pt/, /\d+em/];
  for (const pattern of cssPatterns) {
    if (pattern.test(code)) {
      return { valid: false, reason: 'Matches CSS pattern' };
    }
  }

  return { valid: true };
}
```

### 3. Machine Learning Enhancement

For advanced scenarios, train a simple classifier:

```typescript
// Features for ML classification
interface ButtonFeatures {
  aspectRatio: number;
  area: number;
  textLength: number;
  hasNavigationWord: boolean;
  isInForm: boolean;
  isPrimaryColor: boolean;
  zIndex: number;
}

// Simple rule-based classifier (could be replaced with trained model)
function classifyButton(features: ButtonFeatures): 'real' | 'decoy' | 'unknown' {
  let score = 0;
  
  if (features.hasNavigationWord) score += 2;
  if (features.isPrimaryColor) score += 1;
  if (features.isInForm) score += 1;
  if (features.aspectRatio > 2 && features.aspectRatio < 6) score += 1;
  if (features.area > 2000 && features.area < 20000) score += 1;
  
  if (score >= 4) return 'real';
  if (score <= 1) return 'decoy';
  return 'unknown';
}
```

---

## Summary of Key Recommendations

### For Problem 2 (Phantom Code Extraction):

1. **Use TreeWalker** to extract only from visible text nodes, excluding script/style tags
2. **Filter by context** - prefer codes in user-facing content areas
3. **Exclude CSS units** - filter out values ending in ms, px, pt, em, etc.
4. **Require mixed alphanumeric** - real codes usually have both letters and numbers
5. **Validate before submission** - check against known false positive patterns
6. **Use confidence scoring** - rank candidates and pick highest confidence

### For Problem 4 (Decoy Button Identification):

1. **Multi-factor scoring** - combine visibility, clickability, size, text, position
2. **Check for trap indicators** - aria-hidden, tabindex=-1, honeypot classes
3. **Analyze text content** - prefer buttons with navigation-related text
4. **Verify size appropriateness** - exclude too-small or too-large buttons
5. **Check z-index** - real buttons should be on top, not covered
6. **Scroll incrementally** - when page says "keep scrolling", scroll and re-check
7. **Log analysis** - track scores for debugging and refinement

---

## References

- [^75^] Bot Detection Guide 2025 - Human Security
- [^76^] Bot Detection and Prevention - Formspree
- [^77^] How To Fight the Ongoing Battle Between AI and CAPTCHA - Checkmarx
- [^84^] Automatically Detecting Online Deceptive Patterns - arXiv
- [^88^] AI Visual Testing - BrowserStack
- [^93^] Building Human-Like Web Automation with Computer Vision - Medium
- [^104^] What Is a Honeypot? - Palo Alto Networks
- [^105^] Types of Data Extraction in Web Scraping - Dataprixa
