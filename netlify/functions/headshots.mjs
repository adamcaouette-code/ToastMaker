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

import { ESPN, resolveAthlete } from "./_espn.mjs";

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
        headshots[name] = (await resolveAthlete(league, name))?.headshot ?? null;
      } catch (e) {
        headshots[name] = null; // cosmetic feature: no photo, but say why
        errors.push(`${name}: ${e.message}`);
      }
    }));
  }
  return reply(200, { headshots, ...(errors.length ? { errors } : {}) });
};
