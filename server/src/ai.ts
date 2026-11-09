import { z } from "zod";

/** One call for all three AI jobs: prompt in, zod-validated JSON out. Never free prose. */
export async function generateJson<T extends z.ZodType>(
  schema: T,
  system: string,
  user: string,
  retries = 2
): Promise<z.infer<T>> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(`${process.env.AI_BASE_URL}/chat/completions`, {
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
                z.toJSONSchema(schema)
              )}`,
            },
            { role: "user", content: user },
          ],
        }),
      });

      if (!r.ok) {
        const text = await r.text();
        throw new Error(`ai ${r.status}: ${text}`);
      }

      const j = (await r.json()) as { choices: { message: { content: string } }[] };
      const raw = j.choices[0]?.message?.content?.trim() ?? "{}";
      const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
      return schema.parse(JSON.parse(cleaned));
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        // Exponential backoff: 500ms, 1500ms
        await new Promise((res) => setTimeout(res, 500 * Math.pow(2, attempt)));
      }
    }
  }

  throw lastError;
}
