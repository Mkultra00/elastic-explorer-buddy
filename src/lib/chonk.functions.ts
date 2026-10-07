import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type HectareStat = {
  hectare: string;
  observations: number;
  stories: number;
  incidents: number;
  disturbances: number;
  dead: number;
};

export type Pin = { id: string; lat: number; lon: number; label: string; type: string | null; evidence: string };

export const setupChonk = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ reset: z.boolean() }).parse(d))
  .handler(async ({ data }) => {
    const { ensureIndices, ingestAll } = await import("./chonk.server");
    const indices = await ensureIndices(data.reset);
    const counts = await ingestAll();
    return { indices, counts };
  });

export const getProgress = createServerFn({ method: "GET" }).handler(async () => {
  const { es, IDX } = await import("./chonk.server");
  const count = async (index: string, query: unknown) => {
    const r = await es(`/${index}/_count`, { method: "POST", body: JSON.stringify({ query }) });
    return r.ok ? (r.json.count as number) : 0;
  };
  const withNote = { term: { has_note: true } };
  const done = { bool: { filter: [withNote, { exists: { field: "ai.primary_label" } }] } };
  const [obsTotal, obsNotes, obsDone, stTotal, stDone] = await Promise.all([
    count(IDX.obs, { match_all: {} }),
    count(IDX.obs, withNote),
    count(IDX.obs, done),
    count(IDX.stories, withNote),
    count(IDX.stories, done),
  ]);
  return { obsTotal, toClassify: obsNotes + stTotal, classified: obsDone + stDone };
});

export const classifyBatch = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ size: z.number().min(1).max(40) }).parse(d))
  .handler(async ({ data }) => {
    const { es, bulk, IDX, classifyNotes, buildAi, RateLimited } = await import("./chonk.server");
    const query = {
      bool: { filter: [{ term: { has_note: true } }], must_not: [{ exists: { field: "ai.primary_label" } }] },
    };
    let index: string = IDX.stories;
    let r = await es(`/${index}/_search`, { method: "POST", body: JSON.stringify({ size: data.size, query }) });
    if (!r.json.hits?.hits?.length) {
      index = IDX.obs;
      r = await es(`/${index}/_search`, { method: "POST", body: JSON.stringify({ size: data.size, query }) });
    }
    const hits = (r.json.hits?.hits ?? []) as any[];
    if (!hits.length) return { done: true, processed: 0, retryAfter: 0 };
    const items = hits.map((h) => ({ id: h._id as string, text: (h._source.note ?? h._source.note_text) as string }));
    try {
      const results = await classifyNotes(items);
      const byId = new Map(results.map((x) => [x.id, x]));
      const lines: unknown[] = [];
      for (const it of items) {
        const res = byId.get(it.id) ?? { primary_label: "none", subject: "unknown", confidence: 0, evidence: "", weird_score: 0, one_liner: "" };
        lines.push({ update: { _index: index, _id: it.id } });
        lines.push({ doc: { ai: buildAi(res, it.text) } });
      }
      await bulk(lines);
      return { done: false, processed: items.length, retryAfter: 0 };
    } catch (e) {
      if (e instanceof RateLimited) return { done: false, processed: 0, retryAfter: e.retryAfter };
      throw e;
    }
  });

