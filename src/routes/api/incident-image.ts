import { createFileRoute } from "@tanstack/react-router";
import { generateImage, imageSettings } from "@/lib/image-gateway.server";

export const Route = createFileRoute("/api/incident-image")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { prompt, stream = true } = await request.json();
        if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 2000) {
          return new Response("Invalid prompt", { status: 400 });
        }
        const apiKey = process.env["LOVABLE_API_KEY"];
        if (!apiKey) return new Response("Missing LOVABLE_API_KEY", { status: 500 });
        const upstream = await generateImage({ ...imageSettings, apiKey }, prompt, stream);
        return new Response(upstream.body, {
          status: upstream.status,
          headers: {
            "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
            "Cache-Control": "no-cache",
          },
        });
      },
    },
  },
});
