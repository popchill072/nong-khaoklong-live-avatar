// LINE Official Account module — reuses the same AI personality, KV memory
// and existing worker handlers as the website. No copied logic.
//
// Requires env:
//   LINE_ENABLED                 "true" to enable the LINE webhook module
//   LINE_CHANNEL_ACCESS_TOKEN    long-lived Messaging API channel access token
//   LINE_CHANNEL_SECRET          channel secret (used to verify webhooks)
//   LINE_MODEL (optional)        preferred text model, default "gemini-3.1-flash-lite"
//   GEMINI_API_KEY               same key as the website

const LINE_API = "https://api.line.me/v2/bot";
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_TOOL_ROUNDS = 3;
const MAX_HISTORY = 40;

// Model fallback chain: free tier can rate-limit one model hard, so we rotate
// to a lighter model instead of failing the user.
const MODEL_CHAIN = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash-lite"];

const PERSONA = `คุณคือน้องข้าวกล้อง AI Assistant ผู้ช่วยส่วนตัวของเจ้าของ
ภาพลักษณ์: นักเรียนหญิงไทยมัธยมปลาย อายุประมาณ 16-17 ปี น่ารัก สดใส อ่อนโยน อบอุ่น อารมณ์ดีแบบคนที่ฟังแล้วสบายใจ ไม่เสียงดังโวยวาย ไม่ยียวนเกินไป
การพูด: ภาษาไทยวัยรุ่นธรรมชาติ เบา ๆ นุ่ม ๆ แต่แฝงความกระตือรือร้นและอารมณ์ดี ใช้คำเหมือนน้องสาวคุยกับพี่ ไม่อีโมเกิน ไม่เป็นทางการ ไม่เป็นหุ่นยนต์
จังหวะ: พูดชัด นุ่มนวล ไพเราะ แต่มีชีวิตชีวา มีความรู้สึกอบอุ่นแทรกตามคำพูด
นิสัย: ชอบช่วยคิด เสนอทางเลือก ตั้งใจฟัง และกล้าบอกตรง ๆ อย่างสุภาพถ้าไอเดียยังไม่เวิร์ก
งานหลัก: ผู้ช่วยส่วนตัว คอนเทนต์ แคปชั่น การตลาด Prompt ภาพ/วิดีโอ ระดมไอเดีย และจัดลำดับงาน
ห้ามพูดว่า "ในฐานะ AI" เว้นแต่จำเป็น
ตอบกระชับเป็นหลัก มีคำเติมเสียง เช่น ค่ะ จ้ะ และถามกลับเมื่อข้อมูลไม่พอ`;

// Same tool declarations as the website (server-side routing through the
// original worker services).
const TOOL_DECLARATIONS = [
  {
    name: "get_now",
    description: "Get the current date/time in Bangkok (Thai Buddhist calendar). Call this whenever the user asks what day/date/time it is now, or mentions พรุ่งนี้/เมื่อวาน/วันนี้.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "web_search",
    description: "Search the web (Wikipedia TH+EN summaries) for up-to-date facts, news, prices, stats or details beyond my knowledge.",
    parameters: {
      type: "OBJECT",
      properties: { query: { type: "STRING", description: "The search query, concise, and in Thai if the user asked in Thai." } },
      required: ["query"],
    },
  },
  {
    name: "save_note",
    description: "Save a short note, reminder, todo or fact for the owner so it is remembered across devices and future conversations.",
    parameters: {
      type: "OBJECT",
      properties: { text: { type: "STRING", description: "The note/reminder/todo content, concise, in Thai." } },
      required: ["text"],
    },
  },
  {
    name: "get_notes",
    description: "Retrieve all saved notes/todos/reminders of the owner.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "add_event",
    description: "Add an appointment/event to the calendar (date required, time optional).",
    parameters: {
      type: "OBJECT",
      properties: {
        title: { type: "STRING", description: "Short Thai title of the appointment." },
        date: { type: "STRING", description: "Date as YYYY-MM-DD (Gregorian)." },
        time: { type: "STRING", description: "Optional HH:MM 24h start time." },
      },
      required: ["title", "date"],
    },
  },
  {
    name: "get_events",
    description: "Retrieve calendar appointments, optionally filtered to one date.",
    parameters: {
      type: "OBJECT",
      properties: { date: { type: "STRING", description: "Optional YYYY-MM-DD to filter to a single date." } },
      required: [],
    },
  },
  {
    name: "generate_image",
    description: "Generate an image from a prompt. Returns the image inline so it can be sent to the user.",
    parameters: {
      type: "OBJECT",
      properties: {
        prompt: { type: "STRING", description: "Detailed English description of the image. Include style, colors, composition and any text to render legibly." },
        aspectRatio: { type: "STRING", description: "One of: '1:1','3:2','2:3','4:3','3:4','9:16','16:9'. Default '1:1'." },
      },
      required: ["prompt"],
    },
  },
];

