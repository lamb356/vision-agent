# Google Gemini Flash for Browser Automation - Research Report

## Executive Summary

This report provides comprehensive research on using Google Gemini Flash (specifically `gemini-3-flash-preview`) for browser automation tasks, addressing the user's specific problem of receiving only single-action outputs despite requesting up to 25 actions.

---

## 1. Gemini Flash Capability Assessment

### 1.1 Model Overview

| Model | Context Window | Output Tokens | Key Features |
|-------|---------------|---------------|--------------|
| **gemini-3-flash-preview** | 1,048,576 tokens | 59 tokens max | Thinking levels, structured output, tool use |
| **gemini-2.5-flash** | 1M tokens | 8,192 tokens | Stable, widely tested for browser automation |
| **gemini-3-pro-preview** | 1M tokens | 64K tokens | Higher reasoning, more expensive |

### 1.2 Vision Understanding Quality for UI Elements

**Strengths:**
- Gemini 2.5 Flash achieved **82% accuracy in position detection** and **100% element selection** in comparative studies
- Gemini 3 Flash shows **69.1% spatial reasoning** vs Gemini 2.5 Pro's 11.4% for UI recognition
- Native multimodal architecture - trained from ground up on text + images
- Supports pixel-level operations with normalized coordinates (0-1000 range)

**Limitations:**
- Vision accuracy degrades with very long context sessions
- May hallucinate UI elements when thinking mode is enabled for complex reasoning
- Bounding box coordinates can be offset after image processing

### 1.3 Token Costs for Images

| Resolution | Gemini 2.0 | Gemini 2.5 | Gemini 3 |
|------------|------------|------------|----------|
| Small (≤384px) | 258 tokens | 258 tokens | 64-258 tokens |
| Medium | 516-774 tokens | 516-774 tokens | ~258-512 tokens |
| High | 1032+ tokens | 1032+ tokens | ~512-1120 tokens |

**Critical Finding:** A screenshot at 1122x555 pixels with medium media resolution consumes approximately **2,322 tokens** per image in practice, significantly higher than documentation suggests.

---

## 2. The Single-Action Problem - Root Causes & Solutions

### 2.1 Why Gemini Returns Only 1 Action

Based on research, this is a **known behavioral pattern** with several contributing factors:

1. **Model Architecture**: Gemini Flash models are optimized for fast, single-turn responses rather than batch action generation
2. **Thinking Level Configuration**: Default "high" thinking mode may cause the model to over-analyze and consolidate actions
3. **Schema Description Issues**: Without explicit field descriptions in Pydantic schemas, Gemini defaults to minimal output
4. **Context Window Pressure**: When screenshots accumulate in history, the model compresses output to save tokens

### 2.2 Proven Solutions for Multi-Action Output

#### Solution A: Explicit Schema Descriptions (HIGHLY EFFECTIVE)

```python
from pydantic import BaseModel, Field

class BrowserAction(BaseModel):
    action_type: str = Field(
        ...,
        description="Type of action: click, type, scroll, wait, navigate"
    )
    element_index: int = Field(
        ...,
        description="Index of the element to interact with (0-99)"
    )
    value: str = Field(
        default="",
        description="Value to type or additional parameters"
    )

class ActionPlan(BaseModel):
    actions: list[BrowserAction] = Field(
        ...,
        description="List of actions to execute in sequence. Generate 5-25 actions to complete the task efficiently.",
        min_items=1,
        max_items=25
    )
    reasoning: str = Field(
        ...,
        description="Explain why these actions will achieve the goal"
    )
```

#### Solution B: Prompt Engineering Techniques

**1. The "Batch Directive" Approach:**
```
You are a browser automation agent. Your task is to generate MULTIPLE actions 
in a SINGLE response to complete tasks efficiently.

REQUIREMENTS:
- Generate 5-25 actions per response depending on task complexity
- Actions should be independent and executable in sequence
- Each action must include: action_type, element_index, and optional value
- Do NOT generate just one action - this is inefficient
```

