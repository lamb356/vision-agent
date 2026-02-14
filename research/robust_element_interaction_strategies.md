# Robust Element Interaction Strategies for Browser Automation

## Research Summary: Solving Problem 3 - Submit Button Blocked by Overlays

This document provides comprehensive strategies for handling element interactions when the target element is covered by overlays, not the topmost element, or otherwise blocked.

---

## Table of Contents

1. [Understanding the Problem](#understanding-the-problem)
2. [Playwright-Specific Solutions](#playwright-specific-solutions)
3. [Detection Methods for Covered Elements](#detection-methods)
4. [JavaScript Event Dispatch Techniques](#javascript-event-dispatch)
5. [Form Submission Alternatives](#form-submission-alternatives)
6. [Overlay Handling Strategies](#overlay-handling-strategies)
7. [Comprehensive Fallback Chain](#comprehensive-fallback-chain)
8. [Production Agent Techniques](#production-agent-techniques)
9. [Implementation Recommendations](#implementation-recommendations)

---

## Understanding the Problem

When Playwright's standard click fails due to overlays:
- The element exists in the DOM
- The element may be visible but covered by another element
- The click event is intercepted by an overlay element
- Standard `force: true` may not work in all cases
- JavaScript `dispatchEvent` may not trigger the expected behavior

---

## Playwright-Specific Solutions

### 1. Force Click Option

```typescript
// Basic force click - bypasses actionability checks
await page.locator('#submit-button').click({ force: true });

// Force click with additional options
await page.locator('#submit-button').click({
  force: true,
  timeout: 10000,
  noWaitAfter: true  // Don't wait for navigation
});
```

**When to use:**
- Element is covered by overlay but still clickable
- Element is technically visible but Playwright thinks it's not
- Element is slightly off-screen

**Limitations:**
- Still may fail if element is completely obscured
- Does not bypass all checks (element must still be attached to DOM)

### 2. Dispatch Event (Programmatic Click)

```typescript
// Simple dispatch event - fires click event directly
await page.locator('#submit-button').dispatchEvent('click');

// Dispatch with additional event properties
await page.locator('#submit-button').dispatchEvent('click', {
  bubbles: true,
  cancelable: true,
  composed: true
});
```

**When to use:**
- Force click fails
- Element is hidden or has zero size
- Element is behind another element
- You need to bypass all actionability checks

**Limitations:**
- Does not simulate real user interaction
- May not trigger all event handlers that expect mouse events
- Some applications check for isTrusted event property

### 3. page.evaluate() JavaScript Click

```typescript
// Direct element click via JavaScript
await page.evaluate(() => {
  const button = document.querySelector('#submit-button');
  if (button) {
    button.click();
  }
});

// Click with element handle
const button = await page.locator('#submit-button').elementHandle();
await page.evaluate((el) => el.click(), button);

// Using locator.evaluate (recommended)
await page.locator('#submit-button').evaluate((el) => el.click());
```

**When to use:**
- All other methods fail
- Element is deeply nested or in shadow DOM
- Need to execute custom JavaScript logic

### 4. Mouse API - Coordinate-Based Click

```typescript
// Get element position and click at coordinates
const box = await page.locator('#submit-button').boundingBox();
if (box) {
  await page.mouse.click(
    box.x + box.width / 2,
    box.y + box.height / 2
  );
}

// Complete manual mouse sequence
const box = await page.locator('#submit-button').boundingBox();
if (box) {
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.waitForTimeout(100); // Small delay
  await page.mouse.up();
}
```

**When to use:**
- Element is moving or animated
- Need to click at specific position within element
- Overlay detection is interfering

### 5. Position-Based Click

```typescript
// Click at specific offset within element
await page.locator('#submit-button').click({
  position: { x: 10, y: 5 },
  force: true
});

// Click at top-left corner
await page.locator('#submit-button').click({
  position: { x: 0, y: 0 }
});
```

---

## Detection Methods for Covered Elements

### 1. Check if Element is Clickable (elementFromPoint)

```typescript
async function isElementClickable(page: Page, locator: Locator): Promise<boolean> {
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

// Usage
const isClickable = await isElementClickable(page, page.locator('#submit-button'));
```

### 2. Advanced Overlap Detection (Multiple Points)

```typescript
async function isElementNotOverlapped(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    // Store original pointer-events
    const originalPointerEvents = el.style.pointerEvents;
    
    // Temporarily enable pointer events for detection
    el.style.pointerEvents = 'all';
    
    const rect = el.getBoundingClientRect();
    
    const getStyleValueAsNumber = (styleProperty: string) => {
      return Number(window.getComputedStyle(el, null)
        .getPropertyValue(styleProperty)
        .replace('px', ''));
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
      // Top-left corner
      {x: leftEdgeToCheck + (borderRadiusTopLeft / 3), y: topEdgeToCheck + (borderRadiusTopLeft / 3)},
      // Top-right corner
      {x: rightEdgeToCheck - (borderRadiusTopRight / 3), y: topEdgeToCheck + (borderRadiusTopRight / 3)},
      // Bottom-left corner
      {x: leftEdgeToCheck + (borderRadiusBottomLeft / 3), y: bottomEdgeToCheck - (borderRadiusBottomLeft / 3)},
      // Bottom-right corner
      {x: rightEdgeToCheck - (borderRadiusBottomRight / 3), y: bottomEdgeToCheck - (borderRadiusBottomRight / 3)},
      // Center
      {x: rect.left + (rect.width / 2), y: rect.top + (rect.height / 2)}
    ];
    
    const result = pointsToCheck.every((point) => isPointVisible(point.x, point.y));
    
    // Restore original pointer-events
    el.style.pointerEvents = originalPointerEvents;
    
    return result;
  });
}
```

### 3. Find Topmost Element at Position

```typescript
async function getTopmostElementAtPosition(page: Page, x: number, y: number): Promise<string | null> {
  return page.evaluate((coordX, coordY) => {
    const element = document.elementFromPoint(coordX, coordY);
    if (!element) return null;
    
    return {
      tagName: element.tagName,
      id: element.id,
      className: element.className,
      textContent: element.textContent?.substring(0, 50),
      zIndex: window.getComputedStyle(element).zIndex,
      pointerEvents: window.getComputedStyle(element).pointerEvents
    };
  }, x, y);
}

// Usage with element center
const box = await page.locator('#submit-button').boundingBox();
if (box) {
  const topElement = await getTopmostElementAtPosition(
    page,
    box.x + box.width / 2,
    box.y + box.height / 2
  );
  console.log('Topmost element:', topElement);
}
```

---

## JavaScript Event Dispatch Techniques

### 1. Complete Mouse Event Sequence

```typescript
// Dispatch complete mouse event sequence
async function dispatchCompleteClick(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) return;
    
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    // Create mouse events with proper coordinates
    const mousedownEvent = new MouseEvent('mousedown', {
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
      view: window
    });
    
    const mouseupEvent = new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: centerX,
      clientY: centerY,
      screenX: centerX,
      screenY: centerY,
      button: 0,
      buttons: 0,
      detail: 1,
      view: window
    });
    
    const clickEvent = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: centerX,
      clientY: centerY,
      screenX: centerX,
      screenY: centerY,
      button: 0,
      buttons: 0,
      detail: 1,
      view: window
    });
    
    // Dispatch events in sequence
    element.dispatchEvent(mousedownEvent);
    element.dispatchEvent(mouseupEvent);
    element.dispatchEvent(clickEvent);
  }, selector);
}
```

### 2. Focus Management

```typescript
// Focus element before interaction
await page.locator('#submit-button').focus();

// Focus with JavaScript
await page.evaluate(() => {
  const element = document.querySelector('#submit-button');
  if (element) {
    element.focus();
    element.scrollIntoView({ block: 'center', behavior: 'instant' });
  }
});

// Check if element is focused
const isFocused = await page.evaluate(() => {
  return document.activeElement === document.querySelector('#submit-button');
});
```

### 3. Pointer Events Manipulation

```typescript
// Temporarily disable pointer events on overlay
await page.evaluate((overlaySelector) => {
  const overlay = document.querySelector(overlaySelector);
  if (overlay) {
    overlay.style.pointerEvents = 'none';
  }
}, '.overlay-class');

// Click the target
await page.locator('#submit-button').click();

// Restore pointer events
await page.evaluate((overlaySelector) => {
  const overlay = document.querySelector(overlaySelector);
  if (overlay) {
    overlay.style.pointerEvents = '';
  }
}, '.overlay-class');
```

---

## Form Submission Alternatives

### 1. Form Submit Method

```typescript
// Submit form directly
await page.evaluate(() => {
  const form = document.querySelector('form');
  if (form) {
    form.submit();
  }
});

// Submit by form ID
await page.evaluate(() => {
  const form = document.getElementById('my-form');
  if (form) {
    form.submit();
  }
});

// Using $eval
await page.$eval('form', (form) => form.submit());
```

### 2. Keyboard Events (Enter Key)

```typescript
// Press Enter on focused element
await page.locator('#submit-button').press('Enter');

// Focus and press Enter
await page.locator('#submit-button').focus();
await page.keyboard.press('Enter');

// Press Enter with delay
await page.locator('input[type="text"]').press('Enter', { delay: 100 });

// Press Space (for buttons)
await page.locator('#submit-button').press('Space');
```

### 3. Request Interception (Direct Form POST)

```typescript
// Intercept and submit form data directly
const formData = await page.evaluate(() => {
  const form = document.querySelector('form');
  const data = new FormData(form);
  return Object.fromEntries(data.entries());
});

// Submit via fetch API
await page.evaluate((data) => {
  fetch('/submit-endpoint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}, formData);
```

---

## Overlay Handling Strategies

### 1. Wait for Overlay to Disappear

```typescript
// Wait for overlay to be hidden
await page.locator('.overlay').waitFor({ state: 'hidden', timeout: 10000 });

// Wait for overlay to be detached
await expect(page.locator('.overlay')).toHaveCount(0);

// Wait for overlay to have display:none
await page.waitForFunction(() => {
  const overlay = document.querySelector('.overlay');
  return !overlay || overlay.style.display === 'none';
});
```

### 2. Remove Overlay via JavaScript

```typescript
// Remove overlay completely
await page.evaluate(() => {
  const overlays = document.querySelectorAll('.overlay, .modal, .popup');
  overlays.forEach(overlay => overlay.remove());
});

// Hide overlay
await page.evaluate(() => {
  const overlay = document.querySelector('.overlay');
  if (overlay) {
    overlay.style.display = 'none';
    overlay.style.visibility = 'hidden';
    overlay.style.opacity = '0';
  }
});

// Remove specific overlay by selector
await page.evaluate((selector) => {
  const element = document.querySelector(selector);
  if (element) {
    element.parentNode.removeChild(element);
  }
}, '.blocking-overlay');
```

### 3. Add Locator Handler (Playwright 1.42+)

```typescript
// Setup handler for cookie consent or modal
await page.addLocatorHandler(
  page.getByRole('button', { name: 'Accept all cookies' }),
  async () => {
    await page.getByRole('button', { name: 'Reject all cookies' }).click();
  }
);

// Handler with limited invocations
await page.addLocatorHandler(
  page.locator('.modal-overlay'),
  async (overlay) => {
    await overlay.locator('.close-button').click();
  },
  { times: 3 }
);

// Handler that doesn't wait for overlay to disappear
await page.addLocatorHandler(
  page.locator('.notification'),
  async () => {
    await page.evaluate(() => {
      document.querySelector('.notification')?.remove();
    });
  },
  { noWaitAfter: true }
);

// Remove handler when done
await page.removeLocatorHandler(overlayLocator);
```

### 4. MutationObserver for Dynamic Overlays

```typescript
// Setup MutationObserver to remove overlays as they appear
await page.addInitScript(() => {
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1) { // Element node
          const element = node as Element;
          if (element.matches?.('.overlay, .modal, [role="dialog"]')) {
            element.remove();
          }
        }
      });
    });
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
});
```

---

## Comprehensive Fallback Chain

### Ultimate Element Interaction Fallback Chain

```typescript
async function robustClick(
  page: Page,
  locator: Locator,
  options: {
    maxRetries?: number;
    retryDelay?: number;
    scrollIntoView?: boolean;
    removeOverlays?: boolean;
  } = {}
): Promise<boolean> {
  const {
    maxRetries = 3,
    retryDelay = 500,
    scrollIntoView = true,
    removeOverlays = false
  } = options;
  
  // Get selector string from locator for JS evaluation
  const selector = await getSelectorFromLocator(locator);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Click attempt ${attempt}/${maxRetries}`);
      
      // Step 1: Standard click (most reliable for normal cases)
      if (attempt === 1) {
        await locator.click({ timeout: 5000 });
        return true;
      }
      
      // Step 2: Scroll into view first
      if (scrollIntoView) {
        await locator.scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
      }
      
      // Step 3: Force click (bypass actionability checks)
      try {
        await locator.click({ force: true, timeout: 3000 });
        return true;
      } catch (e) {
        console.log('Force click failed, trying next method');
      }
      
      // Step 4: Remove overlays if enabled
      if (removeOverlays) {
        await page.evaluate(() => {
          document.querySelectorAll('.overlay, .modal-backdrop, [role="dialog"]')
            .forEach(el => el.remove());
        });
        await page.waitForTimeout(200);
      }
      
      // Step 5: Dispatch event (programmatic click)
      try {
        await locator.dispatchEvent('click');
        return true;
      } catch (e) {
        console.log('Dispatch event failed, trying next method');
      }
      
      // Step 6: JavaScript click via evaluate
      try {
        await locator.evaluate((el) => (el as HTMLElement).click());
        return true;
      } catch (e) {
        console.log('JavaScript click failed, trying next method');
      }
      
      // Step 7: Mouse click at coordinates
      try {
        const box = await locator.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          return true;
        }
      } catch (e) {
        console.log('Mouse click failed, trying next method');
      }
      
      // Step 8: Complete event sequence with focus
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

// Helper function to get selector from locator
async function getSelectorFromLocator(locator: Locator): Promise<string> {
  // This is a simplified version - in practice you might need to track the selector
  return locator.toString();
}
```

### Form Submission Fallback Chain

```typescript
async function robustFormSubmit(
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
    const box = await submitButtonLocator.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(100);
      await page.mouse.up();
      return true;
    }
  } catch (e) {
    console.log('Mouse sequence failed');
  }
  
  return false;
}
```

---

## Production Agent Techniques

### How SeeAct/WebVoyager Handle Blocked Elements

Based on research of production browser agents:

1. **Self-Healing Automation**
   - Detect when elements are blocked
   - Automatically try alternative selectors
   - Use AI to understand intent rather than brittle selectors

2. **Overlay Detection and Removal**
   - Monitor for common overlay patterns
   - Automatically dismiss cookie banners, modals, popups
   - Use MutationObserver for dynamic overlays

3. **Fallback Strategy Hierarchy**
   - Primary: Standard interaction
   - Secondary: Force/Programmatic interaction
   - Tertiary: JavaScript evaluation
   - Quaternary: Coordinate-based interaction

4. **Intelligent Retry Logic**
   - Exponential backoff
   - State verification between retries
   - Screenshot comparison for visual regression

### Recommended Agent Pattern

```typescript
class RobustElementInteractor {
  constructor(private page: Page) {}
  
  async interact(
    action: 'click' | 'fill' | 'select',
    locator: Locator,
    value?: string
  ): Promise<boolean> {
    // Pre-interaction: Check for overlays
    await this.handleOverlays();
    
    // Try interaction with fallback chain
    const success = await this.tryWithFallbacks(action, locator, value);
    
    // Post-interaction: Verify state change
    if (success) {
      await this.verifyStateChange(locator);
    }
    
    return success;
  }
  
  private async handleOverlays(): Promise<void> {
    const commonOverlays = [
      '[role="dialog"]',
      '.modal',
      '.overlay',
      '.cookie-banner',
      '.popup'
    ];
    
    for (const selector of commonOverlays) {
      const overlay = this.page.locator(selector).first();
      if (await overlay.isVisible().catch(() => false)) {
        // Try to close overlay
        const closeButton = overlay.locator('button:has-text("Close"), .close, [aria-label="Close"]').first();
        if (await closeButton.isVisible().catch(() => false)) {
          await closeButton.click().catch(() => {});
        } else {
          await overlay.evaluate(el => el.remove()).catch(() => {});
        }
      }
    }
  }
  
  private async tryWithFallbacks(
    action: string,
    locator: Locator,
    value?: string
  ): Promise<boolean> {
    const methods = [
      () => this.standardAction(action, locator, value),
      () => this.forceAction(action, locator, value),
      () => this.javascriptAction(action, locator, value),
      () => this.coordinateAction(action, locator, value)
    ];
    
    for (const method of methods) {
      try {
        if (await method()) return true;
      } catch (e) {
        continue;
      }
    }
    
    return false;
  }
  
  private async standardAction(action: string, locator: Locator, value?: string): Promise<boolean> {
    switch (action) {
      case 'click':
        await locator.click({ timeout: 5000 });
        return true;
      case 'fill':
        await locator.fill(value || '', { timeout: 5000 });
        return true;
      default:
        return false;
    }
  }
  
  private async forceAction(action: string, locator: Locator, value?: string): Promise<boolean> {
    switch (action) {
      case 'click':
        await locator.click({ force: true, timeout: 3000 });
        return true;
      case 'fill':
        await locator.fill(value || '', { force: true, timeout: 3000 });
        return true;
      default:
        return false;
    }
  }
  
  private async javascriptAction(action: string, locator: Locator, value?: string): Promise<boolean> {
    if (action === 'click') {
      await locator.evaluate((el) => (el as HTMLElement).click());
      return true;
    } else if (action === 'fill') {
      await locator.evaluate((el, val) => {
        (el as HTMLInputElement).value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
      return true;
    }
    return false;
  }
  
  private async coordinateAction(action: string, locator: Locator, value?: string): Promise<boolean> {
    const box = await locator.boundingBox();
    if (!box) return false;
    
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    
    if (action === 'click') {
      await this.page.mouse.click(x, y);
      return true;
    } else if (action === 'fill') {
      await this.page.mouse.click(x, y);
      await this.page.keyboard.type(value || '');
      return true;
    }
    
    return false;
  }
  
  private async verifyStateChange(locator: Locator): Promise<void> {
    // Implement state verification logic
    // e.g., check if element is still visible, if URL changed, etc.
  }
}
```

---

## Implementation Recommendations

### Ranked by Reliability (Most to Least)

| Rank | Method | Reliability | Use Case |
|------|--------|-------------|----------|
| 1 | Standard Click | High | Normal interactions |
| 2 | Force Click | High | Covered but clickable elements |
| 3 | Remove Overlay + Click | High | Known overlay patterns |
| 4 | Dispatch Event | Medium | Hidden/zero-size elements |
| 5 | JavaScript Click | Medium | Shadow DOM, complex nesting |
| 6 | Focus + Enter Key | Medium | Form submissions |
| 7 | Form Submit | Medium | When button is blocked |
| 8 | Coordinate Click | Low | Last resort |
| 9 | Complete Event Sequence | Low | Complex event dependencies |

### Specific Solution for Submit Button Problem

```typescript
async function clickSubmitButton(page: Page, buttonLocator: Locator): Promise<boolean> {
  // Step 1: Try standard click first
  try {
    await buttonLocator.click({ timeout: 5000 });
    return true;
  } catch (e) {
    console.log('Standard click failed, trying alternatives...');
  }
  
  // Step 2: Scroll into view and force click
  try {
    await buttonLocator.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await buttonLocator.click({ force: true, timeout: 3000 });
    return true;
  } catch (e) {
    console.log('Force click failed...');
  }
  
  // Step 3: Check and remove overlays
  const box = await buttonLocator.boundingBox();
  if (box) {
    const topElement = await page.evaluate((x, y) => {
      return document.elementFromPoint(x, y)?.className;
    }, box.x + box.width / 2, box.y + box.height / 2);
    
    console.log('Top element at button position:', topElement);
    
    // Remove common overlay selectors
    await page.evaluate(() => {
      const selectors = ['.overlay', '.modal', '.backdrop', '.popup', '[role="dialog"]'];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => el.remove());
      });
    });
  }
  
  // Step 4: Try JavaScript click
  try {
    await buttonLocator.evaluate((el) => (el as HTMLElement).click());
    return true;
  } catch (e) {
    console.log('JavaScript click failed...');
  }
  
  // Step 5: Dispatch complete event sequence
  try {
    await buttonLocator.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      
      ['mousedown', 'mouseup', 'click'].forEach(eventType => {
        const event = new MouseEvent(eventType, {
          bubbles: true,
          cancelable: true,
          clientX: centerX,
          clientY: centerY,
          button: 0,
          detail: 1
        });
        el.dispatchEvent(event);
      });
    });
    return true;
  } catch (e) {
    console.log('Event sequence failed...');
  }
  
  // Step 6: Focus and press Enter
  try {
    await buttonLocator.focus();
    await page.keyboard.press('Enter');
    return true;
  } catch (e) {
    console.log('Enter key failed...');
  }
  
  // Step 7: Submit parent form directly
  try {
    await buttonLocator.evaluate((el) => {
      const form = el.closest('form');
      if (form) {
        form.submit();
      }
    });
    return true;
  } catch (e) {
    console.log('Form submit failed');
  }
  
  return false;
}
```

### Best Practices

1. **Always start with standard methods** - They're the most reliable and maintainable
2. **Add proper error handling** - Catch and log failures for debugging
3. **Use appropriate timeouts** - Don't let tests hang indefinitely
4. **Verify state changes** - Confirm the action had the expected effect
5. **Document fallback usage** - Explain why fallbacks are needed
6. **Monitor for flakiness** - Track which methods fail and why
7. **Consider user experience** - Some workarounds may bypass validation

---

## References

- Playwright Documentation: https://playwright.dev/docs/
- Playwright API: https://playwright.dev/docs/api/class-page
- BrowserStack Playwright Guide: https://www.browserstack.com/guide/playwright-click-type
- GitHub Issues: microsoft/playwright#500, microsoft/playwright#11934
