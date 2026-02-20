export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HandlerInfo {
  event: string;
  source: string;
  listenerType: 'attribute' | 'addEventListener' | 'react' | 'vue' | 'jquery' | 'unknown';
}

export interface ElementStyles {
  zIndex: number;
  opacity: number;
  pointerEvents: string;
  position: string;
  display: string;
  visibility: string;
  overflow: string;
}

export interface InteractiveElement {
  role: string;
  name: string;
  selector: string;
  visible: boolean;
  enabled: boolean;
  boundingBox: BoundingBox | null;
  handlers: HandlerInfo[];
  frameworkProps?: Record<string, unknown>;
  styles: ElementStyles;
}

export interface EnrichedSnapshot {
  ariaTree: string;
  interactiveElements: InteractiveElement[];
  url: string;
  title: string;
  visibleText: string;
  timestamp: string;
}

export interface SnapshotDiff {
  addedElements: string[];
  removedElements: string[];
  modifiedElements: string[];
  urlChanged: boolean;
  newUrl?: string;
  visibilityChanges: Array<{ selector: string; from: string; to: string }>;
  textChanges: Array<{ selector: string; from: string; to: string }>;
  summary: string;
}

export interface JsToolResult {
  result: unknown;
  changes: SnapshotDiff;
  snapshot: EnrichedSnapshot;
  consoleMessages: string[];
  errors: string[];
  executedCode: string;
}

export interface DragToolResult {
  sourceSelector: string;
  targetSelector: string;
  result: unknown;
  changes: SnapshotDiff;
  snapshot: EnrichedSnapshot;
  errors: string[];
}

export interface HoverToolResult {
  selector: string;
  result: unknown;
  changes: SnapshotDiff;
  snapshot: EnrichedSnapshot;
  errors: string[];
}

export type GeminiRole = 'user' | 'model';

export interface TextPart {
  text: string;
}

export interface ImagePart {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

export type GeminiPart = TextPart | ImagePart;

export interface GeminiMessage {
  role: GeminiRole;
  parts: GeminiPart[];
}

export interface GeminiCallOptions {
  temperature?: number;
  maxTokens?: number;
  thinkingBudget?: number;
  model?: string;
}

export interface AdvisorRequest {
  snapshot: string;
  sourceCode?: string;
  prompt: string;
}

export interface AdvisorResponse {
  analysis: string;
  suggestedCode: string;
  disclaimer: string;
  raw: string;
}

export type ParsedToolCall =
  | { tool: 'js'; code: string }
  | { tool: 'drag'; sourceSelector: string; targetSelector: string }
  | { tool: 'hover'; selector: string }
  | { tool: 'screenshot'; fullPage?: boolean }
  | { tool: 'advisor'; prompt: string; sourceCode?: string }
  | { tool: 'status'; status: string }
  | { tool: 'none' };

export interface AgentRunOptions {
  maxSteps?: number;
  maxToolCalls?: number;
  challengeUrl?: string;
}
