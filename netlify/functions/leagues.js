// Checks SportsGameOdds directly (not through an agent — this is a plain
// data lookup, no reasoning needed) for which leagues have events today,
// so the frontend's league chips reflect what's actually live rather than
// a hardcoded list.
//
// Needs its own env var, SPORTSGAMEODDS_API_KEY — separate from the key
// stored in the agent's vault. That vault key only ever lives inside the
// agent's sandbox; this function runs outside it, so it needs its own copy.
// Same underlying SportsGameOdds account/key is fine to reuse the value of,
// just set it here too as its own Netlify env var.

// This tier requires a leagueID on every events query, so: list all leagues
// from /v2/leagues, then check each for an unfinished event with odds in the
// next 36h. Cached 10 min (per warm instance + browser) to spare the rate limit.
const BASE = "https://api.sportsgameodds.com/v2";
const TTL = 10 * 60 * 1000;
let cache = null;

exports.handler = async (event) => {
  try {
    const key = process.env.SPORTSGAMEODDS_API_KEY;
    if (!key) throw new Error("Missing env var: SPORTSGAMEODDS_API_KEY");
    const headers = { "cache-control": "public, max-age=600" };
    if (cache && Date.now() - cache.at < TTL) {
      return { statusCode: 200, headers, body: JSON.stringify({ leagues: cache.leagues }) };
    }

    const get = async (path) => {
      const res = await fetch(`${BASE}${path}`, { headers: { "x-api-key": key } });
      if (!res.ok) throw new Error(`SportsGameOdds ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.json();
    };

    const raw = await get("/leagues");
    const ids = (raw.data || []).map((l) => l.leagueID).filter(Boolean);
    const until = new Date(Date.now() + 36 * 3600 * 1000).toISOString();
    const qs = new URLSearchParams({ finalized: "false", oddsAvailable: "true", startsBefore: until, limit: "1" });

    // Sequential with a pause + one retry on 429: this plan rejects bursts.
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const errors = [];
    const leagues = [];
    for (const id of ids) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const d = await get(`/events?leagueID=${id}&${qs}`);
          if (Array.isArray(d.data) && d.data.length) leagues.push(id);
          break;
        } catch (e) {
          if (attempt === 1 || !e.message.includes("429")) errors.push(`${id}: ${e.message}`);
          else await sleep(1500);
        }
      }
      await sleep(300);
    }
    leagues.sort();
    if (event.queryStringParameters?.debug) {
      const sample = JSON.stringify(raw).slice(0, 300);
      return { statusCode: 200, body: JSON.stringify({ leagues, leagueCount: ids.length, ids, failed: errors.length, errors: errors.slice(0, 3), sample }) };
    }
    if (!errors.length) cache = { at: Date.now(), leagues }; // never cache a partial result
    return { statusCode: 200, headers, body: JSON.stringify({ leagues }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
