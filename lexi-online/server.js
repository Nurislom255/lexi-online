// server.js - Lexi Online: a multiplayer word-card game for CS students.
// Runs with plain Node.js (version 18 or newer). No npm packages needed.
//   node server.js            -> http://localhost:3000
//   PORT=8080 node server.js  -> another port
//
// How the parts talk to each other:
//   Browser --POST /api/...--> server   (a player does something: join, throw a card, answer)
//   Browser <--GET /api/events-- server (Server-Sent Events: the server pushes the new
//                                         table state to every player whenever it changes)
//
// Drafted with help from Claude (AI); reviewed and modified by the team.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Game settings (change these to tune the game)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const HAND_SIZE = 5;
const MIN_WORD_CARDS = 2;          // a hand always keeps at least this many word cards
const POWER_CARD_CHANCE = 0.3;     // chance that a drawn card is a power card
const WIN_SCORES = [8, 10, 15];    // choices the host can pick from
const TURN_SECONDS = 40;           // time to throw a card before one is thrown for you
const ANSWER_SECONDS = 15;
const BLITZ_SECONDS = 6;
const REVEAL_SECONDS = Number(process.env.REVEAL) || 4;   // pause after the answer is revealed (REVEAL=0.1 for fast tests)
const POINTS_DEFEND = 2;           // defender answers correctly
const POINTS_FAST_BONUS = 1;       // defender answers in the first third of the time
const POINTS_HIT = 2;              // defender is wrong or runs out of time
const NAME_MAX = 16;

// Power cards. "attack" cards are thrown with a word card; "defense" cards
// are played by the player who is answering.
const POWERS = {
  blitz:  { name: "Blitz",  kind: "attack",  weight: 3, text: "Only 6 seconds to answer." },
  double: { name: "Double", kind: "attack",  weight: 2, text: "Every point in this duel counts twice." },
  crowd:  { name: "Crowd",  kind: "attack",  weight: 2, text: "Six answers to choose from instead of four." },
  steal:  { name: "Steal",  kind: "attack",  weight: 2, text: "If they miss, you also take 1 of their points." },
  peek:   { name: "Peek",   kind: "defense", weight: 3, text: "Play while answering: removes two wrong answers." },
};

// ---------------------------------------------------------------------------
// Word data (same lists as the console game)
// ---------------------------------------------------------------------------
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "subjects.json"), "utf8"));
const SUBJECTS = DATA.subjects.map((s, index) => ({
  id: s.id, name: s.name, year: s.year, semester: s.semester,
  elective: s.elective, color: index, wordCount: s.words.length,
}));
const WORDS = [];   // every word, each remembering its subject
DATA.subjects.forEach((s, subjectIndex) => {
  s.words.forEach((w) => WORDS.push({ ...w, subject: subjectIndex }));
});
const DEFAULT_SUBJECTS = ["programming", "calculus", "physics"];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const rooms = new Map();   // room code -> room object

function randomInt(n) {
  return crypto.randomInt(n);
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function makeRoomCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";   // no I or O, they look like 1 and 0
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) code += letters[randomInt(letters.length)];
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  const text = String(name || "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
  return text || "Player";
}

function secondsLeft(deadline) {
  return Math.max(0, deadline - Date.now());
}

