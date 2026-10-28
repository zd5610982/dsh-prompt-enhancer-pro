/**
 * End-to-end verification against a RUNNING DeepSeek Harness instance.
 *
 * The offline suites prove the plugin's own contract. This one proves the
 * *installation* is live inside the app:
 *
 *   1. `/plugins/dsh-prompt-enhancer-pro/status` answers.
 *   2. The browser half is composed into the module graph and served. The URL
 *      is not guessable — it carries a revision derived from the bundle's
 *      filesystem metadata — so this recomputes it with the same algorithm
 *      dsh-client-modules uses (`framedHash` / `artifactRevision` / `comboUrl`).
 *   3. The served script, executed in a sandbox, registers exactly one module
 *      with the expected id, and its factory runs with only React available.
 *   4. With `--enhance`, one real rewrite request round-trips through the model.
 *
 * Usage:
 *   node test/live.test.mjs [--port 19387] [--enhance]
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HASH_REVISION_LENGTH = 12
const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '..')
const pluginManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const pluginName = pluginManifest.name
const routeBase = `/plugins/dsh-prompt-enhancer-pro`

const args = process.argv.slice(2)
const portIndex = args.indexOf('--port')
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 19387
const withEnhance = args.includes('--enhance')
const origin = `http://127.0.0.1:${port}`

let passed = 0
let failed = 0

/**
 * Run one assertion group.
 * @param {string} name - check name.
 * @param {Function} body - check body, possibly async.
 * @returns {Promise<void>} fulfillment after the result is recorded.
 */
