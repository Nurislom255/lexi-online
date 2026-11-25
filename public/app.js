// app.js - Lexi Online browser client.
// Draws the screen from the state the server sends, and sends the player's moves back.
// Drafted with help from Claude (AI); reviewed and modified by the team.

"use strict";

const app = document.getElementById("app");
const toastBox = document.getElementById("toast");

const SUBJECT_COLORS = ["#c0563b", "#3a6ea5", "#5b8c3a", "#8a4f9e", "#c28a1d", "#2f8f8a",
  "#b04a72", "#4f5fae", "#7b7b2e", "#a3552a", "#2f7a5a", "#6a4cae", "#9a3b3b", "#3d7d9e", "#86603a"];
const SEAT_COLORS = ["#e3b04b", "#e58a6f", "#8fc1a9", "#a9b8e8"];

const ICONS = {
  blitz: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.5 2 4 13.5h6.5L9 22l10-12h-6.6z"/></svg>',
  double: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><text x="12" y="17" text-anchor="middle" font-family="Georgia,serif" font-weight="800" font-size="14" fill="currentColor">×2</text><circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  crowd: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="2" y="4" width="8" height="4" rx="1.2"/><rect x="14" y="4" width="8" height="4" rx="1.2"/><rect x="2" y="10" width="8" height="4" rx="1.2"/><rect x="14" y="10" width="8" height="4" rx="1.2"/><rect x="2" y="16" width="8" height="4" rx="1.2"/><rect x="14" y="16" width="8" height="4" rx="1.2"/></svg>',
  steal: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="17" cy="7" r="4"/><path d="M17 5.5v3M3 18h11M10 14l4 4-4 4"/></svg>',
  peek: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let subjects = [];         // library list from the server
let session = loadSession();   // { code, token } for the table we're sitting at
let state = null;          // latest table state from the server
let stream = null;         // EventSource
let deadline = 0;          // local time when the current timer runs out
let lastChallengeShown = null;
let lastRevealShown = null;
let logOpen = false;       // phones: is the game log panel open?
const prevScores = {};

// What the player has picked on their turn (only in this browser)
const pick = { cardId: null, powerId: null, targetId: null };

function loadSession() {
  try { return JSON.parse(localStorage.getItem("lexi-session")) || null; } catch { return null; }
}
function saveSession(s) {
  session = s;
  try {
    if (s) localStorage.setItem("lexi-session", JSON.stringify(s));
    else localStorage.removeItem("lexi-session");
  } catch { /* private mode: still works for this tab */ }
}

// ---------------------------------------------------------------------------
// Tiny DOM helper: el("div", { class: "x", onclick: fn }, child1, "text", ...)
// Text is always added with textContent, so player names can never inject HTML.
// ---------------------------------------------------------------------------
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "html") node.innerHTML = value;          // only for our own icons
    else if (key === "style") node.style.cssText = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function toast(message) {
  toastBox.textContent = message;
  toastBox.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastBox.classList.remove("show"), 3200);
}

// ---------------------------------------------------------------------------
// Talking to the server
// ---------------------------------------------------------------------------
async function post(url, body) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || "That didn't work."); return null; }
    return data;
  } catch {
    toast("Can't reach the server. Check your connection.");
    return null;
  }
}

function act(action, extra) {
  return post("/api/action", { code: session.code, token: session.token, action, ...extra });
}

function connect() {
  if (stream) stream.close();
  stream = new EventSource("/api/events?code=" + session.code + "&token=" + session.token);
  stream.onmessage = (event) => {
    state = JSON.parse(event.data);
    deadline = Date.now() + state.timeLeftMs;
    render();
  };
  stream.onerror = () => {
    // The browser retries by itself. If it gave up, the table is gone.
    if (stream.readyState === EventSource.CLOSED) {
      saveSession(null);
      state = null;
      toast("That table has closed.");
      render();
    }
  };
}

function leaveTable() {
  if (stream) stream.close();
  stream = null;
  saveSession(null);
  state = null;
  history.replaceState(null, "", "/");
  render();
}

// ---------------------------------------------------------------------------
// Pieces used on several screens
// ---------------------------------------------------------------------------
function avatar(player, seatIndex) {
  const letter = (player.name.trim()[0] || "?").toUpperCase();
  return el("span", { class: "avatar", style: "background:" + SEAT_COLORS[seatIndex % 4], "aria-hidden": "true" }, letter);
}

