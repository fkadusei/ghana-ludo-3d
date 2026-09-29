/**
 * Ghana Ludo 3D — UI controller.
 * Glues the rules engine (engine.js), the three.js view (scene.js), audio, networking (net.js)
 * and the HUD together.
 *
 * Offline flow: choose players -> decide starter -> roll (3D dice) -> click a glowing pawn ->
 * animate, resolve capture / finish / turn order.
 *
 * Online flow (host-authoritative, peer-to-peer): the host owns randomness and validates every
 * request. It broadcasts `roll` / `move` messages; every peer runs the same deterministic engine
 * and animations, and the host periodically sends a state snapshot so peers can detect and heal
 * drift.
 */
import { Game } from "./engine.js";
import * as audio from "./audio.js";
import * as net from "./net.js";

const $ = (id) => document.getElementById(id);
const el = {
  stage: $("stage"),
  loading: $("loading"),
  status: $("status"),
  start: $("start"),
  online: $("online"),
  solo: $("solo"),
  soloModal: $("soloModal"),
  soloClose: $("soloClose"),
  soloStart: $("soloStart"),
  soloColor: $("soloColor"),
  soloCount: $("soloCount"),
  soloLevel: $("soloLevel"),
  roomBadge: $("roomBadge"),
  roll: $("roll"),
  view: $("view"),
  mute: $("mute"),
  rules: $("rules"),
  reset: $("reset"),
  currentName: $("currentName"),
  nextName: $("nextName"),
  lastName: $("lastName"),
  currentTurn: $("currentTurn"),
  nextTurn: $("nextTurn"),
  lastTurn: $("lastTurn"),
  standings: $("standingsBody"),
  direction: $("direction"),
  directionText: $("directionText"),
  directionForward: $("directionForward"),
  directionBackward: $("directionBackward"),
  playersModal: $("playersModal"),
  playersClose: $("playersClose"),
  playersSave: $("playersSave"),
  rulesModal: $("rulesModal"),
  rulesClose: $("rulesClose"),
  winnerModal: $("winnerModal"),
  winnerTitle: $("winnerTitle"),
  winnerClose: $("winnerClose"),
  winnerNew: $("winnerNew"),
  podium: $("podium"),
  onlineModal: $("onlineModal"),
  onlineClose: $("onlineClose"),
  onlineMenu: $("onlineMenu"),
  onlineLobby: $("onlineLobby"),
  onlineName: $("onlineName"),
  onlineCreate: $("onlineCreate"),
  onlineCode: $("onlineCode"),
  onlineJoin: $("onlineJoin"),
  onlineError: $("onlineError"),
  roomCode: $("roomCode"),
  copyLink: $("copyLink"),
  seatList: $("seatList"),
  lobbyHint: $("lobbyHint"),
  leaveRoom: $("leaveRoom"),
  startOnline: $("startOnline"),
  checks: {
    blue: $("playBlue"),
    red: $("playRed"),
    yellow: $("playYellow"),
    green: $("playGreen"),
  },
};

let createScene;
try {
  ({ createScene } = await import("./scene.js"));
} catch (err) {
  el.loading.textContent = "Could not load the 3D engine (three.js from the CDN). Check your internet connection and reload.";
  throw err;
}

const STORAGE_KEY = "ghana_ludo_3d_state_v1";
const game = new Game();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ui = {
  setupComplete: false,
  gameStarted: false,
  deciding: false,
  animating: false,
  awaitingMove: false,
  pendingRoll: null,
  pendingPlayer: null,
  pendingDirection: null,
  moveSent: false, // online client: move request sent, waiting for the host's echo
  actionSeq: 0, // completed rolls/moves; identical on every peer, used to compare snapshots
  lastRoll: null, // { player, value }
};

const SEATS = ["blue", "red", "yellow", "green"];
const online = {
  active: false,
  role: null, // "host" | "client"
  ended: false, // host went away
  code: null,
  link: null,
  mySeat: null,
  name: "",
  token: null,
  phase: "menu", // "lobby" | "playing"
  seats: null, // color -> { kind: open|host|peer|bot|closed, name, away, token, connId }
  intents: [], // host: pending requests from clients
  inbox: [], // client: game messages waiting for the local animation to finish
  latest: null, // client: newest state snapshot from the host
  botTimer: null,
  solo: false, // playing against computers on this device only (no network)
  botLevel: "normal",
};

const scene = createScene(el.stage, game, {
  onTokenClick: (token) => handleTokenClick(token),
  onDiceClick: () => requestRoll(),
});

// ---------------------------------------------------------------------------
// HUD helpers
// ---------------------------------------------------------------------------

/** Haptic feedback on phones that support it. */
const buzz = (pattern) => {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch (err) {
    // ignore
  }
};

const setStatus = (message) => {
  el.status.textContent = message;
};

const currentPlayer = () => game.players[game.currentPlayer];
const allDone = () => game.isOver();
const findToken = (id) => game.players.flatMap((p) => p.tokens).find((t) => t.id === id);
const isMine = (player) => !online.active || online.mySeat === player.color;

/** "Red (Kofi, you)" online, plain "Red" offline. */
function seatLabel(player) {
  if (!online.active || !online.seats) return player.name;
  const seat = online.seats[player.color];
  if (seat.kind === "bot") return `${player.name} (CPU)`;
  const you = online.mySeat === player.color;
  const who = [seat.name, you ? "you" : ""].filter(Boolean).join(", ");
  return who ? `${player.name} (${who})` : player.name;
}

/** Can a roll be applied right now (regardless of whose turn it is)? */
function canApplyRoll() {
  return ui.gameStarted && !ui.deciding && !ui.animating && !ui.awaitingMove && !ui.pendingDirection && !allDone();
}

