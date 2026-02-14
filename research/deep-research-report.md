# Building a General-Purpose Vision-Based Browser Automation Agent for an Adversarial Long-Page Challenge

## Scope, constraints, and what "works" in modern browser agents

Your environment (a single long page with 30 sequential steps, heavy scrolling, decoy controls, recurring overlays, and code-entry gates) is unusually adversarial compared to the "form-filling on normal sites" regime assumed by many academic browser-agent benchmarks. That matters because (a) closed-loop re-observation after each action is usually required for reliability, and (b) adversarial UI interference (decoys, pop-ups, stacking-context click interception) is a principal failure source rather than "couldn't parse HTML."

Several state-of-the-art web agents (2024–2025) explicitly model web navigation as a partially observable, multi-step decision process where each low-level action can change the rendered page and invalidate multi-action plans. This is why many of them intentionally emit **one grounded action per turn** (or one "macro action" skill) rather than long open-loop sequences.

In practice, robust systems tend to converge on the following "production-ish" loop:

1) Observe (screenshot + structured page state)  
2) Decide next action (often single action + justification + stop/continue signal)  
3) Execute with strong interaction guards (scroll-into-view, hit-test, overlay handling)  
4) Verify state change ("change observation," step counter, DOM diff, URL hash, etc.)  
5) If no progress: escalate strategy, backtrack, or explore systematically

This matches the design principles described in **Agent-E** (planner + navigation agent, DOM distillation, "change observation") and **WILBUR** (loop detection + backtracking + learning from prior executions).

Your current system is already close to this canonical loop. The research-backed improvements below focus on (i) making planning/action outputs more controllable, (ii) grounding actions to the correct element among adversarial decoys, (iii) hardening interactions under overlays, and (iv) adding exploration + memory to avoid repeating the same failure mode.

## State-of-the-art browser agents and their architecture lessons

### Lessons from WebVoyager, SeeAct, VisualWebArena, and related benchmarks

**WebVoyager** is an end-to-end multimodal web agent evaluated on real websites; it takes both visual and textual signals and executes actions like clicking, typing, and scrolling. It explicitly uses a SoM-inspired approach by marking interactive elements on screenshots to help the model refer to targets reliably.

**SeeAct** ("GPT-4V(ision) is a Generalist Web Agent, if Grounded") is highly relevant to your setting because its central finding is: *the hard part is not describing the next action in English; the hard part is grounding that description to the right executable element*. Their pipeline separates:
- **Action generation** (what to do next) from
- **Action grounding** (which element to click/type into).

SeeAct also documents multiple grounding strategies—element attributes, textual choices, and image annotation—and notes that a ranker (inspired by MindAct) can narrow candidates before asking the VLM to choose.

**VisualWebArena** formalizes the SoM-style web representation: annotate each interactable element with a bounding box + unique ID, and feed the annotated screenshot (and optionally a textual SoM element tree) to the multimodal model.

Two benchmark papers matter for your "scroll long page + visually pick the one correct control" regime:

- **VisualWebArena** (image-grounded web tasks; SoM-annotated interactables)  
- **VideoWebArena** (video/long-context multimodal agents; still uses SoM state representation and in-context video approaches)  

If your challenge resembles "scan a long page for a specific visual affordance," VisualWebArena's representation choice (SoM boxes + IDs) is directly aligned with what you're already doing (EIDs + bboxes). The key gap is **how you present and use** that representation to reduce grounding error under decoys.

### Lessons from Agent-E and WILBUR for retries, stagnation, and self-improvement

**Agent-E** is one of the clearest "design principles" papers for practical web agent systems. It argues for:
- a **hierarchical architecture** (planner agent decomposes tasks; browser navigation agent executes subtasks),
- **DOM distillation/denoising** (choose among representations),
- **change observation** (monitor outcome of each action and feed that back as a control signal).

For your "stuck on Step 1" failure, "change observation" is particularly relevant: you should explicitly compute and feed the model a compact progress signal ("no meaningful change after action X; overlay still present; scroll position unchanged; step did not advance"). Agent-E frames this as conceptually similar to Reflexion-like feedback.

**WILBUR** focuses on robustness and correctness via:
- modeling web navigation as **graph exploration over web states**,
- enabling recovery from delayed mistakes using **backtracking**,
- adding **loop detection**, and
- building **adaptive in-context learning** from previous executions through demonstration banks and instruction synthesis.

For your repetitive failure loops, WILBUR-style loop detection ("I've seen this state; repeated the same actions; no progress") and backtracking/strategy-switching is the most directly transferable research pattern.

