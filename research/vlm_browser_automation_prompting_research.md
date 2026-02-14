# Vision-Language Model Prompting Techniques for Browser Automation
## Research Report: Solving the Single-Action Problem

---

## Executive Summary

This research addresses the user's core problem: **Gemini consistently returns only 1 action instead of multi-step plans** (e.g., "scroll down 5 times, dismiss the popup, click the green button"). The following techniques are ranked by expected impact on forcing multi-action outputs.

---

## 1. Ranked Recommendations (By Expected Impact)

### 🔴 CRITICAL (Highest Impact)

| Rank | Technique | Expected Impact | Effort |
|------|-----------|-----------------|--------|
| 1 | **Structured JSON Output Schema** | Forces array of actions | Medium |
| 2 | **Plan-Then-Execute Prompting** | Generates full plan first | Low |
| 3 | **Few-Shot Multi-Action Examples** | Shows expected format | Low |
| 4 | **ReAct-Style System Prompt** | Encourages reasoning chains | Medium |

### 🟡 HIGH IMPACT

| Rank | Technique | Expected Impact | Effort |
|------|-----------|-----------------|--------|
| 5 | **Hierarchical Planning** | Breaks down complex tasks | Medium |
| 6 | **Self-Consistency/Verification** | Reduces single-action bias | Low |
| 7 | **Model-Specific Prompting** | Leverages Gemini quirks | Low |

---

## 2. The Core Problem Analysis

Based on research from WebArena, SeeAct, WebVoyager, and EconWebArena benchmarks:

**Why models default to single actions:**
1. **Training bias**: Most web agent training uses step-by-step (ReAct) patterns
2. **Safety mechanisms**: Models are trained to be cautious and verify each step
3. **Prompt ambiguity**: Asking for "up to N actions" is interpreted as maximum, not target
4. **Lack of examples**: Without seeing multi-action outputs, models don't know the expected format

**Key insight from research**: The EconWebArena ablation study (Table 5) shows that enabling `multiaction` actually **decreased** success rate from 46.9% to 41.9%, suggesting that simply allowing multiple actions isn't enough - the model needs to be **explicitly instructed** on WHEN to use multiple actions.

---

## 3. Technique 1: Structured JSON Output Schema (HIGHEST IMPACT)

### The Problem with Free-Form Output
When models can output any format, they default to the simplest response (1 action).

### The Solution: Force Array Structure

```json
{
  "type": "object",
  "properties": {
    "plan_analysis": {
      "type": "string",
      "description": "Brief analysis of what needs to be done to complete the task"
    },
    "actions": {
      "type": "array",
      "description": "ARRAY OF ACTIONS - MUST contain at least 1 action, up to 25 actions",
      "minItems": 1,
      "maxItems": 25,
      "items": {
        "type": "object",
        "properties": {
          "action_type": {
            "type": "string",
            "enum": ["click", "type", "scroll", "wait", "navigate", "submit", "dismiss"],
            "description": "The type of browser action"
          },
          "target": {
            "type": "string",
            "description": "Description of the element to interact with"
          },
          "value": {
            "type": "string",
            "description": "Value for type/submit actions (optional)"
          },
          "reasoning": {
            "type": "string",
            "description": "Why this specific action is needed"
          }
        },
        "required": ["action_type", "target", "reasoning"]
      }
    },
    "expected_final_state": {
      "type": "string",
      "description": "What the page should look like after all actions"
    }
  },
  "required": ["plan_analysis", "actions", "expected_final_state"]
}
```

### Gemini-Specific Implementation

```typescript
// Using Gemini API with structured output
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const actionSchema = {
  type: "object",
  properties: {
    plan_analysis: { type: "string" },
    actions: {
      type: "array",
      minItems: 1,
      maxItems: 25,
      items: {
        type: "object",
        properties: {
          action_type: {
            type: "string",
            enum: ["click", "type", "scroll_down", "scroll_up", "wait", "navigate", "submit", "dismiss_popup"]
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

const model = genAI.getGenerativeModel({
  model: "gemini-2.0-flash-exp",
  generationConfig: {
    responseMimeType: "application/json",
    responseSchema: actionSchema,
  },
});
```

### OpenAI/GPT-4V Implementation

```typescript
import OpenAI from "openai";

const openai = new OpenAI();

const response = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [
    { role: "system", content: systemPrompt },
    { 
      role: "user", 
      content: [
        { type: "text", text: userPrompt },
        { type: "image_url", image_url: { url: screenshotBase64 } }
      ]
    }
  ],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "browser_actions",
      strict: true,
      schema: actionSchema
    }
  }
});
```

---

## 4. Technique 2: Plan-Then-Execute Prompting

### Concept
Separate planning from execution. First generate a complete plan, then execute actions.

### Two-Stage Prompt Template

#### Stage 1: Planning Prompt

