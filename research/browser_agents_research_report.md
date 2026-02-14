# State-of-the-Art Browser Automation Agents Research Report (2024-2025)

## Executive Summary

This report provides a comprehensive analysis of 8 cutting-edge browser automation agents published in 2024-2025, with specific focus on solving three critical user problems:
1. **Multi-step planning** (vs. single-action plans)
2. **Stuck state recovery** and retry strategies
3. **Element interaction** when elements are covered/blocked

---

## 1. COMPARISON TABLE: All Systems

| System | Institution | Core Input | Multi-Step Planning | DOM Representation | Error Recovery | Key Metric |
|--------|-------------|------------|---------------------|-------------------|----------------|------------|
| **WebVoyager** | Zhejiang/Tencent | Screenshots + SOM | ReAct reasoning loop | Set-of-Mark (visual) | Retry w/ error msg | 59.1% success |
| **SeeAct** | OSU/OpenAI | Screenshots + HTML | Two-stage: plan->ground | HTML + visual choices | Oracle grounding gap | 51.1% (oracle) |
| **Agent-E** | Vercel Labs | Accessibility tree | JSON action sequences | Interactive refs (@e1) | Built-in retry logic | Production CLI |
| **BrowserGym** | ServiceNow | Multi-modal | Framework-agnostic | HTML + AXTree + pixels | Environment resets | 23.5% GPT-4 |
| **MindAct** | Microsoft | HTML text | Candidate ranking + MCQ | Pruned HTML snippets | Iterative refinement | SOTA on Mind2Web |
| **CogAgent** | Tsinghua | Screenshots (1120x1120) | End-to-end VLM | High-res cross-attention | Pixel-level grounding | SOTA AITW/Mind2Web |
| **AutoWebGLM** | Tsinghua | HTML + screenshots | Curriculum + RL | HTML simplification | DPO + rejection sampling | 18.2% WebArena |
| **WebArena** | CMU/AI2 | HTML + screenshots | Benchmark tasks | Full DOM + screenshots | Functional eval | 14.4% GPT-4 baseline |

---

## 2. DETAILED SYSTEM ANALYSIS

### 2.1 WebVoyager (ACL 2024)
**Paper:** https://arxiv.org/abs/2401.13919  
**Code:** https://github.com/MinorJerry/WebVoyager

#### Core Architecture
- **Observation-Action Loop:** Screenshot -> GPT-4V analysis -> Action execution -> New screenshot
- **Environment:** Real websites via Selenium (not simulated)
- **Key Innovation:** Set-of-Mark (SOM) prompting with JavaScript-based element marking

#### Multi-Step Planning Strategy
```
ReAct Prompting Pattern:
1. Observation: "The image shows..."
2. Thought: "To proceed, I need to..."
3. Action: "Click [17]" or "Type [13]; Warsaw"
```
- Uses **chain-of-thought reasoning** before each action
- Maintains **action history** in context window
- No explicit plan generation - reactive step-by-step

#### DOM Representation: Set-of-Mark (SOM)
```javascript
// GPT-4V-ACT JavaScript tool extracts interactive elements
// Overlays bounding boxes with numerical labels
// Elements marked: <input>, <button>, <a>, etc.
```
- **Visual grounding:** Black bounding boxes with white-on-black labels
- **Auxiliary text:** Element type, text content, aria-label attributes
- **No HTML parsing required** - purely visual approach

#### Error Recovery Mechanisms
- **Immediate retry:** If action raises exception, error message added to prompt
- **Error correction consumes one step** from exploration budget
- **No backtracking** - only forward retry

#### Performance
- **59.1% task success rate** on 15 real websites
- **85.3% agreement** with human judgment (auto-eval)
- Outperforms GPT-4 (All Tools) and text-only variants

---

### 2.2 SeeAct (ICML 2024)
**Paper:** https://arxiv.org/abs/2401.01614  
**Code:** https://osu-nlp-group.github.io/SeeAct/  
**Package:** `pip install seeact`

#### Core Architecture
- **Two-stage design:** Action Generation -> Element Grounding
- **LMM-based:** GPT-4V for visual understanding
- **Online evaluation:** First to evaluate on live websites

#### Multi-Step Planning Strategy
```
Stage 1 - Action Generation:
  "Analyze task, webpage, previous actions -> Generate action description"
  Example: "Click the 'Find Your Truck' button"

Stage 2 - Element Grounding:
  Convert description -> HTML element + operation (CLICK/TYPE/SELECT)
```