### Where CogAgent fits

**CogAgent** targets GUI grounding and multi-step GUI interaction, and is frequently cited in the "vision agents" lineage for operating on rendered interfaces rather than pure DOM. This is relevant when decoys differ primarily by **visual styling** or when key signals are in modals/canvas-like regions.

### Ranked recommendations for your problems (expected impact)

1) **Split "decide what to do" from "which element"** (SeeAct-style) and run grounding as a separate step with narrowed candidates. This directly targets Problems 1, 4, 5, 6.  
2) Add **change observation + loop detection** signals into the prompt and policy (Agent-E + WILBUR). This targets Problem 7 and indirectly improves all others by avoiding repeated failures.  
3) Adopt a **SoM/ID-overlaid screenshot** as the primary "click reference," aligned with VisualWebArena/WebVoyager (but be careful: SeeAct reports SoM alone isn't always best). This targets Problem 4 and helps multi-step scrolling.  

## Observation representations, Set-of-Mark prompting, and the best DOM payload

### Set-of-Mark prompting: what it is and what web agents actually use

The original **Set-of-Mark (SoM)** prompting technique overlays "marks" (IDs, boxes, masks) onto image regions to elicit stronger visual grounding from large multimodal models (LMMs).

In web agents, "SoM" commonly means a *web-specific variant*:
- draw bounding boxes around interactable elements,
- label each with a unique ID,
- provide a textual list/tree mapping IDs to element metadata.

That approach is explicitly described in VisualWebArena (interactable element ID + bbox) and WebVoyager (mark interactive elements on screenshot).

However, SeeAct's ICML materials caution that "existing LMM grounding strategies like set-of-mark prompting" are not necessarily effective in isolation for web agents, and that combining HTML structure with visuals can outperform naive SoM.

**Practical implication:** keep SoM, but use it as *one input in a two-stage grounding pipeline,* not as the only grounding signal.

### DOM representation strategies: what research suggests you should include

Research systems use several observation representations:

- **Filtered element lists** with role/type/text + bounding box (common for grounding)  
- **Accessibility trees** (often more semantically meaningful and smaller than raw HTML)  
- **Screenshot / SoM-annotated screenshot** (critical when the UI meaning is visual: color, placement, badges, modals, decoys)  
- **Distilled/denoised DOM** chosen adaptively (Agent-E emphasizes flexible DOM distillation)  
- **Candidate narrowing** before asking the large model (Mind2Web shows that filtering large HTML with a smaller model improves effectiveness/efficiency).  

**Optimal balance for your specific challenge:**  
You're already sending "clickables with EID, text, bbox, visibility flags; inputs; scrollables; dialogs." This is close to VisualWebArena's SoM + element tree idea. The key improvements are:

1) **Make the screenshot the single source of truth for "what is visible"** and treat DOM text as *supporting evidence*, not as truth. (This helps with decoys and overlays.)  
2) Add **accessibility role/name** (or Playwright role selectors) per element, to reduce ambiguity among "Click Here" clones. This aligns with how Playwright itself encourages robust target selection and how web agents use structured semantics.  
3) Include a **top-K candidate set** for click targets (ranked by heuristics) rather than sending all 25-40 buttons as an undifferentiated list; SeeAct/MindAct-like narrowing reduces grounding mistakes by turning the model's job into classification among candidates.  

### Specific techniques to implement now

**Technique A: Produce a SoM-annotated screenshot from your existing EIDs**  
You do *not* need segmentation models. Use your bboxes and draw boxes + the EID label. This directly mirrors VisualWebArena's "annotate every interactable element with bounding box and unique ID."  

**Technique B: Provide both "SoM image" and "SoM text map"**  
VisualWebArena describes providing the annotated image and a text representation of SoM (element tree string).  
You can approximate "SoM text map" as a compact JSON list:

- eid, role, name (from aria-label/innerText), bbox, isTopmostAtCenter, isInDialog, isLikelyOverlay.

**Technique C: Add "hit-test metadata" per candidate element**  
Before asking the model which element to click, compute whether it is actually clickable at its center point (topmost) using document.elementFromPoint(...) and include topmostEidAtCenter. This directly targets your "submit button blocked" issue and helps decoy separation.

### Ranked recommendations for your problems

1) Add SoM overlay + candidate narrowing (Problem 4, 6)  
2) Add accessibility/role + hit-test fields (Problem 3, 4, 5)  
3) Adaptive DOM distillation (Problem 1, 7)  

