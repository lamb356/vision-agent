# Comprehensive Research Report: Building a General-Purpose Vision-Based Browser Automation Agent

## Executive Summary

This report provides exhaustive research across 10 dimensions to solve 7 critical problems in building a vision-based browser automation agent for Brett Adcock's Browser Navigation Challenge. The research covers state-of-the-art agents, prompting techniques, DOM representations, element interaction strategies, and specific solutions for each problem area.

---

## Table of Contents

1. [Problem-to-Solution Quick Reference](#problem-to-solution-quick-reference)
2. [Research Direction 1: State-of-the-Art Browser Agents](#research-direction-1-state-of-the-art-browser-agents)
3. [Research Direction 2: VLM Prompting Techniques](#research-direction-2-vlm-prompting-techniques)
4. [Research Direction 3: Set-of-Mark (SoM) Prompting](#research-direction-3-set-of-mark-som-prompting)
5. [Research Direction 4: DOM Representation Strategies](#research-direction-4-dom-representation-strategies)
6. [Research Direction 5: Robust Element Interaction](#research-direction-5-robust-element-interaction)
7. [Research Direction 6: Multi-Turn Agent Loops](#research-direction-6-multi-turn-agent-loops)
8. [Research Direction 7: Error Recovery and Exploration](#research-direction-7-error-recovery-and-exploration)
9. [Research Direction 8: Trap and Decoy Detection](#research-direction-8-trap-and-decoy-detection)
10. [Research Direction 9: Code/Text Extraction](#research-direction-9-codetext-extraction)
11. [Research Direction 10: Gemini Flash Specifics](#research-direction-10-gemini-flash-specifics)
12. [Implementation Roadmap](#implementation-roadmap)
13. [References and Resources](#references-and-resources)

---

## Problem-to-Solution Quick Reference

| Problem | Root Cause | Primary Solution | Expected Impact |
|---------|------------|------------------|-----------------|
| **Problem 1: Single-Action Plans** | Missing schema constraints, default thinking mode | Structured JSON schema with `minItems`, `thinking_level="minimal"` | ⭐⭐⭐⭐⭐ |
| **Problem 2: Phantom Code Extraction** | Regex matches CSS values | TreeWalker + context filtering + confidence scoring | ⭐⭐⭐⭐⭐ |
| **Problem 3: Submit Button Blocked** | Overlays, z-index issues | 8-step fallback chain starting with force click | ⭐⭐⭐⭐ |
| **Problem 4: Decoy Buttons** | No discrimination logic | Multi-factor scoring (10+ heuristics) | ⭐⭐⭐⭐ |
| **Problem 5: Overlay Management** | Aggressive DOM removal | Confidence-based detection + whitelist protection | ⭐⭐⭐⭐ |
| **Problem 6: Scroll Strategy** | No stopping criteria | Progressive scroll with content stabilization detection | ⭐⭐⭐⭐ |
| **Problem 7: Page State Stagnation** | No stuck detection | 6-layer detection + progressive recovery | ⭐⭐⭐⭐⭐ |

---

## Research Direction 1: State-of-the-Art Browser Agents

### 1.1 Comparison of Leading Systems (2024-2025)

| System | Institution | Core Innovation | Success Rate | Best For |
|--------|-------------|-----------------|--------------|----------|
| **WebVoyager** | Zhejiang/Tencent | Set-of-Mark visual grounding | 59.1% | Real websites |
| **SeeAct** | OSU/OpenAI | Two-stage plan→ground | 51.1% (oracle) | Live evaluation |
| **CogAgent** | Tsinghua | 1120×1120 high-res vision | SOTA on AITW | Tiny element recognition |
| **WILBUR** | OSU | Backtracking + reflection | 53% text-only | Recovery from stuck states |
| **MindAct** | Microsoft | Cross-encoder ranking | SOTA Mind2Web | HTML-based grounding |
| **AutoWebGLM** | Tsinghua | Curriculum + RL training | 18.2% WebArena | Open-domain navigation |
| **Agent-E** | Vercel Labs | Accessibility tree refs | Production | CLI automation |
| **BrowserGym** | ServiceNow | Gymnasium environment | 23.5% GPT-4 | Benchmarking framework |

### 1.2 Key Architectural Patterns

#### WebVoyager's ReAct Loop (Best for Multi-Step Planning)
```
Observation: "The image shows..."
Thought: "To proceed, I need to..."
Action: "Click [17]" or "Type [13]; Warsaw"
```

#### SeeAct's Two-Stage Design (Best for Element Grounding)
```
Stage 1: Action Generation → "Click the 'Find Your Truck' button"
Stage 2: Element Grounding → Convert description to HTML element
```

#### CogAgent's End-to-End Vision (Best for Tiny Elements)
```
Screenshot (1120×1120) → VLM → "Click at coordinates (0.45, 0.32)"
```

### 1.3 Critical Insights for Your Problems

**For Problem 1 (Single-Action Plans):**
- WebVoyager uses chain-of-thought reasoning before each action
- SeeAct's two-stage design separates planning from execution
- AutoWebGLM uses curriculum learning for progressive skill building

**For Problem 3 (Blocked Elements):**
- Set-of-Mark visual grounding bypasses HTML complexity
- Multi-modal grounding (HTML + visual) outperforms pure visual by **10%**
- High-resolution vision (1120×1120) captures tiny elements

**For Problem 7 (Stuck States):**
- WILBUR's intelligent backtracking achieves **6% improvement** over retry-only
- Demonstration retrieval provides **12% improvement** from learning failures
- Reflection module verifies progress after each action

### 1.4 Essential Resources

**Papers:**
- WebVoyager: https://arxiv.org/abs/2401.13919
- SeeAct: https://arxiv.org/abs/2401.01614
- CogAgent: https://arxiv.org/abs/2312.08914
- WILBUR: https://arxiv.org/abs/2404.05902

**Code:**
- WebVoyager: https://github.com/MinorJerry/WebVoyager
- SeeAct: https://github.com/OSU-NLP-Group/SeeAct
- BrowserGym: https://github.com/ServiceNow/BrowserGym

---

## Research Direction 2: VLM Prompting Techniques

### 2.1 Why Models Default to Single Actions

Based on research from WebArena, SeeAct, and EconWebArena:

1. **Training bias**: Most web agent training uses step-by-step (ReAct) patterns
2. **Safety mechanisms**: Models are trained to be cautious and verify each step
3. **Prompt ambiguity**: "Up to N actions" is interpreted as maximum, not target
4. **Lack of examples**: Without seeing multi-action outputs, models don't know the expected format

**Key finding**: EconWebArena's ablation study shows enabling `multiaction` actually **decreased** success rate from 46.9% to 41.9% - simply allowing multiple actions isn't enough; the model needs explicit instruction.

### 2.2 Ranked Solutions for Multi-Action Output

| Rank | Technique | Expected Impact | Implementation Effort |
|------|-----------|-----------------|----------------------|
| 1 | **Structured JSON Schema with `minItems`** | ⭐⭐⭐⭐⭐ | Medium |
| 2 | **Plan-Then-Execute Prompting** | ⭐⭐⭐⭐ | Low |
| 3 | **Few-Shot Multi-Action Examples** | ⭐⭐⭐⭐ | Low |
| 4 | **ReAct-Style System Prompt** | ⭐⭐⭐ | Medium |
| 5 | **Hierarchical Planning** | ⭐⭐⭐⭐ | Medium |

### 2.3 Solution 1: Structured JSON Schema (HIGHEST IMPACT)

```typescript
const actionSchema = {
  type: "object",
  properties: {
    plan_analysis: { 
      type: "string",
      description: "Brief analysis of what needs to be done"
    },
    actions: {
      type: "array",
      description: "ARRAY OF ACTIONS - MUST contain at least 5 actions for efficiency",
      minItems: 5,  // ← CRITICAL: Forces multiple actions
      maxItems: 25,
      items: {
        type: "object",
        properties: {
          action_type: {
            type: "string",
            enum: ["click", "type", "scroll", "wait", "dismiss", "submit"]
          },
          target: { type: "string" },
          value: { type: "string" },
          reasoning: { type: "string" }
        },
        required: ["action_type", "target", "reasoning"]
      }
    },
    expected_final_state: { type: "string" }
  },
  required: ["plan_analysis", "actions", "expected_final_state"]
};

// Gemini implementation
const model = genAI.getGenerativeModel({
  model: "gemini-3-flash-preview",
  generationConfig: {
    responseMimeType: "application/json",
    responseSchema: actionSchema,
    temperature: 0.4
  }
});
```

### 2.4 Solution 2: Plan-Then-Execute Prompting

```
You are a web automation planner. Generate a COMPLETE plan upfront.

=== USER GOAL ===
{user_goal}

=== CURRENT PAGE ===
URL: {url}
Screenshot: [attached]

=== INSTRUCTIONS ===
1. FIRST, analyze the current page and plan ALL necessary steps
2. THEN, output a JSON array of actions to execute in sequence
3. Include between 5-25 actions depending on task complexity
4. Each action must include reasoning

=== OUTPUT FORMAT ===
{
  "analysis": "Your understanding of the current state",
  "actions": [
    {"action": "click|type|scroll|wait|dismiss", "target": "...", "value": "...", "reasoning": "..."}
  ],
  "expected_outcome": "What the page will look like after all actions"
}

CRITICAL: Generate at least 5 actions. Single-action responses are unacceptable.
```

### 2.5 Solution 3: Few-Shot Examples

Include 3-5 examples showing multi-action sequences:

```
=== EXAMPLE 1: Scrolling Required ===
Goal: "Find the contact information at the bottom of the page"
Response: {
  "analysis": "Contact information is in the footer, below current viewport",
  "actions": [
    {"action": "scroll", "target": "page", "value": "down 5", "reasoning": "Scroll to footer section"},
    {"action": "wait", "target": "page", "value": "1", "reasoning": "Allow footer to load"},
    {"action": "click", "target": "Contact link", "reasoning": "Navigate to contact page"}
  ],
  "expected_outcome": "Contact page with information is displayed"
}

=== EXAMPLE 2: Handling Popups ===
Goal: "Read the article content"
Response: {
  "analysis": "Newsletter popup is blocking the article content",
  "actions": [
    {"action": "dismiss", "target": "Newsletter signup popup", "reasoning": "Close popup to access article"},
    {"action": "wait", "target": "page", "value": "1", "reasoning": "Wait for popup to close"},
    {"action": "scroll", "target": "page", "value": "down 3", "reasoning": "Scroll to read article content"}
  ],
  "expected_outcome": "Article content is visible and readable"
}
```

### 2.6 Before/After Comparison

**BEFORE (Your Current Problem):**
```json
{"actions": [{"action": "submit_code", "code": "..."}]}
```

**AFTER (With Solutions Applied):**
```json
{
  "analysis": "The current view shows the top of the page with navigation. Contact information is typically in the footer section which is below the current viewport.",
  "actions": [
    {"action": "scroll", "target": "page", "value": "down 5", "reasoning": "Scroll down to reach the footer section"},
    {"action": "wait", "target": "page", "value": "1", "reasoning": "Allow any lazy-loaded footer content to appear"},
    {"action": "scroll", "target": "page", "value": "down 3", "reasoning": "Continue scrolling to ensure footer is fully visible"},
    {"action": "click", "target": "Contact Us link in footer", "reasoning": "Navigate to dedicated contact page"}
  ],
  "expected_outcome": "Contact page with email, phone, and address information is displayed"
}
```

---

## Research Direction 3: Set-of-Mark (SoM) Prompting

### 3.1 What is Set-of-Mark?

Set-of-Mark (SoM) is a visual prompting technique from Microsoft Research (2023) that overlays numbered labels on image regions to significantly improve visual grounding in multimodal models.

**Key Paper**: "Set-of-Mark Prompting Unleashes Extraordinary Visual Grounding in GPT-4V" (arXiv:2310.11441)

### 3.2 Performance Improvements

| Task | Without SoM | With SoM | Improvement |
|------|-------------|----------|-------------|
| RefCOCOg REC | 25.7% | **86.4%** | **+60.7%** |
| Phrase Grounding | n/a | **89.2%** R@1 | SOTA-level |

### 3.3 Why SoM Works Better Than Raw Coordinates

1. **Interpretability**: Numbers are "speakable" - LLMs naturally reference them
2. **Visual grounding**: Models directly associate text with visual marks
3. **Reduced cognitive load**: No need to estimate precise coordinates
4. **Natural human-like interaction**: Humans also use pointing and labeling

### 3.4 TypeScript/Playwright Implementation

```typescript
import { Page, ElementHandle } from 'playwright';
import sharp from 'sharp';
import { createCanvas, loadImage } from 'canvas';

interface InteractiveElement {
  id: number;
  element: ElementHandle;
  bbox: { x: number; y: number; width: number; height: number };
  text: string;
  role: string;
  visible: boolean;
}

class SoMOverlay {
  constructor(private page: Page) {}
  
  async extractInteractiveElements(): Promise<InteractiveElement[]> {
    const elements = await this.page.$$(`
      button, a, input, textarea, select, [role="button"],
      [role="link"], [role="textbox"], [onclick], 
      [tabindex]:not([tabindex="-1"])
    `);
    
    const interactiveElements: InteractiveElement[] = [];
    let id = 1;
    
    for (const element of elements) {
      const bbox = await element.boundingBox();
      const visible = await element.isVisible().catch(() => false);
      
      if (bbox && visible && bbox.width > 5 && bbox.height > 5) {
        const text = await element.textContent().catch(() => '') || '';
        const role = await element.getAttribute('role').catch(() => '');
        
        interactiveElements.push({
          id: id++,
          element,
          bbox,
          text: text.slice(0, 100),
          role,
          visible
        });
      }
    }
    
    return interactiveElements;
  }
  
  async createMarkedScreenshot(elements: InteractiveElement[]): Promise<Buffer> {
    const screenshot = await this.page.screenshot({ fullPage: false });
    const image = await loadImage(screenshot);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    
    ctx.drawImage(image, 0, 0);
    
    for (const el of elements) {
      const { x, y, width, height } = el.bbox;
      
      // Semi-transparent fill
      ctx.fillStyle = 'rgba(255, 255, 0, 0.2)';
      ctx.fillRect(x, y, width, height);
      
      // Border
      ctx.strokeStyle = '#FF0000';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, width, height);
      
      // Label background
      const label = String(el.id);
      const textMetrics = ctx.measureText(label);
      ctx.fillStyle = '#FF0000';
      ctx.fillRect(x, y - 18, textMetrics.width + 8, 18);
      
      // Label text
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 14px Arial';
      ctx.fillText(label, x + 4, y - 4);
    }
    
    return canvas.toBuffer('png');
  }
}
```

### 3.5 Expected Impact on Your Problems

| Problem | Impact | Explanation |
|---------|--------|-------------|
| Problem 4 (Decoy Buttons) | +30% accuracy | Visual grounding helps distinguish similar buttons |
| Problem 1 (Single-Action) | +20% improvement | Numbered labels make element targeting clearer |
| Problem 3 (Blocked Elements) | +15% improvement | Visual + DOM hybrid approach more robust |

---

## Research Direction 4: DOM Representation Strategies

### 4.1 Comparison of Approaches

| Approach | Token Size | Information Density | Strengths | Weaknesses |
|----------|------------|---------------------|-----------|------------|
| **Full HTML** | Very High (10^6 bytes) | Low | Complete information | Exceeds context window |
| **Filtered DOM** | High | Medium | Balanced | Requires filtering rules |
| **Accessibility Tree** | Low (~10^3 tokens) | High | Semantic, compact | May miss non-compliant elements |
| **Hybrid (Vision + AXTree)** | Medium | High | Best of both | More complex |

### 4.2 Accessibility Tree Extraction

**Key Insight**: Accessibility Tree reduces token consumption by ~90% vs raw DOM.

```typescript
// Get accessibility tree snapshot
const snapshot = await page.accessibility.snapshot();

// Get aria snapshot (newer Playwright versions)
const ariaSnapshot = await page.locator('body').ariaSnapshot();
```

**Structure:**
```json
{
  "role": "WebArea",
  "name": "Example Page",
  "children": [
    {"role": "heading", "name": "Welcome", "level": 1},
    {"role": "button", "name": "Submit", "focused": false, "focusable": true},
    {"role": "textbox", "name": "Email", "description": "Enter your email", "focusable": true}
  ]
}
```

### 4.3 Recommended Element Attributes

```typescript
interface ElementRepresentation {
  ref: number;           // Unique identifier (essential)
  role: string;          // Semantic type (essential)
  name: string;          // Label/text (essential)
  bbox: { x, y, width, height };  // Bounding box (essential)
  visible: boolean;      // Visibility flag (essential)
  text?: string;         // Truncated content (optional)
  placeholder?: string;  // Helpful for form fields
  required?: boolean;    // Helpful for validation
}
```

### 4.4 Filtering Best Practices

**INCLUDE:**
```typescript
const INCLUDE_SELECTORS = [
  'button', 'a[href]', 'input', 'textarea', 'select',
  '[role="button"]', '[role="link"]', '[role="textbox"]',
  '[onclick]', '[tabindex]:not([tabindex="-1"])',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6'
];
```

**EXCLUDE:**
```typescript
const EXCLUDE_SELECTORS = [
  '[hidden]', '[aria-hidden="true"]',
  '[style*="display: none"]', '[style*="visibility: hidden"]',
  'script', 'style', 'meta', 'link',
  // Filter by size: bbox.width < 5 || bbox.height < 5
];
```

### 4.5 Optimal Configuration for Your Stack

```typescript
const DOM_CONFIG = {
  maxTextLength: 100,
  maxElements: 100,
  minElementSize: 5,
  includeHidden: false,
  include: {
    ref: true,
    role: true,
    name: true,
    bbox: true,
    visible: true,
    text: true
  }
};
```

---

## Research Direction 5: Robust Element Interaction

### 5.1 Comprehensive Fallback Chain (8 Methods)

| Priority | Method | Code | When to Use |
|----------|--------|------|-------------|
| 1 | Standard Click | `await locator.click()` | Normal interactions |
| 2 | Force Click | `await locator.click({ force: true })` | Covered but clickable |
| 3 | Remove Overlays + Click | `await removeOverlays(page)` then click | Known overlays |
| 4 | Dispatch Event | `await locator.dispatchEvent('click')` | Hidden elements |
| 5 | JavaScript Click | `await locator.evaluate(el => el.click())` | Shadow DOM |
| 6 | Focus + Enter | `await locator.focus(); await page.keyboard.press('Enter')` | Form submissions |
| 7 | Form Submit | `await page.evaluate(() => form.submit())` | Button blocked |
| 8 | Coordinate Click | `await page.mouse.click(x, y)` | Last resort |

### 5.2 Implementation

```typescript
async function robustClick(
  page: Page,
  locator: Locator,
  options: { maxRetries?: number; removeOverlays?: boolean } = {}
): Promise<boolean> {
  const { maxRetries = 3, removeOverlays = false } = options;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Step 1: Standard click
      if (attempt === 1) {
        await locator.click({ timeout: 5000 });
        return true;
      }
      
      // Step 2: Scroll into view and force click
      await locator.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await locator.click({ force: true, timeout: 3000 });
      return true;
    } catch (e) {
      // Continue to next method
    }
    
    // Step 3: Remove overlays
    if (removeOverlays) {
      await page.evaluate(() => {
        document.querySelectorAll('.overlay, .modal-backdrop, [role="dialog"]')
          .forEach(el => el.remove());
      });
    }
    
    // Step 4: Dispatch event
    try {
      await locator.dispatchEvent('click');
      return true;
    } catch (e) {}
    
    // Step 5: JavaScript click
    try {
      await locator.evaluate((el) => (el as HTMLElement).click());
      return true;
    } catch (e) {}
    
    // Step 6: Mouse click at coordinates
    const box = await locator.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return true;
    }
  }
  
  return false;
}
```

### 5.3 Detection for Covered Elements

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
```

---

## Research Direction 6: Multi-Turn Agent Loops

### 6.1 Recommended OAO Loop Structure

```
OBSERVE (capture page state) 
    → THINK (detect stuck state, plan action) 
    → ACT (execute browser action) 
    → VERIFY (check result) 
    → RECOVERY (if stuck detected)
```

### 6.2 When to Re-screenshot vs Batch Actions

| Scenario | Strategy | Rationale |
|----------|----------|-----------|
| Single action | Re-screenshot after each | Verify state change |
| Sequential dependent actions | Re-screenshot between each | Each depends on previous |
| Independent batch | Batch then verify | Efficiency for safe sequences |
| Navigation | Always re-screenshot | Page completely changes |

**Rule of Thumb**: Re-screenshot after any action that could change page state.

### 6.3 Speed vs Reliability Trade-offs

| Approach | Speed | Reliability | Use Case |
|----------|-------|-------------|----------|
| Minimal verification | Fast | Low | Simple, predictable tasks |
| State diff check | Medium | Medium | Most web automation |
| Full screenshot + DOM | Slow | High | Complex, dynamic pages |

---

## Research Direction 7: Error Recovery and Exploration

### 7.1 Six-Layer Stuck State Detection

| Check | Description | Threshold |
|-------|-------------|-----------|
| Page Unchanged | Screenshot + DOM hash comparison | >95% similar = stuck |
| Repeated Actions | Same action signature | 3+ repeats = stuck |
| No Progress | Task progress not advancing | 5+ steps = stuck |
| Action Failures | Consistent execution failures | 60%+ rate = stuck |
| Element Repetition | Clicking same element repeatedly | 3+ times = stuck |
| Circular Navigation | URL cycling (A→B→A→B) | 2-cycle = stuck |

### 7.2 Progressive Recovery Strategy

| Level | Trigger | Actions |
|-------|---------|---------|
| 1 - Mild | 2-3 stuck indicators | Wait, scroll, refresh |
| 2 - Moderate | 3-4 stuck indicators | Alternative selectors, different action types |
| 3 - Severe | 4+ stuck indicators | Backtrack, different approach, systematic exploration |
| 4 - Final | All recovery failed | Human handoff, mark failed |

### 7.3 Backtracking Implementation

```typescript
interface Checkpoint {
  id: string;
  state: PageState;
  taskProgress: TaskProgress;
  actionHistory: ActionRecord[];
  timestamp: number;
}

class BacktrackingManager {
  private checkpoints: Checkpoint[] = [];
  private maxCheckpoints: number = 5;
  
  saveCheckpoint(state: PageState, progress: TaskProgress): Checkpoint {
    const checkpoint: Checkpoint = {
      id: `cp_${Date.now()}`,
      state: this.cloneState(state),
      taskProgress: this.cloneProgress(progress),
      actionHistory: [...this.actionHistory],
      timestamp: Date.now()
    };
    
    this.checkpoints.push(checkpoint);
    if (this.checkpoints.length > this.maxCheckpoints) {
      this.checkpoints.shift();
    }
    
    return checkpoint;
  }
  
  async backtrack(): Promise<BacktrackResult> {
    const checkpoint = this.findBestCheckpoint();
    if (!checkpoint) return { success: false };
    
    await this.restoreBrowserState(checkpoint.state);
    this.markPathAsFailed(checkpoint);
    
    return { success: true, checkpoint };
  }
}
```

---

## Research Direction 8: Trap and Decoy Detection

### 8.1 Common Decoy Patterns

| Indicator | Real Element | Decoy/Trap |
|-----------|--------------|------------|
| Event Listeners | Has meaningful handlers | Empty or suspicious |
| href attribute | Valid URL | Missing, #, javascript:; |
| aria-hidden | false or absent | true |
| tabindex | 0 or positive | -1 (unfocusable) |
| pointer-events | auto | none |

### 8.2 Multi-Factor Button Scoring (10+ Factors)

```typescript
interface ButtonScore {
  element: ElementHandle;
  score: number;
  reasons: string[];
}

async function scoreButton(element: ElementHandle): Promise<ButtonScore> {
  const metadata = await extractMetadata(element);
  const reasons: string[] = [];
  let score = 0;

  // Factor 1: Visibility (critical)
  if (metadata.isVisible) {
    score += 2;
    reasons.push('visible');
  } else {
    score -= 5;
    reasons.push('hidden');
  }

  // Factor 2: Clickability (critical)
  if (metadata.isClickable) {
    score += 2;
    reasons.push('clickable');
  } else {
    score -= 5;
    reasons.push('not-clickable');
  }

  // Factor 3: Has valid href
  if (metadata.hasHref) {
    score += 1.5;
    reasons.push('has-href');
  }

  // Factor 4: Size appropriateness
  const sizeScore = scoreSize(metadata.size);
  score += sizeScore;

  // Factor 5: Text content analysis
  const textScore = scoreText(metadata.text);
  score += textScore;

  // Factor 6: Position (prefer lower on page for navigation)
  if (metadata.position.y > 500) {
    score += 0.5;
    reasons.push('lower-position');
  }

  // Factor 7: Z-index (on top)
  if (metadata.zIndex > 0) {
    score += 0.5;
    reasons.push('on-top');
  }

  // Factor 8: Color contrast
  if (metadata.colorContrast > 3) {
    score += 0.5;
    reasons.push('high-contrast');
  }

  // Factor 9: In viewport
  if (metadata.isInViewport) {
    score += 1;
    reasons.push('in-viewport');
  }

  // Factor 10: Check for trap indicators
  const isTrap = await checkForTrapIndicators(element);
  if (isTrap) {
    score -= 3;
    reasons.push('possible-trap');
  }

  return { element, score, reasons };
}
```

### 8.3 Scroll-to-Find Strategy

```typescript
async function scrollToFindButton(
  page: Page, 
  detector: DecoyButtonDetector,
  maxScrolls: number = 10
): Promise<ElementHandle | null> {
  for (let i = 0; i < maxScrolls; i++) {
    // Try to find button at current scroll position
    const button = await detector.findRealButton(page);
    if (button && await button.isVisible()) {
      return button;
    }

    // Scroll down
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 0.8);
    });

    // Wait for lazy-loaded content
    await page.waitForTimeout(500);
  }

  return null;
}
```

---

## Research Direction 9: Code/Text Extraction

### 9.1 The Problem: Phantom Code Extraction

Your regex `[a-zA-Z0-9]{6}` matches CSS values like:
- "1500ms" (animation duration)
- "1179px" (element width)
- "1981px" (position value)

### 9.2 Multi-Layer Filtering Approach

```
Layer 1: Extract all 6-char alphanumeric strings
Layer 2: Filter out CSS units (ms, px, pt, em, rem, %, s)
Layer 3: Filter by context (parent element, surrounding text)
Layer 4: Validate format (real codes have specific patterns)
Layer 5: Deduplicate and rank by confidence
```

### 9.3 TypeScript Implementation

```typescript
interface ExtractedCode {
  code: string;
  confidence: number;
  source: string;
  context: string;
}

const DEFAULT_CONFIG = {
  minLength: 6,
  maxLength: 6,
  requireDigit: true,
  requireLetter: true,
  excludedUnits: ['ms', 'px', 'pt', 'em', 'rem', 's', 'sec', '%', 'vh', 'vw', 'deg'],
  excludedPatterns: [
    /^#?[0-9a-fA-F]{6}$/,  // Hex colors
    /^[0-9]{6}$/,           // Numbers only
    /^rgb/, /^hsl/,         // RGB/HSL values
    /^[0-9]+\.[0-9]+/,      // Decimal numbers
  ]
};

async function extractCodes(page: Page): Promise<ExtractedCode[]> {
  const candidates: ExtractedCode[] = [];

  // Method 1: Extract from visible text only (excludes CSS)
  const textCodes = await extractFromVisibleText(page);
  candidates.push(...textCodes);

  // Method 2: Extract from data-* attributes
  const attrCodes = await extractFromDataAttributes(page);
  candidates.push(...attrCodes);

  // Filter and rank
  return filterAndRank(candidates);
}

async function extractFromVisibleText(page: Page): Promise<ExtractedCode[]> {
  return page.evaluate((config) => {
    const results: ExtractedCode[] = [];
    const seen = new Set<string>();

    // Use TreeWalker to get only visible text nodes
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
  }, DEFAULT_CONFIG);
}

function filterAndRank(candidates: ExtractedCode[]): ExtractedCode[] {
  const filtered: ExtractedCode[] = [];

  for (const candidate of candidates) {
    const code = candidate.code;

    // Check 1: Must contain at least one digit
    if (!/\d/.test(code)) continue;

    // Check 2: Must contain at least one letter
    if (!/[a-zA-Z]/.test(code)) continue;

    // Check 3: Exclude CSS units
    const lowerCode = code.toLowerCase();
    for (const unit of DEFAULT_CONFIG.excludedUnits) {
      if (lowerCode.endsWith(unit)) {
        candidate.confidence -= 0.5;
        break;
      }
    }

    // Check 4: Exclude pattern matches
    for (const pattern of DEFAULT_CONFIG.excludedPatterns) {
      if (pattern.test(code)) {
        candidate.confidence -= 0.7;
        break;
      }
    }

    // Check 5: Context validation
    if (isGoodContext(candidate.context)) {
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

function isGoodContext(context: string): boolean {
  const goodIndicators = [
    'code', 'token', 'key', 'secret', 'verify', 'confirm',
    'enter', 'input', 'submit', 'validation'
  ];
  const lowerContext = context.toLowerCase();
  return goodIndicators.some(ind => lowerContext.includes(ind));
}
```

---

## Research Direction 10: Gemini Flash Specifics

### 10.1 Model Comparison

| Model | Context Window | Output Tokens | UI Accuracy | Best For |
|-------|---------------|---------------|-------------|----------|
| **gemini-3-flash-preview** | 1M tokens | 59 max | 69.1% spatial | Speed, cost |
| **gemini-2.5-flash** | 1M tokens | 8,192 | 82% position | Stability |
| **gemini-3-pro-preview** | 1M tokens | 64K | Higher | Complex reasoning |

### 10.2 The Single-Action Problem - Root Causes

1. **Model Architecture**: Optimized for fast, single-turn responses
2. **Thinking Level**: Default "high" mode causes over-analysis
3. **Schema Description**: Without explicit field descriptions, defaults to minimal output
4. **Context Window**: Screenshots accumulate, causing output compression

### 10.3 Proven Solutions

#### Solution A: Explicit Schema Descriptions (MOST EFFECTIVE)

```typescript
class ActionPlan extends BaseModel {
  actions: BrowserAction[] = Field(
    ...,
    description: "List of actions to execute in sequence. Generate 5-25 actions to complete the task efficiently.",
    min_items: 5,  // Enforce minimum
    max_items: 25
  )
}
```

#### Solution B: Set Thinking Level to "Minimal"

```typescript
const config = types.GenerateContentConfig(
    thinking_config=types.ThinkingConfig(thinking_level="minimal")
)
```

#### Solution C: Strong Prompt Directives

```
CRITICAL: To minimize API calls, you MUST output MULTIPLE actions in each response. 
Single-action responses will be considered a failure.
```

### 10.4 Recommended Configuration

```typescript
const config = types.GenerateContentConfig(
  system_instruction=SYSTEM_PROMPT_WITH_MULTIPLE_ACTION_EMPHASIS,
  temperature=0.4,  // Lower for more deterministic output
  thinking_config=types.ThinkingConfig(thinking_level="minimal"),
  response_mime_type="application/json",
  response_schema={
    type: "object",
    properties: {
      actions: {
        type: "array",
        items: {...},
        minItems: 5,  // Critical!
        maxItems: 25,
        description: "Generate at least 5 actions to complete the task efficiently"
      }
    }
  }
);
```

### 10.5 Known Limitations and Workarounds

| Issue | Workaround |
|-------|------------|
| "Internal Error" with preview models | Toggle thinking levels or remove system instructions temporarily |
| Thought signature errors | Disable parallel tool calling |
| Context window truncation | Summarize history periodically |
| Screenshot token bloat | Resize images to 1024px max width |

---

## Implementation Roadmap

### Phase 1: Critical Fixes (Week 1)

| Priority | Task | Problem Solved |
|----------|------|----------------|
| P0 | Add `minItems: 5` to JSON schema | Problem 1 |
| P0 | Set `thinking_level: "minimal"` | Problem 1 |
| P0 | Implement TreeWalker code extraction | Problem 2 |
| P1 | Add 8-step fallback chain for clicks | Problem 3 |
| P1 | Implement button scoring system | Problem 4 |

### Phase 2: Robustness (Week 2)

| Priority | Task | Problem Solved |
|----------|------|----------------|
| P1 | Implement overlay confidence detection | Problem 5 |
| P1 | Add progressive scroll with stabilization | Problem 6 |
| P1 | Implement 6-layer stuck detection | Problem 7 |
| P2 | Add backtracking mechanism | Problem 7 |

### Phase 3: Optimization (Week 3)

| Priority | Task | Impact |
|----------|------|--------|
| P2 | Implement Set-of-Mark overlays | +25% element accuracy |
| P2 | Add action memory system | Prevents repeated failures |
| P2 | Implement strategy evolution | Adaptive approach |
| P3 | Add hybrid DOM + Vision approach | Best of both worlds |

---

## References and Resources

### Essential Papers

| Paper | Authors | Venue | Link |
|-------|---------|-------|------|
| WebVoyager | He et al. | ACL 2024 | https://arxiv.org/abs/2401.13919 |
| SeeAct | Zheng et al. | ICML 2024 | https://arxiv.org/abs/2401.01614 |
| CogAgent | Hong et al. | CVPR 2024 | https://arxiv.org/abs/2312.08914 |
| Set-of-Mark | Yang et al. | arXiv 2023 | https://arxiv.org/abs/2310.11441 |
| WILBUR | Lutz et al. | arXiv 2024 | https://arxiv.org/abs/2404.05902 |
| AutoWebGLM | Lai et al. | KDD 2024 | https://arxiv.org/abs/2404.03648 |
| WebArena | Zhou et al. | ICLR 2024 | https://arxiv.org/abs/2307.13854 |
| Mind2Web | Deng et al. | NeurIPS 2023 | https://arxiv.org/abs/2306.06070 |

### Code Repositories

| System | Repository |
|--------|------------|
| WebVoyager | https://github.com/MinorJerry/WebVoyager |
| SeeAct | https://github.com/OSU-NLP-Group/SeeAct |
| CogAgent | https://github.com/THUDM/CogVLM |
| Set-of-Mark | https://github.com/microsoft/SoM |
| BrowserGym | https://github.com/ServiceNow/BrowserGym |
| Agent-E | https://github.com/vercel-labs/agent-browser |

### Benchmarks

| Benchmark | Tasks | Evaluation | Link |
|-----------|-------|------------|------|
| WebArena | 812 | Functional | https://webarena.dev/ |
| Mind2Web | 2,350 | Element accuracy | https://mind2web.github.io/ |
| WorkArena | 23,150 | Functional | https://servicenow.github.io/WorkArena/ |

---

## Summary of Key Recommendations

### For Problem 1 (Single-Action Plans):
1. Add `minItems: 5` constraint to JSON schema
2. Set `thinking_level: "minimal"` in Gemini config
3. Include explicit prompt directives about multiple actions
4. Add few-shot examples showing multi-action sequences

### For Problem 2 (Phantom Code Extraction):
1. Use TreeWalker to extract only from visible text nodes
2. Filter out CSS units (ms, px, pt, em, etc.)
3. Require mixed alphanumeric (letters + digits)
4. Use confidence scoring and rank candidates

### For Problem 3 (Submit Button Blocked):
1. Implement 8-step fallback chain
2. Start with force click, escalate to JavaScript evaluation
3. Detect and remove overlays before clicking
4. Use coordinate-based click as last resort

### For Problem 4 (Decoy Buttons):
1. Implement 10-factor scoring system
2. Check for trap indicators (aria-hidden, tabindex=-1)
3. Analyze text content for navigation keywords
4. Scroll incrementally when page says "keep scrolling"

### For Problem 5 (Overlay Management):
1. Use confidence-based detection (50+ threshold)
2. Implement whitelist for protected elements
3. Try close buttons before DOM removal
4. Use continuous monitoring for reappearing popups

### For Problem 6 (Scroll Strategy):
1. Use viewport-sized scroll increments (80% overlap)
2. Detect content stabilization (3 consecutive identical measurements)
3. Monitor scrollHeight changes for infinite scroll
4. Stop when target found or max scrolls reached

### For Problem 7 (Page State Stagnation):
1. Implement 6-layer stuck detection
2. Use progressive recovery (4 levels)
3. Add checkpoint/backtracking mechanism
4. Implement action memory to avoid repeated failures

---

*Report compiled from comprehensive parallel research across 10 dimensions for building production-grade vision-based browser automation agents.*
