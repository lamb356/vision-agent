import type { GeminiSchema } from "./types.js";

// --- Schemas ---

const coordinateSchema: GeminiSchema = {
  type: "OBJECT",
  properties: {
    x: { type: "INTEGER", description: "X pixel coordinate" },
    y: { type: "INTEGER", description: "Y pixel coordinate" },
  },
  required: ["x", "y"],
};

export const distractorSchema: GeminiSchema = {
  type: "OBJECT",
  properties: {
    has_distractors: {
      type: "BOOLEAN",
      description: "True if any overlay/popup/modal is blocking the page",
    },
    dismiss_buttons: {
      type: "ARRAY",
      items: coordinateSchema,
      description: "Coordinates of each dismiss/close button for overlays",
    },
  },
  required: ["has_distractors", "dismiss_buttons"],
};

export const codeSchema: GeminiSchema = {
  type: "OBJECT",
  properties: {
    code: {
      type: "STRING",
      description:
        'The exactly 6-character alphanumeric code visible on the page, or "NONE" if not found',
    },
    confidence: {
      type: "STRING",
      enum: ["high", "medium", "low"],
      description: "How confident you are in the extracted code",
    },
  },
  required: ["code", "confidence"],
};

export const submitTargetsSchema: GeminiSchema = {
  type: "OBJECT",
  properties: {
    input_location: {
      ...coordinateSchema,
      description: "Center of the text input field where the code should be typed",
    },
    submit_button: {
      ...coordinateSchema,
      description: "Center of the REAL submit button (closest to input field)",
    },
    confidence: {
      type: "STRING",
      enum: ["high", "medium", "low"],
      description: "How confident you are in the identified targets",
    },
  },
  required: ["input_location", "submit_button", "confidence"],
};

export const verifySchema: GeminiSchema = {
  type: "OBJECT",
  properties: {
    current_step: {
      type: "INTEGER",
      description: "The step number currently displayed on the page",
    },
    advanced: {
      type: "BOOLEAN",
      description: "True if the page moved to the next step",
    },
    error_message: {
      type: "STRING",
      description: "Any error message visible on the page, or empty string",
    },
    completed: {
      type: "BOOLEAN",
      description: "True if all 30 steps are completed (success/congratulations page)",
    },
  },
  required: ["current_step", "advanced", "error_message", "completed"],
};

export const combinedSchema: GeminiSchema = {
  type: "OBJECT",
  properties: {
    code: {
      type: "STRING",
      description:
        'The exactly 6-character alphanumeric code visible on the page, or "NONE" if not found',
    },
    input_location: {
      ...coordinateSchema,
      description: "Center of the text input field",
    },
    submit_button: {
      ...coordinateSchema,
      description: "Center of the REAL submit button",
    },
    has_distractors: {
      type: "BOOLEAN",
      description: "True if overlays are blocking the page",
    },
    dismiss_buttons: {
      type: "ARRAY",
      items: coordinateSchema,
      description: "Dismiss button coordinates for any overlays",
    },
  },
  required: [
    "code",
    "input_location",
    "submit_button",
    "has_distractors",
    "dismiss_buttons",
  ],
};

const actionItemSchema: GeminiSchema = {
  type: "OBJECT",
  properties: {
    action: {
      type: "STRING",
      enum: ["click", "scroll_down", "scroll_up", "select_radio", "type_text", "scroll_modal"],
      description: "The type of action to perform",
    },
    target: {
      ...coordinateSchema,
      description: "Where to perform the action (click target, scroll start point, radio button location)",
    },
    description: {
      type: "STRING",
      description: "Human-readable description of what this action does",
    },
    text_to_type: {
      type: "STRING",
      description: "Text to type (only for type_text action)",
    },
  },
  required: ["action", "target", "description"],
};

export const analyzePageSchema: GeminiSchema = {
  type: "OBJECT",
  properties: {
    page_description: {
      type: "STRING",
      description: "Brief description of what you see on the page",
    },
    has_modal: {
      type: "BOOLEAN",
      description: "True if there is a modal/dialog/overlay with interactive content",
    },
    has_code_visible: {
      type: "BOOLEAN",
      description: "True if a 6-character alphanumeric code is visible anywhere",
    },
    code: {
      type: "STRING",
      description: 'The 6-char code if visible, otherwise "NONE"',
    },
    interactive_elements: {
      type: "STRING",
      description: "Description of interactive elements: radio buttons, checkboxes, dropdowns, forms, scrollable areas, etc.",
    },
    recommended_actions: {
      type: "ARRAY",
      items: actionItemSchema,
      description: "Ordered list of actions to take to proceed (e.g., scroll modal, select radio, click submit)",
    },
    input_location: {
      ...coordinateSchema,
      description: "Center of code input field if visible, otherwise (0,0)",
    },
    submit_button: {
      ...coordinateSchema,
      description: "Center of the REAL submit button if visible, otherwise (0,0)",
    },
  },
  required: [
    "page_description",
    "has_modal",
    "has_code_visible",
    "code",
    "interactive_elements",
    "recommended_actions",
    "input_location",
    "submit_button",
  ],
};

export const startSchema: GeminiSchema = {
  type: "OBJECT",
  properties: {
    start_button: {
      ...coordinateSchema,
      description: "Center of the START button",
    },
    found: {
      type: "BOOLEAN",
      description: "True if a START button was found on the page",
    },
  },
  required: ["start_button", "found"],
};

// --- Prompts ---

