// Server-only helpers for CHONK RADAR: Socrata, Elasticsearch, Mistral.
import { createHash } from "crypto";

export const IDX = {
  obs: "chonk_observations",
  stories: "chonk_stories",
  hectares: "chonk_hectares",
} as const;

export const PROMPT_VERSION = "v1";
export const CLASSIFY_MODEL = "mistral-small-latest";

const SOCRATA = "https://data.cityofnewyork.us/resource";

/* ---------------- Elasticsearch ---------------- */

export async function es(path: string, init: RequestInit = {}) {
  const url = process.env["ELASTICSEARCH_URL"];
  const key = process.env["ELASTIC_API_KEY"];
  if (!url || !key) throw new Error("Elastic is not configured");
  const res = await fetch(`${url.replace(/\/+$/, "")}${path}`, {
    ...init,
    headers: {
      Authorization: `ApiKey ${key}`,
      "Content-Type": init.body && path.includes("_bulk") ? "application/x-ndjson" : "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  return { status: res.status, ok: res.ok, json };
}

async function esOk(path: string, init: RequestInit = {}) {
  const r = await es(path, init);
  if (!r.ok) throw new Error(`Elastic ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
  return r.json;
}

export async function bulk(lines: unknown[]) {
  if (!lines.length) return { errors: false, items: [] };
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const r = await esOk("/_bulk?refresh=wait_for", { method: "POST", body });
  if (r.errors) {
    const first = r.items.find((i: any) => Object.values(i as object)[0]?.error);
    throw new Error(`Bulk errors: ${JSON.stringify(first).slice(0, 300)}`);
  }
  return r;
}

const AI_MAPPING = {
  properties: {
    primary_label: { type: "keyword" },
    incident_type: { type: "keyword" },
    disturbance_type: { type: "keyword" },
    subject: { type: "keyword" },
    confidence: { type: "float" },
    evidence: { type: "text" },
    evidence_verified: { type: "boolean" },
    weird_score: { type: "float" },
    one_liner: { type: "text" },
    model: { type: "keyword" },
    prompt_version: { type: "keyword" },
    classified_at: { type: "date" },
  },
};

const MAPPINGS: Record<string, unknown> = {
  [IDX.obs]: {
    dynamic: "strict",
    properties: {
      unique_squirrel_id: { type: "keyword" },
      hectare: { type: "keyword" },
      shift: { type: "keyword" },
      obs_date: { type: "date", format: "strict_date" },
      location: { type: "geo_point" },
      age: { type: "keyword" },
      primary_fur_color: { type: "keyword" },
      behaviors: {
        properties: Object.fromEntries(
          ["kuks", "quaas", "moans", "tail_flags", "tail_twitches", "approaches", "indifferent", "runs_from", "chasing"].map(
            (k) => [k, { type: "boolean" }],
          ),
        ),
      },
      other_activities: { type: "text" },
      other_interactions: { type: "text" },
      color_notes: { type: "text" },
      note_text: { type: "text" },
      has_note: { type: "boolean" },
      ai: AI_MAPPING,
    },
  },
  [IDX.stories]: {
    dynamic: "strict",
    properties: {
      story_id: { type: "keyword" },
      story_date: { type: "date", format: "strict_date" },
      hectare: { type: "keyword" },
      shift: { type: "keyword" },
      story_topic_squirrel: { type: "keyword" },
      note: { type: "text" },
      has_note: { type: "boolean" },
      location: { type: "geo_point" },
      ai: AI_MAPPING,
    },
  },
  [IDX.hectares]: {
    dynamic: "strict",
    properties: {
      hectare: { type: "keyword" },
      grid_id: { type: "keyword" },
      centroid: { type: "geo_point" },
      polygon: { type: "object", enabled: false },
    },
  },
};

export async function ensureIndices(reset: boolean) {
  const out: Record<string, string> = {};
  for (const [name, mappings] of Object.entries(MAPPINGS)) {
    const exists = await es(`/${name}`, { method: "HEAD" });
    if (exists.status === 200 && reset) await esOk(`/${name}`, { method: "DELETE" });
    if (exists.status !== 200 || reset) {
      await esOk(`/${name}`, { method: "PUT", body: JSON.stringify({ mappings }) });
      out[name] = "created";
    } else out[name] = "exists";
  }
  return out;
}

/* ---------------- Socrata ingest ---------------- */

async function socrata(id: string): Promise<any[]> {
  const res = await fetch(`${SOCRATA}/${id}.json?$limit=10000`);
  if (!res.ok) throw new Error(`NYC Open Data ${id} returned ${res.status}`);
  return res.json();
}

function mmddyyyy(d?: string) {
  if (!d || d.length !== 8) return undefined;
  return `${d.slice(4)}-${d.slice(0, 2)}-${d.slice(2, 4)}`;
}

function clean(s?: string) {
  const t = (s ?? "").trim();
  return t.length ? t : undefined;
}

function pointInRing(x: number, y: number, ring: [number, number][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export async function ingestAll() {
  const [squirrels, stories, grid] = await Promise.all([
    socrata("vfnx-vebw"),
    socrata("gfqj-f768"),
    socrata("qad5-y26n"),
  ]);

  // Geo sanity check: x ≈ -73.97 (lon), y ≈ 40.78 (lat). Abort otherwise.
  const s0 = squirrels[0];
  const x0 = Number(s0?.x);
  const y0 = Number(s0?.y);
  if (!(Math.abs(x0 + 73.97) < 0.1 && Math.abs(y0 - 40.78) < 0.1)) {
    throw new Error(`Geo sanity check failed: x=${x0}, y=${y0}`);
  }

  // Label grid polygons by majority hectare of squirrels inside them
  // (the grid dataset ships no hectare code).
  const polys = grid.map((g) => {
    const ring: [number, number][] = g.the_geom.coordinates[0][0];
    const cx = ring.slice(0, -1).reduce((a, p) => a + p[0], 0) / (ring.length - 1);
    const cy = ring.slice(0, -1).reduce((a, p) => a + p[1], 0) / (ring.length - 1);
    return { id: String(g.id), ring, cx, cy, votes: new Map<string, number>() };
  });
  for (const s of squirrels) {
    const x = Number(s.x);
    const y = Number(s.y);
    const p = polys.find((p) => pointInRing(x, y, p.ring));
    if (p) p.votes.set(s.hectare, (p.votes.get(s.hectare) ?? 0) + 1);
  }
  const hectareCentroid = new Map<string, { lat: number; lon: number }>();
  const hectareDocs: unknown[] = [];
  for (const p of polys) {
    const best = [...p.votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (best && !hectareCentroid.has(best)) hectareCentroid.set(best, { lat: p.cy, lon: p.cx });
    hectareDocs.push({ index: { _index: IDX.hectares, _id: p.id } });
    hectareDocs.push({
      hectare: best ?? null,
      grid_id: p.id,
      centroid: { lat: p.cy, lon: p.cx },
      polygon: p.ring,
    });
  }
  // Fallback centroid for hectares not matched to a polygon: mean of squirrel points.
  const acc = new Map<string, { x: number; y: number; n: number }>();
  for (const s of squirrels) {
    const a = acc.get(s.hectare) ?? { x: 0, y: 0, n: 0 };
    a.x += Number(s.x);
    a.y += Number(s.y);
    a.n++;
    acc.set(s.hectare, a);
  }
  for (const [h, a] of acc) if (!hectareCentroid.has(h)) hectareCentroid.set(h, { lat: a.y / a.n, lon: a.x / a.n });

  const obsDocs: unknown[] = [];
  for (const s of squirrels) {
    const parts = [
      clean(s.other_activities) && `activities: ${clean(s.other_activities)}`,
      clean(s.other_interactions) && `interactions: ${clean(s.other_interactions)}`,
      clean(s.color_notes) && `color_notes: ${clean(s.color_notes)}`,
    ].filter(Boolean) as string[];
    obsDocs.push({ index: { _index: IDX.obs, _id: s.unique_squirrel_id } });
    obsDocs.push({
      unique_squirrel_id: s.unique_squirrel_id,
      hectare: s.hectare,
      shift: s.shift,
      obs_date: mmddyyyy(s.date),
      location: { lat: Number(s.y), lon: Number(s.x) },
      age: clean(s.age),
      primary_fur_color: clean(s.primary_fur_color),
      behaviors: {
        kuks: !!s.kuks, quaas: !!s.quaas, moans: !!s.moans, tail_flags: !!s.tail_flags,
        tail_twitches: !!s.tail_twitches, approaches: !!s.approaches, indifferent: !!s.indifferent,
        runs_from: !!s.runs_from, chasing: !!s.chasing,
      },
      other_activities: clean(s.other_activities),
      other_interactions: clean(s.other_interactions),
      color_notes: clean(s.color_notes),
      note_text: parts.join(" | ") || undefined,
      has_note: parts.length > 0,
    });
  }

  const storyDocs: unknown[] = [];
  for (const st of stories) {
    const note = clean(st.note_squirrel_park_stories);
    const id = createHash("sha1").update(`${st.hectare}|${st.date}|${st.shift}|${note ?? ""}`).digest("hex");
    storyDocs.push({ index: { _index: IDX.stories, _id: id } });
    storyDocs.push({
      story_id: id,
      story_date: mmddyyyy(st.date),
      hectare: st.hectare,
      shift: st.shift,
      story_topic_squirrel: String(st.story_topic_squirrel ?? ""),
      note,
      has_note: !!note,
      location: hectareCentroid.get(st.hectare),
    });
  }

  for (let i = 0; i < obsDocs.length; i += 2000) await bulk(obsDocs.slice(i, i + 2000));
  await bulk(storyDocs);
  await bulk(hectareDocs);

  return {
    observations: squirrels.length,
    observationsWithNotes: (obsDocs.filter((_, i) => i % 2 === 1) as any[]).filter((d) => d.has_note).length,
    stories: stories.length,
    hectarePolygons: grid.length,
  };
}

/* ---------------- Mistral classification ---------------- */

const SYSTEM_PROMPT = `You classify field notes from the 2018 Central Park Squirrel Census.
For each note, return one label object.

primary_label:
- "incident": a SQUIRREL is dead, injured, not moving, hit by a vehicle, attacked, fighting, or being fed by a human.
- "cross_species_incident": same kind of event but the animal is not a squirrel (dead bird, injured rat...).
- "disturbance": ambient habitat disturbance (dogs off leash, crowds/events, leaf blowers/machinery/noise, litter/food waste, human activity).
- "not-squirrel-incident": human pain, figurative language, objects (e.g. "my feet hurt", "dead tired", "broken bench").
- "none": ordinary squirrel behavior or nothing notable.

incident_type (only if incident/cross_species_incident, else null): dead, injured, not_moving, roadkill, dog_encounter, fight, human_feeding, other.
disturbance_type (only if disturbance, else null): dog_off_leash, event_crowd, noise_machinery, litter_food, human_activity, other.
subject: squirrel, other_animal, human, unknown.
A dog actively chasing/attacking a squirrel = incident/dog_encounter. A dog merely present off leash = disturbance/dog_off_leash.
A human handing food to a squirrel = incident/human_feeding.
evidence: an EXACT verbatim substring of the note that justifies the label (empty string if none).
confidence: 0..1.
weird_score: 0..1, how bizarre/funny the note is.
one_liner: a short witty headline (max 10 words) about the note.
Return one result per input id, using the same id.`;

const LABEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "primary_label", "incident_type", "disturbance_type", "subject", "confidence", "evidence", "weird_score", "one_liner"],
        properties: {
          id: { type: "string" },
          primary_label: { type: "string", enum: ["incident", "cross_species_incident", "disturbance", "not-squirrel-incident", "none"] },
          incident_type: { type: ["string", "null"], enum: ["dead", "injured", "not_moving", "roadkill", "dog_encounter", "fight", "human_feeding", "other", null] },
          disturbance_type: { type: ["string", "null"], enum: ["dog_off_leash", "event_crowd", "noise_machinery", "litter_food", "human_activity", "other", null] },
          subject: { type: "string", enum: ["squirrel", "other_animal", "human", "unknown"] },
          confidence: { type: "number" },
          evidence: { type: "string" },
          weird_score: { type: "number" },
          one_liner: { type: "string" },
        },
      },
    },
  },
};

export class RateLimited extends Error {
  constructor(public retryAfter: number) {
    super("Mistral rate limit");
  }
}

export async function classifyNotes(items: { id: string; text: string }[]) {
  const key = process.env["MISTRAL_API_KEY"];
  if (!key) throw new Error("Mistral is not configured");
  const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CLASSIFY_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(items) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "labels", schema: LABEL_SCHEMA, strict: true },
      },
    }),
  });
  if (res.status === 429) throw new RateLimited(Number(res.headers.get("retry-after") ?? 3));
  if (!res.ok) throw new Error(`Mistral ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  const parsed = JSON.parse(json.choices[0]?.message.content ?? "{}") as { results: any[] };
  return parsed.results ?? [];
}

export function buildAi(r: any, sourceText: string) {
  const evidence = String(r.evidence ?? "");
  return {
    primary_label: r.primary_label,
    incident_type: r.incident_type ?? null,
    disturbance_type: r.disturbance_type ?? null,
    subject: r.subject,
    confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0)),
    evidence,
    evidence_verified: evidence.length > 0 && sourceText.toLowerCase().includes(evidence.toLowerCase()),
    weird_score: Math.max(0, Math.min(1, Number(r.weird_score) || 0)),
    one_liner: r.one_liner,
    model: CLASSIFY_MODEL,
    prompt_version: PROMPT_VERSION,
    classified_at: new Date().toISOString(),
  };
}
