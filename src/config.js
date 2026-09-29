/**
 * Optional relay (TURN) configuration for online play.
 *
 * Online rooms connect players directly (peer-to-peer). A few strict networks (some corporate or
 * carrier-grade NATs) block that and need a relay server to forward the traffic. Free public relays
 * no longer exist, so to enable this you supply your own credentials — see "Relay (TURN)" in the README.
 *
 * Leave both empty to use direct connections only (works for most home / mobile networks).
 */

/** Fixed relay servers, e.g. from your own coturn or a provider's dashboard. */
export const TURN_SERVERS = [
  // { urls: ["turn:relay.example.com:3478", "turns:relay.example.com:443?transport=tcp"], username: "USER", credential: "PASS" },
];

/**
 * Or a URL that returns a JSON array of RTCIceServer objects (fetched fresh each time a room is created
 * or joined). Use this with providers that mint short-lived credentials, so no secret lives in the repo.
 * Example shape: [{ "urls": "turn:...", "username": "...", "credential": "..." }]
 */
export const TURN_CREDENTIALS_URL = "";
