# Codex Task: Evaluate and Implement Vision Browser Agent Architecture Overhaul

## Your Mission

Read ALL the files listed below, understand the full project history and research, then:

1. **Evaluate** whether the proposed architecture (below) is the right direction or if the research suggests something better
2. **Propose** any changes or alternative approaches you think would work better, with reasoning
3. **Implement** the chosen architecture as changes to `src/agent.ts` and `src/gemini.ts` (and any new files needed)

This is a critical decision point. We've done extensive research and had multiple failed runs. We need you to synthesize everything and make the right architectural call.

---

## GitHub Repository

**Repo:** `https://github.com/lamb356/vision-agent` (branch: `master`)

Pull the latest code and read `src/agent.ts`, `src/gemini.ts`, and `src/index.ts` thoroughly before doing anything.

---

## Files to Read (LOCAL — all in the repo or provided below)

### Research Files (read ALL of these first)

These are research reports from Kimi 2.5 Agent Swarm and ChatGPT Deep Research on state-of-the-art browser automation agents:

**Kimi Research (in repo or provided separately):**
1. `comprehensive_browser_automation_research_report.md` — Covers WebVoyager, SeeAct, CogAgent, Agent-E, WILBUR, MindAct comparisons + ranked solutions for all 7 problems
2. `som_dom_research_report.md` — Set-of-Mark prompting research, SoM vs bbox performance (25.7% → 86.4% accuracy improvement)
3. `gemini_flash_browser_automation_research.md` — Gemini-specific structured output, responseSchema, thinking levels
4. `vlm_browser_automation_prompting_research.md` — VLM prompting patterns for multi-step plans
5. `multi_turn_agent_loops_error_recovery_report.md` — Loop structures, error recovery, backtracking
6. `robust_element_interaction_strategies.md` — Click fallback chains, overlay handling
7. `trap_decoy_detection_research.md` — Decoy identification heuristics
8. `quick_reference.md` — Summary of single-action fix (structured JSON schema)
9. `prompt_templates.js` — Ready-to-use prompt templates with few-shot examples
10. `code-extractor.ts` — Code extraction with CSS unit filtering
11. `decoy-detector.ts` — Multi-factor button scoring
12. `scroll_overlay_manager.ts` — Scroll strategy + overlay management
13. `robust_interaction_utils.ts` — Playwright interaction utilities
14. `agent_recovery_implementation_pseudocode.ts` — Recovery/backtracking pseudocode

**ChatGPT Deep Research Reports (the most important ones):**

15. `deep-research-report.md` — Comprehensive research covering:
    - State-of-the-art agents (WebVoyager, SeeAct, Agent-E, WILBUR, CogAgent, MindAct, AgentOccam)
    - SeeAct's two-stage decide→ground pipeline
    - Set-of-Mark vs raw coordinates (86.4% vs 25.7%)
    - Schema-enforced multi-step plans with minItems
    - Hit-test gating (elementsFromPoint) for blocked buttons
    - pointer-events:none shim instead of DOM deletion for overlays
    - Context-gated code extraction
    - Candidate narrowing (top-8 buttons, not all 40)
    - WILBUR loop detection + backtracking
    - Gemini Live API limitations (no responseSchema, 1 FPS, use function calling instead)
    - Learning/memory layer across runs (deterministic rules → vector DB → demo banks)

16. `Chat_gpt_research.md` — Speed optimization research covering:
    - One-action-per-turn is actually what SOTA agents do (not multi-action)
    - EconWebArena showed multi-action DECREASED success rate (46.9% → 41.9%)
    - Skill-based batching: LLM picks a skill, skill runs internally with cheap verification
    - Risk-stratified action batching (low/medium/high risk)
    - Postcondition-gated micro-batching with Tier-0/1/2/3 verification
    - Macro actions (scroll_search, dismiss_overlays as deterministic skills)
    - Confidence-weighted decisions for high-risk clicks
    - AgentOccam: remove scroll as a model action, handle it deterministically
    - Tree-Planner: plan sampling to avoid repeated prompt token tax
    - Quantitative batching model: E[time] = (t_o + t_m + K*t_a + (1-p_K)*t_r) / K
    - Gemini Live limitations confirmed (no schema, no logprobs in WebSocket API)

---

## Project History Summary

### What this is
Browser automation agent for Brett Adcock's $500k/year hiring challenge. 30 sequential steps on a single webpage. Must complete all 30 in under 10 minutes (~20s per step).

