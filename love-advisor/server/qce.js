import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

// QCE 主程序（Tauri 壳：拉起 NapCat 扫码登录 + qce-server）默认安装位置
const DEFAULT_QCE_EXE = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'QQChatExporter', 'QQ Chat Exporter.exe')
  : ''

// ── QCE (QQ Chat Exporter) 服务端客户端 ───────────────
// 文档参考：qq-chat-exporter-6.2.10/qq-chat-export-server
// 默认 http://localhost:40653，token 认证（Bearer / ?token= / X-Access-Token）
// chatType: 2 = 群聊，其它 = 好友单聊

const DEFAULT_QCE_BASE = 'http://localhost:40653'

export function qceConfig(req) {
  const base = (req.headers['x-qce-base'] || DEFAULT_QCE_BASE).replace(/\/+$/, '')
  const token = req.headers['x-qce-token'] || process.env.QCE_TOKEN || ''
  return { base, token }
}

async function qceFetch({ base, token }, urlPath, options = {}) {
  const sep = urlPath.includes('?') ? '&' : '?'
  const url = `${base}${urlPath}${token ? `${sep}token=${encodeURIComponent(token)}` : ''}`
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(options.timeout || 15000),
  })
  return res
}

// QCE 统一响应包装 {ok/requestId, data|error} → 归一化
function unwrapQce(j) {
  if (j && typeof j === 'object' && 'ok' in j) {
    if (!j.ok) throw new Error(j.error?.message || j.error || 'QCE 返回错误')
    return j.data
  }
  return j // /health 等非标准端点直接返回
}

// ── clb 导入（从 handleImport 抽出，供文件上传和 QQ 直连共用） ──
// Windows 下优先直接用 node 跑 chatlab-cli 的 mjs 入口：绕过 cmd.exe，
// 长参数（如多行 SQL）不会被 shell 打碎；找不到时退回 shell 方式。
const CLB_MJS = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'chatlab-cli', 'bin', 'chatlab.mjs')
  : ''

function clbRaw(args) {
  return new Promise((resolve, reject) => {
    const useMjs = fs.existsSync(CLB_MJS)
    const child = useMjs
      ? spawn(process.execPath, [CLB_MJS, ...args])
      : spawn(process.platform === 'win32' ? 'clb.cmd' : 'clb', args, { shell: true })
    let out = '', err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`clb exit ${code}: ${err || out}`))
      resolve(out)
    })
    child.on('error', reject)
  })
}

// 全局串行队列：clb 进程并发会争写 .chatlab-meta.json（EPERM），
// 导入、统计、SQL、消息检索全部排队执行
let clbQueue = Promise.resolve()
export function clb(args) {
  const p = clbQueue.then(() => clbRaw(args), () => clbRaw(args))
  clbQueue = p.catch(() => {})
  return p
}

export function extractJson(raw) {
  for (const l of raw.split('\n').map(l => l.trim()).filter(Boolean)) {
    if (l.startsWith('{')) {
      try { return JSON.parse(l) } catch { /* 下一条 */ }
    }
  }
  throw new Error('无法解析 clb 输出')
}

export async function clbImportBuffer(fileBuf, filename, dryRun) {
  const safeName = filename.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')
  const tmp = path.join(os.tmpdir(), `love-advisor-${Date.now()}-${safeName}`)
  fs.writeFileSync(tmp, fileBuf)
  try {
    const args = ['import', tmp, '--json']
    if (dryRun) args.push('--dry-run')
    const j = extractJson(await clb(args))
    if (!j.ok) throw new Error(j.error?.message || 'clb 返回错误')
    const d = j.data
    return dryRun ? {
      name: d.meta?.name || filename,
      platform: d.meta?.platform || 'unknown',
      type: d.meta?.type || 'private',
      totalMessageCount: d.totalMessageCount,
      newMessageCount: d.newMessageCount,
      duplicateCount: d.duplicateCount,
    } : {
      sessionId: d.sessionId,
      name: d.meta?.name || filename,
      platform: d.meta?.platform,
      totalMessages: d.newMessageCount,
    }
  } finally {
    fs.unlink(tmp, () => {})
  }
}

