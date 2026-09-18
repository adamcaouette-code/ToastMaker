const { api } = require("./_anthropic");

exports.handler = async (event) => {
  try {
    const { session_id, after } = event.queryStringParameters || {};
    if (!session_id) {
      return { statusCode: 400, body: JSON.stringify({ error: "session_id is required" }) };
    }
    const qs = after ? `?after=${encodeURIComponent(after)}` : "";
    const result = await api(`/sessions/${session_id}/events${qs}`, { method: "GET" });
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
