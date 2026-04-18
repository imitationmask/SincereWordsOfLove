const logEl = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const clearBtn = document.getElementById("clear");

/** @type {{ role: 'user' | 'assistant', content: string }[]} */
let history = [];

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
  return wrap;
}

function errorLine(msg) {
  const el = document.createElement("div");
  el.className = "err";
  el.textContent = msg;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  bubble("user", text);
  history.push({ role: "user", content: text });

  const pending = bubble(
    "assistant",
    "正在温柔地替你翻译这份心情…",
    { pending: true }
  );

  sendBtn.disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail =
        typeof data.detail === "string"
          ? data.detail.slice(0, 400)
          : "";
      throw new Error(
        data.error || `请求失败（${res.status}）${detail ? `：${detail}` : ""}`
      );
    }
    const content = data.content || "";
    pending.classList.remove("pending");
    pending.querySelector("div").textContent = content;
    history.push({ role: "assistant", content });
  } catch (err) {
    pending.remove();
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
  input.focus();
});