**2. The "Efficiency Emphasis" Approach:**
```
CRITICAL: To minimize API calls and complete tasks quickly, you MUST output 
MULTIPLE actions in each response. Single-action responses will be considered 
a failure. Plan the entire sequence and output all actions at once.
```

**3. The "Thinking Override" Approach:**
```python
from google.genai import types

response = client.models.generate_content(
    model="gemini-3-flash-preview",
    contents=prompt,
    config=types.GenerateContentConfig(
        thinking_config=types.ThinkingConfig(thinking_level="minimal")
        # or "low" for faster, less conservative responses
    )
)
```

#### Solution C: Temperature and Sampling Adjustments

```python
config = types.GenerateContentConfig(
    temperature=0.7,  # Higher temperature encourages variety
    top_p=0.95,
    top_k=64,
    max_output_tokens=4096  # Ensure enough room for multiple actions
)
```

---

## 3. Structured Output Best Practices

### 3.1 JSON Schema Configuration

**Supported Schema Properties:**
- `type`, `properties`, `required`
- `items`, `minItems`, `maxItems`
- `enum`, `format`
- `minimum`, `maximum`
- `description` (critical for Gemini)
- `anyOf`, `oneOf`

**Critical Pattern for Arrays:**
```json
{
  "type": "object",
  "properties": {
    "actions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "action_type": {"type": "string"},
          "element_index": {"type": "integer"},
          "value": {"type": "string"}
        },
        "required": ["action_type", "element_index"]
      },
      "minItems": 1,
      "maxItems": 25,
      "description": "Generate multiple actions to complete the task efficiently"
    }
  },
  "required": ["actions"]
}
```

### 3.2 Response Parsing Strategy

```python
import json

def parse_gemini_response(response_text: str) -> dict:
    """Parse Gemini response with markdown code fence handling"""
    # Strip markdown code fences if present
    cleaned = response_text.strip()
    if cleaned.startswith("```json"):
        cleaned = cleaned[7:]
    if cleaned.startswith("```"):
        cleaned = cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    
    return json.loads(cleaned.strip())
```

### 3.3 Validation and Retry Logic

```python
from pydantic import ValidationError

def validate_actions(parsed_response: dict) -> list[BrowserAction]:
    try:
        plan = ActionPlan(**parsed_response)
        if len(plan.actions) < 2:
            # Retry with stronger prompt if only 1 action
            raise ValueError("Insufficient actions generated")
        return plan.actions
    except ValidationError as e:
        # Handle partial/malformed responses
        logger.error(f"Validation error: {e}")
        return []
