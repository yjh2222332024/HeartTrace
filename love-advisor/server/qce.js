import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { TOOL_ERROR_CODES, normalizeToolError, toolError } from './tool-errors.js'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// QCE 主程序（Tauri 壳：拉起 NapCat 扫码登录 + qce-server）默认安装位置
const DEFAULT_QCE_EXE = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'QQChatExporter', 'QQ Chat Exporter.exe')
  : ''

// ── QCE (QQ Chat Exporter) 服务端客户端 ───────────────
// 文档参考：qq-chat-exporter-6.2.10/qq-chat-export-server
// 默认 http://localhost:40653，token 认证（Bearer / ?token= / X-Access-Token）
// chatType: 2 = 群聊，其它 = 好友单聊

const DEFAULT_QCE_BASE = 'http://localhost:40653'
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
export const MAX_IMPORT_JSON_NESTING = 80

// ChatLab CLI bundles stream-json for import parsing. Reject pathological nesting before
// handing JSON to the CLI so a crafted local import cannot monopolize its event loop.
export function assertSafeImportJsonNesting(fileBuf) {
  let first = 0
  while (first < fileBuf.length && /\s/.test(String.fromCharCode(fileBuf[first]))) first += 1
  if (fileBuf[first] !== 0x7B && fileBuf[first] !== 0x5B) return

  let depth = 0
  let quoted = false
  let escaped = false
  for (const byte of fileBuf) {
    if (quoted) {
      if (escaped) escaped = false
      else if (byte === 0x5C) escaped = true
      else if (byte === 0x22) quoted = false
      continue
    }
    if (byte === 0x22) quoted = true
    else if (byte === 0x7B || byte === 0x5B) {
      depth += 1
      if (depth > MAX_IMPORT_JSON_NESTING) {
        throw new Error(`导入 JSON 嵌套层级超过 ${MAX_IMPORT_JSON_NESTING}，请检查文件是否异常`)
      }
    } else if (byte === 0x7D || byte === 0x5D) {
      depth = Math.max(0, depth - 1)
    }
  }
}

export function getTrustedQceDirs() {
  const dirs = new Set()
  if (process.env.LOCALAPPDATA) {
    dirs.add(path.resolve(path.join(process.env.LOCALAPPDATA, 'QQChatExporter')))
  }
  if (process.env.ProgramFiles) {
    dirs.add(path.resolve(path.join(process.env.ProgramFiles, 'QQChatExporter')))
  }
  if (process.env['ProgramFiles(x86)']) {
    dirs.add(path.resolve(path.join(process.env['ProgramFiles(x86)'], 'QQChatExporter')))
  }
  if (process.env.QCE_PATH) {
    dirs.add(path.resolve(path.dirname(process.env.QCE_PATH)))
  }
  return [...dirs]
}

export function validateQceExePath(candidatePath) {
  if (!candidatePath || typeof candidatePath !== 'string') {
    throw new Error('未指定 QCE 程序路径')
  }
  const resolved = path.resolve(candidatePath.trim())
  const basename = path.basename(resolved).toLowerCase()
  if (basename !== 'qq chat exporter.exe') {
    throw new Error('指定的文件不是 QQ Chat Exporter.exe')
  }

  const trustedDirs = getTrustedQceDirs()
  const inTrustedDir = trustedDirs.some(td => {
    const rel = path.relative(td, resolved)
    return !rel.startsWith('..') && !path.isAbsolute(rel)
  })

  if (!inTrustedDir) {
    throw new Error('安全拦截：QCE 程序路径不在允许的受信任安装目录内')
  }

  let stat
  try {
    stat = fs.statSync(resolved)
  } catch {
    throw new Error('未找到 QCE 程序文件')
  }

  if (!stat.isFile()) {
    throw new Error('指定的 QCE 路径不是有效文件')
  }

  return resolved
}