## Prompting and structured output control for multi-step plans

### Why you're seeing single-action plans

Even when you "ask for up to 25 actions," many web-agent prompting recipes implicitly bias toward **one action per step** because:
- the environment changes after each action,
- the model can't reliably predict intermediate page states,
- and most benchmarked agents are evaluated on per-step correctness, not open-loop macro plans.

So your "Problem 1: SINGLE-ACTION PLANS" is partly a *mismatch between what you request (open-loop plan) and what these agent paradigms are optimized to produce (closed-loop policy).*

The fix is not merely "prompt harder." It's to redesign the control interface so the model can still be "multi-step" without requiring it to hallucinate future states.

### Research-supported prompting patterns that improve reliability

**Pattern A: Plan-then-execute (P-t-E)**  
Separate planning from execution: the model produces a high-level plan (multi-step), but you execute it one action at a time with re-observation and re-planning. This is a standard resilience pattern.  

**Pattern B: ReAct-style interleaving**  
ReAct interleaves reasoning traces and actions to update plans based on observations. In web contexts, this corresponds to "think -> act -> observe -> think..." loops.  

**Pattern C: Two-stage decide + ground (SeeAct)**  
Generate the *intent* of the action (e.g., "scroll down to find the nav button at bottom"), then run a grounding step to pick the exact element ID.  

### Concrete solution for your stack: "Macro actions" + JSON Schema constraints

You described that Gemini Flash returns structured JSON, but tends to emit a single submit_code. You can force multi-step structure and reduce "submit_code fixation" by:

1) Expanding your action vocabulary to include **macro actions** the code can execute safely:
   - scroll_search(target="navigation button", maxScrolls=8, stopWhen="new_candidate_found")
   - dismiss_overlays(maxAttempts=3)
   - collect_code_candidates(scope="near_code_prompt")

2) Using Gemini API **structured outputs** with JSON Schema constraints--especially minItems--to force a multi-action plan (or at least a multi-item plan scaffold). Gemini structured outputs explicitly support JSON Schema subsets including minItems/maxItems.

### Why this directly addresses your Problem 1

- min(2) prevents trivial single-action outputs.  
- Macro actions shift the model from "predict exact scroll count" to "choose a robust skill," while your executor remains closed-loop and can re-screenshot per macro.  
- Explicit escalation actions create a "policy" for what to do when stuck, rather than letting the model repeat submit_code.

## Robust element interaction under overlays, decoys, and long scrolling

### Problem 3: Submit button blocked (covered by overlay / not topmost)

**Technique A: Pre-click hit testing and blocker attribution**
1) Compute the click point (center or a "safe" inset point).
2) In page context, evaluate document.elementsFromPoint(x, y) and identify the topmost element.
3) If topmost != target (or not contained by target), treat it as blocker and enter overlay dismissal flow.

**Technique B: Prefer form-native submission when possible**
If you know the form element, try form.requestSubmit() (or form.submit() if appropriate) inside page.evaluate. This bypasses pointer interception.

**Technique C: Overlay "pointer-events: none" shim**
Instead of removing overlays (risking deleting important nodes), temporarily set pointer-events: none on the specific blocker element(s) found via elementsFromPoint, or on a narrowly defined overlay subtree. This allows the click to reach the intended target without DOM surgery.

### Problem 5: Overlay/popup management (recurring traps)

**Robust overlay strategy (safer than wholesale deletion):**
- Maintain an "overlay manager" that runs **before every action** and **after every scroll**:
  1) detect potential overlays (position fixed/sticky; large viewport coverage; high z-index; role=dialog; aria-modal; or blocks pointer events),
  2) attempt *semantic close* first (click close/X, "No thanks," "Dismiss," press Escape),
  3) if unsuccessful, apply targeted **pointer-events: none** only to the overlay root (not the whole page),
  4) re-check that the target is now topmost at the click point.

**Key safety guard:** never delete nodes unless you're confident they are pure overlays; prefer reversible CSS changes.

### Problem 4: Decoy button identification (25-40 similar buttons; one correct visually)

**Technique A: Candidate ranking prior to VLM choice**
Implement a deterministic ranker that prioritizes likely navigation controls:
- larger buttons,
- near bottom of page or near "Keep scrolling..." instruction,
- visually distinctive (color/contrast can be approximated by sampling pixels in bbox),
- not inside known overlay containers.

Then ask Gemini to pick among **top 8-12** candidate EIDs only.

