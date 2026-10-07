import { useEffect, useRef, useState } from "react";

// Single shared player so only one clip plays at a time.
let current: { audio: HTMLAudioElement; stop: () => void } | null = null;

export function SpeakButton({ text, label = "▶ Read it", className = "" }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "loading" | "playing" | "error">("idle");
  const urlRef = useRef<string | null>(null);

  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  async function play() {
    if (state === "playing" || state === "loading") {
      current?.stop();
      return;
    }
    current?.stop();
    setState("loading");
    try {
      if (!urlRef.current) {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error(await res.text());
        urlRef.current = URL.createObjectURL(await res.blob());
      }
      const audio = new Audio(urlRef.current);
      const stop = () => {
        audio.pause();
        setState("idle");
        if (current?.audio === audio) current = null;
      };
      current = { audio, stop };
      audio.onended = stop;
      setState("playing");
      await audio.play();
    } catch (e) {
      console.error(e);
      setState("error");
    }
  }

  return (
    <button onClick={play} className={`font-mono text-[11px] underline-offset-2 hover:underline ${className}`}>
      {state === "loading" ? "… warming up the sarcasm" : state === "playing" ? "■ Stop" : state === "error" ? "Voice failed, retry" : label}
    </button>
  );
}