// ---------------------------------------------------------------------------
// Rooms and players
// ---------------------------------------------------------------------------
function createRoom() {
  const room = {
    code: makeRoomCode(),
    hostId: null,
    players: [],                 // in seat order
    phase: "lobby",              // lobby | turn | challenge | reveal | ended
    settings: { subjects: [...DEFAULT_SUBJECTS], winScore: 10 },
    wordPile: [],                // shuffled word indexes still to be drawn
    nextCardId: 1,
    turnPlayerId: null,
    deadline: 0,
    timer: null,
    challenge: null,
    log: [],
    seq: 0,                      // goes up on every change, so browsers can animate
    winnerId: null,
    lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function addPlayer(room, name) {
  const player = {
    id: crypto.randomBytes(4).toString("hex"),       // public: other players see it
    token: crypto.randomBytes(16).toString("hex"),   // secret: proves "this is me"
    name: cleanName(name),
    score: 0,
    hand: [],
    stream: null,                // the open Server-Sent Events response
    connected: false,
    lastSeen: Date.now(),
  };
  room.players.push(player);
  if (!room.hostId) room.hostId = player.id;
  return player;
}

function findPlayer(room, id) {
  return room.players.find((p) => p.id === id);
}

function addLog(room, text) {
  room.log.push({ t: Date.now(), text });
  if (room.log.length > 30) room.log.shift();
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------
function poolForRoom(room) {
  const chosen = new Set(room.settings.subjects);
  const pool = [];
  WORDS.forEach((w, index) => {
    if (chosen.has(SUBJECTS[w.subject].id)) pool.push(index);
  });
  return pool;
}

function drawWordCard(room) {
  if (room.wordPile.length === 0) room.wordPile = shuffle(poolForRoom(room));
  return { id: room.nextCardId++, type: "word", word: room.wordPile.pop() };
}

function drawPowerCard(room) {
  const names = Object.keys(POWERS);
  const total = names.reduce((sum, n) => sum + POWERS[n].weight, 0);
  let roll = randomInt(total);
  for (const n of names) {
    if (roll < POWERS[n].weight) return { id: room.nextCardId++, type: "power", power: n };
    roll -= POWERS[n].weight;
  }
  return { id: room.nextCardId++, type: "power", power: "blitz" };
}

function refillHand(room, player) {
  while (player.hand.length < HAND_SIZE) {
    const words = player.hand.filter((c) => c.type === "word").length;
    const slotsLeft = HAND_SIZE - player.hand.length;
    const mustBeWord = words + slotsLeft <= MIN_WORD_CARDS;
    const card = !mustBeWord && Math.random() < POWER_CARD_CHANCE
      ? drawPowerCard(room) : drawWordCard(room);
    player.hand.push(card);
  }
}

// Picks the answer options: the right word plus wrong words from the same subject.
function buildOptions(wordIndex, count) {
  const answer = WORDS[wordIndex];
  const seen = new Set([answer.word.toLowerCase()]);
  const candidates = shuffle(WORDS
    .map((w, i) => i)
    .filter((i) => WORDS[i].subject === answer.subject && i !== wordIndex));
  const options = [wordIndex];
  for (const i of candidates) {
    if (options.length >= count) break;
    const text = WORDS[i].word.toLowerCase();
    if (!seen.has(text)) {
      seen.add(text);
      options.push(i);
    }
  }
  return shuffle(options);
}

// ---------------------------------------------------------------------------
// Turn flow
// ---------------------------------------------------------------------------
function setTimer(room, seconds, onTimeout) {
  clearTimeout(room.timer);
  room.deadline = Date.now() + seconds * 1000;
  room.timer = setTimeout(() => {
    room.timer = null;
    onTimeout();
    broadcast(room);
  }, seconds * 1000);
}

function activePlayers(room) {
  return room.players.filter((p) => p.connected);
}

function startGame(room) {
  room.players.forEach((p) => { p.score = 0; p.hand = []; });
  room.wordPile = shuffle(poolForRoom(room));
  room.players.forEach((p) => refillHand(room, p));
  room.winnerId = null;
  room.challenge = null;
  room.log = [];
  addLog(room, "The cards are dealt. First to " + room.settings.winScore + " points wins.");
  const first = activePlayers(room)[randomInt(activePlayers(room).length)];
  beginTurn(room, first);
}

function nextPlayerAfter(room, playerId) {
  const start = room.players.findIndex((p) => p.id === playerId);
  for (let step = 1; step <= room.players.length; step++) {
    const p = room.players[(start + step) % room.players.length];
    if (p.connected) return p;
  }
  return null;
}

function beginTurn(room, player) {
  if (!player || activePlayers(room).length < MIN_PLAYERS) {
    endGame(room, "Not enough players left at the table.");
    return;
  }
  room.phase = "turn";
  room.turnPlayerId = player.id;
  room.challenge = null;
  setTimer(room, TURN_SECONDS, () => autoThrow(room));
}

// If a player runs out of time, a random word card is thrown for them.
function autoThrow(room) {
  const player = findPlayer(room, room.turnPlayerId);
  if (!player || room.phase !== "turn") return;
  const card = player.hand.find((c) => c.type === "word");
  const targets = activePlayers(room).filter((p) => p.id !== player.id);
  if (!card || targets.length === 0) {
    beginTurn(room, nextPlayerAfter(room, player.id));
    return;
  }
  addLog(room, player.name + " took too long, so a card was thrown for them.");
  throwCard(room, player, card.id, targets[randomInt(targets.length)].id, null);
}

// Returns an error message, or null if the throw worked.
function throwCard(room, player, cardId, targetId, powerId) {
  if (room.phase !== "turn" || room.turnPlayerId !== player.id) return "It's not your turn.";
  const card = player.hand.find((c) => c.id === cardId && c.type === "word");
  if (!card) return "Pick a word card to throw.";
  const target = findPlayer(room, targetId);
  if (!target || target.id === player.id) return "Pick an opponent to challenge.";
  if (!target.connected) return target.name + " is away right now. Pick someone else.";

  let power = null;
  if (powerId) {
    power = player.hand.find((c) => c.id === powerId && c.type === "power");
    if (!power) return "That power card isn't in your hand.";
    if (POWERS[power.power].kind !== "attack") return "Peek is a defence card. Keep it for when you're challenged.";
  }

  player.hand = player.hand.filter((c) => c !== card && c !== power);
  const powerName = power ? power.power : null;
  const optionCount = powerName === "crowd" ? 6 : 4;
  const seconds = powerName === "blitz" ? BLITZ_SECONDS : ANSWER_SECONDS;

  room.challenge = {
    id: room.seq + 1,
    challengerId: player.id,
    targetId: target.id,
    word: card.word,
    power: powerName,
    options: buildOptions(card.word, optionCount),
    removed: [],
    peekUsed: false,
    seconds,
    startedAt: Date.now(),
    result: null,
  };
  room.phase = "challenge";
  const powerText = power ? " with " + POWERS[powerName].name : "";
  addLog(room, player.name + " challenges " + target.name + powerText + ".");
  setTimer(room, seconds, () => resolveChallenge(room, -1));
  return null;
}

function usePeek(room, player, cardId) {
  const c = room.challenge;
  if (room.phase !== "challenge" || !c || c.targetId !== player.id) return "You can only peek while answering.";
  if (c.peekUsed) return "You already peeked at this card.";
  const card = player.hand.find((x) => x.id === cardId && x.type === "power" && x.power === "peek");
  if (!card) return "You don't have a Peek card.";
  player.hand = player.hand.filter((x) => x !== card);
  const wrong = c.options.filter((w) => w !== c.word);
  shuffle(wrong).slice(0, 2).forEach((w) => c.removed.push(w));
  c.peekUsed = true;
  addLog(room, player.name + " plays Peek.");
  return null;
}

// choice = word index the defender picked, or -1 for "ran out of time"
function resolveChallenge(room, choice) {
  const c = room.challenge;
  if (!c || room.phase !== "challenge") return;
  clearTimeout(room.timer);

  const challenger = findPlayer(room, c.challengerId);
  const target = findPlayer(room, c.targetId);
  const elapsed = (Date.now() - c.startedAt) / 1000;
  const correct = choice === c.word;
  const multiplier = c.power === "double" ? 2 : 1;
  const points = {};

  if (correct) {
    let gain = POINTS_DEFEND;
    if (elapsed <= c.seconds / 3) gain += POINTS_FAST_BONUS;
    gain *= multiplier;
    target.score += gain;
    points[target.id] = gain;
    addLog(room, target.name + " knew it: " + WORDS[c.word].word + ". +" + gain);
  } else {
    let gain = POINTS_HIT * multiplier;
    if (c.power === "steal" && target.score > 0) {
      const taken = Math.min(target.score, multiplier);
      target.score -= taken;
      gain += taken;
      points[target.id] = -taken;
    }
    challenger.score += gain;
    points[challenger.id] = gain;
    const why = choice === -1 ? "ran out of time" : "missed";
    addLog(room, target.name + " " + why + " on " + WORDS[c.word].word + ". " + challenger.name + " +" + gain);
  }

  c.result = { choice, correct, points, elapsed: Math.round(elapsed * 10) / 10 };
  room.phase = "reveal";
  refillHand(room, challenger);
  refillHand(room, target);

  const leader = room.players.find((p) => p.score >= room.settings.winScore);
  setTimer(room, REVEAL_SECONDS, () => {
    if (leader) endGame(room, null);
    else beginTurn(room, nextPlayerAfter(room, c.challengerId));
  });
}

function endGame(room, reason) {
  clearTimeout(room.timer);
  room.phase = "ended";
  room.challenge = null;
  const ranked = [...room.players].sort((a, b) => b.score - a.score);
  room.winnerId = ranked.length ? ranked[0].id : null;
  addLog(room, reason || (ranked[0].name + " wins the game!"));
}

// ---------------------------------------------------------------------------
// What each player is allowed to see
// ---------------------------------------------------------------------------
function wordCardView(index) {
  const w = WORDS[index];
  return { word: w.word, pos: w.pos, definition: w.definition, example: w.example, subject: w.subject };
}

function cardView(card) {
  if (card.type === "word") return { id: card.id, type: "word", ...wordCardView(card.word) };
  const p = POWERS[card.power];
  return { id: card.id, type: "power", power: card.power, name: p.name, kind: p.kind, text: p.text };
}

function viewFor(room, me) {
  const c = room.challenge;
  let challenge = null;
  if (c) {
    const revealed = room.phase === "reveal";
    const iAmChallenger = me.id === c.challengerId;
    challenge = {
      id: c.id,
      challengerId: c.challengerId,
      targetId: c.targetId,
      power: c.power ? { id: c.power, name: POWERS[c.power].name, text: POWERS[c.power].text } : null,
      definition: WORDS[c.word].definition,
      subject: WORDS[c.word].subject,
      options: c.options.map((w) => ({ id: w, text: WORDS[w].word, removed: c.removed.includes(w) })),
      peekUsed: c.peekUsed,
      seconds: c.seconds,
      // The answer stays secret until the reveal (the challenger already knows it).
      answer: revealed || iAmChallenger ? wordCardView(c.word) : null,
      answerId: revealed || iAmChallenger ? c.word : null,
      result: revealed ? c.result : null,
    };
  }
  return {
    seq: room.seq,
    code: room.code,
    phase: room.phase,
    me: me.id,
    hostId: room.hostId,
    settings: room.settings,
    winScores: WIN_SCORES,
    turnPlayerId: room.turnPlayerId,
    timeLeftMs: room.phase === "lobby" || room.phase === "ended" ? 0 : secondsLeft(room.deadline),
    players: room.players.map((p) => ({
      id: p.id, name: p.name, score: p.score, cards: p.hand.length, connected: p.connected,
    })),
    hand: me.hand.map(cardView),
    challenge,
    log: room.log.slice(-12),
    winnerId: room.winnerId,
  };
}

function broadcast(room) {
  room.seq++;
  room.lastActive = Date.now();
  for (const p of room.players) {
    if (p.stream) p.stream.write("data: " + JSON.stringify(viewFor(room, p)) + "\n\n");
  }
}

// ---------------------------------------------------------------------------
// HTTP: static files, API and the live event stream
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".json": "application/json",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 10000) req.destroy();   // nobody needs to send that much
    });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); }
    });
  });
}