**Technique B: Two-pass "visual verification"**
Pass 1: model proposes "the correct button is the green one at bottom of page in section X."  
Pass 2: show a cropped image around the top candidates (or SoM overlay) and ask it to choose the correct EID. This mirrors SeeAct's explicit grounding step.

### Problem 6: Scroll strategy for long pages

**Practical scroll policy (closed-loop, deterministic)**
Instead of asking the model "how many times to scroll," implement a scroll-search macro:

- Scroll by ~0.8 viewport height.
- After each scroll:
  - run overlay manager,
  - extract newly visible interactables,
  - update candidate ranking,
  - stop if:
    - "navigation button" candidate appears with high confidence,
    - the step prompt changes,
    - scroll reaches bottom.

**Critical detail:** long pages may contain **scrollable containers** inside the page. Your DOM snapshot already identifies scrollables; treat each scrollable region as its own mini-viewport and run the same scroll-search inside it before scrolling the main page.

## Robust code/text extraction without CSS/JS noise

### Techniques to implement

**Technique A: Context-gated DOM extraction**
Only accept a 6-character candidate if it is:
- in the same visual region as a "code" instruction (e.g., within 500px of text like "code", "enter", "submit", "verification"), OR
- inside a semantically labeled element (aria-label mentions code; role=status; etc.), OR
- rendered in a dedicated "code display" container (monospace, letter spacing).

**Technique B: Negative filters for unit-like suffixes**
Reject tokens where:
- last 2 characters are a common unit (px, ms, em, vh, vw, rem),
- it contains a decimal point,
- it's adjacent to { : ; patterns characteristic of CSS/JS dumps.

**Technique C: Two-stage "candidate generation + verification"**
1) Generate candidates via deterministic rules (regex + context gating).  
2) Ask Gemini to **verify** which candidate is the challenge code **given a screenshot crop** around each candidate, returning either (a) the selected candidate string or (b) "none present."

## Gemini Flash, Gemini Live API, and learning/memory layer

### Gemini Flash best practices for structured JSON and multi-step plans

**Structured outputs (JSON Schema)**
Gemini structured outputs support a subset of JSON Schema; critically for your "single-action plan" issue, it supports minItems/maxItems for arrays and lets you set response_mime_type to application/json with a response_json_schema.

### Gemini Live API: can it stream a Playwright viewport for real-time action guidance?

**What the Live API is**
The Gemini Live API is a **stateful WebSocket API** that supports continuous streaming input (text, audio, video) and can return text/audio and function call requests.

**Input video format constraints**
The Live API expects "a sequence of discrete image frames" and supports video frames input at **1 FPS**, recommending **768x768** for best results.

**Structured JSON output in Live mode**
Critical gotcha: the Live API setup message explicitly lists **unsupported generationConfig fields**, including responseMimeType and responseSchema. So you generally can't rely on "JSON schema mode" in Live sessions the way you can with generateContent.

**What you should do instead:** use **function calling** in Live sessions. The Live API has dedicated messages for tool calls (functionCalls[]) and tool responses.

### Learning/memory layer across runs

**Level 1: Deterministic rule memory (lowest complexity, immediate payoff)**
Store a simple JSON knowledge base keyed by step + feature flags:
- false_code_suffixes = ["px","ms","em","rem","vh","vw"]
- overlay_selectors_seen = [...]
- decoy_classes_seen = [...]
- step_1_solution = "scroll_search until bottom; nav button appears in section X"

**Level 2: Vector DB memory (moderate complexity)**
Store embeddings of page-state summaries. On new runs, retrieve top-K similar past states and inject as few-shot exemplars.

**Level 3: Demonstration bank + instruction synthesis (WILBUR-style)**
Maintain positive and negative demo banks plus distilled instruction banks.

## Summary mapping: your seven problems to highest-leverage fixes

Problem 1 (single-action plans): Use schema-enforced multi-step scaffold + macro actions, or plan-then-execute with one action per loop.  
Problem 2 (phantom code): context-gated extraction + blacklist + verification + learned constraints from memory.  
Problem 3 (submit blocked): hit-test + blocker attribution + targeted overlay mitigation; treat force as last resort.  
Problem 4 (decoys): candidate narrowing + SoM overlay + explicit grounding step.  
Problem 5 (overlays): overlay manager + reversible pointer-events shim; integrate dark-pattern heuristics.  
Problem 6 (scroll): deterministic scroll-search macro + stop conditions + scrollable-container handling.  
Problem 7 (stagnation): change observation + loop detection + backtracking + cross-run memory (WILBUR/Agent-E patterns).