### Tech stack
- Playwright (headless Chromium) for browser control
- Google Gemini Flash (gemini-3-flash-preview) as vision model
- TypeScript/Node.js
- DOM snapshot extraction with element IDs (data-agent-eid), bounding boxes, visibility flags
- Screenshots sent alongside DOM snapshots for action planning

### What Step 1 actually looks like (from screenshot analysis)
- Page header: "Step 1 of 30 - Browser Navigation Challenge"
- Multiple sections (5-16+) with filler text: "Keep scrolling to find the navigation button"
- 25-40 decoy buttons: "Try This!", "Click Here", "Proceed", "Next Page", "Advance"
- Trap popups: "Wrong Button! Try Again!" (red), "You have won a prize!", "Alert!"
- Content blocks that lazy-load: "Content Block 2 Loaded! This content appeared 1500ms after page load"
- ONE correct navigation button hidden below the fold
- Input field for 6-char code + Submit button (used in later steps, visible but not needed for Step 1)

### Run history (all failed)
- **Run 1-14 (original architecture):** Got to 2/30 then 4/30, then regressed to 0/30 due to dismiss loops and selector bugs
- **Option B rewrite (commit 10eab70):** Complete rewrite with EID injection, skill system — 0/30 (digit filter bypassed, page stuck on step 1)
- **Scout overhaul (commit 5f6c1ef):** PRIMARY_SCOUT_PROMPT, bbox data, code validation — 0/30 (phantom code BJK5AQ submitted every step, scout returns only 1 action)
- **Phantom code fix (commit 83920d2):** extractVisibleCodes, repeat caps, JS click fallback — API key broken, untested but still extracting CSS values like "1500ms" as codes

### The 7 Critical Problems (from debugging)

**Problem 1: SINGLE-ACTION PLANS**
Despite asking for up to 25 actions, Gemini returns only 1 action (usually just submit_code with a wrong code). Research says this is expected — SOTA agents intentionally do one action per turn. The fix is macro skills, not forcing multi-action.

**Problem 2: PHANTOM CODE EXTRACTION**
CSS values like "1500ms", "1179px", "1981px" match the 6-char alphanumeric regex. These get submitted as codes, waste time, and never work. Also "BJK5AQ" from hidden DOM attributes.

**Problem 3: SUBMIT BUTTON BLOCKED**
Submit button E016 consistently covered by overlays. Playwright click fails, JS click doesn't advance step, Enter fallback doesn't work. Need hit-test gating + pointer-events:none shim.

**Problem 4: DECOY BUTTON IDENTIFICATION**
25-40 buttons with similar labels. ONE correct button must be found visually. Page says "Keep scrolling to find the navigation button." Need candidate narrowing + SoM overlay.

**Problem 5: OVERLAY/POPUP MANAGEMENT**
Trap popups spawn constantly. DOM deletion is dangerous (can remove important elements). Need reversible CSS-based approach (pointer-events:none).

**Problem 6: SCROLL STRATEGY**
Long page, content hidden below fold. Agent needs deterministic scroll-search skill, not LLM-driven scrolling.

**Problem 7: PAGE STATE STAGNATION**
Agent stuck on Step 1 for all attempts. Same actions repeated. No loop detection, no strategy switching, no memory of failures.

---

## Proposed New Architecture (based on research synthesis)

### Core Principle: SKILL-BASED ARCHITECTURE
Research consensus: Don't make the VLM return multi-action plans. Make it pick ONE skill per turn. Skills execute internally with cheap verification. This is what Agent-E, AgentOccam, and the speed research all converge on.

### The Loop (one Gemini call per skill invocation)

