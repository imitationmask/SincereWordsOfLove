# 后端调试说明

本文说明如何调试本项目的 Node 后端（`server.mjs`）以及 `POST /api/chat` 接口，便于本地排错与性能观察。

## 前置条件

- 已安装依赖：`npm install`
- 按需配置 `.env`（至少调试路由逻辑时可不填 Key；调用通义接口时需 `DASHSCOPE_API_KEY`）

## 在 Cursor / VS Code 中调试

1. 打开 **Run and Debug**（运行和调试，`Cmd+Shift+D` / `Ctrl+Shift+D`）。
2. 在配置中选择 **「Debug server.mjs」**。
3. 在 `server.mjs` 中需要暂停的行左侧设置**断点**，按 **F5** 启动调试。

调试器启动后，终端会打印服务地址（默认 `http://127.0.0.1:8787`，或由 `PORT` 指定）。

**端口冲突**：若已在其它终端运行 `npm start` 占用同一端口，请先结束该进程再调试，否则会启动失败。

## 使用 `--inspect`（命令行 + 附加）

- `npm run debug`：以 `node --inspect` 启动，默认调试端口 **9229**。
- `npm run debug-brk`：以 `node --inspect-brk` 启动，**在第一行暂停**，适合从入口逐步执行。

在 Cursor 中选择 **「Attach to --inspect」** 附加到已运行的进程。

## 调试 `POST /api/chat`

### 断点建议位置（`server.mjs`）

| 目的 | 建议位置 |
|------|----------|
| 确认请求进入聊天逻辑 | `POST` 且路径为 `/api/chat` 的分支内 |
| 查看解析后的请求体、`stream` 标志 | `readBody` 之后、`JSON.parse` 之后 |
| 与网页行为一致（流式） | `body.stream === true` 分支，或 `proxyChatStream` 内（如对上游 `fetch`） |
| 非流式（整段 JSON 返回） | `await proxyChat(...)` 或 `proxyChat` 内部 |

前端默认发送 **`stream: true`**，因此常见调试路径是 **`proxyChatStream`**，而不是非流式的 `proxyChat`。

### 触发请求的方式

**方式 A：浏览器（与线上一致）**

访问 `http://127.0.0.1:8787`，在页面输入并提交，会向 `/api/chat` 发送带 `stream: true` 的请求。

**方式 B：`curl` 非流式（便于观察整段 JSON）**

```bash
curl -s -X POST http://127.0.0.1:8787/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"你好"}]}'
```

**方式 C：`curl` 流式（与前端一致）**

```bash
curl -N -X POST http://127.0.0.1:8787/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"你好"}],"stream":true}'
```

未配置 `DASHSCOPE_API_KEY` 时，接口可能直接返回 500；仍可先在进入处理逻辑处下断点，确认请求是否到达服务端。

## 请求耗时日志

服务端在成功或失败路径会打印类似日志，便于判断单次 `/api/chat` 总耗时（从通过校验并准备调用模型开始计时）：

- `[api/chat] stream completed in …ms`：流式正常结束
- `[api/chat] stream failed in …ms`：流式路径出错
- `[api/chat] completed in …ms`：非流式成功
- `[api/chat] completed with error in …ms`：非流式或外层错误（若在解析请求体阶段失败，可能无此项）

## 调试语音桥接 `/api/asr/stream`

- 语音使用 **WebSocket**，由 `server.mjs` 的 **`server.on("upgrade", …)`** 处理路径 **`/api/asr/stream`**，逻辑在 **`attachDashScopeAsrBridge`**。
- 未配置 **`DASHSCOPE_API_KEY`** 时，浏览器连接后服务端会推送 JSON **`{ type: "error", message: "…" }`** 并关闭连接。
- 成功链路：百炼返回 **`task-started`** → 服务端向浏览器发 **`{ type: "ready" }`** → 前端开始发送 PCM 二进制帧。
- 服务端错误会打印 **`[api/asr]`** 前缀日志，可与浏览器控制台中的 WebSocket 报错对照。

详细协议与环境变量见 **`docs/asr-voice.md`**。

## 相关文件

- `server.mjs`：HTTP 服务、`/api/chat` 代理、`/api/asr/stream` WebSocket 升级与百炼桥接
- `.vscode/launch.json`：调试启动与附加配置
- `package.json` 中的 `debug` / `debug-brk` 脚本
