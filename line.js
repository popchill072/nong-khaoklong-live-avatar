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
  {
    name: "add_expense",
    description: "Record an expense or income to the owner's ledger. Call when the user says they spent/received money, e.g. ซื้อของไป 500, จ่ายค่าโทรศัพท์, ได้เงินเดือน. Income is a positive amount, expense a negative amount (or specify expense with positive amount and category).",
    parameters: {
      type: "OBJECT",
      properties: {
        amount: { type: "NUMBER", description: "Signed number of the money change. Expense = negative (e.g. -500), income = positive (e.g. 15000)." },
        category: { type: "STRING", description: "Optional short Thai category, e.g. อาหาร, เดินทาง, บิล, งานอดิเรก." },
        note: { type: "STRING", description: "Optional short Thai description." },
        date: { type: "STRING", description: "Optional YYYY-MM-DD (Gregorian). Default today." },
      },
      required: ["amount"],
    },
  },
  {
    name: "get_expenses",
    description: "Retrieve the owner's expense/income ledger, optionally filtered to one date. Returns items newest first with total. Call when the user asks about their expenses, income, spending, ยอดใช้จ่าย, รายรับรายจ่าย.",
    parameters: {
      type: "OBJECT",
      properties: { date: { type: "STRING", description: "Optional YYYY-MM-DD to filter to a single day (Gregorian)." } },
      required: [],
    },
  },
  {
    name: "add_todo",
    description: "Add a to-do task to the owner's task list. Call when the user asks to put something on their to-do / task list / งานที่ต้องทำ / รายการที่ต้องทำ.", 
    parameters: {
      type: "OBJECT",
      properties: { text: { type: "STRING", description: "Short Thai description of the task." } },
      required: ["text"],
    },
  },
  {
    name: "list_todos",
    description: "List the owner's to-do tasks (undone first). Call when the user asks what tasks/todos they have, งานค้าง, รายการที่ต้องทำ, ต้องทำอะไรบ้าง.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "toggle_todo",
    description: "Mark a to-do task done/undone. Call when the user says a task is finished/เสร็จแล้ว/ทำแล้ว/เลิกทำ — match by its text, pass the exact todo text. If unclear ask which task.",
    parameters: {
      type: "OBJECT",
      properties: { text: { type: "STRING", description: "Exact text of the task to toggle, as returned by list_todos." } },
      required: ["text"],
    },
  },
  {
    name: "add_shopping",
    description: "Add an item to the owner's shopping list. Call when the user asks to put something on their shopping list / รายการซื้อของ / ต้องซื้อของ / ไปซื้อ.",
    parameters: {
      type: "OBJECT",
      properties: { text: { type: "STRING", description: "Short Thai name of the item to buy." } },
      required: ["text"],
    },
  },
  {
    name: "list_shopping",
    description: "List the owner's shopping list (undone first). Call when the user asks what's on their shopping list / ต้องซื้ออะไร / ของที่จะซื้อ.",
    parameters: { type: "OBJECT", properties: {}, required: [] },
  },
  {
    name: "toggle_shopping",
    description: "Mark a shopping item bought/unbought. Call when the user says they bought an item / ซื้อแล้ว / หามาแล้ว — match by text, pass the exact item text. If unclear ask which item.",
    parameters: {
      type: "OBJECT",
      properties: { text: { type: "STRING", description: "Exact text of the shopping item to toggle, as returned by list_shopping." } },
      required: ["text"],
    },
  },
  {
    name: "translate",
    description: "Translate text into another language. Call when the user asks to translate/แปล as a language / แปลเป็นภาษาอังกฤษ/อังกฤษ/จีน/ญี่ปุ่น ฯลฯ, or asks what something means in another language.",
    parameters: {
      type: "OBJECT",
      properties: {
        text: { type: "STRING", description: "The text to translate." },
        to: { type: "STRING", description: "Target language, e.g. EN, TH, JA, ZH, KO. Default EN." },
      },
      required: ["text"],
    },
  },
  {
    name: "thai_days",
    description: "List Thai important days / Buddhist holidays for a year or what falls on a specific date. Call when the user asks about วันสำคัญ, วันหยุด, วันไหว้พระจันทร์, วันมาฆบูชา/วิสาขบูชา/ออกพรรษา, ฤกษ์, or what day is special.",
    parameters: {
      type: "OBJECT",
      properties: {
        date: { type: "STRING", description: "Optional YYYY-MM-DD (Gregorian) to see what's special on that exact date. Omit to list the current Bangkok year." },
      },
      required: [],
    },
  },
  {
    name: "request_clear",
    description: "FIRST STEP of wiping a category. Call ONLY after the user explicitly asks to delete/wipe/ลบทั้งหมด/ล้างทั้งหมด for one of: notes, todos, shopping, expenses, calendar, history. Returns a confirmation code. Do NOT call clear_store directly.",
    parameters: {
      type: "OBJECT",
      properties: { kind: { type: "STRING", description: "One of: notes, todos, shopping, expenses, calendar, history." } },
      required: ["kind"],
    },
  },
  {
    name: "confirm_clear",
    description: "SECOND STEP of wiping a category. Call ONLY when the user confirms the wipe by repeating the confirmation code from request_clear (e.g. says the code back or says ยืนยัน).",
    parameters: {
      type: "OBJECT",
      properties: { kind: { type: "STRING", description: "Same kind as request_clear." }, code: { type: "STRING", description: "The confirmation code the user repeated." } },
      required: ["kind", "code"],
    },
  },
  {
    name: "report_issue",
    description: "File a report/request to the admin on the user's behalf. Call when the user reports a problem, says the system is broken (ระบบพัง/ใช้งานไม่ได้/บอทไม่ตอบ), wants to contact/urgently reach the admin, or asks to send a message to the admin. Also call when they explicitly say แจ้งปัญหา/แจ้งเรื่อง/ติดต่อแอดมิน.",
    parameters: {
      type: "OBJECT",
      properties: {
        text: { type: "STRING", description: "What the user wants the admin to know, concise Thai." },
        urgent: { type: "BOOLEAN", description: "True if the user says it is urgent/ด่วน/เรื่องร้อน/เร่งด่วน." },
      },
      required: ["text"],
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

    // Log the LINE userId of every sender so the owner can find their own
    // userId (needed for LINE_ADMIN_USER) via `wrangler tail`.
    console.log("LINE msg userId=" + userId);

    await rememberLineUser(env, userId);

    // Owner-only commands: broadcast + view/reply to user reports.
    if (isOwner(env, userId)) {
      const m = text.match(/^(ประกาศ|แจ้งข่าว|announce)[:：]\s*(.+)$/i);
      if (m && m[2].trim()) {
        const r = await publishAnnounce(env, m[2]);
        const msg = r.ok
          ? `✅ บันทึกประกาศ v${r.v} แล้วค่ะ (${r.date})\nระบบจะทยอยส่งให้ผู้ใช้ทุกคนที่เคยคุย (ไม่ซ้ำใครซ้ำเวอร์ชัน) ประมาณ ${ANNOUNCE_BATCH} คน/รอบ cron ผู้ใช้ที่ปิดรับข่าวจะไม่ถูกรบกวน`
          : "⚠️ ยังไม่ได้ประกาศ: " + (r.error || "ข้อความว่างเปล่า");
        await replyMessages(env, replyToken, [{ type: "text", text: msg.slice(0, 5000) }]);
        return;
      }
      // Admin: view reports  -> "ดูเรื่องแจ้ง" / "reports"
      const vr = text.match(/^(ดูเรื่องแจ้ง|ดูเรื่อง|reports?)[:：]?\s*(\d*)$/i);
      if (vr) {
        const limit = parseInt(vr[2] || "10", 10) || 10;
        const out = await listReportsForAdmin(env, Math.min(limit, 50));
        await replyMessages(env, replyToken, [{ type: "text", text: out.slice(0, 5000) }]);
        return;
      }
      // Admin: reply to a ticket -> "ตอบ: R-xxx ข้อความ"
      const rp = text.match(/^(ตอบ|reply)[:：]\s*([A-Za-z0-9-]+)\s+(.+)$/i);
      if (rp) {
        const msg = await adminReply(env, rp[2].toUpperCase(), rp[3]);
        await replyMessages(env, replyToken, [{ type: "text", text: msg.slice(0, 5000) }]);
        return;
      }
    }

    // Report to admin (any user):
    //   "แจ้งปัญหา: <ข้อความ>" -> submit immediately
    //   "แจ้งปัญหา"           -> bot asks, next message becomes the report
    const rpMatch = text.match(/^(แจ้งปัญหา|แจ้งเรื่อง|รายงานปัญหา|แจ้งขัดข้อง|ติดต่อแอดมิน|ติดต่อผู้ดูแล|แจ้งผู้ดูแล|ขอความช่วยเหลือ|แจ้งด่วน|report)[:：]?\s*(.*)$/i);
    if (rpMatch) {
      const content = (rpMatch[2] || "").trim();
      if (content) {
        const urgent = /ด่วน|ร้อน|เร่งด่วน|แย่มาก|ช่วยด่วน|สำคัญมาก|พัง/.test(text);
        const out = await submitReport(env, userId, content, urgent);
        await replyMessages(env, replyToken, [{ type: "text", text: out.slice(0, 5000), quickReply: quickReplyPayload() }]);
        return;
      }
      // No content yet -> start the 2-step flow.
      await env.MEMORY.put("report:pending:" + userId, "1", { expirationTtl: 30 * 60 }).catch(() => {});
      await replyMessages(env, replyToken, [{
        type: "text",
        text: "รับทราบค่ะ 🤗 อยากแจ้งอะไรให้แอดมินทราบ พิมพ์รายละเอียดมาได้เลยค่ะ (พิมพ์ \"ยกเลิก\" ถ้าไม่ต้องการ)",
        quickReply: quickReplyPayload(),
      }]);
      return;
    }

    // 2-step report: the previous "แจ้งปัญหา" asked for details; this message is it.
    const pending = await env.MEMORY.get("report:pending:" + userId).catch(() => null);
    if (pending) {
      await env.MEMORY.delete("report:pending:" + userId).catch(() => {});
      if (/^(ยกเลิก|ลืมไป|ไม่เอาแล้ว|ช่างเถอะ|ลืมแล้ว)$/.test(text)) {
        await replyMessages(env, replyToken, [{ type: "text", text: "ไม่เป็นไรค่ะ ^^", quickReply: quickReplyPayload() }]);
        return;
      }
      const urgent = /ด่วน|ร้อน|เร่งด่วน|แย่มาก|ช่วยด่วน|สำคัญมาก|พัง/.test(text);
      const out = await submitReport(env, userId, text, urgent);
      await replyMessages(env, replyToken, [{ type: "text", text: out.slice(0, 5000), quickReply: quickReplyPayload() }]);
      return;
    }

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
  { label: "✅ งานค้าง", text: "งานค้าง" },
  { label: "🛒 ของค้างซื้อ", text: "ซื้อของ" },
  { label: "💰 ใช้เงินวันนี้", text: "ใช้เงินวันนี้" },
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
  if (/^(โน้ต|ดูโน้ต|บันทึก|จดไว้|สิ่งที่จำไว้)/.test(t)) return { cmd: "notes" };
  if (/^(งานค้าง|ทำอะไรค้าง|รายการที่ต้องทำ)$/.test(t) || t.includes("งานค้าง")) return { cmd: "todos" };
  if (/^(ซื้อของ|ของค้าง|ต้องซื้อ|รายการซื้อ|ช้อปปิ้ง|shopping|ของที่ต้องซื้อ)/.test(t)) return { cmd: "shopping" };
  if (/^(ใช้เงิน|ใช้เงินวันนี้|รายจ่าย|ค่าใช้จ่าย|ใช้จ่าย|รายรับ|expense)/.test(t)) return { cmd: "expenses" };
  if (/^(วันสำคัญ|วันหยุด|ไหว้พระจันทร์|มาฆบูชา|วิสาขบูชา|เข้าพรรษา|ออกพรรษา|อาสาฬหบูชา|ฤกษ์)/.test(t)) return { cmd: "thaidays" };
  if (/^(ปิดข่าว|ปิดประกาศ|หยุดรับข่าว|ไม่รับข่าว|เลิกรับข่าว|unsubscribe)/.test(t)) return { cmd: "announce_off" };
  if (/^(เปิดข่าว|เปิดประกาศ|รับข่าวต่อ|สมัครรับข่าว|subscribe|รับข่าว)/.test(t)) return { cmd: "announce_on" };
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
    if (q.cmd === "todos") return await quickTodos(env, services, userId);
    if (q.cmd === "shopping") return await quickShopping(env, services, userId);
    if (q.cmd === "expenses") return await quickExpenses(env, services, userId);
    if (q.cmd === "thaidays") return await quickThaiDays(env, services, userId);
    if (q.cmd === "announce_off") {
      try { await env.MEMORY.put("announceOff:" + userId, "1", { expirationTtl: 365 * 24 * 3600 }); } catch (e) {}
      return "📴 ปิดรับประกาศแล้วค่ะ — จะไม่รบกวนเรื่องฟีเจอร์ใหม่/ข่าวสารอีก พิมพ์ \"เปิดข่าว\" เมื่อไหร่ก็กลับมารับได้เสมอ";
    }
    if (q.cmd === "announce_on") {
      try { await env.MEMORY.delete("announceOff:" + userId); } catch (e) {}
      return "📣 เปิดรับประกาศแล้วค่ะ — คราวหน้ามีฟีเจอร์ใหม่/ข่าวสารจะแจ้งให้ทราบก่อนใคร";
    }
    return "✨ คำสั่งลัดของข้าวกล้อง ✨\n\n"
      + "• \"สรุปวันนี้\" — สรุปนัด + โน้ตทั้งหมดวันนี้\n"
      + "• \"นัดวันนี้\" — ดูนัดในวันนี้\n"
      + "• \"ดูโน้ต\" — ดูสิ่งที่จดไว้\n"
      + "• \"งานค้าง\" — ดู to-do ที่ยังไม่เสร็จ\n"
      + "• \"ซื้อของ\" — ดูรายการซื้อของ\n"
      + "• \"ใช้เงินวันนี้\" — ดูยอดใช้จ่าย/รายรับวันนี้\n"
      + "• \"วันสำคัญ\" — ดูวันสำคัญ/วันหยุดของปีนี้\n"
      + "• \"แปล...\" — ขอบอกให้แปล (พิมพ์ \"แปลเป็นภาษาอังกฤษว่า ...\")\n"
      + "• \"ปิดข่าว\" / \"เปิดข่าว\" — หยุด / กลับมารับประกาศอัปเดตฟีเจอร์ใหม่\n"
      + "• \"ช่วยเหลือ\" — เมนูนี้\n\n"
      + "หรือพิมพ์ถามปกติก็ได้นะคะ (จดนัด/เตือน/ค้นหา/สร้างภาพ/จดโน้ต/จดรายจ่าย/เพิ่มงาน)";
  } catch (e) {
    return "ขอโทษค่ะ คอมห้ามันพลาดไปหน่อย ลองใหม่นะคะ (" + String(e?.message || e) + ")";
  }
}

