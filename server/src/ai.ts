import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const RETRYABLE_STATUS = new Set([429, 503]);
const DELAYS_MS = [1000, 2000, 4000];
const ATTEMPT_TIMEOUT_MS = 20_000; // 20s per attempt

/** Fetch with a manual abort timeout that is cleanly cancelled on success/failure. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("attempt timed out after 20s")), ATTEMPT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** One call for all three AI jobs: prompt in, zod-validated JSON out. Never free prose. */
export async function generateJson<T extends z.ZodType>(
  schema: T,
  system: string,
  user: string,
  retries = DELAYS_MS.length
): Promise<z.infer<T>> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let r: Response | undefined;
    try {
      r = await fetchWithTimeout(`${process.env.AI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.AI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.AI_MODEL,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `${system}\nReply with valid JSON only, strictly matching this JSON Schema:\n${JSON.stringify(
                zodToJsonSchema(schema)
              )}`,
            },
            { role: "user", content: user },
          ],
        }),
      });
    } catch (err) {
      // Network-level errors (timeout, connection refused, etc.) are retryable
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        const delay = DELAYS_MS[attempt] ?? 1000 * Math.pow(2, attempt);
        console.warn(`ai fetch failed (${lastError.message}), retrying in ${delay}ms (attempt ${attempt + 1}/${retries})...`);
        await new Promise((res) => setTimeout(res, delay));
      }
      continue;
    }

    if (r.ok) {
      const j = (await r.json()) as { choices: { message: { content: string } }[] };
      const raw = j.choices[0]?.message?.content?.trim() ?? "{}";
      const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
      return schema.parse(JSON.parse(cleaned)); // throws if model drifts from schema
    }

    // Don't retry on auth or not-found errors
    if (!RETRYABLE_STATUS.has(r.status)) {
      throw new Error(`ai ${r.status}: ${await r.text()}`);
    }

    lastError = new Error(`ai ${r.status}: ${await r.text()}`);

    if (attempt < retries) {
      const delay = DELAYS_MS[attempt] ?? 1000 * Math.pow(2, attempt);
      console.warn(`ai request failed with ${r.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})...`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }

  throw lastError!;
}