#### Three Grounding Strategies (CRITICAL INSIGHT)

**1. Grounding via Element Attributes**
```
Model outputs: Element text + Element type
Heuristic search matches against DOM
```

**2. Grounding via Textual Choices (BEST - 20-30% gap closed)**
```python
# DeBERTa cross-encoder ranks top-50 candidates
candidates = ranker(query, all_elements)[:50]
# Cluster into groups of 17 for multi-choice QA
# Iterative refinement until single choice or None
```

**3. Grounding via Image Annotation**
```
Bounding boxes + alphabet labels on screenshot
Model outputs label on bottom-left of target
```

**Key Finding:** Textual choices + HTML correspondence outperforms pure visual annotation by **10%**

#### Error Recovery
- **No built-in backtracking** in original version
- **Retry on failure** with same grounding strategy
- **Reflection module** added in SeeAct-V variant

#### Performance
- **51.1% success** with oracle grounding (online)
- **20-30% gap** between best grounding and oracle
- GPT-4V substantially outperforms GPT-4 (13.3%)

---

### 2.3 Agent-E (Vercel Labs)
**Code:** https://github.com/vercel-labs/agent-browser

#### Core Architecture
- **Client-daemon architecture:** Rust CLI + Node.js daemon
- **Browser Engine:** Playwright (Chromium/Firefox/WebKit)
- **Optimal for AI agents** - designed for programmatic control

#### Multi-Step Planning Strategy
```bash
# 1. Navigate and get snapshot
agent-browser open example.com
agent-browser snapshot -i --json   # AI parses tree and refs

# 2. AI identifies target refs from snapshot
# 3. Execute actions using stable refs
agent-browser click @e2
agent-browser fill @e3 "input text"

# 4. Get new snapshot if page changed
agent-browser snapshot -i --json
```

#### DOM Representation: Interactive Element Refs
```json
{
  "success": true,
  "data": {
    "snapshot": "...",
    "refs": {
      "e1": {"role": "heading", "name": "Title"},
      "e2": {"role": "button", "name": "Submit"}
    }
  }
}
```
- **Stable references:** @e1, @e2 persist across snapshots
- **Accessibility tree-based:** Role, name, state properties
- **JSON output:** Machine-readable for AI agents

#### Error Recovery
- **Visibility checks:** `agent-browser is visible @e2`
- **Scoped headers:** Authentication without login flows
- **Headed mode:** Debug with visible browser window

---

### 2.4 BrowserGym (ServiceNow)
**Paper:** https://arxiv.org/abs/2403.07718  
**Code:** https://github.com/ServiceNow/BrowserGym

#### Core Architecture
- **Gymnasium-compatible environment** for web agents
- **Multi-modal observations:** HTML, AXTree, screenshot, pixels
- **Rich action space:** Python code + high-level primitives

#### Multi-Step Planning Strategy
- **Framework-agnostic:** Supports any agent architecture
- **Chat-based interactions:** Conversational interface
- **Task templates:** 29-341 tasks across difficulty levels

#### DOM Representation
```python
obs = {
    "html": "...",           # Full DOM
    "axtree": "...",         # Accessibility tree
    "screenshot": bytes,     # PNG image
    "coordinates": (x, y),   # Screen coordinates
    "url": "...",
    "tabs": [...]
}
```

#### Error Recovery
- **Environment reset:** Standard gym interface
- **Max step limits:** 30-50 steps per task
- **Functional evaluation:** End-to-end correctness checks

#### Supported Benchmarks
| Benchmark | Task Templates | Max Steps | Multi-Tab |
|-----------|---------------|-----------|-----------|
| MiniWoB++ | 125 | 10 | No |
| WebArena | 812 | 30 | Yes |
| VisualWebArena | 910 | 30 | Yes |
| WorkArena L1-L3 | 33-341 | 30-50 | Yes/No |
| AssistantBench | 214 | 30 | Yes |

---

### 2.5 MindAct (Microsoft Research)
**Paper:** https://arxiv.org/abs/2306.06070 (Mind2Web)  
**Dataset:** Multi-domain web task benchmark

#### Core Architecture
- **Two-stage:** Candidate ranking -> Action selection
- **Cross-encoder ranking:** DeBERTa for element retrieval
- **Multi-choice QA:** Action prediction as classification

#### Multi-Step Planning Strategy
```python
# Stage 1: Rank top-k candidates
scores = cross_encoder(query, element_candidates)
top_k = elements[scores.topk(k=50)]

# Stage 2: Multi-choice action selection
# Partition into groups of 5
# Iterative refinement until single selection
```

