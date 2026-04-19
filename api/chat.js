const API_KEY = process.env.DASHSCOPE_API_KEY || "";
const BASE_URL =
  process.env.DASHSCOPE_BASE_URL ||
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
const MODEL = process.env.DASHSCOPE_MODEL || "qwen-turbo";

const SYSTEM_PROMPT = `你是「爱的真心话」助手。用户会输入父母对孩子说的话（可能带情绪或语气冲），你要以父母的第一人称内心视角，写出这句话背后真正的关爱、担心或无奈。
硬性要求：
1. 只输出一段「父母真心话」正文，不要小标题、不要列表、不要引号包裹整段。
2. 全文严格控制在50个汉字以内（含标点），宁可短也不要超过。
3. 语气柔和、体谅孩子，不啰嗦、不说教堆砌。
4. 不要出现「AI」「模型」「作为助手」等套话。`;

function chatPayload(messages) {
  return {
    model: MODEL,
    temperature: 0.6,
    max_tokens: 256,
    stream: false,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
  };
}

async function proxyChat(messages) {
  const url = `${BASE_URL.replace(/\/$/, "")}/chat/completions`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(chatPayload(messages)),
  });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`DashScope HTTP ${r.status}`);
    err.detail = text;
    throw err;
  }
  const data = JSON.parse(text);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty model response");
  return String(content).trim();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body != null && typeof req.body === "object") {
      resolve(req.body);
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!API_KEY) {
    res.status(500).json({
      error:
        "服务器未配置 DASHSCOPE_API_KEY。请在 Vercel 项目 Environment Variables 中设置后重新部署。",
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    res.status(400).json({ error: "无效的 JSON 请求体" });
    return;
  }

  const messages = body.messages;
  if (!Array.isArray(messages)) {
    res.status(400).json({ error: "请求体需包含 messages 数组" });
    return;
  }

  try {
    const content = await proxyChat(messages);
    res.status(200).json({ content });
  } catch (e) {
    const detail = e?.detail || e?.message || String(e);
    res.status(502).json({ error: "调用通义千问失败", detail });
  }
}
