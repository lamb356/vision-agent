import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { callGemini } from '../gemini.js';
import { AdvisorRequest, AdvisorResponse, EnrichedSnapshot, GeminiMessage } from '../types.js';

var advisorPromptCache: string | null = null;

async function getAdvisorSystemPrompt(): Promise<string> {
  if (advisorPromptCache) {
    return advisorPromptCache;
  }

  var promptPath = path.join(process.cwd(), 'prompts', 'ADVISOR.md');
  advisorPromptCache = await readFile(promptPath, 'utf8');
  return advisorPromptCache;
}

function parseSection(raw: string, heading: string): string {
  var escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var regex = new RegExp(`###\\s*${escaped}\\s*([\\s\\S]*?)(?=###\\s*\\d\\.|$)`, 'i');
  var match = raw.match(regex);
  return match?.[1]?.trim() ?? '';
}

export async function advisorTool(
  request: AdvisorRequest,
  snapshot: EnrichedSnapshot,
  modelOverride?: string
): Promise<AdvisorResponse> {
  var systemPrompt = await getAdvisorSystemPrompt();

  var messageText = [
    'You are assisting the main browser automation agent.',
    '',
    `Task: ${request.prompt}`,
    '',
    'Current snapshot context:',
    truncateForAdvisor(JSON.stringify(snapshot, null, 2), 12000)
  ];

  if (request.sourceCode?.trim()) {
    messageText.push('', 'Relevant source code:', truncateForAdvisor(request.sourceCode, 12000));
  }

  var messages: GeminiMessage[] = [
    {
      role: 'user',
      parts: [{ text: messageText.join('\n') }]
    }
  ];

  var raw = await callGemini(messages, systemPrompt, modelOverride, {
    temperature: 0.2,
    maxTokens: 1800,
    thinkingBudget: 512
  });

  return {
    analysis: parseSection(raw, '1. Source Analysis') || raw,
    suggestedCode: parseSection(raw, '2. Code'),
    disclaimer: parseSection(raw, '3. Disclaimer'),
    raw
  };
}

function truncateForAdvisor(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}