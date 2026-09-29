/**
 * Ludo rules engine — pure state + rules, no DOM and no rendering.
 * Ported from the 2D game so both share identical rules.
 *
 * Token model (`steps`):
 * - -1                          : in base
 * - 0..entryStep                : on the outer 52-cell track (relative to owner's start)
 * - entryStep+1..entryStep+7    : in the colored home lane
 * - entryStep+HOME_LENGTH       : finished (center home)
 * Negative steps other than -1 are used transiently while moving backward across the start.
 */

export const SIZE = 15;
export const PATH_LENGTH = 52;
export const HOME_LENGTH = 7;

/** Outer track as [row, col], clockwise, starting at Blue's entry square. */
export const PATH = [
  [6, 0], [6, 1], [6, 2], [6, 3], [6, 4], [6, 5],
  [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6],
  [0, 7], [0, 8],
  [1, 8], [2, 8], [3, 8], [4, 8], [5, 8],
  [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14],
  [7, 14], [8, 14],
  [8, 13], [8, 12], [8, 11], [8, 10], [8, 9],
  [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8],
  [14, 7], [14, 6],
  [13, 6], [12, 6], [11, 6], [10, 6], [9, 6],
  [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  [7, 0],
];

const PLAYER_DEFS = [
  {
    name: "Blue", color: "blue",
    startCoord: [6, 1], entryCoord: [7, 0],
    homeLane: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6], [7, 7]],
    base: [[2, 2], [2, 4], [4, 2], [4, 4]],
  },
  {
    name: "Red", color: "red",
    startCoord: [1, 8], entryCoord: [0, 7],
    homeLane: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7], [7, 7]],
    base: [[2, 10], [2, 12], [4, 10], [4, 12]],
  },
  {
    name: "Yellow", color: "yellow",
    startCoord: [13, 6], entryCoord: [14, 7],
    homeLane: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7], [8, 7], [7, 7]],
    base: [[10, 2], [10, 4], [12, 2], [12, 4]],
  },
  {
    name: "Green", color: "green",
    startCoord: [8, 13], entryCoord: [7, 14],
    homeLane: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 8], [7, 7]],
    base: [[10, 10], [10, 12], [12, 10], [12, 12]],
  },
];

const mod = (n, m) => ((n % m) + m) % m;
const findIndex = ([r, c]) => PATH.findIndex(([pr, pc]) => pr === r && pc === c);

export function createPlayers() {
  const players = PLAYER_DEFS.map((def, idx) => {
    const startIndex = findIndex(def.startCoord);
    const entryIndex = findIndex(def.entryCoord);
    const player = {
      ...def,
      idx,
      enabled: true,
      startIndex,
      entryIndex,
      entryStep: mod(entryIndex - startIndex, PATH_LENGTH),
    };
    player.tokens = def.base.map((baseCoord, i) => ({
      id: `${def.color}-${i}`,
      player,
      steps: -1,
      finished: false,
      baseCoord,
    }));
    return player;
  });
  return players;
}

export class Game {
  constructor() {
    this.players = createPlayers();
    this.safeIndices = new Set();
    this.players.forEach((p) => {
      this.safeIndices.add(p.startIndex);
      this.safeIndices.add((p.startIndex + 8) % PATH_LENGTH);
    });
    this.reset();
  }

  reset() {
    this.players.forEach((p) => {
      p.enabled = true;
      p.tokens.forEach((t) => {
        t.steps = -1;
        t.finished = false;
      });
    });
    this.currentPlayer = 0;
    this.standings = [];
  }

  // ---- players / turn order ------------------------------------------------

  enabledPlayers() {
    return this.players.filter((p) => p.enabled);
  }

  isPlayerComplete(player) {
    return player.tokens.every((t) => t.finished);
  }

