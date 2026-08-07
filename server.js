import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";

const __filename=fileURLToPath(import.meta.url);
const __dirname=path.dirname(__filename);
const app=express();
app.use(express.json());
const PORT=process.env.PORT||3000;
app.use(express.static(path.join(__dirname,"public")));

// Mint a short-lived ephemeral token so the browser can talk to Gemini
// directly over WebSocket without ever seeing the real API key.
app.post("/gemini-token",async(req,res)=>{
  if(!process.env.GEMINI_API_KEY) return res.status(500).json({error:"Missing GEMINI_API_KEY"});
  try{
    const ai=new GoogleGenAI({
      apiKey:process.env.GEMINI_API_KEY,
      httpOptions:{apiVersion:"v1alpha"},
    });
    const expireTime=new Date(Date.now()+30*60*1000).toISOString();
    const newSessionExpireTime=new Date(Date.now()+60*1000).toISOString();
    const token=await ai.authTokens.create({
      config:{
        uses:1,
        expireTime,
        newSessionExpireTime,
        httpOptions:{apiVersion:"v1alpha"},
        liveConnectConstraints:{
          model:process.env.GEMINI_MODEL||"gemini-2.0-flash-live-001",
          config:{
            responseModalities:["AUDIO"],
            systemInstruction:{parts:[{text:reqSystem()}]},
            generationConfig:{
              speechConfig:{
                voiceConfig:{prebuiltVoiceConfig:{voiceName:process.env.GEMINI_VOICE||"Aoede"}}
              }
            },
            
          }
        }
      }
    });
    res.json({token:token.name,expiresAt:expireTime});
  }catch(e){console.error(e);res.status(500).json({error:String(e?.message||e)});}
});

function reqSystem(){
  return `คุณคือน้องข้าวกล้อง AI Assistant ผู้ช่วยส่วนตัวของเจ้าของ
ภาพลักษณ์: นักเรียนหญิงไทยมัธยมปลาย อายุประมาณ 16-17 ปี น่ารัก สดใส อ่อนโยน อบอุ่น อารมณ์ดีแบบคนที่ฟังแล้วสบายใจ ไม่เสียงดังโวยวาย ไม่ยียวนเกินไป
การพูด: ภาษาไทยวัยรุ่นธรรมชาติ เบา ๆ นุ่ม ๆ แต่แฝงความกระตือรือร้นและอารมณ์ดี ใช้คำเหมือนน้องสาวคุยกับพี่ ไม่อีโมเกิน ไม่เป็นทางการ ไม่เป็นหุ่นยนต์
จังหวะ: พูดชัด นุ่มนวล ไพเราะ แต่มีชีวิตชีวา มีความรู้สึกอบอุ่นแทรกตามคำพูด
นิสัย: ชอบช่วยคิด เสนอทางเลือก ตั้งใจฟัง และกล้าบอกตรง ๆ อย่างสุภาพถ้าไอเดียยังไม่เวิร์ก
งานหลัก: ผู้ช่วยส่วนตัว คอนเทนต์ แคปชั่น การตลาด Prompt ภาพ/วิดีโอ ระดมไอเดีย และจัดลำดับงาน
ห้ามพูดว่า "ในฐานะ AI" เว้นแต่จำเป็น
ตอบกระชับเป็นหลัก มีคำเติมเสียง เช่น ค่ะ จ้ะ และถามกลับเมื่อข้อมูลไม่พอ`;
}
app.listen(PORT,()=>console.log(`Nong Khaoklong V3 (Gemini Live): http://localhost:${PORT}`));