function authPlayer(body) {
  const room = rooms.get(String(body.code || "").toUpperCase());
  if (!room) return {};
  const player = room.players.find((p) => p.token === body.token);
  return { room, player };
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const full = path.join(__dirname, "public", file);
  if (!full.startsWith(path.join(__dirname, "public"))) {   // blocks ../ tricks
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(full, (err, content) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(content);
  });
}

function openStream(req, res, room, player) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (player.stream) player.stream.end();        // only one live tab per player
  player.stream = res;
  player.connected = true;
  player.lastSeen = Date.now();
  broadcast(room);

  req.on("close", () => {
    if (player.stream !== res) return;           // an older tab closing doesn't count
    player.stream = null;
    player.connected = false;
    player.lastSeen = Date.now();
    // Give a refreshed page a few seconds to come back before it counts as leaving.
    setTimeout(() => {
      if (player.connected) return;
      if (room.phase === "lobby") {
        room.players = room.players.filter((p) => p !== player);
        if (room.hostId === player.id) room.hostId = room.players[0] ? room.players[0].id : null;
      } else if (room.phase !== "ended" && activePlayers(room).length < MIN_PLAYERS) {
        endGame(room, "Not enough players left at the table.");
      } else if (room.phase === "turn" && room.turnPlayerId === player.id) {
        beginTurn(room, nextPlayerAfter(room, player.id));
      }
      broadcast(room);
    }, 8000);
    broadcast(room);
  });
}