export function assertLocalRequest(req) {
  const remoteAddress = String(req.socket?.remoteAddress || req.connection?.remoteAddress || '').toLowerCase()
  const isLoopbackPeer = remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1'
  if (!isLoopbackPeer) {
    const err = new Error('拒绝访问：请求连接必须来自本机回环网络')
    err.status = 403
    throw err
  }
  let host = ''
  try { host = new URL(`http://${req.headers.host}`).hostname.toLowerCase() } catch {}
  if (!LOOPBACK_HOSTS.has(host)) {
    const err = new Error('拒绝访问：必须来自本机回环网络')
    err.status = 403
    throw err
  }
  const origin = req.headers.origin || req.headers.referer || ''
  if (origin) {
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      const err = new Error('来源地址格式无效')
      err.status = 403
      throw err
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
      const err = new Error('拒绝访问：禁止非本地网页跨站调用')
      err.status = 403
      throw err
    }
  }
}

function headerValue(value) {
  return Array.isArray(value) ? value[0] : value
}

export async function readBoundedDownload(response, maxBytes = 100 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel()
    throw new Error('导出文件超过 100MB 限制')
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('导出文件超过 100MB 限制')
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, total)
  } finally { reader.releaseLock() }
}

export function normalizeQceBase(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('QCE 服务地址无效')
  }

  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('QCE 服务地址必须是本机回环地址')
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('QCE 服务地址只能包含协议、主机和端口')
  }
  return url.origin
}

export function qceConfig(req) {
  const base = normalizeQceBase(headerValue(req.headers['x-qce-base']) || DEFAULT_QCE_BASE)
  // token 优先级：请求头（浏览器设置）> QCE 安装目录的 security.json（随登录自动轮换）> .env
  const token =
    headerValue(req.headers['x-qce-token']) || readQceToken() || process.env.QCE_TOKEN || ''
  return { base, token }
}

// v6.x 每次重新登录都会轮换 accessToken 并写入安装目录 .qce-config/security.json，
// 服务端与 QCE 同机，直接读它做兜底（带缓存，避免每个请求都碰盘）
let tokenCache = { value: '', at: 0 }
function readQceToken() {
  if (!DEFAULT_QCE_EXE) return ''
  const file = path.join(path.dirname(DEFAULT_QCE_EXE), '.qce-config', 'security.json')
  if (Date.now() - tokenCache.at > 30000 || tokenCache.file !== file) {
    try {
      tokenCache = { value: JSON.parse(fs.readFileSync(file, 'utf8')).accessToken || '', at: Date.now(), file }
    } catch {
      tokenCache = { value: tokenCache.file === file ? tokenCache.value : '', at: Date.now(), file }
    }
  }
  return tokenCache.value
}

