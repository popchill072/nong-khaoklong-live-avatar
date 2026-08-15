// Cloudflare Worker — serves static assets + mints ephemeral Gemini token.
// Static files live in ./public (wrangler.toml -> assets.directory).

import {
  handleLineWebhook,
  lineHealth,
  serveLineMedia,
  handleScheduled,
} from "./line.js";

// Handles to the original worker services. The LINE module calls these
// directly (no copied logic) for memory/history, search, time, notes,
// calendar and image generation.
const lineServices = {
  handleHistory,
  handleSearch,
  handleNow,
  handleNotes,
  handleCalendar,
  handleExpenses,
  handleTodos,
  handleShopping,
  generateImage,
};

export default {
  async fetch(request, env, ctx) {
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

    // Web search (proxy, no Gemini grounding quota): GET /api/search?q=...
    if (url.pathname === "/api/search") {
      return handleSearch(request, url, env);
    }

    // Current time (Asia/Bangkok): GET /api/now
    if (url.pathname === "/api/now") {
      return handleNow();
    }

    // Notes/todo memory (same KV as chat): GET /api/notes  POST /api/notes
    if (url.pathname === "/api/notes") {
      return handleNotes(request, env);
    }

    // Calendar (appointments): GET /api/calendar  POST /api/calendar  DELETE /api/calendar
    if (url.pathname === "/api/calendar") {
      return handleCalendar(request, env);
    }

    // Expenses (income/expense ledger): GET /api/expenses  POST /api/expenses
    if (url.pathname === "/api/expenses") {
      return handleExpenses(request, env);
    }

    // Todo list: GET /api/todos  POST /api/todos (toggle/delete/add)
    if (url.pathname === "/api/todos") {
      return handleTodos(request, env);
    }

    // Shopping list: GET /api/shopping  POST /api/shopping (toggle/delete/add)
    if (url.pathname === "/api/shopping") {
      return handleShopping(request, env);
    }

    // LINE Official Account module (opt-in via env flags)
    if (url.pathname === "/api/line/webhook") {
      return handleLineWebhook(request, env, lineServices, ctx);
    }
    if (url.pathname === "/api/line/health") {
      return lineHealth(env);
    }
    if (url.pathname.startsWith("/api/line/media/")) {
      return serveLineMedia(url.pathname, env);
    }

    // Serve static assets from the bundled ./public directory.
    const asset = await env.ASSETS.fetch(request);
    return asset;
  },

  // Cron trigger: LINE appointment reminders (opt-in via LINE_ENABLED +
  // LINE_REMINDERS_ENABLED). Fires on the schedule from wrangler.toml.
  async scheduled(_event, env) {
    await handleScheduled(env, lineServices);
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
    generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio } },
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

/* Web search proxy — free & keyless by default (Wikipedia TH+EN summaries).
   Data quality: factual/encyclopaedic, up-to-date enough for common questions.
   Need fresher/live-web results? Set SEARCH_API_KEY + SEARCH_ENGINE=bing|tavily. */