async function handleApi(req, res, route) {
  if (route === "/api/subjects" && req.method === "GET") {
    sendJson(res, 200, { subjects: SUBJECTS, powers: POWERS });
    return;
  }

  if (route === "/api/events" && req.method === "GET") {
    const q = new URL(req.url, "http://x").searchParams;
    const { room, player } = authPlayer({ code: q.get("code"), token: q.get("token") });
    if (!room || !player) { sendJson(res, 404, { error: "This table no longer exists." }); return; }
    openStream(req, res, room, player);
    return;
  }

  if (req.method !== "POST") { sendJson(res, 405, { error: "Use POST." }); return; }
  const body = await readBody(req);

  if (route === "/api/create") {
    const room = createRoom();
    const player = addPlayer(room, body.name);
    addLog(room, player.name + " opened the table.");
    sendJson(res, 200, { code: room.code, token: player.token, id: player.id });
    return;
  }

  if (route === "/api/join") {
    const room = rooms.get(String(body.code || "").trim().toUpperCase());
    if (!room) { sendJson(res, 404, { error: "No table with that code. Check the four letters." }); return; }
    if (room.phase !== "lobby") { sendJson(res, 409, { error: "That game has already started." }); return; }
    if (room.players.length >= MAX_PLAYERS) { sendJson(res, 409, { error: "That table is full (4 players)." }); return; }
    const player = addPlayer(room, body.name);
    addLog(room, player.name + " sat down.");
    broadcast(room);
    sendJson(res, 200, { code: room.code, token: player.token, id: player.id });
    return;
  }

  if (route === "/api/action") {
    const { room, player } = authPlayer(body);
    if (!room || !player) { sendJson(res, 404, { error: "This table no longer exists." }); return; }
    const error = doAction(room, player, body);
    if (error) { sendJson(res, 400, { error }); return; }
    broadcast(room);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "Unknown request." });
}