export function resolveQceDownloadUrl(downloadUrl, config) {
  let url
  try {
    url = new URL(downloadUrl, `${config.base}/`)
  } catch {
    throw new Error('下载地址无效')
  }

  if (url.origin !== config.base || url.username || url.password || url.hash) {
    throw new Error('下载地址必须属于当前 QCE 服务地址')
  }
  return url
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

// QCE 统一响应包装 → 归一化
// v6.x: {success, data, timestamp, requestId}，错误时 {success:false, error:{message,...}}
// 旧版: {ok/requestId, data|error}，两者都兼容
function unwrapQce(j) {
  if (j && typeof j === 'object' && ('ok' in j || 'success' in j)) {
    const ok = 'ok' in j ? j.ok : j.success
    if (!ok) throw new Error(j.error?.message || j.error || 'QCE 返回错误')
    return j.data
  }
  return j // /health 等非标准端点直接返回
}

// ── clb 导入（从 handleImport 抽出，供文件上传和 QQ 直连共用） ──
// Windows 下优先直接用 node 跑 chatlab-cli 的 mjs 入口：绕过 cmd.exe，
// 长参数（如多行 SQL）不会被 shell 打碎；找不到时退回 shell 方式。
const CLB_MJS_CANDIDATES = [
  path.join(__dirname, '..', 'node_modules', 'chatlab-cli', 'bin', 'chatlab.mjs'),
  path.join(__dirname, '..', '..', 'node_modules', 'chatlab-cli', 'bin', 'chatlab.mjs'),
  process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', 'chatlab-cli', 'bin', 'chatlab.mjs'),
  process.env.npm_config_prefix && path.join(process.env.npm_config_prefix, 'node_modules', 'chatlab-cli', 'bin', 'chatlab.mjs'),
  process.env.npm_config_prefix && path.join(process.env.npm_config_prefix, 'lib', 'node_modules', 'chatlab-cli', 'bin', 'chatlab.mjs'),
].filter(Boolean)

function resolveClbEntry() {
  try {
    return require.resolve('chatlab-cli/bin/chatlab.mjs')
  } catch {}
  return CLB_MJS_CANDIDATES.find(fs.existsSync) || null
}

export function runChildProcess(command, args, { signal, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(toolError(TOOL_ERROR_CODES.TOOL_CANCELLED, '工具执行已取消'))
      return
    }
    let settled = false
    let timedOut = false
    let child
    let timer
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn(value)
    }
    const onAbort = () => {
      child?.kill()
      finish(reject, toolError(TOOL_ERROR_CODES.TOOL_CANCELLED, '工具执行已取消'))
    }
    try {
      child = spawn(command, args, { windowsHide: true })
    } catch (error) {
      finish(reject, normalizeToolError(error))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, Math.max(1, Number(timeoutMs) || 30000))

    let out = '', err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('close', code => {
      if (timedOut) {
        finish(reject, toolError(
          TOOL_ERROR_CODES.TOOL_TIMEOUT,
          `工具执行超过 ${timeoutMs}ms`,
          { retryable: true },
        ))
        return
      }
      if (code !== 0) {
        finish(reject, toolError(
          TOOL_ERROR_CODES.TEMPORARY_FAILURE,
          `clb exit ${code}: ${err || out}`,
          { retryable: true },
        ))
        return
      }
      finish(resolve, out)
    })
    child.on('error', error => finish(reject, normalizeToolError(error, { cancelled: signal?.aborted })))
  })
}

function clbRaw(args, options = {}) {
  return new Promise((resolve, reject) => {
    const entry = resolveClbEntry()
    if (!entry) {
      reject(toolError(TOOL_ERROR_CODES.TOOL_UNAVAILABLE, '未找到 chatlab-cli 入口，请先安装 chatlab-cli'))
      return
    }
    // Never pass model/user-controlled arguments through a shell.
    runChildProcess(process.execPath, [entry, ...args], options).then(resolve, reject)
  })
}

// 全局串行队列：clb 进程并发会争写 .chatlab-meta.json（EPERM），
// 导入、统计、SQL、消息检索全部排队执行
let clbQueue = Promise.resolve()
export function clb(args, options = {}) {
  const execute = () => {
    if (options.signal?.aborted) {
      throw toolError(TOOL_ERROR_CODES.TOOL_CANCELLED, '工具执行已取消')
    }
    return clbRaw(args, options)
  }
  const p = clbQueue.then(execute, execute)
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
  assertSafeImportJsonNesting(fileBuf)
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

// ── NapCat 探测辅助 ──────────────────────────────────
// 读 QCE 的 config/webui.json 拿 NapCat WebUI 端口，失败时用默认 6099
function readNapCatPort(qceDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(qceDir, 'config', 'webui.json'), 'utf8')).port || 6099
  } catch {
    return 6099
  }
}

function waitPort(port, timeoutMs) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs
    const attempt = () => {
      const sock = net.connect({ host: '127.0.0.1', port, timeout: 1000 })
      const done = ok => {
        sock.destroy()
        if (ok || Date.now() > deadline) resolve(ok)
        else setTimeout(attempt, 500)
      }
      sock.once('connect', () => done(true))
      sock.once('timeout', () => done(false))
      sock.once('error', () => done(false))
    }
    attempt()
  })
}

