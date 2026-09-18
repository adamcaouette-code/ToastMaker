const BASE = "https://api.anthropic.com/v1";
// Sessions/events use managed-agents; the memory-store endpoints are documented
// under agent-memory. Sending both is accepted (comma-separated) and covers either.
const BETA_HEADER = "managed-agents-2026-04-01,agent-memory-2026-07-22";

function headers() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set in Netlify env vars");
  return {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": BETA_HEADER,
    "content-type": "application/json",
  };
}

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) },
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`Anthropic API ${res.status}: ${JSON.stringify(json)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// Follows next_page cursors and returns every item. view=full caps limit at 20
// per page, so bulk reads must paginate. Capped at 25 pages as a runaway guard.
async function listAll(path, params = {}, maxPages = 25) {
  const out = [];
  let page = null;
  for (let i = 0; i < maxPages; i++) {
    const qs = new URLSearchParams(params);
    if (page) qs.set("page", page);
    const r = await api(`${path}?${qs}`, { method: "GET" });
    out.push(...(r.data || []));
    page = r.next_page;
    if (!page) break;
  }
  return out;
}

const listMemories = (storeId) =>
  listAll(`/memory_stores/${storeId}/memories`, { view: "full", limit: "20" });

module.exports = { api, listAll, listMemories };