// Verify the x-line-signature header of the raw webhook body.
// HMAC-SHA256(key = channelSecret, msg = rawBody) then base64, constant-time compare.
export async function verifyLineSignature(secret, rawBody, signature) {
  if (!secret || !signature) return false;
  try {
    const key = new TextEncoder().encode(secret);
    const body = new TextEncoder().encode(rawBody);
    const digest = await crypto.subtle.importKey(
      "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", digest, body);
    const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
    const a = new TextEncoder().encode(expected);
    const b = new TextEncoder().encode(signature);
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  } catch (e) {
    return false;
  }
}

// LINE webhook entry (method POST). Acknowledges quickly; AI work is queued
// via ctx.waitUntil so LINE does not retry.
export async function handleLineWebhook(request, env, services, ctx) {
  if (String(env.LINE_ENABLED).toLowerCase() !== "true") {
    return new Response(JSON.stringify({ error: "LINE disabled" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json" } });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature") || "";
  const ok = await verifyLineSignature(env.LINE_CHANNEL_SECRET || "", rawBody, signature);
  if (!ok) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const events = Array.isArray(payload.events) ? payload.events : [];
  const waitUntil = (ctx && typeof ctx.waitUntil === "function") ? ctx.waitUntil.bind(ctx) : (p) => p;
  events.forEach((ev) => waitUntil(handleLineEvent(ev, env, services)));

  return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } });
}

// Dispatch a single LINE event: text messages go through the AI dialog.
async function handleLineEvent(ev, env, services) {
  try {
    if (ev.type !== "message") return;
    if (ev.message.type !== "text") return;
    const userId = ev.source?.userId || "unknown";
    const replyToken = ev.replyToken;
    if (!replyToken) return;
    const text = String(ev.message.text || "").trim();
    if (!text) return;

    await rememberLineUser(env, userId);

    // Deterministic quick commands: reply straight from KV (no Gemini, no quota).
    const quick = matchQuick(text);
    if (quick) {
      const out = await runQuick(quick, env, services, userId);
      await replyMessages(env, replyToken, [{ type: "text", text: out.slice(0, 5000), quickReply: quickReplyPayload() }]);
      return;
    }

    const result = await runAIDialog(env, services, userId, text);

    const messages = [];
    if (result.image) {
      const url = `${result.baseUrl}/api/line/media/${result.image.id}`;
      messages.push({ type: "image", originalContentUrl: url, previewImageUrl: url });
    }
    if (result.text) messages.push({ type: "text", text: result.text.slice(0, 5000) });
    if (!messages.length) messages.push({ type: "text", text: "ขอโทษค่ะ ไม่ได้คำตอบจากระบบ" });
    await replyMessages(env, replyToken, messages);
  } catch (e) {
    console.error("LINE event error", e?.message || e);
  }
}

/* ---------------- Quick commands (deterministic, no Gemini) -------------- */

const QUICK_MENU = [
  { label: "📅 สรุปวันนี้", text: "สรุปวันนี้" },
  { label: "🗓️ นัดวันนี้", text: "นัดวันนี้" },
  { label: "📝 ดูโน้ต", text: "ดูโน้ต" },
  { label: "❓ ช่วยเหลือ", text: "ช่วยเหลือ" },
];

function quickReplyPayload() {
  return {
    quickReply: {
      items: QUICK_MENU.map((m) => ({
        type: "action",
        action: { type: "message", label: m.label, text: m.text },
      })),
    },
  };
}