```
You are a web automation planner. Your job is to analyze the current webpage and create a detailed, step-by-step plan to achieve the user's goal.

USER GOAL: {user_goal}

CURRENT PAGE STATE:
- Screenshot: [attached]
- URL: {current_url}
- Page Title: {page_title}

INSTRUCTIONS:
1. Analyze the current page and the goal
2. Break down the task into sequential steps
3. Consider what actions are needed (scroll, click, type, wait, etc.)
4. Think about potential obstacles (popups, loading states, pagination)

OUTPUT FORMAT - Respond with a JSON object:
{
  "task_analysis": "Brief description of what needs to be done",
  "estimated_steps": <number>,
  "plan": [
    {
      "step_number": 1,
      "action": "Specific action description",
      "target": "What element to interact with",
      "purpose": "Why this action is needed",
      "precondition": "What must be true before this step",
      "postcondition": "What will be true after this step"
    },
    ...
  ],
  "potential_issues": ["List any anticipated problems"],
  "success_criteria": "How we know the task is complete"
}

IMPORTANT:
- Generate the COMPLETE plan upfront
- Include ALL necessary steps
- Do not stop at just one action
- Consider that the page may need scrolling, popups dismissed, etc.
```

#### Stage 2: Execution Prompt (Optional - for verification)

```
You are a web automation executor. Execute the following planned steps.

PLAN: {plan_from_stage_1}

CURRENT STATE:
- Screenshot: [attached]
- Previous Actions: {action_history}
- Current Step: {current_step_number}

Execute the current step and return the action in this format:
{
  "step_number": <number>,
  "action_type": "click|type|scroll|wait|etc",
  "target": "element description",
  "value": "value if applicable",
  "confidence": <0-1>,
  "alternative_actions": ["backup options if this fails"]
}
```

### Combined Single-Prompt Approach

```
You are an autonomous web browser agent. Your task is to complete the user's goal by generating a SEQUENCE of actions.

=== USER GOAL ===
{user_goal}

=== CURRENT PAGE ===
URL: {url}
Screenshot: [attached]

=== AVAILABLE ACTIONS ===
- click(element): Click on an element
- type(element, text): Type text into an input
- scroll(direction, amount): Scroll the page
- wait(seconds): Wait for page to load
- dismiss(element): Close popups/modals
- submit(element): Submit a form

=== INSTRUCTIONS ===
1. FIRST, analyze the current page and plan ALL necessary steps
2. THEN, output a JSON array of actions to execute in sequence
3. Include between 1-25 actions depending on task complexity
4. Each action must include reasoning

=== OUTPUT FORMAT ===
{
  "analysis": "Your understanding of the current state and what needs to be done",
  "actions": [
    {
      "action": "click|type|scroll|wait|dismiss|submit",
      "target": "Description of target element with any visible text",
      "value": "Text to type if applicable",
      "reasoning": "Why this action is necessary"
    }
  ],
  "expected_outcome": "What the page will look like after all actions"
}

=== EXAMPLES ===

Example 1 - Simple Task:
Goal: "Click the login button"
Output: {
  "analysis": "The login button is visible on the page",
  "actions": [
    {"action": "click", "target": "Login button", "reasoning": "User wants to log in"}
  ],
  "expected_outcome": "Login form appears"
}

Example 2 - Complex Task:
Goal: "Find the pricing information at the bottom of the page"
Output: {
  "analysis": "The pricing section is likely below the fold, need to scroll down",
  "actions": [
    {"action": "scroll", "target": "page", "value": "down 3 times", "reasoning": "Pricing is typically at bottom of page"},
    {"action": "wait", "target": "page", "value": "1", "reasoning": "Allow any lazy-loaded content to appear"},
    {"action": "click", "target": "Pricing link in footer", "reasoning": "Navigate to pricing section"}
  ],
  "expected_outcome": "Pricing page or section is displayed"
}

=== YOUR RESPONSE ===
```

---

## 5. Technique 3: Few-Shot Multi-Action Examples

### The Power of Examples
Research shows that providing 2-3 high-quality examples dramatically improves model performance on multi-step tasks.

### Complete Few-Shot Prompt Template

