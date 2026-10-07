import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

// Sarcastic narrator: ElevenLabs v3 with audio tags. Voice "Chris".
const VOICE_ID = "iP95p4xoKVk53GoZ742B";

const Body = z.object({ text: z.string().min(1).max(4500) });

export const Route = createFileRoute("/api/tts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const parsed = Body.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return new Response("Invalid text", { status: 400 });
        const key = process.env["ELEVENLABS_API_KEY"];
        if (!key) return new Response("ElevenLabs is not connected", { status: 500 });

        const text = parsed.data.text.trimStart().startsWith("[")
          ? parsed.data.text
          : `[sarcastic] ${parsed.data.text}`;

        const res = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`,
          {
            method: "POST",
            headers: { "xi-api-key": key, "Content-Type": "application/json" },
            body: JSON.stringify({
              text,
              model_id: "eleven_v3",
              voice_settings: { stability: 0.0, similarity_boost: 0.75 },
            }),
          },
        );
        if (!res.ok) {
          const err = await res.text();
          console.error(`ElevenLabs ${res.status}: ${err}`);
          return new Response(`Voice failed (${res.status}): ${err.slice(0, 200)}`, { status: res.status });
        }
        return new Response(res.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
      },
    },
  },
});
