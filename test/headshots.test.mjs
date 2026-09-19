// Run: node --test test/   — headshots resolve only on confident matches.
import test from "node:test";
import assert from "node:assert";
import { handler } from "../netlify/functions/headshots.mjs";

const espn = (items) => async () => ({ ok: true, json: async () => ({ items }) });
const call = async (league, names) =>
  JSON.parse((await handler({ httpMethod: "POST", body: JSON.stringify({ league, names }) })).body);

test("suffix difference still matches, returns the ESPN headshot url", async () => {
  global.fetch = espn([{ id: "40001", displayName: "Michael Harris II" }]);
  const r = await call("MLB", ["Michael Harris"]);
  assert.strictEqual(r.headshots["Michael Harris"], "https://a.espncdn.com/i/headshots/mlb/players/full/40001.png");
});

test("ambiguous initial+last is refused (no photo, not a guess)", async () => {
  global.fetch = espn([
    { id: "1", displayName: "Nathan Lowe" },
    { id: "2", displayName: "Noah Lowe" },
  ]);
  const r = await call("MLB", ["Nate Lowe"]);
  assert.strictEqual(r.headshots["Nate Lowe"], null);
});

test("no results -> null; unsupported league -> nothing", async () => {
  global.fetch = espn([]);
  assert.strictEqual((await call("NBA", ["Nobody Real"])).headshots["Nobody Real"], null);
  assert.strictEqual((await call("CRICKET", ["X Y"])).unsupported, "CRICKET");
});

test("results are cached: second request doesn't hit ESPN", async () => {
  let hits = 0;
  global.fetch = async () => (hits++, { ok: true, json: async () => ({ items: [{ id: "9", displayName: "Cache Test" }] }) });
  await call("NFL", ["Cache Test"]);
  await call("NFL", ["Cache Test"]);
  assert.strictEqual(hits, 1);
});

test("ESPN failure -> null plus a visible error, and not cached", async () => {
  global.fetch = async () => ({ ok: false, status: 503 });
  const r = await call("NHL", ["Some Player"]);
  assert.strictEqual(r.headshots["Some Player"], null);
  assert.match(r.errors[0], /503/);
});
