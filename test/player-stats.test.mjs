// Run: node --test test/player-stats.test.mjs — offline; pins the stat math.
import test from "node:test";
import assert from "node:assert";
import { parseGamelog, buildCard, handler } from "../netlify/functions/player-stats.mjs";

// Three MLB-shaped games: hits/2B/3B/HR/RBI/avg columns as ESPN sends them.
const log = {
  names: ["hits", "doubles", "triples", "homeRuns", "RBIs", "avg"],
  displayNames: ["Hits", "Doubles", "Triples", "Home Runs", "RBIs", "Batting Average"],
  events: {
    a: { gameDate: "2026-09-01", atVs: "vs", opponent: { abbreviation: "CIN" } },
    b: { gameDate: "2026-09-02", atVs: "@", opponent: { abbreviation: "STL" } },
    c: { gameDate: "2026-09-03", atVs: "vs", opponent: { abbreviation: "MIL" } },
  },
  seasonTypes: [{
    displayName: "2026 Regular Season",
    categories: [{ events: [
      { eventId: "c", stats: ["1", "0", "0", "0", "0", ".300"] }, // out of order on purpose
      { eventId: "a", stats: ["2", "1", "0", "0", "1", ".250"] },
      { eventId: "b", stats: ["3", "0", "0", "1", "2", ".280"] },
    ] }],
  }],
};

test("games sort by date; total bases = H + 2B + 2*3B + 3*HR", () => {
  const card = buildCard(parseGamelog(log), { stat: "Total Bases", line: 2.5, pick: "more" });
  assert.deepStrictEqual(card.prop.log.map((g) => g.v), [3, 6, 1]); // a: 2+1, b: 3+3, c: 1
  assert.deepStrictEqual(card.prop.log.map((g) => g.opp), ["vsCIN", "@STL", "vsMIL"]);
});

test("hit rate honors the pick direction", () => {
  const more = buildCard(parseGamelog(log), { stat: "Total Bases", line: 2.5, pick: "more" }).prop;
  const less = buildCard(parseGamelog(log), { stat: "Total Bases", line: 2.5, pick: "less" }).prop;
  assert.deepStrictEqual([more.hits, more.of], [2, 3]);
  assert.deepStrictEqual([less.hits, less.of], [1, 3]);
});

test("unmapped stat: no prop block, but the generic grid still builds (rates skipped)", () => {
  const card = buildCard(parseGamelog(log), { stat: "Made Up Stat", line: 1, pick: "more" });
  assert.strictEqual(card.prop, null);
  assert.ok(card.averages.some((a) => a.label === "Hits"));
  assert.ok(!card.averages.some((a) => /average/i.test(a.label)));
});

test("stat whose operands are missing is not guessed (pitcher asked for hitter stat)", () => {
  const pitcher = { ...log, names: ["inningsPitched"], displayNames: ["IP"],
    seasonTypes: [{ displayName: "Regular Season", categories: [{ events: [{ eventId: "a", stats: ["6.0"] }] }] }] };
  assert.strictEqual(buildCard(parseGamelog(pitcher), { stat: "Total Bases", line: 1.5 }).prop, null);
});

test("no confident ESPN match -> matched:false (no stats)", async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({ items: [] }) });
  const r = JSON.parse((await handler({ httpMethod: "POST", body: JSON.stringify({ league: "MLB", player: "Nobody Zzz" }) })).body);
  assert.strictEqual(r.matched, false);
});

test("ESPN gamelog failure -> 502 with a reason, not an empty card", async () => {
  global.fetch = async (url) => String(url).includes("/search")
    ? { ok: true, json: async () => ({ items: [{ id: "77", displayName: "Real Player" }] }) }
    : { ok: false, status: 503 };
  const res = await handler({ httpMethod: "POST", body: JSON.stringify({ league: "NFL", player: "Real Player" }) });
  assert.strictEqual(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /503/);
});

test("chart/hit rate cover the last 5 games only, each carrying its opponent abbreviation", () => {
  const events = {}, evs = [];
  for (let i = 1; i <= 7; i++) {
    events["g" + i] = { gameDate: `2026-09-0${i}`, atVs: i % 2 ? "vs" : "@", opponent: { abbreviation: "OP" + i } };
    evs.push({ eventId: "g" + i, stats: [String(i), "0", "0", "0", "0", ".300"] });
  }
  const seven = { ...log, events, seasonTypes: [{ displayName: "Regular Season", categories: [{ events: evs }] }] };
  const prop = buildCard(parseGamelog(seven), { stat: "Hits", line: 4.5, pick: "over" }).prop;
  assert.strictEqual(prop.log.length, 5);
  assert.deepStrictEqual(prop.log.map((g) => g.v), [3, 4, 5, 6, 7]);
  assert.deepStrictEqual(prop.log.map((g) => g.oppAbbr), ["OP3", "OP4", "OP5", "OP6", "OP7"]);
  assert.deepStrictEqual([prop.hits, prop.of], [3, 5]);
});
