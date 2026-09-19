// Run: node --test test/   — proves the PrizePicks parser fails loudly.
const test = require("node:test");
const assert = require("node:assert");
const { normalize, leagueKind } = require("../netlify/functions/_prizepicks");

const player = { type: "new_player", id: "p1", attributes: { display_name: "Nico Hoerner", team: "CHC", position: "2B" } };
const row = (attrs = {}, pid = "p1") => ({
  id: "r1",
  attributes: { line_score: 0.5, stat_type: "Hits", odds_type: "demon", description: "CIN", ...attrs },
  relationships: { new_player: { data: { id: pid } } },
});

test("normalizes a good row", () => {
  const [l] = normalize([row()], [player]);
  assert.deepStrictEqual([l.player, l.team, l.stat, l.line, l.oddsType], ["Nico Hoerner", "CHC", "Hits", 0.5, "demon"]);
});
test("throws on missing line_score", () => assert.throws(() => normalize([row({ line_score: undefined })], [player]), /line_score/));
test("throws on missing stat_type", () => assert.throws(() => normalize([row({ stat_type: "" })], [player]), /stat_type/));
test("throws on unresolvable player", () => assert.throws(() => normalize([row()], []), /player/));
test("classifies boards", () => {
  assert.strictEqual(leagueKind("MLB"), "game");
  assert.strictEqual(leagueKind("NFLSZN"), "season");
  assert.strictEqual(leagueKind("MLBLIVE"), "live");
  assert.strictEqual(leagueKind("WNBA1H", "9"), "period");
});
