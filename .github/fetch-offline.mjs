#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  constants, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CONFIG_URL = new URL('./offline-engine.json', import.meta.url)

export const REQUIRED_PAYLOAD_FILES = [
  'offline/crawl.js',
  'offline/crawl.wasm.gz',
  'offline/crawl.data.gz',
  'offline/prewarm/manifest.json',
  'offline/prewarm/prewarm.bin.gz',
  'offline/version.json',
  'gamedata/local/manifest.json',
]

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function string(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

export function validateReleaseConfig(value) {
  const raw = object(value, 'offline engine config')
  const build = string(raw.build, 'build', /^[0-9a-f]{12}$/)
  const config = {
    repository: string(raw.repository, 'repository', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    tag: string(raw.tag, 'tag', /^[A-Za-z0-9._-]+$/),
    asset: string(raw.asset, 'asset', /^[A-Za-z0-9._-]+$/),
    bytes: raw.bytes,
    sha256: string(raw.sha256, 'archive SHA-256', /^[0-9a-f]{64}$/),
    build,
    engineCommit: string(raw.engineCommit, 'engine commit', /^[0-9a-f]{40}$/),
    crawlVersion: string(raw.crawlVersion, 'Crawl version', /^[A-Za-z0-9._+-]+$/),
    crawlBase: string(raw.crawlBase, 'Crawl base', /^[0-9a-f]{40}$/),
  }
  if (!Number.isSafeInteger(config.bytes) || config.bytes <= 0) {
    throw new Error('archive byte size is invalid')
  }
  if (config.tag !== `engine-${build}`) {
    throw new Error(`tag must be engine-${build}`)
  }
  if (config.asset !== `pocketzot-offline-${build}.tar.gz`) {
    throw new Error(`asset must be pocketzot-offline-${build}.tar.gz`)
  }
  return config
}

function safePayloadPath(path) {
  return typeof path === 'string'
    && /^(?:offline|gamedata\/local)\/[A-Za-z0-9._/-]+$/.test(path)
    && !path.split('/').some(part => part === '' || part === '.' || part === '..')
}

export function validateReleaseManifest(value, config) {
  const raw = object(value, 'release manifest')
  if (raw.schema !== 1) throw new Error('release manifest schema is not 1')
  if (raw.build !== config.build) throw new Error('release manifest build does not match the pin')
  if (raw.engineCommit !== config.engineCommit) throw new Error('release manifest engine commit does not match the pin')
  if (raw.crawlVersion !== config.crawlVersion) throw new Error('release manifest Crawl version does not match the pin')
  if (raw.crawlBase !== config.crawlBase) throw new Error('release manifest Crawl base does not match the pin')
  if (typeof raw.version !== 'string' || raw.version.length === 0) {
    throw new Error('release manifest has no game version')
  }
  if (!Array.isArray(raw.files) || raw.files.length === 0) {
    throw new Error('release manifest has no files')
  }

  const seen = new Set()
  const files = raw.files.map((entry, index) => {
    const file = object(entry, `release manifest file ${index}`)
    const path = file.path
    if (!safePayloadPath(path)) throw new Error(`unsafe release path: ${String(path)}`)
    if (seen.has(path)) throw new Error(`duplicate release path: ${path}`)
    seen.add(path)
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new Error(`invalid byte size for ${path}`)
    }
    if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error(`invalid SHA-256 for ${path}`)
    }
    return { path, bytes: file.bytes, sha256: file.sha256 }
  })

  for (const path of REQUIRED_PAYLOAD_FILES) {
    if (!seen.has(path)) throw new Error(`release manifest is missing ${path}`)
  }
  return { ...raw, files }
}

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseChecksums(value) {
  const checksums = new Map()
  for (const line of value.split('\n').filter(Boolean)) {
    const match = /^([0-9a-f]{64})\s+\*?([^\s].*)$/.exec(line)
    if (!match) throw new Error(`invalid SHA256SUMS line: ${line}`)
    const [, digest, name] = match
    if (checksums.has(name)) throw new Error(`duplicate SHA256SUMS entry: ${name}`)
    checksums.set(name, digest)
  }
  return checksums
}

