// Cloudflare Pages Function — POST /gemini-token
// Mints a short-lived ephemeral token so the browser can talk to Gemini
// directly over WebSocket without ever seeing the real API key.
// GEMINI_API_KEY must be set as a Pages secret (Environment variable).

// Voice/model are set client-side in index.html setupSession(); the token
// here is intentionally unconstrained so the client controls them.

export async function onRequestPost({ env }) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "Missing GEMINI_API_KEY secret" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(Date.now() + 60 * 1000).toISOString();
  const body = JSON.stringify({
    uses: 1,
    expireTime,
    newSessionExpireTime,
  });

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/auth_tokens`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body,
      }
    );
    const data = await r.json();
    if (!r.ok) {
      throw new Error(data?.error?.message || `HTTP ${r.status}`);
    }
    return new Response(
      JSON.stringify({ token: data.name, expiresAt: expireTime }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: String(e?.message || e) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}