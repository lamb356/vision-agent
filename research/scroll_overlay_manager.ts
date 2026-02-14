/**
 * Scroll Strategy & Overlay/Popup Manager for Browser Automation
 * 
 * This module provides comprehensive solutions for:
 * - Problem 5: Overlay/Popup Management (trap popups, safe removal)
 * - Problem 6: Scroll Strategy (long pages, content discovery)
 * 
 * Based on research from WebVoyager, Playwright best practices, and
 * production browser automation patterns.
 */

import { Page, Locator, ElementHandle } from 'playwright';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface ScrollOptions {
  /** Maximum number of scroll attempts */
  maxScrolls?: number;
  /** Pixels to scroll each time (default: viewport height * 0.8) */
  scrollAmount?: number;
  /** Wait time after each scroll in ms */
  waitAfterScroll?: number;
  /** Stop when this element is found */
  targetSelector?: string;
  /** Stop condition callback */
  stopCondition?: () => Promise<boolean>;
}

export interface OverlayDetectionResult {
  isOverlay: boolean;
  confidence: number;
  reasons: string[];
  element: ElementHandle | null;
}

export interface ScrollState {
  scrollY: number;
  scrollHeight: number;
  clientHeight: number;
  contentHash: string;
  timestamp: number;
}

export interface ContentDiscoveryResult {
  found: boolean;
  element: Locator | null;
  scrollCount: number;
  finalScrollY: number;
}

// ============================================================================
// SCROLL STRATEGY IMPLEMENTATION
// ============================================================================

export class ScrollManager {
  private page: Page;
  private scrollHistory: ScrollState[] = [];
  private mutationObserver: any = null;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Get current scroll state for comparison
   */
  async getScrollState(): Promise<ScrollState> {
    return await this.page.evaluate(() => {
      const body = document.body;
      const html = document.documentElement;
      
      // Create a simple content hash based on visible element count
      const visibleElements = document.querySelectorAll('body *:not(script):not(style)');
      const contentHash = Array.from(visibleElements)
        .slice(0, 100)
        .map(el => el.tagName + (el as HTMLElement).className)
        .join('')
        .slice(0, 500);
      
      return {
        scrollY: window.scrollY,
        scrollHeight: Math.max(body.scrollHeight, body.offsetHeight, html.scrollHeight),
        clientHeight: window.innerHeight,
        contentHash: contentHash,
        timestamp: Date.now()
      };
    });
  }

  /**
   * Calculate optimal scroll amount based on viewport
   */
  async calculateScrollAmount(ratio: number = 0.8): Promise<number> {
    const viewportHeight = await this.page.evaluate(() => window.innerHeight);
    return Math.floor(viewportHeight * ratio);
  }

  /**
   * Check if scrolling has stopped producing new content
   */
  async hasContentStabilized(checks: number = 3): Promise<boolean> {
    if (this.scrollHistory.length < checks) return false;
    
    const recent = this.scrollHistory.slice(-checks);
    const first = recent[0];
    const last = recent[recent.length - 1];
    
    // Check if scroll height hasn't changed
    const heightStable = first.scrollHeight === last.scrollHeight;
    
    // Check if content hash is similar
    const contentStable = first.contentHash === last.contentHash;
    
    // Check if we've reached the bottom
    const atBottom = last.scrollY + last.clientHeight >= last.scrollHeight - 100;
    
    return (heightStable && contentStable) || atBottom;
  }

