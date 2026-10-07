import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { makeImagePrompt } from "@/lib/chonk.functions";
import { streamImage } from "@/lib/stream-image";
import { Button } from "@/components/ui/button";
import { Palette } from "lucide-react";

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
      <Button variant="link" onClick={draw} className="mt-1 h-auto px-0 py-0 font-mono text-[11px] text-accent underline">
        <Palette aria-hidden="true" /> Sketch this observation
      </Button>
    );
  }

  return (
    <div className="mt-2">
      {img && (
        <img
          src={img}
          alt="Illustration based on this observation"
          className={`w-full rounded-sm border border-border transition-[filter] ${final ? "blur-0" : "blur-2xl"}`}
        />
      )}
      {state === "prompting" && <p className="font-mono text-[11px] text-muted-foreground">Mistral is imagining the scene…</p>}
      {state === "drawing" && !img && <p className="font-mono text-[11px] text-muted-foreground">Drawing…</p>}
      {state === "error" && (
        <p className="font-mono text-[11px] text-destructive">
          Sketch failed: {err}{" "}
          <Button variant="link" onClick={draw} className="h-auto px-0 py-0 text-[11px] text-destructive underline">
            retry
          </Button>
        </p>
      )}
    </div>
  );
}
