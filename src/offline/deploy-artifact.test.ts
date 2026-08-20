import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deriveReleaseConfig,
  REQUIRED_PAYLOAD_FILES,
  validateReleaseConfig,
  verifyExtractedRelease,
} from '../../.github/fetch-offline.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function testConfig() {
  return validateReleaseConfig({
    repository: 'aeshna-cyanea/crawl',
    tag: 'engine-0123456789ab',
    asset: 'pocketzot-offline-0123456789ab.tar.gz',
    bytes: 123,
    sha256: 'a'.repeat(64),
    build: '0123456789ab',
    engineCommit: 'b'.repeat(40),
    crawlVersion: '0.35-a0-848-gd8b905dbbe',
    crawlBase: 'c'.repeat(40),
  })
}

async function payload() {
  const root = await mkdtemp(join(tmpdir(), 'pocketzot-payload-test-'))
  roots.push(root)
  const files = []
  for (const path of REQUIRED_PAYLOAD_FILES) {
    const contents = Buffer.from(`contents of ${path}`)
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), contents)
    files.push({
      path,
      bytes: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex'),
    })
  }
  const config = testConfig()
  const manifest = {
    schema: 1,
    build: config.build,
    version: '0.35-a0',
    crawlVersion: config.crawlVersion,
    crawlBase: config.crawlBase,
    engineCommit: config.engineCommit,
    files,
  }
  await writeFile(join(root, 'release.json'), JSON.stringify(manifest))
  return { root, config, manifest }
}

async function releaseCandidate() {
  const { config, manifest } = await payload()
  const root = await mkdtemp(join(tmpdir(), 'pocketzot-release-test-'))
  roots.push(root)
  const asset = `pocketzot-offline-${config.build}.tar.gz`
  const manifestName = `pocketzot-offline-${config.build}.json`
  const archive = Buffer.from('synthetic release archive')
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  await writeFile(join(root, asset), archive)
  await writeFile(join(root, manifestName), manifestBytes)
  await writeFile(join(root, 'SHA256SUMS'), [
    `${createHash('sha256').update(archive).digest('hex')}  ${asset}`,
    `${createHash('sha256').update(manifestBytes).digest('hex')}  ${manifestName}`,
  ].join('\n'))
  return { root, config, asset, archive }
}

describe('offline deployment artifact', () => {
  it('accepts the checked-in release pin', async () => {
    const value = JSON.parse(await readFile(
      new URL('../../.github/offline-engine.json', import.meta.url),
      'utf8',
    ))
    const config = validateReleaseConfig(value)
    expect(config.repository).toBe('aeshna-cyanea/crawl')
    expect(config.tag).toBe(`engine-${config.build}`)
    expect(config.asset).toBe(`pocketzot-offline-${config.build}.tar.gz`)
  })

  it('rejects a tag or asset that does not name the pinned build', () => {
    const config = testConfig()
    expect(() => validateReleaseConfig({ ...config, tag: 'engine-deadbeefdead' }))
      .toThrow('tag must be')
    expect(() => validateReleaseConfig({ ...config, asset: 'something.tar.gz' }))
      .toThrow('asset must be')
  })

  it('verifies every extracted file against the release manifest', async () => {
    const { root, config } = await payload()
    await expect(verifyExtractedRelease(root, config)).resolves.toMatchObject({ build: config.build })
  })

  it('rejects modified and unexpected payload files', async () => {
    const changed = await payload()
    await writeFile(join(changed.root, 'offline/crawl.js'), 'modified')
    await expect(verifyExtractedRelease(changed.root, changed.config)).rejects.toThrow(/mismatch/)

    const extra = await payload()
    await writeFile(join(extra.root, 'offline/unlisted.bin'), 'extra')
    await expect(verifyExtractedRelease(extra.root, extra.config)).rejects.toThrow('file set differs')
  })

  it('derives an exact Pages pin from locally produced release files', async () => {
    const candidate = await releaseCandidate()
    const config = await deriveReleaseConfig(candidate.root, 'aeshna-cyanea/crawl')
    expect(config).toEqual({
      ...candidate.config,
      bytes: candidate.archive.byteLength,
      sha256: createHash('sha256').update(candidate.archive).digest('hex'),
    })
  })

  it('refuses to pin a candidate that does not match SHA256SUMS', async () => {
    const candidate = await releaseCandidate()
    await writeFile(join(candidate.root, candidate.asset), 'corrupted')
    await expect(deriveReleaseConfig(candidate.root, 'aeshna-cyanea/crawl'))
      .rejects.toThrow('does not match SHA256SUMS')
  })
})
