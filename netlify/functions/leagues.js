// League chips = the per-game boards PrizePicks is posting right now (one call
// to PrizePicks /leagues). PrizePicks is the default source of truth for this
// app; SportsGameOdds is only supporting data inside the agent.
// Fails loudly (500 with the reason) if PrizePicks errors or changes shape.
const { fetchCatalog } = require("./_prizepicks");

exports.handler = async () => {
  try {
    const leagues = (await fetchCatalog())
      .filter((l) => l.kind === "game" && l.projections > 0)
      .sort((a, b) => b.projections - a.projections)
      .map((l) => l.name);
    return { statusCode: 200, headers: { "cache-control": "no-store" }, body: JSON.stringify({ leagues }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
