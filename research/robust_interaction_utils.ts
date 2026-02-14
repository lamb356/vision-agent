/**
 * Robust Element Interaction Utilities for Playwright
 * 
 * This module provides comprehensive fallback strategies for interacting with
 * elements that are blocked by overlays, not in viewport, or otherwise not
 * directly clickable.
 */

import { Page, Locator } from '@playwright/test';

export interface RobustClickOptions {
  /** Maximum number of retry attempts */
  maxRetries?: number;
  /** Delay between retry attempts in ms */
  retryDelay?: number;
  /** Whether to scroll element into view before clicking */
  scrollIntoView?: boolean;
  /** Whether to attempt overlay removal */
  removeOverlays?: boolean;
  /** Timeout for individual click attempts */
  timeout?: number;
  /** Custom overlay selectors to remove */
  overlaySelectors?: string[];
}

export interface ElementInfo {
  tagName: string;
  id: string;
  className: string;
  textContent: string | null;
  zIndex: string;
  pointerEvents: string;
  isVisible: boolean;
}

const DEFAULT_OVERLAY_SELECTORS = [
  '.overlay',
  '.modal',
  '.modal-backdrop',
  '.popup',
  '[role="dialog"]',
  '.cookie-banner',
  '.cookie-consent',
  '#cookie-banner',
  '.newsletter-popup',
  '.signup-modal',
  '.interstitial',
  '.loading-overlay',
  '.spinner-overlay'
];

/**
 * Check if an element is clickable (not covered by another element)
 */
export async function isElementClickable(
  page: Page,
  locator: Locator
): Promise<boolean> {
  const element = await locator.elementHandle();
  if (!element) return false;

  return await page.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const elementAtPoint = document.elementFromPoint(x, y);
    return el === elementAtPoint || el.contains(elementAtPoint);
  }, element);
}

/**
 * Advanced overlap detection checking multiple points on the element
 */
export async function isElementNotOverlapped(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const originalPointerEvents = el.style.pointerEvents;
    el.style.pointerEvents = 'all';

    const rect = el.getBoundingClientRect();

    const getStyleValueAsNumber = (styleProperty: string) => {
      return Number(
        window
          .getComputedStyle(el, null)
          .getPropertyValue(styleProperty)
          .replace('px', '')
      );
    };

    const paddingLeft = getStyleValueAsNumber('padding-left');
    const paddingRight = getStyleValueAsNumber('padding-right');
    const paddingTop = getStyleValueAsNumber('padding-top');
    const paddingBottom = getStyleValueAsNumber('padding-bottom');

    const borderRadiusTopLeft = getStyleValueAsNumber('border-top-left-radius');
    const borderRadiusTopRight = getStyleValueAsNumber('border-top-right-radius');
    const borderRadiusBottomLeft = getStyleValueAsNumber('border-bottom-left-radius');
    const borderRadiusBottomRight = getStyleValueAsNumber('border-bottom-right-radius');

    const isPointVisible = (x: number, y: number) => {
      const elementAtPoint = document.elementFromPoint(x, y);
      return el.contains(elementAtPoint) || elementAtPoint === el;
    };

    const pointsToCheckOffset = 2;
    const leftEdgeToCheck = rect.left + paddingLeft + pointsToCheckOffset;
    const topEdgeToCheck = rect.top + paddingTop + pointsToCheckOffset;
    const rightEdgeToCheck = rect.right - paddingRight - pointsToCheckOffset;
    const bottomEdgeToCheck = rect.bottom - paddingBottom - pointsToCheckOffset;

    const pointsToCheck = [
      {
        x: leftEdgeToCheck + borderRadiusTopLeft / 3,
        y: topEdgeToCheck + borderRadiusTopLeft / 3,
      },
      {
        x: rightEdgeToCheck - borderRadiusTopRight / 3,
        y: topEdgeToCheck + borderRadiusTopRight / 3,
      },
      {
        x: leftEdgeToCheck + borderRadiusBottomLeft / 3,
        y: bottomEdgeToCheck - borderRadiusBottomLeft / 3,
      },
      {
        x: rightEdgeToCheck - borderRadiusBottomRight / 3,
        y: bottomEdgeToCheck - borderRadiusBottomRight / 3,
      },
      { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    ];

    const result = pointsToCheck.every((point) => isPointVisible(point.x, point.y));

    el.style.pointerEvents = originalPointerEvents;
    return result;
  });
}