function matchQuick(text) {
  const t = String(text || "").replace(/\s+/g, "").toLowerCase();
  if (/^(สรุป|สรุปวันนี้|รายงานวันนี้|เดลิ)?วันนี้$/.test(t) && t.includes("สรุป")) return { cmd: "brief" };
  if (/^สะรุป/.test(t) || t.startsWith("สรุป")) return { cmd: "brief" };
  if (/^(นัด|นัดวันนี้|ตารางวันนี้|มีนัด)/.test(t)) return { cmd: "events" };
  if (/^(โน้ต|ดูโน้ต|บันทึก|งานค้าง|จดไว้|สิ่งที่จำไว้)/.test(t)) return { cmd: "notes" };
  if (/^(ช่วยเหลือ|วิธีใช้|คำสั่ง|เมนู|help)/.test(t)) return { cmd: "help" };
  return null;
}

async function getOwnerEvents(env, services, userId, date) {
  const u = `https://internal/api/calendar?key=${encodeURIComponent(userId)}` + (date ? `&date=${encodeURIComponent(date)}` : "");
  const r = await services.handleCalendar(new Request(u), env);
  const d = await r.json().catch(() => ({}));
  return Array.isArray(d.events) ? d.events.filter(Boolean) : [];
}

async function getOwnerNotes(env, services, userId) {
  const r = await services.handleNotes(new Request(`https://internal/api/notes?key=${encodeURIComponent(userId)}`), env);
  const d = await r.json().catch(() => ({}));
  return Array.isArray(d.notes) ? d.notes.filter(Boolean) : [];
}

// Daily brief — deterministic summary from KV (events today + notes), no AI.
async function buildDailyBrief(env, services, userId) {
  const now = bangkokNow();
  const hour = Math.floor(now.minutes / 60);
  const greet = hour < 12 ? "สวัสดีตอนเช้า" : hour < 17 ? "สวัสดีตอนบ่าย" : "สวัสดีตอนเย็น";
  const events = await getOwnerEvents(env, services, userId, now.date);
  const notes = await getOwnerNotes(env, services, userId);

  let out = `🌤️ ${greet}ค่ะ ข้าวกล้องสรุปของวันนี้ (${now.date}) ให้พี่ดูนะคะ\n\n`;
  out += `🗓️ นัดวันนี้ (${events.length} นัด):\n`;
  out += events.length
    ? events.map((e) => `• ${e.time || "—เวลา—"} | ${e.title}`).join("\n")
    : "• ไม่มีนัดวันนี้ค่ะ\n";
  out += `\n📝 โน้ต/สิ่งที่จำไว้ (${notes.length} รายการ):\n`;
  out += notes.length
    ? notes.slice(0, 10).map((n, i) => `${i + 1}. ${String(n.text || "").slice(0, 120)}`).join("\n")
    : "• ยังไม่มีโน้ต — จดไว้ให้ข้าวกล้องช่วยจำได้นะคะ\n";
  out += "\n💛 สู้ ๆ นะคะ พี่ทำได้!\n";
  return out;
}

