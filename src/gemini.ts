import type {
  GeminiRequest,
  GeminiResponse,
  GeminiSchema,
  ModelVersion,
} from "./types.js";

let activeModel: string = "gemini-3-flash-preview";
let activeModelVersion: ModelVersion = "3x";

export function getActiveModel(): string {
  return activeModel;
}

export function getModelVersion(): ModelVersion {
  return activeModelVersion;
}

function buildThinkingConfig(_budget: number): Record<string, unknown> {
  if (activeModelVersion === "3x") {
    // All vision calls use minimal thinking for speed
    return { thinkingLevel: "minimal" };
  }
  // 2.5: use integer budget directly
  return { thinkingBudget: _budget };
}

function buildEndpoint(model: string, apiKey: string): string {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const masked = url.replace(/key=.+/, `key=${apiKey.slice(0, 8)}...${apiKey.slice(-4)} (len=${apiKey.length})`);
  console.log(`  [DEBUG] ${masked}`);
  return url;
}

async function rawCall(
  apiKey: string,
  model: string,
  prompt: string,
  imageBase64: string,
  schema: GeminiSchema,
  thinkingBudget: number
): Promise<GeminiResponse> {
  const body: GeminiRequest = {
    contents: [
      {
        parts: [
          { inline_data: { mime_type: "image/png", data: imageBase64 } },
          { text: prompt },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
      ...(thinkingBudget > 0 ? { thinkingConfig: buildThinkingConfig(thinkingBudget) as any } : {}),
    },
  };

  const resp = await fetch(buildEndpoint(model, apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini ${resp.status}: ${text}`);
  }

  return resp.json() as Promise<GeminiResponse>;
}

function extractJson<T>(response: GeminiResponse): T {
  const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("No text in Gemini response");
  }
  return JSON.parse(text) as T;
}

/**
 * Set model explicitly. No auto-detection for now.
 */
export async function detectModel(_apiKey: string): Promise<void> {
  console.log(`  Forced model: ${activeModel} (3.x series, thinkingLevel: minimal)`);
}

export interface GeminiCallResult<T> {
  parsed: T;
  raw: GeminiResponse;
}

/**
 * Call Gemini with retry logic. Returns parsed result + raw response.
 */
export async function callGemini<T>(
  apiKey: string,
  prompt: string,
  imageBase64: string,
  schema: GeminiSchema,
  thinkingBudget: number = 512,
  maxRetries: number = 3
): Promise<GeminiCallResult<T>> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await rawCall(
        apiKey,
        activeModel,
        prompt,
        imageBase64,
        schema,
        thinkingBudget
      );

      if (response.error) {
        throw new Error(`Gemini error: ${response.error.message}`);
      }

      return { parsed: extractJson<T>(response), raw: response };
    } catch (err) {
      lastError = err as Error;
      const msg = lastError.message;

      // Retry on 429 (rate limit) or 503 (overloaded)
      if (msg.includes("429") || msg.includes("503")) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.log(`  Gemini ${msg.slice(0, 30)}... retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }

      // Non-retryable error
      throw lastError;
    }
  }

  throw lastError ?? new Error("callGemini exhausted retries");
}

/**
 * Call Gemini in parallel for multiple prompts on the same image.
 * Returns array of { parsed, raw } results.
 */
export async function callGeminiParallel<T extends unknown[]>(
  apiKey: string,
  calls: Array<{
    prompt: string;
    schema: GeminiSchema;
    thinkingBudget: number;
  }>,
  imageBase64: string
): Promise<{ [K in keyof T]: GeminiCallResult<T[K]> }> {
  const results = await Promise.all(
    calls.map((c) =>
      callGemini(apiKey, c.prompt, imageBase64, c.schema, c.thinkingBudget)
    )
  );
  return results as { [K in keyof T]: GeminiCallResult<T[K]> };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
