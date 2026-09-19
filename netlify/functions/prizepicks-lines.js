// GET /api/prizepicks-lines?league=MLB -> current PrizePicks lines for that league.
// See _prizepicks.js: any request error or unexpected response shape is a 502
// with a "PrizePicks: ..." message, never an empty list.
const { fetchLines } = require("./_prizepicks");

exports.handler = async (event) => {
  const league = (event.queryStringParameters || {}).league;
  if (!league) return { statusCode: 400, body: JSON.stringify({ error: "league is required, e.g. ?league=MLB" }) };
  try {
    const result = await fetchLines(league);
    return { statusCode: 200, headers: { "cache-control": "no-store" }, body: JSON.stringify(result) };
  } catch (err) {
    console.error(err);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