export async function deriveReleaseConfig(releaseDirectory, repository) {
  const root = resolve(releaseDirectory)
  const entries = await readdir(root, { withFileTypes: true })
  const manifests = entries
    .filter(entry => entry.isFile() && /^pocketzot-offline-[0-9a-f]{12}\.json$/.test(entry.name))
    .map(entry => entry.name)
  if (manifests.length !== 1) {
    throw new Error(`release directory must contain exactly one offline manifest; found ${manifests.length}`)
  }

  const manifestName = manifests[0]
  const build = /^pocketzot-offline-([0-9a-f]{12})\.json$/.exec(manifestName)[1]
  const asset = `pocketzot-offline-${build}.tar.gz`
  const archivePath = resolve(root, asset)
  const manifestPath = resolve(root, manifestName)
  const sumsPath = resolve(root, 'SHA256SUMS')
  for (const [path, label] of [[archivePath, asset], [manifestPath, manifestName], [sumsPath, 'SHA256SUMS']]) {
    const info = await lstat(path)
    if (!info.isFile()) throw new Error(`${label} is not a regular file`)
  }

  const [archiveBytes, manifestBytes, sumsText] = await Promise.all([
    readFile(archivePath),
    readFile(manifestPath),
    readFile(sumsPath, 'utf8'),
  ])
  const checksums = parseChecksums(sumsText)
  for (const [name, bytes] of [[asset, archiveBytes], [manifestName, manifestBytes]]) {
    const digest = checksum(bytes)
    if (checksums.get(name) !== digest) {
      throw new Error(`${name} does not match SHA256SUMS`)
    }
  }

  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  const config = validateReleaseConfig({
    repository,
    tag: `engine-${build}`,
    asset,
    bytes: archiveBytes.byteLength,
    sha256: checksum(archiveBytes),
    build,
    engineCommit: manifest.engineCommit,
    crawlVersion: manifest.crawlVersion,
    crawlBase: manifest.crawlBase,
  })
  validateReleaseManifest(manifest, config)
  return config
}

