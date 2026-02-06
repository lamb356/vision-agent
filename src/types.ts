// --- Gemini API Types ---

export interface GeminiRequest {
  contents: GeminiContent[];
  generationConfig: GeminiGenerationConfig;
}

export interface GeminiContent {
  parts: GeminiPart[];
}

export type GeminiPart = GeminiTextPart | GeminiImagePart;

export interface GeminiTextPart {
  text: string;
}

export interface GeminiImagePart {
  inline_data: {
    mime_type: "image/png";
    data: string; // raw base64, no data URL prefix
  };
}

export interface GeminiGenerationConfig {
  responseMimeType: "application/json";
  responseSchema: GeminiSchema;
  thinkingConfig?: ThinkingConfig25 | ThinkingConfig3x;
  temperature?: number;
}

export interface ThinkingConfig25 {
  thinkingBudget: number;
}

export interface ThinkingConfig3x {
  thinkingLevel: "minimal" | "low" | "medium" | "high";
}

export interface GeminiSchema {
  type: "OBJECT" | "ARRAY" | "STRING" | "INTEGER" | "NUMBER" | "BOOLEAN";
  properties?: Record<string, GeminiSchema>;
  items?: GeminiSchema;
  required?: string[];
  enum?: string[];
  description?: string;
}

export interface GeminiResponse {
  candidates?: Array<{
    content: {
      parts: Array<{ text?: string }>;
    };
  }>;
  error?: { message: string; code: number };
}

// --- Agent Types ---

export interface Coordinate {
  x: number;
  y: number;
}

export interface DistractorResult {
  has_distractors: boolean;
  dismiss_buttons: Coordinate[];
}

export interface CodeResult {
  code: string; // 6-char alphanumeric or "NONE"
  confidence: "high" | "medium" | "low";
}

export interface SubmitTargets {
  input_location: Coordinate;
  submit_button: Coordinate;
  confidence: "high" | "medium" | "low";
}

export interface VerifyResult {
  current_step: number;
  advanced: boolean;
  error_message: string;
  completed: boolean;
}

export interface CombinedResult {
  code: string;
  input_location: Coordinate;
  submit_button: Coordinate;
  has_distractors: boolean;
  dismiss_buttons: Coordinate[];
}

export interface ActionItem {
  action: "click" | "scroll_down" | "scroll_up" | "select_radio" | "type_text" | "scroll_modal";
  target: Coordinate;
  description: string;
  text_to_type?: string;
}

export interface PageAnalysis {
  page_description: string;
  has_modal: boolean;
  has_code_visible: boolean;
  code: string;
  interactive_elements: string;
  recommended_actions: ActionItem[];
  input_location: Coordinate;
  submit_button: Coordinate;
}

// --- Config ---

export type ModelVersion = "3x" | "2.5";

export interface AgentConfig {
  url: string;
  headed: boolean;
  apiKey: string;
  model: string;
  modelVersion: ModelVersion;
}

export interface StepResult {
  step: number;
  success: boolean;
  elapsed_ms: number;
  attempts: number;
  error?: string;
}