  nextPlayerIndex(fromIndex) {
    for (let i = 1; i <= this.players.length; i += 1) {
      const idx = (fromIndex + i) % this.players.length;
      const p = this.players[idx];
      if (p.enabled && !this.isPlayerComplete(p)) return idx;
    }
    return fromIndex;
  }

  ensureCurrentPlayerActive() {
    const cur = this.players[this.currentPlayer];
    if (cur && cur.enabled && !this.isPlayerComplete(cur)) return;
    this.currentPlayer = this.nextPlayerIndex(this.currentPlayer);
  }

  updateStandings() {
    this.enabledPlayers().forEach((p) => {
      if (this.isPlayerComplete(p) && !this.standings.includes(p)) this.standings.push(p);
    });
    // Like real Ludo, the game ends once only one player is left; they take the last place.
    if (this.isOver()) {
      this.enabledPlayers().forEach((p) => {
        if (!this.standings.includes(p)) this.standings.push(p);
      });
    }
  }

  isOver() {
    const enabled = this.enabledPlayers();
    if (enabled.length < 2) return false;
    return enabled.filter((p) => !this.isPlayerComplete(p)).length <= 1;
  }

  // ---- geometry ------------------------------------------------------------

  /** Track index for a token, or null when in base / home lane. */
  indexForSteps(player, steps) {
    if (steps == null || steps === -1) return null;
    if (steps < 0) return mod(player.startIndex + steps, PATH_LENGTH);
    if (steps > player.entryStep) return null;
    return (player.startIndex + steps) % PATH_LENGTH;
  }

  landingIndex(token) {
    return this.indexForSteps(token.player, token.steps);
  }

  /** [row, col] board coordinate for a token given its current steps. */
  coordFor(token) {
    const { player, steps } = token;
    if (steps === -1) return token.baseCoord;
    if (steps < 0) return PATH[mod(player.startIndex + steps, PATH_LENGTH)];
    if (steps <= player.entryStep) return PATH[(player.startIndex + steps) % PATH_LENGTH];
    return player.homeLane[steps - player.entryStep - 1];
  }

  tokensAtIndex(index) {
    const list = [];
    this.enabledPlayers().forEach((p) => {
      p.tokens.forEach((t) => {
        if (this.landingIndex(t) === index) list.push(t);
      });
    });
    return list;
  }

  /** The single enemy token on `index` that `player` could capture, else null. */
  captureTargetAt(player, index) {
    const occupants = this.tokensAtIndex(index).filter((t) => t.player !== player);
    return occupants.length === 1 ? occupants[0] : null;
  }

  /** Map trackIndex -> owning player for every blockade (2+ same-color tokens). */
  blockades() {
    const map = new Map();
    this.enabledPlayers().forEach((p) => {
      const counts = new Map();
      p.tokens.forEach((t) => {
        const idx = this.landingIndex(t);
        if (idx == null) return;
        counts.set(idx, (counts.get(idx) || 0) + 1);
      });
      counts.forEach((n, idx) => {
        if (n >= 2) map.set(idx, p);
      });
    });
    return map;
  }

  // ---- move legality -------------------------------------------------------

  isBlockedForward(token, stepsToCheck) {
    const start = this.indexForSteps(token.player, token.steps);
    if (start == null) return false;
    const walls = this.blockades();
    for (let s = 1; s <= stepsToCheck; s += 1) {
      const idx = (start + s) % PATH_LENGTH;
      if (!walls.has(idx)) continue;
      if (walls.get(idx) === token.player && idx === start) continue;
      return true;
    }
    return false;
  }

  isBlockedBackward(token, roll) {
    const start = this.indexForSteps(token.player, token.steps);
    if (start == null) return false;
    const walls = this.blockades();
    for (let s = 1; s <= roll; s += 1) {
      const idx = (start - s + PATH_LENGTH) % PATH_LENGTH;
      if (!walls.has(idx)) continue;
      if (walls.get(idx) === token.player && idx === start) continue;
      return true;
    }
    return false;
  }