function wordCard(card, extra) {
  const subject = subjects[card.subject] || { name: "" };
  return el(extra && extra.tag || "div", { class: "card card-word " + (extra && extra.cls || ""), ...(extra && extra.attrs) },
    el("span", { class: "card-band", style: "background:" + SUBJECT_COLORS[card.subject % SUBJECT_COLORS.length] }),
    el("span", { class: "card-subject" }, subject.name),
    el("span", { class: "card-word-text" }, card.word),
    el("span", { class: "card-pos" }, card.pos),
    el("span", { class: "card-def" }, card.definition));
}

function powerCard(card, extra) {
  return el(extra && extra.tag || "div", { class: "card card-power " + (extra && extra.cls || ""), ...(extra && extra.attrs) },
    el("span", { html: ICONS[card.power] }),
    el("span", { class: "card-power-name" }, card.name),
    el("span", { class: "card-power-kind" }, card.kind === "defense" ? "Defence card" : "Attack card"),
    el("span", { class: "card-power-text" }, card.text));
}

function playerName(id) {
  const p = state.players.find((x) => x.id === id);
  return p ? p.name : "Someone";
}

// ---------------------------------------------------------------------------
// Screen 1: home
// ---------------------------------------------------------------------------
function renderHome() {
  const params = new URLSearchParams(location.search);
  const nameInput = el("input", { class: "field", id: "name", maxlength: "16", autocomplete: "nickname",
    placeholder: "e.g. Nurislom", value: localStorage.getItem("lexi-name") || "" });
  const codeInput = el("input", { class: "field field-code", id: "code", maxlength: "4", autocomplete: "off",
    "aria-label": "Table code", placeholder: "CODE", value: (params.get("code") || "").toUpperCase() });

  function nameOrWarn() {
    const name = nameInput.value.trim();
    if (!name) { toast("Type your name first."); nameInput.focus(); return null; }
    try { localStorage.setItem("lexi-name", name); } catch { /* ignore */ }
    return name;
  }
  async function create() {
    const name = nameOrWarn(); if (!name) return;
    const data = await post("/api/create", { name });
    if (data) { saveSession({ code: data.code, token: data.token }); connect(); }
  }
  async function join() {
    const name = nameOrWarn(); if (!name) return;
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 4) { toast("Table codes have 4 letters."); codeInput.focus(); return; }
    const data = await post("/api/join", { code, name });
    if (data) { saveSession({ code: data.code, token: data.token }); connect(); }
  }
  codeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });

  const sample = [
    { subject: 1, word: "pointer", pos: "noun", definition: "A variable that stores the memory address of another variable." },
    { subject: 7, word: "recursion", pos: "noun", definition: "A technique where a function solves a problem by calling itself on a smaller version." },
    { subject: 5, word: "eigenvalue", pos: "noun", definition: "A scalar λ for which Av = λv has a nonzero solution v." },
  ];

  app.replaceChildren(el("section", { class: "home" },
    el("div", { class: "home-spread", "aria-hidden": "true" },
      wordCard(sample[0]), wordCard(sample[1]), wordCard(sample[2])),
    el("div", null,
      el("h1", { class: "wordmark" }, "Lexi", el("small", null, "A word-card duel for CS students")),
      el("p", { class: "home-pitch" },
        "Deal a hand of real course vocabulary, throw your hardest word at a friend, and see if they can name it from its definition. 2 to 4 players, one table code."),
      el("div", { class: "join-form" },
        el("label", { for: "name" }, "Your name"),
        nameInput,
        el("button", { class: "btn", onclick: create }, "Open a new table"),
        el("div", { class: "join-or" }, "or join a friend's table"),
        el("div", { class: "join-row" }, codeInput, el("button", { class: "btn btn-quiet", onclick: join }, "Join"))),
      el("details", { class: "rules" },
        el("summary", null, "How to play"),
        el("ol", null,
          el("li", null, "Everyone gets 5 cards: ", el("b", null, "word cards"), " from the chosen course libraries and some ", el("b", null, "power cards"), "."),
          el("li", null, "On your turn, pick a word card, add a power card if you like, and throw it at another player."),
          el("li", null, "They see only the definition and must pick the right word in 15 seconds. Right: they score 2 (3 if fast). Wrong or too slow: you score 2."),
          el("li", null, "Power cards: Blitz (6 seconds), Double (points ×2), Crowd (6 answers), Steal (take a point). Peek is a defence card: play it while answering to cross out two wrong answers."),
          el("li", null, "First to the target score wins.")))))
  );
}