/** Can *this* player start a roll now? */
function canRoll() {
  if (!canApplyRoll()) return false;
  if (!online.active) return true;
  return !online.ended && online.mySeat === currentPlayer().color;
}

/** Highlights the pawns the local player may move (never shows rings for opponents' moves). */
function refreshSelectable() {
  const p = ui.pendingPlayer;
  if (ui.awaitingMove && !ui.animating && !ui.moveSent && !ui.pendingDirection && p && isMine(p) && !online.ended) {
    scene.setSelectable(game.movableTokens(p, ui.pendingRoll));
  } else {
    scene.setSelectable([]);
  }
}

let pumping = false;
function refreshControls() {
  const rollable = canRoll();
  el.roll.disabled = !rollable;
  scene.setDiceEnabled(rollable);
  el.reset.disabled = !ui.gameStarted && !ui.setupComplete && !online.active;

  if (online.active && !pumping) {
    pumping = true;
    try {
      pumpInbox();
      drainIntents();
      maybeBot();
    } finally {
      pumping = false;
    }
  }
}

function setTurnCard(card, player, role) {
  card.className = `turn-card ${role}${player ? ` ${player.color}` : ""}`;
}

function setTurnUI() {
  game.ensureCurrentPlayerActive();
  const current = currentPlayer();
  const next = game.players[game.nextPlayerIndex(game.currentPlayer)];
  const show = ui.setupComplete;

  el.currentName.textContent = show ? seatLabel(current) : "Not set";
  el.nextName.textContent = show ? seatLabel(next) : "—";
  setTurnCard(el.currentTurn, show ? current : null, "current");
  setTurnCard(el.nextTurn, show ? next : null, "next");

  if (ui.lastRoll) {
    el.lastName.textContent = `${ui.lastRoll.player.name}: ${ui.lastRoll.value}`;
    setTurnCard(el.lastTurn, ui.lastRoll.player, "last");
  } else {
    el.lastName.textContent = "—";
    setTurnCard(el.lastTurn, null, "last");
  }

  el.roll.className = `roll-btn${show ? ` ${current.color}` : ""}`;
  scene.setActivePlayer(show ? current : null);
}

