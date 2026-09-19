// The saved-slip record ("slip-v1"): one JSON memory file per generated slip,
// written by the app on every real Generate and read back by History (and by
// any agent that wants to grade or review it).
//
// Path follows the rule in the store's Rules.md — a folder per day named
//   YYYY/MM/DD SPORT-ID PARLAY-LEG-AMOUNT WIN-LOSS-PENDING
// e.g. /slips/2026/09/19 MLB 3-LEG PENDING/20260919T184205Z-0k3f.json
// Grading later = rename PENDING -> WIN/LOSS and fill in legs[].status/result.

const DAY_TZ = "America/New_York"; // "the day the slip was made", per Rules.md

const num = (v) => (v !== "" && v != null && Number.isFinite(Number(v)) ? Number(v) : null);
const clean = (s) => [...String(s ?? "").replace(/[\/]+/g, "-")].filter((c) => c.charCodeAt(0) >= 32 && c !== String.fromCharCode(8232) && c !== String.fromCharCode(8233)).join("").trim();

function buildRecord(slip, { now = new Date(), index = 0, leagues = [], appVersion = "" } = {}) {
  const legs = (slip.legs || []).map((l) => ({
    player: String(l.player || ""),
    league: String(l.league || ""),
    team: String(l.team || ""),
    opponent: String(l.opponent || ""),
    stat: String(l.stat || ""),
    line: num(l.line),
    pick: ["under", "less"].includes(String(l.pick || "").toLowerCase()) ? "under" : "over",
    hitProb: num(l.hitProb),
    reasoning: typeof l.reasoning === "string" ? l.reasoning : "",
    status: "open", // open | hit | miss | push | void  (set when graded)
    result: null,   // the player's actual stat (set when graded)
  }));
  if (!legs.length) throw new Error("slip has no legs");
  if (legs.some((l) => !l.player)) throw new Error("a leg has no player name");

  const found = [...new Set(legs.map((l) => l.league).filter(Boolean))];
  const sports = found.length ? found : leagues;
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";

  return {
    schema: "slip-v1",
    id: `${stamp}-${index}${Math.random().toString(36).slice(2, 5)}`,
    createdAt: now.toISOString(),
    date: now.toLocaleDateString("en-CA", { timeZone: DAY_TZ }), // YYYY-MM-DD
    league: sports.join("/") || "UNKNOWN",
    entryType: slip.entryType === "power" ? "power" : "flex",
    entry: num(slip.entry) ?? 0,
    multiplier: num(slip.multiplier) ?? 0,
    payout: num(slip.payout) ?? 0,
    note: typeof slip.note === "string" ? slip.note : "",
    status: "pending", // pending | won | lost
    legs,
    appVersion,
  };
}

function recordPath(rec, status = "PENDING") {
  const [y, m, d] = rec.date.split("-");
  return `/slips/${y}/${m}/${d} ${clean(rec.league)} ${rec.legs.length}-LEG ${status}/${rec.id}.json`;
}

function parseRecord(content) {
  const r = JSON.parse(content);
  if (!r || r.schema !== "slip-v1" || !Array.isArray(r.legs)) throw new Error("not a slip-v1 record");
  return r;
}

module.exports = { buildRecord, recordPath, parseRecord };