#### DOM Representation
- **Pruned HTML snippets:** Only candidate elements + neighbors
- **None option:** For elements not in candidate set
- **Ground truth actions:** For supervised fine-tuning

#### Error Recovery
- **Iterative refinement:** Re-group selected candidates
- **None rejection:** Discard all options if no match
- **SFT on failures:** Fine-tune on error patterns

#### Performance
- **SOTA on Mind2Web** dataset
- Generalizes to unseen websites via in-context learning

---

### 2.6 CogAgent (CVPR 2024)
**Paper:** https://arxiv.org/abs/2312.08914  
**Code:** https://github.com/THUDM/CogVLM

#### Core Architecture
- **18B parameter VLM:** 11B visual + 7B language
- **Dual-resolution input:** 224x224 + 1120x1120
- **High-resolution cross-module:** Cross-attention for detail

#### Multi-Step Planning Strategy
```
End-to-end approach:
Screenshot -> VLM -> Action text (no separate grounding)

Example output:
"Click at coordinates (0.45, 0.32)"
or
"Type 'search query' in the search box"
```

#### DOM Representation: Visual-Only
```
Low-res branch (224x224):  Global layout understanding
High-res branch (1120x1120): Fine text/icon recognition
         |
    Cross-attention fusion
         |
    Autoregressive action generation
```

**Key Innovation:** Cross-attention reduces compute by **>50%** vs full high-res

#### Error Recovery
- **Pixel-level grounding:** Direct coordinate prediction
- **No HTML dependency:** Pure vision approach
- **Outperforms LLM+HTML methods** on AITW and Mind2Web

#### Performance
- **SOTA on 9 VQA benchmarks** (including text-rich)
- **First generalist VLM** to beat LLM+HTML on GUI tasks
- 1120x1120 input enables tiny element recognition

---

### 2.7 AutoWebGLM (KDD 2024)
**Paper:** https://arxiv.org/abs/2404.03648  
**Code:** https://github.com/THUDM/AutoWebGLM

#### Core Architecture
- **Base model:** ChatGLM3-6B
- **HTML simplification:** Human-inspired browsing patterns
- **Hybrid human-AI training:** Curriculum + RL

#### Multi-Step Planning Strategy
```
Three-stage training:

Stage 1: Curriculum Learning (SFT)
  - Web recognition tasks (25.81%)
  - Simple task operations (27.1%)
  - Complex multi-step tasks (38.71%)

Stage 2: Reinforcement Learning (DPO + SFT)
  L_DPO+SFT = L_DPO + alpha * L_SFT
  - Contrastive pairs: successful vs failed attempts
  - Reduces hallucinations

Stage 3: Rejection Sampling Fine-tuning (RFT)
  - Self-play in sandbox environments
  - Collect successful traces for fine-tuning
```

#### DOM Representation: Simplified HTML
```python
# HTML simplification algorithm
# Preserves vital information while reducing verbosity
# Inspired by human browsing patterns
```

#### Error Recovery
- **DPO for robustness:** Learn from mistakes
- **Rejection sampling:** Filter successful trajectories
- **Auto-curriculum:** Generate training tasks automatically

#### Performance
- **18.2% on WebArena** (vs GPT-4 at 14.4%)
- Outperforms GPT-4 on real-world navigation
- Bilingual benchmark (Chinese + English)

---

### 2.8 WebArena (ICLR 2024)
**Paper:** https://arxiv.org/abs/2307.13854  
**Website:** https://webarena.dev/

#### Core Architecture
- **Self-hosted web applications:** Docker-based
- **Four domains:** E-commerce, social forum, GitLab, CMS
- **Functional correctness evaluation:** End-to-end verification

#### Multi-Step Planning Strategy
- **Long-horizon tasks:** Average 3.3 variations per template
- **Multiple valid paths:** Evaluation accommodates different solutions
- **Intent-based:** Natural language task descriptions

#### DOM Representation
```python
obs = {
    "url": "...",
    "dom": "...",              # Full DOM tree
    "accessibility_tree": "...", # A11y tree
    "screenshot": bytes,       # Visual rendering
    "tabs": [...],             # Multi-tab support
    "tools": ["map", "calculator", "wikipedia"]
}
```

#### Error Recovery
- **Unachievable task detection:** Agent must return "N/A"
- **Multiple validation methods:**
  - Exact match for information seeking
  - Programmatic state checks
  - GPT-4 fuzzy match