const ordinal = (n) => {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10 < 4 ? n % 10 : 0]}`;
};

function renderStandings() {
  el.standings.innerHTML = "";
  const total = game.enabledPlayers().length || 4;
  for (let i = 0; i < total; i += 1) {
    const tr = document.createElement("tr");
    const place = document.createElement("td");
    place.textContent = ordinal(i + 1);
    const who = document.createElement("td");
    const winner = game.standings[i];
    if (winner) {
      const wrap = document.createElement("span");
      wrap.className = "standings-player";
      const dot = document.createElement("span");
      dot.className = `standings-dot ${winner.color}`;
      const name = document.createElement("span");
      name.textContent = seatLabel(winner);
      wrap.append(dot, name);
      who.appendChild(wrap);
    } else {
      who.textContent = "—";
      who.className = "muted";
    }
    tr.append(place, who);
    el.standings.appendChild(tr);
  }
}

function showWinner() {
  const [first] = game.standings;
  const mine = online.active && online.mySeat === first.color;
  el.winnerTitle.textContent = mine ? "You win!" : `${first.name} wins!`;
  el.winnerTitle.className = first.color;
  el.podium.innerHTML = "";
  game.standings.forEach((p, i) => {
    const li = document.createElement("li");
    li.className = p.color;
    li.textContent = `${ordinal(i + 1)} — ${seatLabel(p)}`;
    el.podium.appendChild(li);
  });
  scene.celebrateAll();
  setTimeout(() => setModal(el.winnerModal, true), 900);
}

function setModal(modal, open) {
  modal.classList.toggle("show", open);
  modal.setAttribute("aria-hidden", open ? "false" : "true");
}

// ---------------------------------------------------------------------------
// Persistence (offline games only; saved at stable points)
// ---------------------------------------------------------------------------

function persist() {
  if (online.active) return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        game: game.serialize(),
        ui: {
          setupComplete: ui.setupComplete,
          gameStarted: ui.gameStarted,
          lastRoll: ui.lastRoll ? { color: ui.lastRoll.player.color, value: ui.lastRoll.value } : null,
        },
      })
    );
  } catch (err) {
    // Storage may be unavailable (private mode); the game still works.
  }
}

function clearPersisted() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    // ignore
  }
}

function tryRestore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data?.ui?.setupComplete || !game.restore(data.game)) return false;
    ui.setupComplete = true;
    ui.gameStarted = !!data.ui.gameStarted;
    const last = data.ui.lastRoll && game.players.find((p) => p.color === data.ui.lastRoll.color);
    ui.lastRoll = last ? { player: last, value: data.ui.lastRoll.value } : null;
    return true;
  } catch (err) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Setup flow (offline)
// ---------------------------------------------------------------------------

function openPlayersModal() {
  game.players.forEach((p) => {
    el.checks[p.color].checked = p.enabled;
  });
  setModal(el.playersModal, true);
}

function applyPlayerSelection() {
  const selected = game.players.filter((p) => el.checks[p.color].checked);
  if (selected.length < 2) {
    alert("Please select at least 2 colors to play.");
    return false;
  }
  game.players.forEach((p) => {
    p.enabled = selected.includes(p);
    p.tokens.forEach((t) => {
      t.steps = -1;
      t.finished = false;
    });
  });
  game.standings = [];
  game.currentPlayer = selected[0].idx;
  ui.lastRoll = null;
  ui.setupComplete = true;
  el.start.textContent = "Decide Starter";
  setStatus("Click “Decide Starter” to begin.");
  scene.layout();
  renderStandings();
  setTurnUI();
  refreshControls();
  return true;
}

/** Shuffle animation that lands on `targetIdx` (or a random enabled player when null). */
function runStarter(targetIdx = null) {
  const indices = game.enabledPlayers().map((p) => p.idx);
  ui.deciding = true;
  el.start.disabled = true;
  setStatus("Deciding who starts...");
  audio.startShuffleSound();
  refreshControls();

  let i = 0;
  const timer = setInterval(() => {
    game.currentPlayer = indices[i % indices.length];
    setTurnUI();
    i += 1;
  }, 120);

  setTimeout(() => {
    clearInterval(timer);
    audio.stopShuffleSound();
    game.currentPlayer = targetIdx ?? indices[Math.floor(Math.random() * indices.length)];
    ui.deciding = false;
    ui.gameStarted = true;
    el.start.disabled = false;
    el.start.classList.add("hidden");
    setTurnUI();
    const p = currentPlayer();
    setStatus(online.active && isMine(p) ? "You start! Roll to play." : `${seatLabel(p)} starts! Roll to play.`);
    refreshControls();
    persist();
  }, 2500);
}

function decideStarter() {
  if (!ui.setupComplete) return openPlayersModal();
  if (ui.deciding) return undefined;
  if (game.enabledPlayers().length < 2) return openPlayersModal();
  runStarter();
  return undefined;
}

// ---------------------------------------------------------------------------
// Turn flow
// ---------------------------------------------------------------------------

/** UI entry point for rolling (button, dice tap, Space). */
function requestRoll() {
  if (!canRoll()) return;
  if (!online.active) {
    doRoll(1 + Math.floor(Math.random() * 6));
  } else if (online.role === "host") {
    hostRoll();
  } else {
    online.link.send({ t: "roll" });
  }
}

/** Host only: pick the value, tell everyone, and roll locally. */
function hostRoll() {
  const value = 1 + Math.floor(Math.random() * 6);
  online.link.broadcast({ t: "roll", v: value });
  doRoll(value);
}

/** Runs the roll animation and resolves what follows. Identical on every peer. */
async function doRoll(value) {
  game.ensureCurrentPlayerActive();
  const player = currentPlayer();
  const mine = isMine(player);

  ui.animating = true;
  ui.moveSent = false;
  refreshControls();
  audio.playDiceRoll();
  if (mine) buzz(25);
  await scene.rollDice(value);
  if (mine) buzz(value === 6 ? [40, 40, 60] : 30);
  if (value === 6) audio.playChime();

  ui.lastRoll = { player, value };
  setTurnUI();

  const movable = game.movableTokens(player, value);
  if (!movable.length) {
    const next = game.nextPlayerIndex(game.currentPlayer);
    setStatus(`${seatLabel(player)} rolled ${value} but has no valid moves. Next: ${seatLabel(game.players[next])}.`);
    await sleep(800);
    game.currentPlayer = next;
    ui.animating = false;
    setTurnUI();
    finishAction();
    refreshControls();
    persist();
    return;
  }

  ui.awaitingMove = true;
  ui.pendingRoll = value;
  ui.pendingPlayer = player;
  ui.animating = false;
  refreshSelectable();
  setStatus(mine ? `You rolled ${value}. Tap a glowing pawn to move it.` : `${seatLabel(player)} rolled ${value}. Waiting for them to move…`);
  refreshControls();
}

function handleTokenClick(token) {
  if (!ui.awaitingMove || ui.animating || ui.moveSent || ui.pendingDirection) return;
  if (token.player !== ui.pendingPlayer || !isMine(token.player)) return;
  const roll = ui.pendingRoll;
  const { forward, backward } = game.options(token, roll);
  if (!forward && !backward) return;

  if (forward && backward) {
    ui.pendingDirection = { token, roll };
    scene.setSelectable([]);
    el.directionText.textContent = `${token.player.name} rolled ${roll}: capture backward or move forward?`;
    el.direction.classList.add("show");
    el.direction.setAttribute("aria-hidden", "false");
    audio.playDirectionChime();
    refreshControls();
    return;
  }
  submitMove(token, backward ? "backward" : "forward");
}

function resolveDirection(direction) {
  if (!ui.pendingDirection) return;
  const { token } = ui.pendingDirection;
  ui.pendingDirection = null;
  el.direction.classList.remove("show");
  el.direction.setAttribute("aria-hidden", "true");
  submitMove(token, direction);
}

/** Sends the local player's chosen move to wherever it must be authorised. */
function submitMove(token, direction) {
  if (!online.active) {
    executeMove(token, ui.pendingRoll, direction);
  } else if (online.role === "host") {
    hostMove(token, direction);
  } else {
    ui.moveSent = true;
    scene.setSelectable([]);
    online.link.send({ t: "move", id: token.id, dir: direction });
  }
}

function hostMove(token, direction) {
  online.link.broadcast({ t: "move", id: token.id, dir: direction });
  executeMove(token, ui.pendingRoll, direction);
}

async function executeMove(token, roll, direction) {
  const player = token.player;
  ui.awaitingMove = false;
  ui.pendingRoll = null;
  ui.pendingPlayer = null;
  ui.moveSent = false;
  ui.animating = true;
  scene.setSelectable([]);
  refreshControls();

  const leavingBase = token.steps === -1;
  const plan = game.stepPlan(token, roll, direction);
  for (let i = 0; i < plan.length; i += 1) {
    token.steps = plan[i];
    if (i === plan.length - 1) game.settle(token);
    scene.layout();
    audio.playStepTick();
    await scene.hopStep(token, leavingBase ? 0.55 : 0.2);
  }

  let flight = Promise.resolve();
  const victim = game.resolveCapture(token);
  if (victim) {
    audio.playCaptureCrash();
    if (isMine(victim.player)) buzz([70, 40, 110]);
    scene.captureBurst(victim);
    scene.layout();
    flight = scene.flyToBase(victim);
  }
  if (token.finished) {
    audio.playHomeCheer();
    if (isMine(player)) buzz([40, 30, 40, 30, 90]);
    scene.celebrate(token);
  }
  game.updateStandings();
  renderStandings();
  await flight;

  const extraTurn = roll === 6 && !game.isPlayerComplete(player);
  const nextIdx = extraTurn ? game.currentPlayer : game.nextPlayerIndex(game.currentPlayer);
  game.currentPlayer = nextIdx;
  ui.animating = false;
  setTurnUI();

  if (allDone()) {
    const order = game.standings.map((p, i) => `${ordinal(i + 1)} ${p.name}`).join(", ");
    setStatus(`Game over! ${order}.`);
    showWinner();
  } else {
    const bits = [`${seatLabel(player)} rolled ${roll}.`];
    if (victim) bits.push(`Captured ${victim.player.name}!`);
    if (token.finished) bits.push("Pawn home!");
    const next = game.players[nextIdx];
    bits.push(extraTurn ? "Rolls again." : `Next: ${seatLabel(next)}.`);
    setStatus(bits.join(" "));
  }
  finishAction();
  refreshControls();
  persist();
}

// ---------------------------------------------------------------------------
// Online: snapshots / sync
// ---------------------------------------------------------------------------

function buildSnapshot(withPending = false) {
  return {
    seq: ui.actionSeq,
    started: ui.gameStarted,
    game: game.serialize(),
    lastRoll: ui.lastRoll ? { color: ui.lastRoll.player.color, value: ui.lastRoll.value } : null,
    pending: withPending && ui.awaitingMove ? { color: ui.pendingPlayer.color, roll: ui.pendingRoll } : null,
  };
}

/** Called after every completed roll-without-move or move. */
function finishAction() {
  ui.actionSeq += 1;
  if (!online.active) return;
  if (online.role === "host") online.link.broadcast({ t: "state", snap: buildSnapshot() });
  else reconcile();
}

function applySnapshot(snap) {
  if (!game.restore(snap.game)) return;
  ui.actionSeq = snap.seq;
  ui.setupComplete = true;
  ui.gameStarted = !!snap.started;
  ui.deciding = false;
  ui.animating = false;
  ui.moveSent = false;
  ui.pendingDirection = null;
  el.direction.classList.remove("show");
  const last = snap.lastRoll && game.players.find((p) => p.color === snap.lastRoll.color);
  ui.lastRoll = last ? { player: last, value: snap.lastRoll.value } : null;
  ui.awaitingMove = false;
  ui.pendingRoll = null;
  ui.pendingPlayer = null;
  if (snap.pending) {
    ui.awaitingMove = true;
    ui.pendingRoll = snap.pending.roll;
    ui.pendingPlayer = game.players.find((p) => p.color === snap.pending.color);
  }
  online.inbox = [];
  online.latest = null;
  scene.snap();
  if (ui.lastRoll) scene.setDiceFace(ui.lastRoll.value);
  el.start.classList.add("hidden");
  renderStandings();
  setTurnUI();
  refreshSelectable();
  refreshControls();
}

/** Client: compare the host's snapshot with local state once local animations are done. */
function reconcile() {
  const snap = online.latest;
  if (!snap || ui.animating) return;
  if (snap.seq < ui.actionSeq) {
    online.latest = null;
    return;
  }
  if (snap.seq > ui.actionSeq) {
    // Behind: normally a queued message is about to catch us up. If we are idle and nothing
    // arrives, we have drifted, so take the host's word for it.
    setTimeout(() => {
      if (online.latest && !ui.animating && online.latest.seq > ui.actionSeq) applySnapshot(online.latest);
    }, 2500);
    return;
  }
  online.latest = null;
  if (JSON.stringify(game.serialize()) !== JSON.stringify(snap.game)) applySnapshot(snap);
}

/** Client: apply queued roll/move messages in order once the previous one has finished. */
function pumpInbox() {
  if (online.role !== "client") return;
  while (online.inbox.length) {
    if (ui.animating || ui.deciding) return;
    const msg = online.inbox[0];
    if (msg.t === "roll") {
      if (!canApplyRoll()) return;
      online.inbox.shift();
      doRoll(msg.v);
      return;
    }
    if (msg.t === "move") {
      if (!ui.awaitingMove) return;
      online.inbox.shift();
      const token = findToken(msg.id);
      if (token) {
        ui.pendingDirection = null;
        el.direction.classList.remove("show");
        executeMove(token, ui.pendingRoll, msg.dir);
      }
      return;
    }
    online.inbox.shift();
  }
}

// ---------------------------------------------------------------------------
// Online: host logic
// ---------------------------------------------------------------------------

const publicSeats = () =>
  Object.fromEntries(SEATS.map((c) => [c, { kind: online.seats[c].kind, name: online.seats[c].name, away: !!online.seats[c].away }]));

const seatOfConn = (conn) => SEATS.find((c) => online.seats[c].connId === conn.peer) || null;

function broadcastLobby() {
  online.link.broadcast({ t: "lobby", seats: publicSeats() });
  renderLobby();
  setTurnUI();
}

function assignSeat(conn, seat, token, name) {
  online.seats[seat] = { kind: "peer", name, token, connId: conn.peer, away: false, conn };
  online.link.sendTo(conn, {
    t: "welcome",
    seat,
    seats: publicSeats(),
    phase: online.phase,
    snap: online.phase === "playing" ? buildSnapshot(true) : null,
  });
  broadcastLobby();
}

function hostOnData(conn, msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.t === "hello") {
    const name = String(msg.name || "Player").slice(0, 14);
    const token = String(msg.token || "").slice(0, 40);
    const returning = SEATS.find((c) => token && online.seats[c].token === token && online.seats[c].kind !== "host");
    if (returning) {
      const wasAway = online.seats[returning].away;
      assignSeat(conn, returning, token, name);
      if (wasAway) setStatus(`${name} reconnected as ${returning}.`);
      return;
    }
    if (online.phase !== "lobby") {
      online.link.sendTo(conn, { t: "reject", reason: "That game has already started." });
      return;
    }
    const open = SEATS.find((c) => online.seats[c].kind === "open");
    if (!open) {
      online.link.sendTo(conn, { t: "reject", reason: "This room is full." });
      return;
    }
    assignSeat(conn, open, token, name);
    return;
  }
  if (msg.t === "roll" || msg.t === "move") {
    online.intents.push({ conn, msg, at: Date.now() });
    drainIntents();
  }
}

function hostOnClose(conn) {
  const seat = seatOfConn(conn);
  if (!seat) return;
  const s = online.seats[seat];
  if (online.phase === "playing") {
    // The computer covers for them; they can rejoin with the same browser tab.
    s.kind = "bot";
    s.away = true;
    s.connId = null;
    s.conn = null;
    setStatus(`${s.name || seat} disconnected. The computer will play ${seat} until they return.`);
  } else {
    online.seats[seat] = { kind: "open", name: "" };
  }
  broadcastLobby();
}

/** Returns "done" | "wait" | "bad" for a client's request. */
function tryIntent({ conn, msg }) {
  const seat = seatOfConn(conn);
  if (!seat || online.seats[seat].kind !== "peer") return "bad";
  if (!ui.gameStarted || allDone()) return "bad";
  if (ui.animating || ui.deciding) return "wait";

  if (msg.t === "roll") {
    if (ui.awaitingMove || ui.pendingDirection) return "bad";
    if (currentPlayer().color !== seat) return "bad";
    hostRoll();
    return "done";
  }

  if (!ui.awaitingMove) return "bad";
  if (ui.pendingPlayer.color !== seat) return "bad";
  const token = findToken(msg.id);
  if (!token || token.player.color !== seat) return "bad";
  const opts = game.options(token, ui.pendingRoll);
  if (msg.dir === "forward" ? !opts.forward : msg.dir === "backward" ? !opts.backward : true) return "bad";
  hostMove(token, msg.dir);
  return "done";
}

function drainIntents() {
  if (!(online.active && online.role === "host") || !online.intents.length) return;
  const now = Date.now();
  online.intents = online.intents.filter((it) => {
    const result = tryIntent(it);
    if (result === "done") return false;
    if (result === "bad" || now - it.at > 4000) {
      online.link.sendTo(it.conn, { t: "nack" });
      return false;
    }
    return true;
  });
}

/** Computer players: pick a sensible legal move (captures > finishing > leaving base > progress). */
function botChoose(player, roll) {
  let best = null;
  const all = [];
  game.movableTokens(player, roll).forEach((token) => {
    const o = game.options(token, roll);
    const dirs = [];
    if (o.forward) dirs.push("forward");
    if (o.backward) dirs.push("backward");
    dirs.forEach((dir) => {
      let score = Math.random() * 3;
      if (dir === "backward") {
        score += 100;
      } else {
        const target = token.steps === -1 ? 0 : token.steps + roll;
        const idx = game.indexForSteps(player, target);
        if (token.steps === -1) score += 55;
        if (idx != null && game.captureTargetAt(player, idx)) score += 100;
        if (idx != null && game.safeIndices.has(idx)) score += 18;
        if (target === player.entryStep + 7) score += 90;
        else if (target > player.entryStep) score += 35;
        if (token.steps > 0) score += token.steps * 0.15;
      }
      all.push({ token, dir, score });
      if (!best || score > best.score) best = { token, dir, score };
    });
  });
  // Easy computers often just pick any legal move.
  if (online.botLevel === "easy" && all.length && Math.random() < 0.55) return all[Math.floor(Math.random() * all.length)];
  return best;
}

function maybeBot() {
  if (!(online.active && online.role === "host" && ui.gameStarted) || online.botTimer) return;
  if (ui.animating || ui.deciding || allDone()) return;
  const player = currentPlayer();
  if (online.seats[player.color].kind !== "bot") return;

  if (ui.awaitingMove) {
    if (ui.pendingPlayer !== player) return;
    online.botTimer = setTimeout(() => {
      online.botTimer = null;
      if (!ui.awaitingMove || ui.animating || ui.pendingPlayer !== player) return;
      const choice = botChoose(player, ui.pendingRoll);
      if (choice) hostMove(choice.token, choice.dir);
    }, 1000);
  } else if (canApplyRoll()) {
    online.botTimer = setTimeout(() => {
      online.botTimer = null;
      if (canApplyRoll() && currentPlayer() === player && online.seats[player.color].kind === "bot") hostRoll();
    }, 1000);
  }
}

// ---------------------------------------------------------------------------
// Online: lobby UI and connection lifecycle
// ---------------------------------------------------------------------------

const sessionToken = (() => {
  try {
    let t = sessionStorage.getItem("ghana_ludo_token");
    if (!t) {
      t = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      sessionStorage.setItem("ghana_ludo_token", t);
    }
    return t;
  } catch (err) {
    return Math.random().toString(36).slice(2);
  }
})();

function loadName() {
  try {
    return localStorage.getItem("ghana_ludo_name") || "";
  } catch (err) {
    return "";
  }
}

function saveName(name) {
  try {
    localStorage.setItem("ghana_ludo_name", name);
  } catch (err) {
    // ignore
  }
}

const cleanName = () => (el.onlineName.value || "").trim().slice(0, 14) || "Player";
const showOnlineError = (message) => {
  el.onlineError.textContent = message || "";
};

function setBusy(button, busy) {
  button.classList.toggle("busy", busy);
  button.disabled = busy;
}

function renderLobby() {
  if (!online.active || !online.seats) return;
  const isHost = online.role === "host";
  el.onlineMenu.hidden = true;
  el.onlineLobby.hidden = false;
  el.roomCode.textContent = online.code || "-----";
  el.seatList.innerHTML = "";

  SEATS.forEach((color) => {
    const seat = online.seats[color];
    const li = document.createElement("li");
    li.className = `seat ${color}${seat.kind === "open" || seat.kind === "closed" ? " empty" : ""}`;
    const who = document.createElement("span");
    who.className = "who";
    const you = online.mySeat === color;
    let sub = "";
    let title = "";
    if (seat.kind === "host") {
      title = seat.name || "Host";
      sub = "Host";
    } else if (seat.kind === "peer") {
      title = seat.name || "Player";
      sub = "Player";
    } else if (seat.kind === "bot") {
      title = "Computer";
      sub = seat.away ? "Covering for a player who left" : "Computer player";
    } else if (seat.kind === "open") {
      title = "Waiting for a player…";
    } else {
      title = "Closed";
    }
    who.textContent = you ? `${title} (you)` : title;
    if (sub) {
      const small = document.createElement("small");
      small.textContent = sub;
      who.appendChild(small);
    }
    li.appendChild(who);

    if (isHost && seat.kind !== "host") {
      if (seat.kind === "peer") {
        const kick = document.createElement("button");
        kick.className = "ghost";
        kick.textContent = "Remove";
        kick.addEventListener("click", () => setSeatKind(color, "open"));
        li.appendChild(kick);
      } else {
        const select = document.createElement("select");
        select.setAttribute("aria-label", `${color} seat`);
        [["open", "Open"], ["bot", "Computer"], ["closed", "Closed"]].forEach(([value, label]) => {
          const opt = document.createElement("option");
          opt.value = value;
          opt.textContent = label;
          opt.selected = seat.kind === value;
          select.appendChild(opt);
        });
        select.addEventListener("change", () => setSeatKind(color, select.value));
        li.appendChild(select);
      }
    }
    el.seatList.appendChild(li);
  });

  const occupied = SEATS.filter((c) => ["host", "peer", "bot"].includes(online.seats[c].kind)).length;
  el.startOnline.hidden = !isHost || online.phase !== "lobby";
  el.startOnline.disabled = occupied < 2;
  if (online.phase === "playing") el.lobbyHint.textContent = "Game in progress. Friends can rejoin with the code.";
  else if (isHost) el.lobbyHint.textContent = occupied < 2 ? "Share the code, or set a seat to Computer, to get at least 2 players." : "Ready when you are.";
  else el.lobbyHint.textContent = "Waiting for the host to start the game…";
  updateBadge();
}

function updateBadge() {
  el.online.hidden = online.solo;
  el.solo.hidden = online.active;
  if (!online.active) {
    el.roomBadge.hidden = true;
    el.online.textContent = "Play Online";
    return;
  }
  if (online.solo) {
    el.roomBadge.hidden = false;
    el.roomBadge.className = `room-badge ${online.mySeat}`;
    el.roomBadge.textContent = `You: ${online.mySeat[0].toUpperCase()}${online.mySeat.slice(1)} · vs Computer`;
    return;
  }
  el.online.textContent = "Room";
  el.roomBadge.hidden = false;
  el.roomBadge.className = `room-badge ${online.mySeat || ""}`;
  const state = online.ended ? " · disconnected" : "";
  el.roomBadge.textContent = `You: ${online.mySeat ? online.mySeat[0].toUpperCase() + online.mySeat.slice(1) : "—"} · Room ${online.code || ""}${state}`;
}

/** Host: change what a seat is (open / computer / closed / remove a player). */
function setSeatKind(color, kind) {
  const seat = online.seats[color];
  if (seat.kind === "host" || online.phase !== "lobby") return;
  if (seat.kind === "peer" && seat.conn) {
    online.link.sendTo(seat.conn, { t: "reject", reason: "The host removed you from the room." });
    setTimeout(() => {
      try {
        seat.conn.close();
      } catch (err) {
        // ignore
      }
    }, 200);
  }
  online.seats[color] = { kind, name: "" };
  broadcastLobby();
}

function openOnlineModal() {
  el.onlineName.value = el.onlineName.value || loadName();
  if (online.active) renderLobby();
  else {
    el.onlineMenu.hidden = false;
    el.onlineLobby.hidden = true;
  }
  setModal(el.onlineModal, true);
}

function enterOnline(role, code) {
  online.active = true;
  online.role = role;
  online.code = code;
  online.ended = false;
  online.intents = [];
  online.inbox = [];
  online.latest = null;
  online.phase = "lobby";
  el.start.classList.add("hidden");
  el.reset.disabled = false;
  el.reset.textContent = "Leave Game";
  setStatus(role === "host" ? "Room created. Share the code with your friends." : "Joined. Waiting for the host to start.");
  updateBadge();
}

async function createRoom() {
  showOnlineError("");
  setBusy(el.onlineCreate, true);
  const name = cleanName();
  saveName(name);
  try {
    const link = await net.hostRoom({
      onConnect: () => {},
      onData: hostOnData,
      onClose: hostOnClose,
    });
    online.link = link;
    online.name = name;
    online.mySeat = "blue";
    online.seats = Object.fromEntries(SEATS.map((c) => [c, { kind: "open", name: "" }]));
    online.seats.blue = { kind: "host", name, token: sessionToken };
    enterOnline("host", link.code);
    renderLobby();
  } catch (err) {
    showOnlineError(err.message || "Could not create a room.");
  } finally {
    setBusy(el.onlineCreate, false);
  }
}

async function joinRoom(code) {
  showOnlineError("");
  const clean = net.normalizeCode(code);
  if (clean.length !== 5) {
    showOnlineError("Enter the 5-letter room code.");
    return;
  }
  setBusy(el.onlineJoin, true);
  const name = cleanName();
  saveName(name);
  try {
    const link = await net.joinRoom(clean, { onData: clientOnData, onClose: clientOnClose });
    online.link = link;
    online.name = name;
    online.seats = null;
    online.role = "client";
    online.code = clean;
    link.send({ t: "hello", token: sessionToken, name });
    // The host answers with `welcome` (or `reject`); enterOnline runs from clientOnData.
    online.pendingJoin = setTimeout(() => {
      if (!online.active) {
        showOnlineError("The host did not answer. Try again.");
        try {
          link.close();
        } catch (err) {
          // ignore
        }
      }
    }, 8000);
  } catch (err) {
    showOnlineError(err.message || "Could not join the room.");
  } finally {
    setBusy(el.onlineJoin, false);
  }
}

function clientOnData(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.t) {
    case "welcome":
      clearTimeout(online.pendingJoin);
      online.mySeat = msg.seat;
      online.seats = msg.seats;
      online.phase = msg.phase;
      enterOnline("client", online.code);
      online.phase = msg.phase;
      renderLobby();
      scene.setViewSeat(online.mySeat);
      if (msg.snap) {
        setModal(el.onlineModal, false);
        applySnapshot(msg.snap);
        setStatus("Reconnected to the game.");
      }
      break;
    case "reject":
      clearTimeout(online.pendingJoin);
      showOnlineError(msg.reason || "Could not join.");
      if (online.active) {
        setStatus(msg.reason || "Removed from the room.");
        online.ended = true;
        updateBadge();
        refreshControls();
      } else {
        try {
          online.link.close();
        } catch (err) {
          // ignore
        }
      }
      break;
    case "lobby":
      online.seats = msg.seats;
      renderLobby();
      setTurnUI();
      break;
    case "start":
      handleStart(msg.enabled, msg.starter);
      break;
    case "roll":
    case "move":
      online.inbox.push(msg);
      pumpInbox();
      break;
    case "state":
      online.latest = msg.snap;
      reconcile();
      break;
    case "nack":
      ui.moveSent = false;
      refreshSelectable();
      break;
    default:
      break;
  }
}

function clientOnClose() {
  if (!online.active) {
    showOnlineError("Lost connection to the room.");
    return;
  }
  online.ended = true;
  setStatus("Disconnected from the host. Reload the page to start over.");
  updateBadge();
  scene.setSelectable([]);
  refreshControls();
}

/** Host clicks Start: freeze the roster, pick the starter and tell everyone. */
function startOnlineGame() {
  if (online.role !== "host" || online.phase !== "lobby") return;
  const enabled = SEATS.filter((c) => ["host", "peer", "bot"].includes(online.seats[c].kind));
  if (enabled.length < 2) return;
  const starter = game.players.find((p) => p.color === enabled[Math.floor(Math.random() * enabled.length)]).idx;
  SEATS.forEach((c) => {
    if (!enabled.includes(c)) online.seats[c] = { kind: "closed", name: "" };
  });
  online.link.broadcast({ t: "lobby", seats: publicSeats() });
  online.link.broadcast({ t: "start", enabled, starter });
  handleStart(enabled, starter);
}

function handleStart(enabled, starter) {
  online.phase = "playing";
  game.players.forEach((p) => {
    p.enabled = enabled.includes(p.color);
    p.tokens.forEach((t) => {
      t.steps = -1;
      t.finished = false;
    });
  });
  game.standings = [];
  game.currentPlayer = starter;
  ui.lastRoll = null;
  ui.setupComplete = true;
  ui.gameStarted = false;
  ui.awaitingMove = false;
  ui.pendingRoll = null;
  ui.pendingPlayer = null;
  ui.moveSent = false;
  ui.actionSeq = 0;
  online.inbox = [];
  online.latest = null;
  setModal(el.onlineModal, false);
  scene.layout();
  renderStandings();
  setTurnUI();
  el.start.classList.add("hidden");
  scene.setViewSeat(online.mySeat);
  renderLobby();
  runStarter(starter);
}

/** Play vs Computer: the online host machinery, run locally with a dummy network. */
function startSolo(color, opponents, level) {
  const idx = SEATS.indexOf(color);
  // 1 opponent sits opposite; 2 sit either side; 3 fill the table
  const prefs = [(idx + 2) % 4, (idx + 1) % 4, (idx + 3) % 4].map((i) => SEATS[i]);
  const chosen = prefs.slice(0, opponents);

  online.active = true;
  online.role = "host";
  online.solo = true;
  online.botLevel = level;
  online.link = { broadcast() {}, sendTo() {}, close() {} };
  online.code = null;
  online.ended = false;
  online.intents = [];
  online.inbox = [];
  online.latest = null;
  online.mySeat = color;
  online.seats = Object.fromEntries(SEATS.map((c) => [c, { kind: "closed", name: "" }]));
  online.seats[color] = { kind: "host", name: "" };
  chosen.forEach((c) => {
    online.seats[c] = { kind: "bot", name: "" };
  });
  clearPersisted(); // the previous local game is being replaced
  el.start.classList.add("hidden");
  el.reset.disabled = false;
  el.reset.textContent = "Leave Game";
  setModal(el.soloModal, false);
  setModal(el.playersModal, false);
  updateBadge();

  const enabled = SEATS.filter((c) => online.seats[c].kind !== "closed");
  const starter = game.players.find((p) => p.color === enabled[Math.floor(Math.random() * enabled.length)]).idx;
  handleStart(enabled, starter);
}

function leaveRoom() {
  try {
    online.link?.close();
  } catch (err) {
    // ignore
  }
  window.location.href = window.location.pathname;
}

function inviteLink() {
  return `${window.location.origin}${window.location.pathname}?room=${online.code}`;
}

async function copyInvite() {
  const link = inviteLink();
  try {
    await navigator.clipboard.writeText(link);
    el.copyLink.textContent = "Copied!";
  } catch (err) {
    window.prompt("Copy this invite link:", link);
    el.copyLink.textContent = "Copy invite link";
    return;
  }
  setTimeout(() => {
    el.copyLink.textContent = "Copy invite link";
  }, 1600);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

el.start.addEventListener("click", () => (ui.setupComplete ? decideStarter() : openPlayersModal()));
el.roll.addEventListener("click", requestRoll);
el.view.addEventListener("click", () => scene.resetView());
el.rules.addEventListener("click", () => setModal(el.rulesModal, true));
el.rulesClose.addEventListener("click", () => setModal(el.rulesModal, false));
el.playersClose.addEventListener("click", () => setModal(el.playersModal, false));
el.playersSave.addEventListener("click", () => {
  if (!applyPlayerSelection()) return;
  setModal(el.playersModal, false);
  persist();
});
[el.rulesModal, el.playersModal, el.onlineModal, el.soloModal].forEach((modal) => {
  modal.addEventListener("click", (event) => {
    if (event.target === modal) setModal(modal, false);
  });
});
el.directionForward.addEventListener("click", () => resolveDirection("forward"));
el.directionBackward.addEventListener("click", () => resolveDirection("backward"));
el.mute.addEventListener("click", () => {
  const muted = !audio.isMuted();
  audio.setMuted(muted);
  if (muted) audio.stopShuffleSound();
  if (!muted) audio.unlockAudio();
  el.mute.textContent = muted ? "Sound Off" : "Sound On";
  el.mute.setAttribute("aria-pressed", String(muted));
});
el.winnerClose.addEventListener("click", () => setModal(el.winnerModal, false));
el.winnerNew.addEventListener("click", () => {
  clearPersisted();
  if (online.active) leaveRoom();
  else window.location.reload();
});

el.online.addEventListener("click", openOnlineModal);

// Play vs Computer setup dialog (single-choice chip groups)
const chipValue = (group) => group.querySelector('.chip[aria-pressed="true"]').dataset.value;
[el.soloColor, el.soloCount, el.soloLevel].forEach((group) => {
  group.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    group.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
  });
});
el.solo.addEventListener("click", () => setModal(el.soloModal, true));
el.soloClose.addEventListener("click", () => setModal(el.soloModal, false));
el.soloStart.addEventListener("click", () =>
  startSolo(chipValue(el.soloColor), Number(chipValue(el.soloCount)), chipValue(el.soloLevel))
);
el.onlineClose.addEventListener("click", () => setModal(el.onlineModal, false));
el.onlineCreate.addEventListener("click", createRoom);
el.onlineJoin.addEventListener("click", () => joinRoom(el.onlineCode.value));
el.onlineCode.addEventListener("input", () => {
  el.onlineCode.value = net.normalizeCode(el.onlineCode.value);
});
el.onlineCode.addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinRoom(el.onlineCode.value);
});
el.copyLink.addEventListener("click", copyInvite);
el.leaveRoom.addEventListener("click", leaveRoom);
el.startOnline.addEventListener("click", startOnlineGame);

// Two-click confirm (native confirm() can be suppressed in embedded browsers).
let resetArmed = null;
el.reset.addEventListener("click", () => {
  if (!resetArmed) {
    el.reset.textContent = online.active ? "Click again to leave" : "Click again to confirm";
    resetArmed = setTimeout(() => {
      resetArmed = null;
      el.reset.textContent = online.active ? "Leave Game" : "Reset Game";
    }, 3000);
    return;
  }
  clearTimeout(resetArmed);
  if (online.active) return leaveRoom();
  clearPersisted();
  return window.location.reload();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setModal(el.rulesModal, false);
    setModal(el.playersModal, false);
    setModal(el.onlineModal, false);
    setModal(el.soloModal, false);
  } else if (event.code === "Space" && event.target === document.body) {
    event.preventDefault();
    requestRoll();
  }
});

// Unlock audio on the first real gesture (touch, click or key). Canvas taps arrive as pointer
// events, which iOS may not count as a gesture, so listen for the classic touch/click events too.
["pointerdown", "touchstart", "touchend", "click", "keydown"].forEach((type) => {
  document.addEventListener(type, () => audio.unlockAudio(), { capture: true, passive: true });
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") audio.resumeAudio();
});
window.addEventListener("pageshow", () => audio.resumeAudio());

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const roomParam = net.normalizeCode(new URLSearchParams(window.location.search).get("room"));

if (!roomParam && tryRestore()) {
  scene.snap();
  if (ui.lastRoll) scene.setDiceFace(ui.lastRoll.value);
  if (ui.gameStarted) {
    el.start.classList.add("hidden");
    setStatus(`Welcome back. ${currentPlayer().name}, roll to continue.`);
  } else {
    el.start.textContent = "Decide Starter";
    setStatus("Click “Decide Starter” to begin.");
  }
  renderStandings();
  setTurnUI();
  refreshControls();
} else {
  game.reset();
  scene.snap();
  renderStandings();
  setTurnUI();
  refreshControls();
  if (roomParam) {
    setStatus("You've been invited to a game. Enter your name and tap Join.");
    el.onlineCode.value = roomParam;
    openOnlineModal();
  } else {
    setStatus("Choose your player colors to begin.");
    openPlayersModal();
  }
}
el.loading.classList.add("done");
scene.intro();

// Handle for automated checks in the browser console.
window.__ludo = { game, ui, scene, online, handleTokenClick, requestRoll, audio };