export async function updateReleasePin(releaseDirectory, configUrl = CONFIG_URL) {
  const current = validateReleaseConfig(JSON.parse(await readFile(configUrl, 'utf8')))
  const config = await deriveReleaseConfig(releaseDirectory, current.repository)
  const configPath = fileURLToPath(configUrl)
  const temporary = `${configPath}.${process.pid}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' })
    await rename(temporary, configPath)
  } finally {
    await rm(temporary, { force: true })
  }
  return config
}

async function walkFiles(root, directory = root) {
  const paths = []
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const name = relative(root, path).split(sep).join('/')
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) throw new Error(`payload contains a symbolic link: ${name}`)
    if (stat.isDirectory()) paths.push(...await walkFiles(root, path))
    else if (stat.isFile()) paths.push(name)
    else throw new Error(`payload contains a non-file entry: ${name}`)
  }
  return paths
}

export async function verifyExtractedRelease(root, config) {
  const manifest = validateReleaseManifest(
    JSON.parse(await readFile(resolve(root, 'release.json'), 'utf8')),
    config,
  )
  const expected = manifest.files.map(file => file.path).sort()
  const actual = (await walkFiles(root)).filter(path => path !== 'release.json').sort()
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    const expectedSet = new Set(expected)
    const actualSet = new Set(actual)
    const missing = expected.filter(path => !actualSet.has(path))
    const extra = actual.filter(path => !expectedSet.has(path))
    throw new Error(`payload file set differs from manifest (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`)
  }

  for (const file of manifest.files) {
    const bytes = await readFile(resolve(root, file.path))
    if (bytes.byteLength !== file.bytes) throw new Error(`${file.path}: byte size mismatch`)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== file.sha256) throw new Error(`${file.path}: SHA-256 mismatch`)
  }
  return manifest
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', code => {
      const out = Buffer.concat(stdout).toString('utf8')
      const err = Buffer.concat(stderr).toString('utf8')
      if (code === 0) resolveRun(out)
      else reject(new Error(`${command} exited ${code}: ${err.trim()}`))
    })
  })
}

async function inspectArchive(archive) {
  const listing = await run('tar', ['-tzf', archive])
  const seen = new Set()
  for (const rawName of listing.split('\n').filter(Boolean)) {
    const name = rawName.endsWith('/') ? rawName.slice(0, -1) : rawName
    const safeDirectory = ['offline', 'offline/prewarm', 'gamedata', 'gamedata/local'].includes(name)
    if (name !== 'release.json' && !safeDirectory && !safePayloadPath(name)) {
      throw new Error(`archive contains an unsafe path: ${rawName}`)
    }
    if (seen.has(rawName)) throw new Error(`archive contains a duplicate path: ${rawName}`)
    seen.add(rawName)
  }
  const verbose = await run('tar', ['-tvzf', archive])
  for (const line of verbose.split('\n').filter(Boolean)) {
    if (line[0] !== '-' && line[0] !== 'd') {
      throw new Error(`archive contains a link or special entry: ${line}`)
    }
  }
}

async function archiveBytes(config) {
  const local = process.env.POCKETZOT_OFFLINE_ARCHIVE
  if (local) return readFile(resolve(local))
  const url = `https://github.com/${config.repository}/releases/download/${config.tag}/${config.asset}`
  console.log(`Downloading ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`offline engine download failed: HTTP ${response.status}`)
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && Number(declaredLength) !== config.bytes) {
    throw new Error(`archive Content-Length mismatch: expected ${config.bytes}, got ${declaredLength}`)
  }
  if (!response.body) throw new Error('offline engine download returned no body')
  const chunks = []
  let length = 0
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk)
    length += bytes.byteLength
    if (length > config.bytes) {
      throw new Error(`archive is larger than the pinned ${config.bytes} bytes`)
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, length)
}

async function assertMissing(path) {
  try {
    await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error(`refusing to overwrite existing path: ${path}`)
}

async function installPayload(source, destination) {
  const root = resolve(destination)
  if (root === parse(root).root) throw new Error(`unsafe install destination: ${root}`)
  const offline = resolve(root, 'offline')
  const gamedata = resolve(root, 'gamedata/local')
  const release = resolve(root, 'release.json')
  await assertMissing(offline)
  await assertMissing(gamedata)
  await assertMissing(release)
  await mkdir(root, { recursive: true })

  try {
    await cp(resolve(source, 'offline'), offline, { recursive: true, errorOnExist: true, force: false })
    await mkdir(dirname(gamedata), { recursive: true })
    await cp(resolve(source, 'gamedata/local'), gamedata, { recursive: true, errorOnExist: true, force: false })
    await copyFile(resolve(source, 'release.json'), release, constants.COPYFILE_EXCL)
  } catch (error) {
    // All targets were proven absent above, so anything now present was
    // created by this attempt — including a partially copied directory.
    await rm(release, { force: true })
    await rm(gamedata, { recursive: true, force: true })
    await rm(offline, { recursive: true, force: true })
    throw error
  }
}

export async function installPinnedRelease() {
  const config = validateReleaseConfig(JSON.parse(await readFile(CONFIG_URL, 'utf8')))
  const bytes = await archiveBytes(config)
  if (bytes.byteLength !== config.bytes) {
    throw new Error(`archive byte size mismatch: expected ${config.bytes}, got ${bytes.byteLength}`)
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== config.sha256) {
    throw new Error(`archive SHA-256 mismatch: expected ${config.sha256}, got ${digest}`)
  }

  const temporary = await mkdtemp(join(tmpdir(), 'pocketzot-offline-'))
  try {
    const archive = resolve(temporary, config.asset)
    const extracted = resolve(temporary, 'site')
    await writeFile(archive, bytes, { flag: 'wx' })
    await mkdir(extracted)
    await inspectArchive(archive)
    await run('tar', [
      '--extract', '--gzip', '--file', archive, '--directory', extracted,
      '--no-same-owner', '--no-same-permissions',
    ])
    const manifest = await verifyExtractedRelease(extracted, config)
    await installPayload(extracted, process.env.POCKETZOT_OFFLINE_DEST || resolve('public'))
    console.log(`Installed offline engine ${manifest.version} (${manifest.build}).`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args[0] === '--update-pin') {
    if (args.length !== 2) {
      throw new Error('usage: node .github/fetch-offline.mjs --update-pin <release-directory>')
    }
    const config = await updateReleasePin(args[1])
    console.log(`Pinned ${config.repository} release ${config.tag} (${config.sha256}).`)
    return
  }
  if (args.length !== 0) {
    throw new Error('usage: node .github/fetch-offline.mjs [--update-pin <release-directory>]')
  }
  await installPinnedRelease()
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch(error => {
    console.error(`offline engine command failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
