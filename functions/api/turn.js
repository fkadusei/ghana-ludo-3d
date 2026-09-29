/**
 * Cloudflare Pages Function: GET /api/turn
 *
 * Mints short-lived TURN relay credentials from Cloudflare Realtime TURN, so the API token never
 * reaches the browser or the (public) repo. The game fetches this when a room is created or joined
 * (see TURN_CREDENTIALS_URL in src/config.js) and adds the result to its ICE servers.
 *
 * Required environment variables (Pages project -> Settings -> Variables and Secrets):
 *   TURN_KEY_ID         the TURN key's ID          (plain text is fine)
 *   TURN_KEY_API_TOKEN  the TURN key's API token   (add as a *Secret*)
 *
 * If either is missing, or Cloudflare errors, this returns an empty list and the game simply falls
 * back to direct peer-to-peer connections, so it can never break online play.
 */

const TTL_SECONDS = 4 * 60 * 60; // long enough for a game, short enough to limit abuse

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });

export async function onRequestGet({ request, env }) {
  // Only the site itself should be asking. Browsers label cross-site fetches; refuse those.
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") return json([], 403);

  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    return json([], 200, { "X-Relay": "not-configured" });
  }

  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      }
    );
    if (!res.ok) return json([], 200, { "X-Relay": `upstream-${res.status}` });

    const data = await res.json();
    const servers = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];

    // Browsers (notably Firefox) block TURN on port 53, and it just slows ICE gathering down.
    const cleaned = servers
      .map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }))
      .filter((s) => s.urls.length > 0);

    return json(cleaned, 200, { "X-Relay": "ok" });
  } catch (err) {
    return json([], 200, { "X-Relay": "error" });
  }
}