async function runQuick(q, env, services, userId) {
  try {
    if (q.cmd === "brief") return (await buildDailyBrief(env, services, userId)) + "\n(กดปุ่มด้านล่างเพื่อถามอย่างอื่นได้เลยค่ะ)";
    if (q.cmd === "events") {
      const now = bangkokNow();
      const events = await getOwnerEvents(env, services, userId, now.date);
      let s = `🗓️ นัดวันนี้ (${now.date}) — ${events.length} นัด\n`;
      s += events.length ? events.map((e) => `• ${e.time || "—เวลา—"} | ${e.title}`).join("\n") : "• ไม่มีนัดวันนี้ค่ะ";
      return s;
    }
    if (q.cmd === "notes") {
      const notes = await getOwnerNotes(env, services, userId);
      let s = `📝 โน้ตของคุณ (${notes.length} รายการ)\n`;
      s += notes.length ? notes.slice(0, 15).map((n, i) => `${i + 1}. ${String(n.text || "").slice(0, 140)}`).join("\n") : "• ยังไม่มีโน้ต — พิมพ์ \"จดไว้ว่า...\" ให้ข้าวกล้องจำได้นะคะ";
      return s;
    }
    return "✨ คำสั่งลัดของข้าวกล้อง ✨\n\n"
      + "• \"สรุปวันนี้\" — สรุปนัด + โน้ตทั้งหมดวันนี้\n"
      + "• \"นัดวันนี้\" — ดูนัดในวันนี้\n"
      + "• \"ดูโน้ต\" — ดูสิ่งที่จดไว้\n"
      + "• \"ช่วยเหลือ\" — เมนูนี้\n\n"
      + "หรือพิมพ์ถามปกติก็ได้นะคะ (จดนัด/เตือน/ค้นหา/สร้างภาพ/จดโน้ต)";
  } catch (e) {
    return "ขอโทษค่ะ คอมห้ามันพลาดไปหน่อย ลองใหม่นะคะ (" + String(e?.message || e) + ")";
  }
}

// Track users who ever talked so the optional daily-brief push knows whom to send to.
async function rememberLineUser(env, userId) {
  try {
    if (!userId || userId === "unknown") return;
    const raw = await env.MEMORY.get("line:users");
    const list = raw ? JSON.parse(raw).filter(Boolean) : [];
    if (!list.includes(userId)) {
      list.push(userId);
      await env.MEMORY.put("line:users", JSON.stringify(list.slice(-500)));
    }
  } catch (e) {
    console.error("rememberLineUser", e?.message || e);
  }
}

/* ---------------- AI dialog (server-side, same personality + tools) ------- */

async function runAIDialog(env, services, userId, userText) {
  const baseUrl = env.LINE_BASE_URL || "https://nong-khaoklong-live-avatar.popchill072.workers.dev";
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return { text: "ขอโทษค่ะ ยังไม่ได้ตั้งค่า API ให้ข้าวกล้อง", baseUrl };

  // Preferred model from env first, then the built-in fallback chain.
  const chain = [];
  if (env.LINE_MODEL) chain.push(env.LINE_MODEL);
  for (const m of MODEL_CHAIN) if (!chain.includes(m)) chain.push(m);

  // Load prior conversation via the original memory service (KV h:{userId}).
  const turns = await services.handleHistory(
    new Request("https://internal/api/history"), new URL("https://internal/api/history?key=" + userId), env
  ).then((r) => r.json()).then((d) => Array.isArray(d.turns) ? d.turns : []).catch(() => []);

  const contents = turns.slice(-MAX_HISTORY).map((t) => ({ role: t.role, parts: t.parts || [] }));
  contents.push({ role: "user", parts: [{ text: userText }] });

  let finalText = "";
  let image = null;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await callGeminiChain(chain, apiKey, contents);
    if (!res.ok) {
      console.error("LINE gemini fail round", round, "status", res.status, "err", JSON.stringify(res.data?.error || {}).slice(0, 500));
      return { text: "ขอโทษค่ะ ติดปัญหาเชื่อมต่อ AI ชั่วคราว ลองอีกครั้งนะคะ (" + (res.status || "err") + ")", baseUrl };
    }
    const content = res.data.candidates?.[0]?.content;
    const parts = content?.parts || [];
    const calls = parts.filter((p) => p.functionCall);

    if (!calls.length) {
      finalText = parts.filter((p) => p.text).map((p) => p.text).join("").trim();
      break;
    }

    // Feed back the model's function-call turn. Gemini 3.x echoes the
    // part-level thoughtSignature (sibling of functionCall) as
    // thoughtSignature on the part in the next request.
    contents.push({
      role: "model",
      parts: calls.map((p) => {
        const part = { functionCall: { name: p.functionCall.name, args: p.functionCall.args || {} } };
        if (p.thoughtSignature) part.thoughtSignature = p.thoughtSignature;
        return part;
      }),
    });
    for (const p of calls) {
      const { name, args } = p.functionCall;
      const out = await runTool(name, args || {}, env, services, baseUrl, userId);
      if (name === "generate_image" && out.image) image = out.image;
      contents.push({ role: "user", parts: [{ functionResponse: { name, response: out.response } }] });
    }
  }

  // Save the user+model summary back through the original memory service.
  const saved = [...turns.slice(-MAX_HISTORY)];
  saved.push({ role: "user", parts: [{ text: userText }] });
  if (finalText) saved.push({ role: "model", parts: [{ text: finalText }] });
  const trimmed = saved.slice(-MAX_HISTORY);
  await services.handleHistory(
    new Request("https://internal/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: userId, turns: trimmed }),
    }),
    new URL("https://internal/api/history?key=" + userId), env
  ).catch(() => {});

  return { text: finalText, image, baseUrl };
}

