# 爱的真心话（SincereWordsOfLove）

一个本地运行的网页小工具：输入父母对孩子说的话，通过**阿里云通义千问（DashScope）**生成「父母真心话」——以父母内心视角、柔和简短地表达话语背后的在乎与担心。

## 功能概览

- **对话式界面**：保留多轮上下文，持续输入父母原话并查看解读。
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

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `DASHSCOPE_API_KEY` | 通义千问 API 密钥（必填） | 无 |
| `DASHSCOPE_BASE_URL` | 兼容 OpenAI 的 Chat 接口根 URL | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `DASHSCOPE_MODEL` | 模型名 | `qwen-turbo` |
| `PORT` | 本地 HTTP 端口 | `8787` |

国内与北京区域一般使用默认 `BASE_URL`；**国际或其他区域**请按[阿里云 Model Studio 文档](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)将 `DASHSCOPE_BASE_URL` 改为对应兼容接口地址，并确保 Key 与区域一致。

`.env` 已在 `.gitignore` 中忽略，请勿将真实密钥提交到仓库。

## 项目结构

```
SincereWordsOfLove/
├── server.mjs          # HTTP 服务：静态资源 + /api/chat 代理
├── package.json
├── .env.example        # 环境变量模板
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js          # 前端对话逻辑
└── docs/
    └── 当前进度.md     # 实现进度与后续方向
```

## 接口说明（内部）

- `POST /api/chat`  
  - 请求体：`{ "messages": [ { "role": "user"|"assistant", "content": "..." }, ... ] }`  
  - 成功：`{ "content": "模型回复文本" }`  
  - 服务端会在最前附加一条 `system` 提示，再转发至 DashScope。

## 许可证

私有项目；按需自行补充许可证文件。
