/**
 * Pre-flight checks for profile loading.
 *
 * These replicate what `@deepseek-ai/dsh-app-boot` does when it loads a profile
 * bundle, so a wiring mistake is caught here instead of as a silent non-load at
 * startup:
 *
 *   1. `packageDirFromAnchor` — `createRequire(anchor).resolve.paths(name)`,
 *      then `<searchPath>/<packageName>`; this is how a local junction under
 *      the profile's node_modules is found.
 *   2. `package.json` must declare `dsh.bundle.patch` (a string or a list).
 *   3. Every declared patch file must exist and parse as a patch list.
 *   4. The inserted row must name this package and set only config keys the
 *      plugin's field map understands.
 *
 * Run: node test/profile.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DEFAULT_STYLE, STYLES } from '../lib/core.js'
import { CONFIG_FIELDS } from '../lib/index.js'
import { parsePatchList } from '../lib/patch-yaml.js'
import { parseConfig } from '../lib/schema.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '..')
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))

let passed = 0
let failed = 0

/**
 * Run one assertion group.
 * @param {string} name - test name.
 * @param {Function} body - test body.
 * @returns {void}
 */
function test(name, body) {
  try {
    body()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}`)
    console.error(`       ${String(error?.message ?? error).split('\n')[0]}`)
  }
}

/**
 * Read the declared patch paths.
 * @returns {string[]} absolute patch paths.
 */
function patchPaths() {
  const declared = manifest.dsh.bundle.patch
  const files = typeof declared === 'string' ? [declared] : declared
  return files.map((file) => join(packageDir, file))
}

/**
 * Replicate app-boot's `packageDirFromAnchor`.
 * @param {string} anchor - absolute path of a file used as the resolution anchor.
 * @param {string} packageName - package to resolve.
 * @returns {string | undefined} the package directory, when it exists.
 */
function packageDirFromAnchor(anchor, packageName) {
  for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

console.log('profile: package manifest')

test('the package has a name and a version', () => {
  assert.equal(typeof manifest.name, 'string')
  assert.ok(manifest.name.length > 0)
  assert.equal(typeof manifest.version, 'string')
})

test('the package declares dsh.bundle.patch', () => {
  // Without this, app-boot throws "declares no dsh.bundle" and skips the bundle.
  assert.ok(manifest.dsh?.bundle !== undefined, 'dsh.bundle is missing')
  const declared = manifest.dsh.bundle.patch
  const files = typeof declared === 'string' ? [declared] : declared
  assert.ok(Array.isArray(files) && files.length > 0, 'dsh.bundle.patch must be a path or a list of paths')
})

test('the package declares dsh.client for the web platform', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web')
})

test('the browser half is exposed as ./client and exists', () => {
  const target = manifest.exports?.['./client']?.default
  assert.equal(target, './lib/client.js')
  assert.ok(existsSync(join(packageDir, target)))
})

test('the host half entry exists', () => {
  assert.ok(existsSync(join(packageDir, manifest.main)))
})

test('no DSH peerDependency, so compatibility gating cannot skip it', () => {
  // evaluatePluginCompatibility only inspects @deepseek-ai/dsh* peers.
  const peers = Object.keys(manifest.peerDependencies ?? {})
  const dshPeers = peers.filter((name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
  assert.deepEqual(dshPeers, [], `unexpected DSH peers: ${dshPeers.join(', ')}`)
})

test('every declared file exists', () => {
  // A listed-but-missing entry ships nothing; a runtime file missing from this
  // list would not ship at all.
  const files = manifest.files ?? []
  assert.ok(files.length > 0, 'files is empty')
  for (const file of files) {
    assert.ok(existsSync(join(packageDir, file)), `declared but missing: ${file}`)
  }
})

test('the runtime entry points are all declared', () => {
  const files = new Set(manifest.files ?? [])
  for (const required of ['lib/index.js', 'lib/client.js', 'lib/core.js', 'lib/schema.js', 'cordis.patch.yml']) {
    assert.ok(files.has(required), `${required} is not declared in files`)
  }
})

test('every lib module the halves import is declared', () => {
  // Losing patch-yaml.js or schema.js from files would break a published copy.
  const files = new Set(manifest.files ?? [])
  for (const entry of ['lib/index.js', 'lib/client.js']) {
    const source = readFileSync(join(packageDir, entry), 'utf8')
    for (const match of source.matchAll(/from '\.\/([a-z-]+\.js)'/gu)) {
      const dependency = `lib/${match[1]}`
      assert.ok(files.has(dependency), `${entry} imports ${dependency}, which files does not declare`)
    }
  }
})

console.log('profile: bundle resolution')

test('the package resolves from a profile anchor through a node_modules junction', () => {
  // Build the layout the documented install creates, in a throwaway profile.
  // The link path is derived from manifest.name so this test follows the
  // package whether it is scoped (@scope/name) or unscoped (name).
  const fakeProfile = join(here, '.tmp-profile')
  const linkPath = join(fakeProfile, 'node_modules', ...manifest.name.split('/'))
  rmSync(fakeProfile, { recursive: true, force: true })
  mkdirSync(dirname(linkPath), { recursive: true })
  writeFileSync(join(fakeProfile, 'package.json'), JSON.stringify({ name: 'test-profile', version: '1.0.0' }, null, 2))

  try {
    symlinkSync(packageDir, linkPath, 'junction')
    const resolvedDir = packageDirFromAnchor(join(fakeProfile, 'package.json'), manifest.name)
    assert.ok(resolvedDir !== undefined, `could not resolve ${manifest.name} from a profile node_modules`)
    assert.ok(existsSync(join(resolvedDir, 'package.json')), 'the resolved directory has no package.json')
  } finally {
    rmSync(fakeProfile, { recursive: true, force: true })
  }
})

test('resolution fails loudly for a package that is not installed', () => {
  const fakeProfile = join(here, '.tmp-profile-missing')
  rmSync(fakeProfile, { recursive: true, force: true })
  mkdirSync(fakeProfile, { recursive: true })
  writeFileSync(join(fakeProfile, 'package.json'), JSON.stringify({ name: 'test-profile', version: '1.0.0' }))
  try {
    assert.equal(packageDirFromAnchor(join(fakeProfile, 'package.json'), '@local/definitely-not-installed'), undefined)
  } finally {
    rmSync(fakeProfile, { recursive: true, force: true })
  }
})

console.log('profile: patch layer')

test('every declared patch file exists and is a regular file', () => {
  for (const file of patchPaths()) {
    assert.ok(existsSync(file), `missing patch file: ${file}`)
    assert.ok(statSync(file).isFile(), `not a file: ${file}`)
  }
})

test('each patch parses to a one-entry insert list', () => {
  for (const file of patchPaths()) {
    const parsed = parsePatchList(readFileSync(file, 'utf8'))
    assert.ok(Array.isArray(parsed), `${file} must parse to a list`)
    assert.equal(parsed.length, 1, `${file} should contain exactly one insert`)
    assert.ok(Array.isArray(parsed[0].insert), `${file} must use - insert:`)
    assert.equal(parsed[0].insert.length, 1)
  }
})

test('the inserted row names this package by name, not by file path', () => {
  const parsed = parsePatchList(readFileSync(patchPaths()[0], 'utf8'))
  const row = parsed[0].insert[0]
  assert.equal(row.name, manifest.name)
  assert.equal(row.id, 'prompt-enhancer-pro')
})

test('the patch sets only config keys the plugin understands', () => {
  const parsed = parsePatchList(readFileSync(patchPaths()[0], 'utf8'))
  const config = parsed[0].insert[0].config
  assert.ok(config !== null && typeof config === 'object', 'the insert row has no config')
  for (const key of Object.keys(config)) {
    assert.ok(key in CONFIG_FIELDS, `the patch sets an unknown config key: ${key}`)
  }
})

test('the patch config is accepted without coercion', () => {
  // Regression: this asserted `result.issues === undefined`, which the schema now
  // guarantees for EVERY input — the check had become a tautology and could no
  // longer catch a bad value in the patch. It now asserts what actually matters:
  // that nothing had to be coerced.
  const parsed = parsePatchList(readFileSync(patchPaths()[0], 'utf8'))
  const coerced = []
  const result = parseConfig(CONFIG_FIELDS, parsed[0].insert[0].config, (message, key) =>
    coerced.push({ message, key }),
  )
  assert.deepEqual(
    coerced,
    [],
    `the patch declares values the plugin had to ignore: ${JSON.stringify(coerced)}`,
  )
  assert.ok(STYLES.includes(result.value.defaultStyle))
  assert.equal(typeof result.value.debugLog, 'boolean')
  assert.equal(typeof result.value.enableRoute, 'boolean')
})

test('the field map really does report a bad value, so the check above can fail', () => {
  // Proves the previous test is not vacuous: feed it a typo and require a report.
  const coerced = []
  const result = parseConfig(CONFIG_FIELDS, { defaultStyle: 'structure', debugLog: 'yes' }, (message, key) =>
    coerced.push({ message, key }),
  )
  assert.equal(coerced.length, 2, `a bad patch config was not reported: ${JSON.stringify(coerced)}`)
  assert.deepEqual(
    coerced.map((entry) => entry.key).sort(),
    ['debugLog', 'defaultStyle'],
  )
  assert.equal(result.value.defaultStyle, DEFAULT_STYLE, 'the typo must fall back to the default')
})

console.log('yaml: parser behavior')

test('parses a nested sequence of mappings', () => {
  const parsed = parsePatchList(['- insert:', '    - id: a', "      name: 'pkg'", '      config:', '        x: 1'].join('\n'))
  assert.deepEqual(parsed, [{ insert: [{ id: 'a', name: 'pkg', config: { x: 1 } }] }])
})

test('parses booleans, nulls, numbers, and quoted strings', () => {
  const parsed = parsePatchList(
    ['- insert:', '    - id: a', '      config:', "        s: 'v'", '        t: true', '        f: false', '        n: 3', '        z: null'].join('\n'),
  )
  assert.deepEqual(parsed[0].insert[0].config, { s: 'v', t: true, f: false, n: 3, z: null })
})

test('parses an empty string value as null rather than dropping the key', () => {
  const parsed = parsePatchList(['- insert:', '    - id: a', '      config:', '        provider: '].join('\n'))
  assert.deepEqual(parsed[0].insert[0].config, { provider: null })
})

test('ignores comments and blank lines', () => {
  const parsed = parsePatchList(['# header', '', '- insert:', '    - id: a  # trailing', '      name: pkg'].join('\n'))
  assert.deepEqual(parsed, [{ insert: [{ id: 'a', name: 'pkg' }] }])
})

test('rejects a document whose root is not a list', () => {
  assert.throws(() => parsePatchList('id: a'), /root must be a list/u)
})

test('the real patch file round-trips all of its declarations', () => {
  const parsed = parsePatchList(readFileSync(patchPaths()[0], 'utf8'))
  const row = parsed[0].insert[0]
  assert.deepEqual(Object.keys(row).sort(), ['config', 'id', 'name'])
})

test('a lone dash terminates instead of spinning forever', () => {
  // Regression: the continuation loop excluded only `- `, not a bare `-`.
  // `parseMapping` breaks on both without advancing the index, so the loop span
  // at 100% CPU and never returned — a pre-flight hang, not an error.
  //
  // Run in a child process: if this ever regresses, the failure must be a clean
  // assertion rather than a hung test runner.
  const probe = `
import { parsePatchList } from ${JSON.stringify(pathToFileURL(join(here, '..', 'lib', 'patch-yaml.js')).href)}
const cases = ['- id: x\\n  -\\n', '- id: x\\n  -\\n    a: b\\n']
for (const c of cases) {
  try { parsePatchList(c); console.log('PARSED') }
  catch (error) { console.log('THREW ' + error.message) }
}
`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(result.signal, null, 'the parser did not terminate')
  assert.notEqual(result.status, null, 'the child never exited')
  assert.ok(
    String(result.stdout).includes('THREW'),
    `a malformed sequence must be rejected, got: ${String(result.stdout).trim()}`,
  )
})

test('a lone dash inside a nested sequence still parses', () => {
  // The fix must not reject legitimate YAML: a bare `-` is a valid empty item.
  const parsed = parsePatchList(['- id: x', '  children:', '    - a', '    -'].join('\n'))
  assert.deepEqual(parsed, [{ id: 'x', children: ['a', null] }])
})

console.log(`\nprofile pre-flight: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