```
You are a web automation agent. Generate MULTIPLE actions to complete tasks.

=== ACTION SPACE ===
- click(element): Click on an interactive element
- type(element, text): Enter text into an input field
- scroll(direction, amount): Scroll the page (up/down, number of scrolls)
- wait(seconds): Pause for page loading
- dismiss(element): Close popups, modals, or banners
- navigate(url): Go to a specific URL
- submit(element): Submit a form

=== RULES ===
1. ALWAYS generate ALL necessary actions in ONE response
2. Return actions as a JSON array
3. Include 1-25 actions based on task complexity
4. Each action MUST include reasoning
5. Consider scrolling, popups, and multi-step workflows

=== EXAMPLE 1: Simple Login ===
Goal: "Log in to the website"
Page: Login form visible with email and password fields

Response:
{
  "analysis": "Login form is visible with all required fields",
  "actions": [
    {"action": "type", "target": "Email input field", "value": "user@example.com", "reasoning": "Enter email for authentication"},
    {"action": "type", "target": "Password input field", "value": "password123", "reasoning": "Enter password for authentication"},
    {"action": "click", "target": "Login button", "reasoning": "Submit the login form"},
    {"action": "wait", "target": "page", "value": "2", "reasoning": "Wait for login to complete and redirect"}
  ],
  "expected_outcome": "User is logged in and dashboard loads"
}

=== EXAMPLE 2: Find Information with Scrolling ===
Goal: "Find the contact information at the bottom of the page"
Page: Homepage with navigation, hero section visible

Response:
{
  "analysis": "Contact information is typically in the footer, which is below the current viewport",
  "actions": [
    {"action": "scroll", "target": "page", "value": "down 5", "reasoning": "Scroll to reach the footer section"},
    {"action": "wait", "target": "page", "value": "1", "reasoning": "Allow footer content to load"},
    {"action": "click", "target": "Contact Us link in footer", "reasoning": "Navigate to contact page"},
    {"action": "wait", "target": "page", "value": "2", "reasoning": "Wait for contact page to load"}
  ],
  "expected_outcome": "Contact page with email, phone, and address is displayed"
}

=== EXAMPLE 3: Complex Multi-Step Task ===
Goal: "Add a product to cart and proceed to checkout"
Page: Product listing page

Response:
{
  "analysis": "Need to select a product, add to cart, and navigate to checkout",
  "actions": [
    {"action": "click", "target": "First product in the list", "reasoning": "Select product to view details"},
    {"action": "wait", "target": "page", "value": "2", "reasoning": "Wait for product detail page"},
    {"action": "click", "target": "Add to Cart button", "reasoning": "Add selected product to cart"},
    {"action": "wait", "target": "page", "value": "1", "reasoning": "Wait for cart confirmation"},
    {"action": "click", "target": "Cart icon", "reasoning": "View cart contents"},
    {"action": "wait", "target": "page", "value": "1", "reasoning": "Wait for cart page"},
    {"action": "click", "target": "Proceed to Checkout button", "reasoning": "Continue to checkout flow"}
  ],
  "expected_outcome": "Checkout page with order summary is displayed"
}

=== EXAMPLE 4: Handling Popups ===
Goal: "Read the article content"
Page: Article page with newsletter signup popup blocking content

Response:
{
  "analysis": "Newsletter popup is blocking the article content and must be dismissed first",
  "actions": [
    {"action": "dismiss", "target": "Newsletter signup popup close button", "reasoning": "Close popup to access article"},
    {"action": "wait", "target": "page", "value": "1", "reasoning": "Wait for popup to close"},
    {"action": "scroll", "target": "page", "value": "down 3", "reasoning": "Scroll to read article content"}
  ],
  "expected_outcome": "Article content is visible and readable"
}

=== EXAMPLE 5: Form Completion ===
Goal: "Fill out the registration form"
Page: Registration form with multiple fields

Response:
{
  "analysis": "Registration form has multiple required fields that need to be filled sequentially",
  "actions": [
    {"action": "type", "target": "First Name field", "value": "John", "reasoning": "Enter first name"},
    {"action": "type", "target": "Last Name field", "value": "Doe", "reasoning": "Enter last name"},
    {"action": "type", "target": "Email field", "value": "john.doe@example.com", "reasoning": "Enter email address"},
    {"action": "type", "target": "Password field", "value": "SecurePass123!", "reasoning": "Enter password"},
    {"action": "type", "target": "Confirm Password field", "value": "SecurePass123!", "reasoning": "Confirm password"},
    {"action": "click", "target": "Terms checkbox", "reasoning": "Agree to terms of service"},
    {"action": "click", "target": "Register button", "reasoning": "Submit registration form"}
  ],
  "expected_outcome": "Registration completes and confirmation appears"
}

=== YOUR TASK ===
Goal: "{user_goal}"
Page: {page_description}
Screenshot: [attached]

Generate the complete action sequence:
```

---

## 6. Technique 4: ReAct-Style System Prompt

### The ReAct Pattern
ReAct (Reasoning + Acting) alternates between thought and action. For multi-action output, we modify it to generate multiple thought-action pairs at once.

### Modified ReAct Prompt for Multi-Action