```
1. OBSERVE
   - Take screenshot (viewport only, JPEG, moderate quality)
   - Capture lightweight DOM snapshot (visible elements only, with hit-test metadata)
   - Draw SoM overlay on screenshot (EID labels at element bounding boxes)
   - Compute change observation from previous state
   - Check step counter, code presence, overlay count

2. DECIDE (one Gemini call)
   - Send: SoM-annotated screenshot + compact DOM summary + change observation + step history
   - Gemini returns: { skill: "scroll_search" | "dismiss_overlays" | "click_candidate" | "submit_code" | "explore", params: {...}, reasoning: "..." }
   - Use responseSchema with responseMimeType: "application/json" to enforce structure

3. EXECUTE SKILL (no Gemini calls — deterministic with Tier-0/1 verification)
   Each skill runs internally:

   scroll_search:
     - Scroll 0.8 viewport height
     - After each scroll: check for new candidates, code appearance, bottom reached
     - Stop when: target-like element found, code visible, or bottom reached
     - Max 15 scrolls

   dismiss_overlays:
     - Hit-test all overlay candidates (fixed/absolute, high z-index, large viewport coverage)
     - Try semantic close (click Close/X/Escape)
     - If blocked: apply pointer-events:none to overlay root (reversible, not DOM deletion)
     - Verify overlay removed

   click_candidate:
     - Gemini provides target EID from top-8 candidates shown in SoM screenshot
     - Hit-test: is target topmost at center? If not, run dismiss_overlays first
     - Click with Playwright
     - Verify: did step advance? Did page change?

   submit_code:
     - Validate code: not a CSS unit, not in triedCodes, contains digit + letter
     - Context-gate: code must be near "enter code" text or code input field
     - Type into input, click submit (with hit-test gating)
     - Verify step advanced

   explore:
     - When stuck (same state 3+ times): try different strategy
     - Scroll to top and rescan
     - Try clicking elements not yet tried
     - Switch from main page scroll to container scroll

4. VERIFY (cheap, no Gemini)
   - Tier 0: DOM checks (step counter, code presence, overlay count, scroll position)
   - Tier 1: Hit-test + geometry (element topmost, bbox valid, stable)
   - If step advanced → next step
   - If skill succeeded but step didn't advance → loop back to OBSERVE
   - If skill failed + same state 3 times → add "stuck" signal to next OBSERVE

5. LOOP DETECTION + MEMORY
   - Track: actions taken, outcomes, codes tried, elements clicked
   - If same state hash seen 3+ times → force strategy switch
   - Persist across steps: false positive codes, overlay selectors, decoy button patterns
```

### SoM (Set-of-Mark) Implementation
- Use `sharp` npm package to overlay EID labels on screenshots before sending to Gemini
- Draw small colored rectangles with EID text at top-left of each element's bbox
- Only label visible, in-viewport elements (top ~20 by relevance)
- This lets Gemini see "E016" in the image AND in the DOM data = reliable grounding

### Code Extraction Fix
- Reject any code matching: `/^\d+[a-z]{1,3}$/i` (digits + short unit suffix like "1500ms", "1179px")
- Reject codes ending with: px, ms, pt, em, rem, vh, vw, deg, ch, cm, mm, in, ex, s
- Reject hex color patterns: `/^#?[0-9a-fA-F]{6}$/`
- Only accept codes from visible text (innerText), not DOM attributes
- Context-gate: code must appear near text containing "code", "enter", "submit", "verification"

### Overlay Strategy (reversible, not DOM deletion)
- Detect overlays: position fixed/sticky, z-index > 99, covers > 20% viewport
- Try semantic close first (click buttons matching Close/X/OK/Dismiss/No thanks/×)
- Try pressing Escape
- Fallback: `pointer-events: none` on overlay root (CSS change, reversible)
- NEVER delete DOM nodes (current nuclear removal approach is dangerous)

### Gemini API Usage
- Use `responseMimeType: "application/json"` + `responseSchema` for structured output
- Temperature: 0.3
- Thinking level: minimal (for speed)
- Single skill selection per call (not multi-action plans)
- Include 2-3 few-shot examples in system prompt showing skill selection for different page states

---

## What I Need From You (Codex)

1. **Read the entire codebase** (`src/agent.ts`, `src/gemini.ts`, `src/index.ts`, `package.json`, `tsconfig.json`)

2. **Read ALL research files listed above** (they're provided alongside this prompt)

3. **Evaluate the proposed architecture:**
   - Is skill-based + one-Gemini-call-per-turn the right approach?
   - Is SoM overlay worth implementing now or is it premature?
   - Should we keep ANY of the current code or start fresh?
   - Is there a simpler/faster path to getting Step 1 working?
   - What would YOU do differently based on the research?

4. **Produce a concrete implementation plan:**
   - Ordered list of changes with expected impact
   - Which changes can be made incrementally vs requiring rewrites
   - What to keep, what to throw away, what to add
   - Estimated complexity per change

5. **Implement the highest-impact changes:**
   - Focus on getting Step 1 passing first
   - Every change must compile (`npx tsc --noEmit`)
   - Include debug logging so we can diagnose the next run

### Constraints
- This must remain a **vision-first agent**. Screenshots are the primary input. DOM data is supplementary.
- Must use **Gemini Flash** (gemini-3-flash-preview) as the vision model
- Must use **Playwright** for browser control
- Must work in **headless mode**
- Target: complete 30 steps in under 10 minutes
- The challenge URL is: `https://serene-frangipane-7fd25b.netlify.app`

### Known Issue (not for you to fix)
The `.env` file has an API key issue — the GEMINI_API_KEY keeps loading an old invalid key. We'll fix this separately. Focus on the architecture and code changes.
