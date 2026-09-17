// ── Bilibili 视频与字幕解析器 ─────────────────────────
// 支持：
// 1. BV 号 / URL 解析提取
// 2. 访客凭证轮换（spi 接口获取 buvid3 / buvid4，免登录防 412）
// 3. B 站视频元信息与 AI/CC 字幕拉取
// 4. 多格式本地字幕解析（SRT / VTT / JSON / 纯文本）
// 5. 规范化格式：带时间戳与行号（[MM:SS] BV:行号 内容）
// 6. 语义分片（Chunking）：按字符上限切片，供 LLM 稳定提取

import { createHash } from 'node:crypto'

const BV_REGEX = /(?:^|[^A-Za-z0-9])(BV[A-Za-z0-9]{10})(?:$|[^A-Za-z0-9])/i
const BILIBILI_SESSION_MAX_CHARS = 4096

export const BILIBILI_ERROR_CODES = {
  LOGIN_REQUIRED_FOR_SUBTITLE: 'BILIBILI_LOGIN_REQUIRED_FOR_SUBTITLE',
}

function bilibiliError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

/**
 * 从文本或 URL 中提取标准 BV 号
 */
export function extractBvId(input) {
  if (!input || typeof input !== 'string') return null
  const m = input.trim().match(BV_REGEX)
  return m ? m[1] : null
}

// 仅接受 SESSDATA 本身或包含它的 Cookie 片段，并只保留该字段。
// 该值由构建运行时放在内存中，绝不能写入 task / settings / log。
export function normalizeBilibiliSessionCookie(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.length > BILIBILI_SESSION_MAX_CHARS) throw new Error('B 站登录凭证长度异常')
  const matched = raw.match(/(?:^|;\s*)SESSDATA=([^;\s]+)/i)
  const session = (matched?.[1] || (raw.includes('=') ? '' : raw)).trim()
  if (!session) throw new Error('请输入 B 站 Cookie 中的 SESSDATA 值')
  if (!/^[A-Za-z0-9%._~!$&'()*+,/:=@?\-]{8,2048}$/.test(session)) {
    throw new Error('B 站 SESSDATA 格式无效')
  }
  return `SESSDATA=${session}`
}

export function mergeBilibiliCookies(...cookies) {
  return cookies.map(cookie => String(cookie || '').trim()).filter(Boolean).join('; ')
}

/**
 * 格式化秒数为 [MM:SS]
 */
export function formatTimestamp(seconds) {
  const s = Math.max(0, Number(seconds) || 0)
  const mins = Math.floor(s / 60)
  const secs = Math.floor(s % 60)
  return `[${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}]`
}

/**
 * 获取 B 站公共访客凭证（buvid3 / buvid4）
 */