async function handleSearch(request, url, env) {
  const q = (url.searchParams.get("q") || "").trim();
  const max = Math.min(4, Math.max(1, parseInt(url.searchParams.get("max") || "3", 10) || 3));
  if (!q) return json({ error: "Missing query" }, 400);
  if (q.length > 300) return json({ error: "Query too long" }, 400);

  try {
    let results = [];
    if (env.SEARCH_API_KEY && env.SEARCH_ENGINE === "bing") {
      results = await searchBing(q, max, env.SEARCH_API_KEY);
    } else if (env.SEARCH_API_KEY && env.SEARCH_ENGINE === "tavily") {
      results = await searchTavily(q, max, env.SEARCH_API_KEY);
    } else {
      results = await searchWikipedia(q, max);
    }
    if (!results.length) return json({ error: "No results" }, 404);
    return json({ query: q, engine: engineLabel(env), results }, 200);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}

function engineLabel(env) {
  if (env.SEARCH_API_KEY && env.SEARCH_ENGINE === "bing") return "bing";
  if (env.SEARCH_API_KEY && env.SEARCH_ENGINE === "tavily") return "tavily";
  return "wikipedia";
}

const WIKI_UA = "nong-khaoklong-ai/1.0 (wangbua AI assistant; contact: popchill072@users.noreply.github.com)";

/* Search TH then EN Wikipedia; include article intro as the snippet. */
async function searchWikipedia(q, max) {
  const langs = ["th", "en"];
  const out = [];
  for (const lang of langs) {
    if (out.length >= max) break;
    const r = await fetch(
      `https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=${max}&redirects=resolve&format=json`,
      { headers: { "User-Agent": WIKI_UA } }
    );
    if (!r.ok) continue;
    const d = await r.json();
    const titles = d[1] || [], urls = d[3] || [];
    for (let i = 0; i < titles.length && out.length < max; i++) {
      const t = titles[i], u = urls[i] || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(t)}`;
      const snippet = await wikiExtract(lang, t);
      if (!snippet) continue;
      out.push({ title: `${t} (${lang}${lang === "th" ? " วิกิพีเดีย" : " Wikipedia"})`, url: u, snippet });
    }
  }
  return out;
}

async function wikiExtract(lang, title) {
  try {
    const r = await fetch(
      `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&redirects=1&format=json&titles=${encodeURIComponent(title)}`,
      { headers: { "User-Agent": WIKI_UA } }
    );
    if (!r.ok) return "";
    const d = await r.json();
    const pages = d?.query?.pages || {};
    const pg = Object.values(pages)[0];
    const ex = pg?.extract || "";
    return sanitizeWikitext(ex).slice(0, 600);
  } catch (e) {
    return "";
  }
}

function sanitizeWikitext(s) {
  return String(s || "")
    .replace(/\(listen\)|\[[0-9]+\]|\((?:listen|help[^)]*)\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchTavily(q, max, key) {
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, query: q, max_results: max, search_depth: "basic" }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error("Tavily " + (d?.error || `HTTP ${r.status}`));
  return (d.results || []).slice(0, max).map(x => ({
    title: x.title, url: x.url, snippet: String(x.content || "").slice(0, 600),
  }));
}

async function searchBing(q, max, key) {
  const r = await fetch(
    `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(q)}&count=${max}`,
    { headers: { "Ocp-Apim-Subscription-Key": key } }
  );
  const d = await r.json();
  if (!r.ok) throw new Error("Bing " + (d?.error?.message || `HTTP ${r.status}`));
  return (d.webPages?.value || []).slice(0, max).map(x => ({
    title: x.name, url: x.url, snippet: String(x.snippet || "").slice(0, 600),
  }));
}

function strip(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .trim();
}

/* Calendar (appointments) stored in KV, namespaced per owner key
   (?key=me is the website, ?key=<LINE userId> is a LINE user).
   GET    /api/calendar?key=me           -> {events:[{id,title,at,time}] , sorted by time}
   GET    /api/calendar?key=me&date=YYYY-MM-DD  -> events on that date
   POST   /api/calendar?key=me {title, date, time?}  -> add (date required, YYYY-MM-DD; time HH:MM optional)
   POST   /api/calendar {delete:id}       -> remove an event by id
   Cap 100 events. */
async function handleCalendar(request, env) {
  const url = new URL(request.url);
  const key = (url.searchParams.get("key") || "").trim() || "me";
  const kvKey = "calendar:" + key;
  try {
    const raw = await env.MEMORY.get(kvKey);
    let events = raw ? JSON.parse(raw).filter(Boolean) : [];

    if (request.method === "GET") {
      const date = (url.searchParams.get("date") || "").trim();
      if (date) events = events.filter(e => e.at === date);
      events = events.sort((a, b) => (a.at + a.time).localeCompare(b.at + b.time)).slice(0, 100);
      return json({ events }, 200);
    }

    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (body.delete) {
        events = events.filter(e => e.id !== String(body.delete));
        await env.MEMORY.put(kvKey, JSON.stringify(events));
        return json({ ok: true, deleted: true, events: events.slice(0, 100) }, 200);
      }
      const title = String(body.title || "").trim();
      const date = String(body.date || "").trim();
      if (!title) return json({ error: "Missing title" }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Missing/invalid date (YYYY-MM-DD)" }, 400);
      const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.time || "").trim()) ? String(body.time).trim() : "09:00";
      const userId = String(body.userId || "").trim();
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      events.push({ id, title, at: date, time, userId: userId || undefined, createdAt: new Date().toISOString() });
      if (events.length > 100) events = events.sort((a, b) => (a.at + a.time).localeCompare(b.at + b.time)).slice(0, 100);
      await env.MEMORY.put(kvKey, JSON.stringify(events));
      if (userId) await rememberCalendarUser(env, userId);
      return json({ ok: true, id, events: events.sort((a, b) => (a.at + a.time).localeCompare(b.at + b.time)).slice(0, 100) }, 200);
    }

    if (request.method === "DELETE") {
      await env.MEMORY.delete(kvKey);
      return json({ ok: true, cleared: true, events: [] }, 200);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}

// Keep an index of LINE users who have calendar events, so the reminder cron
// can enumerate per-user calendars without scanning KV keys.
async function rememberCalendarUser(env, userId) {
  try {
    const raw = await env.MEMORY.get("calendar:users");
    const list = raw ? JSON.parse(raw).filter(Boolean) : [];
    if (!list.includes(userId)) {
      list.push(userId);
      await env.MEMORY.put("calendar:users", JSON.stringify(list.slice(-200)));
    }
  } catch (e) {
    console.error("rememberCalendarUser", e?.message || e);
  }
}

/* Current time/date in Bangkok. Theme: the model has a stale built-in clock,
   so call this whenever the user asks "today/what time/พรุ่งนี้/กี่โมง". */
function handleNow() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("th-TH-u-ca-buddhist", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok",
  }).format(now);
  const iso = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok",
  }).format(now).replace(",", "");
  const weekday = new Intl.DateTimeFormat("th-TH", { weekday: "long", timeZone: "Asia/Bangkok" }).format(now);
  return json({
    greeting: `วัน${weekday} ${fmt}`,
    weekday,
    dateThai: fmt,
    iso,
    weekdayThai: "วัน" + weekday,
    today: true,
  }, 200);
}

/* Notes & todos (namespaced per owner key, ?key=me = website).
   GET  /api/notes?key=me          -> {notes:[{text,created}]}
   POST /api/notes?key=me {text}  -> append (cap 50)
   POST /api/notes {clear} -> wipe all */
async function handleNotes(request, env) {
  const key = (new URL(request.url).searchParams.get("key") || "").trim() || "me";
  const kvKey = "notes:" + key;
  try {
    if (request.method === "GET") {
      const raw = await env.MEMORY.get(kvKey);
      return json({ notes: raw ? JSON.parse(raw).filter(Boolean) : [] }, 200);
    }
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const raw = await env.MEMORY.get(kvKey);
      let notes = raw ? JSON.parse(raw) : [];
      if (body.clear) {
        await env.MEMORY.delete(kvKey);
        return json({ notes: [], cleared: true }, 200);
      }
      const text = String(body.text || "").trim();
      if (!text) return json({ error: "Missing text" }, 400);
      if (text.length > 2000) return json({ error: "Note too long" }, 400);
      notes.push({ text, created: new Date().toISOString() });
      if (notes.length > 50) notes = notes.slice(-50);
      await env.MEMORY.put(kvKey, JSON.stringify(notes));
      return json({ ok: true, notes }, 200);
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}

/* Expense ledger (income = positive, expense = negative) namespaced per owner
   key (?key=me = website, ?key=<LINE userId> = a LINE user).
   GET  /api/expenses?key=me                -> {items:[{id,amount,category,note,date}], total} sorted newest first
   GET  /api/expenses?key=me&date=YYYY-MM-DD -> only that date
   POST /api/expenses?key=me {amount, category?, note?, date?} -> add (YYYY-MM-DD, default today Bangkok)
   POST /api/expenses {delete:id} -> remove one
   Cap 500 items. */
async function handleExpenses(request, env) {
  const url = new URL(request.url);
  const key = (url.searchParams.get("key") || "").trim() || "me";
  const kvKey = "expenses:" + key;
  try {
    const raw = await env.MEMORY.get(kvKey);
    let items = raw ? JSON.parse(raw).filter(Boolean) : [];

    if (request.method === "GET") {
      const date = (url.searchParams.get("date") || "").trim();
      if (date) items = items.filter((i) => i.date === date);
      items = items.slice(0, 500);
      return json({ items, total: items.reduce((s, i) => s + (Number(i.amount) || 0), 0) }, 200);
    }

    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (body.delete) {
        items = items.filter((i) => i.id !== String(body.delete));
        await env.MEMORY.put(kvKey, JSON.stringify(items));
        return json({ ok: true, deleted: true, items }, 200);
      }
      const amount = Number(body.amount);
      if (!isFinite(amount) || amount === 0) return json({ error: "Missing/invalid amount (non-zero number)" }, 400);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "").trim())
        ? String(body.date).trim()
        : new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Bangkok" })
            .format(new Date()).replace(/\//g, "-");
      const category = String(body.category || "").trim().slice(0, 40);
      const note = String(body.note || "").trim().slice(0, 300);
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      items.push({ id, amount, category: category || undefined, note: note || undefined, date, created: new Date().toISOString() });
      items = items.slice(-500);
      await env.MEMORY.put(kvKey, JSON.stringify(items));
      return json({ ok: true, id }, 200);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}

/* Todo list (namespaced per owner key). Items {id,text,done,created}.
   GET  /api/todos?key=me           -> {items:[...]} (undone first, newest first)
   POST /api/todos?key=me {text}                  -> add
   POST /api/todos {toggle:id}                    -> flip done
   POST /api/todos {delete:id}                    -> remove
   POST /api/todos {clear:true}                   -> wipe all
   Cap 200 items. */
async function handleTodos(request, env) {
  const key = (new URL(request.url).searchParams.get("key") || "").trim() || "me";
  const kvKey = "todos:" + key;
  try {
    const raw = await env.MEMORY.get(kvKey);
    let items = raw ? JSON.parse(raw).filter(Boolean) : [];

    if (request.method === "GET") {
      const sorted = [...items].sort((a, b) => (a.done === b.done ? (b.created || "").localeCompare(a.created || "") : a.done ? 1 : -1));
      return json({ items: sorted.slice(0, 200) }, 200);
    }

    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (body.clear) {
        await env.MEMORY.delete(kvKey);
        return json({ ok: true, cleared: true, items: [] }, 200);
      }
      if (body.delete) {
        items = items.filter((i) => i.id !== String(body.delete));
        await env.MEMORY.put(kvKey, JSON.stringify(items));
        return json({ ok: true, deleted: true, items }, 200);
      }
      if (body.toggle) {
        const target = items.find((i) => i.id === String(body.toggle));
        if (!target) return json({ error: "Unknown todo id" }, 404);
        target.done = !target.done;
        await env.MEMORY.put(kvKey, JSON.stringify(items));
        return json({ ok: true, done: target.done, items }, 200);
      }
      const text = String(body.text || "").trim();
      if (!text) return json({ error: "Missing text" }, 400);
      if (text.length > 1000) return json({ error: "Todo too long" }, 400);
      items.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), text, done: false, created: new Date().toISOString() });
      items = items.slice(-200);
      await env.MEMORY.put(kvKey, JSON.stringify(items));
      return json({ ok: true, items }, 200);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}

/* Shopping list (namespaced per owner key). Same shape as todos: {id,text,done}.
   GET  /api/shopping?key=me            -> {items:[...]}
   POST /api/shopping?key=me {text}     -> add
   POST /api/shopping {toggle:id}       -> flip done
   POST /api/shopping {delete:id}       -> remove
   POST /api/shopping {clear:true}      -> wipe all
   Cap 200 items. */
async function handleShopping(request, env) {
  const key = (new URL(request.url).searchParams.get("key") || "").trim() || "me";
  const kvKey = "shopping:" + key;
  try {
    const raw = await env.MEMORY.get(kvKey);
    let items = raw ? JSON.parse(raw).filter(Boolean) : [];

    if (request.method === "GET") {
      const sorted = [...items].sort((a, b) => (a.done === b.done ? (b.created || "").localeCompare(a.created || "") : a.done ? 1 : -1));
      return json({ items: sorted.slice(0, 200) }, 200);
    }

    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (body.clear) {
        await env.MEMORY.delete(kvKey);
        return json({ ok: true, cleared: true, items: [] }, 200);
      }
      if (body.delete) {
        items = items.filter((i) => i.id !== String(body.delete));
        await env.MEMORY.put(kvKey, JSON.stringify(items));
        return json({ ok: true, deleted: true, items }, 200);
      }
      if (body.toggle) {
        const target = items.find((i) => i.id === String(body.toggle));
        if (!target) return json({ error: "Unknown item id" }, 404);
        target.done = !target.done;
        await env.MEMORY.put(kvKey, JSON.stringify(items));
        return json({ ok: true, done: target.done, items }, 200);
      }
      const text = String(body.text || "").trim();
      if (!text) return json({ error: "Missing text" }, 400);
      if (text.length > 1000) return json({ error: "Item too long" }, 400);
      items.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), text, done: false, created: new Date().toISOString() });
      items = items.slice(-200);
      await env.MEMORY.put(kvKey, JSON.stringify(items));
      return json({ ok: true, items }, 200);
    }

    return json({ error: "Method not allowed" }, 405);
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