export const getMapData = createServerFn({ method: "GET" }).handler(async () => {
  const { es, IDX } = await import("./chonk.server");
  const aggs = {
    by_h: {
      terms: { field: "hectare", size: 1000 },
      aggs: {
        inc: { filter: { term: { "ai.primary_label": "incident" } } },
        dist: { filter: { term: { "ai.primary_label": "disturbance" } } },
        dead: {
          filter: {
            bool: {
              filter: [
                { terms: { "ai.primary_label": ["incident", "cross_species_incident"] } },
                { terms: { "ai.incident_type": ["dead", "roadkill"] } },
              ],
            },
          },
        },
      },
    },
  };
  const [hect, obs, st, pins, dist] = await Promise.all([
    es(`/${IDX.hectares}/_search`, { method: "POST", body: JSON.stringify({ size: 1000 }) }),
    es(`/${IDX.obs}/_search`, { method: "POST", body: JSON.stringify({ size: 0, aggs }) }),
    es(`/${IDX.stories}/_search`, { method: "POST", body: JSON.stringify({ size: 0, aggs }) }),
    es(`/${IDX.obs}/_search`, {
      method: "POST",
      body: JSON.stringify({
        size: 500,
        _source: ["location", "ai"],
        query: { terms: { "ai.primary_label": ["incident", "cross_species_incident", "disturbance"] } },
      }),
    }),
    es(`/${IDX.stories},${IDX.obs}/_search`, {
      method: "POST",
      body: JSON.stringify({
        size: 0,
        aggs: { types: { terms: { field: "ai.disturbance_type", size: 10 } }, labels: { terms: { field: "ai.primary_label", size: 10 } } },
      }),
    }),
  ]);
  if (!hect.ok) return { ready: false as const };

  const stats = new Map<string, HectareStat>();
  const get = (h: string) => {
    let s = stats.get(h);
    if (!s) stats.set(h, (s = { hectare: h, observations: 0, stories: 0, incidents: 0, disturbances: 0, dead: 0 }));
    return s;
  };
  for (const b of obs.json.aggregations?.by_h?.buckets ?? []) {
    const s = get(b.key);
    s.observations = b.doc_count;
    s.incidents += b.inc.doc_count;
    s.disturbances += b.dist.doc_count;
    s.dead += b.dead.doc_count;
  }
  for (const b of st.json.aggregations?.by_h?.buckets ?? []) {
    const s = get(b.key);
    s.stories = b.doc_count;
    s.incidents += b.inc.doc_count;
    s.disturbances += b.dist.doc_count;
    s.dead += b.dead.doc_count;
  }

  const polygons = (hect.json.hits.hits as any[]).map((h) => ({
    id: h._id as string,
    hectare: (h._source.hectare ?? null) as string | null,
    ring: h._source.polygon as number[][],
  }));
  const pinList: Pin[] = (pins.json.hits?.hits ?? []).map((h: any) => ({
    id: h._id,
    lat: h._source.location.lat,
    lon: h._source.location.lon,
    label: h._source.ai.primary_label,
    type: h._source.ai.incident_type ?? h._source.ai.disturbance_type ?? null,
    evidence: h._source.ai.evidence ?? "",
  }));
  const bucket = (a: any) => (a?.buckets ?? []).map((b: any) => ({ key: b.key as string, count: b.doc_count as number }));
  return {
    ready: true as const,
    polygons,
    stats: [...stats.values()],
    pins: pinList,
    disturbanceTypes: bucket(dist.json.aggregations?.types),
    labels: bucket(dist.json.aggregations?.labels),
  };
});

export const getHectare = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ hectare: z.string().max(5) }).parse(d))
  .handler(async ({ data }) => {
    const { es, IDX } = await import("./chonk.server");
    const q = (filter: unknown[]) =>
      JSON.stringify({ size: 200, query: { bool: { filter } }, sort: [{ "ai.confidence": { order: "desc", unmapped_type: "float" } }] });
    const [stories, obs] = await Promise.all([
      es(`/${IDX.stories}/_search`, { method: "POST", body: q([{ term: { hectare: data.hectare } }]) }),
      es(`/${IDX.obs}/_search`, { method: "POST", body: q([{ term: { hectare: data.hectare } }, { term: { has_note: true } }]) }),
    ]);
    const map = (hits: any[], kind: "story" | "observation") =>
      hits.map((h) => ({
        id: h._id as string,
        kind,
        text: (h._source.note ?? h._source.note_text ?? "") as string,
        date: (h._source.story_date ?? h._source.obs_date ?? null) as string | null,
        shift: h._source.shift as string,
        ai: (h._source.ai ?? null) as null | {
          primary_label: string;
          incident_type: string | null;
          disturbance_type: string | null;
          confidence: number;
          evidence: string;
          evidence_verified: boolean;
          one_liner: string;
          weird_score: number;
        },
      }));
    return [...map(stories.json.hits?.hits ?? [], "story"), ...map(obs.json.hits?.hits ?? [], "observation")];
  });

// Fixtures: the three confirmed incidents in the observation data must be labeled "incident".
export const runFixtures = createServerFn({ method: "GET" }).handler(async () => {
  const { es, IDX } = await import("./chonk.server");
  const fixtures = [
    { hectare: "39G", hint: "dead", expect: ["dead", "roadkill"] },
    { hectare: "26A", hint: "not moving", expect: ["not_moving", "injured"] },
    { hectare: "21F", hint: "dead", expect: ["dead", "roadkill"] },
  ];
  return Promise.all(
    fixtures.map(async (f) => {
      const r = await es(`/${IDX.obs}/_search`, {
        method: "POST",
        body: JSON.stringify({
          size: 1,
          query: { bool: { filter: [{ term: { hectare: f.hectare } }], must: [{ match_phrase: { note_text: f.hint } }] } },
        }),
      });
      const hit = r.json.hits?.hits?.[0];
      const ai = hit?._source?.ai;
      const pass = !!ai && ai.primary_label === "incident" && f.expect.includes(ai.incident_type);
      return {
        hectare: f.hectare,
        note: (hit?._source?.note_text ?? "not found") as string,
        label: ai ? `${ai.primary_label}/${ai.incident_type ?? "-"}` : "unclassified",
        pass,
      };
    }),
  );
});
