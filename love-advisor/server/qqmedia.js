import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ── NTQQ 图片还原：消息 [图片:MD5] → 本地缓存文件 ─────────
// NTQQ 缓存结构：<Tencent Files>/<uin>/nt_qq/nt_data/Pic/YYYY-MM/{Ori,OriTemp,Thumb}/<md5>*.ext
// 消息占位符 [图片:md5] 的 32 位小写哈希与文件名前缀匹配（前缀即 md5）。
// 命中优先级：Ori 原图 > OriTemp > Thumb 缩略图，均要求非 0 字节。

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

// 图片缓存根目录发现：QQ_PIC_DIR 环境变量可覆盖（; 分隔多个）
// 默认在常见安装位置扫描所有 QQ 号的 nt_data/Pic
// 图片缓存根目录发现：QQ_PIC_DIR 环境变量可覆盖（; 分隔多个）
// 优先从 UserDataInfo.ini、系统公用/用户文档及全盘驱动器动态探测 Tencent Files
let picDirsCache = null

function readTencentFilesFromIni() {
  const publicDoc = process.env.PUBLIC || 'C:\\Users\\Public'
  const iniPath = path.join(publicDoc, 'Documents', 'Tencent', 'QQ', 'UserDataInfo.ini')
  try {
    const text = fs.readFileSync(iniPath, 'utf8')
    const m = text.match(/^\s*UserDataSavePath\s*=\s*(.+)$/m)
    if (m && m[1].trim()) return m[1].trim()
  } catch { /* 未配置或不存在 */ }
  return null
}

function discoverTencentFilesBases() {
  const bases = new Set()
  const iniCustomPath = readTencentFilesFromIni()
  if (iniCustomPath) bases.add(path.resolve(iniCustomPath))

  // 用户文档目录
  bases.add(path.join(os.homedir(), 'Documents', 'Tencent Files'))

  // 动态枚举可用 Windows 驱动器（C~H）
  for (const drive of ['C', 'D', 'E', 'F', 'G', 'H']) {
    const candidate = `${drive}:\\Tencent Files`
    try {
      if (fs.existsSync(candidate)) bases.add(candidate)
    } catch { /* 驱动器不存在或无权限 */ }
  }
  return [...bases]
}

function picDirs() {
  if (picDirsCache) return picDirsCache
  if (process.env.QQ_PIC_DIR) {
    picDirsCache = process.env.QQ_PIC_DIR.split(';').map(s => s.trim()).filter(Boolean)
    return picDirsCache
  }
  const bases = discoverTencentFilesBases()
  const dirs = []
  for (const base of bases) {
    let entries = []
    try { entries = fs.readdirSync(base, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const dir = path.join(base, e.name, 'nt_qq', 'nt_data', 'Pic')
      try {
        if (fs.statSync(dir).isDirectory()) dirs.push(dir)
      } catch { /* 无该子目录 */ }
    }
  }
  picDirsCache = dirs
  return dirs
}

// 哈希 → 路径 结果缓存（小 LRU，命中后零 IO；未命中缓存防穿透）
const RESULT_CAP = 2000
const resultCache = new Map() // hash -> { hit: { file, mime } | null, at: number }
const NEGATIVE_CACHE_TTL = 30 * 1000 // 负缓存 30 秒有效，防止磁盘刚写入就永久判定缺失

function getFileSize(filePath) {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

// 点对点定向探测：月份按时间倒序（最新优先），Ori 命中即停（Early-Exit）
function searchPicFile(hash) {
  const roots = picDirs()
  let bestCandidate = null // { rank: 0|1|2, file, mime }

  for (const root of roots) {
    let monthEntries = []
    try {
      monthEntries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }

    // 月份倒序排列（2026-09, 2026-08, ...），优先查最近的聊天记录
    const months = monthEntries
      .filter(e => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name))
      .map(e => e.name)
      .sort((a, b) => b.localeCompare(a))

    for (const month of months) {
      const monthDir = path.join(root, month)
      const subDirs = [
        { name: 'Ori', rank: 0 },
        { name: 'OriTemp', rank: 1 },
        { name: 'Thumb', rank: 2 },
      ]

      for (const { name: sub, rank } of subDirs) {
        // 如果已有更高优先级的候选（如 Ori rank=0），同月份或更早月份的更低优先级子目录无需再扫
        if (bestCandidate && bestCandidate.rank <= rank) continue

        const dir = path.join(monthDir, sub)
        let fileNames = []
        try {
          fileNames = fs.readdirSync(dir)
        } catch {
          continue
        }

        for (const fileName of fileNames) {
          if (!fileName.toLowerCase().startsWith(hash)) continue
          const fullPath = path.join(dir, fileName)
          const size = getFileSize(fullPath)
          if (size <= 0) continue

          const mime = MIME_BY_EXT[path.extname(fileName).toLowerCase()] || 'application/octet-stream'
          const candidate = { rank, file: fullPath, mime }

          // 如果命中原图 Ori（最高优先级），直接 Early-Exit
          if (rank === 0) return { file: fullPath, mime }

          if (!bestCandidate || rank < bestCandidate.rank) {
            bestCandidate = candidate
          }
        }
      }
    }
  }

  return bestCandidate ? { file: bestCandidate.file, mime: bestCandidate.mime } : null
}

export function getPicPath(rawHash) {
  const hash = String(rawHash || '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hash)) return null

  const cached = resultCache.get(hash)
  if (cached) {
    if (cached.hit) return cached.hit
    if (Date.now() - cached.at < NEGATIVE_CACHE_TTL) return null
  }

  const hit = searchPicFile(hash)

  if (resultCache.size >= RESULT_CAP) {
    resultCache.delete(resultCache.keys().next().value)
  }
  resultCache.set(hash, { hit, at: Date.now() })
  return hit
}

// ── 路由：GET /api/qq/pic/:hash ─────────────────────────
export function registerQqMediaRoutes(app) {
  app.get('/api/qq/pic/:hash', (req, res) => {
    const hit = getPicPath(req.params.hash)
    if (!hit) {
      // <img> 展示请求允许静默降级；诊断/API 默认仍保留明确的 404 语义。
      if (req.query.fallback === '1') return res.status(204).end()
      return res.status(404).json({ ok: false, error: '本地缓存中未找到该图片' })
    }
    res.setHeader('Content-Type', hit.mime)
    // 内容寻址（md5 命名），可长缓存
    res.setHeader('Cache-Control', 'public, max-age=86400')
    fs.createReadStream(hit.file)
      .on('error', () => { if (!res.headersSent) res.status(500).end() })
      .pipe(res)
  })
}

// ── 测试辅助：注入目录 + 清缓存 ─────────────────────────
export function _usePicDirsForTest(dirs) {
  picDirsCache = dirs
  resultCache.clear()
}
