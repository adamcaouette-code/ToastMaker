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

// One events query (unfinished, has odds, starting within 36h) across ALL
// leagues, then the distinct leagueIDs. No hardcoded list, so WNBA, soccer,
// tennis, MMA etc. show up whenever they have games.
exports.handler = async () => {
  try {
    const key = process.env.SPORTSGAMEODDS_API_KEY;
    if (!key) throw new Error("Missing env var: SPORTSGAMEODDS_API_KEY");

    const found = new Set();
    let cursor = null;
    for (let page = 0; page < 5; page++) {
      const qs = new URLSearchParams({
        finalized: "false",
        oddsAvailable: "true",
        startsBefore: new Date(Date.now() + 36 * 3600 * 1000).toISOString(),
        limit: "100",
      });
      if (cursor) qs.set("cursor", cursor);
      const res = await fetch(`https://api.sportsgameodds.com/v2/events?${qs}`, {
        headers: { "x-api-key": key },
      });
      if (!res.ok) throw new Error(`SportsGameOdds ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = await res.json();
      for (const e of body.data || []) if (e.leagueID) found.add(e.leagueID);
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    return { statusCode: 200, body: JSON.stringify({ leagues: [...found].sort() }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