/**
 * Get information about the topmost element at a specific position
 */
export async function getTopmostElementAtPosition(
  page: Page,
  x: number,
  y: number
): Promise<ElementInfo | null> {
  return page.evaluate((coordX, coordY) => {
    const element = document.elementFromPoint(coordX, coordY);
    if (!element) return null;

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return {
      tagName: element.tagName,
      id: element.id,
      className: element.className,
      textContent: element.textContent?.substring(0, 50) || null,
      zIndex: style.zIndex,
      pointerEvents: style.pointerEvents,
      isVisible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden',
    };
  }, x, y);
}

/**
 * Remove overlays from the page
 */
export async function removeOverlays(
  page: Page,
  selectors?: string[]
): Promise<void> {
  const overlaySelectors = selectors || DEFAULT_OVERLAY_SELECTORS;

  await page.evaluate((selectors) => {
    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => {
        // Try to click close button first
        const closeButton = el.querySelector(
          'button:has-text("Close"), .close, [aria-label="Close"], .dismiss, .btn-close'
        );
        if (closeButton) {
          (closeButton as HTMLElement).click();
        } else {
          el.remove();
        }
      });
    });
  }, overlaySelectors);
}

/**
 * Hide overlays instead of removing them (can be restored later)
 */
export async function hideOverlays(
  page: Page,
  selectors?: string[]
): Promise<string> {
  const overlaySelectors = selectors || DEFAULT_OVERLAY_SELECTORS;

  return page.evaluate((selectors) => {
    const hiddenElements: Element[] = [];

    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => {
        const htmlEl = el as HTMLElement;
        if (htmlEl.style.display !== 'none') {
          htmlEl.dataset.originalDisplay = htmlEl.style.display;
          htmlEl.style.display = 'none';
          hiddenElements.push(el);
        }
      });
    });

    return `Hidden ${hiddenElements.length} overlay elements`;
  }, overlaySelectors);
}

/**
 * Restore previously hidden overlays
 */
export async function restoreOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('[data-original-display]').forEach((el) => {
      const htmlEl = el as HTMLElement;
      htmlEl.style.display = htmlEl.dataset.originalDisplay || '';
      delete htmlEl.dataset.originalDisplay;
    });
  });
}

/**
 * Dispatch a complete mouse event sequence (mousedown, mouseup, click)
 */
export async function dispatchCompleteClick(
  page: Page,
  selector: string
): Promise<void> {
  await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) throw new Error(`Element not found: ${sel}`);

    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const eventInit: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: centerX,
      clientY: centerY,
      screenX: centerX,
      screenY: centerY,
      button: 0,
      buttons: 1,
      detail: 1,
      view: window,
    };

    const mousedownEvent = new MouseEvent('mousedown', eventInit);
    const mouseupEvent = new MouseEvent('mouseup', {
      ...eventInit,
      buttons: 0,
    });
    const clickEvent = new MouseEvent('click', {
      ...eventInit,
      buttons: 0,
    });

    element.dispatchEvent(mousedownEvent);
    element.dispatchEvent(mouseupEvent);
    element.dispatchEvent(clickEvent);
  }, selector);
}

/**
 * Click at specific coordinates
 */
export async function clickAtCoordinates(
  page: Page,
  x: number,
  y: number,
  options: { delay?: number } = {}
): Promise<void> {
  const { delay = 0 } = options;

  await page.mouse.move(x, y);
  await page.mouse.down();
  if (delay > 0) {
    await page.waitForTimeout(delay);
  }
  await page.mouse.up();
}

/**
 * Click on element using coordinates from bounding box
 */
