// Minimal model client. One prompt in, one text answer out.
// Only erasable TypeScript syntax is used so Node can run this file directly.

export interface LlmClient {
  readonly name: string;
  complete(prompt: string): Promise<string>;
}

/** The daily quota is used up: retrying today is pointless. */
export class QuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExhaustedError";
  }
}

export class LlmError extends Error {
  status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "LlmError";
    this.status = status;
  }
}

const BASE = "https://generativelanguage.googleapis.com/v1beta";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface GeminiOptions {
  apiKey: string;
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  maxRetries?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryDelayMs(body: string): number | undefined {
  const m = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return m ? Math.ceil(Number(m[1]) * 1000) + 1000 : undefined;
}

function extractText(json: any): string {
  const parts: any[] = json?.candidates?.[0]?.content?.parts ?? [];
  // Skip "thought" parts some models return; keep only the visible answer.
  const text = parts
    .filter((p) => !p?.thought && typeof p?.text === "string")
    .map((p) => p.text)
    .join("");
  if (text.trim()) return text;
  const why = json?.promptFeedback?.blockReason ?? json?.candidates?.[0]?.finishReason ?? "no text";
  throw new LlmError(`Empty model response (${why})`);
}

/**
 * Google AI Studio (Gemini API) client. The key travels in a header, never in the URL.
 * Everything goes in ONE user message: some open models (Gemma) do not accept a
 * separate system instruction.
 */
export function createGeminiClient(opts: GeminiOptions): LlmClient {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const sleep = opts.sleep ?? realSleep;
  const maxRetries = opts.maxRetries ?? 4;
  const url = `${BASE}/models/${encodeURIComponent(opts.model)}:generateContent`;

  return {
    name: opts.model,
    async complete(prompt: string): Promise<string> {
      for (let attempt = 0; ; attempt++) {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: opts.temperature ?? 0.7,
              maxOutputTokens: opts.maxOutputTokens ?? 4096,
            },
          }),
        });
        const body = await res.text();
        if (res.ok) return extractText(JSON.parse(body));

        if (res.status === 429) {
          // Heuristic: Google names the per-day quota in the error details.
          if (/per\s*day/i.test(body)) {
            throw new QuotaExhaustedError("Daily quota exhausted for this model (resets at midnight Pacific).");
          }
          if (attempt < maxRetries) {
            await sleep(retryDelayMs(body) ?? 15000 * (attempt + 1));
            continue;
          }
        } else if (res.status >= 500 && attempt < maxRetries) {
          await sleep(5000 * (attempt + 1));
          continue;
        }
        throw new LlmError(`Gemini HTTP ${res.status}: ${body.slice(0, 300)}`, res.status);
      }
    },
  };
}

/** Lists model ids that can answer generateContent (handy to find the exact Gemma id). */
export async function listGeminiModels(apiKey: string, fetchImpl?: FetchLike): Promise<string[]> {
  const f: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init));
  const res = await f(`${BASE}/models?pageSize=200`, { method: "GET", headers: { "x-goog-api-key": apiKey } });
  const body = await res.text();
  if (!res.ok) throw new LlmError(`Gemini HTTP ${res.status}: ${body.slice(0, 300)}`, res.status);
  const models: any[] = JSON.parse(body).models ?? [];
  return models
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => String(m.name).replace(/^models\//, ""))
    .sort();
}
