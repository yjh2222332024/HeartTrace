// ── 军师 Skill ZIP 导入 ──────────────────────────────────
// 压缩包是静态知识文件的交付载体。这里永不执行包内脚本，也不保留原始 ZIP。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import yauzl from 'yauzl'
import { BUNDLED_SKILLS_DIR, resolveUserSkillsDir } from './runtime-paths.js'

const DEFAULT_SKILLS_DIR = resolveUserSkillsDir()

export const SKILL_PACKAGE_LIMITS = {
  maxArchiveBytes: 30 * 1024 * 1024,
  maxFiles: 200,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 15 * 1024 * 1024,
  maxPathLength: 240,
}

const ADVISOR_ID_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/
const ALLOWED_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.ps1', '.sh', '.bat', '.cmd',
  '.png', '.jpg', '.jpeg', '.webp', '.svg', '.pdf',
])
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.ps1', '.sh', '.bat', '.cmd'])

function packageError(message) {
  const error = new Error(message)
  error.code = 'INVALID_SKILL_PACKAGE'
  return error
}

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/')
}

function normalizedZipPath(fileName) {
  const raw = toPosix(fileName)
  if (!raw || raw.includes('\0') || raw.length > SKILL_PACKAGE_LIMITS.maxPathLength) {
    throw packageError('压缩包内存在无效或过长的文件路径')
  }
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.includes('//')) {
    throw packageError(`压缩包内路径不安全：${raw}`)
  }
  const segments = raw.split('/')
  if (segments.some(part => !part || part === '.' || part === '..')) {
    throw packageError(`压缩包内路径不安全：${raw}`)
  }
  return segments.join('/')
}

function entryIsSymlink(entry) {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000
  return unixMode === 0o120000
}

function textFromBuffer(buffer, label) {
  // manifest / 入口文档只能是 UTF-8 文本，拒绝二进制空字节即可。
  if (buffer.includes(0)) throw packageError(`${label} 不是有效的文本文件`)
  return buffer.toString('utf8')
}

function readZipEntry(zip, entry, totalState) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (openError, stream) => {
      if (openError) return reject(packageError(`无法读取压缩包内文件：${entry.fileName}`))
      const chunks = []
      let bytes = 0
      stream.on('data', chunk => {
        bytes += chunk.length
        totalState.actualBytes += chunk.length
        if (bytes > SKILL_PACKAGE_LIMITS.maxFileBytes || totalState.actualBytes > SKILL_PACKAGE_LIMITS.maxTotalBytes) {
          stream.destroy(packageError('解压后的文件或总内容超过安全上限'))
          return
        }
        chunks.push(chunk)
      })
      stream.once('error', error => reject(error.code === 'INVALID_SKILL_PACKAGE' ? error : packageError(`读取压缩包失败：${error.message}`)))
      stream.once('end', () => resolve(Buffer.concat(chunks, bytes)))
    })
  })
}

function parseManifest(buffer) {
  let manifest
  try { manifest = JSON.parse(textFromBuffer(buffer, 'manifest.json')) } catch { throw packageError('manifest.json 必须是有效 JSON') }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw packageError('manifest.json 必须是对象')
  if (!ADVISOR_ID_RE.test(String(manifest.id || ''))) throw packageError('manifest.id 仅允许小写字母、数字、连字符和下划线，长度不超过 80')
  if (!String(manifest.name || '').trim() || String(manifest.name).length > 100) throw packageError('manifest.name 不能为空，且长度不能超过 100')
  if (manifest.default === true) throw packageError('导入的自定义军师不能声明为默认军师')
  if (manifest.entry !== undefined && manifest.entry !== 'SKILL.md') throw packageError('manifest.entry 只能指向根目录的 SKILL.md')
  return manifest
}

function listedManifestFiles(manifest) {
  const listed = ['SKILL.md']
  for (const key of ['alwaysLoad', 'style']) {
    if (manifest[key] === undefined) continue
    if (!Array.isArray(manifest[key]) || manifest[key].some(item => typeof item !== 'string')) {
      throw packageError(`manifest.${key} 必须是文件路径数组`)
    }
    listed.push(...manifest[key])
  }
  if (manifest.routes === undefined) return listed
  if (!Array.isArray(manifest.routes)) throw packageError('manifest.routes 必须是路由数组')
  for (const route of manifest.routes) {
    if (!route || typeof route !== 'object' || !Array.isArray(route.load) || route.load.some(item => typeof item !== 'string')) {
      throw packageError('manifest.routes 中每条路由都必须包含 load 文件路径数组')
    }
    listed.push(...route.load)
  }
  return listed
}