// ---------------------------------------------------------------------------
// Screen 2: lobby
// ---------------------------------------------------------------------------
function renderLobby() {
  const isHost = state.hostId === state.me;
  const chosen = new Set(state.settings.subjects);
  const link = location.origin + "/?code=" + state.code;

  function toggleSubject(id) {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id); else next.add(id);
    if (next.size === 0) { toast("Keep at least one library."); return; }
    act("settings", { subjects: [...next] });
  }

  const seats = [];
  for (let i = 0; i < 4; i++) {
    const p = state.players[i];
    seats.push(p
      ? el("div", { class: "seat-slot filled" }, avatar(p, i), el("span", { class: "who" }, p.name),
          el("span", { class: "tag" }, [p.id === state.hostId ? "Host" : "", p.id === state.me ? "You" : ""].filter(Boolean).join(", ") || (p.connected ? "Ready" : "Reconnecting…")))
      : el("div", { class: "seat-slot" }, "Empty seat"));
  }

  const groups = [];
  for (const year of [1, 2]) {
    for (const sem of [1, 2]) {
      const list = subjects.filter((s) => s.year === year && s.semester === sem);
      if (!list.length) continue;
      groups.push(el("div", { class: "lib-group" },
        el("h3", null, "Year " + year + ", semester " + sem),
        el("div", { class: "chips" }, list.map((s) =>
          el("button", { class: "chip", "aria-pressed": chosen.has(s.id) ? "true" : "false", disabled: !isHost,
            onclick: () => toggleSubject(s.id) },
            el("i", { style: "background:" + SUBJECT_COLORS[s.color % SUBJECT_COLORS.length] }),
            s.name + (s.elective ? " (elective)" : ""))))));
    }
  }
  const wordCount = subjects.filter((s) => chosen.has(s.id)).reduce((n, s) => n + s.wordCount, 0);
  const enough = state.players.filter((p) => p.connected).length >= 2;

  app.replaceChildren(el("section", { class: "lobby" },
    el("div", { class: "lobby-head" },
      el("div", null,
        el("h1", null, isHost ? "Your table is open" : "You're at the table"),
        el("p", null, "Share the code. Up to 4 players can sit down.")),
      el("div", { class: "code-plate" },
        el("div", null, el("span", null, "Table code"), el("strong", null, state.code)),
        el("button", { class: "btn", onclick: () => {
          // Browsers only allow copying on https or localhost, so fall back to showing the link.
          if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(link).then(() => toast("Invite link copied."), () => toast(link));
          } else {
            toast("Share this link: " + link);
          }
        } }, "Copy invite link"))),
    el("div", { class: "seats" }, seats),
    el("div", { class: "settings" },
      el("div", null,
        el("h2", null, "Libraries in the deck"),
        el("p", { class: "hint" }, isHost ? "Pick the courses your group has studied. " + wordCount + " words in the deck."
          : "The host picks the courses. " + wordCount + " words in the deck."),
        groups),
      el("div", null,
        el("h2", null, "Points to win"),
        el("div", { class: "segment", role: "group", "aria-label": "Points to win" },
          state.winScores.map((n) => el("button", { "aria-pressed": state.settings.winScore === n ? "true" : "false",
            disabled: !isHost, onclick: () => act("settings", { winScore: n }) }, String(n)))))),
    el("div", { class: "lobby-foot" },
      isHost
        ? el("button", { class: "btn", disabled: !enough, onclick: () => act("start") }, "Deal the cards")
        : null,
      el("p", null, enough
        ? (isHost ? "" : "Waiting for " + playerName(state.hostId) + " to deal.")
        : "Waiting for at least one more player…"),
      el("button", { class: "btn btn-quiet", onclick: leaveTable }, "Leave table"))));
}

// ---------------------------------------------------------------------------
// Screen 3: the table
// ---------------------------------------------------------------------------
function resetPick() { pick.cardId = null; pick.powerId = null; pick.targetId = null; }

