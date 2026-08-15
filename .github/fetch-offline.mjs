import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const source = (process.env.POCKETZOT_ARTIFACT_SOURCE || 'https://pocketzot.app').replace(/\/$/, '')
const publicDir = resolve('public')

async function fetchBytes(path) {
  const response = await fetch(source + path)
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error(`${path}: empty response`)
  return bytes
}

async function install(path, bytes) {
  const target = resolve(publicDir, path.replace(/^\//, ''))
  if (!target.startsWith(publicDir + '/')) throw new Error(`unsafe artifact path: ${path}`)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
  console.log(`${path} (${bytes.byteLength} bytes)`)
}

async function fetchJson(path) {
  const bytes = await fetchBytes(path)
  const value = JSON.parse(new TextDecoder().decode(bytes))
  await install(path, bytes)
  return value
}

const version = await fetchJson('/offline/version.json')
if (typeof version.build !== 'string' || !version.build) {
  throw new Error('/offline/version.json has no build id')
}

const gamedata = await fetchJson('/gamedata/local/manifest.json')
if (!Array.isArray(gamedata.files) || !gamedata.files.every(
  (name) => typeof name === 'string' && /^[A-Za-z0-9._-]+$/.test(name),
)) {
  throw new Error('/gamedata/local/manifest.json has an unsafe file list')
}

const fixed = [
  '/offline/crawl.js',
  '/offline/crawl.wasm.gz',
  '/offline/crawl.data.gz',
  '/offline/prewarm/manifest.json',
  '/offline/prewarm/prewarm.bin.gz',
]
const paths = [
  ...fixed,
  ...gamedata.files.map((name) => `/gamedata/local/${name}`),
]

await Promise.all(paths.map(async (path) => install(path, await fetchBytes(path))))
console.log(`Installed offline engine ${version.version || 'unknown version'} (${version.build}).`)
