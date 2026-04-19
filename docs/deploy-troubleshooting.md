# 阿里云 ECS 部署排错与操作备忘

本文汇总在 Linux 服务器（含阿里云 ECS）上部署本项目时常见问题：**现象 → 原因 → 处理**。项目入口为 `server.mjs`，默认端口 **`PORT` 未设置时为 8787**，依赖见根目录 `package.json`（含 `dotenv`）。

---

## 1. 概念与选型（非报错）

| 话题 | 说明 |
|------|------|
| 宝塔面板 | **非必需**。可选图形化管理 Nginx、SSL、文件等；熟悉命令行可不用。 |
| LNMP | 指 Linux + Nginx + MySQL + **PHP**。本项目是 **Node**，通常只需 **Linux + Nginx 反代到 Node**；MySQL/PHP 按是否需要再装。 |
| 项目目录 | 常见 **`/var/www/项目名`** 或 **`/home/用户名/项目名`**。关键是路径真实存在，且与 systemd、`nginx` 配置一致。 |
| ECS 带宽 | 个人/小流量可先 **1～3 Mbps**，偏体验选 **3～5 Mbps**；以云监控为准再调。 |
| 地域（如乌兰察布 / 北京） | 华北用户、产品线齐全可偏 **北京**；偏成本可看 **乌兰察布**。与通义 API 调用无强绑定。 |

---

## 2. `curl http://127.0.0.1:8787` 失败

| 现象 | 原因 | 处理 |
|------|------|------|
| `Connection refused` | 本机无进程监听该端口 | 确认服务已启动：`systemctl status sincere-words.service`；`ss -tlnp \| grep 8787` |
| 仍 refused | 端口不是 8787 | 查 `.env` 中 `PORT=`，curl 改用对应端口 |
| 在自己电脑 curl、服务在 ECS | 连的是本机不是 ECS | SSH 进 ECS 再 curl `127.0.0.1`，或对 ECS 公网 IP + 安全组放行 |

---

## 3. Nginx：仍显示默认欢迎页

| 原因 | 处理 |
|------|------|
| 默认站点占用 `listen 80` | 将 **`/etc/nginx/conf.d/default.conf`** 改名备份，如 `default.conf.bak` |
| 用公网 IP 访问未命中你的 `server` | 在自有站点配置中写 `listen 80 default_server;`，`server_name _;`（仅 IP 时） |
| 配置未生效 | `sudo nginx -t && sudo systemctl reload nginx` |

反代 Node 时建议：`proxy_pass http://127.0.0.1:8787;`，流式接口加 `proxy_buffering off;`、`proxy_read_timeout` 足够长。

**配置文件位置**：无 `sites-enabled` 时（常见于 CentOS / Alibaba Cloud Linux），使用 **`/etc/nginx/conf.d/*.conf`**；Debian/Ubuntu 常见 **`/etc/nginx/sites-available/`** 并软链到 **`sites-enabled/`**。

---

## 4. systemd 报错码与处理

单元文件路径一般为 **`/etc/systemd/system/sincere-words.service`**（名称以你为准）。修改后执行 **`systemctl daemon-reload`**。

### `status=217/USER`

| 原因 | 处理 |
|------|------|
| `User=` 用户不存在 | Debian 系常用 `www-data`；**CentOS / 阿里云系常无该用户**。改为 **`nginx`**（若存在）或自建用户，或临时去掉 `User=` 验证 |

### `status=203/EXEC`

| 原因 | 处理 |
|------|------|
| 无法执行 `ExecStart` 中的程序 | 确认 **`/usr/bin/node` 存在**（`which node`） |
| Node 装在 **`/root/.nvm/...`**，服务以 **非 root** 运行 | 非 root **无法进入 `/root`**。改用系统 **`/usr/bin/node`**，或将 Node 装在部署用户目录并保证该用户可读 |

### `status=200/CHDIR`

| 原因 | 处理 |
|------|------|
| `WorkingDirectory=` 不存在或不可进入 | 核对路径；对 **`/`、`/var`、`/var/www`、项目目录** 保证 `User=` 有 **执行权限**（`namei -l` 检查）；`chown`/`chmod` |

### `status=1/FAILURE`（Node 已启动但立即退出）