```
You are a web browsing agent that operates in a continuous loop of Thought → Action → Observation.

=== SYSTEM INSTRUCTIONS ===

Your task is to complete user goals by interacting with web pages. You will be given:
- A user goal
- A screenshot of the current page
- History of previous actions and observations

=== OPERATING MODE ===

You have TWO modes:

MODE 1 - PLANNING: When you need to plan multiple steps ahead
MODE 2 - EXECUTION: When executing a single action and waiting for result

For this request, use MODE 1 - PLANNING. Generate ALL necessary actions upfront.

=== RESPONSE FORMAT ===

Respond with a JSON object containing:

{
  "thought_process": [
    {
      "step": 1,
      "thought": "Your reasoning about what needs to be done first",
      "action": "The specific browser action",
      "expected_observation": "What you expect to see after this action"
    },
    {
      "step": 2,
      "thought": "Your reasoning about the next step",
      "action": "The next browser action",
      "expected_observation": "What you expect to see after this action"
    }
    // ... continue for all necessary steps
  ],
  "actions": [
    // Array of actions to execute in sequence
    {"type": "click|type|scroll|wait|dismiss", "target": "...", "value": "..."}
  ],
  "contingency_plan": "What to do if the expected observations don't match"
}

=== ACTION TYPES ===

1. click(target): Click on an element
2. type(target, value): Type text into an input
3. scroll(direction, amount): Scroll up/down by N units
4. wait(seconds): Wait for page to load/update
5. dismiss(target): Close popup/modal
6. navigate(url): Navigate to URL
7. submit(target): Submit form

=== EXAMPLE INTERACTION ===

User Goal: "Find pricing information"
Current Page: Homepage

Response:
{
  "thought_process": [
    {
      "step": 1,
      "thought": "Pricing is usually in the footer or under a 'Pricing' link. I should first look for a direct Pricing link in the navigation.",
      "action": "Look for Pricing link in navigation",
      "expected_observation": "Either find Pricing link or need to scroll"
    },
    {
      "step": 2,
      "thought": "If Pricing link is visible, click it. If not, scroll down to find it.",
      "action": "Click Pricing link or scroll down",
      "expected_observation": "Navigate to pricing page or see more content"
    },
    {
      "step": 3,
      "thought": "Once on pricing page, I may need to scroll to see all pricing tiers.",
      "action": "Scroll to view all pricing information",
      "expected_observation": "All pricing tiers are visible"
    }
  ],
  "actions": [
    {"type": "click", "target": "Pricing link in navigation", "value": ""},
    {"type": "wait", "target": "page", "value": "2"},
    {"type": "scroll", "target": "page", "value": "down 3"}
  ],
  "contingency_plan": "If no Pricing link found, scroll to footer and look for pricing information there"
}

=== YOUR TURN ===

User Goal: "{user_goal}"
Current Page: {page_url}
Previous Actions: {action_history}
Screenshot: [attached]

Generate your planning response:
```

---

## 7. Technique 5: Hierarchical Planning

### Concept
Break complex tasks into high-level goals → sub-goals → atomic actions.

### Hierarchical Planning Prompt

```
You are a hierarchical web automation planner. Decompose tasks into multiple levels.

=== HIERARCHY LEVELS ===

Level 1 - TASK: The overall user goal
Level 2 - PHASES: Major phases to complete the task
Level 3 - SUBTASKS: Specific subtasks within each phase
Level 4 - ACTIONS: Individual browser actions

=== OUTPUT FORMAT ===

{
  "task": "User's overall goal",
  "phases": [
    {
      "phase_name": "Name of this phase",
      "phase_goal": "What this phase accomplishes",
      "subtasks": [
        {
          "subtask_name": "Name of subtask",
          "actions": [
            {
              "action_type": "click|type|scroll|wait|dismiss",
              "target": "Element to interact with",
              "value": "Value if applicable",
              "reasoning": "Why this action is needed"
            }
          ]
        }
      ]
    }
  ],
  "flat_action_sequence": [
    // All actions flattened into execution order
    {"action_type": "...", "target": "...", "reasoning": "..."}
  ]
}

=== EXAMPLE ===

Task: "Complete a purchase on an e-commerce site"

Response:
{
  "task": "Complete a purchase on an e-commerce site",
  "phases": [
    {
      "phase_name": "Product Selection",
      "phase_goal": "Find and select the desired product",
      "subtasks": [
        {
          "subtask_name": "Browse products",
          "actions": [
            {"action_type": "scroll", "target": "product list", "value": "down 2", "reasoning": "View more products"},
            {"action_type": "click", "target": "Product: Wireless Headphones", "reasoning": "Select product to view details"}
          ]
        }
      ]
    },
    {
      "phase_name": "Add to Cart",
      "phase_goal": "Add selected product to shopping cart",
      "subtasks": [
        {
          "subtask_name": "Configure and add product",
          "actions": [
            {"action_type": "click", "target": "Color: Black option", "reasoning": "Select product color"},
            {"action_type": "click", "target": "Add to Cart button", "reasoning": "Add product to cart"},
            {"action_type": "wait", "target": "page", "value": "1", "reasoning": "Wait for confirmation"}
          ]
        }
      ]
    },
    {
      "phase_name": "Checkout",
      "phase_goal": "Complete the purchase",
      "subtasks": [
        {
          "subtask_name": "Proceed to checkout",
          "actions": [
            {"action_type": "click", "target": "Cart icon", "reasoning": "View cart"},
            {"action_type": "click", "target": "Proceed to Checkout button", "reasoning": "Start checkout"}
          ]
        }
      ]
    }
  ],
  "flat_action_sequence": [
    {"action_type": "scroll", "target": "product list", "value": "down 2", "reasoning": "View more products"},
    {"action_type": "click", "target": "Product: Wireless Headphones", "reasoning": "Select product to view details"},
    {"action_type": "click", "target": "Color: Black option", "reasoning": "Select product color"},
    {"action_type": "click", "target": "Add to Cart button", "reasoning": "Add product to cart"},
    {"action_type": "wait", "target": "page", "value": "1", "reasoning": "Wait for confirmation"},
    {"action_type": "click", "target": "Cart icon", "reasoning": "View cart"},
    {"action_type": "click", "target": "Proceed to Checkout button", "reasoning": "Start checkout"}
  ]
}

=== YOUR TASK ===
Task: "{user_goal}"
Current Page: {page_description}
Screenshot: [attached]

Generate hierarchical plan:
```

