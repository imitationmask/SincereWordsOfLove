const logEl = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const clearBtn = document.getElementById("clear");

const HISTORY_STORAGE_KEY = "sincere-words-of-love:chat-history";

/** @type {{ role: "user" | "assistant", content: string }[]} */
let history = [];

function loadStoredHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string"
    );
  } catch {
    return [];
  }
}

function persistHistory() {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    /* 存储已满或禁用 */
  }
}

function restoreHistoryToUi() {
  history = loadStoredHistory();
  logEl.innerHTML = "";
  for (const m of history) {
    bubble(m.role, m.content);
  }
}

function bubble(role, text, { pending = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = `bubble ${role}${pending ? " pending" : ""}`;
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = role === "user" ? "父母" : "父母真心话";
  const body = document.createElement("div");
  body.textContent = text;
  wrap.append(label, body);
  logEl.appendChild(wrap);
  logEl.scrollTop = logEl.scrollHeight;
  return { wrap, body };
}

function errorLine(msg) {
  const el = document.createElement("div");
  el.className = "err";
  el.textContent = msg;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
}

function parseSseBlock(block, onDelta) {
  for (const line of block.split("\n")) {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") return true;
    try {
      const json = JSON.parse(data);
      const delta = json.choices?.[0]?.delta;
      const piece = delta?.content;
      if (typeof piece === "string" && piece.length) onDelta(piece);
    } catch {
      /* 忽略非 JSON 行 */
    }
  }
  return false;
}

/** 解析 DashScope / OpenAI 兼容的 SSE */
async function consumeSse(response, onDelta) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("无法读取响应流");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      if (parseSseBlock(block, onDelta)) return;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    parseSseBlock(buffer, onDelta);
  }
}

/**
 * 将已收到的全文以「逐字」节奏刷到 DOM（模型可能一次推多个字）
 * @param {HTMLElement} el
 * @param {() => string} getFull 始终返回当前累计全文
 * @param {{ msPerChar?: number }} opts
 */
function typewriterReveal(el, getFull, opts = {}) {
  const ms = opts.msPerChar ?? 20;
  let shownLen = 0;
  let timer = null;
  let doneStreaming = false;
  /** @type {(() => void) | null} */
  let flushResolver = null;

  const glyphsOf = (s) => Array.from(s);

  const pump = () => {
    const full = getFull();
    const glyphs = glyphsOf(full);
    if (shownLen < glyphs.length) {
      shownLen += 1;
      el.textContent = glyphs.slice(0, shownLen).join("");
      logEl.scrollTop = logEl.scrollHeight;
      timer = window.setTimeout(pump, ms);
      return;
    }
    if (doneStreaming) {
      timer = null;
      el.textContent = full.trimEnd();
      if (flushResolver) {
        const r = flushResolver;
        flushResolver = null;
        r();
      }
      return;
    }
    timer = window.setTimeout(pump, ms);
  };

  const kick = () => {
    if (timer != null) {
      window.clearTimeout(timer);
      timer = null;
    }
    pump();
  };

  return {
    kick,
    setDone: () => {
      doneStreaming = true;
      kick();
    },
    /** 须在一次回复中先调用本方法注册 resolve，再调用 setDone，避免流已结束却无人 resolve */
    waitUntilCaughtUp: () =>
      new Promise((resolve) => {
        const full = getFull();
        if (doneStreaming && shownLen >= glyphsOf(full).length) {
          el.textContent = full.trimEnd();
          resolve();
          return;
        }
        flushResolver = resolve;
        kick();
      }),
    cancel: () => {
      if (timer != null) window.clearTimeout(timer);
      timer = null;
      flushResolver = null;
    },
  };
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  bubble("user", text);
  history.push({ role: "user", content: text });

  const { wrap, body } = bubble("assistant", "", { pending: true });

  let fullText = "";
  const tw = typewriterReveal(body, () => fullText, { msPerChar: 20 });

  sendBtn.disabled = true;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history, stream: true }),
    });

    const ct = res.headers.get("content-type") || "";

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const detail =
        typeof data.detail === "string" ? data.detail.slice(0, 400) : "";
      throw new Error(
        data.error || `请求失败（${res.status}）${detail ? `：${detail}` : ""}`
      );
    }

    if (!ct.includes("text/event-stream")) {
      const data = await res.json().catch(() => ({}));
      const content = (data.content || "").trim();
      fullText = content;
      tw.cancel();
      wrap.classList.remove("pending");
      body.textContent = content;
      history.push({ role: "assistant", content });
      persistHistory();
      return;
    }

    wrap.classList.remove("pending");
    body.textContent = "";

    await consumeSse(res, (piece) => {
      fullText += piece;
      tw.kick();
    });

    const flushPromise = tw.waitUntilCaughtUp();
    tw.setDone();
    await flushPromise;

    const finalText = fullText.trim();
    history.push({ role: "assistant", content: finalText });
    persistHistory();
  } catch (err) {
    tw.cancel();
    wrap.remove();
    history.pop();
    errorLine(err?.message || "网络或服务异常，请稍后重试。");
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});