export const DISTRACTOR_PROMPT = `You are analyzing a browser screenshot of a challenge page.

Look for ANY overlays, popups, modals, banners, or floating elements that are blocking the main page content. Multiple popups may be stacked — find ALL of them.

IMPORTANT:
- Look for buttons labeled "Dismiss", "Close", "OK", "Got it", or similar
- Also look for X buttons — especially red circle X icons in the top-right corner of popups
- Look for ANY clickable close/dismiss control on each overlay
- Return the CENTER coordinates of EVERY dismiss/close/X button you can find
- If no overlays are present, set has_distractors to false and return empty array
- New popups may spawn after closing others — that's expected

Return the coordinates of ALL dismiss buttons you can find on ALL visible overlays.`;

export const CODE_PROMPT = `You are analyzing a browser screenshot of a challenge page.

Find the 6-character alphanumeric verification code displayed on this page.

IMPORTANT:
- The code is EXACTLY 6 characters long (letters and/or numbers)
- It is typically displayed prominently on the page
- It might be in a colored box, highlighted text, or bold format
- The code and input area are often on the LEFT SIDE of the page — check the left panel carefully
- The code may be partially obscured or near the edge — look at all visible text
- Do NOT confuse it with step numbers, timestamps, or other text
- If you cannot find a clear 6-character code, return "NONE"

Read the code VERY carefully — every character matters.`;

export const SUBMIT_TARGETS_PROMPT = `You are analyzing a browser screenshot of a challenge page.

Find TWO things:
1. The TEXT INPUT FIELD where a code should be typed
2. The REAL SUBMIT BUTTON to submit the code

LAYOUT HINT: The input field and real submit button are on the LEFT SIDE of the page, often in a left panel.

CRITICAL WARNING: This page has 8-15 FAKE submit buttons designed to trick you!
- The REAL submit button is the one CLOSEST to the input field
- Fake buttons are scattered around the page, often with similar styling
- Look for spatial proximity: the real button is typically right next to or below the input
- Ignore buttons far from the input field

Return the CENTER coordinates of both the input field and the real submit button.`;

export function submitTargetsWithFailedPrompt(failedCoords: Array<{ x: number; y: number }>): string {
  const coordList = failedCoords.map((c) => `(${c.x}, ${c.y})`).join(", ");
  return `${SUBMIT_TARGETS_PROMPT}

ADDITIONAL INFO: Previous attempts clicked these coordinates and they were WRONG (fake buttons): ${coordList}
Do NOT select any button near those coordinates. Find a DIFFERENT submit button.`;
}

export const VERIFY_PROMPT = `You are analyzing a browser screenshot of a challenge page.

Determine the current state of the page:
- What step number is currently displayed?
- Did the page advance to a new step?
- Is there any error message visible (e.g., "incorrect code", "try again")?
- Has the challenge been fully completed (all 30 steps done)?

Look for step indicators, success messages, error banners, or completion screens.`;

export const COMBINED_PROMPT = `You are analyzing a browser screenshot of a challenge page.

LAYOUT: The code, input field, and real submit button are on the LEFT SIDE of the page.

Do ALL of the following:

1. CHECK FOR OVERLAYS: Are there any popups, modals, or overlays blocking the page?
   If yes, find their dismiss/close/X buttons (including red circle X icons).

2. FIND THE CODE: Look for the 6-character alphanumeric verification code.
   It is EXACTLY 6 characters (letters and/or numbers). Check the LEFT panel carefully.

3. FIND THE INPUT: Locate the text input field where the code should be typed (LEFT side).

4. FIND THE REAL SUBMIT BUTTON: There are 8-15 FAKE submit buttons!
   The REAL one is CLOSEST to the input field on the LEFT. Ignore distant buttons.

Return all information in a single response.`;

export const START_PROMPT = `You are analyzing a browser screenshot of a challenge page.

Find the START button on this page. It might say "Start", "BEGIN", "Start Challenge", or similar.

Return the center coordinates of the start button. If no start button is found, set found to false.`;

export const ANALYZE_PAGE_PROMPT = `You are a browser automation agent analyzing a screenshot of a challenge page.

The 6-character verification code may NOT be directly visible. Each step has interactive elements that must be completed first to reveal the code or proceed.

Analyze the screenshot and tell me:

1. WHAT YOU SEE: Describe the page layout. Is there a modal/dialog? What content is shown?

2. INTERACTIVE ELEMENTS: Look carefully for:
   - Radio buttons (circles to select options)
   - Checkboxes
   - Dropdown menus / select elements
   - Scrollable areas (modals that need scrolling to see all content)
   - Form fields to fill in
   - Buttons (Submit, Next, Continue, Confirm, etc.)
   - Sliders, toggles, or other controls

3. CODE VISIBILITY: Is a 6-character alphanumeric code visible? If yes, what is it?
   The code may appear AFTER completing interactive elements.

4. RECOMMENDED ACTIONS: List the specific actions needed to proceed, in order.
   For example:
   - "scroll_modal" at (x,y) to see more content in a scrollable modal
   - "select_radio" at (x,y) to select the correct radio button option
   - "click" at (x,y) to click a Submit/Next/Continue button inside the modal
   - "scroll_down" at (640,400) to scroll the page down

5. INPUT & SUBMIT: If a code input field and submit button are visible, provide their coordinates.
   Look on the LEFT side of the page. If not visible, return (0,0).

IMPORTANT: The page often requires multiple interactions before the code appears. Scrolling inside modals is crucial — radio buttons or answers may be below the visible area.`;

