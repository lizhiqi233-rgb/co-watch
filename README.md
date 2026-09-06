# co-watch · 协同浏览

面向 Chrome / Chromium 内核浏览器的协同浏览扩展，配合自建 WebSocket 房间服务，可在小范围内**同步打开网页**、**同步 HTML5 视频进度**，适合熟人一起看视频或共同浏览。

仓库地址：<https://github.com/lizhiqi233-rgb/co-watch>

当前版本：**服务端 2.1.4 / 扩展 2.2.0**（服务端与扩展版本按各自发布节奏维护）。

---

## 功能概览

- **房间**：使用同一房间口令加入；首位进入者为房主，离开后自动移交新房主。
- **页面同步**：房主绑定「跟随标签」，换页可向全员广播跳转；成员跟随房间当前 URL。
- **播放列表**：队列、已读/在看状态、房主选片与自动连播（见扩展侧逻辑）。
- **视频同步**：房主侧进度 / 暂停 / 倍速等同步给房间内其他人（由内容脚本配合）。
- **扩展热更新**：服务端可提供 `extension.zip`（或带版本号的 zip）供扩展检测更新（可选）。

---

## 仓库结构

```text
co-watch/
├── LICENSE                 # MIT
├── README.md
└── server/
    ├── package.json
    ├── package-lock.json
    ├── index.js            # Server entry point
    ├── server/             # WebSocket + HTTP room service
    │   ├── index.js
    │   ├── http.js
    │   ├── connection.js
    │   ├── protocol/
    │   └── rooms/
    └── extension/          # Chrome extension (Manifest V3)
        ├── manifest.json
        ├── background/
        ├── content/
        ├── popup/
        └── shared/
```

---

## 环境要求

- **服务端**：Node.js ≥ 10（建议当前 LTS）。
- **浏览器**：Chromium 内核，版本不低于扩展清单中的 `minimum_chrome_version`（当前为 **116**）。

---

## 快速开始：服务端

在 `server` 目录安装依赖并启动：

```bash
cd server
npm install
npm start
```

默认监听 **`ws://127.0.0.1:15777`**（HTTP 与 WebSocket 共用同一端口）。

健康检查：<http://127.0.0.1:15777/health>

打包扩展目录下载（便于分发更新）：<http://127.0.0.1:15777/extension.zip>  
带版本路径：<http://127.0.0.1:15777/extension-2.2.0.zip>（版本须与 `extension/manifest.json` 中 `version` 一致）。

---

## 快速开始：浏览器扩展

1. 打开 Chrome：**扩展程序 → 管理扩展程序 → 开发者模式**。
2. **加载已解压的扩展程序**，选择本仓库中的 **`server/extension`** 目录。
3. 点击扩展图标，在弹出页面中配置 **WebSocket 地址**（默认 `ws://127.0.0.1:15777`，若服务端在其他机器请改为对应 IP/域名与端口）。
4. 输入房间口令进入房间；房主需**绑定跟随标签**以便驱动同步。

---

## 服务端环境变量（可选）

| 变量 | 说明 | 默认 |
|------|------|------|
| `PORT` | HTTP/WebSocket 端口 | `15777` |
| `EXTENSION_DIR` | 扩展目录绝对路径；不配则使用 `server/extension` | 内置路径 |
| `CO_WATCH_DEBUG` / `DEBUG=co-watch` | 打印调试日志 | 关闭 |
| `IDLE_CLOSE_MS` | 长时间无任何消息则断开连接（毫秒） | `90000` |
| `IDLE_SWEEP_MS` | 空闲检测扫描间隔（毫秒） | `15000` |
| `JUMP_DESYNC_KICK_MS` | 成员列表「跳转对齐」持续为 ✗ 超过该时间则移出连接（房主会移交） | `60000` |

---

## 安全与使用提示

本工具按**熟人小范围自用**场景设计：**房间口令不等于强鉴权**，请勿将未做额外防护的服务端长期暴露在公网。若需对外部署，请自行配合防火墙、VPN、反向代理与访问控制。

---

## 开源协议

本项目以 **MIT License** 发布，详见仓库中的 [LICENSE](LICENSE)。