async function quickTodos(env, services, userId) {
  const r = await services.handleTodos(new Request("https://internal/api/todos?key=" + encodeURIComponent(userId)), env);
  const d = await r.json().catch(() => ({}));
  const items = d.items || [];
  const undone = items.filter((i) => !i.done);
  let s = `✅ งานของคุณ (${items.length} รายการ — ค้าง ${undone.length})\n`;
  s += undone.length ? undone.map((i) => `• ${String(i.text || "").slice(0, 140)}`).join("\n") : "• ไม่มีงานค้าง ว่าง ๆ ดีใจด้วยค่ะ 🎉";
  return s;
}

async function quickShopping(env, services, userId) {
  const r = await services.handleShopping(new Request("https://internal/api/shopping?key=" + encodeURIComponent(userId)), env);
  const d = await r.json().catch(() => ({}));
  const items = d.items || [];
  const undone = items.filter((i) => !i.done);
  let s = `🛒 รายการซื้อของ (${items.length} — ยังต้องซื้อ ${undone.length})\n`;
  s += undone.length ? undone.map((i) => `• ${String(i.text || "").slice(0, 140)}`).join("\n") : "• ไม่มีของค้างซื้อแล้ว 🛍️";
  return s;
}

async function quickThaiDays(env, services, userId) {
  const r = await services.handleThaiDays(new Request("https://internal/api/thai-days"), env);
  const d = await r.json().catch(() => ({}));
  const days = d.days || [];
  if (!days.length) return `ไม่มีข้อมูลวันสำคัญปี ${d.year || ""} ในตารางค่ะ`;
  return `📅 วันสำคัญ/วันหยุด พ.ศ. ${(Number(d.year) + 543) || ""} (${d.count} วัน)\n\n` + days.map((x) => `• ${x.date} ${x.name}`).join("\n");
}

