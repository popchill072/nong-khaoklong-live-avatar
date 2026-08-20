// Cloudflare Worker — serves static assets + mints ephemeral Gemini token.
// Static files live in ./public (wrangler.toml -> assets.directory).

import {
  handleLineWebhook,
  lineHealth,
  serveLineMedia,
  handleScheduled,
  handleAnnounce,
  handleReports,
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
  handleTranslate,
  handleThaiDays,
  handleClear,
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

    // Translation: GET /api/translate?text=...&to=EN|TH (Gemini text, free)
    if (url.pathname === "/api/translate") {
      return handleTranslate(request, env);
    }

    // Thai important days / Buddhist holidays: GET /api/thai-days (deterministic static)
    if (url.pathname === "/api/thai-days") {
      return handleThaiDays(request, env);
    }

    // Confirmed destructive actions: POST /api/clear {kind, code?} -> two-step wipe
    if (url.pathname === "/api/clear") {
      return handleClear(request, env);
    }

    // Owner broadcast announcement: GET /api/announce (read) or
    // POST /api/announce {text} + `x-announce-key` header (publish).
    if (url.pathname === "/api/announce") {
      return handleAnnounce(request, env);
    }

    // Admin: list user reports. GET /api/reports + `x-announce-key` header.
    if (url.pathname === "/api/reports") {
      return handleReports(request, env);
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
      if (String((await request.json().catch(() => ({}))).confirm) !== "true") {
        return json({ error: "Destructive: send {confirm:\"true\"} to wipe calendar" }, 400);
      }
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
  // th-TH weekday already includes "วัน" ("วันอังคาร"); strip it for fields
  // that re-add the prefix, so we never produce "วันวันอังคาร".
  const weekdayLong = new Intl.DateTimeFormat("th-TH", { weekday: "long", timeZone: "Asia/Bangkok" }).format(now);
  const weekday = weekdayLong.replace(/^วัน/, ""); // "อังคาร"
  const fmt = new Intl.DateTimeFormat("th-TH-u-ca-buddhist", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok",
  }).format(now);
  const iso = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok",
  }).format(now).replace(",", "");
  const yearBE = Number(new Intl.DateTimeFormat("th-TH-u-ca-buddhist", { year: "numeric", timeZone: "Asia/Bangkok" }).format(now).replace(/[^\d]/g, ""));
  return json({
    greeting: fmt,
    weekday, // "อังคาร"
    weekdayThai: "วัน" + weekday, // "วันอังคาร"
    dateThai: fmt, // "วันอังคารที่ 18 สิงหาคม 2569 เวลา 10:19"
    date: iso.slice(0, 10), // "2026-08-18"
    yearBE, // 2569 (Buddhist era — Thai calendar)
    iso,
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
        if (String(body.confirm) !== "true") return json({ error: "Destructive: send {clear:true, confirm:\"true\"}" }, 400);
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
        if (String(body.confirm) !== "true") return json({ error: "Destructive: send {clear:true, confirm:\"true\"}" }, 400);
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
        if (String(body.confirm) !== "true") return json({ error: "Destructive: send {clear:true, confirm:\"true\"}" }, 400);
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

/* Thai important days — deterministic static table (verified against official
   sources Oct 2026). Lunar Buddhist dates differ every year, so this is a
   curated per-year list, not a calendar calculation. Add new years by
   extending THAI_DAYS. */
const THAI_DAYS = {
  "2026": [
    { date: "2026-01-01", name: "วันขึ้นปีใหม่", type: "holiday" },
    { date: "2026-01-02", name: "วันหยุดพิเศษ (เพิ่มกรณีพิเศษ)", type: "holiday" },
    { date: "2026-03-03", name: "วันมาฆบูชา", type: "buddhist" },
    { date: "2026-04-06", name: "วันจักรี", type: "holiday" },
    { date: "2026-04-13", name: "วันสงกรานต์ (วันผู้สูงอายุ)", type: "festival" },
    { date: "2026-04-14", name: "วันสงกรานต์ (วันครอบครัว)", type: "festival" },
    { date: "2026-04-15", name: "วันสงกรานต์ (วันเถลิงศก)", type: "festival" },
    { date: "2026-05-01", name: "วันแรงงานแห่งชาติ", type: "holiday" },
    { date: "2026-05-04", name: "วันฉัตรมงคล", type: "holiday" },
    { date: "2026-05-13", name: "วันพืชมงคลจรดพระนังคัลแรกนาขวัญ", type: "ceremony" },
    { date: "2026-05-31", name: "วันวิสาขบูชา", type: "buddhist" },
    { date: "2026-06-01", name: "ชดเชยวันวิสาขบูชา", type: "holiday" },
    { date: "2026-06-03", name: "วันเฉลิมพระชนมพรรษา สมเด็จพระนางเจ้าสุทิดา พัชรสุธาพิมลลักษณ พระบรมราชินี", type: "royal" },
    { date: "2026-06-08", name: "วันอัฏฐมีบูชา", type: "buddhist" },
    { date: "2026-07-28", name: "วันเฉลิมพระชนมพรรษา พระบาทสมเด็จพระเจ้าอยู่หัว", type: "royal" },
    { date: "2026-07-29", name: "วันอาสาฬหบูชา", type: "buddhist" },
    { date: "2026-07-30", name: "วันเข้าพรรษา", type: "buddhist" },
    { date: "2026-08-12", name: "วันแม่แห่งชาติ", type: "royal" },
    { date: "2026-09-25", name: "วันไหว้พระจันทร์ (เทศกาลไหว้พระจันทร์)", type: "festival" },
    { date: "2026-10-13", name: "วันนวมินทรมหาราช", type: "royal" },
    { date: "2026-10-23", name: "วันปิยมหาราช", type: "holiday" },
    { date: "2026-10-26", name: "วันออกพรรษา", type: "buddhist" },
    { date: "2026-12-05", name: "วันพ่อแห่งชาติ / วันชาติ และวันคล้ายวันพระบรมราชสมภพ รัชกาลที่ 9", type: "royal" },
    { date: "2026-12-07", name: "ชดเชยวันพ่อแห่งชาติ", type: "holiday" },
    { date: "2026-12-10", name: "วันรัฐธรรมนูญ", type: "holiday" },
    { date: "2026-12-31", name: "วันสิ้นปี", type: "holiday" },
  ],
};

// Thai important days / Buddhist holidays (deterministic from static table).
// GET /api/thai-days            -> { year, days } for the current Bangkok year
// GET /api/thai-days?date=YYYY-MM-DD -> what's special on that date
async function handleThaiDays(request, env) {
  const url = new URL(request.url);
  const now = new Date();
  const yy = new Intl.DateTimeFormat("en-CA", { year: "numeric", timeZone: "Asia/Bangkok" }).format(now);
  const date = (url.searchParams.get("date") || "").trim();
  const year = /^\d{4}$/.test(date.slice(0, 4)) ? date.slice(0, 4) : yy;
  const days = THAI_DAYS[year] || [];
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const hit = days.filter((d) => d.date === date);
    return json({ date, year, day: hit }, 200);
  }
  return json({ year, count: days.length, days }, 200);
}

// Check in to see which important Thai days fall in window [windowStart, windowStart+range) days.
// Used by quick "วันสำคัญ" to show today + next 14 days mostly. Not exported separately;
// quickAnswer reads /api/thai-days and filters client-side.

/* Translation using the free Gemini text model (no tooling, no quota on Gemini
   Live). Two-step confirm path lives in /api/clear; this is the real translate.
   GET /api/translate?text=...&to=EN|TH|JA|... (target language code or name)
   Uses the same API key as the image generator. */
async function handleTranslate(request, env) {
  const url = new URL(request.url);
  const text = (url.searchParams.get("text") || "").trim();
  const to = (url.searchParams.get("to") || "EN").trim();
  const apiKey = env.GEMINI_API_KEY;
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (!apiKey) return json({ error: "Missing GEMINI_API_KEY secret" }, 500);
  if (!text) return json({ error: "Missing text" }, 400);
  if (text.length > 2000) return json({ error: "Text too long" }, 400);

  const wanted = env.LINE_MODEL || "gemini-3.5-flash";
  const candidates = [wanted, "gemini-3.1-flash-lite", "gemini-2.0-flash-lite"];
  const seen = new Set();
  for (const model of candidates) {
    if (seen.has(model)) continue;
    seen.add(model);
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `แปลข้อความต่อไปนี้เป็นภาษา ${to} ส่งเฉพาะผลลัพธ์ที่แปลแล้ว ไม่มีคำอธิบายเพิ่มเติม:\n\n${text}` }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 1000 },
          }),
        }
      );
      const d = await r.json();
      if (!r.ok) continue;
      const out = d?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
      if (out) return json({ ok: true, from: "auto", to, text: out.slice(0, 2000) }, 200);
    } catch (e) {
      continue;
    }
  }
  return json({ error: "Translation failed (model unavailable)" }, 429);
}