  /**
   * Progressive scroll with content discovery
   * 
   * Strategy:
   * 1. Scroll by viewport-sized increments
   * 2. Wait for lazy-loaded content
   * 3. Check for target elements
   * 4. Detect infinite scroll vs finite pages
   * 5. Stop when content stabilizes or max scrolls reached
   */
  async progressiveScroll(options: ScrollOptions = {}): Promise<ContentDiscoveryResult> {
    const {
      maxScrolls = 50,
      scrollAmount: fixedScrollAmount,
      waitAfterScroll = 1000,
      targetSelector,
      stopCondition
    } = options;

    const scrollAmount = fixedScrollAmount || await this.calculateScrollAmount(0.8);
    let scrollCount = 0;
    let targetFound = false;
    let foundElement: Locator | null = null;

    console.log(`[ScrollManager] Starting progressive scroll (max: ${maxScrolls}, amount: ${scrollAmount}px)`);

    while (scrollCount < maxScrolls) {
      // Check for target element before scrolling
      if (targetSelector) {
        const target = this.page.locator(targetSelector).first();
        const isVisible = await target.isVisible().catch(() => false);
        if (isVisible) {
          console.log(`[ScrollManager] Target element found: ${targetSelector}`);
          targetFound = true;
          foundElement = target;
          break;
        }
      }

      // Check custom stop condition
      if (stopCondition && await stopCondition()) {
        console.log(`[ScrollManager] Stop condition met at scroll ${scrollCount}`);
        break;
      }

      // Record state before scroll
      const beforeState = await this.getScrollState();
      this.scrollHistory.push(beforeState);

      // Perform scroll
      await this.page.evaluate((amount) => {
        window.scrollBy(0, amount);
      }, scrollAmount);

      scrollCount++;
      console.log(`[ScrollManager] Scroll #${scrollCount} completed`);

      // Wait for content to load
      await this.page.waitForTimeout(waitAfterScroll);

      // Record state after scroll
      const afterState = await this.getScrollState();
      this.scrollHistory.push(afterState);

      // Check if we've reached the end
      if (await this.hasContentStabilized(2)) {
        console.log(`[ScrollManager] Content stabilized after ${scrollCount} scrolls`);
        break;
      }

      // Check for infinite scroll trigger
      const newContentLoaded = beforeState.scrollHeight !== afterState.scrollHeight;
      if (newContentLoaded) {
        console.log(`[ScrollManager] New content loaded (height: ${beforeState.scrollHeight} -> ${afterState.scrollHeight})`);
      }
    }

    const finalState = await this.getScrollState();
    return {
      found: targetFound,
      element: foundElement,
      scrollCount,
      finalScrollY: finalState.scrollY
    };
  }

