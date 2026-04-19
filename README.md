# 爱的真心话（SincereWordsOfLove）

一个本地运行的网页小工具：输入父母对孩子说的话，通过**阿里云通义千问（DashScope）**生成「父母真心话」——以父母内心视角、柔和简短地表达话语背后的在乎与担心。

## 功能概览

- **对话式界面**：保留多轮上下文，持续输入父母原话并查看解读。
- **语音输入**（可选）：麦克风音频经本站 **`/api/asr/stream` WebSocket** 转发至**百炼实时语音识别**（默认模型 **Paraformer** `paraformer-realtime-v2`），与对话接口**共用 `DASHSCOPE_API_KEY`**。需允许网页使用麦克风；公网部署请使用 **HTTPS**（与 WebRTC/getUserMedia 要求一致）。可通过环境变量 `DASHSCOPE_ASR_WSS`、`DASHSCOPE_ASR_MODEL` 切换地域或模型（见 `.env.example`）。
- **输出约束**：服务端固定系统提示，要求模型以第一人称、**50 个汉字以内（含标点）**、语气柔和、无列表与套话。
- **密钥与跨域**：浏览器只访问本地服务；`DASHSCOPE_API_KEY` 由服务端读取，不暴露给前端。

## 环境要求

- **Node.js** 18 及以上（内置 `fetch`）
- 有效的 **DashScope API Key**（百炼 / Model Studio）

## 快速开始

```bash
cd /path/to/SincereWordsOfLove
cp .env.example .env
# 编辑 .env，填写 DASHSCOPE_API_KEY
npm install
npm start
```

浏览器访问终端中提示的地址（默认 **http://127.0.0.1:8787**）。
确认本机可访问：curl -sS http://127.0.0.1:8787/ 应有 HTML。

后端调试步骤（断点、`/api/chat`、curl、`--inspect`）见 **[docs/backend-debug.md](docs/backend-debug.md)**。

在阿里云 ECS 等平台部署时，systemd、Nginx、`npm install`、路径与权限等问题见 **[docs/deploy-troubleshooting.md](docs/deploy-troubleshooting.md)**。

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `DASHSCOPE_API_KEY` | 通义千问 API 密钥（必填） | 无 |
| `DASHSCOPE_BASE_URL` | 兼容 OpenAI 的 Chat 接口根 URL | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `DASHSCOPE_MODEL` | 模型名（追求速度可用 `qwen-turbo`、`qwen3.5-flash` 等） | `qwen-turbo` |
| `DASHSCOPE_MAX_TOKENS` | 单次生成上限（本应用输出很短，可保持较小以略减耗时） | `128` |
| `CHAT_MAX_MESSAGES` | 每次请求只带最近几条对话，避免会话过长拖慢接口 | `12` |
| `PORT` | 本地 HTTP 端口 | `8787` |
| `DASHSCOPE_ASR_WSS` | 百炼实时语音识别 WebSocket 根地址 | `wss://dashscope.aliyuncs.com/api-ws/v1/inference/` |
| `DASHSCOPE_ASR_MODEL` | 实时 ASR 模型名（如 Paraformer） | `paraformer-realtime-v2` |

**若 `/api/chat` 很慢（例如数十秒）**：多半是上游模型与网络延迟。请确认 Key 与 `DASHSCOPE_BASE_URL` 区域一致；选用 Flash / Turbo 等轻量模型；对话轮数多时可依赖 `CHAT_MAX_MESSAGES` 截断上下文；海外访问国内 endpoint 可能明显变慢。

国内与北京区域一般使用默认 `BASE_URL`；**国际或其他区域**请按[阿里云 Model Studio 文档](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)将 `DASHSCOPE_BASE_URL` 改为对应兼容接口地址，并确保 Key 与区域一致。

`.env` 已在 `.gitignore` 中忽略，请勿将真实密钥提交到仓库。

## 项目结构

```
SincereWordsOfLove/
├── server.mjs          # HTTP 服务：静态资源 + /api/chat + /api/asr/stream（语音桥接）
├── package.json
├── .env.example        # 环境变量模板
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js          # 前端对话逻辑
└── docs/
    ├── backend-debug.md           # 后端与 /api/chat 调试说明
    ├── deploy-troubleshooting.md  # 服务器部署排错备忘
    ├── asr-voice.md             # 语音输入（百炼 Paraformer）说明
    └── 当前进度.md                # 实现进度与后续方向
```

## 接口说明（内部）

- `POST /api/chat`  
  - 请求体：`{ "messages": [ { "role": "user"|"assistant", "content": "..." }, ... ] }`  
  - 成功：`{ "content": "模型回复文本" }`  
  - 服务端会在最前附加一条 `system` 提示，再转发至 DashScope。
- `WebSocket /api/asr/stream`  
  - 浏览器采集麦克风 PCM（16 kHz）后经本站转发至百炼实时语音识别（默认 Paraformer），详见 **`docs/asr-voice.md`**。

## 许可证

私有项目；按需自行补充许可证文件。