clearBtn.addEventListener("click", () => {
  history = [];
  logEl.innerHTML = "";
  try {
    localStorage.removeItem(HISTORY_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  input.focus();
});

restoreHistoryToUi();

const FLOAT_DECOR_SIZE = 30;

function layoutFloatingDecor() {
  const root = document.getElementById("heart-decor");
  if (!root) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  function expandRect(r, pad) {
    return {
      left: r.left - pad,
      top: r.top - pad,
      right: r.right + pad,
      bottom: r.bottom + pad,
    };
  }

  function intersects(a, b) {
    return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  }

  function buildZones(strict) {
    const pad = strict ? 22 : 32;
    const selectors = strict ? [".hero", ".chat", ".foot"] : [".chat"];
    return selectors
      .map((s) => document.querySelector(s))
      .filter(Boolean)
      .map((el) => expandRect(el.getBoundingClientRect(), pad));
  }

  function placeBatch(strict) {
    root.replaceChildren();
    const zones = buildZones(strict);
    if (!zones.length) return 0;

    const targetCount = Math.min(
      28,
      Math.max(8, Math.floor((vw * vh) / 26000))
    );

    const rot = () => Math.random() * 40 - 20;

    let placed = 0;
    outer: for (let i = 0; i < targetCount; i++) {
      for (let attempt = 0; attempt < 72; attempt++) {
        const x = Math.random() * Math.max(1, vw - FLOAT_DECOR_SIZE);
        const y = Math.random() * Math.max(1, vh - FLOAT_DECOR_SIZE);
        const box = {
          left: x,
          top: y,
          right: x + FLOAT_DECOR_SIZE,
          bottom: y + FLOAT_DECOR_SIZE,
        };
        if (!zones.some((z) => intersects(box, z))) {
          const img = document.createElement("img");
          img.src = "/balloon.svg";
          img.alt = "";
          img.width = FLOAT_DECOR_SIZE;
          img.height = FLOAT_DECOR_SIZE;
          img.style.left = `${x}px`;
          img.style.top = `${y}px`;
          img.style.transform = `rotate(${rot()}deg)`;
          img.decoding = "async";
          root.appendChild(img);
          placed++;
          continue outer;
        }
      }
    }
    return placed;
  }

  const placedStrict = placeBatch(true);
  if (placedStrict < 6) {
    root.dataset.mode = "relaxed";
    placeBatch(false);
    document.body.classList.add("hearts-near-hero");
  } else {
    root.dataset.mode = "strict";
    document.body.classList.remove("hearts-near-hero");
  }
}

let heartLayoutTimer;
window.addEventListener("resize", () => {
  window.clearTimeout(heartLayoutTimer);
  heartLayoutTimer = window.setTimeout(() => layoutFloatingDecor(), 180);
});

requestAnimationFrame(() => {
  layoutFloatingDecor();
});
