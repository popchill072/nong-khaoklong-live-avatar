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

    // Image generation (Nano Banana): POST /api/image {prompt, aspectRatio}
    if (request.method === "POST" && url.pathname === "/api/image") {
      return generateImage(request, env);
    }

    // Serve static assets from the bundled ./public directory.
    const asset = await env.ASSETS.fetch(request);
    return asset;
  },
};

async function generateImage(request, env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return json({ error: "Missing GEMINI_API_KEY secret" }, 500);

  let prompt = "", aspectRatio = "1:1";
  try {
    const body = await request.json();
    prompt = (body.prompt || "").trim();
    aspectRatio = ["1:1","3:2","2:3","4:3","3:4","9:16","16:9"].includes(body.aspectRatio) ? body.aspectRatio : "1:1";
  } catch (e) {
    return json({ error: "Bad JSON body" }, 400);
  }
  if (!prompt) return json({ error: "Missing prompt" }, 400);

  const wanted = env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
  const candidates = [wanted, "gemini-2.5-flash-image", "gemini-3.1-flash-lite-image"];
  const seen = new Set();
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  };

  let lastQuota = null;
  for (const model of candidates) {
    if (seen.has(model)) continue;
    seen.add(model);
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
      );
      const d = await r.json();
      if (!r.ok) {
        if (r.status === 429) { lastQuota = d?.error?.message || "image quota exceeded"; continue; }
        return json({ error: d?.error?.message || `HTTP ${r.status}` }, 500);
      }
      const parts = d?.candidates?.[0]?.content?.parts || [];
      const img = parts.find(p => p.inlineData?.data);
      if (img) return json({ data: img.inlineData.data, mimeType: img.inlineData.mimeType || "image/png", model }, 200);
    } catch (e) {
      if (String(e?.message || "").includes("429")) { lastQuota = lastQuota || e?.message; continue; }
      continue;
    }
  }

  if (lastQuota) return json({ error: "Image quota exhausted: " + lastQuota }, 429);
  return json({ error: "No image generated" }, 500);
}

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