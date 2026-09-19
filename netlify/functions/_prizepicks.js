// PrizePicks board access — ported from prizepicks-tracker (pp-probe.js /
// bet-finder-background.js). Only the two partner-api.prizepicks.com calls
// that work; api.prizepicks.com is deliberately not used (it 403s).
//
// UNSTABLE DEPENDENCY: this is the endpoint PrizePicks' own web app calls, not
// a public API. No auth, no changelog, no contract. Because these lines feed
// real bet sizing, everything here FAILS LOUDLY: a request error or an
// unexpected response shape throws a "PrizePicks: ..." error. It never returns
// an empty list to mean "something broke". An empty `lines` array only ever
// means the catalog itself reports zero projections for that league.

const HOST = "https://partner-api.prizepicks.com";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Accept: "application/json",
  Referer: "https://app.prizepicks.com/",
};
const PAGE = 250;
const MAX_PAGES = 12;
const BUDGET_MS = 8000; // sync Netlify functions die around 10s

const fail = (msg) => { throw new Error(`PrizePicks: ${msg}`); };
const tagOf = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

async function getJSON(path, stopAt) {
  const url = `${HOST}${path}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: HEADERS });
    if (res.status === 429) {
      // PrizePicks throttles per IP and sends Retry-After (can be ~45s). A sync
      // function can't wait that long: retry only if it fits the budget,
      // otherwise fail loudly and say how long to wait.
      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(4000, 600 * 2 ** attempt);
      if (attempt >= 4 || Date.now() + wait > stopAt) {
        fail(`${path} rate limited (429)${Number.isFinite(ra) && ra > 0 ? `; PrizePicks says retry in ${ra}s` : ""}`);
      }
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) fail(`${path} returned HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      return fail(`${path} did not return JSON — the endpoint may have changed`);
    }
  }
}

// Season futures / live / period splits / series boards are not ordinary
// per-game props (same classification the tracker uses).
function leagueKind(name, parentId) {
  const n = String(name).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/SZN\d*$/.test(n)) return "season";
  if (n.endsWith("LIVE")) return "live";
  if (parentId != null || /\d(H|Q|P)$/.test(n)) return "period";
  if (/SERIES$/.test(n)) return "series";
  return "game";
}

let catalogCache = null; // {at, catalog}; success only, 3 min — chips + Generate both need it
async function fetchCatalog(stopAt = Date.now() + BUDGET_MS) {
  if (catalogCache && Date.now() - catalogCache.at < 3 * 60 * 1000) return catalogCache.catalog;
  const catalog = await fetchCatalogUncached(stopAt);
  catalogCache = { at: Date.now(), catalog };
  return catalog;
}

async function fetchCatalogUncached(stopAt) {
  const body = await getJSON("/leagues?per_page=250", stopAt);
  if (!Array.isArray(body.data) || !body.data.length) fail("/leagues returned no data array — the site format may have changed");
  return body.data.map((d) => {
    const a = d.attributes;
    const name = a && (a.name || a.display_name);
    if (d.id == null || typeof name !== "string") fail("/leagues entry is missing id/name — the site format may have changed");
    return {
      id: String(d.id),
      name,
      tag: tagOf(name),
      projections: a.projections_count ?? a.props_count ?? 0,
      kind: leagueKind(name, a.parent_id),
    };
  });
}

// Validates every row; any deviation from the expected shape throws.
function normalize(data, included) {
  const players = {};
  for (const i of included || []) if (i.type === "new_player") players[i.id] = i.attributes || {};

  return data.map((d) => {
    const a = d.attributes;
    if (!a) fail(`projection ${d.id} has no attributes`);
    const line = Number(a.line_score);
    if (a.line_score == null || !Number.isFinite(line)) fail(`projection ${d.id} has no numeric line_score — the site format may have changed`);
    if (typeof a.stat_type !== "string" || !a.stat_type) fail(`projection ${d.id} has no stat_type — the site format may have changed`);
    const p = players[d.relationships?.new_player?.data?.id];
    const player = p && (p.display_name || p.name);
    if (!player) fail(`projection ${d.id} has no resolvable player — the site format may have changed`);
    return {
      id: d.id,
      player,
      team: p.team || "",
      opponent: a.description || "",
      position: p.position || "",
      stat: a.stat_type,
      line,
      oddsType: String(a.odds_type || "standard").toLowerCase(), // standard | goblin | demon
      status: a.status || "",
      combo: p.combo === true || a.event_type === "combo",
      live: a.is_live === true || a.in_game === true,
      start: a.start_time || "",
      gameId: a.game_id || null,
    };
  });
}

