// Cloudflare Worker — serves static assets + mints ephemeral Gemini token.
// Static files live in ./public (wrangler.toml -> assets.directory).

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/gemini-token") {
      return mintToken(env);
    }

    // Cloud memory: GET  /api/history?key=ME      -> saved turns
    //                POST /api/history  {key, turns} -> save turns
    if (url.pathname === "/api/history") {
      return handleHistory(request, url, env);
    }

    // Serve static assets from the bundled ./public directory.
    const asset = await env.ASSETS.fetch(request);
    return asset;
  },
};

async function handleHistory(request, url, env) {
  let key = (url.searchParams.get("key") || "").trim();
  let bodyTurns = null;

  if (request.method === "POST") {
    try {
      const body = await request.json();
      if (!key) key = (body.key || "").trim();
      bodyTurns = Array.isArray(body.turns) ? body.turns : null;
    } catch (e) {
      return json({ error: "Bad JSON body" }, 400);
    }
  }

  if (!key) return json({ error: "Missing key" }, 400);

  if (request.method === "GET") {
    try {
      const raw = await env.MEMORY.get(`h:${key}`);
      return json({ turns: raw ? JSON.parse(raw) : [] }, 200);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  }

  if (request.method === "POST") {
    try {
      const turns = bodyTurns ? bodyTurns.slice(-80) : [];
      await env.MEMORY.put(`h:${key}`, JSON.stringify(turns));
      return json({ ok: true, saved: turns.length }, 200);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  }

  return json({ error: "Method not allowed" }, 405);
}

async function mintToken(env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: "Missing GEMINI_API_KEY secret" }, 500);
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
      "https://generativelanguage.googleapis.com/v1beta/auth_tokens",
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
    return json({ token: data.name, expiresAt: expireTime }, 200);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}