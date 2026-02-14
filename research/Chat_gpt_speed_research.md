# Speed-Optimizing One-Action-Per-Turn VLM Browser Agents for Timed Adversarial Challenges

## Executive summary

A 30-step challenge with a 10-minute cap gives you ~20 seconds per step on average (600s / 30). With 3-5 seconds of model latency per Gemini call, a strict "observe -> call model -> do one action -> re-observe" loop quickly becomes time-infeasible once steps require multiple scrolls, overlay mitigation, retries, and precise element selection. The practical speed path is therefore not "make the VLM output 3 actions," but move repetition and low-risk micro-decisions out of the VLM and into a deterministic, verifiable execution layer that can safely execute 2-3 (or 10+) micro-actions before you pay for another multimodal call. This is consistent with how modern agents reduce interaction count: they use composite actions, hierarchical skills, and post-action change verification rather than blind long open-loop sequences.

The highest-impact changes for your Playwright + Gemini Flash agent, ranked by expected impact on your timed adversarial setting:

1) Replace "scroll = model call" with a deterministic scroll-search skill that scrolls aggressively (multiple steps) while continuously checking cheap signals (step text changed, code appeared, a "target-like" element entered viewport, scroll height plateau). This single change typically removes the dominant multiplier in long-page tasks. Agents often waste steps on repetitive scrolling; some approaches even remove scroll as a model action entirely because of aimless repetition.

2) Introduce confidence-gated "micro-batching" (2-3 actions) with tiered verification: execute short action sequences without re-observing only when (a) actions are low-risk and/or reversible and (b) cheap verifications pass after each micro-action. This is the web analogue of receding-horizon / closed-loop planning.

3) Shift high-risk decisions into multi-choice selection (top-k candidate EIDs) so you can compute action confidence from (i) logprob margins (if you're on Vertex Gemini API where logprobs are supported) and/or (ii) internal heuristics like rank-gap + hit-test + visibility.

4) Use Playwright actionability + hit-testing checks as a fast verifier to decide whether to continue a batch (viewport, stable, not covered) vs re-observe.

5) Consider Gemini Live API for "always-on" guidance only if you can accept Live constraints: Live supports streaming frames (video as discrete frames, commonly documented at 1 FPS recommended 768x768) and tool calling, but its WebSockets API explicitly does not support several generation-config fields including responseSchema, responseMimeType, and logprobs-related fields.

Throughout, the key design principle is: batch only what you can verify cheaply; re-observe (and pay the 3-5s model latency) only at decision points (e.g., decoy selection) and after batches that materially change the state.

## Risk-stratified batching

Before specific batching patterns, define a risk class for every primitive action:

- Low risk: scroll, press Escape, wait, dismiss known overlay selectors, focus known input, clear+type into validated input.
- Medium risk: click on a clearly identified close button, click on a radio/checkbox when the label is uniquely determined, open a dropdown.
- High risk: click among 25-40 visually similar decoy buttons; submit/advance; any click that could trigger traps, navigation, or irreversible state.

Decision rule template:
- You may batch up to K=3 actions if:
  1) All actions are low risk, OR
  2) Exactly one action is medium/high risk, but its confidence >= threshold and you have immediate cheap verification after it.

## Policy: Skill-based batching (highest impact)

Make Gemini choose which skill to run, not which micro-actions to execute. Then the skill runs multiple actions internally:

- skill_scroll_search(target_hint)
- skill_dismiss_overlays()
- skill_find_code_and_submit()
- skill_focus_and_select_option() (radio/checkbox/modals)

This mirrors the design principle of "domain-specific primitive skills" highlighted in Agent-E.

Confidence estimation:
- Confidence is mostly in deterministic checks:
  - scroll skill knows it is at bottom.
  - overlay dismiss skill confirms overlay DOM removed or made inert.
  - submit skill confirms step changed.

Recovery:
- Skills maintain internal state: how many scrolls attempted, where overlays were seen, which buttons were tried.
- After a skill hits its internal budget without progress, it triggers re-observation with a richer prompt for a "new approach" (prevents infinite loops).

## Verification tiers

Tier 0: DOM-only invariants (milliseconds)
- Step counter text changed (Step N -> Step N+1).
- Code appeared in a specific "challenge code" container.
- Overlay count decreased / overlay root removed.
- Scroll position changed by at least X pixels.
- Target EID now visible.

Tier 1: geometry + hit-test (milliseconds to tens of ms)
- elementFromPoint at the intended click coordinate returns the same element as your target.
- Bounding box intersects viewport and is not zero-sized.
- Basic stability check: bounding box doesn't move significantly over two animation frames.

Tier 2: cheap visual confirmation (mini-screenshot + 1 short model query)
Instead of a full "plan," ask a cheap question that returns "yes/no + pointer."

Tier 3: full re-observation
Your current loop: full screenshot + DOM snapshot -> Gemini for planning.

Tiering is how you "batch safely": you can run many Tier-0/1 checks inside a batch and only pay Tier-3 when needed.

## Implementation details that directly reduce wall-clock time

### Faster screenshots: crop, compress, and avoid full-page shots
- Viewport-only: never use fullPage: true unless absolutely necessary.
- Clip to region-of-interest: capture only the content area that changed.
- Use JPEG/WebP at moderate quality: smaller payloads cut upload time and sometimes model latency.

### Reduce "observation token" bloat
- Move stable instructions (schema, safety rules, action meanings) into system/developer prompt once.
- Keep per-turn prompt minimal: only delta changes + critical state summary.

### Use Playwright actionability signals as a fast "continue vs re-observe" gate
- If Playwright click fails actionability, treat that as a Tier-1 verification failure, not as "try JS click next."
- Run overlay skill (remove/close) and retry once.
- If still blocked, re-observe or choose alternate action.

## Gemini Live API limitations confirmed
- Structured JSON schema enforcement is not available in Live (per the API reference)
- Logprobs-based confidence is not available in Live
- Recommended: 1 FPS at 768x768
- Must use function calling for structured output in Live sessions

## Quantitative batching model

E[time per micro-action] = (t_o + t_m + K * t_a + (1-p_K) * t_r) / K

Where:
- t_m = model think time (3-5s)
- t_o = observation overhead (screenshot + DOM + encoding + send)
- t_a = average time per micro-action
- K = batch length
- p_K = probability whole batch succeeds
- t_r = expected recovery cost when batch fails

Batching helps only if (t_o+t_m)/K shrinks faster than (1-p_K)*t_r/K grows.

## Key research finding

EconWebArena's ablation study shows enabling multiaction actually DECREASED success rate from 46.9% to 41.9% - simply allowing multiple actions isn't enough; the model needs explicit instruction and the right architecture.

The winning speed strategy is not "force multi-action outputs," but convert repetitive behavior into composite actions/skills, execute short horizons with cheap verification, and reserve expensive multimodal calls for semantic decision points.