#### Performance
- **Human: 78.24%** success rate
- **GPT-4: 14.41%** success rate
- **Gap highlights need for:** exploration, failure recovery, planning

---

## 3. SOLUTIONS TO USER PROBLEMS

### PROBLEM 1: Multi-Step Action Sequences (vs Single Actions)

#### Recommended Techniques (Ranked by Impact)

**1. ReAct Prompting Pattern (WebVoyager) - HIGHEST IMPACT**
```python
prompt = """
Observation: [Current screenshot description]
Thought: [Reasoning about next step]
Action: [Specific action with parameters]

History:
Step 1: Observation -> Thought -> Action
Step 2: Observation -> Thought -> Action
...
"""
```
- Forces explicit reasoning before action
- Maintains context across steps
- Easy to implement with any LLM

**2. Two-Stage Planning (SeeAct)**
```python
# Stage 1: Generate high-level plan
plan = llm.generate_plan(task, current_state)

# Stage 2: Execute each step with grounding
for step in plan.steps:
    action = ground_and_execute(step)
    if action.failed:
        replan()
```

**3. Curriculum Learning + RL (AutoWebGLM)**
```python
# Progressive skill building
stage1: Simple single-step tasks
stage2: Multi-step reasoning tasks  
stage3: Complex open-domain tasks

# DPO for robust decision-making
loss = DPO_loss(successful_traj, failed_traj) + alpha * SFT_loss
```

**4. Hierarchical Planning (WILBUR)**
```python
# Goal-level demonstrations
D_g = retrieve_similar_trajectories(goal)
l_g = synthesize_learnings(D_g)

# Action-level demonstrations
D_a = retrieve_similar_actions(plan_step)
l_a = synthesize_learnings(D_a)

# Actor uses both
action = actor(state, plan, D_g, D_a, l_g, l_a)
```

---

### PROBLEM 2: Stuck States and Retry Strategies

#### Recommended Techniques (Ranked by Impact)

**1. Intelligent Backtracking (WILBUR) - HIGHEST IMPACT**
```python
class ReflectionModule:
    def verify(self, old_state, new_state, action, plan):
        # Rule-based: Check DOM changed
        if not dom_changed(old_state, new_state):
            return BACKTRACK, "No state change detected"
        
        # LLM-based: Check progress toward goal
        verdict = llm_reflect(old_state, new_state, action, plan)
        return verdict  # FINISH, CONTINUE, or BACKTRACK

    def backtrack(self, trajectory):
        # Return to most recent URL state
        prev_state = get_last_navigation_state(trajectory)
        navigate_to(prev_state.url)
        return prev_state
```
- **6% improvement** over retry-only baseline
- First agent to recover from delayed mistakes
- Models web navigation as graph exploration

**2. Error Feedback Loop (WebVoyager)**
```python
try:
    execute_action(action)
except Exception as e:
    error_prompt = f"""
    Previous action failed with error: {e}
    Please regenerate response with correction.
    """
    action = llm.regenerate(error_prompt)
    # Consumes one step from budget
```

**3. Demonstration Retrieval (WILBUR)**
```python
# Retrieve both positive and negative examples
D_plus = retrieve_successful_trajectories(goal, state)
D_minus = retrieve_failed_trajectories(goal, state)

# Synthesize learnings
learnings = synthesizer(D_plus, D_minus)

# Include in actor prompt
action = actor(state, plan, learnings=learnings)
```
- **12% improvement** from in-context learning
- Learns from both successes and failures

**4. Rejection Sampling (AutoWebGLM)**
```python
# Generate multiple attempts
attempts = [generate_action(state) for _ in range(k)]

# Filter successful ones via execution
successful = [a for a in attempts if execute(a).success]

# Fine-tune on successful trajectories
if successful:
    model.fine_tune(successful)
```

---

### PROBLEM 3: Element Interaction (Covered/Blocked Elements)

#### Recommended Techniques (Ranked by Impact)

**1. Set-of-Mark Visual Grounding (WebVoyager) - HIGHEST IMPACT**
```javascript
// JavaScript element marking (GPT-4V-ACT)
function markInteractiveElements() {
    const elements = document.querySelectorAll(
        'input, button, a, select, textarea, [role="button"]'
    );
    
    elements.forEach((el, idx) => {
        const rect = el.getBoundingClientRect();
        // Draw black bounding box
        // Add white-on-black label
        // Store element reference
    });
}
```
- **No HTML parsing** - visual approach bypasses complexity
- Handles dynamic elements, popups, floating ads
- Labels persist across interactions

