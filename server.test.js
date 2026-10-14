"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer, cleanup, rooms } = require("./server.js");

let server;
let baseUrl;

test.before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rooms.clear();
});

async function post(path, value) {
  const response = await fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  return { status: response.status, body: await response.json() };
}

test("creates rooms, joins players, and relays real paddle state only to room members", async () => {
  const created = await post("/rooms", { protocol: 2, name: "host", levelId: "levels/song-a" });
  assert.equal(created.status, 201);
  assert.match(created.body.code, /^[2-9]{6}$/);
  const joined = await post(`/rooms/${created.body.code}/join`, { protocol: 2, name: "guest" });
  assert.equal(joined.status, 200);
  assert.notEqual(joined.body.playerId, created.body.playerId);

  const state = {
    seq: 1, x: 91, y: 177, angle: 24, alive: true,
    paddles: [{ id: 1, baseAngle: 359, size: 70, width: 11 }],
    levelId: "levels/song-a", gameState: "playing",
    progress: { beat: 6.5, total: 128 },
  };
  const sync = await post(`/rooms/${created.body.code}/sync`, { protocol: 2, playerId: created.body.playerId, state });
  assert.equal(sync.status, 200);
  assert.equal(sync.body.players.length, 0);
  const guestSync = await post(`/rooms/${created.body.code}/sync`, { protocol: 2, playerId: joined.body.playerId, state: null });
  assert.equal(guestSync.body.players.length, 1);
  assert.equal(guestSync.body.players[0].state.x, 91);
  assert.deepEqual(guestSync.body.players[0].state.paddles, state.paddles);
  assert.equal(guestSync.body.players[0].state.angle, 24);
});

test("rejects malformed state and prevents room identity spoofing or cross-room leakage", async () => {
  const first = await post("/rooms", { protocol: 2, name: "one" });
  const second = await post("/rooms", { protocol: 2, name: "two" });
  const invalid = await post(`/rooms/${first.body.code}/sync`, {
    protocol: 2,
    playerId: first.body.playerId,
    state: { seq: 1, x: "bad", y: 0, angle: 0, paddles: [], alive: true },
  });
  assert.equal(invalid.status, 400);

  const spoof = await post(`/rooms/${first.body.code}/sync`, {
    protocol: 2,
    playerId: second.body.playerId,
    state: null,
  });
  assert.equal(spoof.status, 403);

  const isolated = await post(`/rooms/${second.body.code}/sync`, { protocol: 2, playerId: second.body.playerId, state: null });
  assert.deepEqual(isolated.body.players, []);
});

test("room host publishes its selected level and guests cannot replace it", async () => {
  const host = await post("/rooms", { protocol: 2, name: "host" });
  const guest = await post(`/rooms/${host.body.code}/join`, { protocol: 2, name: "guest" });
  const selectedLevel = { levelId: "levels/song-a/", variant: "Expert" };
  const selected = await post(`/rooms/${host.body.code}/sync`, {
    protocol: 2, playerId: host.body.playerId, state: null, selectedLevel,
  });
  assert.deepEqual(selected.body.selectedLevel, selectedLevel);
  const spoof = await post(`/rooms/${host.body.code}/sync`, {
    protocol: 2, playerId: guest.body.playerId, state: null,
    selectedLevel: { levelId: "levels/other/", variant: "" },
  });
  assert.equal(spoof.status, 403);
  const guestSync = await post(`/rooms/${host.body.code}/sync`, {
    protocol: 2, playerId: guest.body.playerId, state: null,
  });
  assert.deepEqual(guestSync.body.selectedLevel, selectedLevel);
});

test("rejects stale snapshots and removes a player after explicit leave", async () => {
  const created = await post("/rooms", { protocol: 2, name: "host" });
  const state = { seq: 5, x: 10, y: 20, angle: 359, alive: true, paddles: [], gameState: "playing" };
  const first = await post(`/rooms/${created.body.code}/sync`, { protocol: 2, playerId: created.body.playerId, state });
  assert.equal(first.status, 200);
  const stale = await post(`/rooms/${created.body.code}/sync`, { protocol: 2, playerId: created.body.playerId, state });
  assert.equal(stale.status, 409);
  const left = await post(`/rooms/${created.body.code}/leave`, { playerId: created.body.playerId });
  assert.equal(left.status, 200);
  const missing = await fetch(`${baseUrl}/rooms/${created.body.code}/sync`, { method: "POST", body: "{}" });
  assert.equal(missing.status, 404);
});

test("expires inactive players and cleans up empty rooms", async () => {
  const created = await post("/rooms", { protocol: 2, name: "idle" });
  assert.equal(rooms.has(created.body.code), true);
  cleanup(Date.now() + 21_000);
  assert.equal(rooms.has(created.body.code), false);
});

test("shares bounded custom level files with room members after upload completes", async () => {
  const host = await post("/rooms", { protocol: 2, name: "host" });
  const guest = await post(`/rooms/${host.body.code}/join`, { protocol: 2, name: "guest" });
  const begin = await post(`/rooms/${host.body.code}/levels/begin`, {
    playerId: host.body.playerId, name: "demo", levelId: "Custom Levels/demo/",
    files: [{ path: "level.json", size: 5 }, { path: "audio/song.ogg", size: 4 }],
  });
  assert.equal(begin.status, 201);
  const listPath = `/rooms/${host.body.code}/levels/list`;
  assert.deepEqual((await post(listPath, { playerId: guest.body.playerId })).body.levels, []);
  const chunkPath = `/rooms/${host.body.code}/levels/chunk`;
  for (const [file, value] of [[0, "hello"], [1, "test"]]) {
    assert.equal((await post(chunkPath, { playerId: host.body.playerId, id: begin.body.id, file, offset: 0, data: Buffer.from(value).toString("base64") })).status, 200);
  }
  const finishPath = `/rooms/${host.body.code}/levels/finish`;
  assert.equal((await post(finishPath, { playerId: host.body.playerId, id: begin.body.id })).body.levels.length, 1);
  const read = await post(`/rooms/${host.body.code}/levels/read`, { playerId: guest.body.playerId, id: begin.body.id, file: 0, offset: 0 });
  assert.equal(Buffer.from(read.body.data, "base64").toString(), "hello");
  const traversal = await post(`/rooms/${host.body.code}/levels/begin`, { playerId: host.body.playerId, name: "bad", levelId: "x", files: [{ path: "../secret", size: 1 }] });
  assert.equal(traversal.status, 400);
  const other = await post("/rooms", { protocol: 2, name: "other" });
  assert.equal((await post(listPath, { playerId: other.body.playerId })).status, 403);
});