  /**
   * Scroll to element with retry logic
   */
  async scrollToElement(selector: string, maxRetries: number = 3): Promise<boolean> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const element = this.page.locator(selector).first();
        await element.scrollIntoViewIfNeeded({ timeout: 5000 });
        return true;
      } catch (e) {
        console.log(`[ScrollManager] Scroll attempt ${i + 1} failed, retrying...`);
        await this.page.waitForTimeout(500);
      }
    }
    return false;
  }

  /**
   * Smart scroll for infinite scroll pages
   * 
   * Detects when infinite scroll stops loading new content
   */
  async infiniteScrollUntilStable(
    options: {
      maxScrolls?: number;
      stabilityChecks?: number;
      waitAfterScroll?: number;
    } = {}
  ): Promise<number> {
    const { maxScrolls = 30, stabilityChecks = 3, waitAfterScroll = 1500 } = options;
    
    let scrollCount = 0;
    let stableCount = 0;
    let lastHeight = 0;

    console.log(`[ScrollManager] Starting infinite scroll detection`);

    while (scrollCount < maxScrolls && stableCount < stabilityChecks) {
      const currentHeight = await this.page.evaluate(() => document.body.scrollHeight);
      
      if (currentHeight === lastHeight) {
        stableCount++;
        console.log(`[ScrollManager] Stability check ${stableCount}/${stabilityChecks}`);
      } else {
        stableCount = 0;
        console.log(`[ScrollManager] Page height changed: ${lastHeight} -> ${currentHeight}`);
      }

      lastHeight = currentHeight;

      // Scroll to bottom
      await this.page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });

      scrollCount++;
      await this.page.waitForTimeout(waitAfterScroll);
    }

    console.log(`[ScrollManager] Infinite scroll complete after ${scrollCount} iterations`);
    return scrollCount;
  }

  /**
   * Scroll and scan for interactive elements
   * 
   * Useful for discovering buttons, forms, and links while scrolling
   */
  async scrollAndScan(
    scanCallback: (elements: ElementInfo[]) => Promise<boolean>,
    options: ScrollOptions = {}
  ): Promise<{ elementsFound: number; scrollCount: number }> {
    const allElements: ElementInfo[] = [];
    const seenSelectors = new Set<string>();

    const result = await this.progressiveScroll({
      ...options,
      stopCondition: async () => {
        // Scan for new elements
        const elements = await this.getInteractiveElements();
        const newElements = elements.filter(el => !seenSelectors.has(el.selector));
        
        newElements.forEach(el => seenSelectors.add(el.selector));
        allElements.push(...newElements);

        // Call user callback with accumulated elements
        return await scanCallback(allElements);
      }
    });

    return {
      elementsFound: allElements.length,
      scrollCount: result.scrollCount
    };
  }

  /**
   * Get all interactive elements on the current viewport
   */
  async getInteractiveElements(): Promise<ElementInfo[]> {
    return await this.page.evaluate(() => {
      const elements: ElementInfo[] = [];
      const interactiveSelectors = [
        'button:not([disabled])',
        'a[href]',
        'input:not([disabled])',
        'textarea:not([disabled])',
        'select:not([disabled])',
        '[role="button"]',
        '[role="link"]',
        '[onclick]',
        '[tabindex]:not([tabindex="-1"])'
      ];

      interactiveSelectors.forEach(selector => {
        document.querySelectorAll(selector).forEach((el, index) => {
          const rect = el.getBoundingClientRect();
          const computedStyle = window.getComputedStyle(el);
          
          // Only include visible elements in viewport
          if (rect.top >= 0 && rect.top <= window.innerHeight && 
              computedStyle.display !== 'none' && 
              computedStyle.visibility !== 'hidden' &&
              computedStyle.opacity !== '0') {
            elements.push({
              tagName: el.tagName.toLowerCase(),
              selector: `${selector}:nth-of-type(${index + 1})`,
              text: el.textContent?.slice(0, 50) || '',
              boundingBox: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height
              },
              isVisible: true
            });
          }
        });
      });

      return elements;
    });
  }

  /**
   * Reset scroll position
   */
  async resetScroll(): Promise<void> {
    await this.page.evaluate(() => window.scrollTo(0, 0));
    this.scrollHistory = [];
  }
}

// ============================================================================
// OVERLAY/POPUP MANAGER
// ============================================================================

