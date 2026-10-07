import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useRef, useState } from "react";
import { SpeakButton } from "@/components/SpeakButton";
import { ChonkMap, metricValue, type Metric } from "@/components/ChonkMap";
import {
  classifyBatch,
  generateBriefing,
  getHectare,
  getMapData,
  getProgress,
  runFixtures,
  setupChonk,
} from "@/lib/chonk.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "CHONK RADAR — Central Park squirrel incident map" },
      {
        name: "description",
        content: "Mistral classifies 2018 Squirrel Census notes into incidents and disturbances; Elasticsearch maps them by hectare.",
      },
      { property: "og:title", content: "CHONK RADAR — Central Park squirrel incident map" },
      { property: "og:description", content: "An early-warning method demo built on the 2018 Central Park Squirrel Census." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function Index() {
  const qc = useQueryClient();
  const setupFn = useServerFn(setupChonk);
  const classifyFn = useServerFn(classifyBatch);
  const progressFn = useServerFn(getProgress);
  const mapFn = useServerFn(getMapData);
  const hectareFn = useServerFn(getHectare);
  const fixturesFn = useServerFn(runFixtures);
  const briefingFn = useServerFn(generateBriefing);
  const [briefing, setBriefing] = useState<{ script: string; display: string } | null>(null);
  const [briefingBusy, setBriefingBusy] = useState(false);

  async function makeBriefing() {
    setBriefingBusy(true);
    setError(null);
    try {
      setBriefing(await briefingFn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBriefingBusy(false);
    }
  }

  const progress = useQuery({ queryKey: ["progress"], queryFn: () => progressFn(), retry: false });
  const map = useQuery({ queryKey: ["map"], queryFn: () => mapFn(), retry: false });
  const [selected, setSelected] = useState<string | null>(null);
  const hectare = useQuery({
    queryKey: ["hectare", selected],
    queryFn: () => hectareFn({ data: { hectare: selected! } }),
    enabled: !!selected,
  });
  const fixtures = useQuery({ queryKey: ["fixtures"], queryFn: () => fixturesFn(), enabled: false });

  const [metric, setMetric] = useState<Metric>("disturbance_rate");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);

  async function ingest() {
    setError(null);
    setBusy("Pulling NYC Open Data and indexing into Elastic…");
    try {
      await setupFn({ data: { reset: true } });
      await Promise.all([qc.invalidateQueries({ queryKey: ["progress"] }), qc.invalidateQueries({ queryKey: ["map"] })]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function classify() {
    setError(null);
    stopRef.current = false;
    setBusy("Mistral is reading field notes…");
    let backoff = 2000;
    try {
      for (let i = 0; i < 200 && !stopRef.current; i++) {
        const r = await classifyFn({ data: { size: 25 } });
        if (r.done) break;
        if (r.retryAfter) {
          setBusy(`Rate limited by Mistral, waiting ${Math.round(backoff / 1000)}s…`);
          await sleep(backoff + Math.random() * 500);
          backoff = Math.min(backoff * 2, 30000);
          continue;
        }
        backoff = 2000;
        setBusy("Mistral is reading field notes…");
        await qc.invalidateQueries({ queryKey: ["progress"] });
        if (i % 4 === 3) qc.invalidateQueries({ queryKey: ["map"] });
      }
      await Promise.all([qc.invalidateQueries({ queryKey: ["progress"] }), qc.invalidateQueries({ queryKey: ["map"] })]);
      fixtures.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const p = progress.data;
  const m = map.data?.ready ? map.data : null;
  const pct = p && p.toClassify ? Math.round((p.classified / p.toClassify) * 100) : 0;
  const totals = m
    ? m.stats.reduce(
        (a, s) => ({ obs: a.obs + s.observations, inc: a.inc + s.incidents, dist: a.dist + s.disturbances }),
        { obs: 0, inc: 0, dist: 0 },
      )
    : null;
  const leaderboard = m
    ? [...m.stats].filter((s) => s.observations >= 5).sort((a, b) => metricValue(b, "disturbance_rate") - metricValue(a, "disturbance_rate")).slice(0, 8)
    : [];

  return (
    <div className="min-h-screen bg-background font-sans text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-7xl flex-wrap items-end justify-between gap-4 px-6 py-6">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
              Field report · Central Park · Oct 2018
            </p>
            <h1 className="font-display text-5xl font-black tracking-tight">
              CHONK <span className="text-accent">RADAR</span>
            </h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              Mistral reads every census note and labels it as an incident or a disturbance. Elasticsearch adds them up
              per hectare. It's a demo of the method, not proof of an outbreak.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
            <button
              onClick={ingest}
              disabled={!!busy}
              className="rounded-sm border border-primary px-3 py-2 text-primary hover:bg-primary hover:text-primary-foreground disabled:opacity-50"
            >
              1 · Load data
            </button>
            <button
              onClick={classify}
              disabled={!!busy || !p?.toClassify}
              className="rounded-sm bg-primary px-3 py-2 text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              2 · Classify with Mistral
            </button>
            {busy && (
              <button onClick={() => (stopRef.current = true)} className="rounded-sm border border-border px-3 py-2">
                Stop
              </button>
            )}
          </div>
        </div>
        <div className="mx-auto max-w-7xl px-6 pb-4">
          <div className="flex items-center gap-3 font-mono text-xs text-muted-foreground">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
            </div>
            <span>
              {p ? `${p.classified}/${p.toClassify} notes classified · ${p.obsTotal} observations indexed` : "not loaded"}
            </span>
          </div>
          {busy && <p className="mt-2 font-mono text-xs text-accent">{busy}</p>}
          {error && <p className="mt-2 font-mono text-xs text-destructive">{error}</p>}
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-6 px-6 py-6 lg:grid-cols-[1fr_380px]">
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-1 font-mono text-xs">
              {(
                [
                  ["disturbance_rate", "Disturbances / observation"],
                  ["incidents", "Incidents (n)"],
                  ["observations", "Observation effort"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setMetric(k)}
                  className={`rounded-sm px-2.5 py-1.5 ${metric === k ? "bg-foreground text-background" : "bg-secondary text-secondary-foreground"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-full bg-destructive" /> incident</span>
              <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full bg-primary" /> disturbance</span>
              <span>← S · N →</span>
            </div>
          </div>
          <div className="rounded-sm border border-border bg-card p-3">
            {m ? (
              <ChonkMap polygons={m.polygons} stats={m.stats} pins={m.pins} metric={metric} selected={selected} onSelect={setSelected} />
            ) : (
              <div className="flex h-72 items-center justify-center font-mono text-sm text-muted-foreground">
                {map.isLoading ? "Loading map…" : "No data yet. Press “1 · Load data”."}
              </div>
            )}
          </div>

          {m && (
            <div className="rounded-sm border border-foreground bg-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-display text-2xl font-black">Situation briefing</h3>
                <div className="flex gap-3">
                  <button onClick={makeBriefing} disabled={briefingBusy} className="font-mono text-[11px] underline disabled:opacity-50">
                    {briefingBusy ? "Mistral is rolling its eyes…" : briefing ? "Regenerate" : "Write briefing"}
                  </button>
                  {briefing && <SpeakButton key={briefing.script} text={briefing.script} label="▶ Hear it (sarcastic)" className="text-accent" />}
                </div>
              </div>
              <p className="mb-2 font-mono text-[11px] text-muted-foreground">Mistral writes it from the Elastic totals, ElevenLabs reads it out</p>
              {briefing ? (
                <p className="text-sm leading-relaxed">{briefing.display}</p>
              ) : (
                <p className="text-sm text-muted-foreground">One minute of park intelligence, delivered by someone who would rather be anywhere else.</p>
              )}
            </div>
          )}

          {totals && (
            <div className="grid grid-cols-3 gap-3">
              {[
                ["Observations", totals.obs],
                ["Disturbance notes", totals.dist],
                ["Incident notes", totals.inc],
              ].map(([k, v]) => (
                <div key={k} className="rounded-sm border border-border bg-card p-3">
                  <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">{k}</p>
                  <p className="font-display text-3xl font-bold">{v}</p>
                </div>
              ))}
            </div>
          )}

          {m && m.disturbanceTypes.length > 0 && (
            <div className="rounded-sm border border-border bg-card p-4">
              <h3 className="font-display text-lg font-bold">What's disturbing the squirrels</h3>
              <p className="mb-3 font-mono text-[11px] text-muted-foreground">
                disturbance notes by cause, as labeled by Mistral · biggest cause:{" "}
                <span className="text-accent">{m.disturbanceTypes[0].key.replace(/_/g, " ")}</span> (
                {m.disturbanceTypes[0].count})
              </p>
              <div className="space-y-2">
                {m.disturbanceTypes.map((t) => (
                  <div key={t.key} className="flex items-center gap-3">
                    <span className="w-36 shrink-0 font-mono text-xs text-muted-foreground">{t.key.replace(/_/g, " ")}</span>
                    <div className="h-4 flex-1 rounded-sm bg-muted">
                      <div
                        className="h-4 rounded-sm bg-primary"
                        style={{ width: `${Math.max(2, (t.count / m.disturbanceTypes[0].count) * 100)}%` }}
                      />
                    </div>
                    <span className="w-10 shrink-0 text-right font-mono text-xs">{t.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {m && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-sm border border-border bg-card p-4">
                <h3 className="font-display text-lg font-bold">Most disturbed hectares</h3>
                <p className="mb-2 font-mono text-[11px] text-muted-foreground">disturbances per observation, only hectares with at least 5 observations</p>
                <ol className="space-y-1 font-mono text-xs">
                  {leaderboard.map((s) => (
                    <li key={s.hectare}>
                      <button onClick={() => setSelected(s.hectare)} className="flex w-full justify-between hover:text-accent">
                        <span>{s.hectare}</span>
                        <span>
                          {(metricValue(s, "disturbance_rate") * 100).toFixed(0)}% · {s.disturbances}/{s.observations} · inc {s.incidents}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="rounded-sm border border-border bg-card p-4">
                <h3 className="font-display text-lg font-bold">Fixtures</h3>
                <p className="mb-2 font-mono text-[11px] text-muted-foreground">the 3 confirmed incidents must be labeled as incidents</p>
                <button onClick={() => fixtures.refetch()} className="mb-2 font-mono text-xs underline">
                  {fixtures.isFetching ? "Running…" : "Run fixtures"}
                </button>
                <ul className="space-y-2 font-mono text-xs">
                  {fixtures.data?.map((f) => (
                    <li key={f.hectare}>
                      <span className={f.pass ? "text-primary" : "text-destructive"}>{f.pass ? "PASS" : "FAIL"}</span>{" "}
                      {f.hectare} → {f.label}
                      <p className="truncate text-muted-foreground">{f.note}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </section>

        <aside className="rounded-sm border border-border bg-card p-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
          {!selected ? (
            <div className="font-mono text-sm text-muted-foreground">Click a hectare to read its notes and stories.</div>
          ) : (
            <>
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="font-display text-3xl font-black">{selected}</h2>
                {hectare.data && hectare.data.length > 0 && (
                  <SpeakButton
                    key={selected}
                    text={`Hectare ${selected}. ` + hectare.data.slice(0, 6).map((n) => n.text).join(" ... ")}
                    label="▶ Read all"
                    className="text-accent"
                  />
                )}
                <span className="font-mono text-xs text-muted-foreground">n = {hectare.data?.length ?? "…"} notes</span>
              </div>
              {hectare.isLoading && <p className="font-mono text-xs">Loading…</p>}
              <ul className="space-y-3">
                {hectare.data?.map((n) => (
                  <li key={n.id} className="border-l-2 pl-3" style={{ borderColor: labelColor(n.ai?.primary_label) }}>
                    <div className="flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      <span>{n.kind}</span>
                      <span>{n.date} {n.shift}</span>
                      {n.ai && (
                        <span style={{ color: labelColor(n.ai.primary_label) }}>
                          {n.ai.primary_label}
                          {n.ai.incident_type || n.ai.disturbance_type ? `/${n.ai.incident_type ?? n.ai.disturbance_type}` : ""} ·{" "}
                          {Math.round(n.ai.confidence * 100)}%
                        </span>
                      )}
                    </div>
                    {n.ai?.one_liner && <p className="font-display text-sm font-bold">{n.ai.one_liner}</p>}
                    <p className="text-sm">{n.text}</p>
                    <SpeakButton text={n.ai?.one_liner ? `${n.ai.one_liner}. ${n.text}` : n.text} className="text-muted-foreground" />
                    {n.ai?.evidence && (
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                        evidence: “{n.ai.evidence}” {n.ai.evidence_verified ? "✓ verbatim" : "⚠ not found in note"}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </main>
    </div>
  );
}

function labelColor(l?: string) {
  if (l === "incident" || l === "cross_species_incident") return "var(--destructive)";
  if (l === "disturbance") return "var(--primary)";
  return "var(--border)";
}
