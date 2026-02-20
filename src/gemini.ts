import { GeminiCallOptions, GeminiMessage, GeminiPart } from './types.js';

interface GeminiApiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

interface GeminiApiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiApiPart[];
      role?: string;
    };
    finishReason?: string;
  }>;
  promptFeedback?: {
    blockReason?: string;
    safetyRatings?: Array<{ category: string; probability: string }>;
  };
  error?: {
    message?: string;
    status?: string;
    code?: number;
  };
}

function toApiPart(part: GeminiPart): GeminiApiPart {
  if ('text' in part) {
    return { text: part.text };
  }

  return {
    inlineData: {
      mimeType: part.inlineData.mimeType,
      data: part.inlineData.data
    }
  };
}

function extractResponseText(payload: GeminiApiResponse): string {
  var parts = payload.candidates?.[0]?.content?.parts ?? [];
  var text = parts
    .map((part) => part.text ?? '')
    .join('')
    .trim();

  if (text) {
    return text;
  }

  if (payload.promptFeedback?.blockReason) {
    return `Blocked by model safety system: ${payload.promptFeedback.blockReason}`;
  }

  return '';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [2000, 5000, 10000];

export async function callGemini(
  messages: GeminiMessage[],
  systemPrompt: string,
  modelOverride?: string,
  options: GeminiCallOptions = {}
): Promise<string> {
  var apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY. Add it to your environment or .env file.');
  }

  var model =
    modelOverride ||
    options.model ||
    process.env.GEMINI_MODEL ||
    'gemini-2.5-flash-preview-05-20';

  var url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  var payload: Record<string, unknown> = {
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: messages.map((message) => ({
      role: message.role,
      parts: message.parts.map(toApiPart)
    })),
    generationConfig: {
      temperature: options.temperature ?? 0.2,
      maxOutputTokens: options.maxTokens ?? 2048,
      ...(typeof options.thinkingBudget === 'number'
        ? { thinkingConfig: { thinkingBudget: options.thinkingBudget } }
        : {})
    }
  };

  for (var attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    var response: Response | null = null;
    var textBody = '';
    var parsed: GeminiApiResponse | null = null;
    var isLastAttempt = attempt >= MAX_RETRIES - 1;
    var retryDelayMs = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 10_000;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      textBody = await response.text();

      try {
        parsed = JSON.parse(textBody) as GeminiApiResponse;
      } catch {
        parsed = null;
      }
    } catch (error) {
      if (!isLastAttempt) {
        console.log(`[gemini] Network error. Retrying in ${retryDelayMs}ms...`);
        await sleep(retryDelayMs);
        continue;
      }

      throw error;
    }

    var errorText = parsed?.error?.message ?? textBody;
    var statusCode = parsed?.error?.code ?? response.status;
    var isRetryableStatus = statusCode === 429 || statusCode === 500 || statusCode === 503;
    var isTransientServer = /internal error|backend error|temporarily unavailable|timeout|unavailable/i.test(errorText);

    if ((isRetryableStatus || isTransientServer) && !isLastAttempt) {
      console.log(`[gemini] Gemini API error (${statusCode}). Retrying in ${retryDelayMs}ms...`);
      await sleep(retryDelayMs);
      continue;
    }

    if (!parsed) {
      throw new Error(`Gemini returned non-JSON response (${response.status}): ${textBody.slice(0, 800)}`);
    }

    if (!response.ok || parsed.error) {
      throw new Error(`Gemini API error (${response.status}): ${errorText}`);
    }

    var text = extractResponseText(parsed);
    if (!text) {
      throw new Error(`Gemini returned no text. Raw response: ${textBody.slice(0, 1000)}`);
    }

    return text;
  }

  throw new Error('Gemini API error: exceeded retry attempts.');
}