export class OverlayManager {
  private page: Page;
  private removedOverlays: Set<string> = new Set();
  private protectedSelectors: string[] = [
    // Never remove these elements
    'body',
    'html',
    'head',
    'main',
    'article',
    'nav',
    'header:not([class*="popup"]):not([class*="modal"]):not([class*="overlay"])',
    'footer:not([class*="popup"]):not([class*="modal"]):not([class*="overlay"])',
    'script',
    'style',
    'link',
    'meta'
  ];

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Detect if an element is likely an overlay/popup
   * 
   * Uses multiple heuristics:
   * 1. Z-index analysis
   * 2. Position fixed/absolute
   * 3. Size (full or near-full viewport)
   * 4. Visual indicators (backdrop, close buttons)
   * 5. Content analysis (prize, alert, cookie text)
   */
  async detectOverlay(element: ElementHandle): Promise<OverlayDetectionResult> {
    const result = await element.evaluate((el) => {
      const reasons: string[] = [];
      let confidence = 0;
      const htmlElement = el as HTMLElement;
      
      const computedStyle = window.getComputedStyle(htmlElement);
      const rect = htmlElement.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      // Check z-index
      const zIndex = parseInt(computedStyle.zIndex) || 0;
      if (zIndex > 100) {
        reasons.push(`High z-index: ${zIndex}`);
        confidence += 20;
      }
      if (zIndex > 1000) {
        confidence += 30;
      }

      // Check position
      const position = computedStyle.position;
      if (position === 'fixed') {
        reasons.push('Position: fixed');
        confidence += 25;
      }
      if (position === 'absolute' && zIndex > 10) {
        reasons.push('Position: absolute with z-index');
        confidence += 15;
      }

      // Check size (overlays often cover most of viewport)
      const coversViewport = (
        rect.width >= viewportWidth * 0.5 &&
        rect.height >= viewportHeight * 0.3
      );
      if (coversViewport) {
        reasons.push(`Large size: ${Math.round(rect.width)}x${Math.round(rect.height)}`);
        confidence += 20;
      }

      // Check for backdrop/overlay styling
      const hasBackdrop = computedStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
                          computedStyle.backgroundColor !== 'transparent';
      if (hasBackdrop && (computedStyle.backgroundColor.includes('0.') || 
                          computedStyle.backgroundColor.includes('rgb(0, 0, 0'))) {
        reasons.push('Has backdrop styling');
        confidence += 15;
      }

      // Check for trap popup keywords in content
      const textContent = htmlElement.textContent?.toLowerCase() || '';
      const trapKeywords = ['prize', 'won', 'winner', 'alert', 'congratulations', 
                            'you have won', 'claim', 'free', 'click here', 'urgent'];
      const foundKeywords = trapKeywords.filter(kw => textContent.includes(kw));
      if (foundKeywords.length > 0) {
        reasons.push(`Trap keywords: ${foundKeywords.join(', ')}`);
        confidence += 25;
      }

      // Check for cookie/consent banner patterns
      const cookieKeywords = ['cookie', 'consent', 'gdpr', 'privacy', 'accept', 
                              'agree', 'terms', 'policy'];
      const foundCookieKeywords = cookieKeywords.filter(kw => textContent.includes(kw));
      if (foundCookieKeywords.length >= 2) {
        reasons.push(`Cookie banner keywords: ${foundCookieKeywords.join(', ')}`);
        confidence += 20;
      }

      // Check for close button
      const hasCloseButton = htmlElement.querySelector(
        '[class*="close"], [class*="dismiss"], button[aria-label*="close"], ' +
        '.fa-times, .fa-xmark, [data-dismiss]'
      ) !== null;
      if (hasCloseButton) {
        reasons.push('Has close/dismiss button');
        confidence += 10;
      }

      // Check if element is centered (modal pattern)
      const isCentered = (
        Math.abs(rect.left + rect.width/2 - viewportWidth/2) < viewportWidth * 0.2 &&
        Math.abs(rect.top + rect.height/2 - viewportHeight/2) < viewportHeight * 0.2
      );
      if (isCentered && position === 'fixed') {
        reasons.push('Centered modal pattern');
        confidence += 15;
      }

      return {
        isOverlay: confidence >= 50,
        confidence,
        reasons,
        element: null // Will be set by caller
      };
    });

    result.element = element;
    return result;
  }

  /**
   * Find all potential overlay elements on the page
   */
  async findOverlays(): Promise<ElementHandle[]> {
    // Query for common overlay patterns
    const overlaySelectors = [
      // Modal dialogs
      '[role="dialog"]',
      '[role="alertdialog"]',
      '.modal',
      '.modal-dialog',
      '.popup',
      '.overlay',
      '[class*="modal"]',
      '[class*="popup"]',
      '[class*="overlay"]',
      '[class*="dialog"]',
      
      // Fixed position elements that might be overlays
      'div[style*="position: fixed"]',
      'div[style*="position:fixed"]',
      'div[style*="z-index: 10"]',
      'div[style*="z-index: 9"]',
      
      // Cookie/consent banners
      '[class*="cookie"]',
      '[class*="consent"]',
      '[id*="cookie"]',
      '[id*="consent"]',
      '[class*="gdpr"]',
      
      // Common trap popup patterns
      '[class*="prize"]',
      '[class*="winner"]',
      '[class*="alert"]'
    ];

    const overlays: ElementHandle[] = [];
    const seen = new Set<string>();

    for (const selector of overlaySelectors) {
      try {
        const elements = await this.page.locator(selector).elementHandles();
        for (const el of elements) {
          // Use element property to deduplicate
          const isDuplicate = await this.isDuplicateElement(el, seen);
          if (!isDuplicate) {
            overlays.push(el);
          }
        }
      } catch (e) {
        // Selector might be invalid, continue
      }
    }

    return overlays;
  }

