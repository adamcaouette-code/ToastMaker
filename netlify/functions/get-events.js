const { listAll } = require("./_anthropic");

// Only these matter to the browser; tool calls/results (odds payloads) are
// large and would blow past Netlify's 6MB response limit.
const KEEP = new Set(["agent.message", "session.status_idle", "session.status_terminated", "session.error"]);

exports.handler = async (event) => {
  try {
    const { session_id, since } = event.queryStringParameters || {};
    if (!session_id) {
      return { statusCode: 400, body: JSON.stringify({ error: "session_id is required" }) };
    }
    // List Events has no "after id" param: filter by processed_at instead.
    // gte (not gt) because timestamps are second-granular; the client dedupes by id.
    const params = since ? { "created_at[gte]": since } : {};
    const all = await listAll(`/sessions/${encodeURIComponent(session_id)}/events`, params);
    return { statusCode: 200, body: JSON.stringify({ data: all.filter((e) => KEEP.has(e.type)) }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