---

## 8. Technique 6: Model-Specific Prompting

### Gemini-Specific Techniques

Based on research, Gemini has specific behaviors:

1. **Function calling returns multiple parts** - Gemini CAN return multiple function calls in parallel
2. **Prefers explicit instructions** - Be very direct about wanting multiple actions
3. **XML tags work well** - Use clear delimiters

### Gemini-Optimized Prompt

```
<system>
You are a web automation agent powered by Gemini. Your goal is to complete user tasks by generating sequences of browser actions.
</system>

<instructions>
CRITICAL: You MUST return MULTIPLE actions when the task requires more than one step.

Examples of multi-step tasks:
- Finding information that requires scrolling
- Completing forms with multiple fields
- Navigating through multiple pages
- Handling popups before main task

You can return UP TO 25 actions in a single response.
</instructions>

<action_space>
- click(element): Click on an interactive element
- type(element, text): Type text into an input field
- scroll(direction, amount): Scroll the page (e.g., "down 5")
- wait(seconds): Wait for page to load
- dismiss(element): Close popups/modals
- navigate(url): Navigate to a URL
- submit(element): Submit a form
</action_space>

<output_format>
Return ONLY a JSON object with this exact structure:
{
  "analysis": "Brief analysis of current state",
  "actions": [
    {
      "action": "click|type|scroll|wait|dismiss|navigate|submit",
      "target": "Element description with visible text",
      "value": "Text to type or scroll amount",
      "reasoning": "Why this action is necessary"
    }
  ],
  "expected_result": "What will happen after all actions execute"
}
</output_format>

<user_task>
Goal: {user_goal}
URL: {current_url}
Screenshot: [attached]
</user_task>

<response>
```

### GPT-4V/Claude-Specific Techniques

```
System: You are an autonomous web browsing agent. Follow these rules EXACTLY:

1. ALWAYS generate the COMPLETE action sequence needed for the task
2. Return 1-25 actions depending on complexity
3. Use the provided JSON schema
4. Include reasoning for EACH action

Persistence Rule: Keep going until the task is complete. Do not stop after one action.

Tool Use Rule: Use browser actions extensively. Do NOT guess or make up answers.

Planning Rule: Plan extensively before generating actions. Think through all necessary steps.
```

---

## 9. Before/After Examples

### BEFORE (Single-Action Problem)

**User Prompt:**
```
Complete the task on this webpage. You can use up to 25 actions.
Goal: Find the contact information at the bottom of the page
```

**Model Response (Gemini):**
```json
{
  "actions": [
    {"action": "submit_code", "code": "document.querySelector('footer').scrollIntoView()"}
  ]
}
```

**Problem:** Only 1 action, wrong action type (submit_code instead of scroll), no reasoning.

---

### AFTER (Multi-Action Solution)

**User Prompt (with structured schema + few-shot):**
```
You are a web automation agent. Generate MULTIPLE actions to complete tasks.

=== OUTPUT FORMAT (JSON) ===
{
  "analysis": "Your understanding of the task",
  "actions": [
    {"action": "click|type|scroll|wait|dismiss", "target": "...", "value": "...", "reasoning": "..."}
  ],
  "expected_outcome": "..."
}

=== EXAMPLE ===
Goal: "Find information at the bottom of the page"
Response: {
  "analysis": "Need to scroll down to reach footer content",
  "actions": [
    {"action": "scroll", "target": "page", "value": "down 5", "reasoning": "Scroll to footer"},
    {"action": "wait", "target": "page", "value": "1", "reasoning": "Allow content to load"}
  ],
  "expected_outcome": "Footer with information is visible"
}

=== YOUR TASK ===
Goal: Find the contact information at the bottom of the page
Screenshot: [attached]
```