function renderTable() {
  const me = state.players.find((p) => p.id === state.me);
  const myTurn = state.phase === "turn" && state.turnPlayerId === state.me;
  const c = state.challenge;
  const defending = state.phase === "challenge" && c && c.targetId === state.me;
  if (!myTurn) resetPick();

  // Score changes since the last update (for the floating +2 / -1)
  const floats = {};
  for (const p of state.players) {
    if (prevScores[p.id] !== undefined && prevScores[p.id] !== p.score) floats[p.id] = p.score - prevScores[p.id];
    prevScores[p.id] = p.score;
  }
  const floatEl = (id) => floats[id]
    ? el("span", { class: "float " + (floats[id] > 0 ? "plus" : "minus") }, (floats[id] > 0 ? "+" : "") + floats[id]) : null;

  // --- opponents across the top ---
  const seatIndex = (id) => state.players.findIndex((p) => p.id === id);
  const opponents = state.players.filter((p) => p.id !== state.me).map((p) => {
    const canTarget = myTurn && pick.cardId !== null && p.connected;
    const classes = ["seat",
      state.turnPlayerId === p.id && state.phase === "turn" ? "turn" : "",
      c && (c.targetId === p.id || c.challengerId === p.id) ? "turn" : "",
      !p.connected ? "away" : "",
      canTarget ? "targetable" : "",
      pick.targetId === p.id ? "targeted" : ""].join(" ");
    const backs = el("span", { class: "mini-backs", "aria-hidden": "true" }, Array.from({ length: p.cards }, () => el("i")));
    const inner = [avatar(p, seatIndex(p.id)),
      el("span", { class: "name" }, p.name, p.connected ? "" : " (away)"),
      el("span", { class: "meta" }, el("span", { class: "score" }, p.score + " pts"), backs),
      floatEl(p.id)];
    return canTarget
      ? el("button", { class: classes, onclick: () => { pick.targetId = p.id; render(); },
          "aria-label": "Challenge " + p.name }, inner)
      : el("div", { class: classes }, inner);
  });

  // --- the middle of the table ---
  const center = el("div", { class: "center" });
  if (state.phase === "turn") {
    const timer = el("div", { class: "timer", "data-timer": "turn" }, el("i"));
    if (myTurn) {
      const step = pick.cardId === null ? "Pick a word card from your hand. Add a power card if you want, then choose who to challenge."
        : pick.targetId === null ? "Now tap the player you want to challenge."
        : "Ready. Throw the card when you are.";
      const chosenCard = state.hand.find((x) => x.id === pick.cardId);
      const chosenPower = state.hand.find((x) => x.id === pick.powerId);
      if (chosenCard) {
        center.append(el("div", { class: "preview" }, wordCard(chosenCard), chosenPower ? powerCard(chosenPower) : null));
      } else {
        center.append(el("div", { class: "pile", "aria-hidden": "true" },
          el("div", { class: "card card-back" }), el("div", { class: "card card-back" }), el("div", { class: "card card-back" })));
      }
      center.append(el("p", { class: "center-line" }, el("strong", null, "Your turn. "), step), timer);
    } else {
      center.append(el("div", { class: "pile", "aria-hidden": "true" },
          el("div", { class: "card card-back" }), el("div", { class: "card card-back" }), el("div", { class: "card card-back" })),
        el("p", { class: "center-line" }, el("strong", null, playerName(state.turnPlayerId)), " is choosing a card to throw…"), timer);
    }
  }
  if (c && (state.phase === "challenge" || state.phase === "reveal")) center.append(renderDuel(c, defending));

  // --- log ---
  const closeLog = () => { logOpen = false; render(); };
  const log = el("aside", { class: "log" + (logOpen ? " open" : ""), "aria-label": "Game log" },
    el("div", { class: "log-head" },
      el("h2", null, "Table talk"),
      el("button", { class: "log-close", onclick: closeLog, "aria-label": "Close the game log" }, "Close")),
    el("ol", null, state.log.map((l) => el("li", null, l.text))),
    el("button", { class: "btn btn-quiet log-leave", onclick: () => {
      if (confirm("Leave this game? Your seat will be marked as away.")) { logOpen = false; leaveTable(); }
    } }, "Leave game"));
  const lastEvent = state.log.length ? state.log[state.log.length - 1].text : "";
  const ticker = el("p", { class: "ticker", "aria-hidden": "true" }, lastEvent);
  const logToggle = el("button", { class: "log-toggle", onclick: () => { logOpen = !logOpen; render(); },
    "aria-label": "Show the game log", "aria-expanded": String(logOpen),
    html: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>' });

  // --- my hand ---
  const cards = state.hand.map((card, i) => {
    const n = state.hand.length;
    const tilt = (i - (n - 1) / 2) * 4;
    const isPeek = card.type === "power" && card.power === "peek";
    let clickable = false;
    let onclick = null;
    if (myTurn && card.type === "word") {
      clickable = true;
      onclick = () => { pick.cardId = pick.cardId === card.id ? null : card.id; render(); };
    } else if (myTurn && card.type === "power" && card.kind === "attack") {
      clickable = true;
      onclick = () => { pick.powerId = pick.powerId === card.id ? null : card.id; render(); };
    } else if (defending && isPeek && !c.peekUsed) {
      clickable = true;
      onclick = () => act("peek", { cardId: card.id });
    }
    const selected = pick.cardId === card.id || pick.powerId === card.id;
    const cls = [selected ? "selected" : "", defending && isPeek && !c.peekUsed ? "ready" : "",
      !clickable && (myTurn || defending) ? "dim" : ""].join(" ");
    const attrs = { style: "--tilt:" + tilt + "deg", disabled: !clickable, onclick,
      "aria-pressed": clickable ? String(selected) : null,
      "aria-label": card.type === "word" ? "Word card: " + card.word : "Power card: " + card.name };
    return card.type === "word" ? wordCard(card, { tag: "button", cls, attrs }) : powerCard(card, { tag: "button", cls, attrs });
  });

  let actions;
  if (myTurn) {
    const chosen = state.hand.find((x) => x.id === pick.cardId);
    const power = state.hand.find((x) => x.id === pick.powerId);
    const ready = chosen && pick.targetId;
    actions = el("div", { class: "actions throw-actions" },
      el("p", null, chosen ? "Throwing “" + chosen.word + "”" + (power ? " with " + power.name : "") : "No card picked yet"),
      el("button", { class: "btn", disabled: !ready, onclick: async () => {
        const ok = await act("throw", { cardId: pick.cardId, targetId: pick.targetId, powerId: pick.powerId });
        if (ok) resetPick();
      } }, ready ? "Throw at " + playerName(pick.targetId) : "Throw card"));
  } else if (defending && state.hand.some((x) => x.power === "peek") && !c.peekUsed) {
    actions = el("div", { class: "actions" }, el("p", null, "Stuck? Tap your Peek card to cross out two wrong answers."));
  } else {
    actions = el("div", { class: "actions" }, el("button", { class: "btn btn-quiet leave-btn", onclick: () => {
      if (confirm("Leave this game? Your seat will be marked as away.")) leaveTable();
    } }, "Leave game"));
  }

  const mine = el("div", { class: "me" },
    el("div", { class: "me-info" }, avatar(me, seatIndex(me.id)),
      el("div", null, el("div", { class: "name" }, me.name + " (you)"),
        el("div", { class: "score", style: "position:relative" }, me.score, floatEl(me.id)),
        el("div", { class: "meta" }, "First to " + state.settings.winScore + " wins"))),
    el("div", { class: "hand", role: "group", "aria-label": "Your hand" }, cards),
    actions);

  const children = [el("div", { class: "opponents" }, opponents, logToggle), ticker, center, log, mine];
  if (logOpen) children.push(el("div", { class: "sheet-backdrop", onclick: closeLog }));
  if (state.phase === "ended") children.push(renderEnd());
  app.replaceChildren(el("section", { class: "table" }, children));
}

function renderDuel(c, defending) {
  const revealed = state.phase === "reveal";
  const iChallenged = c.challengerId === state.me;
  const subject = subjects[c.subject] || { name: "" };
  const band = el("span", { class: "card-band", style: "background:" + SUBJECT_COLORS[c.subject % SUBJECT_COLORS.length] });

  // Animate only the first time we see this challenge / this reveal.
  const isNew = lastChallengeShown !== c.id;
  lastChallengeShown = c.id;
  const flipNow = revealed && lastRevealShown !== c.id;
  if (revealed) lastRevealShown = c.id;

  const front = el("div", { class: "card card-word face" }, band.cloneNode(),
    el("span", { class: "card-subject" }, subject.name),
    el("span", { class: "card-question" }, "Which word is this?"),
    el("span", { class: "card-def" }, c.definition));
  const back = c.answer
    ? el("div", { class: "card card-word face face-answer" }, band.cloneNode(),
        el("span", { class: "card-subject" }, subject.name),
        el("span", { class: "card-word-text" }, c.answer.word),
        el("span", { class: "card-pos" }, c.answer.pos),
        el("span", { class: "card-def" }, c.answer.example))
    : el("div", { class: "card card-back face face-answer" });
  const flip = el("div", { class: "flip" + (revealed && !flipNow ? " flipped" : "") + (isNew ? " landing" : "") },
    el("div", { class: "flip-inner" }, front, back));
  if (flipNow) requestAnimationFrame(() => requestAnimationFrame(() => flip.classList.add("flipped")));

  const names = el("div", { class: "duel-names" },
    el("strong", null, iChallenged ? "You" : playerName(c.challengerId)), " challenged ",
    el("strong", null, defending || c.targetId === state.me ? "you" : playerName(c.targetId)));

  const result = c.result;
  const answers = el("div", { class: "answers" + (defending && !revealed ? "" : " watching") },
    c.options.map((o) => {
      let cls = "answer";
      if (o.removed) cls += " removed";
      if (revealed && o.id === c.answerId) cls += " correct";
      if (revealed && result && o.id === result.choice && !result.correct) cls += " wrong";
      if (!revealed && iChallenged && o.id === c.answerId) cls += " mine";
      return el("button", { class: cls, disabled: !(defending && !revealed && !o.removed),
        onclick: () => act("answer", { choice: o.id }) }, o.text);
    }));

  const side = el("div", { class: "duel-side" }, names);
  if (c.power) side.append(el("span", { class: "badge", title: c.power.text }, el("span", { html: ICONS[c.power.id] }), c.power.name + ": " + c.power.text));
  side.append(answers);

  if (!revealed) {
    side.append(el("div", { class: "timer", "data-timer": "answer" }, el("i")),
      el("span", { class: "timer-label", "data-timer-label": "1" }, ""));
    if (iChallenged) side.append(el("span", { class: "timer-label" }, "Your word is outlined. Hope they don't know it."));
  } else if (result) {
    const target = c.targetId === state.me ? "You" : playerName(c.targetId);
    const line = result.correct ? target + " got it in " + result.elapsed + " s."
      : result.choice === -1 ? target + " ran out of time." : target + " picked the wrong word.";
    side.append(el("p", { class: "result-line" }, line));
  }
  return el("div", { class: "duel" }, flip, side);
}

function renderEnd() {
  const ranked = [...state.players].sort((a, b) => b.score - a.score);
  const winner = state.players.find((p) => p.id === state.winnerId);
  const isHost = state.hostId === state.me;
  const iWon = winner && winner.id === state.me;
  return el("div", { class: "overlay", role: "dialog", "aria-modal": "true", "aria-label": "Game over" },
    el("div", { class: "podium" },
      el("h2", null, iWon ? "You win!" : (winner ? winner.name + " wins" : "Game over")),
      el("p", null, state.log.length ? state.log[state.log.length - 1].text : ""),
      el("ol", { class: "ranks" }, ranked.map((p, i) => el("li", null,
        el("span", { class: "place" }, String(i + 1)),
        avatar(p, state.players.indexOf(p)),
        el("span", null, p.name + (p.id === state.me ? " (you)" : "")),
        el("span", { class: "pts" }, String(p.score))))),
      isHost
        ? el("button", { class: "btn", onclick: () => act("lobby") }, "Back to the table")
        : el("p", null, "Waiting for " + playerName(state.hostId) + " to set up the next game."),
      el("div", { style: "margin-top:1rem" }, el("button", { class: "btn btn-quiet", onclick: leaveTable }, "Leave table"))));
}

// ---------------------------------------------------------------------------
// Main render + timers
// ---------------------------------------------------------------------------
function render() {
  if (!session || !state) {
    if (session && !state) { app.replaceChildren(el("p", { class: "center-line", style: "padding:4rem" }, "Finding your table…")); return; }
    renderHome();
    return;
  }
  history.replaceState(null, "", "/?code=" + state.code);
  if (state.phase === "lobby") { logOpen = false; renderLobby(); }
  else renderTable();
  tick();
}

function tick() {
  const total = !state ? 0
    : state.phase === "turn" ? 40000
    : state.phase === "challenge" && state.challenge ? state.challenge.seconds * 1000 : 0;
  const left = Math.max(0, deadline - Date.now());
  document.querySelectorAll("[data-timer]").forEach((bar) => {
    const fraction = total ? Math.min(1, left / total) : 0;
    bar.firstChild.style.transform = "scaleX(" + fraction + ")";
    bar.classList.toggle("hurry", left < 5000);
  });
  document.querySelectorAll("[data-timer-label]").forEach((label) => {
    label.textContent = Math.ceil(left / 1000) + " s left";
  });
}
setInterval(tick, 100);

// Escape closes the game log panel on phones.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && logOpen) { logOpen = false; render(); }
});

async function start() {
  try {
    const res = await fetch("/api/subjects");
    subjects = (await res.json()).subjects;
  } catch {
    toast("Can't reach the server.");
  }
  if (session) connect();
  render();
}
start();