  /**
   * Check if element is a duplicate based on bounding box
   */
  private async isDuplicateElement(el: ElementHandle, seen: Set<string>): Promise<boolean> {
    const box = await el.boundingBox();
    if (!box) return true;
    
    const key = `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}`;
    if (seen.has(key)) return true;
    
    seen.add(key);
    return false;
  }

  /**
   * Safely remove overlay elements
   * 
   * Uses whitelist approach to avoid removing important elements
   */
  async removeOverlays(options: {
    minConfidence?: number;
    preserveSelectors?: string[];
    clickCloseFirst?: boolean;
  } = {}): Promise<{ removed: number; clicked: number; errors: string[] }> {
    const { 
      minConfidence = 50, 
      preserveSelectors = [],
      clickCloseFirst = true 
    } = options;

    const result = { removed: 0, clicked: 0, errors: [] as string[] };
    const overlays = await this.findOverlays();

    console.log(`[OverlayManager] Found ${overlays.length} potential overlays`);

    for (const overlay of overlays) {
      try {
        // Check if element should be preserved
        if (await this.shouldPreserveElement(overlay, preserveSelectors)) {
          console.log(`[OverlayManager] Preserving protected element`);
          continue;
        }

        // Detect if it's really an overlay
        const detection = await this.detectOverlay(overlay);
        console.log(`[OverlayManager] Detection confidence: ${detection.confidence} (${detection.reasons.join(', ')})`);

        if (detection.confidence < minConfidence) {
          continue;
        }

        // Try clicking close button first
        if (clickCloseFirst) {
          const clicked = await this.clickCloseButton(overlay);
          if (clicked) {
            result.clicked++;
            await this.page.waitForTimeout(300);
            continue;
          }
        }

        // Remove the overlay via DOM manipulation
        await this.safeRemoveElement(overlay);
        result.removed++;

      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        result.errors.push(errorMsg);
      }
    }

    return result;
  }

  /**
   * Check if element should be preserved
   */
  private async shouldPreserveElement(
    element: ElementHandle, 
    additionalSelectors: string[]
  ): Promise<boolean> {
    const allProtected = [...this.protectedSelectors, ...additionalSelectors];
    
    return await element.evaluate((el, protectedSelectors) => {
      const htmlEl = el as HTMLElement;
      
      // Check tag name
      if (protectedSelectors.some(s => s === htmlEl.tagName.toLowerCase())) {
        return true;
      }
      
      // Check if matches protected selector
      for (const selector of protectedSelectors) {
        if (selector.includes(':') || selector.includes('[') || selector.includes('.')) {
          try {
            if (htmlEl.matches(selector)) return true;
          } catch (e) {
            // Invalid selector, skip
          }
        }
      }
      
      // Check if element contains important content
      const importantTags = ['form', 'input', 'button', 'nav', 'main'];
      for (const tag of importantTags) {
        if (htmlEl.querySelector(tag) !== null) {
          // Element contains important interactive content
          return true;
        }
      }
      
      return false;
    }, allProtected);
  }