export async function getBilibiliGuestCookie(customFetch = fetch) {
  try {
    const res = await customFetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return ''
    const data = await res.json()
    const b3 = data?.data?.b_3 || ''
    const b4 = data?.data?.b_4 || ''
    if (b3 && b4) {
      return `buvid3=${b3}; buvid4=${b4}`
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * 获取 B 站视频信息（标题、UP主、时长、cid）
 */
export async function fetchVideoInfo(bvid, { cookie = '', customFetch = fetch } = {}) {
  const id = extractBvId(bvid)
  if (!id) throw new Error(`无效的 B 站视频标识: ${bvid}`)

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com',
  }
  if (cookie) headers.Cookie = cookie

  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${id}`
  const res = await customFetch(url, { headers, signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`请求 B 站视频详情失败: HTTP ${res.status}`)

  const json = await res.json()
  if (json.code !== 0 || !json.data) {
    throw new Error(json.message || `B 站视频 ${id} 不存在或已被删除`)
  }

  const data = json.data
  return {
    bvid: data.bvid,
    aid: data.aid,
    cid: data.cid || data.pages?.[0]?.cid,
    title: data.title || '',
    desc: data.desc || '',
    ownerName: data.owner?.name || '',
    duration: data.duration || 0,
    pic: data.pic || '',
  }
}

/**
 * 获取 B 站视频的字幕列表并下载最佳中文/AI字幕
 */
export async function fetchSubtitle(bvid, { cookie = '', customFetch = fetch } = {}) {
  const info = await fetchVideoInfo(bvid, { cookie, customFetch })
  if (!info.cid) throw new Error(`未能获取到视频 ${info.bvid} 的播放分 P 信息 (cid)`)

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com',
  }
  if (cookie) headers.Cookie = cookie

  const playerUrl = `https://api.bilibili.com/x/player/v2?bvid=${info.bvid}&cid=${info.cid}`
  const res = await customFetch(playerUrl, { headers, signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`请求 B 站播放器配置失败: HTTP ${res.status}`)

  const json = await res.json()
  const subtitles = json.data?.subtitle?.subtitles || []
  if (!subtitles.length) {
    if (json.data?.need_login_subtitle) {
      throw bilibiliError(
        BILIBILI_ERROR_CODES.LOGIN_REQUIRED_FOR_SUBTITLE,
        `视频「${info.title}」(${info.bvid}) 的字幕需要登录 B 站后才能读取。`,
        { bvid: info.bvid, title: info.title },
      )
    }
    throw new Error(`视频「${info.title}」(${info.bvid}) 没有可用的官方或 AI 字幕，请通过手动粘贴字幕添加。`)
  }

  // 优先级：中文(ai-zh) > 中文(zh-CN) > 第一个字幕
  let best = subtitles.find(s => s.lan === 'ai-zh') || subtitles.find(s => s.lan?.includes('zh')) || subtitles[0]
  let subUrl = best.subtitle_url
  if (subUrl.startsWith('//')) subUrl = `https:${subUrl}`

  const subRes = await customFetch(subUrl, { headers, signal: AbortSignal.timeout(12000) })
  if (!subRes.ok) throw new Error(`下载字幕内容失败: HTTP ${subRes.status}`)

  const subJson = await subRes.json()
  const items = parseBilibiliSubtitleJson(subJson, info.bvid)

  return {
    videoInfo: info,
    language: best.lan_doc || best.lan || '中文',
    items,
    formattedText: formatSubtitleLines(items),
  }
}

/**
 * 解析 B 站字幕 JSON（包含 body: [ { from, to, content } ]）
 */
export function parseBilibiliSubtitleJson(json, bvid = '') {
  const body = Array.isArray(json?.body) ? json.body : []
  const items = []
  let line = 1
  for (const item of body) {
    const text = String(item.content || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    items.push({
      line: line++,
      bvid: bvid || '',
      from: Number(item.from) || 0,
      to: Number(item.to) || 0,
      content: text,
    })
  }
  return items
}

/**
 * 解析本地 SRT 或 VTT 格式字幕
 */
export function parseSrtOrVtt(text, bvid = '') {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const items = []
  let lineNum = 1
  let curFrom = 0
  let curTo = 0
  let curContent = []

  const timeRegex = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{3})/

  const flush = () => {
    if (curContent.length) {
      const content = curContent.join(' ').replace(/\s+/g, ' ').trim()
      if (content) {
        items.push({
          line: lineNum++,
          bvid: bvid || '',
          from: curFrom,
          to: curTo,
          content,
        })
      }
      curContent = []
    }
  }

  for (const l of lines) {
    const trimmed = l.trim()
    if (!trimmed) {
      flush()
      continue
    }
    const tm = trimmed.match(timeRegex)
    if (tm) {
      flush()
      const h1 = Number(tm[1] || 0), m1 = Number(tm[2]), s1 = Number(tm[3]), ms1 = Number(tm[4])
      const h2 = Number(tm[5] || 0), m2 = Number(tm[6]), s2 = Number(tm[7]), ms2 = Number(tm[8])
      curFrom = h1 * 3600 + m1 * 60 + s1 + ms1 / 1000
      curTo = h2 * 3600 + m2 * 60 + s2 + ms2 / 1000
    } else if (/^\d+$/.test(trimmed) && curContent.length === 0) {
      // 序号行，跳过
    } else if (trimmed === 'WEBVTT' || trimmed.startsWith('NOTE')) {
      // VTT 头部行，跳过
    } else {
      curContent.push(trimmed)
    }
  }
  flush()
  return items
}

/**
 * 解析纯文本（每行视为一条字幕，若包含时间戳则解析）
 */
export function parsePlainText(text, bvid = '') {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const items = []
  let lineNum = 1

  const tsRegex = /^\[?(\d{1,2}):(\d{2})(?::(\d{2}))?\]?\s*(?:BV[A-Za-z0-9]{10}:\d+\s*)?(.*)$/

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (!raw) continue

    const m = raw.match(tsRegex)
    if (m) {
      const m1 = Number(m[1]), m2 = Number(m[2]), m3 = m[3] !== undefined ? Number(m[3]) : null
      let seconds = 0
      if (m3 !== null) seconds = m1 * 3600 + m2 * 60 + m3
      else seconds = m1 * 60 + m2
      const content = (m[4] || '').trim() || raw
      items.push({
        line: lineNum++,
        bvid: bvid || '',
        from: seconds,
        to: seconds + 2,
        content,
      })
    } else {
      items.push({
        line: lineNum++,
        bvid: bvid || '',
        from: (lineNum - 1) * 2,
        to: lineNum * 2,
        content: raw,
      })
    }
  }
  return items
}

/**
 * 智能解析任意格式素材输入（JSON、SRT、VTT 或纯文本）
 */
export function parseAnySubtitleInput(content, bvid = '') {
  if (!content) return []
  const str = String(content).trim()
  if (str.startsWith('{') || str.startsWith('[')) {
    try {
      const json = JSON.parse(str)
      if (json && (json.body || Array.isArray(json))) {
        return parseBilibiliSubtitleJson(Array.isArray(json) ? { body: json } : json, bvid)
      }
    } catch { /* 不是合法 json，继续走文本解析 */ }
  }

  if (str.includes('-->')) {
    return parseSrtOrVtt(str, bvid)
  }

  return parsePlainText(str, bvid)
}

/**
 * 规范化排版输出为带行号与时间戳的纯文本
 * 样例格式：[01:23] BV1qb17BxEQZ:42 对方问我周末有没有空
 */
export function formatSubtitleLines(items) {
  if (!Array.isArray(items)) return ''
  return items.map(it => {
    const ts = formatTimestamp(it.from)
    const ref = it.bvid ? `${it.bvid}:${it.line}` : `L${it.line}`
    return `${ts} ${ref} ${it.content}`
  }).join('\n')
}

// 用于确认用户审过的字幕与实际进入构建流程的字幕是同一份。
// 只传递摘要，不保存字幕全文。
export function fingerprintSubtitle(items) {
  return createHash('sha256')
    .update(formatSubtitleLines(items), 'utf8')
    .digest('hex')
}

/**
 * 文本分片（Chunking）：按字符上限切片，保持行完整
 */
export function chunkSubtitles(items, { maxChars = 7000, overlapLines = 3 } = {}) {
  const chunks = []
  if (!items || !items.length) return chunks

  let cur = []
  let curLen = 0

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const lineLen = item.content.length + 20 // 预估带时间戳和行号后的长度
    if (cur.length && (curLen + lineLen > maxChars)) {
      chunks.push({
        chunkIndex: chunks.length,
        fromLine: cur[0].line,
        toLine: cur[cur.length - 1].line,
        fromTime: cur[0].from,
        toTime: cur[cur.length - 1].to,
        bvid: cur[0].bvid,
        items: [...cur],
        text: formatSubtitleLines(cur),
      })

      // 提取重叠行（保留尾部几行上下文给下一片）
      const overlap = overlapLines > 0 ? cur.slice(-overlapLines) : []
      cur = [...overlap]
      curLen = cur.reduce((sum, it) => sum + it.content.length + 20, 0)
    }

    cur.push(item)
    curLen += lineLen
  }

  if (cur.length) {
    chunks.push({
      chunkIndex: chunks.length,
      fromLine: cur[0].line,
      toLine: cur[cur.length - 1].line,
      fromTime: cur[0].from,
      toTime: cur[cur.length - 1].to,
      bvid: cur[0].bvid,
      items: [...cur],
      text: formatSubtitleLines(cur),
    })
  }

  return chunks
}