export async function clickElementByCoordinates(
  page: Page,
  locator: Locator,
  options: { delay?: number; offset?: { x: number; y: number } } = {}
): Promise<void> {
  const { delay = 0, offset = { x: 0.5, y: 0.5 } } = options;

  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('Could not get element bounding box');
  }

  const x = box.x + box.width * offset.x;
  const y = box.y + box.height * offset.y;

  await clickAtCoordinates(page, x, y, { delay });
}

/**
 * Main robust click function with fallback chain
 */
export async function robustClick(
  page: Page,
  locator: Locator,
  options: RobustClickOptions = {}
): Promise<boolean> {
  const {
    maxRetries = 3,
    retryDelay = 500,
    scrollIntoView = true,
    removeOverlays: shouldRemoveOverlays = false,
    timeout = 5000,
    overlaySelectors,
  } = options;

  // Get selector from locator for JS evaluation
  const selector = await locator.toString().replace('Locator@', '');

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Click attempt ${attempt}/${maxRetries}`);

      // Attempt 1: Standard click
      if (attempt === 1) {
        await locator.click({ timeout });
        return true;
      }

      // Attempt 2: Scroll into view then click
      if (scrollIntoView) {
        await locator.scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
      }

      // Attempt 3: Force click
      try {
        await locator.click({ force: true, timeout: timeout / 2 });
        return true;
      } catch (e) {
        console.log('Force click failed, trying next method');
      }

      // Attempt 4: Remove overlays if enabled
      if (shouldRemoveOverlays) {
        await removeOverlays(page, overlaySelectors);
        await page.waitForTimeout(200);

        try {
          await locator.click({ timeout: timeout / 2 });
          return true;
        } catch (e) {
          console.log('Click after overlay removal failed');
        }
      }

      // Attempt 5: Dispatch event
      try {
        await locator.dispatchEvent('click');
        return true;
      } catch (e) {
        console.log('Dispatch event failed, trying next method');
      }

      // Attempt 6: JavaScript click
      try {
        await locator.evaluate((el) => (el as HTMLElement).click());
        return true;
      } catch (e) {
        console.log('JavaScript click failed, trying next method');
      }

      // Attempt 7: Coordinate-based click
      try {
        await clickElementByCoordinates(page, locator, { delay: 100 });
        return true;
      } catch (e) {
        console.log('Coordinate click failed, trying next method');
      }

      // Attempt 8: Complete event sequence with focus
      try {
        await locator.focus();
        await page.waitForTimeout(100);
        await dispatchCompleteClick(page, selector);
        return true;
      } catch (e) {
        console.log('Complete event sequence failed');
      }

      // Wait before retry
      if (attempt < maxRetries) {
        await page.waitForTimeout(retryDelay);
      }
    } catch (error) {
      console.error(`Attempt ${attempt} failed:`, error);
      if (attempt === maxRetries) throw error;
      await page.waitForTimeout(retryDelay);
    }
  }

  return false;
}

/**
 * Robust form submission with multiple fallback methods
 */
export async function robustFormSubmit(
  page: Page,
  submitButtonLocator: Locator,
  formSelector?: string
): Promise<boolean> {
  // Method 1: Standard button click
  try {
    await submitButtonLocator.click({ timeout: 5000 });
    return true;
  } catch (e) {
    console.log('Standard click failed');
  }

  // Method 2: Force click
  try {
    await submitButtonLocator.click({ force: true, timeout: 3000 });
    return true;
  } catch (e) {
    console.log('Force click failed');
  }

  // Method 3: Focus and Enter key
  try {
    await submitButtonLocator.focus();
    await page.keyboard.press('Enter');
    return true;
  } catch (e) {
    console.log('Enter key failed');
  }

  // Method 4: Dispatch click event
  try {
    await submitButtonLocator.dispatchEvent('click');
    return true;
  } catch (e) {
    console.log('Dispatch event failed');
  }

  // Method 5: JavaScript click
  try {
    await submitButtonLocator.evaluate((el) => (el as HTMLElement).click());
    return true;
  } catch (e) {
    console.log('JavaScript click failed');
  }

  // Method 6: Form submit directly
  try {
    const formSel = formSelector || 'form';
    await page.evaluate((sel) => {
      const form = document.querySelector(sel);
      if (form) {
        (form as HTMLFormElement).submit();
      }
    }, formSel);
    return true;
  } catch (e) {
    console.log('Form submit failed');
  }

  // Method 7: Complete mouse sequence at button coordinates
  try {
    await clickElementByCoordinates(page, submitButtonLocator, { delay: 100 });
    return true;
  } catch (e) {
    console.log('Mouse sequence failed');
  }

  return false;
}

/**
 * Setup automatic overlay handler for the page
 */
export async function setupOverlayHandler(
  page: Page,
  overlayLocator: Locator,
  handler: (overlay: Locator) => Promise<void>,
  options: { times?: number; noWaitAfter?: boolean } = {}
): Promise<void> {
  await page.addLocatorHandler(overlayLocator, handler, options);
}

/**
 * Wait for element to be clickable (not overlapped)
 */
export async function waitForElementClickable(
  page: Page,
  locator: Locator,
  options: { timeout?: number; pollInterval?: number } = {}
): Promise<void> {
  const { timeout = 10000, pollInterval = 100 } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await isElementClickable(page, locator)) {
      return;
    }
    await page.waitForTimeout(pollInterval);
  }

  throw new Error('Timeout waiting for element to be clickable');
}

/**
 * Scroll element into view with custom options
 */
export async function scrollElementIntoView(
  page: Page,
  locator: Locator,
  options: { behavior?: 'auto' | 'smooth' | 'instant'; block?: 'start' | 'center' | 'end' | 'nearest' } = {}
): Promise<void> {
  const { behavior = 'instant', block = 'center' } = options;

  await locator.evaluate(
    (el, opts) => {
      el.scrollIntoView({
        behavior: opts.behavior as ScrollBehavior,
        block: opts.block as ScrollLogicalPosition,
      });
    },
    { behavior, block }
  );
}

/**
 * Check if element is in viewport
 */
export async function isElementInViewport(page: Page, locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return (
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= window.innerHeight &&
      rect.right <= window.innerWidth
    );
  });
}

/**
 * Get element information for debugging
 */
export async function getElementInfo(
  page: Page,
  locator: Locator
): Promise<{
  selector: string;
  isVisible: boolean;
  isEnabled: boolean;
  isClickable: boolean;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  zIndex: string;
}> {
  const selector = locator.toString();
  const isVisible = await locator.isVisible().catch(() => false);
  const isEnabled = await locator.isEnabled().catch(() => false);
  const isClickable = await isElementClickable(page, locator);
  const boundingBox = await locator.boundingBox();
  const zIndex = await locator
    .evaluate((el) => window.getComputedStyle(el).zIndex)
    .catch(() => 'auto');

  return {
    selector,
    isVisible,
    isEnabled,
    isClickable,
    boundingBox,
    zIndex,
  };
}

/**
 * Debug element interaction issues
 */
export async function debugElementInteraction(
  page: Page,
  locator: Locator
): Promise<void> {
  const info = await getElementInfo(page, locator);
  console.log('Element Info:', info);

  if (info.boundingBox) {
    const centerX = info.boundingBox.x + info.boundingBox.width / 2;
    const centerY = info.boundingBox.y + info.boundingBox.height / 2;

    const topElement = await getTopmostElementAtPosition(page, centerX, centerY);
    console.log('Topmost element at center:', topElement);
  }

  // Check for overlays
  const overlayCount = await page.evaluate((selectors) => {
    return selectors.reduce((count, selector) => {
      return count + document.querySelectorAll(selector).length;
    }, 0);
  }, DEFAULT_OVERLAY_SELECTORS);

  console.log(`Found ${overlayCount} potential overlay elements`);
}

export default {
  isElementClickable,
  isElementNotOverlapped,
  getTopmostElementAtPosition,
  removeOverlays,
  hideOverlays,
  restoreOverlays,
  dispatchCompleteClick,
  clickAtCoordinates,
  clickElementByCoordinates,
  robustClick,
  robustFormSubmit,
  setupOverlayHandler,
  waitForElementClickable,
  scrollElementIntoView,
  isElementInViewport,
  getElementInfo,
  debugElementInteraction,
};