function validateManifestReferences(manifest, files) {
  for (const item of listedManifestFiles(manifest)) {
    const relativePath = normalizedZipPath(`root/${item}`).replace(/^root\//, '')
    if (!relativePath.toLowerCase().endsWith('.md')) throw packageError(`军师引用的资料必须是 Markdown：${item}`)
    if (!files.has(relativePath)) throw packageError(`manifest 引用了不存在的文件：${item}`)
  }
}

function summarize(manifest, files, totalBytes) {
  const names = [...files.keys()]
  const scripts = names.filter(name => SCRIPT_EXTENSIONS.has(path.posix.extname(name).toLowerCase()))
  const documents = names.filter(name => ['.md', '.mdx', '.txt'].includes(path.posix.extname(name).toLowerCase()))
  return {
    id: manifest.id,
    name: String(manifest.name).trim(),
    description: String(manifest.description || '').trim().slice(0, 600),
    presentation: manifest.presentation && typeof manifest.presentation === 'object' ? manifest.presentation : {},
    fileCount: names.length,
    documentCount: documents.length,
    scriptCount: scripts.length,
    scriptPaths: scripts.slice(0, 20),
    totalBytes,
    rootFiles: names.filter(name => !name.includes('/')).sort(),
    referencedFiles: [...new Set(listedManifestFiles(manifest))],
  }
}

export async function inspectSkillPackage(buffer, filename = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) throw packageError('请选择有效的 .zip 军师包')
  if (buffer.length > SKILL_PACKAGE_LIMITS.maxArchiveBytes) throw packageError('军师包超过 30MB 上传上限')
  if (!String(filename).toLowerCase().endsWith('.zip')) throw packageError('仅支持上传 .zip 军师包')
  if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) throw packageError('文件内容不是有效的 ZIP 压缩包')

  const zip = await new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, opened) => {
      if (error) reject(packageError('无法打开 ZIP 压缩包'))
      else resolve(opened)
    })
  })

  const files = new Map()
  const roots = new Set()
  const declaredState = { declaredBytes: 0, actualBytes: 0, fileCount: 0 }

  try {
    await new Promise((resolve, reject) => {
      zip.once('error', error => reject(packageError(`ZIP 解析失败：${error.message}`)))
      zip.on('entry', async entry => {
        try {
          if (entry.generalPurposeBitFlag & 0x1) throw packageError('不支持加密 ZIP 包')
          if (![0, 8].includes(entry.compressionMethod)) throw packageError('ZIP 包包含不支持的压缩格式')
          if (entryIsSymlink(entry)) throw packageError('ZIP 包不能包含软链接')
          const isDirectory = entry.fileName.endsWith('/')
          const zipPath = normalizedZipPath(isDirectory ? entry.fileName.slice(0, -1) : entry.fileName)
          const [root, ...rest] = zipPath.split('/')
          roots.add(root)
          if (isDirectory) return zip.readEntry()
          if (!rest.length) throw packageError('军师包内文件必须放在唯一的根目录下')
          if (++declaredState.fileCount > SKILL_PACKAGE_LIMITS.maxFiles) throw packageError('军师包文件数超过 200 个')
          if (entry.uncompressedSize > SKILL_PACKAGE_LIMITS.maxFileBytes) throw packageError(`文件过大：${zipPath}`)
          declaredState.declaredBytes += entry.uncompressedSize
          if (declaredState.declaredBytes > SKILL_PACKAGE_LIMITS.maxTotalBytes) throw packageError('解压后的总内容超过 15MB 安全上限')
          const relativePath = rest.join('/')
          if (files.has(relativePath)) throw packageError(`军师包包含重复文件：${relativePath}`)
          const ext = path.posix.extname(relativePath).toLowerCase()
          if (!ALLOWED_EXTENSIONS.has(ext)) throw packageError(`不允许导入该文件类型：${relativePath}`)
          if (SCRIPT_EXTENSIONS.has(ext) && !relativePath.startsWith('scripts/')) {
            throw packageError(`脚本文件必须放在 scripts/ 目录：${relativePath}`)
          }
          const contents = await readZipEntry(zip, entry, declaredState)
          files.set(relativePath, contents)
          zip.readEntry()
        } catch (error) {
          zip.close()
          reject(error)
        }
      })
      zip.once('end', resolve)
      zip.readEntry()
    })
  } finally {
    try { zip.close() } catch {}
  }

  if (roots.size !== 1) throw packageError('军师包必须只包含一个根目录，不能把多个文件夹一起压缩')
  if (!files.has('manifest.json')) throw packageError('军师包缺少 manifest.json')
  if (!files.has('SKILL.md')) throw packageError('军师包缺少根目录 SKILL.md')

  const manifest = parseManifest(files.get('manifest.json'))
  const rootName = [...roots][0]
  if (rootName !== manifest.id) throw packageError('压缩包根目录名称必须与 manifest.id 完全一致')
  const skillText = textFromBuffer(files.get('SKILL.md'), 'SKILL.md').trim()
  if (skillText.length < 20) throw packageError('SKILL.md 内容过短，无法作为军师入口')
  validateManifestReferences(manifest, files)

  return {
    manifest,
    files,
    summary: summarize(manifest, files, declaredState.actualBytes),
  }
}

