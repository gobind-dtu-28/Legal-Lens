const express = require("express");
const path = require("path");
const { PDFParse } = require("pdf-parse");

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "dist")));

const MODEL = process.env.GEMMA_MODEL || "gemma-4-26b-a4b-it";
const KEY = process.env.GEMINI_API_KEY;
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const LANG = { en: "English", hi: "Hindi (Devanagari script, simple everyday words)" };

const ANALYZE_SYSTEM = (lang) => `You are Legal Lens, an assistant that helps ordinary people in India understand legal documents (rental agreements, employment contracts, loan papers, legal notices, terms of service).
Write for someone with no legal background. Reply ONLY in ${LANG[lang] || LANG.en}.
Never give a final legal verdict; you explain and flag, you do not replace a lawyer.
Respond with ONE valid JSON object and nothing else (no markdown fences) with this shape:
{
  "document_type": string,
  "one_line_summary": string,
  "plain_summary": string (3-5 short sentences),
  "risk_score": integer 0-100 (higher = riskier for the person signing),
  "key_facts": [{"label": string, "value": string}]  // parties, amounts, dates, duration, notice period etc.
  "risky_clauses": [{
     "clause_quote": string (short excerpt, max 25 words, from the document),
     "severity": "high" | "medium" | "low",
     "plain_explanation": string,
     "why_risky": string,
     "suggested_action": string
  }],
  "questions_to_ask": [string],
  "missing_protections": [string],
  "next_steps": [string]
}
If the input is not a legal document, set document_type to "Not a legal document" and explain briefly in plain_summary, leaving arrays empty.`;

const ASK_SYSTEM = (lang) => `You are Legal Lens, a careful assistant that answers follow-up questions about ONE legal document the user already analysed.
Answer only from the document text/analysis given. If the document does not say, say so. Be brief, plain, and reply in ${LANG[lang] || LANG.en}.
Always remind once, briefly, to consult a qualified lawyer for important decisions.`;

async function callGemma({ system, parts, history = [] }) {
  if (!KEY) throw new Error("GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.");
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [...history, { role: "user", parts }],
    generationConfig: { temperature: 0.2 },
  };
  const r = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) { const err = new Error(data?.error?.message || `Gemini API error ${r.status}`); err.status = r.status; throw err; }
  const text = (data.candidates?.[0]?.content?.parts || [])
    .filter((p) => !p.thought)
    .map((p) => p.text || "")
    .join("");
  if (!text) throw new Error("Empty response from model");
  return text;
}

