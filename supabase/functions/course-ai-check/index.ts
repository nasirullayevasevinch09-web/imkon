// Uy vazifasini mezon bo'yicha AI bilan tekshirib, ustoz uchun qoralama yozadi.
// O'quvchiga hech narsa ko'rinmaydi: ustoz tasdiqlagandagina baho yuboriladi.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const MODEL = "claude-sonnet-5-5";
const STORAGE_PREFIX = "https://wccuqbmbhkctgngcwwer.supabase.co/storage/v1/object/public/course-hw/";

function parseTasks(hw: string) {
  const out: { n: number; text: string }[] = [];
  let cur: { n: number; text: string } | null = null;
  for (const line of String(hw || "").split(/\n/)) {
    const m = line.match(/^\s*(\d{1,2})[.)]\s*(.*)$/);
    if (m) { cur = { n: +m[1], text: m[2] }; out.push(cur); }
    else if (cur && line.trim()) cur.text += " " + line.trim();
  }
  return out.length ? out : [{ n: 1, text: "Uy vazifasi" }];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "METHOD" }, 405);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "BODY" }, 400); }

  // Kim chaqiryapti: ustoz (admin_token + sub_id) yoki o'quvchi (student_token + lesson_id)
  let sub: any = null;
  if (body.admin_token) {
    const { data: c } = await sb.from("course_config").select("value").eq("key", "admin_token").maybeSingle();
    if (!c || !c.value || c.value !== body.admin_token) return json({ error: "AUTH" }, 401);
    ({ data: sub } = await sb.from("course_submissions").select("*").eq("id", body.sub_id).maybeSingle());
  } else if (body.student_token) {
    const { data: st } = await sb.from("course_students").select("id").eq("session_token", body.student_token).maybeSingle();
    if (!st) return json({ error: "AUTH" }, 401);
    ({ data: sub } = await sb.from("course_submissions").select("*")
      .eq("lesson_id", body.lesson_id).eq("student_id", st.id).maybeSingle());
  } else return json({ error: "AUTH" }, 401);
  if (!sub) return json({ error: "NOT_FOUND" }, 404);
  if (sub.status === "tekshirildi") return json({ ok: true, skipped: "graded" });
  // O'quvchi qayta-qayta chaqirmasin: yangi yuborilmagan bo'lsa, qayta tekshirmaymiz
  if (!body.admin_token && sub.ai_at && new Date(sub.ai_at) >= new Date(sub.submitted_at)) return json({ ok: true, skipped: "fresh" });

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) {
    await sb.from("course_submissions").update({ ai_status: "kalit_yoq" }).eq("id", sub.id);
    return json({ error: "NO_KEY" });
  }
  await sb.from("course_submissions").update({ ai_status: "tekshirilmoqda" }).eq("id", sub.id);

  const { data: lesson } = await sb.from("course_lessons").select("num,title,homework,criteria").eq("id", sub.lesson_id).single();
  const tasks = parseTasks(lesson.homework);
  const crit = lesson.criteria || {};
  const answers: any[] = (sub.tasks && sub.tasks.length) ? sub.tasks
    : [{ n: 0, text: sub.answer, link: sub.link, file_url: sub.file_url, file_name: sub.file_name }];

  const content: any[] = [];
  let intro = `Siz "1 OY – 10 TA GRANT" kursining ustoz yordamchisisiz. ${lesson.num}-dars: ${lesson.title}.\n` +
    `O'quvchining uy vazifasini har bir vazifa bo'yicha MEZONGA qat'iy amal qilib baholang (0, 1 yoki 2 ball).\n\nVAZIFALAR VA MEZONLAR:\n`;
  for (const t of tasks) {
    const c = crit[String(t.n)] || {};
    intro += `\n${t.n}. ${t.text}\n  2 ball: ${c.c2 || "vazifa to'liq va sifatli bajarilgan"}\n  1 ball: ${c.c1 || "qisman bajarilgan"}\n  0 ball: topshirilmagan yoki talabga javob bermaydi\n` +
      (c.ex ? `  Ustozning namunasi (kerak bo'lsa moslab ishlating): ${c.ex}\n` : "");
  }
  if (answers[0].n === 0) intro += `\nDIQQAT: o'quvchi javobni vazifalarga ajratmasdan, bitta umumiy javob qilib yuborgan. Undan har bir vazifaga tegishli qismni toping.\n`;
  intro += `\nO'QUVCHINING JAVOBLARI:`;
  content.push({ type: "text", text: intro });

  for (const a of answers) {
    const head = a.n === 0 ? "UMUMIY JAVOB" : `${a.n}-VAZIFA JAVOBI`;
    let t = `\n--- ${head} ---\n`;
    if (a.text) t += `Matn:\n${a.text}\n`;
    if (a.link) t += `Havola: ${a.link} (havolani ochib bo'lmaydi — faqat havola berilganini hisobga oling, mazmunini taxmin qilmang)\n`;
    content.push({ type: "text", text: t });
    if (a.file_url && String(a.file_url).startsWith(STORAGE_PREFIX)) {
      const ext = String(a.file_name || a.file_url).split(".").pop()!.toLowerCase();
      if (ext === "pdf") content.push({ type: "document", source: { type: "url", url: a.file_url } });
      else if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) content.push({ type: "image", source: { type: "url", url: a.file_url } });
      else if (["txt", "csv"].includes(ext)) {
        try { const r = await fetch(a.file_url); content.push({ type: "text", text: `Fayl (${a.file_name}):\n${(await r.text()).slice(0, 20000)}` }); }
        catch { content.push({ type: "text", text: `Fayl ${a.file_name} o'qilmadi.` }); }
      } else content.push({ type: "text", text: `Fayl ${a.file_name} (${ext}) yuklangan, lekin bu turdagi faylni o'qib bo'lmaydi. Uni "ustoz qo'lda ko'rishi kerak" deb belgilang va ballni faqat boshqa ma'lumot bo'yicha bering.` });
    }
  }

  content.push({ type: "text", text:
    `\nJAVOB FORMATI: faqat JSON, boshqa hech narsa yozmang:\n` +
    `{"tasks":{"1":{"points":0|1|2,"fb":"...","ex":"..."}, ...}}\n` +
    `Qoidalar:\n- Har bir vazifa raqami (${tasks.map((t) => t.n).join(", ")}) uchun yozing; javob bo'lmasa 0 ball.\n` +
    `- "fb": o'zbek tilida (lotin), o'quvchiga "siz" deb murojaat, 2–4 gap: avval nima yaxshi, keyin aniq nima yetishmayapti va qanday tuzatish (o'quvchining o'z ishidan misol keltiring).\n` +
    `- "ex": 1 yoki 0 ball bo'lsa — o'quvchining o'z javobini tuzatilgan holda ko'rsatuvchi qisqa namuna ("Sizda: ... → Yaxshiroq: ..."); 2 ball bo'lsa bo'sh qoldiring.\n` +
    `- Shaxsiy ma'lumot o'ylab topmang, faqat o'quvchi yozgan narsaga tayaning.` });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages: [{ role: "user", content }] }),
    });
    const out = await r.json();
    if (!r.ok) throw new Error(out?.error?.message || ("HTTP " + r.status));
    const text = (out.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : text);
    const pts: Record<string, number> = {}, fb: Record<string, unknown> = {};
    for (const t of tasks) {
      const v = parsed?.tasks?.[String(t.n)];
      if (!v) continue;
      const p = Math.max(0, Math.min(2, Math.round(Number(v.points) || 0)));
      pts[t.n] = p;
      fb[t.n] = { fb: String(v.fb || "").slice(0, 5000) || null, ex: String(v.ex || "").slice(0, 5000) || null };
    }
    await sb.from("course_submissions").update({
      ai_task_points: pts, ai_task_feedback: fb, ai_status: "tayyor", ai_at: new Date().toISOString(),
    }).eq("id", sub.id);
    return json({ ok: true, points: pts });
  } catch (e) {
    await sb.from("course_submissions").update({ ai_status: "xato", ai_at: new Date().toISOString() }).eq("id", sub.id);
    return json({ error: "AI", detail: String((e as Error).message).slice(0, 300) }, 502);
  }
});