**Model Response:**
```json
{
  "analysis": "The current view shows the top of the page with navigation. Contact information is typically in the footer section which is below the current viewport.",
  "actions": [
    {"action": "scroll", "target": "page", "value": "down 5", "reasoning": "Scroll down to reach the footer section where contact info is typically located"},
    {"action": "wait", "target": "page", "value": "1", "reasoning": "Allow any lazy-loaded footer content to appear"},
    {"action": "scroll", "target": "page", "value": "down 3", "reasoning": "Continue scrolling to ensure footer is fully visible"},
    {"action": "click", "target": "Contact Us link in footer", "reasoning": "Navigate to dedicated contact page for complete information"}
  ],
  "expected_outcome": "Contact page with email, phone, and address information is displayed"
}
```

**Improvement:** 4 actions with clear reasoning, appropriate action types, proper sequence.

---

## 10. Complete TypeScript/Node.js Implementation

### Full Implementation Example

```typescript
// browser-automation-agent.ts

import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

// ============================================
// TYPES
// ============================================

interface BrowserAction {
  action: "click" | "type" | "scroll" | "wait" | "dismiss" | "navigate" | "submit";
  target: string;
  value?: string;
  reasoning: string;
}

interface AgentResponse {
  analysis: string;
  actions: BrowserAction[];
  expected_outcome: string;
}

interface AgentConfig {
  provider: "gemini" | "openai" | "claude";
  apiKey: string;
  model?: string;
  maxActions?: number;
}

// ============================================
// PROMPT BUILDER
// ============================================

class PromptBuilder {
  private maxActions: number;

  constructor(maxActions: number = 25) {
    this.maxActions = maxActions;
  }

  buildSystemPrompt(): string {
    return `You are an autonomous web browsing agent. Your goal is to complete user tasks by generating sequences of browser actions.

CRITICAL INSTRUCTIONS:
1. ALWAYS generate MULTIPLE actions when the task requires more than one step
2. You can return 1-${this.maxActions} actions depending on task complexity
3. Return actions as a JSON array with the exact format specified
4. Include reasoning for EACH action explaining why it's necessary
5. Consider: scrolling, popups, loading states, form fields, navigation

ACTION SPACE:
- click(element): Click on an interactive element
- type(element, text): Type text into an input field  
- scroll(direction, amount): Scroll page (e.g., "down 5")
- wait(seconds): Wait for page to load
- dismiss(element): Close popups/modals
- navigate(url): Navigate to URL
- submit(element): Submit a form

EXAMPLES OF MULTI-STEP TASKS:
- Finding information: scroll → wait → click → wait
- Form completion: type → type → click → type → submit
- E-commerce: click → wait → click → scroll → click
- With popups: dismiss → wait → click → wait

PERSISTENCE RULE: Keep generating actions until the task is complete. Do not stop prematurely.`;
  }

  buildFewShotExamples(): string {
    return `
=== EXAMPLE 1: Simple Multi-Step ===
Goal: "Click the login button"
Response: {
  "analysis": "Login button is visible in the top navigation",
  "actions": [
    {"action": "click", "target": "Login button", "reasoning": "Navigate to login page"}
  ],
  "expected_outcome": "Login form appears"
}

=== EXAMPLE 2: Scrolling Required ===
Goal: "Find the contact information"
Response: {
  "analysis": "Contact information is in the footer, below current viewport",
  "actions": [
    {"action": "scroll", "target": "page", "value": "down 5", "reasoning": "Scroll to footer section"},
    {"action": "wait", "target": "page", "value": "1", "reasoning": "Allow footer to load"},
    {"action": "click", "target": "Contact link", "reasoning": "Navigate to contact page"}
  ],
  "expected_outcome": "Contact page with information is displayed"
}

=== EXAMPLE 3: Form Completion ===
Goal: "Fill out the search form"
Response: {
  "analysis": "Search form has multiple fields that need to be filled",
  "actions": [
    {"action": "type", "target": "Search input", "value": "laptops", "reasoning": "Enter search term"},
    {"action": "click", "target": "Category dropdown", "reasoning": "Open category selector"},
    {"action": "click", "target": "Electronics option", "reasoning": "Select Electronics category"},
    {"action": "click", "target": "Search button", "reasoning": "Submit search form"},
    {"action": "wait", "target": "page", "value": "2", "reasoning": "Wait for search results"}
  ],
  "expected_outcome": "Search results page with laptops in Electronics category"
}`;
  }

  buildUserPrompt(goal: string, screenshotBase64: string, url: string, actionHistory: BrowserAction[] = []): any[] {
    const historyContext = actionHistory.length > 0 
      ? `\nPrevious actions: ${JSON.stringify(actionHistory)}`
      : "";

    const promptText = `Complete the following task by generating a sequence of browser actions.

GOAL: ${goal}
CURRENT URL: ${url}${historyContext}

Analyze the screenshot and generate ALL necessary actions to complete the task. Return your response in the exact JSON format shown in the examples.