export function installSkillPackage(pkg, {
  skillsDir = DEFAULT_SKILLS_DIR,
  builtInSkillsDir = BUNDLED_SKILLS_DIR,
} = {}) {
  if (!pkg?.manifest || !(pkg.files instanceof Map)) throw packageError('待安装的军师包无效')
  const id = String(pkg.manifest.id || '')
  if (!ADVISOR_ID_RE.test(id)) throw packageError('军师 ID 无效')
  const root = path.resolve(skillsDir)
  const target = path.resolve(root, id)
  if (!target.startsWith(root + path.sep)) throw packageError('军师安装路径无效')
  const builtInTarget = path.resolve(builtInSkillsDir, id)
  if (fs.existsSync(builtInTarget) && builtInTarget !== target) {
    throw packageError(`军师 ID「${id}」属于内置军师，不能覆盖`)
  }
  if (fs.existsSync(target)) throw packageError(`军师 ID「${id}」已存在，不能覆盖已有军师`)

  fs.mkdirSync(root, { recursive: true })
  const temp = path.join(root, `.${id}.import-${randomUUID()}`)
  try {
    fs.mkdirSync(temp, { recursive: false })
    for (const [relativePath, contents] of pkg.files) {
      const destination = path.resolve(temp, relativePath)
      if (!destination.startsWith(temp + path.sep)) throw packageError('军师包文件路径无效')
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.writeFileSync(destination, contents, { flag: 'wx' })
    }
    try {
      fs.renameSync(temp, target)
    } catch (error) {
      // Windows 的索引器或杀软可能短暂锁住新建目录；只在目标仍不存在时回退，
      // 始终不覆盖已有军师。
      if (!['EPERM', 'EBUSY'].includes(error.code) || fs.existsSync(target)) throw error
      fs.cpSync(temp, target, { recursive: true, force: false, errorOnExist: true })
      fs.rmSync(temp, { recursive: true, force: true })
    }
  } catch (error) {
    try { fs.rmSync(temp, { recursive: true, force: true }) } catch {}
    throw error
  }
  return { id, dir: target, name: pkg.manifest.name }
}

export function createSkillImportRuntime({
  skillsDir = DEFAULT_SKILLS_DIR,
  builtInSkillsDir = BUNDLED_SKILLS_DIR,
  ttlMs = 10 * 60 * 1000,
} = {}) {
  const pending = new Map()

  function prune() {
    const before = Date.now() - ttlMs
    for (const [token, value] of pending) {
      if (value.createdAt < before) pending.delete(token)
    }
  }

  async function inspect(buffer, filename) {
    prune()
    const pkg = await inspectSkillPackage(buffer, filename)
    const id = pkg.manifest.id
    const target = path.resolve(skillsDir, id)
    const builtInTarget = path.resolve(builtInSkillsDir, id)
    if (fs.existsSync(builtInTarget) && builtInTarget !== target) {
      throw packageError(`军师 ID「${id}」属于内置军师，不能覆盖`)
    }
    if (fs.existsSync(target)) throw packageError(`军师 ID「${id}」已存在，不能覆盖已有军师`)
    const token = randomUUID()
    pending.set(token, { pkg, createdAt: Date.now() })
    return { token, expiresInSeconds: Math.floor(ttlMs / 1000), ...pkg.summary }
  }

  function install(token) {
    prune()
    const item = pending.get(String(token || ''))
    if (!item) throw packageError('该军师包检查结果已过期，请重新上传')
    const result = installSkillPackage(item.pkg, { skillsDir, builtInSkillsDir })
    pending.delete(String(token))
    return result
  }

  function discard(token) {
    pending.delete(String(token || ''))
  }

  return { inspect, install, discard }
}
