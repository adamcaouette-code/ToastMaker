const { api } = require("./_anthropic");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "POST only" };
  }

  try {
    const { message } = JSON.parse(event.body || "{}");
    if (!message) {
      return { statusCode: 400, body: JSON.stringify({ error: "message is required" }) };
    }

    const { SLIP_BUILDER_AGENT_ID, ENVIRONMENT_ID, VAULT_ID, MEMORY_STORE_ID } = process.env;
    for (const [k, v] of Object.entries({ SLIP_BUILDER_AGENT_ID, ENVIRONMENT_ID, VAULT_ID, MEMORY_STORE_ID })) {
      if (!v) throw new Error(`Missing env var: ${k}`);
    }

    // Beta API — if this 400s, check the current payload shape at
    // platform.claude.com/docs/en/api/beta/sessions and adjust below.
    const session = await api("/sessions", {
      method: "POST",
      body: JSON.stringify({
        agent: SLIP_BUILDER_AGENT_ID,
        environment_id: ENVIRONMENT_ID,
        vault_ids: [VAULT_ID],
        resources: [
          { type: "memory_store", memory_store_id: MEMORY_STORE_ID, access: "read_write" },
        ],
      }),
    });

    await api(`/sessions/${session.id}/events`, {
      method: "POST",
      body: JSON.stringify({
        type: "user.message",
        content: [{ type: "text", text: message }],
      }),
    });

    return { statusCode: 200, body: JSON.stringify({ session_id: session.id }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
