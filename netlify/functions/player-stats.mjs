// POST /api/player-stats { league, player, stat, line, pick }
//   -> the player card behind a slip leg: ESPN match + headshot, the bet's stat
//      over recent games (season avg, last-5 avg, hit rate vs the line), and a
//      per-game season-average grid for every counting stat ESPN logs.
// GET  /api/player-stats -> { players: [] } (the old Stats-tab stub, kept so
//      that tab's empty state still works).
//
// No confident ESPN match => { matched: false }, never someone else's numbers.
// ESPN errors are surfaced as 502s, not silently turned into "no stats".

import { ESPN, resolveAthlete } from "./_espn.mjs";

const RECENT = 10;

// PrizePicks stat_type (lowercase) -> function over one game's {espnName: number}.
// Returns undefined-ish (NaN) when an operand is missing, which drops the mapping
// for that player (e.g. a pitcher asked for hitter Total Bases) instead of guessing.
const sum = (...keys) => (v) => keys.reduce((a, k) => a + v[k], 0);
const STAT_MAP = {
  // MLB hitters
  hits: sum("hits"),
  "total bases": (v) => v.hits + v.doubles + 2 * v.triples + 3 * v.homeRuns,
  "home runs": sum("homeRuns"),
  rbis: sum("RBIs"),
  runs: sum("runs"),
  walks: sum("walks"),
  "hitter strikeouts": sum("strikeouts"),
  "stolen bases": sum("stolenBases"),
  singles: (v) => v.hits - v.doubles - v.triples - v.homeRuns,
  "hits+runs+rbis": sum("hits", "runs", "RBIs"),
  // NFL
  "receiving yards": sum("receivingYards"),
  receptions: sum("receptions"),
  "rushing yards": sum("rushingYards"),
  "rush attempts": sum("rushingAttempts"),
  "rush+rec yds": sum("rushingYards", "receivingYards"),
  "pass yards": sum("passingYards"),
  "pass tds": sum("passingTouchdowns"),
  // NBA / WNBA
  points: sum("points"),
  rebounds: sum("totalRebounds"),
  assists: sum("assists"),
  "blocked shots": sum("blocks"),
  steals: sum("steals"),
  turnovers: sum("turnovers"),
  "3-pt made": sum("threePointFieldGoalsMade-threePointFieldGoalsAttempted"),
  "pts+rebs+asts": sum("points", "totalRebounds", "assists"),
  "pts+rebs": sum("points", "totalRebounds"),
  "pts+asts": sum("points", "assists"),
  "rebs+asts": sum("totalRebounds", "assists"),
};

// Rate/percentage columns don't average meaningfully as a per-game figure.
const SKIP_COL = /pct|avg|ops|onbase|slug|per|long|minutes|%/i;

const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function parseGamelog(d) {
  const names = d.names || [];
  const labels = d.displayNames || d.labels || [];
  const st = (d.seasonTypes || []).find((s) => /regular/i.test(s.displayName)) || (d.seasonTypes || [])[0];
  const seen = new Set();
  const games = [];
  for (const cat of st?.categories || []) {
    for (const ev of cat.events || []) {
      if (seen.has(ev.eventId)) continue;
      seen.add(ev.eventId);
      const meta = d.events?.[ev.eventId] || {};
      const vals = {};
      names.forEach((n, i) => {
        // "2-5" style columns (made-attempted) keep the first number
        const num = parseFloat(String(ev.stats?.[i]).split("-")[0]);
        if (Number.isFinite(num)) vals[n] = num;
      });
      games.push({
        date: meta.gameDate || "",
        opp: `${meta.atVs || ""}${meta.opponent?.abbreviation || ""}`,
        vals,
      });
    }
  }
  games.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { games, names, labels };
}

export function buildCard({ games, names, labels }, { stat, line, pick }) {
  // ---- the bet's stat, when we know how to compute it ----
  let prop = null;
  const fn = STAT_MAP[String(stat || "").toLowerCase()];
  if (fn && games.length) {
    const series = games
      .map((g) => ({ v: fn(g.vals), opp: g.opp, date: g.date }))
      .filter((g) => Number.isFinite(g.v));
    if (series.length) {
      const last = series.slice(-RECENT);
      const dir = String(pick || "more").toLowerCase() === "less" ? -1 : 1;
      const hit = (v) => (Number.isFinite(line) ? dir * (v - line) > 0 : false);
      prop = {
        stat,
        line: Number.isFinite(line) ? line : null,
        pick: dir === -1 ? "less" : "more",
        seasonAvg: round(mean(series.map((g) => g.v)), 2),
        last5Avg: round(mean(series.slice(-5).map((g) => g.v)), 2),
        games: series.length,
        hits: last.filter((g) => hit(g.v)).length,
        of: last.length,
        log: last.map((g) => ({ v: g.v, opp: g.opp, date: g.date, hit: hit(g.v) })),
      };
    }
  }

  // ---- generic per-game averages for every counting stat ----
  const averages = [];
  names.forEach((n, i) => {
    if (SKIP_COL.test(n) || n.includes("-")) return;
    const xs = games.map((g) => g.vals[n]).filter(Number.isFinite);
    if (!xs.length) return;
    averages.push({
      label: labels[i] || n,
      season: round(mean(xs), 2),
      last5: round(mean(xs.slice(-5)), 2),
    });
  });

  return { prop, averages: averages.slice(0, 10), gamesPlayed: games.length };
}

export const handler = async (event) => {
  const reply = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
  if (event.httpMethod === "GET") return reply(200, { players: [] });
  if (event.httpMethod !== "POST") return reply(405, { error: "GET or POST only" });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return reply(400, { error: "invalid JSON body" });
  }
  const { league, player, stat, pick } = body;
  const line = body.line == null ? NaN : Number(body.line);
  if (!league || !player) return reply(400, { error: "league and player are required" });

  const cfg = ESPN[String(league).toUpperCase()];
  if (!cfg) return reply(200, { matched: false, reason: `no ESPN stats for league ${league}` });

  try {
    const athlete = await resolveAthlete(league, player);
    if (!athlete) return reply(200, { matched: false, reason: "no confident ESPN match for this player" });

    const [sport, slug] = cfg;
    const res = await fetch(`https://site.web.api.espn.com/apis/common/v3/sports/${sport}/${slug}/athletes/${athlete.id}/gamelog`);
    if (!res.ok) throw new Error(`ESPN gamelog ${res.status}`);
    const card = buildCard(parseGamelog(await res.json()), { stat, line, pick });

    return reply(200, { matched: true, player: athlete.matchedName, espnId: athlete.id, headshot: athlete.headshot, ...card });
  } catch (err) {
    console.error(err);
    return reply(502, { error: `ESPN: ${err.message}` });
  }
};
