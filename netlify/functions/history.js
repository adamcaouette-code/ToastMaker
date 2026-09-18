const { listMemories } = require("./_anthropic");

// KNOWN LIMITATION: your four agents don't yet write slip records in one
// consistent structured shape (that's a follow-up task, not done yet).
// So this can only reliably parse a slip if a memory file happens to
// contain a fenced ```json block matching Design's slip shape (see
// app.js SLIP SHAPE comment) plus an "outcome" field for status/results.
// Anything else gets wrapped as a bare note so the tab doesn't crash, but
// it won't render as a full card with per-leg hit/miss until the memory
// schema is standardized across Slip Builder / Bet-Sizing / Results-Logger.

exports.handler = async () => {
  try {
    const { MEMORY_STORE_ID } = process.env;
    if (!MEMORY_STORE_ID) throw new Error("Missing env var: MEMORY_STORE_ID");

    const files = (await listMemories(MEMORY_STORE_ID))
      .filter((f) => /slip/i.test(f.path) && !/review|preferences/i.test(f.path))
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    const slips = files.map((f, i) => {
      const match = (f.content || "").match(/```json\s*([\s\S]*?)```/);
      if (match) {
        try {
          const parsed = JSON.parse(match[1]);
          if (parsed && (parsed.legs || parsed.entryType)) {
            return { id: f.path, date: new Date(f.updated_at).toLocaleDateString(), ...parsed };
          }
        } catch {
          // fall through
        }
      }
      // Unparseable — wrap as a plain note-style entry instead of dropping it.
      return {
        id: f.path || `slip-${i}`,
        date: new Date(f.updated_at).toLocaleDateString(),
        entryType: "flex",
        entry: 0,
        multiplier: 0,
        payout: 0,
        status: "unknown",
        note: f.content ? f.content.slice(0, 400) : "(empty)",
        legs: [],
      };
    });

    return { statusCode: 200, body: JSON.stringify({ slips }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
