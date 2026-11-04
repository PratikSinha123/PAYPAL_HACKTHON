import { z } from "zod";

/** One call for all three AI jobs: prompt in, zod-validated JSON out. Never free prose. */
export async function generateJson<T extends z.ZodType>(schema: T, system: string, user: string): Promise<z.infer<T>> {
  const r = await fetch(`${process.env.AI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.AI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.AI_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${system}\nReply with JSON only, matching this JSON Schema:\n${JSON.stringify(z.toJSONSchema(schema))}` },
        { role: "user", content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`ai ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { choices: { message: { content: string } }[] };
  return schema.parse(JSON.parse(j.choices[0].message.content)); // throws if the model drifts from the schema
}