YOUR RESPONSE (JSON only):`;

    return [
      { type: "text", text: promptText },
      { 
        type: "image_url", 
        image_url: { 
          url: `data:image/png;base64,${screenshotBase64}` 
        } 
      }
    ];
  }
}

// ============================================
// JSON SCHEMA
// ============================================

const ActionSchema = {
  type: "object",
  properties: {
    analysis: {
      type: "string",
      description: "Brief analysis of current state and what needs to be done"
    },
    actions: {
      type: "array",
      minItems: 1,
      maxItems: 25,
      description: "Array of browser actions to execute",
      items: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["click", "type", "scroll", "wait", "dismiss", "navigate", "submit"],
            description: "Type of browser action"
          },
          target: {
            type: "string",
            description: "Description of the element to interact with"
          },
          value: {
            type: "string",
            description: "Value for type/scroll/wait actions"
          },
          reasoning: {
            type: "string",
            description: "Why this action is necessary"
          }
        },
        required: ["action", "target", "reasoning"]
      }
    },
    expected_outcome: {
      type: "string",
      description: "What the page will look like after all actions"
    }
  },
  required: ["analysis", "actions", "expected_outcome"]
};

// ============================================
// AGENT IMPLEMENTATION
// ============================================

class BrowserAutomationAgent {
  private config: AgentConfig;
  private promptBuilder: PromptBuilder;

  constructor(config: AgentConfig) {
    this.config = config;
    this.promptBuilder = new PromptBuilder(config.maxActions || 25);
  }

  async generateActions(
    goal: string, 
    screenshotBase64: string, 
    url: string,
    actionHistory: BrowserAction[] = []
  ): Promise<AgentResponse> {
    switch (this.config.provider) {
      case "gemini":
        return this.generateWithGemini(goal, screenshotBase64, url, actionHistory);
      case "openai":
        return this.generateWithOpenAI(goal, screenshotBase64, url, actionHistory);
      case "claude":
        return this.generateWithClaude(goal, screenshotBase64, url, actionHistory);
      default:
        throw new Error(`Unknown provider: ${this.config.provider}`);
    }
  }

  private async generateWithGemini(
    goal: string, 
    screenshotBase64: string, 
    url: string,
    actionHistory: BrowserAction[]
  ): Promise<AgentResponse> {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(this.config.apiKey);

    const model = genAI.getGenerativeModel({
      model: this.config.model || "gemini-2.0-flash-exp",
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: ActionSchema,
        temperature: 0.2, // Lower temperature for more consistent output
      },
    });

    const systemPrompt = this.promptBuilder.buildSystemPrompt();
    const fewShotExamples = this.promptBuilder.buildFewShotExamples();
    const userPrompt = this.promptBuilder.buildUserPrompt(goal, screenshotBase64, url, actionHistory);

    const chat = model.startChat({
      history: [
        { role: "user", parts: [{ text: systemPrompt + fewShotExamples }] },
        { role: "model", parts: [{ text: "I understand. I will generate multiple actions as JSON when needed." }] },
      ],
    });

    const result = await chat.sendMessage(userPrompt);
    const responseText = result.response.text();
    
    return this.parseResponse(responseText);
  }

  private async generateWithOpenAI(
    goal: string, 
    screenshotBase64: string, 
    url: string,
    actionHistory: BrowserAction[]
  ): Promise<AgentResponse> {
    const openai = new OpenAI({ apiKey: this.config.apiKey });

    const systemPrompt = this.promptBuilder.buildSystemPrompt() + this.promptBuilder.buildFewShotExamples();
    const userPrompt = this.promptBuilder.buildUserPrompt(goal, screenshotBase64, url, actionHistory);

    const response = await openai.chat.completions.create({
      model: this.config.model || "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt as any }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "browser_actions",
          strict: true,
          schema: ActionSchema as any
        }
      },
      temperature: 0.2,
    });

    const responseText = response.choices[0].message.content || "{}";
    return this.parseResponse(responseText);
  }

  private async generateWithClaude(
    goal: string, 
    screenshotBase64: string, 
    url: string,
    actionHistory: BrowserAction[]
  ): Promise<AgentResponse> {
    const anthropic = new Anthropic({ apiKey: this.config.apiKey });

    const systemPrompt = this.promptBuilder.buildSystemPrompt() + this.promptBuilder.buildFewShotExamples();
    const userPrompt = this.promptBuilder.buildUserPrompt(goal, screenshotBase64, url, actionHistory);

    const response = await anthropic.messages.create({
      model: this.config.model || "claude-3-5-sonnet-20241022",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        { role: "user", content: userPrompt as any }
      ],
      temperature: 0.2,
    });

    // Extract text from Claude's response
    const content = response.content[0];
    const responseText = content.type === "text" ? content.text : "{}";
    
    return this.parseResponse(responseText);
  }

  private parseResponse(responseText: string): AgentResponse {
    try {
      // Try to extract JSON if wrapped in markdown
      const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/) || 
                        responseText.match(/```\s*([\s\S]*?)\s*```/) ||
                        [null, responseText];
      
      const jsonStr = jsonMatch[1] || responseText;
      const parsed = JSON.parse(jsonStr);

      // Validate structure
      if (!parsed.actions || !Array.isArray(parsed.actions)) {
        throw new Error("Invalid response: missing actions array");
      }

      return {
        analysis: parsed.analysis || "",
        actions: parsed.actions,
        expected_outcome: parsed.expected_outcome || ""
      };
    } catch (error) {
      console.error("Failed to parse agent response:", error);
      console.error("Raw response:", responseText);
      
      // Return fallback single action
      return {
        analysis: "Failed to parse response",
        actions: [{ 
          action: "wait", 
          target: "page", 
          value: "1",
          reasoning: "Error parsing response, waiting for stability" 
        }],
        expected_outcome: "System stable"
      };
    }
  }
}

// ============================================
// USAGE EXAMPLE
// ============================================

async function main() {
  // Initialize agent with Gemini
  const agent = new BrowserAutomationAgent({
    provider: "gemini",
    apiKey: process.env.GEMINI_API_KEY!,
    model: "gemini-2.0-flash-exp",
    maxActions: 25
  });

  // Generate actions for a task
  const screenshotBase64 = "..."; // Your screenshot
  const result = await agent.generateActions(
    "Find the pricing information at the bottom of the page",
    screenshotBase64,
    "https://example.com"
  );

  console.log("Analysis:", result.analysis);
  console.log("Number of actions:", result.actions.length);
  console.log("Actions:", JSON.stringify(result.actions, null, 2));
  console.log("Expected outcome:", result.expected_outcome);
}

export { BrowserAutomationAgent, PromptBuilder, AgentResponse, BrowserAction };
```