const CACHE_MS = 3 * 60 * 1000; // per warm instance; spares the rate limit on back-to-back runs
const cache = new Map();

async function fetchLines(league) {
  const hit = cache.get(tagOf(league));
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  const result = await fetchLinesUncached(league);
  cache.set(tagOf(league), { at: Date.now(), result }); // only reached on success
  return result;
}

async function fetchLinesUncached(league) {
  const stopAt = Date.now() + BUDGET_MS;
  const catalog = await fetchCatalog(stopAt);
  const want = tagOf(league);
  const match = catalog.find((l) => l.tag === want && l.kind === "game");
  if (!match) {
    const avail = catalog.filter((l) => l.kind === "game" && l.projections > 0).map((l) => l.name).join(", ");
    fail(`no per-game league '${league}'. PrizePicks is currently posting: ${avail || "(none)"}`);
  }

  // First page tells us total_pages; the rest go in small waves (PrizePicks
  // throttles hard, and getJSON backs off on 429). Capped at MAX_PAGES (~3000
  // props, same cap as the tracker); hitting the cap is reported via
  // `truncated`, not hidden.
  const raw = [];
  const included = [];
  const absorb = (body) => {
    if (!Array.isArray(body.data)) fail("/projections returned no data array — the site format may have changed");
    raw.push(...body.data);
    included.push(...(Array.isArray(body.included) ? body.included : []));
    return body.data.length;
  };
  const pageUrl = (p) => `/projections?per_page=${PAGE}&single_stat=true&league_id=${match.id}&page=${p}`;

  const first = await getJSON(pageUrl(1), stopAt);
  const firstN = absorb(first);
  const totalPages = firstN < PAGE ? 1 : Number(first.meta?.total_pages) || MAX_PAGES;
  const lastPage = Math.min(MAX_PAGES, totalPages);
  for (let base = 2; base <= lastPage; base += 3) {
    const wave = [];
    for (let p = base; p < base + 3 && p <= lastPage; p++) wave.push(getJSON(pageUrl(p), stopAt));
    for (const body of await Promise.all(wave)) absorb(body);
  }
  const truncated = totalPages > MAX_PAGES;

  if (!raw.length && match.projections > 0) {
    fail(`${match.name}: catalog lists ${match.projections} projections but none came back`);
  }
  const lines = normalize(raw, included);
  return { league: match.name, leagueId: match.id, fetchedAt: new Date().toISOString(), count: lines.length, truncated, lines };
}

// Compact text for the agent: pre-game single-player STANDARD lines, grouped by
// player. Goblin/demon ladders are ~3x the size (MLB: 4.4k lines, 112KB), so the
// full set stays available from /api/prizepicks-lines but isn't sent in the prompt.
function linesForPrompt({ league, lines, truncated }) {
  const std = lines.filter((l) => !l.combo && !l.live && (!l.status || l.status === "pre_game") && l.oddsType === "standard");
  const byPlayer = new Map();
  for (const l of std) {
    const key = `${l.player}|${l.team}|${l.opponent}`;
    if (!byPlayer.has(key)) byPlayer.set(key, { l, props: [] });
    byPlayer.get(key).props.push(`${l.stat} ${l.line}`);
  }
  const rows = [...byPlayer.values()].map(({ l, props }) =>
    `${l.player}${l.position ? ` [${l.position}]` : ""} (${l.team}${l.opponent ? ` vs ${l.opponent}` : ""}): ${props.join("; ")}`);
  const warn = truncated ? " (BOARD TRUNCATED: more lines exist than shown)" : "";
  return [`${league} standard lines — ${std.length} lines, ${rows.length} players${warn}`, ...rows].join("\n");
}

module.exports = { fetchCatalog, fetchLines, linesForPrompt, normalize, leagueKind, tagOf };
