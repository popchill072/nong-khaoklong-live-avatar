# น้องข้าวกล้อง AI Assistant V3 — Live Avatar + LINE Official Account

ผู้ช่วย AI ตัวเป็นภาพเคลื่อนไหว "น้องข้าวกล้อง" ที่คุยกับเจ้าของได้ทั้งบนเว็บ (เสียง/ข้อความ Live) และผ่าน LINE Official Account (ข้อความ)

V3 ต่อยอดจาก Prototype/V2:
- Gemini Live สำหรับคุยเสียงต่อเสียงแบบเรียลไทม์ (bidiGenerateContent)
- ภาษาไทย + persona "น้องข้าวกล้อง"
- รองรับการพูดแทรก (interrupt) และ semantic VAD
- Avatar ภาพ + crossfade video อารมณ์ (happy/sad/excited/surprised/thinking/love/angry/sleepy/embarrassed/bye)
- PWA: ติดตั้งเป็นแอปที่หน้า Home ได้ (โลโก้ + icons + manifest)
- API key อยู่ฝั่ง server (browser ได้แค่ ephemeral token)
- Tools: web_search, get_now, save_note / get_notes, add_event / get_events, generate_image, set_emotion
- Memory ระหว่างเครื่องผ่าน KV (Cloudflare) — จำได้ทุก device
- LINE Official Account bot (webhook + signature verify + AI + memory แยกผู้ใช้)

## เทคโนโลยี
- Cloudflare Worker (ES modules) + KV namespace `MEMORY`
- Gemini Live API (WebSocket) บนเว็บ, Gemini generateContent บน LINE
- LINE Messaging API (Reply API)
- Static: `public/` ถูกเสิร์ฟโดย Cloudflare Assets

---

## วิธีติดตั้ง (บน Cloudflare)

1. ติดตั้ง Node.js 20+
2. `npm install`
3. คัดลอก `.env.example` เป็น `.env` (ใช้ใน local dev ผ่าน `wrangler dev`; ตัวจริงตั้งเป็น secret ใน Cloudflare)
4. สร้าง Worker บน Cloudflare และตั้งตัวแปร (Settings → Variables and Secrets):

| Variable | ค่า |
|---|---|
| `GEMINI_API_KEY` | API key จาก https://aistudio.google.com (ฟรี) |
| `GEMINI_MODEL` *(optional)* | `gemini-3.1-flash-live-preview` (ค่าเริ่มต้นฝั่งเว็บ) |
| `GEMINI_VOICE` *(optional)* | เช่น `Leda` / `Aoede` / `Kore` |

5. สร้าง KV namespace และผูกเป็น `MEMORY` (ดู `wrangler.toml`)
6. Deploy: `npx wrangler deploy`
7. เปิด `https://<worker>.workers.dev`

### ทดสอบเว็บ
- เปิด URL → กด "เริ่มคุย" → อนุญาตไมโครโฟน → พูดกับข้าวกล้อง

---

## การตั้งค่า LINE Official Account

LINE bot จะทำงานเมื่อตั้งตัวแปร LINE ให้ครบเท่านั้น (ถ้าไม่ได้ตั้ง LINE_ENABLED=true โมดูลจะปิดอยู่ เว็บยังใช้ได้ปกติ)

### ขั้นตอน

