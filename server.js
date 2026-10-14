"use strict";

const crypto = require("node:crypto");
const http = require("node:http");

const PROTOCOL = 2;
const MAX_PLAYERS = 8;
const MAX_BODY = 20 * 1024;
const PLAYER_TIMEOUT_MS = 20_000;
const MAX_LEVEL_BYTES = 32 * 1024 * 1024;
const MAX_LEVEL_FILES = 199;
const LEVEL_CHUNK_BYTES = 8 * 1024;
const rooms = new Map();
const limits = new Map();
const alphabet = "23456789";

function cleanName(value) {
  if (typeof value !== "string") return "Player";
  const name = value.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 24);
  return name || "Player";
}

function send(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(body);
}

function rateLimit(req, res, cost = 1) {
  const ip = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let entry = limits.get(ip);
  if (!entry || now - entry.startedAt >= 10_000) {
    entry = { startedAt: now, requests: 0 };
    limits.set(ip, entry);
  }
  entry.requests += cost;
  if (entry.requests > 600) {
    send(res, 429, { ok: false, error: "rateLimited" });
    return false;
  }
  return true;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("bodyTooLarge"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalidJson");
        resolve(value);
      } catch {
        reject(Object.assign(new Error("invalidJson"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function makeCode() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = "";
    for (let i = 0; i < 6; i += 1) code += alphabet[crypto.randomInt(alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error("Unable to allocate a room code");
}

function makePlayer(room, name, levelId) {
  const player = {
    playerId: crypto.randomUUID(),
    name: cleanName(name),
    levelId: typeof levelId === "string" ? levelId.slice(0, 256) : null,
    state: null,
    updatedAt: Date.now(),
    lastSeq: -1,
  };
  room.players.set(player.playerId, player);
  return player;
}

function memberList(room) {
  return [...room.players.values()].map((player) => ({
    playerId: player.playerId,
    name: player.name,
    levelId: player.state?.levelId ?? player.levelId,
    gameState: player.state?.gameState ?? "waiting",
    alive: player.state?.alive ?? true,
  }));
}

function validState(value) {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const finite = (number, low, high) => typeof number === "number" && Number.isFinite(number) && number >= low && number <= high;
  if (!Number.isSafeInteger(value.seq) || value.seq < 0) return false;
  if (!finite(value.x, -10_000, 10_000) || !finite(value.y, -10_000, 10_000) || !finite(value.angle, -360_000, 360_000)) return false;
  if (typeof value.alive !== "boolean" || !Array.isArray(value.paddles) || value.paddles.length > 8) return false;
  for (const paddle of value.paddles) {
    if (!paddle || !Number.isInteger(paddle.id) || paddle.id < 1 || paddle.id > 8 || !finite(paddle.baseAngle, -360_000, 360_000) || !finite(paddle.size, 0, 360) || !finite(paddle.width, 0, 500)) return false;
  }
  if (value.levelId !== null && value.levelId !== undefined && (typeof value.levelId !== "string" || value.levelId.length > 256)) return false;
  if (value.gameState !== undefined && !["loading", "waiting", "playing", "finished"].includes(value.gameState)) return false;
  if (value.progress !== null && value.progress !== undefined) {
    if (typeof value.progress !== "object" || !finite(value.progress.beat, -1_000_000, 1_000_000)) return false;
    if (value.progress.total !== null && value.progress.total !== undefined && !finite(value.progress.total, -1_000_000, 1_000_000)) return false;
  }
  return true;
}

function validRelativePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 240
    && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function transferList(room) {
  return [...room.levels.values()].filter((level) => level.complete).map((level) => ({
    id: level.id, name: level.name, levelId: level.levelId, bytes: level.bytes,
    files: level.files.map(({ path, size }) => ({ path, size })),
  }));
}

function getMember(room, playerId) {
  return typeof playerId === "string" ? room.players.get(playerId) : null;
}

function cleanup(now = Date.now()) {
  for (const [code, room] of rooms) {
    for (const [id, player] of room.players) {
      if (now - player.updatedAt > PLAYER_TIMEOUT_MS) {
        room.players.delete(id);
        for (const [levelId, level] of room.levels) if (level.ownerId === id && !level.complete) room.levels.delete(levelId);
      }
    }
    if (room.players.size === 0) rooms.delete(code);
  }
  for (const [ip, entry] of limits) if (now - entry.startedAt > 60_000) limits.delete(ip);
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (!rateLimit(req, res)) return;
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, protocol: PROTOCOL, rooms: rooms.size });

    try {
      if (req.method === "POST" && url.pathname === "/rooms") {
        const body = await readJson(req);
        if (body.protocol !== PROTOCOL) return send(res, 426, { ok: false, error: "protocolMismatch" });
        const code = makeCode();
        const room = { code, createdAt: Date.now(), players: new Map(), levels: new Map() };
        const player = makePlayer(room, body.name, body.levelId);
        rooms.set(code, room);
        return send(res, 201, { ok: true, protocol: PROTOCOL, code, playerId: player.playerId, levelId: player.levelId, players: memberList(room) });
      }

      const match = url.pathname.match(/^\/rooms\/([2-9]{6})\/(join|sync|leave|levels\/(?:list|begin|chunk|finish|read))$/);
      if (!match || req.method !== "POST") return send(res, 404, { ok: false, error: "notFound" });
      const [, code, action] = match;
      const body = await readJson(req);
      const room = rooms.get(code);
      if (action === "join") {
        if (body.protocol !== PROTOCOL) return send(res, 426, { ok: false, error: "protocolMismatch" });
        if (!room) return send(res, 404, { ok: false, error: "roomNotFound" });
        if (room.players.size >= MAX_PLAYERS) return send(res, 409, { ok: false, error: "roomFull" });
        const player = makePlayer(room, body.name, null);
        return send(res, 200, { ok: true, protocol: PROTOCOL, playerId: player.playerId, levelId: [...room.players.values()][0]?.levelId ?? null, players: memberList(room), levels: transferList(room) });
      }
      if (!room) return send(res, 404, { ok: false, error: "roomNotFound" });
      if (action.startsWith("levels/")) {
        const player = getMember(room, body.playerId);
        if (!player) return send(res, 403, { ok: false, error: "invalidSession" });
        player.updatedAt = Date.now();
        if (action === "levels/list") return send(res, 200, { ok: true, levels: transferList(room) });
        if (action === "levels/begin") {
          if (typeof body.levelId !== "string" || body.levelId.length > 256 || !Array.isArray(body.files)
            || body.files.length < 1 || body.files.length > MAX_LEVEL_FILES) return send(res, 400, { ok: false, error: "invalidLevel" });
          let bytes = 0;
          const files = [];
          const paths = new Set();
          for (const file of body.files) {
            if (!file || !validRelativePath(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_LEVEL_BYTES) return send(res, 400, { ok: false, error: "invalidFile" });
            if (paths.has(file.path)) return send(res, 400, { ok: false, error: "duplicateFile" });
            paths.add(file.path);
            bytes += file.size;
            files.push({ path: file.path, size: file.size, chunks: new Map(), received: 0 });
          }
          if (bytes > MAX_LEVEL_BYTES) return send(res, 413, { ok: false, error: "levelTooLarge" });
          for (const existing of room.levels.values()) if (existing.ownerId === player.playerId) room.levels.delete(existing.id);
          const roomBytes = [...room.levels.values()].reduce((sum, level) => sum + level.bytes, 0);
          if (roomBytes + bytes > MAX_LEVEL_BYTES) return send(res, 413, { ok: false, error: "roomLevelStorageFull" });
          const id = crypto.randomBytes(12).toString("hex");
          room.levels.set(id, { id, ownerId: player.playerId, name: cleanName(body.name || "Custom level"), levelId: body.levelId, bytes, files, complete: false, createdAt: Date.now() });
          return send(res, 201, { ok: true, id, chunkBytes: LEVEL_CHUNK_BYTES });
        }
        const level = room.levels.get(body.id);
        if (!level || !level.complete && level.ownerId !== player.playerId) return send(res, 404, { ok: false, error: "levelNotFound" });
        if (action === "levels/chunk") {
          if (level.ownerId !== player.playerId || level.complete || !Number.isInteger(body.file) || !Number.isInteger(body.offset)
            || body.file < 0 || body.file >= level.files.length || typeof body.data !== "string" || body.data.length > 12_000) return send(res, 400, { ok: false, error: "invalidChunk" });
          const file = level.files[body.file];
          const buffer = Buffer.from(body.data, "base64");
          if (buffer.length > LEVEL_CHUNK_BYTES || buffer.toString("base64") !== body.data || body.offset < 0
            || body.offset % LEVEL_CHUNK_BYTES !== 0 || body.offset + buffer.length > file.size
            || buffer.length !== Math.min(LEVEL_CHUNK_BYTES, file.size - body.offset)) return send(res, 400, { ok: false, error: "invalidChunk" });
          if (!file.chunks.has(body.offset)) { file.chunks.set(body.offset, buffer); file.received += buffer.length; }
          return send(res, 200, { ok: true, received: level.files.reduce((sum, item) => sum + item.received, 0), total: level.bytes });
        }
        if (action === "levels/finish") {
          if (level.ownerId !== player.playerId) return send(res, 403, { ok: false, error: "invalidSession" });
          if (level.files.some((file) => file.received !== file.size)) return send(res, 409, { ok: false, error: "levelIncomplete" });
          level.complete = true;
          return send(res, 200, { ok: true, id: level.id, levels: transferList(room) });
        }
        if (action === "levels/read") {
          if (!level.complete || !Number.isInteger(body.file) || !Number.isInteger(body.offset) || body.file < 0 || body.file >= level.files.length || body.offset < 0) return send(res, 400, { ok: false, error: "invalidRead" });
          const file = level.files[body.file];
          const size = Math.min(LEVEL_CHUNK_BYTES, file.size - body.offset);
          if (size < 0 || body.offset % LEVEL_CHUNK_BYTES !== 0) return send(res, 400, { ok: false, error: "invalidRead" });
          const chunk = file.chunks.get(body.offset);
          if (size > 0 && !chunk) return send(res, 404, { ok: false, error: "chunkNotFound" });
          return send(res, 200, { ok: true, data: chunk ? chunk.toString("base64") : "", offset: body.offset, fileSize: file.size });
        }
      }
      if (action === "sync" && body.protocol !== PROTOCOL) return send(res, 426, { ok: false, error: "protocolMismatch" });
      const player = room.players.get(body.playerId);
      if (!player) return send(res, 403, { ok: false, error: "invalidSession" });
      if (action === "leave") {
        room.players.delete(player.playerId);
        for (const [levelId, level] of room.levels) if (level.ownerId === player.playerId && !level.complete) room.levels.delete(levelId);
        if (room.players.size === 0) rooms.delete(code);
        return send(res, 200, { ok: true });
      }
      if (!validState(body.state)) return send(res, 400, { ok: false, error: "invalidState" });
      if (body.state && body.state.seq <= player.lastSeq) return send(res, 409, { ok: false, error: "staleState" });
      if (body.state) {
        player.lastSeq = body.state.seq;
        player.state = body.state;
        player.levelId = body.state.levelId || player.levelId;
      }
      player.updatedAt = Date.now();
        return send(res, 200, {
        ok: true,
        protocol: PROTOCOL,
        serverTime: Date.now(),
        levelId: [...room.players.values()][0]?.levelId ?? null,
        members: memberList(room),
          levels: transferList(room),
        players: [...room.players.values()].filter((other) => other.playerId !== player.playerId && other.state).map((other) => ({
          playerId: other.playerId,
          name: other.name,
          updatedAt: other.updatedAt,
          state: other.state,
        })),
      });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) send(res, error.status || 500, { ok: false, error: error.status ? error.message : "serverError" });
    }
  });
  return server;
}

const cleanupTimer = setInterval(() => cleanup(), 5_000);
cleanupTimer.unref();

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  createServer().listen(port, "0.0.0.0", () => console.log(`[bbmp-relay] listening on :${port}`));
}

module.exports = { createServer, cleanup, rooms, validState, validRelativePath, MAX_LEVEL_BYTES, LEVEL_CHUNK_BYTES };