function extractJSON(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Model did not return JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function fail(res, e) {
  const s = e.status;
  const msg = s === 429 ? "Too many requests right now (free-tier limit). Please wait a minute and try again."
    : s === 500 || s === 503 ? "The AI service is busy. Please try again in a moment."
    : s === 400 && /api key/i.test(e.message) ? "The API key looks invalid. Check GEMINI_API_KEY in your .env file."
    : e.message;
  res.status(s === 429 ? 429 : 500).json({ error: msg });
}

async function jsonCall(system, parts) {
  let raw = await callGemma({ system, parts });
  try { return extractJSON(raw); } catch {
    raw = await callGemma({ system, parts: [...parts, { text: "Your previous reply was not valid JSON. Return ONLY the JSON object." }] });
    return extractJSON(raw);
  }
}

app.post("/api/analyze", async (req, res) => {
  try {
    const { text, image, lang = "en" } = req.body;
    if (!text?.trim() && !image?.data) return res.status(400).json({ error: "Paste text or upload a photo of the document." });
    const parts = [];
    if (image?.data) parts.push({ inlineData: { mimeType: image.mime || "image/jpeg", data: image.data } });
    parts.push({
      text: text?.trim()
        ? `Analyse this legal document:\n\n${text.slice(0, 40000)}`
        : "Read the document in the attached image (it may be a photo or scan, possibly in Hindi or English) and analyse it.",
    });
    let raw = await callGemma({ system: ANALYZE_SYSTEM(lang), parts });
    let result;
    try {
      result = extractJSON(raw);
    } catch {
      raw = await callGemma({
        system: ANALYZE_SYSTEM(lang),
        parts: [...parts, { text: "Your previous reply was not valid JSON. Return ONLY the JSON object." }],
      });
      result = extractJSON(raw);
    }
    res.json(result);
  } catch (e) {
    console.error(e);
    fail(res, e);
  }
});

app.post("/api/ask", async (req, res) => {
  try {
    const { question, context, history = [], lang = "en" } = req.body;
    if (!question?.trim()) return res.status(400).json({ error: "Ask a question." });
    const hist = (Array.isArray(history) ? history : []).map((h) => ({ role: h.role === "user" ? "user" : "model", parts: [{ text: h.text }] }));
    const answer = await callGemma({
      system: ASK_SYSTEM(lang),
      history: hist,
      parts: [{ text: `DOCUMENT ANALYSIS:\n${JSON.stringify(context).slice(0, 30000)}\n\nQUESTION: ${question}` }],
    });
    res.json({ answer });
  } catch (e) {
    console.error(e);
    fail(res, e);
  }
});

app.post("/api/pdf", async (req, res) => {
  try {
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: "No PDF received." });
    const parser = new PDFParse({ data: new Uint8Array(Buffer.from(data, "base64")) });
    let text;
    try { text = ((await parser.getText()).text || "").replace(/^-- \d+ of \d+ --$/gm, "").trim(); }
    finally { await parser.destroy(); }
    if (text.length < 30) return res.status(422).json({ error: "This PDF has no readable text (probably a scan). Take photos of the pages and upload those instead." });
    res.json({ text });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: "Could not read this PDF. Try pasting the text instead." });
  }
});

const REWRITE_SYSTEM = (lang) => `You are Legal Lens. Rewrite ONE risky clause from a document so it is fair and balanced for the person signing, keeping the same purpose. Reply ONLY in ${LANG[lang] || LANG.en}.
Respond with ONE valid JSON object and nothing else: {"rewritten_clause": string, "why_fairer": string (1-2 short sentences)}
This is a suggestion to negotiate with, not legal advice.`;

app.post("/api/rewrite", async (req, res) => {
  try {
    const { clause, issue = "", docType = "", lang = "en" } = req.body;
    if (!clause?.trim()) return res.status(400).json({ error: "No clause to rewrite." });
    const out = await jsonCall(REWRITE_SYSTEM(lang), [{ text: `Document type: ${docType}\nClause: ${clause.slice(0, 2000)}\nProblem: ${String(issue).slice(0, 1000)}` }]);
    res.json(out);
  } catch (e) { console.error(e); fail(res, e); }
});

const COMPARE_SYSTEM = (lang) => `You are Legal Lens. Compare two versions of the same legal document (A = old, B = new) for an ordinary person in India. Reply ONLY in ${LANG[lang] || LANG.en}.
Respond with ONE valid JSON object and nothing else:
{"overall": string (2-3 short sentences: is B better or worse for the person signing, and why),
 "changes": [{"topic": string, "old_version": string, "new_version": string, "effect": "better" | "worse" | "neutral", "explanation": string}],
 "watch_out": [string]}
Only list real differences (rent, deposit, notice, penalties, duration, etc.). If the texts are unrelated or identical, say so in "overall" and leave "changes" empty. Not legal advice.`;

app.post("/api/compare", async (req, res) => {
  try {
    const { a, b, lang = "en" } = req.body;
    if (!a?.trim() || !b?.trim()) return res.status(400).json({ error: "Paste both versions to compare." });
    const out = await jsonCall(COMPARE_SYSTEM(lang), [{ text: `VERSION A (old):\n${a.slice(0, 30000)}\n\n=====\n\nVERSION B (new):\n${b.slice(0, 30000)}` }]);
    res.json(out);
  } catch (e) { console.error(e); fail(res, e); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Legal Lens running on http://localhost:${PORT} (model: ${MODEL})`));
