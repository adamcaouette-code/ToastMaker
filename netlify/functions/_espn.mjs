// Shared ESPN lookups (no API key needed). Used by headshots.mjs and player-stats.mjs.
//
// Search uses common/v3/search: the tracker's old .../athletes?searchTerm= form
// returns HTTP 400 now. Game logs come from site.web.api.espn.com; the
// site.api.espn.com /statistics and /gamelog paths the tracker used 404.

import { buildIndex, matchPlayer, normKey } from "./player-match.mjs";

// PrizePicks league name -> ESPN [sport, league slug]. The slug is also the
// headshot path segment. Leagues not listed have no ESPN data here.
export const ESPN = {
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

// slug|name -> {id, headshot, matchedName} | null, per warm instance. "No
// confident match" (null) is cached too; errors are NOT cached.
const cache = new Map();

export async function resolveAthlete(league, name) {
  const cfg = ESPN[String(league).toUpperCase()];
  if (!cfg) return null;
  const [sport, slug] = cfg;
  const key = `${slug}|${normKey(name)}`;
  if (cache.has(key)) return cache.get(key);

  const url = `https://site.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(name)}&limit=5&type=player&sport=${sport}&league=${slug}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN search ${res.status}`);
  const items = (await res.json())?.items || [];

  const hit = matchPlayer(buildIndex(items.map((i) => [i.displayName, i.id])), name);
  const found = hit
    ? { id: hit.value, matchedName: hit.matchedName, headshot: `https://a.espncdn.com/i/headshots/${slug}/players/full/${hit.value}.png` }
    : null;
  cache.set(key, found);
  return found;
}
