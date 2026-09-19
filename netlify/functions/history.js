// GET  /api/history -> { slips: [...], warnings: [...] }  every saved slip, newest first
// POST /api/history { slips, leagues, appVersion } -> { saved: [{ id, path }] }
//
// Slips live in the shared memory store as slip-v1 JSON files (see _slips.js),
// so History accumulates across days and devices, and the agents can read them.
// Only slip-v1 .json files are slips: agent notes (Rules.md, sizing markdown)
// are not, and are skipped. A .json file that isn't a valid record is reported
// in `warnings` (shown on the History tab), never silently dropped. A failed
// save is an error response, never a silent success.

const { api, listAll, MEMORY_HEADERS } = require("./_anthropic");
const { buildRecord, recordPath, parseRecord } = require("./_slips");

const reply = (statusCode, body) => ({ statusCode, headers: { "cache-control": "no-store" }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  try {
    const { MEMORY_STORE_ID } = process.env;
    if (!MEMORY_STORE_ID) throw new Error("Missing env var: MEMORY_STORE_ID");
    const base = `/memory_stores/${MEMORY_STORE_ID}/memories`;

    if (event.httpMethod === "POST") {
      const { slips, leagues, appVersion } = JSON.parse(event.body || "{}");
      if (!Array.isArray(slips) || !slips.length) return reply(400, { error: "slips[] is required" });

      const saved = [];
      const now = new Date();
      for (const [index, slip] of slips.entries()) {
        try {
          const rec = buildRecord(slip, { now, index, leagues, appVersion });
          const mem = await api(base, {
            method: "POST",
            headers: MEMORY_HEADERS,
            body: JSON.stringify({ path: recordPath(rec), content: JSON.stringify(rec, null, 2) }),
          });
          saved.push({ id: rec.id, path: mem.path });
        } catch (err) {
          console.error(err);
          return reply(502, { error: `Saved ${saved.length} of ${slips.length} slips, then failed: ${err.message}`, saved });
        }
      }
      return reply(200, { saved });
    }

    const files = await listAll(base, { view: "full", limit: "20", path_prefix: "/slips/" }, MEMORY_HEADERS);
    const slips = [];
    const warnings = [];
    for (const f of files) {
      if (!/\.json$/i.test(f.path)) continue;
      try {
        slips.push({ ...parseRecord(f.content), path: f.path });
      } catch (err) {
        warnings.push(`${f.path}: ${err.message}`);
      }
    }
    slips.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return reply(200, { slips, warnings });
  } catch (err) {
    console.error(err);
    return reply(500, { error: err.message });
  }
};
