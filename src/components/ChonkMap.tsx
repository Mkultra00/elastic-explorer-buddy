import { useMemo } from "react";
import type { HectareStat, Pin } from "@/lib/chonk.functions";

export type Metric = "disturbance_rate" | "incidents" | "observations";

type Poly = { id: string; hectare: string | null; ring: number[][] };

const ANGLE = (-61 * Math.PI) / 180; // rotate the park so its long axis runs horizontally
const LAT0 = 40.7825;
const LON0 = -73.9655;
const KX = Math.cos((LAT0 * Math.PI) / 180);

function project(lon: number, lat: number): [number, number] {
  const dx = (lon - LON0) * KX;
  const dy = lat - LAT0;
  const x = dx * Math.cos(ANGLE) - dy * Math.sin(ANGLE);
  const y = dx * Math.sin(ANGLE) + dy * Math.cos(ANGLE);
  return [x, -y];
}

export function metricValue(s: HectareStat | undefined, m: Metric) {
  if (!s) return 0;
  if (m === "observations") return s.observations;
  if (m === "incidents") return s.incidents;
  return s.observations ? s.disturbances / s.observations : 0;
}

export function ChonkMap({
  polygons,
  stats,
  pins,
  metric,
  selected,
  onSelect,
}: {
  polygons: Poly[];
  stats: HectareStat[];
  pins: Pin[];
  metric: Metric;
  selected: string | null;
  onSelect: (h: string) => void;
}) {
  const byH = useMemo(() => new Map(stats.map((s) => [s.hectare, s])), [stats]);
  const { shapes, bounds } = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const shapes = polygons.map((p) => {
      const pts = p.ring.map(([lon, lat]) => project(lon, lat));
      for (const [x, y] of pts) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      return { ...p, d: "M" + pts.map((q) => q.join(",")).join("L") + "Z" };
    });
    return { shapes, bounds: { minX, minY, w: maxX - minX, h: maxY - minY } };
  }, [polygons]);

  const max = useMemo(() => {
    let m = 0;
    for (const s of stats) m = Math.max(m, metricValue(s, metric));
    return m || 1;
  }, [stats, metric]);

  const pad = bounds.w * 0.01;
  const pinR = bounds.w * 0.0028;
  // Story badges: one per hectare with stories
  const centroids = useMemo(() => {
    const c = new Map<string, [number, number]>();
    for (const p of polygons) {
      if (!p.hectare || c.has(p.hectare)) continue;
      const pts = p.ring.slice(0, -1).map(([lon, lat]) => project(lon, lat));
      c.set(p.hectare, [pts.reduce((a, q) => a + q[0], 0) / pts.length, pts.reduce((a, q) => a + q[1], 0) / pts.length]);
    }
    return c;
  }, [polygons]);

  return (
    <svg
      viewBox={`${bounds.minX - pad} ${bounds.minY - pad} ${bounds.w + pad * 2} ${bounds.h + pad * 2}`}
      className="h-auto w-full"
      role="img"
      aria-label="Central Park hectare map"
    >
      {shapes.map((s) => {
        const v = metricValue(s.hectare ? byH.get(s.hectare) : undefined, metric);
        const pct = Math.round(Math.sqrt(v / max) * 90);
        const isSel = s.hectare && s.hectare === selected;
        return (
          <path
            key={s.id}
            d={s.d}
            onClick={() => s.hectare && onSelect(s.hectare)}
            style={{
              fill: s.hectare ? `color-mix(in oklch, var(--accent) ${pct}%, var(--card))` : "var(--muted)",
              stroke: isSel ? "var(--foreground)" : "var(--border)",
              strokeWidth: isSel ? pinR * 0.9 : pinR * 0.25,
              cursor: s.hectare ? "pointer" : "default",
            }}
          >
            <title>
              {s.hectare ?? "unlabeled"} · {byH.get(s.hectare ?? "")?.observations ?? 0} obs ·{" "}
              {byH.get(s.hectare ?? "")?.disturbances ?? 0} disturbances · {byH.get(s.hectare ?? "")?.incidents ?? 0} incidents
            </title>
          </path>
        );
      })}
      {stats
        .filter((s) => s.stories > 0 && centroids.has(s.hectare))
        .map((s) => {
          const [x, y] = centroids.get(s.hectare)!;
          return (
            <circle key={"st" + s.hectare} cx={x} cy={y} r={pinR * 0.6} style={{ fill: "var(--primary)", opacity: 0.35, pointerEvents: "none" }} />
          );
        })}
      {pins.map((p) => {
        const [x, y] = project(p.lon, p.lat);
        const inc = p.label !== "disturbance";
        return (
          <circle
            key={p.id}
            cx={x}
            cy={y}
            r={inc ? pinR * 1.6 : pinR}
            style={{
              fill: inc ? "var(--destructive)" : "var(--primary)",
              stroke: "var(--card)",
              strokeWidth: pinR * 0.35,
              pointerEvents: "none",
            }}
          />
        );
      })}
    </svg>
  );
}