```

---

## 4. Model Comparison for Browser Automation

### 4.1 Gemini 3 Flash vs Gemini 2.5 Flash

| Aspect | Gemini 3 Flash Preview | Gemini 2.5 Flash |
|--------|------------------------|------------------|
| **Speed** | Faster (Flash-level) | Fast |
| **Reasoning** | Configurable thinking levels | Fixed reasoning |
| **UI Accuracy** | 69.1% spatial reasoning | 82% position accuracy |
| **Stability** | Preview - occasional errors | Stable, production-ready |
| **Multi-action** | Requires prompt tuning | Similar behavior |
| **Cost** | $0.0000005/1K input | Slightly higher |

**Recommendation**: For production browser automation, consider **gemini-2.5-flash** for stability, or use **gemini-3-flash-preview** with `thinking_level="minimal"` for speed.

### 4.2 Comparison with Alternatives

| Model | Best For | Browser Auto Strength | Cost |
|-------|----------|----------------------|------|
| **Gemini 2.5 Flash** | Speed, multimodal | Good vision, fast | Low |
| **Gemini 3 Flash** | Agentic workflows | Better planning | Very Low |
| **GPT-4V** | Complex reasoning | Excellent UI understanding | High |
| **Claude 3.5 Sonnet** | Code generation | Good for DOM analysis | Medium |
| **Claude 3 Opus** | Complex planning | Best for multi-step | High |

**Key Finding**: Claude excels at planning and following complex instructions, while Gemini excels at speed and multimodal processing. For browser automation requiring both, consider a hybrid approach.

---

## 5. Known Limitations and Workarounds

### 5.1 Documented Issues

1. **"Internal Error" with Preview Models**
   - Affects Gemini 3 Pro and Flash Preview
   - Workaround: Toggle thinking levels or remove system instructions temporarily

2. **Thought Signature Errors**
   - Parallel function calls can cause 400 errors
   - Workaround: Disable parallel tool calling or handle signatures carefully

3. **Context Window Truncation**
   - Long chats lose earlier context
   - Workaround: Summarize history periodically, use external memory

4. **Single Function Call Bias**
   - Gemini 2.5 Pro sometimes returns only one tool call
   - Workaround: Use Gemini 2.5 Flash for parallel operations

### 5.2 Browser-Specific Quirks

| Issue | Workaround |
|-------|------------|
| Screenshot token bloat | Resize images to 1024px max width, use JPEG compression |
| Coordinate drift | Validate bounding boxes, use normalized coordinates |
| Consent overlay failures | Add helper functions to dismiss common banners |
| DOM selector brittleness | Use visual + DOM hybrid approach |

---

## 6. Implementation Guidance for Your Use Case

### 6.1 Recommended System Prompt

```python
SYSTEM_PROMPT = """<role>
You are an expert browser automation agent. Your goal is to complete web tasks efficiently by generating action sequences.
</role>

<capabilities>
- Analyze webpage screenshots and DOM elements
- Generate precise click, type, scroll, and navigation actions
- Plan multi-step sequences to achieve goals
</capabilities>

<critical_requirements>
1. GENERATE MULTIPLE ACTIONS: Output 5-25 actions per response depending on task complexity
2. SEQUENTIAL PLANNING: Actions should form a coherent sequence toward the goal
3. INDEPENDENT ACTIONS: Each action must be executable without waiting for intermediate results
4. EFFICIENCY: Minimize total API calls by batching actions
</critical_requirements>

<output_format>
Return a JSON object with:
- "actions": Array of action objects (REQUIRED, min 5 items)
- "reasoning": String explaining the plan (REQUIRED)
- "estimated_completion": Percentage of task completion (0-100)

Each action must have:
- "action_type": One of [click, type, scroll, navigate, wait, extract]
- "element_index": Integer index of target element
- "value": String value for type actions or additional params
</output_format>

<example>
Goal: "Search for 'laptops' and filter by price under $500"
{
  "actions": [
    {"action_type": "click", "element_index": 5, "value": ""},
    {"action_type": "type", "element_index": 5, "value": "laptops"},
    {"action_type": "click", "element_index": 12, "value": ""},
    {"action_type": "click", "element_index": 23, "value": ""},
    {"action_type": "click", "element_index": 45, "value": "$500"}
  ],
  "reasoning": "Click search box, type query, submit, click filters, set max price",
  "estimated_completion": 80
}
</example>

Remember: ALWAYS generate multiple actions. Single-action responses are unacceptable."""
```

### 6.2 Recommended Configuration

```python
from google import genai
from google.genai import types

client = genai.Client()

