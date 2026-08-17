/**
 * Skin config single-source contract (#49 acceptance: the fork's look is
 * decided by the skin config file). Asserts the committed generated artifacts
 * — src/mist-skin.css (palette + fonts sections) and src/skin-wordmark.ts
 * (wordmark section) — match skin.config.json exactly, so a hand edit to an
 * artifact, or a config edit without rerunning scripts/build-skin.mjs, fails
 * here instead of silently shipping drift. The second describe block guards the
 * gate itself (review P2): the palette must cover exactly the upstream deepseek
 * scale read off design-platform.css — a dropped stop would silently fall back
 * to the upstream brand color, an invented one is config with no consumer.
 * Asserted against file text on disk plus real generator runs via the --config
 * seam, same posture as base-styles.client.spec.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const config = JSON.parse(
  readFileSync(fileURLToPath(new URL('../skin.config.json', import.meta.url)), 'utf8'),
) as { palette: Record<string, string>; fonts: { sans: string; mono: string }; wordmark: string }
const skinCss = readFileSync(fileURLToPath(new URL('../src/mist-skin.css', import.meta.url)), 'utf8')
const wordmarkModule = readFileSync(fileURLToPath(new URL('../src/skin-wordmark.ts', import.meta.url)), 'utf8')
const platformCss = readFileSync(
  fileURLToPath(new URL('../../ui-theme/src/styles/design-platform.css', import.meta.url)), 'utf8',
)
const GENERATOR = fileURLToPath(new URL('../scripts/build-skin.mjs', import.meta.url))

/** #rrggbb → "r, g, b" — same rendering the generator applies. */
function hexToRgb(hex: string): string {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')
}

/** The full upstream deepseek scale, read off the frozen tree's design-platform sheet. */
function upstreamStops(): string[] {
  return [...new Set([...platformCss.matchAll(/--dsw-static-deepseek-([\w-]+):/g)].map(([, stop = '']) => stop))].sort()
}

/**
 * Run the generator for real against a tampered config (the --config seam).
 * Validation precedes any write, so rejected configs never touch the artifacts.
 */
function runGeneratorWith(tampered: unknown): { status: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'skin-config-'))
  const path = join(dir, 'skin.config.json')
  writeFileSync(path, JSON.stringify(tampered))
  const result = spawnSync(process.execPath, [GENERATOR, '--config', path, '--check'], { encoding: 'utf8' })
  return { status: result.status, stderr: result.stderr }
}

describe('skin.config.json single source of truth', () => {
  it('palette section: every config stop lands in the CSS, and the CSS carries no stop the config lacks', () => {
    for (const [stop, hex] of Object.entries(config.palette)) {
      expect(skinCss).toContain(`--dsw-static-deepseek-${stop}: rgb(${hexToRgb(hex)});`)
    }
    const cssStops = [...skinCss.matchAll(/--dsw-static-deepseek-([\w-]+):/g)].map(([, stop = '']) => stop)
    expect([...cssStops].sort()).toEqual(Object.keys(config.palette).sort())
  })

  it('palette section: covers exactly the upstream scale (a dropped stop would fall back to upstream brand color)', () => {
    expect(Object.keys(config.palette).sort()).toEqual(upstreamStops())
  })

  it('fonts section: both stacks land in the CSS verbatim', () => {
    expect(skinCss).toContain(`--dsw-font-family: ${config.fonts.sans};`)
    expect(skinCss).toContain(`--ds-font-family-code: ${config.fonts.mono};`)
  })

  it('wordmark section: the generated runtime constant matches config.wordmark', () => {
    // The generator emits single quotes (stylistic/quotes); mirror its escaping here.
    const quoted = `'${config.wordmark.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    expect(wordmarkModule).toContain(`export const SKIN_WORDMARK = ${quoted}`)
  })
})

describe('palette full-set gate (review P2: missing/extra stops must fail loud)', () => {
  it('rejects a config missing a consumed stop, naming the stop', () => {
    const tampered = JSON.parse(JSON.stringify(config)) as typeof config
    delete tampered.palette['500']
    const { status, stderr } = runGeneratorWith(tampered)
    expect(status).not.toBe(0)
    expect(stderr).toContain('缺档 [500]')
  })

  it('rejects a config carrying a stop the upstream scale lacks, naming the stop', () => {
    const tampered = JSON.parse(JSON.stringify(config)) as typeof config
    tampered.palette['999'] = '#000000'
    const { status, stderr } = runGeneratorWith(tampered)
    expect(status).not.toBe(0)
    expect(stderr).toContain('多档 [999]')
  })
})
