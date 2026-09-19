const { api } = require("./_anthropic");
const { fetchLines, linesForPrompt } = require("./_prizepicks");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "POST only" };
  }

  try {
    const { message: userMessage, leagues } = JSON.parse(event.body || "{}");
    const message = userMessage;
    if (!message) {
      return { statusCode: 400, body: JSON.stringify({ error: "message is required" }) };
    }

    const { SLIP_BUILDER_AGENT_ID, ENVIRONMENT_ID, VAULT_ID, MEMORY_STORE_ID } = process.env;
    for (const [k, v] of Object.entries({ SLIP_BUILDER_AGENT_ID, ENVIRONMENT_ID, VAULT_ID, MEMORY_STORE_ID })) {
      if (!v) throw new Error(`Missing env var: ${k}`);
    }

    // PrizePicks is the default source: fetch its real lines for the chosen
    // leagues and hand them to the agent. If PrizePicks fails or changes shape
    // this throws and NO session starts — never bet-size off a silent gap.
    // Prepended so the trailing version tag stays last.
    let fullMessage = message;
    if (Array.isArray(leagues) && leagues.length) {
      const boards = [];
      for (const lg of leagues) boards.push(linesForPrompt(await fetchLines(lg)));
      fullMessage =
        "PRIZEPICKS LINES (live, authoritative). PrizePicks is the platform I bet on: build slips ONLY from these players, stats and lines. " +
        "These are the standard lines (goblin/demon variants exist in the app but aren't listed). Use SportsGameOdds and other sources only as supporting data to judge these lines. " +
        "If a stat or player isn't listed here, don't use it.\n\n" + boards.join("\n\n") + "\n\n---\n" + message;
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
        events: [{ type: "user.message", content: [{ type: "text", text: fullMessage }] }],
      }),
    });

    return { statusCode: 200, body: JSON.stringify({ session_id: session.id }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