---

## 11. Additional Tips & Best Practices

### 1. Temperature Settings
- Use **low temperature (0.1-0.3)** for consistent multi-action output
- Higher temperatures increase variability but may reduce reliability

### 2. Retry Logic
```typescript
async function generateWithRetry(
  agent: BrowserAutomationAgent,
  goal: string,
  screenshot: string,
  url: string,
  maxRetries: number = 3
): Promise<AgentResponse> {
  for (let i = 0; i < maxRetries; i++) {
    const result = await agent.generateActions(goal, screenshot, url);
    
    // Check if we got multiple actions
    if (result.actions.length > 1 || isSimpleTask(goal)) {
      return result;
    }
    
    // Retry with stronger prompt
    console.log(`Retry ${i + 1}: Got only ${result.actions.length} action(s)`);
  }
  
  throw new Error("Failed to generate multi-action plan");
}
```

### 3. Action Validation
```typescript
function validateActions(actions: BrowserAction[]): boolean {
  // Check for common issues
  for (const action of actions) {
    if (!action.action || !action.target || !action.reasoning) {
      return false;
    }
    
    // Type-specific validation
    if (action.action === "type" && !action.value) {
      return false;
    }
    
    if (action.action === "scroll" && !action.value) {
      return false;
    }
  }
  
  return true;
}
```

### 4. Progressive Enhancement
Start simple and add complexity:
1. First: Structured JSON schema (biggest impact)
2. Then: Few-shot examples
3. Then: ReAct-style reasoning
4. Finally: Hierarchical planning for complex tasks

---

## 12. Summary

| Technique | Impact | Effort | When to Use |
|-----------|--------|--------|-------------|
| Structured JSON Schema | ⭐⭐⭐⭐⭐ | Medium | Always - forces array output |
| Few-Shot Examples | ⭐⭐⭐⭐ | Low | When model doesn't understand format |
| Plan-Then-Execute | ⭐⭐⭐⭐ | Low | Complex multi-step tasks |
| ReAct Prompting | ⭐⭐⭐ | Medium | When reasoning transparency is needed |
| Hierarchical Planning | ⭐⭐⭐⭐ | Medium | Very complex tasks with phases |
| Model-Specific Tuning | ⭐⭐⭐ | Low | Fine-tuning for specific providers |

### Quick Start Recommendation

1. **Start with Structured JSON Schema** - This alone should solve 80% of the single-action problem
2. **Add 3-5 few-shot examples** - Show the model what multi-action output looks like
3. **Use explicit instructions** - "Generate ALL necessary actions" not "up to N actions"
4. **Set temperature to 0.2** - Consistent output
5. **Validate and retry** - If you get single action, retry with stronger prompt

---

## References

1. WebArena: A Realistic Web Environment for Building Autonomous Agents
2. SeeAct: GPT-4V(ision) is a Generalist Web Agent, if Grounded
3. WebVoyager: Building an End-to-End Web Agent with Large Multimodal Models
4. EconWebArena: Benchmarking Autonomous Agents on Economic Tasks
5. On the Fine-Grained Planning Abilities of VLM Web Agents
6. ReAct: Synergizing Reasoning and Acting in Language Models (Yao et al., 2022)
7. Plan-and-Execute Agents (LangGraph)
8. HiPlan: Hierarchical Planning for LLM-Based Agents
9. BrowserGym & AgentLab Framework
10. WebAgent-R1: Training Web Agents via End-to-End Reinforcement Learning