**先看日志**：

```bash
journalctl -u sincere-words.service -n 80 --no-pager
```

| 日志关键词 | 原因 | 处理 |
|------------|------|------|
| `Cannot find module '.../server.mjs'` | `ExecStart` / `WorkingDirectory` 路径错误 | 用 `find`/`ls` 确认 `server.mjs` 真实路径；**两处统一为同一项目根目录的绝对路径** |
| `Cannot find package 'dotenv'` / `ERR_MODULE_NOT_FOUND` | 未安装依赖 | 在**含 `package.json` 的目录**执行 **`npm install`**（或 `npm install --production`） |
| `EADDRINUSE` | 端口占用 | 修改 `.env` 中 `PORT` 或结束占用进程 |
| `EACCES` | 权限不足 | `chown -R 运行用户:组 项目目录`，保证可读 `.env` 与 `node_modules` |

**推荐 `ExecStart` 写法**（避免相对路径歧义）：

```ini
WorkingDirectory=/实际路径/项目根目录
ExecStart=/usr/bin/node /实际路径/项目根目录/server.mjs
User=运行用户
```

修改后：`systemctl daemon-reload && systemctl restart sincere-words.service`。

### `Start request repeated too quickly`

短时间内连续崩溃触发频率限制。修好根因后：

```bash
systemctl reset-failed sincere-words.service
```

---

## 5. 路径重复导致找不到 `server.mjs`

**现象**：日志中路径形如 `/var/www/sincere-words/SincereWordsOfLove/server.mjs`，但磁盘上并非此结构。

**原因**：`ExecStart` 或部署目录多包了一层文件夹。

**处理**：以 **`find /var/www -name server.mjs`** 为准，**`WorkingDirectory` 与 `ExecStart` 中的 `server.mjs` 必须指向真实文件**。

---

## 6. 域名与解析

| 记录 | 含义 |
|------|------|
| 主机 **@** | 根域名，如 `example.com` |
| 主机 **www** | `www.example.com` |

两者可同时 **A 记录指向同一 ECS 公网 IP**；Nginx 里 `server_name` 写实际域名。

---

## 7. `ExecStart` 用绝对路径还是相对路径

- **可执行文件**（`node`）：使用 **绝对路径**（如 `/usr/bin/node`）。
- **脚本**：建议使用 **`server.mjs` 的绝对路径**，并设置正确的 **`WorkingDirectory`**（与 `dotenv` 加载 `.env` 的当前工作目录一致）。

---

## 8. 部署检查清单（上线前）

- [ ] 项目目录存在，`server.mjs`、`package.json`、`public/` 齐全  
- [ ] 在项目根目录执行过 **`npm install`**，无 `dotenv` 等模块缺失  
- [ ] **`.env`** 已配置（至少 **`DASHSCOPE_API_KEY`**），权限仅运行用户可读  
- [ ] **`systemctl status`** 为 `active (running)`，**`ss -tlnp`** 能看到监听端口  
- [ ] **Nginx** 反代到该端口，已去掉或禁用默认站点，**`nginx -t`** 通过  
- [ ] 若使用**语音输入**：已安装依赖 **`ws`**（`npm install`），且反代支持 **WebSocket**（见下文第 9 节）  
- [ ] 安全组放行 **80/443**；不建议把 Node 端口直接对公网大开  

---

## 9. 语音输入与 WebSocket（Nginx 反代）

本项目语音经浏览器 **`WebSocket`** 访问同源路径 **`/api/asr/stream`**，由 Node **`upgrade`** 转发至百炼实时识别。若仅配置了普通 HTTP 反代、未透传升级头，会出现语音连接失败或立即断开。

**建议在反代 Node 的 `location` 中增加**（可与现有 `proxy_pass` 并存）：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 3600s;
```

公网使用语音需 **HTTPS**（页面以 **`https://`** 打开），浏览器才会稳定允许麦克风，且 WebSocket 为 **`wss://`**。

更细的协议与变量说明见 **`docs/asr-voice.md`**。

---

## 相关文档

- 本地运行与环境变量：仓库根目录 `README.md`  
- 后端调试：`docs/backend-debug.md`  
- 语音输入（Paraformer）：`docs/asr-voice.md`