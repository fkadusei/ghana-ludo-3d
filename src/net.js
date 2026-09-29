/**
 * Peer-to-peer transport (WebRTC via PeerJS). No game server: the host's browser is the authority
 * and every other player connects straight to it. PeerJS's free cloud broker is only used to
 * introduce peers; game traffic then flows peer-to-peer.
 *
 * Limitation: with STUN only, a few strict networks (some corporate / carrier-grade NATs) cannot
 * connect directly. Supply relay (TURN) servers in config.js to cover those.
 */
import { TURN_SERVERS, TURN_CREDENTIALS_URL } from "./config.js";

const PEERJS_URL = "https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js";
const ID_PREFIX = "ghanaludo-";
// No 0/O/1/I so codes are easy to read out loud.
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
];

/** True when a relay is configured, so callers can tailor error messages. */
export const hasRelay = () => TURN_SERVERS.length > 0 || !!TURN_CREDENTIALS_URL;

/** STUN + any configured relays (fixed, and/or fetched fresh from TURN_CREDENTIALS_URL). */
async function peerConfig() {
  const iceServers = [...STUN_SERVERS, ...TURN_SERVERS];
  if (TURN_CREDENTIALS_URL) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(TURN_CREDENTIALS_URL, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`relay endpoint ${res.status}`);
      const extra = await res.json();
      if (Array.isArray(extra)) iceServers.push(...extra);
    } catch (err) {
      // No relay this time; direct connections still work on most networks.
    }
  }
  return { config: { iceServers } };
}

export const normalizeCode = (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);

const randomCode = () => {
  let out = "";
  for (let i = 0; i < 5; i += 1) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return out;
};

let loading = null;
function loadPeerJS() {
  if (window.Peer) return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = PEERJS_URL;
      s.onload = resolve;
      s.onerror = () => {
        loading = null;
        reject(new Error("Could not load the multiplayer library. Check your internet connection."));
      };
      document.head.appendChild(s);
    });
  }
  return loading;
}

async function openPeer(id) {
  const cfg = await peerConfig();
  return new Promise((resolve, reject) => {
    const peer = id ? new window.Peer(id, cfg) : new window.Peer(cfg);
    const timer = setTimeout(() => {
      peer.destroy();
      reject(new Error("Could not reach the matchmaking service. Try again."));
    }, 12000);
    peer.on("open", () => {
      clearTimeout(timer);
      resolve(peer);
    });
    peer.on("error", (err) => {
      clearTimeout(timer);
      peer.destroy();
      reject(err);
    });
  });
}

/**
 * Host a room. handlers: { onConnect(conn), onData(conn, msg), onClose(conn) }.
 * Resolves to { code, broadcast(msg), sendTo(conn, msg), close() }.
 */
export async function hostRoom(handlers) {
  await loadPeerJS();
  let peer = null;
  let code = null;
  for (let attempt = 0; attempt < 6 && !peer; attempt += 1) {
    code = randomCode();
    try {
      peer = await openPeer(ID_PREFIX + code);
    } catch (err) {
      if (err && err.type !== "unavailable-id") throw err;
    }
  }
  if (!peer) throw new Error("Could not create a room. Try again.");

  const conns = new Set();
  peer.on("connection", (conn) => {
    conn.on("open", () => {
      conns.add(conn);
      handlers.onConnect(conn);
    });
    conn.on("data", (msg) => handlers.onData(conn, msg));
    const gone = () => {
      if (conns.delete(conn)) handlers.onClose(conn);
    };
    conn.on("close", gone);
    conn.on("error", gone);
  });

  return {
    code,
    broadcast(msg) {
      conns.forEach((c) => c.open && c.send(msg));
    },
    sendTo(conn, msg) {
      if (conn.open) conn.send(msg);
    },
    close() {
      peer.destroy();
    },
  };
}

/**
 * Join a room. handlers: { onData(msg), onClose() }. Resolves to { send(msg), close() }.
 */
export async function joinRoom(code, handlers) {
  await loadPeerJS();
  const peer = await openPeer(null);
  const conn = peer.connect(ID_PREFIX + normalizeCode(code), { reliable: true });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            "Could not connect. Check the room code, or your network may be blocking direct connections (try another network)."
          )
        ),
      15000
    );
    conn.on("open", () => {
      clearTimeout(timer);
      resolve();
    });
    peer.on("error", (err) => {
      clearTimeout(timer);
      reject(err && err.type === "peer-unavailable" ? new Error("Room not found. Check the code.") : err);
    });
  }).catch((err) => {
    peer.destroy();
    throw err;
  });

  conn.on("data", (msg) => handlers.onData(msg));
  let closed = false;
  const gone = () => {
    if (closed) return;
    closed = true;
    handlers.onClose();
  };
  conn.on("close", gone);
  conn.on("error", gone);
  peer.on("disconnected", () => {});

  return {
    send(msg) {
      if (conn.open) conn.send(msg);
    },
    close() {
      closed = true;
      peer.destroy();
    },
  };
}