  canMoveForward(token, roll) {
    const { player } = token;
    if (token.finished) return false;
    if (token.steps === -1) {
      if (roll !== 6) return false;
      const walls = this.blockades();
      return !(walls.has(player.startIndex) && walls.get(player.startIndex) !== player);
    }
    if (token.steps + roll > player.entryStep + HOME_LENGTH) return false;
    if (token.steps <= player.entryStep) {
      const onTrack = Math.min(roll, player.entryStep - token.steps);
      if (onTrack > 0 && this.isBlockedForward(token, onTrack)) return false;
    }
    return true;
  }

  /** Backward moves are legal only when they land on (and capture) a single enemy. */
  canCaptureBackward(token, roll) {
    const { player } = token;
    if (token.finished || token.steps === -1) return false;
    if (token.steps > player.entryStep) return false;
    let target = token.steps - roll;
    if (target < 0) target += PATH_LENGTH;
    if (this.isBlockedBackward(token, roll)) return false;
    const idx = this.indexForSteps(player, target);
    if (idx == null) return false;
    return !!this.captureTargetAt(player, idx);
  }

  /** { forward, backward } legality for a token and roll. */
  options(token, roll) {
    return { forward: this.canMoveForward(token, roll), backward: this.canCaptureBackward(token, roll) };
  }

  movableTokens(player, roll) {
    return player.tokens.filter((t) => {
      const o = this.options(t, roll);
      return o.forward || o.backward;
    });
  }

  // ---- move application ----------------------------------------------------

  /**
   * Step values the token passes through for a move, ending with the final value.
   * Forward from base on a 6 is a single step to 0.
   */
  stepPlan(token, roll, direction) {
    const start = token.steps;
    if (direction === "backward") {
      const out = [];
      for (let i = 1; i <= roll; i += 1) out.push(start - i);
      return out;
    }
    if (start === -1) return [0];
    const out = [];
    for (let i = 1; i <= roll; i += 1) out.push(start + i);
    return out;
  }

  /** Normalizes transient negative steps and marks the token finished at the center. */
  settle(token) {
    while (token.steps < 0 && token.steps !== -1) token.steps += PATH_LENGTH;
    const finishStep = token.player.entryStep + HOME_LENGTH;
    if (token.steps >= finishStep) {
      token.steps = finishStep;
      token.finished = true;
    }
  }

  /** Captures a lone enemy on the token's landing square. Returns the victim or null. */
  resolveCapture(token) {
    const idx = this.landingIndex(token);
    if (idx == null) return null;
    const victim = this.captureTargetAt(token.player, idx);
    if (!victim) return null;
    victim.steps = -1;
    return victim;
  }

  // ---- persistence ---------------------------------------------------------

  serialize() {
    return {
      currentPlayer: this.currentPlayer,
      standings: this.standings.map((p) => p.color),
      players: this.players.map((p) => ({
        color: p.color,
        enabled: p.enabled,
        tokens: p.tokens.map((t) => ({ steps: t.steps, finished: t.finished })),
      })),
    };
  }

  restore(data) {
    if (!data || !Array.isArray(data.players)) return false;
    for (const saved of data.players) {
      const p = this.players.find((x) => x.color === saved.color);
      if (!p || !Array.isArray(saved.tokens) || saved.tokens.length !== p.tokens.length) return false;
    }
    data.players.forEach((saved) => {
      const p = this.players.find((x) => x.color === saved.color);
      p.enabled = !!saved.enabled;
      p.tokens.forEach((t, i) => {
        t.steps = Number(saved.tokens[i].steps);
        t.finished = !!saved.tokens[i].finished;
      });
    });
    this.currentPlayer = Number.isInteger(data.currentPlayer) ? data.currentPlayer : 0;
    this.standings = (data.standings || [])
      .map((c) => this.players.find((p) => p.color === c))
      .filter(Boolean);
    return true;
  }
}