// ── 注册路由 ─────────────────────────────────────────
export function registerQceRoutes(app, { afterImport } = {}) {
  // 自动启动 QCE 主程序（探活 → spawn → 由前端轮询 /api/qq/status 等上线）
  app.post('/api/qq/launch', async (req, res) => {
    try {

      // 已在线则无需启动
      try {
        const h = await qceFetch(qceConfig(req), '/health', { timeout: 3000 })
        if (h.ok) return res.json({ ok: true, data: { alreadyRunning: true } })
      } catch { /* 未在线，继续启动流程 */ }

      const rawExePath = (
        req.headers['x-qce-path'] || process.env.QCE_PATH || DEFAULT_QCE_EXE || ''
      ).trim()

      let exePath
      try {
        exePath = validateQceExePath(rawExePath)
      } catch (validationError) {
        return res.status(400).json({
          ok: false,
          error: validationError.message || '未找到有效的 QCE 程序',
          code: 'EXE_INVALID',
        })
      }

      // detached：QCE 独立于我们后端生命周期；窗口由 QCE 自己弹出（扫码登录用）
      // 环境加固：剥离代理变量，避免 QCE 壳访问本机 NapCat WebUI 时被系统代理劫持
      // （HTTP_PROXY 指向 Clash 时会返回 502，导致扫码登录界面一直 "error decoding response body"）
      const { HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy, ALL_PROXY, all_proxy, ...childEnv } = process.env
      const qceEnv = { ...childEnv, NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' }
      const qceDir = path.dirname(exePath)
      const child = spawn(exePath, [], {
        detached: true,
        stdio: 'ignore',
        cwd: qceDir,
        env: qceEnv,
      })
      child.unref()

      // 兜底：QCE 壳只有安装后首次运行才自动引导 NapCat，之后再启动只会探测端口干等。
      // 若数秒内 NapCat WebUI（config/webui.json 的 port，默认 6099）仍未上线，
      // 就用官方 launcher-user.bat 引导（隐藏控制台窗口），壳会自动探测到并弹出登录。
      const napcatPort = readNapCatPort(qceDir)
      if (!(await waitPort(napcatPort, 6000))) {
        const bat = path.join(qceDir, 'launcher-user.bat')
        if (fs.existsSync(bat)) {
          const boot = spawn('cmd.exe', ['/c', bat], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            cwd: qceDir,
            env: qceEnv,
          })
          boot.unref()
        }
      }
      res.json({ ok: true, data: { launched: true, exePath } })
    } catch (e) {
      const status = e.status || 500
      res.status(status).json({ ok: false, error: e.message })
    }
  })

  // 状态检测：health（无需 token）+ auth（验证 token 有效性）
  app.get('/api/qq/status', async (req, res) => {
    let cfg
    try {
      cfg = qceConfig(req)
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message })
    }
    try {
      const health = await qceFetch(cfg, '/health')
      const online = health.ok
      let authenticated = false
      if (online) {
        try {
          // v6.x /security-status: {success, data:{hasConfig, tokenExpired, requiresAuth}}
          const sec = await qceFetch(cfg, '/security-status', { timeout: 5000 })
          const sj = await sec.json().catch(() => ({}))
          const d = sj?.data || sj || {}
          if (d.requiresAuth === false || d.enabled === false) {
            authenticated = true
          } else if (cfg.token) {
            // token 是否有效需要真实鉴权请求验证（401 = 无效）
            const probe = await qceFetch(cfg, '/api/friends', { timeout: 8000 })
            authenticated = probe.ok
          }
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
      if (Number(chatType) === 2) {
        return res.status(400).json({ ok: false, error: '群聊不能导入为恋爱工作区，请选择一对一好友会话' })
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
    const { downloadUrl, fileName } = req.body
    if (!downloadUrl) return res.status(400).json({ ok: false, error: '缺少 downloadUrl' })

    let url, cfg
    try {
      cfg = qceConfig(req)
      url = resolveQceDownloadUrl(downloadUrl, cfg)
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message })
    }

    try {
      const fileRes = await fetch(url, {
        redirect: 'error',
        headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
        signal: AbortSignal.timeout(120000),
      })
      if (!fileRes.ok) throw new Error(`下载导出文件失败: HTTP ${fileRes.status}`)
      const buf = await readBoundedDownload(fileRes)
      const name = fileName || url.pathname.split('/').pop() || 'qce-export.json'
      const result = await clbImportBuffer(buf, name, false)
      const data = afterImport ? await afterImport(result) : result
      res.json({ ok: true, data })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })
}
