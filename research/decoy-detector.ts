/**
 * Decoy Button Detector Module
 * 
 * Solves Problem 4: Decoy Button Identification
 * Identifies the real button among 25-40 decoys/traps
 */

import { Page, ElementHandle } from 'playwright';

export interface ButtonScore {
  element: ElementHandle<Element>;
  score: number;
  reasons: string[];
  metadata: ButtonMetadata;
}

export interface ButtonMetadata {
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
  tagName: string;
  classes: string;
  id: string;
}

export interface DecoyDetectorConfig {
  minButtonSize: { width: number; height: number };
  maxButtonSize: { width: number; height: number };
  requireVisible: boolean;
  requireClickable: boolean;
  navigationKeywords: string[];
  trapKeywords: string[];
  suspiciousSelectors: string[];
}

export const DEFAULT_DECOY_CONFIG: DecoyDetectorConfig = {
  minButtonSize: { width: 60, height: 30 },
  maxButtonSize: { width: 400, height: 150 },
  requireVisible: true,
  requireClickable: true,
  navigationKeywords: [
    'next', 'continue', 'proceed', 'submit', 'confirm', 'go',
    'navigate', 'forward', 'advance', 'enter', 'access', 'login',
    'signin', 'register', 'signup', 'start', 'begin', 'finish',
    'complete', 'save', 'apply', 'send', 'download', 'open'
  ],
  trapKeywords: [
    'trap', 'decoy', 'fake', 'test', 'honeypot', 'bait',
    'dummy', 'placeholder', 'sample', 'example'
  ],
  suspiciousSelectors: [
    '.honeypot', '.trap', '.decoy', '.fake', '[aria-hidden="true"]',
    '[tabindex="-1"]', '[style*="display:none"]',
    '[style*="visibility:hidden"]', '[style*="opacity:0"]'
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
      input[type="button"]:not([disabled]),
      .btn:not([disabled]),
      .button:not([disabled])
    `);

    if (buttons.length === 0) {
      console.log('No buttons found on page');
      return null;
    }

    console.log(`Found ${buttons.length} potential buttons`);

    // Score each button
    const scoredButtons: ButtonScore[] = [];
    for (const button of buttons) {
      const score = await this.scoreButton(page, button);
      scoredButtons.push(score);
    }

    // Sort by score descending
    scoredButtons.sort((a, b) => b.score - a.score);

    // Log analysis for debugging
    console.log('\n=== Button Analysis ===');
    scoredButtons.slice(0, 10).forEach((b, i) => {
      console.log(`${i + 1}. Score: ${b.score.toFixed(2)} - "${b.metadata.text}" (${b.metadata.tagName})`);
      console.log(`   Reasons: ${b.reasons.join(', ')}`);
      console.log(`   Size: ${b.metadata.size.width}x${b.metadata.size.height}, Position: (${b.metadata.position.x}, ${b.metadata.position.y})`);
    });

    // Return the highest scoring button if it meets threshold
    const bestButton = scoredButtons[0];
    if (bestButton && bestButton.score > 2) {
      return bestButton.element;
    }

    console.log('No button met the confidence threshold');
    return null;
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

    // Factor 4: Has event listeners
    if (metadata.hasEventListeners) {
      score += 1;
      reasons.push('has-handler');
    }

    // Factor 5: Size appropriateness
    const sizeScore = this.scoreSize(metadata.size);
    score += sizeScore;
    if (sizeScore > 0) reasons.push('good-size');
    else if (sizeScore < 0) reasons.push('bad-size');

    // Factor 6: Text content analysis
    const textScore = this.scoreText(metadata.text);
    score += textScore;
    if (textScore > 0) reasons.push('good-text');
    else if (textScore < 0) reasons.push('suspicious-text');

    // Factor 7: Position (prefer buttons in lower part of page for navigation)
    if (metadata.position.y > 300) {
      score += 0.5;
      reasons.push('lower-position');
    }

    // Factor 8: Z-index (prefer elements on top)
    if (metadata.zIndex > 0) {
      score += 0.5;
      reasons.push('on-top');
    }

    // Factor 9: Color contrast (prefer prominent buttons)
    if (metadata.colorContrast > 3) {
      score += 0.5;
      reasons.push('high-contrast');
    }

    // Factor 10: In viewport
    if (metadata.isInViewport) {
      score += 1;
      reasons.push('in-viewport');
    }

    // Factor 11: Check for trap indicators
    const isTrap = await this.checkForTrapIndicators(element);
    if (isTrap) {
      score -= 4;
      reasons.push('possible-trap');
    }

    // Factor 12: Check if element is covered by another element
    const isCovered = await this.checkIfCovered(page, element);
    if (isCovered) {
      score -= 2;
      reasons.push('covered');
    }

    // Factor 13: Prefer certain tag types
    if (metadata.tagName === 'BUTTON' || metadata.tagName === 'A') {
      score += 0.5;
      reasons.push('standard-tag');
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
                   (el as HTMLInputElement).placeholder?.trim() ||
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
      const href = el.getAttribute('href');
      const hasHref = href !== null &&
                      href !== '#' &&
                      href !== 'javascript:void(0)' &&
                      href !== 'javascript:;' &&
                      href !== '';

      // Check for event listeners (approximation)
      const hasEventListeners = el.onclick !== null ||
                                el.getAttribute('onclick') !== null ||
                                el.getAttribute('data-onclick') !== null;

      // Calculate color contrast (simplified)
      const bgColor = style.backgroundColor;
      const color = style.color;
      const colorContrast = bgColor !== color && bgColor !== 'transparent' ? 4 : 1;

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
        isInViewport,
        tagName: el.tagName.toUpperCase(),
        classes: el.className || '',
        id: el.id || ''
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
        score += 1.5;
      }
    }

    // Check for trap keywords (negative)
    for (const keyword of this.config.trapKeywords) {
      if (lowerText.includes(keyword)) {
        score -= 3;
      }
    }

    // Generic text is suspicious
    if (text === 'Button' || text === 'Click' || text === 'Click Here' || text === '') {
      score -= 1.5;
    }

    // Very long text is suspicious
    if (text.length > 50) {
      score -= 0.5;
    }

    // Very short text is also suspicious
    if (text.length > 0 && text.length < 3) {
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
        const htmlEl = current as HTMLElement;
        
        // Check for honeypot indicators in class/id
        const classAndId = (current.className || '') + ' ' + (current.id || '');
        if (/honeypot|trap|decoy|fake|bait/i.test(classAndId)) {
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
        const style = htmlEl.style;
        if (style.position === 'absolute' || style.position === 'fixed') {
          if (parseInt(style.left) < -1000 || parseInt(style.top) < -1000) {
            return true;
          }
        }

        // Check computed style
        const computedStyle = window.getComputedStyle(current);
        if (computedStyle.display === 'none' || 
            computedStyle.visibility === 'hidden' ||
            computedStyle.opacity === '0') {
          return true;
        }

        current = current.parentElement;
        depth++;
      }

      return false;
    });
  }

  /**
   * Check if element is covered by another element
   */
  private async checkIfCovered(page: Page, element: ElementHandle<Element>): Promise<boolean> {
    return element.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      // Get element at center point
      const topElement = document.elementFromPoint(centerX, centerY);

      // Check if top element is the same or a child of our element
      if (!topElement) return true;
      if (topElement === el) return false;
      if (el.contains(topElement)) return false;

      // Element is covered by something else
      return true;
    });
  }

  /**
   * Scroll to find navigation button as instructed by page
   */
  async scrollToFindButton(page: Page, maxScrolls: number = 10): Promise<ElementHandle<Element> | null> {
    console.log(`Scrolling to find button (max ${maxScrolls} scrolls)...`);

    for (let i = 0; i < maxScrolls; i++) {
      console.log(`\nScroll attempt ${i + 1}/${maxScrolls}`);
      
      // Try to find button at current scroll position
      const button = await this.findRealButton(page);
      if (button) {
        const isVisible = await button.isVisible();
        if (isVisible) {
          console.log('Found real button!');
          return button;
        }
      }

      // Scroll down
      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 0.7);
      });

      // Wait for any lazy-loaded content
      await page.waitForTimeout(800);

      // Check if we've reached bottom
      const isAtBottom = await page.evaluate(() => {
        return window.innerHeight + window.scrollY >= document.body.scrollHeight - 100;
      });

      if (isAtBottom) {
        console.log('Reached bottom of page');
        break;
      }
    }

    console.log('Could not find button after scrolling');
    return null;
  }

  /**
   * Get all buttons with their scores for analysis
   */
  async analyzeAllButtons(page: Page): Promise<ButtonScore[]> {
    const buttons = await page.$$(`
      button:not([disabled]),
      a[href]:not([disabled]),
      [role="button"]:not([disabled]),
      input[type="submit"]:not([disabled]),
      input[type="button"]:not([disabled])
    `);

    const scoredButtons: ButtonScore[] = [];
    for (const button of buttons) {
      const score = await this.scoreButton(page, button);
      scoredButtons.push(score);
    }

    return scoredButtons.sort((a, b) => b.score - a.score);
  }
}

export default DecoyButtonDetector;
