const BASE = "https://api.anthropic.com/v1";
// The API rejects these two betas combined, so each call sends exactly one:
// sessions/events use managed-agents; memory-store listing uses agent-memory.
const BETA_HEADER = "managed-agents-2026-04-01";
const MEMORY_BETA = "agent-memory-2026-07-22";

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
async function listAll(path, params = {}, headers = {}, maxPages = 25) {
  const out = [];
  let page = null;
  for (let i = 0; i < maxPages; i++) {
    const qs = new URLSearchParams(params);
    if (page) qs.set("page", page);
    const r = await api(`${path}?${qs}`, { method: "GET", headers });
    out.push(...(r.data || []));
    page = r.next_page;
    if (!page) break;
  }
  return out;
}

const listMemories = (storeId) =>
  listAll(`/memory_stores/${storeId}/memories`, { view: "full", limit: "20" }, { "anthropic-beta": MEMORY_BETA });

module.exports = { api, listAll, listMemories };