**2. Multi-Modal Grounding (SeeAct)**
```python
# Best strategy: Combine HTML + Visual

# 1. Rank candidates with cross-encoder
candidates = deberta_ranker(query, all_elements)[:50]

# 2. Present as textual choices with visual annotations
for i, elem in enumerate(candidates):
    label = chr(65 + i)  # A, B, C...
    draw_bounding_box(screenshot, elem.bbox, label)

# 3. Model selects label
selected_label = llm.choose_action(screenshot_with_boxes, choices)
element = candidates[ord(selected_label) - 65]
```
- **10% better** than visual-only annotation
- HTML provides semantic context
- Visual resolves ambiguous elements

**3. High-Resolution Vision (CogAgent)**
```python
# Dual-resolution architecture
low_res = encode_224x224(screenshot)      # Global context
high_res = encode_1120x1120(screenshot)   # Fine details

# Cross-attention fusion
for layer in decoder_layers:
    hidden = self_attention(hidden)
    hidden += cross_attention(hidden, high_res)

# Direct coordinate prediction
action = generate_action(hidden)  # "Click (0.45, 0.32)"
```
- **1120x1120 resolution** captures tiny elements
- **No HTML needed** - pure vision
- Recognizes text, icons, small buttons

**4. Stable Element References (Agent-E)**
```bash
# Get snapshot with stable refs
agent-browser snapshot -i --json

# Returns:
# @e1: {role: "button", name: "Submit", visible: true}
# @e2: {role: "input", name: "Search", visible: false}

# Check visibility before interaction
if $(agent-browser is visible @e2); then
    agent-browser click @e2
fi
```
- **Visibility checks** prevent blocked element errors
- **Stable refs** persist across page changes
- **Accessibility tree** handles dynamic content

**5. Candidate Ranking + Iterative Refinement (MindAct)**
```python
# Stage 1: Retrieve top candidates
scores = cross_encoder(task_description, all_elements)
candidates = elements[scores.topk(k=50)]

# Stage 2: Iterative multi-choice selection
while len(candidates) > 1:
    groups = partition(candidates, group_size=5)
    selected = []
    for group in groups:
        choice = llm.select_from_choices(group + ["None"])
        if choice != "None":
            selected.append(choice)
    candidates = selected

# Final element
if candidates:
    return candidates[0]
else:
    return None  # Reject all
```

---

## 4. IMPLEMENTATION RECOMMENDATIONS

### For Multi-Step Planning

```python
# PATTERN: ReAct with explicit planning
class ReActAgent:
    def run(self, task, max_steps=30):
        history = []
        state = self.get_initial_state()
        
        for step in range(max_steps):
            # 1. Observe
            observation = self.observe(state)
            
            # 2. Think (explicit reasoning)
            thought = self.llm.generate_thought(
                task=task,
                observation=observation,
                history=history
            )
            
            # 3. Act
            action = self.llm.generate_action(
                thought=thought,
                available_actions=self.get_available_actions(state)
            )
            
            # 4. Execute
            new_state, result = self.execute(action)
            
            # 5. Record
            history.append({
                "step": step,
                "observation": observation,
                "thought": thought,
                "action": action,
                "result": result
            })
            
            # 6. Check completion
            if self.is_complete(task, new_state):
                return {"success": True, "history": history}
            
            state = new_state
        
        return {"success": False, "history": history}
```

### For Stuck State Recovery

```python
# PATTERN: Reflection + Backtracking
class RobustAgent:
    def __init__(self):
        self.trajectory = []
        self.checkpoint_states = []
    
    def run_with_recovery(self, task):
        state = self.get_initial_state()
        self.checkpoint_states.append(state)
        
        while not self.is_complete(task, state):
            action = self.plan_and_execute(task, state)
            new_state, success = self.execute(action)
            
            # Reflection
            verdict, feedback = self.reflect(state, new_state, action, task)
            
            if verdict == "BACKTRACK":
                # Recover to last checkpoint
                state = self.backtrack()
                # Include failure in context
                self.add_feedback(feedback)
            elif verdict == "CONTINUE":
                self.trajectory.append((action, new_state))
                if self.should_checkpoint(new_state):
                    self.checkpoint_states.append(new_state)
                state = new_state
            elif verdict == "FINISH":
                break
        
        return self.trajectory
    
    def reflect(self, old_state, new_state, action, task):
        # Rule-based check
        if not self.state_changed(old_state, new_state):
            return "BACKTRACK", "No state change detected"
        
        # LLM reflection
        prompt = f"""
        Task: {task}
        Previous state: {old_state}
        Action taken: {action}
        New state: {new_state}
        
        Did this action make progress? Reply with:
        - FINISH: if task is complete
        - CONTINUE: if progress was made
        - BACKTRACK: if action failed or was wrong
        """
        return self.llm.classify(prompt)
```