/* Two-step destructive action confirmation (protects against accidental wipes).
   POST /api/clear {kind:"notes"|"todos"|"shopping"|"expenses"|"calendar"|"history", code?}
   Step 1 (no code): creates a KV token TTL 15min, returns {pending:true, kind, code}.
   Step 2 (with code): verifies token, wipes that per-user store, deletes token. */
const CLEAR_KINDS = ["notes", "todos", "shopping", "expenses", "calendar", "history"];
async function handleClear(request, env) {
  const url = new URL(request.url);
  const key = (url.searchParams.get("key") || "").trim() || "me";
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await request.json().catch(() => ({}));
  const kind = String(body.kind || "").trim();
  if (!CLEAR_KINDS.includes(kind)) return json({ error: "Unknown kind: " + kind }, 400);

  const code = String(body.code || "").trim();
  const tokenKey = "pendingclear:" + key + ":" + kind;
  if (!code) {
    const newCode = Math.random().toString(36).slice(2, 8);
    await env.MEMORY.put(tokenKey, newCode, { expirationTtl: 15 * 60 });
    return json({ pending: true, kind, code: newCode }, 200);
  }

  const stored = await env.MEMORY.get(tokenKey).catch(() => null);
  if (!stored || stored !== code) return json({ error: "Code not valid or expired" }, 403);

  const kvKey = kind === "history" ? "h:" + key : kind + ":" + key;
  await env.MEMORY.delete(kvKey);
  await env.MEMORY.delete(tokenKey);
  return json({ ok: true, wiped: kind }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}