1. เปิด [LINE Developers Console](https://developers.line.biz/) → สร้าง Provider → สร้าง Channel แบบ ** Messaging API**
2. ในหน้า Messaging API ตั้งค่า:
   - **Webhook URL**: `https://<worker>.workers.dev/api/line/webhook`
   - เปิด **Use webhook** (on)
   - (optional) เปิด Auto-reply / Greeting off เพื่อไม่ให้ขัดกับ bot ตัวเอง
3. ตั้งค่า secret/token ใน Cloudflare Worker (Settings → Variables and Secrets):

| Variable | ค่า | จำเป็น? |
|---|---|---|
| `LINE_ENABLED` | `true` | ✅ (ปิด-เปิดโมดูล LINE ทั้งหมด) |
| `LINE_CHANNEL_SECRET` | Channel secret จาก LINE Dev Console | ✅ |
| `LINE_CHANNEL_ACCESS_TOKEN` | Channel access token (กดปุ่ม **Issue** ใน Messaging API) | ✅ |
| `LINE_MODEL` *(optional)* | โมเดลข้อความที่ใช้ตอบ LINE เช่น `gemini-3.5-flash` (ค่าเริ่มต้น) | — |
| `LINE_BASE_URL` *(optional)* | URL ของ worker ถ้าต่างจาก default (ใช้ตอนส่งรูปจาก generate_image) | — |
| `LINE_REMINDERS_ENABLED` *(optional)* | `true` (ค่าเริ่มต้น) เปิดการแจ้งเตือนเชิงรุกจากนัดหมาย; `false` = ปิด | — |
| `LINE_REMINDER_OFFSETS` *(optional)* | ช่วงเตือนล่วงหน้า (นาที, คั่นคอมม่า) เช่น `60,10,0` (ค่าเริ่มต้น) — 0 = ตอนถึงเวลา; ยิ่งน้อยรอบยิ่งประหยัด push quota | — |
| `LINE_DAILY_BRIEF` *(optional)* | เวลาสรุปวันนี้แบบอัตโนมัติ (เวลาไทย HH:MM) เช่น `08:00` — push สรุปนัด+โน้ตให้ผู้ใช้ทุกคนที่เคยคุย 1 ครั้ง/คน/วัน (ไม่ตั้ง = ปิด) | — |

> ใช้คำสั่งได้ถ้าไม่สะดวกกด dashboard:
> ```
> npx wrangler secret put LINE_ENABLED       (พิมพ์ true)
> npx wrangler secret put LINE_CHANNEL_SECRET
> npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
> ```

4. Deploy อีกครั้ง: `npx wrangler deploy`
5. เปิด LINE → เพิ่ม LINE Official Account (Channel) เป็นเพื่อน → พิมพ์ข้อความ

### ทดสอบ LINE
- ส่งข้อความ "สวัสดี" → ควรได้เสียงของข้าวกล้องตอบ
- "ตอนนี้กี่โมง" → ตอบเวลาจริง (เรียก tool get_now)
- "จดไว้ว่าพรุ่งนี้ซื้อของ" → บันทึก notes
- "พรุ่งนี้มีนัดอะไร" → เช็ค calendar
- **คำสั่งลัด** (ตอบจาก KV ทันที ไม่เปลือง Gemini/WS): "สรุปวันนี้" / "นัดวันนี้" / "ดูโน้ต" / "งานค้าง" / "ซื้อของ" / "ใช้เงินวันนี้" / "ช่วยเหลือ" — มีปุ่ม Quick Reply เด้งให้กดด้วย (มีบนเว็บ "📋 สรุปวันนี้" ด้วย)
- "/health" ไม่มี — แต่เปิด `https://<worker>.workers.dev/api/line/health` ในบราวเซอร์เพื่อดูสถานะว่า LINE โมดูลเปิด/ปิด มี token+secret ครบไหม

### การแจ้งเตือนนัดหมาย (LINE push)
- เมื่อจดนัดทาง LINE ("จดนัดพบหมอ พรุ่งนี้บ่าย 2") ระบบจะเก็บ userId ของคนจดไว้กับนัดนั้น
- Cron trigger ทุก 1 นาที (`wrangler.toml → [triggers]`) ตรวจ calendar ของผู้ใช้ LINE ที่มีนัด (index `calendar:users`) → เมื่อถึงจุดเตือน (ค่าเริ่มต้น: ล่วงหน้า 60 / 10 นาที + ตอนถึงเวลา, ปรับได้ด้วย `LINE_REMINDER_OFFSETS`) จะ push ข้อความเตือนถึงคนจดนัด (LINE Push API)
- ข้อมูลแยกต่อผู้ใช้: โน้ต/นัดของ LINE แต่ละคนอยู่คนละ KV (`notes:{userId}`, `calendar:{userId}`), เว็บใช้ `me`, ห้ามปนกัน — นาดที่จดผ่าน web (ไม่มี userId) ไม่ถูกเตือนอัตโนมัติ
- การ push ใช้ quota ของ LINE (ไทย ~500 ข้อความ/เดือน, ญี่ปุ่น/ไต้หวัน ~200/เดือน) — การ reply ระหว่างคุยไม่นับ
- จำกัดการเตือน: ตัดรอบที่เลยเที่ยงคืนข้ามวันออก + ป้องกันซ้ำด้วย KV marker (`reminder:{id}:{offset}`, TTL 7 วัน)

### สรุปวันนี้ (Daily brief)
- **ฝั่งเว็บ**: กดปุ่ม "📋 สรุปวันนี้" → fetch `/api/notes` + `/api/calendar?date=วันนี้` ตรงจาก KV ไม่ผ่าน Gemini/WebSocket
- **ฝั่ง LINE**: พิมพ์ "สรุปวันนี้" (หรือกด Quick Reply) → ตอบทันทีจาก KV
- **อัตโนมัติ (push)**: ตั้ง `LINE_DAILY_BRIEF=08:00` → ทุกวัน 08:00 (ไทย) cron push สรุปให้ผู้ใช้ LINE ทุกคนที่เคยคุย (track ด้วย index `line:users`) 1 ครั้ง/คน/วัน (กันซ้ำด้วย `brief:{date}:{userId}`, TTL 2 วัน) — นับ push quota

### บันทึกรายรับ-จ่าย / To-do / รายการซื้อของ
- **คุยทั้ง LINE และเว็บ** — พิมพ์เช่น "ซื้อกาแฟไป 120", "ได้เงินเดือน 15000", "จดงานว่าส่งรายงานพรุ่งนี้", "ทำแล้ว", "ใส่รายการซื้อของว่านม กับไข่", "ซื้อไข่แล้ว" → ข้าวกล้องจดลง KV แยกต่อผู้ใช้ (`expenses:{key}`, `todos:{key}`, `shopping:{key}`) แบบเดียวกับโน้ต/นัด
- **คำสั่งลัด deterministic**: "งานค้าง" / "ซื้อของ" / "ใช้เงินวันนี้" → ตอบยอด/รายการจาก KV ทันทีไม่ใช้ Gemini (มีปุ่มบนเว็บและ Quick Reply บน LINE)
- ข้อมูลเดียวกันเห็นร่วมกันทั้ง LINE และเว็บ (key เดียวกันต่อผู้ใช้)

### ถ้าหน้า LINE ตอบช้าหรือ error
- เปิด `/api/line/health` ดูว่า `enabled / hasToken / hasSecret = true`
- Gemini free tier มี quota (~20 req/min/model) — ระบบมี fallback โมเดลอัตโนมัติ (`gemini-3.1-flash-lite` → ... → `gemini-2.0-flash-lite`) แต่ถ้าใช้หนักบนเว็บ+LINE พร้อมกันอาจยังโดนจำกัด
- ตรวจ log: `npx wrangler tail nong-khaoklong-live-avatar`

### ความแม่นยำวัน/เวลา/ปี
- โมเดลหน่วยความจำมีค่าล้าสมัย → ตอนนี้ทั้งเว็บและ LINE ฝัง "วันนี้ที่กรุงเทพฯ (พ.ศ.)" เข้าไปใน system prompt ทุกครั้งที่คุย (`bangkokNowText`/`setupSession`) โมเดลห้ามเดาวัน/เวลา/ปีเอง
- `/api/now` คืน `date` (YYYY-MM-DD), `yearBE` (พ.ศ.), `weekday` ("อังคาร" ไม่มี "วัน" ซ้ำ), `dateThai`, `iso` — ลบ bug "วันวันอังคาร" แล้ว
- ตัวช่วย `get_now` ยังมีอยู่สำหรับถามเวลาปัจจุบันแบบละเอียด

### แปลภาษา / วันสำคัญไทย / ยืนยันก่อนลบ
- **แปล**: พิมพ์ "แปลเป็นภาษาอังกฤษว่า ..." (หรือ ask แปลเป็น ไทย/จีน/ญี่ปุ่น ฯลฯ) → เรียก `/api/translate` (Gemini text, ฟรี) — ทั้ง LINE และเว็บ
- **วันสำคัญ/วันหยุดไทย**: พิมพ์ "วันสำคัญ" หรือถามเจาะจง "วันไหว้พระจันทร์ปีนี้", "อาสาฬหบูชา ตรงกับวันไหน" → `/api/thai-days` ตอบจากตาราง static ที่ตรวจสอบแล้ว (ปี พ.ศ.2569/2026: มาฆบูชา 3 มี.ค., วิสาขบูชา 31 พ.ค., อาสาฬหบูชา 29 ก.ค., เข้าพรรษา 30 ก.ค., ออกพรรษา 26 ต.ค., ไหว้พระจันทร์ 25 ก.ย.) — ใช้อัปเดตตารางปีใหม่ใน `THAI_DAYS` (worker.js) ตามประกาศจริง
- **ยืนยันก่อนลบ**: คำสั่งลบ/ล้างทั้งหมด (โน้ต, งาน, ซื้อของ, รายรับ-จ่าย, ปฏิทิน, ประวัติ) ต้องยืนยัน 2 ขั้น — AI ขอรหัสยืนยันก่อน (`request_clear`) แล้วยืนยันด้วยรหัส (`confirm_clear`); REST ลบ/l้างโดยตรงต้องส่ง `{clear:true, confirm:"true"}` ไม่งั้น error 400 (token หมดอายุ 15 นาที)

### ประกาศฟีเจอร์ใหม่ / ข่าวสาร (LINE broadcast)
- **เจ้าของตั้ง**: ตั้ง `LINE_ADMIN_USER` = LINE userId ของตัวเอง (ดูได้จาก `wrangler tail` เมื่อตัวเองพิมพ์ข้อความครั้งแรก) จากนั้นพิมพ์ใน LINE ว่า `ประกาศ: <ข้อความ>` (หรือ `แจ้งข่าว: <ข้อความ>`) — หรือประกาศทาง API: `POST /api/announce {text}` + header `x-announce-key: <LINE_ANNOUNCE_KEY>`
- **ระบบ broadcast**: cron (ทุก 1 นาที) อ่านประกาศล่าสุดจาก KV (`announce`, เพิ่มเวอร์ชันทุกครั้งที่ประกาศใหม่) → push ให้ผู้ใช้ LINE ทุกคนที่เคยคุย (index `line:users`) ครั้งละ ~20 คน/รอบ เพื่อไม่ให้กิน quota cron — กันซ้ำต่อ (เวอร์ชัน, ผู้ใช้) ด้วย marker `announceSeen:{v}:{userId}` (TTL 90 วัน)
- **กันรบกวน**: ผู้ใช้พิมพ์ "ปิดข่าว" → ขึ้น KV `announceOff:{userId}` ข้ามไม่ส่ง (พิมพ์ "เปิดข่าว" กลับมารับได้) — เนื้อหาประกาศจะลงท้ายด้วยสรุปความสามารถอัตโนมัติ เพื่อให้ผู้ใช้รู้ว่าระบบทำอะไรได้บ้าง

### ผู้ใช้แจ้งปัญหา / ติดต่อแอดมิน (LINE)
- **ผู้ใช้**: พิมพ์ `แจ้งปัญหา: <ข้อความ>` (ครั้งเดียว) หรือพิมพ์ `แจ้งปัญหา` แล้ว บอทจะถามรายละเอียด (พิมพ์ "ยกเลิก" ได้) — AI ก็ช่วยจดได้ (tool `report_issue`) เช่น พิมพ์ว่า "ระบบพัง" → แจ้งเรื่องออกมาได้เอง
- **รอบในระบบ**: เก็บ KV `reports:{userId}` (ต่อคน, cap 50) + `reports:all` (index รวม, cap 200) พร้อมหมายเลขติดตาม `R-0001`; กันสแปม 3 เรื่อง/ชม./คน (KV TTL 1 ชม.)
- **แจ้งแอดมินทันที**: push ไป `LINE_ADMIN_USER` (นับ quota push) พร้อมป้าย `🔴 [ด่วน]` ถ้าคำแจ้งมีคำว่า ด่วน/ร้อน/เร่งด่วน
- **แอดมิน**: พิมพ์ `ดูเรื่องแจ้ง` (ดูล่าสุด) + `ตอบ: R-0001 ข้อความ` (push คำตอบกลับหาผู้แจ้ง) หรือดูผ่าน API `GET /api/reports` + header `x-announce-key`

---

## API endpoints (ภายใน Worker)

| Path | Method | ใช้ |
|---|---|---|
| `/gemini-token` | POST | ออก ephemeral token ให้เว็บ (Live) |
| `/api/history?key=me` | GET/POST | บันทึก/อ่านบทสนทนา (KV `h:{key}`) |
| `/api/now` | GET | วัน/เวลาไทย (พุทธศักราช) |
| `/api/search?q=...` | GET | ค้นข้อมูล (Wikipedia TH+EN, ไม่ต้อง key) |
| `/api/notes` | GET/POST | บันทึก/อ่านโน้ต |
| `/api/calendar` | GET/POST/DELETE | นัดหมาย |
| `/api/expenses` | GET/POST | บันทึกรายรับ-รายจ่าย (amount +, ขั้น income ใช้ +) |
| `/api/todos` | GET/POST | รายการงาน (เพิ่ม/สลับเสร็จ/ลบ/ล้าง) |
| `/api/shopping` | GET/POST | รายการซื้อของ (เพิ่ม/สลับซื้อแล้ว/ลบ/ล้าง) |
| `/api/translate?text=...&to=EN` | GET | แปลข้อความ (Gemini text, ฟรี) |
| `/api/thai-days` | GET | วันสำคัญ/วันหยุดไทย (ตาราง static; `?date=YYYY-MM-DD` ดูเฉพาะวัน) |
| `/api/clear` | POST | ล้างข้อมูลแบบ 2 ขั้น (`{kind}` → ได้รหัส → `{kind,code}`) |
| `/api/announce` | GET/POST | อ่านประกาศล่าสุด / ประกาศใหม่ (POST ต้อง header `x-announce-key` = `LINE_ANNOUNCE_KEY`) |
| `/api/reports` | GET | ดูรายงานปัญหา/ติดต่อแอดมินที่ผู้ใช้ส่งมา (ต้อง header `x-announce-key`) |
| `/api/image` | POST | สร้างภาพ (Nano Banana) |
| `/api/line/webhook` | POST | webhook LINE (ตรวจ signature + ตอบ) |
| `/api/line/health` | GET | ดูสถานะโมดูล LINE |
| `/api/line/media/{id}` | GET | เสิร์ฟรูปที่ generate ให้ LINE |

## Feature flags (ชุดที่เปิด/ปิดได้)
- `LINE_ENABLED` — ปิด-เปิดโมดูล LINE ทั้งหมด (false = เว็บทำงานปกติ, LINE webhook ตอบ 404)
- `LINE_MODEL` — เปลี่ยนโมเดลข้อความฝั่ง LINE
- `LINE_REMINDERS_ENABLED` + `LINE_REMINDER_OFFSETS` — เปิด/ปรับการแจ้งเตือนนัดอัตโนมัติ (LINE push)
- `LINE_DAILY_BRIEF` — เปิด/ปิดสรุปวันนี้แบบ push อัตโนมัติ (เวลาไทย HH:MM)
- `SEARCH_ENGINE` + `SEARCH_API_KEY` *(optional)* — เปลี่ยนเครื่องมือค้นจาก Wikipedia เป็น `bing` / `tavily` (มี free tier: Bing 1,000/เดือน, Tavily 1,000 credits/เดือน ไม่ต้องบัตร)

---

## หมายเหตุเรื่อง Lip-sync
ตัวนี้เป็น "Live Avatar scaffold" ที่ทำให้ภาพตอบสนองตามสถานะการฟัง/พูดและเสียงของ Gemini ได้ แต่ริมฝีปากของภาพถ่ายยังไม่ขยับเป็น viseme จริง การทำ lip-sync จริงต้องต่อ avatar renderer/2D-3D rig ที่รับ audio/viseme events เพิ่มอีกชั้นหนึ่ง