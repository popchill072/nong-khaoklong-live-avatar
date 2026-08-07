# น้องข้าวกล้อง AI Assistant V3 — Live Avatar

V3 เป็นเวอร์ชันต่อจาก Prototype/V2:
- GPT Realtime สำหรับคุยเสียงต่อเสียง
- ภาษาไทย + persona "น้องข้าวกล้อง"
- รองรับการพูดแทรกและ semantic VAD
- Avatar image + voice-reactive animation
- มีปุ่ม mute microphone และพิมพ์ข้อความได้
- API key อยู่ฝั่ง server

## วิธีใช้
1. ติดตั้ง Node.js 20+
2. `npm install`
3. คัดลอก `.env.example` เป็น `.env`
4. ใส่ `OPENAI_API_KEY=...`
5. `npm start`
6. เปิด `http://localhost:3000`
7. กด "เริ่มคุย" และอนุญาตไมโครโฟน

## หมายเหตุเรื่อง Lip-sync
ตัวนี้เป็น "Live Avatar scaffold" ที่ทำให้ภาพตอบสนองตามสถานะการฟัง/พูดและเสียงของ GPT ได้ แต่ริมฝีปากของภาพถ่ายยังไม่ขยับเป็น viseme จริง
การทำ lip-sync จริงต้องต่อ avatar renderer/2D-3D rig ที่รับ audio/viseme events เพิ่มอีกชั้นหนึ่ง
