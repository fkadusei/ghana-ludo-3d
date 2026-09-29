/**
 * Ghana Ludo 3D — UI controller.
 * Glues the rules engine (engine.js), the three.js view (scene.js), audio and the HUD together.
 *
 * Flow: choose players -> decide starter -> roll (3D dice) -> click a glowing pawn -> animate,
 * resolve capture / finish / turn order.
 */
import { Game } from "./engine.js";
import * as audio from "./audio.js";

const $ = (id) => document.getElementById(id);
const el = {
  stage: $("stage"),
  loading: $("loading"),
  status: $("status"),
  start: $("start"),
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
  lastRoll: null, // { player, value }
};

const scene = createScene(el.stage, game, {
  onTokenClick: (token) => handleTokenClick(token),
  onDiceClick: () => rollDice(),
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

function canRoll() {
  return ui.gameStarted && !ui.deciding && !ui.animating && !ui.awaitingMove && !ui.pendingDirection && !allDone();
}

function refreshControls() {
  const rollable = canRoll();
  el.roll.disabled = !rollable;
  scene.setDiceEnabled(rollable);
  el.reset.disabled = !ui.gameStarted && !ui.setupComplete;
}

function setTurnCard(card, player, role) {
  card.className = `turn-card ${role}${player ? ` ${player.color}` : ""}`;
}

function setTurnUI() {
  game.ensureCurrentPlayerActive();
  const current = currentPlayer();
  const next = game.players[game.nextPlayerIndex(game.currentPlayer)];
  const show = ui.setupComplete;

  el.currentName.textContent = show ? current.name : "Not set";
  el.nextName.textContent = show ? next.name : "—";
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
      name.textContent = winner.name;
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
  el.winnerTitle.textContent = `${first.name} wins!`;
  el.winnerTitle.className = first.color;
  el.podium.innerHTML = "";
  game.standings.forEach((p, i) => {
    const li = document.createElement("li");
    li.className = p.color;
    li.textContent = `${ordinal(i + 1)} — ${p.name}`;
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
// Persistence (saved at stable points: after setup, start, roll-without-move, and every move)
// ---------------------------------------------------------------------------

function persist() {
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
// Setup flow
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

function decideStarter() {
  if (!ui.setupComplete) return openPlayersModal();
  if (ui.deciding) return undefined;
  const indices = game.enabledPlayers().map((p) => p.idx);
  if (indices.length < 2) return openPlayersModal();

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
    game.currentPlayer = indices[Math.floor(Math.random() * indices.length)];
    ui.deciding = false;
    ui.gameStarted = true;
    el.start.disabled = false;
    el.start.classList.add("hidden");
    setTurnUI();
    setStatus(`${currentPlayer().name} starts! Roll to play.`);
    refreshControls();
    persist();
  }, 2500);
  return undefined;
}

// ---------------------------------------------------------------------------
// Turn flow
// ---------------------------------------------------------------------------

async function rollDice() {
  if (!canRoll()) return;
  game.ensureCurrentPlayerActive();
  const player = currentPlayer();
  const value = 1 + Math.floor(Math.random() * 6);

  ui.animating = true;
  refreshControls();
  audio.playDiceRoll();
  buzz(25);
  await scene.rollDice(value);
  buzz(value === 6 ? [40, 40, 60] : 30);
  if (value === 6) audio.playChime();

  ui.lastRoll = { player, value };
  setTurnUI();

  const movable = game.movableTokens(player, value);
  if (!movable.length) {
    const next = game.nextPlayerIndex(game.currentPlayer);
    setStatus(`${player.name} rolled ${value} but has no valid moves. Next: ${game.players[next].name}.`);
    await sleep(800);
    game.currentPlayer = next;
    ui.animating = false;
    setTurnUI();
    refreshControls();
    persist();
    return;
  }

  ui.awaitingMove = true;
  ui.pendingRoll = value;
  ui.pendingPlayer = player;
  ui.animating = false;
  scene.setSelectable(movable);
  setStatus(`${player.name} rolled ${value}. Tap a glowing pawn to move it.`);
  refreshControls();
}

function handleTokenClick(token) {
  if (!ui.awaitingMove || ui.animating || token.player !== ui.pendingPlayer) return;
  const roll = ui.pendingRoll;
  const { forward, backward } = game.options(token, roll);
  if (!forward && !backward) return;

  if (forward && backward) {
    ui.awaitingMove = false;
    ui.pendingDirection = { token, roll };
    scene.setSelectable([]);
    el.directionText.textContent = `${token.player.name} rolled ${roll}: capture backward or move forward?`;
    el.direction.classList.add("show");
    el.direction.setAttribute("aria-hidden", "false");
    audio.playDirectionChime();
    refreshControls();
    return;
  }
  executeMove(token, roll, backward ? "backward" : "forward");
}

function resolveDirection(direction) {
  if (!ui.pendingDirection) return;
  const { token, roll } = ui.pendingDirection;
  ui.pendingDirection = null;
  el.direction.classList.remove("show");
  el.direction.setAttribute("aria-hidden", "true");
  executeMove(token, roll, direction);
}

async function executeMove(token, roll, direction) {
  const player = token.player;
  ui.awaitingMove = false;
  ui.pendingRoll = null;
  ui.pendingPlayer = null;
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
    buzz([70, 40, 110]);
    scene.captureBurst(victim);
    scene.layout();
    flight = scene.flyToBase(victim);
  }
  if (token.finished) {
    audio.playHomeCheer();
    buzz([40, 30, 40, 30, 90]);
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
    const bits = [`${player.name} rolled ${roll}.`];
    if (victim) bits.push(`Captured ${victim.player.name}!`);
    if (token.finished) bits.push("Pawn home!");
    bits.push(extraTurn ? "Roll again." : `Next: ${game.players[nextIdx].name}.`);
    setStatus(bits.join(" "));
  }
  refreshControls();
  persist();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

el.start.addEventListener("click", () => (ui.setupComplete ? decideStarter() : openPlayersModal()));
el.roll.addEventListener("click", rollDice);
el.view.addEventListener("click", () => scene.resetView());
el.rules.addEventListener("click", () => setModal(el.rulesModal, true));
el.rulesClose.addEventListener("click", () => setModal(el.rulesModal, false));
el.playersClose.addEventListener("click", () => setModal(el.playersModal, false));
el.playersSave.addEventListener("click", () => {
  if (!applyPlayerSelection()) return;
  setModal(el.playersModal, false);
  persist();
});
[el.rulesModal, el.playersModal].forEach((modal) => {
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
  el.mute.textContent = muted ? "Sound Off" : "Sound On";
  el.mute.setAttribute("aria-pressed", String(muted));
});
el.winnerClose.addEventListener("click", () => setModal(el.winnerModal, false));
el.winnerNew.addEventListener("click", () => {
  clearPersisted();
  window.location.reload();
});

// Two-click confirm (native confirm() can be suppressed in embedded browsers).
let resetArmed = null;
el.reset.addEventListener("click", () => {
  if (!resetArmed) {
    el.reset.textContent = "Click again to confirm";
    resetArmed = setTimeout(() => {
      resetArmed = null;
      el.reset.textContent = "Reset Game";
    }, 3000);
    return;
  }
  clearTimeout(resetArmed);
  clearPersisted();
  window.location.reload();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setModal(el.rulesModal, false);
    setModal(el.playersModal, false);
  } else if (event.code === "Space" && event.target === document.body) {
    event.preventDefault();
    rollDice();
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (tryRestore()) {
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
  setStatus("Choose your player colors to begin.");
  openPlayersModal();
}
el.loading.classList.add("done");
scene.intro();

// Handle for automated checks in the browser console.
window.__ludo = { game, ui, scene, handleTokenClick, rollDice };
