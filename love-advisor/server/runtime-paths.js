import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const LEGACY_DATA_DIR = path.join(__dirname, '.data')
export const BUNDLED_SKILLS_DIR = fs.existsSync(path.resolve(__dirname, '..', 'skills'))
  ? path.resolve(__dirname, '..', 'skills')
  : path.resolve(__dirname, '..', '..', 'skills')

export const RUNTIME_DATA_FILES = [
  'settings.json',
  'advisor-prompts.json',
  'conversations.json',
  'runs.json',
  'cases.json',
  'imports.json',
  'training-sessions.json',
  'builder_jobs.json',
]

export function resolveUserDataDir({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (env.LOVE_ADVISOR_DATA_DIR) return pathApi.resolve(env.LOVE_ADVISOR_DATA_DIR)
  if (platform === 'win32') {
    return pathApi.join(env.LOCALAPPDATA || pathApi.join(homeDir, 'AppData', 'Local'), 'LoveAdvisor')
  }
  if (platform === 'darwin') {
    return pathApi.join(homeDir, 'Library', 'Application Support', 'LoveAdvisor')
  }
  return pathApi.join(env.XDG_DATA_HOME || pathApi.join(homeDir, '.local', 'share'), 'love-advisor')
}

export function resolveUserSkillsDir(options = {}) {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (env.LOVE_ADVISOR_SKILLS_DIR) return pathApi.resolve(env.LOVE_ADVISOR_SKILLS_DIR)
  return pathApi.join(resolveUserDataDir(options), 'skills')
}

export function migrateLegacyData({
  legacyDataDir = LEGACY_DATA_DIR,
  dataDir = resolveUserDataDir(),
  fileNames = RUNTIME_DATA_FILES,
} = {}) {
  const sourceRoot = path.resolve(legacyDataDir)
  const targetRoot = path.resolve(dataDir)
  const result = { source: sourceRoot, target: targetRoot, copied: [], skipped: [] }
  if (sourceRoot === targetRoot || !fs.existsSync(sourceRoot)) return result

  for (const fileName of fileNames) {
    const source = path.join(sourceRoot, fileName)
    const target = path.join(targetRoot, fileName)
    if (!fs.existsSync(source)) continue
    if (fs.existsSync(target)) {
      result.skipped.push(fileName)
      continue
    }
    fs.mkdirSync(targetRoot, { recursive: true })
    try {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
      result.copied.push(fileName)
    } catch (error) {
      if (error.code === 'EEXIST') result.skipped.push(fileName)
      else throw error
    }
  }
  return result
}