async function quickExpenses(env, services, userId) {
  const now = bangkokNow();
  const r = await services.handleExpenses(new Request("https://internal/api/expenses?key=" + encodeURIComponent(userId) + "&date=" + now.date), env);
  const d = await r.json().catch(() => ({}));
  const items = d.items || [];
  const total = (Number(d.total) || 0);
  const income = items.filter((i) => (Number(i.amount) || 0) > 0).reduce((s, i) => s + Number(i.amount), 0);
  const spend = items.filter((i) => (Number(i.amount) || 0) < 0).reduce((s, i) => s - Number(i.amount), 0);
  let s = `💰 ยอดของวันนี้ (${now.date})\n• รายรับ +${income.toLocaleString("th-TH")} บาท\n• รายจ่าย -${spend.toLocaleString("th-TH")} บาท\n• สุทธิ ${(income - spend) >= 0 ? "+" : ""}${(income - spend).toLocaleString("th-TH")} บาท\n`;
  s += items.length ? "\nรายการ:\n" + items.map((i) => `• ${i.amount > 0 ? "+" : "−"}${Math.abs(Number(i.amount)).toLocaleString("th-TH")}${i.category ? " [" + i.category + "]" : ""}${i.note ? " " + i.note : ""}`).join("\n") : "\n(ยังไม่มีรายการวันนี้ ลองพิมพ์ \"ซื้อกาแฟไป 120\" ให้ข้าวกล้องจดให้ได้นะคะ)";
  return s;
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

/* --------------- Announcements (owner broadcast to LINE users) ------------ */

const ANNOUNCE_BATCH = 20; // users pushed per cron run (stays cheap + safe)

// Auto-appended footer so users always know the current capabilities.
const ANNOUNCE_FOOTER =
  "💛 พิมพ์ \"ช่วยเหลือ\" เพื่อดูคำสั่งทั้งหมดได้เลยค่ะ\n\n"
  + "✨ ตอนนี้ข้าวกล้องทำได้: จดนัด + เตือนล่วงหน้า / โน้ต / to-do งานค้าง / "
  + "รายการซื้อของ / บันทึกรับ-จ่าย / แปลภาษา / วันสำคัญไทย / ค้นข้อมูลเว็บ / สร้างรูปภาพ / พูดคุยถาม-ตอบ";

// True when the sender is the bot owner (LINE_ADMIN_USER = owner's LINE userId).
function isOwner(env, userId) {
  const o = String(env.LINE_ADMIN_USER || "").trim();
  return !!(o && userId && o === userId);
}

// Publish a new announcement: increments the version so cron broadcasts it to
// every user who hasn't seen that version yet. Returns {ok, v, date}.
export async function publishAnnounce(env, text) {
  const t = String(text || "").trim();
  if (!t) return { ok: false, error: "empty text" };
  const raw = await env.MEMORY.get("announce").catch(() => null);
  const cur = raw ? JSON.parse(raw) : {};
  const v = (Number(cur.v) || 0) + 1;
  const date = bangkokNow().date;
  await env.MEMORY.put("announce", JSON.stringify({ v, date, text: t + "\n\n" + ANNOUNCE_FOOTER }));
  return { ok: true, v, date };
}

// REST endpoint for publishing announcements. Owner-guarded:
//   POST /api/announce {text}  + header `x-announce-key: LINE_ANNOUNCE_KEY`
//   GET  /api/announce         -> current announcement (public, for the web)
export async function handleAnnounce(request, env) {
  const json = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

  if (request.method === "GET") {
    const raw = await env.MEMORY.get("announce").catch(() => null);
    const d = raw ? JSON.parse(raw) : null;
    return json(d || { v: 0 });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const expect = String(env.LINE_ANNOUNCE_KEY || "").trim();
  if (!expect) return json({ error: "Announce disabled (set LINE_ANNOUNCE_KEY)" }, 403);
  const got = String(request.headers.get("x-announce-key") || "").trim();
  if (got !== expect) return json({ error: "Invalid key" }, 401);

  let text = "";
  try {
    text = String((await request.json()).text || "");
  } catch (e) {
    return json({ error: "Bad JSON" }, 400);
  }
  const r = await publishAnnounce(env, text);
  return json(r, r.ok ? 200 : 400);
}

// Cron: push the latest announcement to users who haven't seen it yet. Dedupes
// per (version, user), skips opted-out users, and only sends a few per run so
// the cron stays cheap. Run before the reminders gate so it works even when
// LINE_REMINDERS_ENABLED=false.
export async function broadcastAnnounce(env) {
  const raw = await env.MEMORY.get("announce").catch(() => null);
  if (!raw) return;
  let ann;
  try { ann = JSON.parse(raw); } catch (e) { return; }
  const v = Number(ann.v) || 0;
  if (!v || !String(ann.text || "").trim()) return;

  const usersRaw = await env.MEMORY.get("line:users").catch(() => null);
  const users = usersRaw ? JSON.parse(usersRaw).filter(Boolean) : [];
  let sent = 0;
  for (const uid of users) {
    if (sent >= ANNOUNCE_BATCH) break;
    if (!uid || uid === "unknown") continue;
    if (await env.MEMORY.get("announceOff:" + uid).catch(() => null)) continue;
    const seenKey = "announceSeen:" + v + ":" + uid;
    if (await env.MEMORY.get(seenKey).catch(() => null)) continue;
    const ok = await pushMessage(env, uid, ann.text);
    if (ok) {
      await env.MEMORY.put(seenKey, "1", { expirationTtl: 90 * 24 * 3600 });
      sent++;
    }
  }
}

/* --------------- User reports / contact admin ----------------------------- */

const REPORT_SPAM_PER_HOUR = 3;
const REPORT_URGENT = /ด่วน|ร้อน|เร่งด่วน|แย่มาก|ช่วยด่วน|สำคัญมาก|พัง/;

function bangkokClock() {
  const now = bangkokNow();
  return `${String(Math.floor(now.minutes / 60)).padStart(2, "0")}:${String(now.minutes % 60).padStart(2, "0")}`;
}

// Store a user report, notify the admin (push) and return a confirmation text.
// Dedupes abuse: max REPORT_SPAM_PER_HOUR reports per user (KV TTL window).
export async function submitReport(env, userId, content, urgent) {
  const text = String(content || "").trim();
  if (!text) return "แจ้งเรื่องว่างเปล่านะคะ ลองพิมพ์รายละเอียดใหม่อีกทีค่ะ";
  if (!userId || userId === "unknown") return "ขอโทษค่ะ ไม่สามารถระบุตัวตนผู้แจ้งได้ ลองใหม่นะคะ";

  try {
    // Spam limit: count in a 1-hour window.
    const limitKey = "report:limit:" + userId;
    const count = Number(await env.MEMORY.get(limitKey).catch(() => null)) || 0;
    if (count >= REPORT_SPAM_PER_HOUR) {
      return `ตอนนี้แจ้งเรื่องถึง ${REPORT_SPAM_PER_HOUR} ครั้ง/ชม. แล้วค่ะ ช่วยรออีกสักครู่หรือส่งข้อความคุยกับข้าวกล้องก่อนนะคะ 😊`;
    }
    await env.MEMORY.put(limitKey, String(count + 1), { expirationTtl: 3600 });

    // Ticket id (sequential, short).
    const seq = (Number(await env.MEMORY.get("report:seq").catch(() => null)) || 0) + 1;
    await env.MEMORY.put("report:seq", String(seq));
    const id = "R-" + String(seq).padStart(4, "0");

    const ticket = { id, ts: `${bangkokNow().date} ${bangkokClock()}`, uid: userId, text, urgent: !!urgent };

    // Per-user history (cap 50).
    const userRaw = await env.MEMORY.get("reports:" + userId).catch(() => null);
    const userList = userRaw ? JSON.parse(userRaw).filter(Boolean) : [];
    userList.push(ticket);
    await env.MEMORY.put("reports:" + userId, JSON.stringify(userList.slice(-50)));

    // Global index for the admin (cap 200).
    const allRaw = await env.MEMORY.get("reports:all").catch(() => null);
    const allList = allRaw ? JSON.parse(allRaw).filter(Boolean) : [];
    allList.push(ticket);
    await env.MEMORY.put("reports:all", JSON.stringify(allList.slice(-200)));

    // Notify admin via push (skip if LINE_ADMIN_USER not configured).
    const admin = String(env.LINE_ADMIN_USER || "").trim();
    if (admin && admin !== userId) {
      const badge = urgent ? "🔴 [ด่วน]" : "📥";
      await pushMessage(env, admin,
        `${badge} แจ้งเรื่องใหม่ ${id} ${ticket.ts}\n${text.slice(0, 500)}\n\nดู: พิมพ์ "ดูเรื่องแจ้ง" / ตอบ: พิมพ์ "ตอบ: ${id} ข้อความ"`);
    }

    return urgent
      ? `🚨 รับทราบเรื่องด่วนแล้วค่ะ (${id})\nส่งให้แอดมินทันทีแล้ว รอแอดมินติดต่อกลับนะคะ`
      : `📥 รับทราบแล้วค่ะ (${id})\nส่งเรื่องให้แอดมินแล้ว แอดมินจะรีบจัดการให้ค่ะ`;
  } catch (e) {
    console.error("submitReport", e?.message || e);
    return "ขอโทษค่ะ บันทึกเรื่องไม่สำเร็จ ลองใหม่อีกครั้งนะคะ";
  }
}

// Admin: list the latest reports from the global index.
export async function listReportsForAdmin(env, limit) {
  const allRaw = await env.MEMORY.get("reports:all").catch(() => null);
  const allList = allRaw ? JSON.parse(allRaw).filter(Boolean) : [];
  if (!allList.length) return "ยังไม่มีเรื่องแจ้งเข้ามาค่ะ 📭";
  const rows = allList.slice(-limit).reverse().map((r) =>
    `${r.urgent ? "🔴" : "📥"} ${r.id} ${r.ts}${r.urgent ? " [ด่วน]" : ""}\n  ${String(r.text).slice(0, 120)}`
  );
  return `เรื่องแจ้งล่าสุด (${allList.length} รายการ):\n\n` + rows.join("\n") + "\n\nพิมพ์ \"ตอบ: <id> ข้อความ\" เพื่อตอบกลับผู้แจ้ง";
}

// Admin: push a reply back to the user who filed a given ticket.
export async function adminReply(env, id, msg) {
  const allRaw = await env.MEMORY.get("reports:all").catch(() => null);
  const allList = allRaw ? JSON.parse(allRaw).filter(Boolean) : [];
  const ticket = allList.find((r) => String(r.id).toUpperCase() === String(id).toUpperCase());
  if (!ticket) return `ไม่เจอเรื่อง ${id} ในระบบค่ะ (ดูด้วย "ดูเรื่องแจ้ง")`;
  const admin = String(env.LINE_ADMIN_USER || "").trim();
  if (!admin) return "ยังไม่ได้ตั้ง LINE_ADMIN_USER ไว้ค่ะ";
  const ok = await pushMessage(env, ticket.uid, `📨 แอดมินตอบกลับเรื่อง ${ticket.id}:\n${String(msg).slice(0, 500)}`);
  return ok
    ? `✅ ส่งคำตอบ ${ticket.id} กลับให้ผู้แจ้งแล้วค่ะ`
    : "⚠️ ส่งคำตอบไม่สำเร็จ (push ผิดพลาด) — ดู log ได้เลยค่ะ";
}

// REST: GET /api/reports?limit=10 (admin only, guarded by LINE_ANNOUNCE_KEY).
export async function handleReports(request, env) {
  const json = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const expect = String(env.LINE_ANNOUNCE_KEY || "").trim();
  const got = String(request.headers.get("x-announce-key") || "").trim();
  if (!expect || got !== expect) return json({ error: "Invalid key" }, 401);
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 100);
  const allRaw = await env.MEMORY.get("reports:all").catch(() => null);
  const allList = allRaw ? JSON.parse(allRaw).filter(Boolean) : [];
  return json({ count: allList.length, reports: allList.slice(-limit).reverse() }, 200);
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

  // Inject today's Bangkok date (Buddhist year) into the system prompt on every
  // request so the model never answers with a stale/guessed date or year.
  const systemNote = "ข้อมูลวัน/เวลาปัจจุบัน (เวลาไทย): " + bangkokNowText()
    + " — ใช้ค่านี้เป็นหลักเมื่อตอบเรื่องวัน/เวลา/พรุ่งนี้/เมื่อวาน/ปี อย่าเดาจากความจำตัวเอง";

  const contents = turns.slice(-MAX_HISTORY).map((t) => ({ role: t.role, parts: t.parts || [] }));
  contents.push({ role: "user", parts: [{ text: userText }] });

  let finalText = "";
  let image = null;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await callGeminiChain(chain, apiKey, contents, systemNote);
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

async function callGeminiChain(chain, apiKey, contents, systemNote) {
  let last = null;
  for (const model of chain) {
    const res = await callGemini(model, apiKey, contents, systemNote);
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

async function callGemini(model, apiKey, contents, systemNote) {
  try {
    const r = await fetch(`${GEMINI_API}/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: PERSONA + (systemNote ? "\n\n" + systemNote : "") }] },
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
      case "add_expense": {
        const amount = Number(args.amount);
        if (!isFinite(amount) || amount === 0) return { response: { error: "invalid amount" } };
        const r = await services.handleExpenses(new Request("https://internal/api/expenses?key=" + encodeURIComponent(userId), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount, category: args.category || "", note: args.note || "", date: args.date || "" }),
        }), env);
        const d = await r.json().catch(() => ({}));
        if (!d.ok) return { response: { error: d?.error || "add failed" } };
        return { response: { ok: true, saved: amount, category: args.category || "", date: args.date || "today", text: "บันทึกรายการแล้ว" } };
      }
      case "get_expenses": {
        const date = String(args.date || "").trim();
        const q = "https://internal/api/expenses?key=" + encodeURIComponent(userId) + (date ? "&date=" + encodeURIComponent(date) : "");
        const r = await services.handleExpenses(new Request(q), env);
        const d = await r.json().catch(() => ({}));
        const items = d.items || [];
        const total = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
        const text = items.length
          ? items.slice(0, 30).map((i) => `${i.date} ${i.amount > 0 ? "+" : ""}${i.amount}${i.category ? " [" + i.category + "]" : ""}${i.note ? " " + i.note : ""}`).join("\n")
          : "(ยังไม่มีรายการ)" + (date ? ` เมื่อ ${date}` : "");
        return { response: { count: items.length, total, entries_text: text } };
      }
      case "add_todo": {
        const text = String(args.text || "").trim();
        if (!text) return { response: { error: "missing text" } };
        const r = await services.handleTodos(new Request("https://internal/api/todos?key=" + encodeURIComponent(userId), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
        }), env);
        const d = await r.json().catch(() => ({}));
        return { response: { ok: !!d.ok, count: (d.items || []).length, text: "เพิ่มงานแล้ว" } };
      }
      case "list_todos": {
        const r = await services.handleTodos(new Request("https://internal/api/todos?key=" + encodeURIComponent(userId)), env);
        const d = await r.json().catch(() => ({}));
        const items = d.items || [];
        const undone = items.filter((i) => !i.done).map((i, n) => `${n + 1}. ${i.text}`).join("\n");
        const doneCount = items.filter((i) => i.done).length;
        return { response: { count: items.length, done: doneCount, undone_text: undone || "(ไม่มีงานค้าง — ว่าง ๆ ดีใจด้วยนะคะ)" } };
      }
      case "toggle_todo": {
        const text = String(args.text || "").trim();
        if (!text) return { response: { error: "missing text" } };
        const r0 = await services.handleTodos(new Request("https://internal/api/todos?key=" + encodeURIComponent(userId)), env);
        const d0 = await r0.json().catch(() => ({}));
        const match = (d0.items || []).find((i) => i.text === text) || (d0.items || []).find((i) => String(i.text).includes(text));
        if (!match) return { response: { error: "ไม่เจองานในรายการ: " + text } };
        const r = await services.handleTodos(new Request("https://internal/api/todos?key=" + encodeURIComponent(userId), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ toggle: match.id }),
        }), env);
        const d = await r.json().catch(() => ({}));
        return { response: { ok: !!d.ok, text, done: !!d.done, result: `งาน "${text}" ${d.done ? "เสร็จแล้วค่ะ 🎉" : "กลับมาเป็นยังไม่เสร็จ"}` } };
      }
      case "add_shopping": {
        const text = String(args.text || "").trim();
        if (!text) return { response: { error: "missing text" } };
        const r = await services.handleShopping(new Request("https://internal/api/shopping?key=" + encodeURIComponent(userId), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
        }), env);
        const d = await r.json().catch(() => ({}));
        return { response: { ok: !!d.ok, count: (d.items || []).length, text: "เพิ่มในรายการซื้อของแล้ว" } };
      }
      case "list_shopping": {
        const r = await services.handleShopping(new Request("https://internal/api/shopping?key=" + encodeURIComponent(userId)), env);
        const d = await r.json().catch(() => ({}));
        const items = d.items || [];
        const undone = items.filter((i) => !i.done).map((i, n) => `${n + 1}. ${i.text}`).join("\n");
        const doneCount = items.filter((i) => i.done).length;
        return { response: { count: items.length, bought: doneCount, undone_text: undone || "(ไม่มีของค้างซื้อ)" } };
      }
      case "toggle_shopping": {
        const text = String(args.text || "").trim();
        if (!text) return { response: { error: "missing text" } };
        const r0 = await services.handleShopping(new Request("https://internal/api/shopping?key=" + encodeURIComponent(userId)), env);
        const d0 = await r0.json().catch(() => ({}));
        const match = (d0.items || []).find((i) => i.text === text) || (d0.items || []).find((i) => String(i.text).includes(text));
        if (!match) return { response: { error: "ไม่เจอของในรายการ: " + text } };
        const r = await services.handleShopping(new Request("https://internal/api/shopping?key=" + encodeURIComponent(userId), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ toggle: match.id }),
        }), env);
        const d = await r.json().catch(() => ({}));
        return { response: { ok: !!d.ok, text, done: !!d.done, result: `ของ "${text}" ${d.done ? "ซื้อแล้ว ✅" : "กลับมาเป็นยังไม่ซื้อ"}` } };
      }
      case "translate": {
        const text = String(args.text || "").trim();
        if (!text) return { response: { error: "missing text" } };
        const to = String(args.to || "EN").trim();
        const r = await services.handleTranslate(new Request("https://internal/api/translate?text=" + encodeURIComponent(text) + "&to=" + encodeURIComponent(to)), env);
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.ok) return { response: { translated: d.text, to, result: "ส่งผลลัพธ์ที่แปลแล้วให้ผู้ใช้" } };
        return { response: { result: `translate failed: ${d?.error || "quota/error"}. บอกผู้ใช้ว่าแปลไม่ได้ตอนนี้` } };
      }
      case "thai_days": {
        const date = String(args.date || "").trim();
        const q = "https://internal/api/thai-days" + (date ? "?date=" + encodeURIComponent(date) : "");
        const r = await services.handleThaiDays(new Request(q), env);
        const d = await r.json().catch(() => ({}));
        if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
          const hit = d.day || [];
          return { response: { date, result: hit.length ? `วัน ${date} ตรงกับ: ${hit.map((x) => x.name).join(", ")}` : `วันที่ ${date} ไม่มีวันสำคัญในตาราง (ตรวจสอบแล้ว)` } };
        }
        const days = d.days || [];
        if (!days.length) return { response: { result: `ไม่มีข้อมูลวันสำคัญสำหรับปี ${d.year || ""} ในตาราง` } };
        const text = days.map((x) => `- ${x.date} ${x.name}`).join("\n");
        return { response: { year: d.year, count: days.length, days_text: text } };
      }
      case "request_clear": {
        const kind = String(args.kind || "").trim();
        if (!kind) return { response: { error: "missing kind (notes|todos|shopping|expenses|calendar|history)" } };
        const r = await services.handleClear(new Request("https://internal/api/clear?key=" + encodeURIComponent(userId), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }),
        }), env);
        const d = await r.json().catch(() => ({}));
        if (!d.pending) return { response: { error: d?.error || "request failed" } };
        return { response: { kind: d.kind, code: d.code, result: `เพื่อความปลอดภัย ต้องยืนยันก่อนลบ ${d.kind} ทั้งหมด — พิมพ์รหัสยืนยัน ${d.code} เพื่อยืนยันการลบ (หรือพิมพ์ "ยกเลิก" ได้เลย)` } };
      }
      case "confirm_clear": {
        const kind = String(args.kind || "").trim();
        const code = String(args.code || "").trim();
        if (!kind || !code) return { response: { error: "missing kind or code" } };
        const r = await services.handleClear(new Request("https://internal/api/clear?key=" + encodeURIComponent(userId), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, code }),
        }), env);
        const d = await r.json().catch(() => ({}));
        if (!d.ok) return { response: { error: d?.error || "invalid code", result: "รหัสยืนยันไม่ถูกต้องหรือหมดอายุ — เริ่มคำสั่งลบใหม่เพื่อขอรหัสใหม่" } };
        return { response: { ok: true, wiped: d.wiped, result: `ลบ ${d.wiped} ทั้งหมดเรียบร้อยแล้วค่ะ` } };
      }
      case "report_issue": {
        const text = String(args.text || "").trim();
        if (!text) return { response: { error: "missing text" } };
        const urgent = !!args.urgent;
        const out = await submitReport(env, userId, text, urgent);
        return { response: { result: out } };
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

// Friendly "now" string in Thai + Buddhist year, e.g.
// "วันอังคารที่ 18 สิงหาคม 2569 เวลา 10:19 (2026-08-18)". Injected into the
// system prompt each request so the model never guesses a stale date/year.
function bangkokNowText() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("th-TH-u-ca-buddhist", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok",
  }).format(now);
  const iso = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Bangkok",
  }).format(now);
  return `${fmt} (วันที่แบบสากล ${iso})`;
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

  // Announcement broadcast — owner publishes via "ประกาศ: <ข้อความ>" (LINE) or
  // POST /api/announce; cron pushes to each active user once per version.
  await broadcastAnnounce(env);

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