// Returns an error message, or null if the action worked.
function doAction(room, player, body) {
  const isHost = room.hostId === player.id;

  switch (body.action) {
    case "settings": {
      if (!isHost) return "Only the host can change the settings.";
      if (room.phase !== "lobby") return "Settings are locked once the game starts.";
      if (Array.isArray(body.subjects)) {
        const valid = body.subjects.filter((id) => SUBJECTS.some((s) => s.id === id));
        if (valid.length === 0) return "Choose at least one library.";
        room.settings.subjects = [...new Set(valid)];
      }
      if (WIN_SCORES.includes(body.winScore)) room.settings.winScore = body.winScore;
      return null;
    }
    case "start":
      if (!isHost) return "Only the host can start the game.";
      if (room.phase !== "lobby") return "The game is already running.";
      if (activePlayers(room).length < MIN_PLAYERS) return "You need at least 2 players to start.";
      startGame(room);
      return null;
    case "throw":
      return throwCard(room, player, body.cardId, body.targetId, body.powerId || null);
    case "peek":
      return usePeek(room, player, body.cardId);
    case "answer": {
      const c = room.challenge;
      if (room.phase !== "challenge" || !c || c.targetId !== player.id) return "This question isn't for you.";
      if (!c.options.includes(body.choice) || c.removed.includes(body.choice)) return "Pick one of the answers shown.";
      resolveChallenge(room, body.choice);
      return null;
    }
    case "lobby":
      if (!isHost) return "Only the host can start a new game.";
      if (room.phase !== "ended") return "The game is still running.";
      clearTimeout(room.timer);
      room.phase = "lobby";
      room.players = room.players.filter((p) => p.connected);
      room.players.forEach((p) => { p.score = 0; p.hand = []; });
      room.challenge = null;
      room.winnerId = null;
      addLog(room, "Back at the table. Waiting for the host to deal.");
      return null;
    default:
      return "Unknown action.";
  }
}

const server = http.createServer((req, res) => {
  const route = new URL(req.url, "http://x").pathname;
  if (route.startsWith("/api/")) {
    handleApi(req, res, route).catch((err) => {
      console.error(err);
      sendJson(res, 500, { error: "Something went wrong on the server." });
    });
  } else {
    serveStatic(req, res);
  }
});

// Keep connections alive through proxies, and forget empty tables after 30 minutes.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    room.players.forEach((p) => { if (p.stream) p.stream.write(": ping\n\n"); });
    if (activePlayers(room).length === 0 && now - room.lastActive > 30 * 60 * 1000) {
      clearTimeout(room.timer);
      rooms.delete(room.code);
    }
  }
}, 20000);

server.listen(PORT, () => {
  console.log("Lexi Online is running on http://localhost:" + PORT);
  console.log("Loaded " + WORDS.length + " words in " + SUBJECTS.length + " libraries.");
});
