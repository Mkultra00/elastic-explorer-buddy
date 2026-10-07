import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { makeImagePrompt } from "@/lib/chonk.functions";
import { streamImage } from "@/lib/stream-image";

type Props = { note: string; label: string };

export function NoteSketch({ note, label }: Props) {
  const promptFn = useServerFn(makeImagePrompt);
  const [state, setState] = useState<"idle" | "prompting" | "drawing" | "done" | "error">("idle");
  const [img, setImg] = useState<string | null>(null);
  const [final, setFinal] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function draw() {
    setState("prompting");
    setErr(null);
    try {
      const { prompt } = await promptFn({ data: { note, label } });
      setState("drawing");
      await streamImage("/api/incident-image", { prompt }, (url, isFinal) => {
        setImg(url);
        setFinal(isFinal);
      });
      setState("done");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }

  if (state === "idle") {
    return (
      <button onClick={draw} className="mt-1 font-mono text-[11px] text-accent underline">
        🎨 Sketch this incident
      </button>
    );
  }

  return (
    <div className="mt-2">
      {img && (
        <img
          src={img}
          alt="Mistral's sketch of the incident"
          className={`w-full rounded-sm border border-border transition-[filter] ${final ? "blur-0" : "blur-2xl"}`}
        />
      )}
      {state === "prompting" && <p className="font-mono text-[11px] text-muted-foreground">Mistral is imagining the scene…</p>}
      {state === "drawing" && !img && <p className="font-mono text-[11px] text-muted-foreground">Drawing…</p>}
      {state === "error" && (
        <p className="font-mono text-[11px] text-destructive">
          Sketch failed: {err}{" "}
          <button onClick={draw} className="underline">
            retry
          </button>
        </p>
      )}
    </div>
  );
}
