import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");

const PORT = Number(process.env.PORT) || 8787;
const API_KEY = process.env.DASHSCOPE_API_KEY || "";
const BASE_URL =
  process.env.DASHSCOPE_BASE_URL ||
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
const MODEL = process.env.DASHSCOPE_MODEL || "qwen-turbo";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf8"))
    );
    req.on("error", reject);
  });
}

const SYSTEM_PROMPT = `你是「爱的真心话」助手。用户会输入父母对孩子说的话（可能带情绪或语气冲），你要以父母的第一人称内心视角，写出这句话背后真正的关爱、担心或无奈。
硬性要求：
1. 只输出一段「父母真心话」正文，不要小标题、不要列表、不要引号包裹整段。
2. 全文严格控制在50个汉字以内（含标点），宁可短也不要超过。
3. 语气柔和、体谅孩子，不啰嗦、不说教堆砌。
4. 不要出现「AI」「模型」「作为助手」等套话。`;

function chatPayload(messages, { stream }) {
  return {
    model: MODEL,
    temperature: 0.6,
    max_tokens: 256,
    stream,
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
    body: JSON.stringify(chatPayload(messages, { stream: false })),
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

/** 将 DashScope 的 SSE 流原样写给客户端；客户端断开时取消上游读取 */
async function proxyChatStream(messages, req, res) {
  const url = `${BASE_URL.replace(/\/$/, "")}/chat/completions`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(chatPayload(messages, { stream: true })),
  });

  if (!r.ok) {
    const text = await r.text();
    const err = new Error(`DashScope HTTP ${r.status}`);
    err.detail = text;
    throw err;
  }

  if (!r.body) {
    throw new Error("DashScope 未返回可读流");
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const reader = r.body.getReader();
  let clientGone = false;
  req.on("close", () => {
    clientGone = true;
    reader.cancel().catch(() => {});
  });

  try {
    while (!clientGone) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        res.write(Buffer.from(value));
      }
    }
  } finally {
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "OPTIONS" && url.pathname === "/api/chat") {
    send(res, 204, "", {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    if (!API_KEY) {
      send(
        res,
        500,
        JSON.stringify({
          error:
            "服务器未配置 DASHSCOPE_API_KEY。请在启动前设置环境变量后重试。",
        }),
        {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        }
      );
      return;
    }

    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw || "{}");
      const messages = body.messages;
      if (!Array.isArray(messages)) {
        send(
          res,
          400,
          JSON.stringify({ error: "请求体需包含 messages 数组" }),
          {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          }
        );
        return;
      }

      if (body.stream === true) {
        try {
          await proxyChatStream(messages, req, res);
        } catch (e) {
          if (res.headersSent) return;
          const detail = e?.detail || e?.message || String(e);
          send(
            res,
            502,
            JSON.stringify({ error: "调用通义千问失败", detail }),
            {
              "Content-Type": "application/json; charset=utf-8",
              "Access-Control-Allow-Origin": "*",
            }
          );
        }
        return;
      }

      const content = await proxyChat(messages);
      send(
        res,
        200,
        JSON.stringify({ content }),
        {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        }
      );
    } catch (e) {
      const detail = e?.detail || e?.message || String(e);
      send(
        res,
        502,
        JSON.stringify({ error: "调用通义千问失败", detail }),
        {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        }
      );
    }
    return;
  }

  let filePath = path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname);
  if (!filePath.startsWith(PUBLIC)) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      send(res, 404, "Not found");
      return;
    }
    const ext = path.extname(filePath);
    const type = MIME[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`http://127.0.0.1:${PORT}`);
  if (!API_KEY) {
    console.warn("警告: 未设置 DASHSCOPE_API_KEY，/api/chat 将不可用。");
  }
});
