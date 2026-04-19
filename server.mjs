import "dotenv/config";
import { randomUUID } from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket as WsClient } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");

const PORT = Number(process.env.PORT) || 8787;
const API_KEY = process.env.DASHSCOPE_API_KEY || "";
const BASE_URL =
  process.env.DASHSCOPE_BASE_URL ||
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
const MODEL = process.env.DASHSCOPE_MODEL || "qwen-turbo";

/** 百炼实时语音识别 WebSocket（与 Chat 共用 DASHSCOPE_API_KEY），默认北京地域 */
const ASR_WSS_URL =
  process.env.DASHSCOPE_ASR_WSS ||
  "wss://dashscope.aliyuncs.com/api-ws/v1/inference/";
const ASR_MODEL = process.env.DASHSCOPE_ASR_MODEL || "paraformer-realtime-v2";

/** 每次请求最多带上最近几条对话，避免上下文过长拖慢首字与总耗时 */
const CHAT_MAX_MESSAGES = (() => {
  const n = Number(process.env.CHAT_MAX_MESSAGES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 12;
})();

/** 输出约 50 汉字以内，128 token 足够；可按需调低以略减生成长度 */
const DASHSCOPE_MAX_TOKENS = (() => {
  const n = Number(process.env.DASHSCOPE_MAX_TOKENS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 128;
})();

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

function trimChatMessages(messages) {
  if (messages.length <= CHAT_MAX_MESSAGES) return messages;
  return messages.slice(-CHAT_MAX_MESSAGES);
}

function chatPayload(messages, { stream }) {
  const payload = {
    model: MODEL,
    temperature: 0.6,
    max_tokens: DASHSCOPE_MAX_TOKENS,
    stream,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
  };
  /** Qwen3 系若默认开启 thinking，会明显增加耗时；其它模型不传该字段以免兼容接口报错 */
  if (/qwen3|qwq/i.test(MODEL)) {
    payload.enable_thinking = false;
  }
  return payload;
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

function asrRunTaskMessage(taskId) {
  return {
    header: {
      action: "run-task",
      task_id: taskId,
      streaming: "duplex",
    },
    payload: {
      task_group: "audio",
      task: "asr",
      function: "recognition",
      model: ASR_MODEL,
      parameters: {
        format: "pcm",
        sample_rate: 16000,
      },
      input: {},
    },
  };
}

function asrFinishTaskMessage(taskId) {
  return {
    header: {
      action: "finish-task",
      task_id: taskId,
      streaming: "duplex",
    },
    payload: { input: {} },
  };
}

function safeSendJson(ws, obj) {
  if (ws.readyState !== WsClient.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

/**
 * 浏览器 WebSocket ↔ 百炼实时语音识别（Paraformer）协议桥接
 * @param {import("ws").WebSocket} browserWs
 */
function attachDashScopeAsrBridge(browserWs) {
  if (!API_KEY) {
    safeSendJson(browserWs, {
      type: "error",
      message:
        "服务器未配置 DASHSCOPE_API_KEY，无法使用语音输入。请配置环境变量后重试。",
    });
    browserWs.close();
    return;
  }

  const taskId = randomUUID();
  let taskStarted = false;
  let finished = false;

  const ds = new WsClient(ASR_WSS_URL, {
    headers: { Authorization: `bearer ${API_KEY}` },
  });

  const closeAll = () => {
    if (finished) return;
    finished = true;
    try {
      if (ds.readyState === WsClient.OPEN) ds.close();
    } catch {
      /* ignore */
    }
    try {
      if (browserWs.readyState === WsClient.OPEN) browserWs.close();
    } catch {
      /* ignore */
    }
  };

  ds.on("open", () => {
    ds.send(JSON.stringify(asrRunTaskMessage(taskId)));
  });

  ds.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const ev = msg.header?.event;
    if (ev === "task-started") {
      taskStarted = true;
      safeSendJson(browserWs, { type: "ready" });
      return;
    }
    if (ev === "result-generated") {
      const sentence = msg.payload?.output?.sentence;
      if (!sentence || sentence.heartbeat) return;
      safeSendJson(browserWs, {
        type: "result",
        text: sentence.text || "",
        sentenceEnd: sentence.sentence_end === true,
      });
      return;
    }
    if (ev === "task-finished") {
      finished = true;
      safeSendJson(browserWs, { type: "done" });
      try {
        browserWs.close();
      } catch {
        /* ignore */
      }
      try {
        ds.close();
      } catch {
        /* ignore */
      }
      return;
    }
    if (ev === "task-failed") {
      safeSendJson(browserWs, {
        type: "error",
        message: msg.header?.error_message || "语音识别任务失败",
      });
      closeAll();
    }
  });

  ds.on("error", (err) => {
    console.error("[api/asr] DashScope WebSocket:", err?.message || err);
    safeSendJson(browserWs, {
      type: "error",
      message: err?.message || "连接语音识别服务失败",
    });
    closeAll();
  });

  ds.on("close", () => {
    if (!finished) {
      safeSendJson(browserWs, { type: "done" });
    }
    try {
      if (browserWs.readyState === WsClient.OPEN) browserWs.close();
    } catch {
      /* ignore */
    }
  });

  browserWs.on("message", (data, isBinary) => {
    if (!isBinary) return;
    if (taskStarted && ds.readyState === WsClient.OPEN) {
      ds.send(data);
    }
  });

  browserWs.on("close", () => {
    if (finished) return;
    if (ds.readyState === WsClient.OPEN) {
      try {
        if (taskStarted) {
          ds.send(JSON.stringify(asrFinishTaskMessage(taskId)));
        } else {
          ds.close();
        }
      } catch {
        /* ignore */
      }
    }
  });

  browserWs.on("error", (err) => {
    console.error("[api/asr] browser WebSocket:", err?.message || err);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  /**
   * WebSocket 握手会先触发 `request`，再触发 `upgrade`。
   * 若在此处按静态资源处理 /api/asr/stream，会先发 404，握手失败（wscat / 浏览器均报 Unexpected 404）。
   */
  if (String(req.headers.upgrade || "").toLowerCase() === "websocket") {
    return;
  }

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

    let tChat0;
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

      const messagesForApi = trimChatMessages(messages);

      tChat0 = performance.now();

      if (body.stream === true) {
        try {
          await proxyChatStream(messagesForApi, req, res);
          console.log(
            `[api/chat] stream completed in ${(performance.now() - tChat0).toFixed(1)}ms`
          );
        } catch (e) {
          console.log(
            `[api/chat] stream failed in ${(performance.now() - tChat0).toFixed(1)}ms`
          );
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

      const content = await proxyChat(messagesForApi);
      send(
        res,
        200,
        JSON.stringify({ content }),
        {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        }
      );
      console.log(
        `[api/chat] completed in ${(performance.now() - tChat0).toFixed(1)}ms`
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
      if (tChat0 !== undefined) {
        console.log(
          `[api/chat] completed with error in ${(performance.now() - tChat0).toFixed(1)}ms`
        );
      }
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

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url || "/", `http://${req.headers.host}`);
  if (u.pathname === "/api/asr/stream") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachDashScopeAsrBridge(ws);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`http://127.0.0.1:${PORT}`);
  if (!API_KEY) {
    console.warn(
      "警告: 未设置 DASHSCOPE_API_KEY，/api/chat 与语音输入将不可用。"
    );
  }
});