config = types.GenerateContentConfig(
    system_instruction=SYSTEM_PROMPT,
    temperature=0.4,  # Lower for more deterministic action generation
    top_p=0.95,
    top_k=40,
    max_output_tokens=4096,
    thinking_config=types.ThinkingConfig(
        thinking_level="minimal"  # or "low" for faster responses
    ),
    response_mime_type="application/json",
    response_schema={
        "type": "object",
        "properties": {
            "actions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "action_type": {"type": "string"},
                        "element_index": {"type": "integer"},
                        "value": {"type": "string"}
                    },
                    "required": ["action_type", "element_index"]
                },
                "minItems": 5,
                "maxItems": 25,
                "description": "Generate at least 5 actions to complete the task efficiently"
            },
            "reasoning": {"type": "string"},
            "estimated_completion": {"type": "integer", "minimum": 0, "maximum": 100}
        },
        "required": ["actions", "reasoning"]
    }
)
```

### 6.3 Execution Loop Pattern

```python
async def run_browser_agent(goal: str, max_steps: int = 50):
    actions_executed = []
    
    for step in range(max_steps):
        # Capture current state
        screenshot = await capture_screenshot()
        dom_elements = await extract_dom_elements()
        
        # Build prompt with state
        prompt = f"""
        <goal>{goal}</goal>
        <progress>{len(actions_executed)} actions executed so far</progress>
        <current_url>{await get_current_url()}</current_url>
        <available_elements>{format_elements(dom_elements)}</available_elements>
        <task>Generate the next batch of actions to progress toward the goal.</task>
        """
        
        # Call Gemini
        response = client.models.generate_content(
            model="gemini-3-flash-preview",
            contents=[prompt, screenshot],
            config=config
        )
        
        # Parse and validate
        try:
            result = parse_gemini_response(response.text)
            actions = validate_actions(result)
            
            if len(actions) < 2:
                # Retry with stronger emphasis
                prompt += "\n\n<reminder>CRITICAL: Generate at least 5 actions!</reminder>"
                continue
                
        except Exception as e:
            logger.error(f"Parse error: {e}")
            continue
        
        # Execute actions
        for action in actions:
            await execute_action(action)
            actions_executed.append(action)
            
        # Check completion
        if result.get("estimated_completion", 0) >= 100:
            break
    
    return actions_executed
```

---

## 7. Summary of Recommendations

### Immediate Fixes for Single-Action Problem

1. **Add explicit field descriptions** to your Pydantic schema - this is the #1 fix
2. **Set `thinking_level="minimal"`** for faster, less conservative responses
3. **Use `minItems` in your JSON schema** to enforce minimum action count
4. **Add explicit instructions** in the prompt about generating multiple actions
5. **Increase temperature slightly** (0.4-0.7) to encourage variety

### Long-term Architecture Improvements

1. **Consider model fallback**: Use Gemini 2.5 Flash if 3 Flash Preview is unstable
2. **Implement retry logic**: Detect single-action responses and retry with stronger prompts
3. **Use hybrid approach**: Claude for planning, Gemini for execution
4. **Add action validation**: Ensure minimum action count before execution
5. **Monitor token usage**: Screenshot accumulation causes context pressure

### Testing Checklist

- [ ] Schema has detailed field descriptions
- [ ] JSON schema includes `minItems` constraint
- [ ] System prompt explicitly requests multiple actions
- [ ] Thinking level is set to "minimal" or "low"
- [ ] Temperature is tuned (0.4-0.7 range)
- [ ] Retry logic handles single-action responses
- [ ] Screenshots are resized to reduce token usage

---

## References

1. [Gemini Structured Output Documentation](https://ai.google.dev/gemini-api/docs/structured-output)
2. [Gemini Thinking Configuration](https://ai.google.dev/gemini-api/docs/thinking)
3. [Browser-Use Gemini Issue #104](https://github.com/browser-use/browser-use/issues/104)
4. [Gemini 3 Prompt Best Practices](https://www.philschmid.de/gemini-3-prompt-practices)
5. [Gemini Token Documentation](https://ai.google.dev/gemini-api/docs/tokens)
6. [Gemini Function Calling Guide](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/function-calling)
7. [Gemini 2.5 Computer Use Best Practices](https://skywork.ai/blog/gemini-2-5-computer-use-best-practices-limitations-2025/)

---

*Report generated for browser automation research - Gemini Flash multi-action planning*