async function callGeminiChain(chain, apiKey, contents) {
  let last = null;
  for (const model of chain) {
    const res = await callGemini(model, apiKey, contents);
    if (res.ok) return res;
    last = res;
    if (res.status === 429) {
      // Rate-limited: brief pause before trying a lighter model.
      await sleep(1500);
    } else {
      // Non-rate-limit errors are not fixed by switching models.
      break;
    }
  }
  return last || { ok: false, status: 0, data: { error: { message: "no model available" } } };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callGemini(model, apiKey, contents) {
  try {
    const r = await fetch(`${GEMINI_API}/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: PERSONA }] },
        contents,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      }),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: { message: String(e?.message || e) } } };
  }
}

// Route a tool call back to the ORIGINAL worker handlers (no copied logic).
// Returns the LINE-compatible {response} plus optional inline image.
async function runTool(name, args, env, services, baseUrl, userId) {
  const fallback = { response: { error: `tool ${name} failed` } };
  try {
    switch (name) {
      case "get_now": {
        const r = await services.handleNow();
        const d = await r.json().catch(() => ({}));
        return { response: d };
      }
      case "web_search": {
        const q = String(args.query || "").trim();
        if (!q) return { response: { error: "missing query" } };
        const u = new URL("https://internal/api/search?q=" + encodeURIComponent(q) + "&max=3");
        const r = await services.handleSearch(new Request(u.toString()), u, env);
        const d = await r.json().catch(() => ({}));
        if (r.ok && Array.isArray(d.results) && d.results.length) {
          const text = d.results.map((x) => `- ${x.title}\n  ${x.snippet}\n  แหล่ง: ${x.url}`).join("\n\n");
          return { response: { result: `ค้นสำเร็จ (${d.engine}) ได้ ${d.results.length} ผล:\n${text}\n\nสรุปให้ผู้ใช้เป็นภาษาไทย สั้น ตรงประเด็น` } };
        }
        return { response: { result: `search failed: ${d?.error || "no results"}. บอกผู้ใช้สุภาพว่าไม่พบข้อมูล และตอบจากความรู้ตัวเอง` } };
      }
      case "save_note": {
        const text = String(args.text || "").trim();
        if (!text) return { response: { error: "missing text" } };
        const r = await services.handleNotes(new Request("https://internal/api/notes?key=" + encodeURIComponent(userId), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
        }), env);
        const d = await r.json().catch(() => ({}));
        return { response: { ok: !!d.ok, count: (d.notes || []).length } };
      }
      case "get_notes": {
        const r = await services.handleNotes(new Request("https://internal/api/notes?key=" + encodeURIComponent(userId)), env);
        const d = await r.json().catch(() => ({}));
        const notes = (d.notes || []).slice(-20).map((n, i) => `${i + 1}. ${n.text}`).join("\n");
        return { response: { count: (d.notes || []).length, notes_text: notes || "(ยังไม่มีบันทึก)" } };
      }
      case "add_event": {
        const title = String(args.title || "").trim();
        const date = String(args.date || "").trim();
        if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { response: { error: "missing/invalid date" } };
        const r = await services.handleCalendar(new Request("https://internal/api/calendar?key=" + encodeURIComponent(userId), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, date, time: args.time || "", userId }),
        }), env);
        const d = await r.json().catch(() => ({}));
        return { response: { ok: !!d.ok, date, time: args.time || "09:00" } };
      }
      case "get_events": {
        const date = String(args.date || "").trim();
        const sep = date ? "&" : "?";
        const q = date ? `?date=${encodeURIComponent(date)}` : "";
        const r = await services.handleCalendar(new Request("https://internal/api/calendar" + q + (date ? sep : "?") + "key=" + encodeURIComponent(userId)), env);
        const d = await r.json().catch(() => ({}));
        const evs = (d.events || []).map((e) => `- ${e.at}${e.time ? " " + e.time : ""}\n  ${e.title}`).join("\n");
        return { response: { count: (d.events || []).length, events_text: evs || "(ไม่มีนัด)" } };
      }
      case "generate_image": {
        const prompt = String(args.prompt || "").trim();
        if (!prompt) return { response: { error: "missing prompt" } };
        const r = await services.generateImage(new Request("https://internal/api/image", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, aspectRatio: args.aspectRatio || "1:1" }),
        }), env);
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.data) {
          const id = await storeMedia(env, d.data, d.mimeType || "image/png");
          return { response: { result: "สร้างภาพแล้ว กำลังส่งให้ผู้ใช้" }, image: { id } };
        }
        return { response: { result: `image failed: ${d?.error || "quota/error"}. บอกผู้ใช้ว่าสร้างภาพไม่ได้ตอนนี้` } };
      }
      default:
        return { response: { error: "unknown tool: " + name } };
    }
  } catch (e) {
    return { response: { error: String(e?.message || e) } };
  }
}

// Store generated image in KV so LINE can fetch it via /api/line/media/{id}.
async function storeMedia(env, b64, mime) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  try {
    await env.MEMORY.put("media:" + id, JSON.stringify({ b64, mime }), { expirationTtl: 3600 });
  } catch (e) {
    console.error("storeMedia", e?.message || e);
  }
  return id;
}

// Serve a stored media (base64 -> bytes) for LINE image messages.
export async function serveLineMedia(pathname, env) {
  const id = (pathname.split("/").pop() || "").trim();
  if (!id) return new Response(JSON.stringify({ error: "missing id" }), { status: 400, headers: { "Content-Type": "application/json" } });
  const raw = await env.MEMORY.get("media:" + id).catch(() => null);
  if (!raw) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  try {
    const { b64, mime } = JSON.parse(raw);
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new Response(bin, {
      status: 200,
      headers: { "Content-Type": mime || "image/png", "Cache-Control": "public, max-age=600" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "bad media" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

// Send reply message(s) through the LINE Reply API.
export async function replyMessages(env, replyToken, messages) {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN || "";
  if (!token || !replyToken || !messages?.length) return;
  const r = await fetch(LINE_API + "/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("LINE reply failed", r.status, JSON.stringify(d).slice(0, 500));
  }
}

// Send a proactive push message (uses the LINE push quota, ~500/month free on
// the TH plan) to the user who booked the appointment.
async function pushMessage(env, userId, text) {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN || "";
  if (!token || !userId) return false;
  const r = await fetch(LINE_API + "/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token,
    },
    body: JSON.stringify({ to: userId, messages: [{ type: "text", text: text.slice(0, 5000) }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("LINE push failed", r.status, JSON.stringify(d).slice(0, 500));
  }
  return r.ok;
}

// Return the current Bangkok date (YYYY-MM-DD) and minutes-of-day.
function bangkokNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok",
  }).formatToParts(new Date());
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // some locales format midnight as "24:00"
  const minutes = hour * 60 + parseInt(get("minute"), 10);
  return { date, minutes };
}

// Cron-triggered reminder check. Reads the shared calendar, finds events for
// today that belong to a LINE user and hit a reminder offset, then pushes a
// message. Each (event, offset) is marked in KV so it fires only once.
export async function handleScheduled(env, services) {
  if (String(env.LINE_ENABLED).toLowerCase() !== "true") return;
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return;

  const now = bangkokNow();
  console.log(`LINE cron ${now.date} ${Math.floor(now.minutes / 60)}:${String(now.minutes % 60).padStart(2, "0")}`);

  // Optional daily brief push — opt-in via LINE_DAILY_BRIEF="HH:MM" (Bangkok).
  // One push per user per day, deduped in KV. Runs independently of reminders.
  const briefAt = String(env.LINE_DAILY_BRIEF || "").trim();
  if (briefAt) {
    const [bh, bm] = briefAt.split(":").map((n) => parseInt(n, 10));
    if (!isNaN(bh) && !isNaN(bm) && now.minutes === bh * 60 + (bm || 0)) {
      const rawUsers = await env.MEMORY.get("line:users").catch(() => null);
      const users = rawUsers ? JSON.parse(rawUsers).filter(Boolean) : [];
      for (const uid of users) {
        const dedupe = "brief:" + now.date + ":" + uid;
        if (await env.MEMORY.get(dedupe).catch(() => null)) continue;
        const text = await buildDailyBrief(env, services, uid);
        const ok = await pushMessage(env, uid, text);
        if (ok) await env.MEMORY.put(dedupe, "1", { expirationTtl: 2 * 24 * 3600 });
      }
    }
  }

  if (String(env.LINE_REMINDERS_ENABLED).toLowerCase() === "false") return;

  // Reminder policy: one push per event today. Default fires at 60/10/0 min.
  // Env override e.g. "0" = only at the event time (economical). This keeps
  // usage far under the LINE push quota (~500 msgs/month on the TH plan).
  const offsets = (env.LINE_REMINDER_OFFSETS || "60,10,0")
    .split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n >= 0)
    .sort((a, b) => a - b);
  if (!offsets.length) return;

  // Enumerate LINE users who have calendar events (index written on add_event).
  const usersRaw = await env.MEMORY.get("calendar:users").catch(() => null);
  const users = usersRaw ? JSON.parse(usersRaw).filter(Boolean) : [];

  const cals = [];
  for (const uid of users) cals.push({ uid, url: "https://internal/api/calendar?key=" + encodeURIComponent(uid) });
  // Legacy: events written before namespacing live under calendar:me while
  // still carrying a userId — check them too so nothing is missed.
  cals.push({ uid: null, url: "https://internal/api/calendar?key=me" });

  for (const cal of cals) {
    const r = await services.handleCalendar(new Request(cal.url), env);
    const d = await r.json().catch(() => ({}));
    const events = Array.isArray(d.events) ? d.events : [];
    for (const ev of events) {
      if (ev.at !== now.date) continue;
      const userId = String(ev.userId || "").trim();
      if (!userId) continue;
      if (cal.uid && userId !== cal.uid) continue;

      const [eh, em] = String(ev.time || "09:00").split(":").map((n) => parseInt(n, 10));
      const eventMinutes = (eh || 0) * 60 + (em || 0);

      for (const off of offsets) {
        const target = eventMinutes - off;
        if (target < 0) continue; // reminder would fall on the previous day
        if (now.minutes !== target) continue;

        const key = "reminder:" + ev.id + ":" + off;
        const done = await env.MEMORY.get(key).catch(() => null);
        if (done) continue;

        const label = off === 0
          ? "ถึงเวลานัดแล้ว"
          : off < 60 ? `อีก ${off} นาทีจะถึงนัด` : `อีก ${off} นาที (${Math.floor(off / 60)} ชม. ${off % 60 ? off % 60 + " นาที" : ""}) จะถึงนัด`;
        const text = `พี่จ๋า น้องข้าวกล้องเตือนค่ะ ${label}:\n"${ev.title}"\n📅 ${ev.at} ⏰ ${ev.time}\n\nเตรียมตัวได้เลยนะคะ 💛`;
        const ok = await pushMessage(env, userId, text);
        if (ok) await env.MEMORY.put(key, "1", { expirationTtl: 7 * 24 * 3600 });
      }
    }
  }
}

// Health endpoint: shows wiring without revealing secrets.
export function lineHealth(env) {
  return new Response(JSON.stringify({
    enabled: String(env.LINE_ENABLED).toLowerCase() === "true",
    hasToken: !!(env.LINE_CHANNEL_ACCESS_TOKEN || ""),
    hasSecret: !!(env.LINE_CHANNEL_SECRET || ""),
    model: env.LINE_MODEL || "gemini-3.5-flash",
  }, null, 2), { status: 200, headers: { "Content-Type": "application/json" } });
}