async function check(name, body) {
  try {
    await body()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}`)
    console.error(`       ${String(error?.message ?? error).split('\n')[0]}`)
  }
}

/**
 * Reproduce `framedHash` from dsh-client-modules.
 * @param {string} domain - hash domain tag.
 * @param {string[]} parts - framed parts.
 * @returns {string} the 12-character revision.
 */
function framedHash(domain, parts) {
  const hash = createHash('sha1').update(domain).update('\0')
  for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
  return hash.digest('hex').slice(0, HASH_REVISION_LENGTH)
}

/**
 * Reproduce `artifactRevision` from a captured baseline.
 * @param {{ mtimeMs: number, ctimeMs: number, size: number }} baseline - file stats.
 * @returns {string} the artifact revision.
 */
function artifactRevision(baseline) {
  return framedHash('plugin-artifact', [String(baseline.mtimeMs), String(baseline.ctimeMs), String(baseline.size)])
}

/**
 * Reproduce `comboUrl`.
 * @param {string[]} ids - entry ids in order.
 * @param {string} rev - combo revision.
 * @param {boolean} [sourceMap] - whether to address the map.
 * @returns {string} the absolute combo path.
 */
function comboUrl(ids, rev, sourceMap = false) {
  return `/plugins/??${ids.map((id) => `${id}/client.js${sourceMap ? '.map' : ''}`).join(',')}&rev=${rev}`
}

/**
 * Resolve the installed plugin directory the way app-boot does.
 * @returns {string | undefined} the directory, when installed.
 */
function resolveInstalledDir() {
  const anchor = join(homedir(), '.dsh', 'profiles', 'desktop', 'package.json')
  for (const searchPath of createRequire(anchor).resolve.paths(pluginName) ?? []) {
    const candidate = join(searchPath, pluginName)
    try {
      statSync(candidate)
      return candidate
    } catch {
      // keep searching
    }
  }
  return undefined
}

console.log(`live verification against ${origin}\n`)

console.log('installation')

const installedDir = resolveInstalledDir()
await check('the plugin is installed into the desktop profile', () => {
  assert.ok(installedDir !== undefined, `${pluginName} is not resolvable from the desktop profile`)
})

await check('the profile registers it as a bundle', () => {
  const manifest = JSON.parse(readFileSync(join(homedir(), '.dsh', 'profiles', 'desktop', 'package.json'), 'utf8'))
  assert.ok(manifest.dsh.profile.bundles.includes(pluginName), 'not listed in dsh.profile.bundles')
})

await check('the host route answers /status', async () => {
  const response = await fetch(`${origin}${routeBase}/status`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.styles) && body.styles.length > 0)
})

console.log('\nbrowser half in the module graph')

let servedBody = ''
await check('the advertised combo URL serves the bundle', async () => {
  const clientPath = join(installedDir, pluginManifest.exports['./client'].default)
  const stats = statSync(clientPath)
  const rev = artifactRevision({ mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, size: stats.size })
  const url = comboUrl([pluginName], rev)
  const response = await fetch(`${origin}${url}`)
  assert.equal(response.status, 200, `${url} did not serve (is the plugin active?)`)
  servedBody = await response.text()
  assert.ok(servedBody.length > 0)
})

await check('the source map is served too', async () => {
  const clientPath = join(installedDir, pluginManifest.exports['./client'].default)
  const stats = statSync(clientPath)
  const rev = artifactRevision({ mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, size: stats.size })
  const response = await fetch(`${origin}${comboUrl([pluginName], rev, true)}`)
  assert.equal(response.status, 200)
})

await check('the served script registers exactly one module with the right id', () => {
  const registered = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => registered.push(entry) } },
    console,
    AbortController,
    URL,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  }
  sandbox.globalThis = sandbox
  sandbox.window.fetch = async () => ({ ok: true, json: async () => ({}) })
  vm.createContext(sandbox)
  new vm.Script(servedBody, { filename: 'served-client.js' }).runInContext(sandbox)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, pluginName)
  assert.equal(typeof registered[0].factory, 'function')
})

await check('the factory runs with only React available', () => {
  const registered = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => registered.push(entry) } },
    console,
    AbortController,
    URL,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  }
  sandbox.globalThis = sandbox
  sandbox.window.fetch = async () => ({ ok: true, json: async () => ({}) })
  vm.createContext(sandbox)
  new vm.Script(servedBody, { filename: 'served-client.js' }).runInContext(sandbox)

  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useCallback: (callback) => callback,
    useRef: (value) => ({ current: value }),
    memo: (component) => component,
  }
  const exports = registered[0].factory((specifier) => {
    if (specifier === 'react' || specifier === 'react/jsx-runtime') return reactStub
    throw new Error(`the bundle requested a non-platform module: ${specifier}`)
  })
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual([...exports.inject].sort(), ['locale', 'slots'])
  assert.equal(typeof exports.PromptEnhancer, 'function')
})

await check('a repeat apply pass is a no-op rather than a throw', () => {
  // The regression that aborted the web boot: a second activation pass threw on
  // the locale registry, and a throwing body marks the entry FAILED.
  const registered = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => registered.push(entry) } },
    console,
    AbortController,
    URL,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  }
  sandbox.globalThis = sandbox
  sandbox.window.fetch = async () => ({ ok: true, json: async () => ({}) })
  vm.createContext(sandbox)
  new vm.Script(servedBody, { filename: 'served-client.js' }).runInContext(sandbox)

  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useCallback: (callback) => callback,
    useRef: (value) => ({ current: value }),
    memo: (component) => component,
  }
  const exports = registered[0].factory(() => reactStub)

  const namespaces = new Set()
  const record = { locales: 0, registrations: 0 }
  const ctx = {
    locale: {
      register: (ns) => {
        if (namespaces.has(ns)) throw new Error(`locale namespace "${ns}" already has locale "zh"`)
        namespaces.add(ns)
        record.locales += 1
        return () => {}
      },
    },
    effect: (body) => {
      body()
      return () => {}
    },
    slots: {
      inject: (_name, callback) => {
        callback()
        return () => {}
      },
      register: () => {
        record.registrations += 1
        return () => {}
      },
    },
  }

  exports.apply(ctx)
  exports.apply(ctx)
  assert.equal(record.locales, 1, 'the dictionary was registered twice')
  assert.equal(record.registrations, 1, 'the control was registered twice')
})

await check('the served bundle registers into conversation.input.right', () => {
  // The slot name is a contract with ui-conversation: that package declares the
  // slot and projects inputActions into it. The declaration itself lives in the
  // app archive, so this asserts the name the plugin registers under.
  assert.ok(
    servedBody.includes('conversation.input.right'),
    'the bundle no longer registers into the expected slot',
  )
  assert.ok(servedBody.includes('inputActions'), 'the control no longer consumes inputActions')
})

if (withEnhance) {
  console.log('\nreal rewrite round-trip')
  await check('a draft is rewritten by the model', async () => {
    const response = await fetch(`${origin}${routeBase}/enhance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft: '写个爬虫脚本', style: 'default' }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true, `model call failed: ${body.error ?? 'unknown'}`)
    assert.ok(body.text.length > 20, 'the rewrite is suspiciously short')
    console.log(`       -> ${body.text.slice(0, 80)}…`)
  })
}

console.log(`\nlive verification: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.error('\nIf a check failed: confirm the plugin is registered in dsh.profile.bundles,')
  console.error('then look at ~/.dsh/prompt-enhancer-pro-boot.log for "apply() entered" and "HTTP routes mounted".')
  process.exit(1)
}
