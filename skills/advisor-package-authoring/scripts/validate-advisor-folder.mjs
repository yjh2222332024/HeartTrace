import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2] ? path.resolve(process.argv[2]) : ''
const allowedExtensions = new Set([
  '.md', '.mdx', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.ps1', '.sh', '.bat', '.cmd',
  '.png', '.jpg', '.jpeg', '.webp', '.svg', '.pdf',
])
const scriptExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.ps1', '.sh', '.bat', '.cmd'])
const idPattern = /^[a-z0-9][a-z0-9_-]{0,79}$/
const limits = {
  maxFiles: 200,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 15 * 1024 * 1024,
  maxPathLength: 240,
}

function fail(message) {
  console.error(`Invalid advisor folder: ${message}`)
  process.exit(1)
}

if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail('provide an existing advisor folder')

const manifestPath = path.join(root, 'manifest.json')
const entryPath = path.join(root, 'SKILL.md')
if (!fs.existsSync(manifestPath) || !fs.existsSync(entryPath)) fail('manifest.json and SKILL.md are required at the root')

let manifest
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { fail('manifest.json must be valid JSON') }
if (!idPattern.test(String(manifest?.id || ''))) fail('manifest.id must be a lowercase safe identifier')
if (path.basename(root) !== manifest.id) fail('folder name must equal manifest.id')
if (!String(manifest?.name || '').trim() || String(manifest.name).length > 100) fail('manifest.name is required and must not exceed 100 characters')
if (manifest.default === true) fail('imported advisors cannot be default')
if (manifest.entry !== undefined && manifest.entry !== 'SKILL.md') fail('manifest.entry must be SKILL.md')
if (fs.readFileSync(entryPath, 'utf8').trim().length < 20) fail('SKILL.md is too short to be an advisor entry')

const files = new Set()
let totalBytes = 0
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, item.name)
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink()) fail(`symlinks are not allowed: ${relative}`)
    if (item.isDirectory()) walk(absolute)
    else if (item.isFile()) {
      if (relative.length > limits.maxPathLength) fail(`path exceeds ${limits.maxPathLength} characters: ${relative}`)
      const ext = path.posix.extname(relative).toLowerCase()
      if (!allowedExtensions.has(ext)) fail(`unsupported file type: ${relative}`)
      if (scriptExtensions.has(ext) && !relative.startsWith('scripts/')) fail(`scripts must be in scripts/: ${relative}`)
      if (stat.size > limits.maxFileBytes) fail(`file exceeds 2MB: ${relative}`)
      totalBytes += stat.size
      if (totalBytes > limits.maxTotalBytes) fail('folder contents exceed the 15MB extraction limit')
      files.add(relative)
      if (files.size > limits.maxFiles) fail(`folder contains more than ${limits.maxFiles} files`)
    }
  }
}
walk(root)

const references = ['SKILL.md']
for (const key of ['alwaysLoad', 'style']) {
  if (manifest[key] === undefined) continue
  if (!Array.isArray(manifest[key]) || manifest[key].some(value => typeof value !== 'string')) fail(`manifest.${key} must be a path array`)
  references.push(...manifest[key])
}
if (manifest.routes !== undefined) {
  if (!Array.isArray(manifest.routes)) fail('manifest.routes must be an array')
  for (const route of manifest.routes) {
    if (!route || !Array.isArray(route.load) || route.load.some(value => typeof value !== 'string')) fail('each route must have a load path array')
    references.push(...route.load)
  }
}
for (const relative of references) {
  if (relative.includes('\\') || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')) fail(`unsafe manifest path: ${relative}`)
  if (!relative.toLowerCase().endsWith('.md')) fail(`routed document must be Markdown: ${relative}`)
  if (!files.has(relative)) fail(`referenced file is missing: ${relative}`)
}

const scripts = [...files].filter(file => scriptExtensions.has(path.posix.extname(file).toLowerCase()))
console.log(JSON.stringify({ ok: true, id: manifest.id, files: files.size, totalBytes, scripts }, null, 2))