// ── 注册路由 ─────────────────────────────────────────
export function registerQceRoutes(app) {
  // 自动启动 QCE 主程序（探活 → spawn → 由前端轮询 /api/qq/status 等上线）
  app.post('/api/qq/launch', async (req, res) => {
    try {
      // 已在线则无需启动
      try {
        const h = await qceFetch(qceConfig(req), '/health', { timeout: 3000 })
        if (h.ok) return res.json({ ok: true, data: { alreadyRunning: true } })
      } catch { /* 未在线，继续启动流程 */ }

      const exePath = (
        req.headers['x-qce-path'] || process.env.QCE_PATH || DEFAULT_QCE_EXE || ''
      ).trim()
      if (!exePath || !fs.existsSync(exePath)) {
        return res.status(400).json({
          ok: false,
          error: '未找到 QCE 程序，请在设置中填写 QCE 程序路径（如 %LOCALAPPDATA%\\QQChatExporter\\QQ Chat Exporter.exe）',
          code: 'EXE_NOT_FOUND',
        })
      }
      // detached：QCE 独立于我们后端生命周期；窗口由 QCE 自己弹出（扫码登录用）
      const child = spawn(exePath, [], {
        detached: true,
        stdio: 'ignore',
        cwd: path.dirname(exePath),
      })
      child.unref()
      res.json({ ok: true, data: { launched: true, exePath } })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  // 状态检测：health（无需 token）+ auth（验证 token 有效性）
  app.get('/api/qq/status', async (req, res) => {
    const cfg = qceConfig(req)
    try {
      const health = await qceFetch(cfg, '/health')
      const online = health.ok
      let authenticated = false
      if (online && cfg.token) {
        try {
          const auth = await qceFetch(cfg, '/security-status', { timeout: 5000 })
          const aj = await auth.json().catch(() => ({}))
          authenticated = !!(aj?.data?.authenticated ?? aj?.authenticated) || !!(aj?.data?.enabled === false)
        } catch { authenticated = false }
      }
      res.json({ ok: true, data: { online, authenticated, hasToken: !!cfg.token, base: cfg.base } })
    } catch {
      res.json({ ok: true, data: { online: false, authenticated: false, hasToken: !!cfg.token, base: cfg.base } })
    }
  })

  // 好友 / 群列表（透传）
  app.get('/api/qq/friends', async (req, res) => {
    try {
      const r = await qceFetch(qceConfig(req), '/api/friends')
      const j = await r.json()
      res.json({ ok: true, data: unwrapQce(j) })
    } catch (e) { res.status(502).json({ ok: false, error: e.message }) }
  })
  app.get('/api/qq/groups', async (req, res) => {
    try {
      const r = await qceFetch(qceConfig(req), '/api/groups')
      const j = await r.json()
      res.json({ ok: true, data: unwrapQce(j) })
    } catch (e) { res.status(502).json({ ok: false, error: e.message }) }
  })

  // 创建导出任务（固定 JSON 格式）
  app.post('/api/qq/export', async (req, res) => {
    try {
      const { chatType, peerUid, sessionName, filter } = req.body
      if (!peerUid || chatType === undefined) {
        return res.status(400).json({ ok: false, error: '缺少 peerUid 或 chatType' })
      }
      const body = {
        peer: { chatType: Number(chatType), peerUid },
        format: 'JSON',
        sessionName: sessionName || '',
        ...(filter ? { filter } : {}),
      }
      const r = await qceFetch(qceConfig(req), '/api/messages/export', {
        method: 'POST',
        body: JSON.stringify(body),
        timeout: 30000,
      })
      const j = await r.json()
      res.json({ ok: true, data: unwrapQce(j) })
    } catch (e) { res.status(502).json({ ok: false, error: e.message }) }
  })

  // 任务进度查询
  app.get('/api/qq/tasks/:taskId', async (req, res) => {
    try {
      const r = await qceFetch(qceConfig(req), `/api/tasks/${encodeURIComponent(req.params.taskId)}`)
      const j = await r.json()
      res.json({ ok: true, data: unwrapQce(j) })
    } catch (e) { res.status(502).json({ ok: false, error: e.message }) }
  })

  // 终极接力：下载 QCE 导出成品 → clb 入库 → 返回 sessionId
  app.post('/api/qq/import', async (req, res) => {
    try {
      const { downloadUrl, fileName } = req.body
      if (!downloadUrl) return res.status(400).json({ ok: false, error: '缺少 downloadUrl' })
      const cfg = qceConfig(req)
      const url = downloadUrl.startsWith('http') ? downloadUrl : cfg.base + (downloadUrl.startsWith('/') ? '' : '/') + downloadUrl
      const fileRes = await fetch(url, {
        headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
        signal: AbortSignal.timeout(120000),
      })
      if (!fileRes.ok) throw new Error(`下载导出文件失败: HTTP ${fileRes.status}`)
      const buf = Buffer.from(await fileRes.arrayBuffer())
      const name = fileName || url.split('/').pop() || 'qce-export.json'
      const result = await clbImportBuffer(buf, name, false)
      res.json({ ok: true, data: result })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })
}
