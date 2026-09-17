#!/usr/bin/env node
// ── 心迹 CLI 一键启动入口（兼容 love-advisor 命令）──────────
import { startServer } from '../server/index.js'
import { exec } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))

const args = process.argv.slice(2)

if (args.includes('-h') || args.includes('--help')) {
  console.log(`
  🌸 心迹 HeartTrace v${pkg.version}
  关系理解与对话训练工作台

  用法:
    npx love-advisor [选项]
    love-advisor [选项]

  选项:
    -p, --port <port>   指定服务端口（默认: 3111）
    --host <host>       指定监听地址（默认: 127.0.0.1）
    --no-open           启动后不自动打开浏览器
    -v, --version       查看版本号
    -h, --help          查看帮助
`)
  process.exit(0)
}

if (args.includes('-v') || args.includes('--version')) {
  console.log(`v${pkg.version}`)
  process.exit(0)
}

// 解析端口
let port = 3111
const portIdx = args.findIndex(a => a === '-p' || a === '--port')
if (portIdx >= 0 && args[portIdx + 1]) {
  const p = Number(args[portIdx + 1])
  if (Number.isInteger(p) && p > 0 && p < 65536) port = p
} else if (process.env.PORT) {
  const p = Number(process.env.PORT)
  if (Number.isInteger(p) && p > 0 && p < 65536) port = p
}

// 解析主机
let host = '127.0.0.1'
const hostIdx = args.findIndex(a => a === '--host')
if (hostIdx >= 0 && args[hostIdx + 1]) {
  host = args[hostIdx + 1].trim()
} else if (process.env.HOST) {
  host = process.env.HOST.trim()
}

const noOpen = args.includes('--no-open')

function openBrowser(url) {
  const plat = process.platform
  try {
    if (plat === 'win32') {
      exec(`start "" "${url}"`)
    } else if (plat === 'darwin') {
      exec(`open "${url}"`)
    } else {
      exec(`xdg-open "${url}"`)
    }
  } catch {
    // 忽略打开失败（如无头服务器环境）
  }
}

async function main() {
  try {
    const { url } = await startServer({ port, host })

    console.log(`
  ┌────────────────────────────────────────────────────┐
  │                                                    │
  │   🌸 心迹 (HeartTrace) v${pkg.version.padEnd(6)}                   │
  │   关系理解与对话训练工作台已就绪                    │
  │                                                    │
  │   ➜ 本地访问:  \x1b[36m${url}\x1b[0m               │
  │   ➜ 按 Ctrl+C 即可停止服务                         │
  │                                                    │
  └────────────────────────────────────────────────────┘
`)

    if (!noOpen) {
      // 稍微延迟 100ms 确保端口就绪后弹窗
      setTimeout(() => openBrowser(url), 100)
    }
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`\x1b[31m[错误] 端口 ${port} 已被占用。请使用 -p 指定其他端口，例如：npx love-advisor -p 3222\x1b[0m`)
    } else {
      console.error(`\x1b[31m[错误] 启动失败: ${err.message}\x1b[0m`)
    }
    process.exit(1)
  }
}

main()
