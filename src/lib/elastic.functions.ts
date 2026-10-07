import { createServerFn } from "@tanstack/react-start";

function elasticHeaders(apiKey: string): HeadersInit {
  // Encoded API keys are not JWTs; send only the Authorization header.
  return {
    Authorization: `ApiKey ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function elasticFetch(path: string, init: RequestInit = {}) {
  const url = process.env["ELASTICSEARCH_URL"];
  const apiKey = process.env["ELASTIC_API_KEY"];
  if (!url || !apiKey) {
    throw new Error("ELASTICSEARCH_URL or ELASTIC_API_KEY is not configured");
  }
  const base = url.replace(/\/+$/, "");
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...elasticHeaders(apiKey), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Elasticsearch error ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

export const elasticPing = createServerFn({ method: "GET" }).handler(
  async () => {
    const info = await elasticFetch("/");
    return {
      clusterName: info.cluster?.name ?? "unknown",
      version: info.version?.number ?? "unknown",
    };
  },
);

export const elasticSearch = createServerFn({ method: "POST" })
  .inputValidator((data: { index: string; query: unknown }) => data)
  .handler(async ({ data }) => {
    const result = await elasticFetch(
      `/${encodeURIComponent(data.index)}/_search`,
      { method: "POST", body: JSON.stringify(data.query) },
    );
    return result;
  });

export const elasticIndexDoc = createServerFn({ method: "POST" })
  .inputValidator((data: { index: string; document: unknown }) => data)
  .handler(async ({ data }) => {
    const result = await elasticFetch(
      `/${encodeURIComponent(data.index)}/_doc`,
      { method: "POST", body: JSON.stringify(data.document) },
    );
    return { id: result._id, result: result.result };
  });