  /**
   * Try to find and click close button within overlay
   */
  private async clickCloseButton(overlay: ElementHandle): Promise<boolean> {
    const closeSelectors = [
      'button[class*="close"]',
      'button[class*="dismiss"]',
      '[class*="close"]',
      '[class*="dismiss"]',
      '[aria-label*="close" i]',
      '[aria-label*="dismiss" i]',
      '[data-dismiss]',
      '.fa-times',
      '.fa-xmark',
      '.icon-close',
      'button:has-text("Close")',
      'button:has-text("Dismiss")',
      'button:has-text("×")',
      'button:has-text("X")',
      '[class*="modal"] > button:first-child',
      '[class*="popup"] > button:first-child'
    ];

    for (const selector of closeSelectors) {
      try {
        const closeButton = await overlay.$(selector);
        if (closeButton) {
          const isVisible = await closeButton.isVisible().catch(() => false);
          if (isVisible) {
            await closeButton.click();
            console.log(`[OverlayManager] Clicked close button: ${selector}`);
            return true;
          }
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    return false;
  }

  /**
   * Safely remove an element from the DOM
   * 
   * Uses multiple safety checks to prevent removing important elements
   */
  private async safeRemoveElement(element: ElementHandle): Promise<boolean> {
    return await element.evaluate((el) => {
      const htmlEl = el as HTMLElement;
      
      // Final safety checks before removal
      const tagName = htmlEl.tagName.toLowerCase();
      const protectedTags = ['body', 'html', 'head', 'script', 'style', 'link', 'meta'];
      
      if (protectedTags.includes(tagName)) {
        console.log(`[OverlayManager] Refusing to remove protected tag: ${tagName}`);
        return false;
      }

      // Check if element is too large (might be main content)
      const rect = htmlEl.getBoundingClientRect();
      const viewportArea = window.innerWidth * window.innerHeight;
      const elementArea = rect.width * rect.height;
      
      if (elementArea > viewportArea * 0.9) {
        // Element covers almost entire viewport - be extra cautious
        const hasImportantContent = htmlEl.querySelector('main, article, nav, form') !== null;
        if (hasImportantContent) {
          console.log(`[OverlayManager] Large element contains important content, preserving`);
          return false;
        }
      }

      // Store reference for potential restoration
      const restoreData = {
        parent: htmlEl.parentElement,
        nextSibling: htmlEl.nextSibling,
        outerHTML: htmlEl.outerHTML
      };

      // Remove the element
      try {
        htmlEl.remove();
        console.log(`[OverlayManager] Removed element: ${tagName}`);
        return true;
      } catch (e) {
        console.error(`[OverlayManager] Failed to remove element:`, e);
        return false;
      }
    });
  }

  /**
   * Continuously monitor and remove popups
   * 
   * Useful for pages with persistent trap popups
   */
  async startPopupMonitor(options: {
    intervalMs?: number;
    maxDurationMs?: number;
    onPopupDetected?: (detection: OverlayDetectionResult) => void;
  } = {}): Promise<() => void> {
    const { intervalMs = 2000, maxDurationMs = 60000, onPopupDetected } = options;
    
    let isRunning = true;
    const startTime = Date.now();

    const monitor = async () => {
      while (isRunning) {
        if (Date.now() - startTime > maxDurationMs) {
          console.log(`[OverlayManager] Monitor timeout reached`);
          break;
        }

        try {
          const overlays = await this.findOverlays();
          
          for (const overlay of overlays) {
            const detection = await this.detectOverlay(overlay);
            
            if (detection.isOverlay && detection.confidence >= 60) {
              console.log(`[OverlayManager] Popup detected (confidence: ${detection.confidence})`);
              
              if (onPopupDetected) {
                onPopupDetected(detection);
              }

              // Try to dismiss
              await this.clickCloseButton(overlay);
            }
          }
        } catch (e) {
          // Ignore errors during monitoring
        }

        await this.page.waitForTimeout(intervalMs);
      }
    };

    // Start monitoring in background
    monitor();

    // Return stop function
    return () => {
      isRunning = false;
    };
  }

  /**
   * Dismiss popup using multiple strategies
   * 
   * 1. Click close button
   * 2. Click outside modal
   * 3. Press Escape key
   * 4. Remove via DOM manipulation
   */
  async dismissPopup(popup: ElementHandle | null = null): Promise<boolean> {
    // Strategy 1: Click close button
    if (popup) {
      const clicked = await this.clickCloseButton(popup);
      if (clicked) return true;
    }

    // Strategy 2: Click outside (on backdrop)
    try {
      await this.page.mouse.click(10, 10);
      await this.page.waitForTimeout(200);
    } catch (e) {
      // Ignore
    }

    // Strategy 3: Press Escape
    try {
      await this.page.keyboard.press('Escape');
      await this.page.waitForTimeout(200);
      
      // Check if popup is still visible
      if (popup) {
        const stillVisible = await popup.isVisible().catch(() => false);
        if (!stillVisible) return true;
      }
    } catch (e) {
      // Ignore
    }

    // Strategy 4: DOM removal
    if (popup) {
      return await this.safeRemoveElement(popup);
    }

    return false;
  }

  /**
   * Handle cookie consent banners specifically
   */
  async handleCookieConsent(options: {
    accept?: boolean;
    reject?: boolean;
    customSelectors?: string[];
  } = {}): Promise<boolean> {
    const { accept = false, reject = true, customSelectors = [] } = options;

    const cookieSelectors = [
      '[class*="cookie"]',
      '[id*="cookie"]',
      '[class*="consent"]',
      '[class*="gdpr"]',
      '[class*="privacy-banner"]',
      '[class*="cookie-banner"]',
      ...customSelectors
    ];

    for (const selector of cookieSelectors) {
      try {
        const banner = this.page.locator(selector).first();
        const isVisible = await banner.isVisible().catch(() => false);
        
        if (!isVisible) continue;

        if (reject) {
          // Try to find reject/decline button
          const rejectButton = banner.locator(
            'button:has-text("Reject"), button:has-text("Decline"), ' +
            'button:has-text("No"), button:has-text("Only necessary"), ' +
            'button:has-text("Essential only"), [class*="reject"], [class*="decline"]'
          ).first();
          
          const rejectVisible = await rejectButton.isVisible().catch(() => false);
          if (rejectVisible) {
            await rejectButton.click();
            console.log(`[OverlayManager] Clicked cookie reject button`);
            return true;
          }
        }

        if (accept) {
          // Try to find accept button
          const acceptButton = banner.locator(
            'button:has-text("Accept"), button:has-text("Agree"), ' +
            'button:has-text("OK"), button:has-text("Yes"), [class*="accept"]'
          ).first();
          
          const acceptVisible = await acceptButton.isVisible().catch(() => false);
          if (acceptVisible) {
            await acceptButton.click();
            console.log(`[OverlayManager] Clicked cookie accept button`);
            return true;
          }
        }

        // If no button found, try to remove the banner
        const handle = await banner.elementHandle();
        if (handle) {
          await this.safeRemoveElement(handle);
          console.log(`[OverlayManager] Removed cookie banner`);
          return true;
        }

      } catch (e) {
        // Continue to next selector
      }
    }

    return false;
  }
}

// ============================================================================
// INTEGRATED PAGE MANAGER
// ============================================================================

export interface ElementInfo {
  tagName: string;
  selector: string;
  text: string;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  isVisible: boolean;
}

export class PageManager {
  public scrollManager: ScrollManager;
  public overlayManager: OverlayManager;

  constructor(private page: Page) {
    this.scrollManager = new ScrollManager(page);
    this.overlayManager = new OverlayManager(page);
  }

  /**
   * Complete page preparation workflow
   * 
   * 1. Handle cookie consent
   * 2. Remove overlays
   * 3. Scroll to discover content
   * 4. Return interactive elements
   */
  async preparePage(options: {
    handleCookies?: boolean;
    removeOverlays?: boolean;
    scrollToDiscover?: boolean;
  } = {}): Promise<{
    cookiesHandled: boolean;
    overlaysRemoved: number;
    elements: ElementInfo[];
  }> {
    const { 
      handleCookies = true, 
      removeOverlays = true, 
      scrollToDiscover = false 
    } = options;

    let cookiesHandled = false;
    let overlaysRemoved = 0;

    // Handle cookies first
    if (handleCookies) {
      cookiesHandled = await this.overlayManager.handleCookieConsent({ reject: true });
    }

    // Remove overlays
    if (removeOverlays) {
      const result = await this.overlayManager.removeOverlays();
      overlaysRemoved = result.removed + result.clicked;
    }

    // Get initial elements
    let elements = await this.scrollManager.getInteractiveElements();

    // Scroll to discover more content if requested
    if (scrollToDiscover) {
      await this.scrollManager.progressiveScroll({ maxScrolls: 10 });
      elements = await this.scrollManager.getInteractiveElements();
    }

    return {
      cookiesHandled,
      overlaysRemoved,
      elements
    };
  }

  /**
   * Find and interact with element that may be below the fold
   */
  async findAndClick(
    selector: string, 
    options: ScrollOptions = {}
  ): Promise<boolean> {
    // First try without scrolling
    const element = this.page.locator(selector).first();
    const initiallyVisible = await element.isVisible().catch(() => false);
    
    if (initiallyVisible) {
      await element.click();
      return true;
    }

    // Scroll to find the element
    const result = await this.scrollManager.progressiveScroll({
      ...options,
      targetSelector: selector
    });

    if (result.found && result.element) {
      await result.element.click();
      return true;
    }

    return false;
  }

  /**
   * Safe interaction with element that might be covered by overlay
   */
  async safeClick(selector: string, maxAttempts: number = 3): Promise<boolean> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Try to remove any overlays first
        await this.overlayManager.removeOverlays();
        
        // Try to click
        const element = this.page.locator(selector).first();
        await element.click({ timeout: 5000 });
        return true;
      } catch (e) {
        console.log(`[PageManager] Click attempt ${attempt + 1} failed`);
        
        if (attempt < maxAttempts - 1) {
          // Wait and retry
          await this.page.waitForTimeout(500);
        }
      }
    }
    
    return false;
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Create a MutationObserver to detect DOM changes while scrolling
 */
export function createScrollMutationObserver(
  callback: (mutations: MutationRecord[]) => void,
  options: MutationObserverInit = {}
): MutationObserver {
  const defaultOptions: MutationObserverInit = {
    childList: true,
    subtree: true,
    attributes: false,
    characterData: false,
    ...options
  };

  return new MutationObserver((mutations) => {
    callback(mutations);
  });
}

/**
 * Detect if page uses infinite scroll pattern
 */
export async function detectInfiniteScroll(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    // Check for common infinite scroll indicators
    const indicators = [
      // Check for scroll event listeners
      () => {
        const listeners = (window as any).jQuery?._data?.(window, 'events')?.scroll;
        return listeners && listeners.length > 0;
      },
      // Check for IntersectionObserver usage
      () => {
        return typeof IntersectionObserver !== 'undefined' && 
               document.querySelectorAll('[data-infinite-scroll], [infinite-scroll]').length > 0;
      },
      // Check for common infinite scroll class names
      () => {
        const selectors = [
          '[class*="infinite"]',
          '[class*="load-more"]',
          '[class*="scroll-load"]'
        ];
        return selectors.some(s => document.querySelector(s) !== null);
      }
    ];

    return indicators.some(fn => {
      try {
        return fn();
      } catch (e) {
        return false;
      }
    });
  });
}

/**
 * Calculate optimal scroll wait time based on network conditions
 */
export async function calculateOptimalWaitTime(
  page: Page, 
  samples: number = 3
): Promise<number> {
  const times: number[] = [];

  for (let i = 0; i < samples; i++) {
    const startTime = Date.now();
    
    await page.evaluate(() => {
      return new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => resolve();
        img.onerror = () => resolve();
        img.src = '/favicon.ico?' + Date.now();
      });
    });
    
    times.push(Date.now() - startTime);
  }

  const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
  return Math.max(500, Math.min(3000, avgTime * 2));
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  ScrollManager,
  OverlayManager,
  PageManager,
  createScrollMutationObserver,
  detectInfiniteScroll,
  calculateOptimalWaitTime
};
