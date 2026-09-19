// Run: node --test test/history.test.js — the saved-slip record and the History endpoint.
const test = require("node:test");
const assert = require("node:assert");
process.env.ANTHROPIC_API_KEY = "test";
process.env.MEMORY_STORE_ID = "memstore_test";
const { buildRecord, recordPath, parseRecord } = require("../netlify/functions/_slips");
const { handler } = require("../netlify/functions/history");

const slip = {
  entryType: "flex", entry: 0.5, multiplier: 2.25, payout: 1.13, note: "why",
  legs: [
    { player: "Nico Hoerner", league: "MLB", team: "CHC", opponent: "vs CIN", stat: "Hits", line: 0.5, pick: "more", hitProb: 68.9, reasoning: "r" },
    { player: "Pete Crow-Armstrong", league: "MLB", team: "CHC", opponent: "vs CIN", stat: "Hits", line: "0.5", pick: "under" },
  ],
};
const NOW = new Date("2026-09-20T02:30:00Z"); // 22:30 on Sep 19 in New York

test("record: normalized legs, pending, day follows New York time (not UTC)", () => {
  const r = buildRecord(slip, { now: NOW, appVersion: "v9" });
  assert.strictEqual(r.date, "2026-09-19");
  assert.strictEqual(r.status, "pending");
  assert.deepStrictEqual(r.legs.map((l) => l.pick), ["over", "under"]); // legacy "more" -> over
  assert.strictEqual(r.legs[1].line, 0.5);
  assert.strictEqual(r.legs[1].hitProb, null);
  assert.deepStrictEqual(r.legs.map((l) => l.status), ["open", "open"]);
});

test("path follows the daily-folder rule: YYYY/MM/DD SPORT N-LEG STATUS", () => {
  const r = buildRecord(slip, { now: NOW });
  assert.match(recordPath(r), /^\/slips\/2026\/09\/19 MLB 2-LEG PENDING\/20260920T023000Z-0\w+\.json$/);
  assert.match(recordPath(r, "WIN"), /2-LEG WIN\//);
});

test("bad slips are rejected, not saved half-empty", () => {
  assert.throws(() => buildRecord({ legs: [] }), /no legs/);
  assert.throws(() => buildRecord({ legs: [{ league: "MLB" }] }), /no player/);
  assert.throws(() => parseRecord('{"schema":"other","legs":[]}'), /slip-v1/);
});

test("POST saves each slip as a memory file at the right path", async () => {
  const calls = [];
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url: String(url), beta: opts.headers["anthropic-beta"], body });
    return { ok: true, text: async () => JSON.stringify({ path: body.path }) };
  };
  const res = await handler({ httpMethod: "POST", body: JSON.stringify({ slips: [slip, slip], appVersion: "v9" }) });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.length, 2);
  assert.match(calls[0].url, /memory_stores\/memstore_test\/memories$/);
  assert.strictEqual(calls[0].beta, "agent-memory-2026-07-22"); // memory endpoints take this beta alone
  assert.strictEqual(parseRecord(calls[0].body.content).legs.length, 2);
  assert.notStrictEqual(JSON.parse(res.body).saved[0].id, JSON.parse(res.body).saved[1].id);
});

test("POST failure is loud: 502, says how many saved, no silent success", async () => {
  let n = 0;
  global.fetch = async () => (++n === 1
    ? { ok: true, text: async () => JSON.stringify({ path: "/x" }) }
    : { ok: false, status: 500, text: async () => "{}" });
  const res = await handler({ httpMethod: "POST", body: JSON.stringify({ slips: [slip, slip] }) });
  assert.strictEqual(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /Saved 1 of 2/);
});

test("GET returns only slip-v1 records, newest first; notes skipped, bad json warned", async () => {
  const rec = (createdAt) => JSON.stringify({ ...buildRecord(slip, { now: new Date(createdAt) }) });
  const files = [
    { path: "/slips/Rules.md", content: "# rules" },
    { path: "/slips/2026-09-19_sizing_decisions.md", content: "# note" },
    { path: "/slips/2026/09/18 MLB 2-LEG PENDING/a.json", content: rec("2026-09-18T15:00:00Z") },
    { path: "/slips/2026/09/19 MLB 2-LEG PENDING/b.json", content: rec("2026-09-19T15:00:00Z") },
    { path: "/slips/2026/09/19 MLB 2-LEG PENDING/broken.json", content: "{nope" },
  ];
  global.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ data: files, next_page: null }) });
  const res = JSON.parse((await handler({ httpMethod: "GET" })).body);
  assert.deepStrictEqual(res.slips.map((s) => s.date), ["2026-09-19", "2026-09-18"]);
  assert.strictEqual(res.warnings.length, 1);
  assert.match(res.warnings[0], /broken\.json/);
});
