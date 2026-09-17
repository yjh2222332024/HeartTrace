# 依赖清单

> 本项目的全部外部依赖。npm 依赖见 [love-advisor/package.json](../love-advisor/package.json)，此处记录其之外的运行时环境、全局工具与外部程序。

## 运行时环境

| 组件 | 版本要求 | 本机实测 | 说明 |
|---|---|---|---|
| Node.js | >= 18 | v22.20.0 | 服务端使用内置 `fetch`、`AbortSignal.timeout`，无需 polyfill |
| npm | 随 Node | — | `npm install`（love-advisor 目录）与全局工具安装 |
| Python 3 | 3.x | — | 仅根目录提取/构建脚本使用，纯标准库（json / os / pathlib / collections），无 pip 依赖 |

## npm 依赖（love-advisor）

安装方式：`cd love-advisor && npm install`

- 运行时：`express ^5.2.1`、`vue ^3.5.13`、`marked`、`dompurify`
- 开发：`vite ^6.0.11`、`@vitejs/plugin-vue`、`tailwindcss ^3.4.17`、`autoprefixer`、`postcss`、`concurrently`
- 测试：`npm test`（Node 内置 test runner，无需额外框架）

## 全局 npm 工具

| 工具 | 版本 | 用途 | 安装命令 |
|---|---|---|---|
| chatlab-cli（`clb`） | 0.37.1 | 聊天记录导入 / 统计 / SQL / 检索，被 `love-advisor/server/qce.js`、`chatlab.js` 调用 | `npm i -g chatlab-cli` |

说明：服务端优先直接运行 `%APPDATA%\npm\node_modules\chatlab-cli\bin\chatlab.mjs`，找不到时回退 PATH 中的 `clb.cmd`（见 [qce.js](../love-advisor/server/qce.js)）。必须全局安装，本地安装不会进入服务端的查找路径。

## 外部程序：QQ Chat Exporter (QCE)

| 项 | 值 |
|---|---|
| 版本 | v6.2.10（当前最新 release） |
| 仓库 | https://github.com/shuakami/qq-chat-exporter |
| Windows 一键安装包 | `QQChatExporter-Installer-v6.2.10.exe`（约 48.8 MB） |
| 安装路径（默认） | `%LOCALAPPDATA%\QQChatExporter\QQ Chat Exporter.exe` |
| 服务端口 | `http://localhost:40653`（仅本机回环） |

- 下载地址：https://github.com/shuakami/qq-chat-exporter/releases/download/v6.2.10/QQChatExporter-Installer-v6.2.10.exe
- 其余平台资产：`NapCat-QCE-Windows-x64-v6.2.10.zip`（Shell 模式）、`NapCat-Framework-QCE-v6.2.10.zip`（QQNT 插件）、`napcat-plugin-qce.zip`（NapCat 插件商店）
- 与服务端的集成见 [qce.js](../love-advisor/server/qce.js)：启动探测 `/health`、好友/群列表、导出任务、成品下载后经 `clb` 入库
- QCE 访问令牌（Token）：通常**无需手动填写**——v6.x 每次登录会轮换 accessToken 并写入 `%LOCALAPPDATA%\QQChatExporter\.qce-config\security.json`，服务端会自动读取（见 [qce.js](../love-advisor/server/qce.js) 的 `readQceToken`）。浏览器端也可在「设置 / 导入」对话框粘贴 token（存浏览器设置，以 `X-QCE-Token` 头发送，优先级最高）
- 根目录 [.env](../.env) 中的 `QCE_TOKEN` / `QCE_PATH` 均为可选的服务端兜底：`QCE_TOKEN` 仅在 security.json 不可读且请求未带 token 头时使用；`QCE_PATH` 仅在安装到非默认路径时需要指定（默认路径服务端可自动探测）

## 模型服务（.env 配置）

OpenAI 兼容接口，见根目录 [.env.example](../.env.example)：

| 变量 | 说明 |
|---|---|
| `BASE_URL` | OpenAI 兼容 API 地址（含 `/v1`） |
| `API_KEY` | Bearer 令牌 |
| `BASE_MODEL` | 模型名（当前 `dots3-note-prev`，推理模型，服务端会转发 `reasoning_content`） |
