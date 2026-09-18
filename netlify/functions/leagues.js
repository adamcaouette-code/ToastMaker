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

const CANDIDATE_LEAGUES = ["MLB", "NFL", "NBA", "NHL", "NCAAF", "NCAAB"];

exports.handler = async () => {
  try {
    const key = process.env.SPORTSGAMEODDS_API_KEY;
    if (!key) throw new Error("Missing env var: SPORTSGAMEODDS_API_KEY");

    const checks = await Promise.all(
      CANDIDATE_LEAGUES.map(async (league) => {
        try {
          const res = await fetch(
            `https://api.sportsgameodds.com/v2/events?leagueID=${league}&limit=1`,
            { headers: { "x-api-key": key } }
          );
          if (!res.ok) return null;
          const data = await res.json();
          return data.success && Array.isArray(data.data) && data.data.length > 0
            ? league
            : null;
        } catch {
          return null;
        }
      })
    );

    const leagues = checks.filter(Boolean);
    return { statusCode: 200, body: JSON.stringify({ leagues }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
