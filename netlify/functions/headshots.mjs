// POST /api/headshots  { league: "MLB", names: ["Michael Harris II", ...] }
//   -> { headshots: { "Michael Harris II": "https://a.espncdn.com/.../123.png" | null } }
//
// Resolves each PrizePicks player name to an ESPN athlete id via ESPN's public
// player search (common/v3/search; the tracker's .../athletes?searchTerm= form
// now returns HTTP 400 for everything), then runs the
// results through matchPlayer() from player-match.mjs (exact -> no-suffix ->
// initial+last, refusing ambiguity) against each result's displayName.
// No confident match => null, so the frontend keeps its silhouette rather
// than showing the wrong player. No API key needed for search or images.

import { buildIndex, matchPlayer, normKey } from "./player-match.mjs";

// PrizePicks league name -> ESPN [sport, league slug]. The slug is also the
// headshot path segment. Leagues not listed have no ESPN headshots here.
const ESPN = {
  MLB: ["baseball", "mlb"],
  NFL: ["football", "nfl"],
  NBA: ["basketball", "nba"],
  WNBA: ["basketball", "wnba"],
  NHL: ["hockey", "nhl"],
  CFB: ["football", "college-football"],
  NCAAF: ["football", "college-football"],
  CBB: ["basketball", "mens-college-basketball"],
  NCAAB: ["basketball", "mens-college-basketball"],
};

// name -> url|null, per warm instance. Negative results are cached too so an
// unmatched player isn't re-searched on every slip. Errors are NOT cached.
const cache = new Map();

async function resolveOne(league, [sport, slug], name) {
  const key = `${slug}|${normKey(name)}`;
  if (cache.has(key)) return cache.get(key);

  const url = `https://site.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(name)}&limit=5&type=player&sport=${sport}&league=${slug}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN search ${res.status}`);
  const items = (await res.json())?.items || [];

  const hit = matchPlayer(buildIndex(items.map((i) => [i.displayName, i.id])), name);
  const headshot = hit ? `https://a.espncdn.com/i/headshots/${slug}/players/full/${hit.value}.png` : null;
  cache.set(key, headshot);
  return headshot;
}

export const handler = async (event) => {
  const reply = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
  if (event.httpMethod !== "POST") return reply(405, { error: "POST only" });

  let league, names;
  try {
    ({ league, names } = JSON.parse(event.body || "{}"));
  } catch {
    return reply(400, { error: "invalid JSON body" });
  }
  if (!league || !Array.isArray(names)) return reply(400, { error: "league and names[] are required" });

  const cfg = ESPN[String(league).toUpperCase()];
  if (!cfg) return reply(200, { headshots: {}, unsupported: league });

  const unique = [...new Set(names.filter((n) => typeof n === "string" && n).slice(0, 30))];
  const headshots = {};
  const errors = [];
  for (let i = 0; i < unique.length; i += 4) {
    await Promise.all(unique.slice(i, i + 4).map(async (name) => {
      try {
        headshots[name] = await resolveOne(league, cfg, name);
      } catch (e) {
        headshots[name] = null; // cosmetic feature: no photo, but say why
        errors.push(`${name}: ${e.message}`);
      }
    }));
  }
  return reply(200, { headshots, ...(errors.length ? { errors } : {}) });
};
