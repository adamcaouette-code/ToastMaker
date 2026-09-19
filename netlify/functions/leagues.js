// Lists the leagues this SportsGameOdds key can access (one call). The
// Slip Builder agent does the odds lookup itself and says so if a league
// has no games.
//
// Not filtered by "has games today": that needs one events call per league,
// which this plan's rate limit rejects (429) and which runs past Netlify's
// 10s function limit. Revisit if the plan is upgraded.
//
// Needs its own env var, SPORTSGAMEODDS_API_KEY — separate from the key
// stored in the agent's vault. That vault key only ever lives inside the
// agent's sandbox; this function runs outside it.

exports.handler = async () => {
  try {
    const key = process.env.SPORTSGAMEODDS_API_KEY;
    if (!key) throw new Error("Missing env var: SPORTSGAMEODDS_API_KEY");

    const res = await fetch("https://api.sportsgameodds.com/v2/leagues", { headers: { "x-api-key": key } });
    if (!res.ok) throw new Error(`SportsGameOdds ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const { data = [] } = await res.json();
    const leagues = data.filter((l) => l.enabled !== false).map((l) => l.leagueID);

    return {
      statusCode: 200,
      headers: { "cache-control": "public, max-age=3600" },
      body: JSON.stringify({ leagues }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
