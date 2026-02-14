# Quick Reference: Fixing Single-Action Output Problem

## The Problem
Gemini returns only 1 action (usually `submit_code`) instead of multi-step plans like:
```
scroll down 5 times → dismiss popup → click green button
```

## The Solution (Ranked by Impact)

### 1. USE STRUCTURED JSON SCHEMA (⭐⭐⭐⭐⭐ HIGHEST IMPACT)

**Before:**
```
Complete the task. You can use up to 25 actions.
Goal: Find contact information
```
Result: `{"actions": [{"action": "submit_code", "code": "..."}]}`

**After:**
```typescript
const schema = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      minItems: 1,
      maxItems: 25,  // Forces array structure
      items: { /* action definition */ }
    }
  }
};
```
Result: `{"actions": [{...}, {...}, {...}]}` ← Multiple actions!

---

### 2. ADD FEW-SHOT EXAMPLES (⭐⭐⭐⭐ HIGH IMPACT)

**Add 3-5 examples showing multi-action output:**

```
=== EXAMPLE: Scrolling Required ===
Goal: "Find contact information"
Response: {
  "actions": [
    {"action": "scroll", "target": "page", "value": "down 5"},
    {"action": "wait", "target": "page", "value": "1"},
    {"action": "click", "target": "Contact link"}
  ]
}
```

---

### 3. USE EXPLICIT INSTRUCTIONS (⭐⭐⭐ MEDIUM IMPACT)

**Before:**
```
You can use up to 25 actions.
```

**After:**
```
CRITICAL: ALWAYS generate MULTIPLE actions when needed.
You MUST return 1-25 actions depending on task complexity.
Generate ALL necessary actions in ONE response.
```

---

### 4. SET LOW TEMPERATURE (⭐⭐⭐ MEDIUM IMPACT)

```typescript
temperature: 0.2  // More consistent, predictable output
```

---

## Quick Implementation (Gemini)

```typescript
import { GoogleGenerativeAI } from "@google/generative-ai";

const schema = {
  type: "object",
  properties: {
    analysis: { type: "string" },
    actions: {
      type: "array",
      minItems: 1,
      maxItems: 25,  // KEY: Forces array output
      items: {
        type: "object",
        properties: {
          action: { 
            type: "string", 
            enum: ["click", "type", "scroll", "wait", "dismiss"] 
          },
          target: { type: "string" },
          value: { type: "string" },
          reasoning: { type: "string" }
        },
        required: ["action", "target", "reasoning"]
      }
    }
  }
};

const model = genAI.getGenerativeModel({
  model: "gemini-2.0-flash-exp",
  generationConfig: {
    responseMimeType: "application/json",
    responseSchema: schema,
    temperature: 0.2,
  },
});
```

---

## Quick Implementation (OpenAI/GPT-4V)

```typescript
const response = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: [textPrompt, screenshot] }
  ],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "browser_actions",
      strict: true,
      schema: schema
    }
  },
  temperature: 0.2,
});
```

---

## Before/After Comparison

| Aspect | Before | After |
|--------|--------|-------|
| Output | 1 action | 4-8 actions |
| Type | `submit_code` | `scroll`, `click`, `wait` |
| Reasoning | None | Each action has reasoning |
| Completeness | Incomplete | Full task plan |

---

## Common Mistakes to Avoid

❌ **"You can use up to 25 actions"**
→ Model interprets as "maximum, not required"

✅ **"Generate ALL necessary actions (1-25)"**
→ Model understands to output multiple

❌ **Free-form text output**
→ Model defaults to simplest response

✅ **Structured JSON with array schema**
→ Forces multiple action output

❌ **No examples**
→ Model doesn't know expected format

✅ **3-5 few-shot examples**
→ Model learns from examples

---

## Debugging Tips

1. **If still getting 1 action:**
   - Check schema has `minItems: 1` and `maxItems: 25`
   - Verify `type: "array"` is set
   - Add explicit "Generate multiple actions" instruction

2. **If actions are wrong type:**
   - Use `enum` to restrict action types
   - Add examples with correct action types

3. **If model ignores instructions:**
   - Use ALL CAPS for critical instructions
   - Repeat key instructions multiple times
   - Add examples demonstrating desired behavior

---

## Expected Results

**Input:** "Find contact information at the bottom of the page"

**Before:**
```json
{
  "actions": [
    {"action": "submit_code", "code": "document.querySelector('footer').scrollIntoView()"}
  ]
}
```

**After:**
```json
{
  "analysis": "Contact info is in footer, need to scroll down",
  "actions": [
    {"action": "scroll", "target": "page", "value": "down 5", "reasoning": "Scroll to footer"},
    {"action": "wait", "target": "page", "value": "1", "reasoning": "Allow footer to load"},
    {"action": "click", "target": "Contact link", "reasoning": "Navigate to contact page"},
    {"action": "wait", "target": "page", "value": "2", "reasoning": "Wait for page load"}
  ],
  "expected_outcome": "Contact page is displayed"
}
```

---

## Files in This Package

1. `vlm_browser_automation_prompting_research.md` - Full research report
2. `prompt_templates.js` - Ready-to-use prompt templates
3. `quick_reference.md` - This quick reference guide

---

## Next Steps

1. Start with **Structured JSON Schema** (biggest impact)
2. Add **few-shot examples** (shows expected format)
3. Use **low temperature** (consistent output)
4. Implement **retry logic** (handle edge cases)
5. Add **validation** (ensure action quality)