### For Element Interaction

```python
# PATTERN: Multi-modal grounding
class GroundedAgent:
    def __init__(self):
        self.ranker = DeBERTaCrossEncoder()  # From MindAct
    
    def ground_action(self, action_description, page):
        # 1. Get candidates via ranking
        all_elements = page.get_interactive_elements()
        scores = self.ranker.score(action_description, all_elements)
        top_candidates = all_elements[scores.topk(50)]
        
        # 2. Annotate screenshot
        screenshot = page.screenshot()
        for i, elem in enumerate(top_candidates[:17]):  # Group size
            label = chr(65 + i)
            screenshot = draw_bounding_box(screenshot, elem.bbox, label)
        
        # 3. LLM selects from annotated choices
        prompt = f"""
        Task: {action_description}
        
        Screenshot shows webpage with labeled elements (A-Q).
        Available elements:
        {format_choices(top_candidates[:17])}
        
        Select the letter of the element to interact with,
        or "None" if not present.
        """
        
        response = self.vlm.generate(prompt, image=screenshot)
        selected = parse_selection(response)
        
        if selected == "None":
            return None
        return top_candidates[ord(selected) - 65]
```

---

## 5. KEY PAPERS AND RESOURCES

### Essential Papers

| Paper | Authors | Venue | Link |
|-------|---------|-------|------|
| WebVoyager | He et al. | ACL 2024 | https://arxiv.org/abs/2401.13919 |
| SeeAct | Zheng et al. | ICML 2024 | https://arxiv.org/abs/2401.01614 |
| CogAgent | Hong et al. | CVPR 2024 | https://arxiv.org/abs/2312.08914 |
| AutoWebGLM | Lai et al. | KDD 2024 | https://arxiv.org/abs/2404.03648 |
| WebArena | Zhou et al. | ICLR 2024 | https://arxiv.org/abs/2307.13854 |
| Mind2Web | Deng et al. | NeurIPS 2023 | https://arxiv.org/abs/2306.06070 |
| WILBUR | Lutz et al. | arXiv 2024 | https://arxiv.org/abs/2404.05902 |
| BrowserGym | Drouin et al. | ICML 2024 | https://arxiv.org/abs/2403.07718 |

### Code Repositories

| System | Repository |
|--------|------------|
| WebVoyager | https://github.com/MinorJerry/WebVoyager |
| SeeAct | https://github.com/OSU-NLP-Group/SeeAct |
| CogAgent | https://github.com/THUDM/CogVLM |
| AutoWebGLM | https://github.com/THUDM/AutoWebGLM |
| BrowserGym | https://github.com/ServiceNow/BrowserGym |
| Agent-E | https://github.com/vercel-labs/agent-browser |

### Benchmarks

| Benchmark | Tasks | Evaluation | Link |
|-----------|-------|------------|------|
| WebArena | 812 | Functional | https://webarena.dev/ |
| Mind2Web | 2,350 | Element accuracy | https://mind2web.github.io/ |
| WebVoyager | 643 (15 sites) | Auto + Human | In paper |
| WorkArena | 23,150 | Functional | https://servicenow.github.io/WorkArena/ |
| VisualWebArena | 910 | Functional | In WebArena repo |

---

## 6. SUMMARY: TECHNIQUES BY IMPACT

### For Multi-Step Planning
1. **ReAct prompting** - Forces reasoning before action
2. **Two-stage plan->ground** - Separate planning from execution
3. **Curriculum learning** - Progressive skill building
4. **Hierarchical demonstrations** - Goal + action level examples

### For Stuck State Recovery
1. **Backtracking** - Return to previous checkpoint (WILBUR)
2. **Reflection module** - Verify progress after each action
3. **Demonstration retrieval** - Learn from past successes/failures
4. **Rejection sampling** - Filter successful trajectories

### For Element Interaction
1. **Set-of-Mark** - Visual grounding with bounding boxes
2. **Multi-modal grounding** - HTML + visual combined
3. **High-resolution vision** - 1120x1120 for tiny elements
4. **Stable references** - Accessibility tree with visibility checks
5. **Candidate ranking** - Cross-encoder + iterative selection

---

*Report compiled from 2024-2025 research papers on browser automation agents.*
