import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

export const mistralChat = createServerFn({ method: "POST" })
  .inputValidator((data) =>
    z
      .object({
        messages: z.array(messageSchema).min(1),
        model: z.string().default("mistral-large-latest"),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const apiKey = process.env["MISTRAL_API_KEY"];
    if (!apiKey) throw new Error("MISTRAL_API_KEY is not configured");

    const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: data.model,
        messages: data.messages,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Mistral API error ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    return { content: json.choices[0]?.message.content ?? "" };
  });

export const listMistralModels = createServerFn({ method: "GET" }).handler(
  async () => {
    const apiKey = process.env["MISTRAL_API_KEY"];
    if (!apiKey) throw new Error("MISTRAL_API_KEY is not configured");

    const res = await fetch("https://api.mistral.ai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`Mistral API error ${res.status}`);
    const json = (await res.json()) as { data: { id: string }[] };
    return { models: json.data.map((m) => m.id) };
  },
);
