/**
 * Integration tests for the host half: the real HTTP route over a real
 * `node:http` server, with a fake `llm` service standing in for the model.
 *
 * These tests exercise the wiring the unit tests cannot reach: request
 * parsing, the size cap, provider resolution, stream accumulation, and the
 * error paths a user actually sees.
 *
 * Run: node test/host.test.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Keep this suite's activation logging out of the real boot log, and make the
// model deadline short enough to exercise in a test. Both must be set before the
// plugin module is evaluated, which is why they precede the static import below.
process.env.DSH_PROMPT_ENHANCER_LOG ??= join(mkdtempSync(join(tmpdir(), 'dsh-pe-host-')), 'boot.log')
process.env.DSH_PROMPT_ENHANCER_TIMEOUT_MS ??= '300'

import {
  DEFAULT_MODEL_TIMEOUT_MS,
  MAX_DRAFT_CHARS,
  ROUTE_PATH,
  apply,
  inject,
  modelTimeoutMs,
  isSameOriginRequest,
  timeoutMessage,
  releaseRouteOnce,
} from '../lib/index.js'

let passed = 0
let failed = 0

/**
 * Run one assertion group.
 * @param {string} name - test name.
 * @param {Function} body - test body, possibly async.
 * @returns {Promise<void>} fulfillment after the result is recorded.
 */
async function test(name, body) {
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
 * Build a fake host context exposing the services the plugin reads.
 * @param {object} [options] - service overrides.
 * @returns {{ ctx: object, mounted: object[], log: string[] }} the context and probe records.
 */
function fakeContext(options = {}) {
  // Module-level route state persists for the process, so each case starts clean.
  releaseRouteOnce()
  const mounted = []
  const log = []
  let webServer = options.webServer
  if (webServer === undefined) {
    webServer = {
      register(route) {
        // dsh-host-webserver throws on a duplicate (kind, path).
        if (mounted.some((existing) => existing.kind === route.kind && existing.path === route.path)) {
          throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
        }
        mounted.push(route)
        return () => {
          const index = mounted.indexOf(route)
          if (index >= 0) mounted.splice(index, 1)
        }
      },
    }
  }
  const services = {
    webServer,
    llm: options.llm,
    agentDefaultModel: options.agentDefaultModel,
  }
  const ctx = {
    // `webServer` is an own property, exactly as a real Cordis context exposes
    // services; the resolver form is the fallback.
    webServer: options.initialWebServer === 'absent' ? undefined : webServer,
    get(name) {
      log.push(`get:${name}`)
      if (name === 'webServer' && options.initialWebServer === 'absent') return undefined
      return services[name]
    },
    effect: (body) => {
      body()
      return () => {}
    },
  }
  return { ctx, mounted, log, webServer }
}

/**
 * Start a server that dispatches through the plugin's registered route.
 * @param {object} mounted - registered routes.
 * @returns {Promise<{ url: string, close: () => Promise<void> }>} the test server.
 */
async function startServer(mounted) {
  const route = mounted[0]
  assert.ok(route !== undefined, 'the plugin did not register a route')
  const server = createServer((req, res) => {
    route.handler(req, res).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(resolve)
    }),
  }
}

/**
 * POST a JSON body and decode the JSON reply.
 * @param {string} url - base URL.
 * @param {string} path - request path.
 * @param {object} body - JSON body.
 * @returns {Promise<{ status: number, body: object }>} the reply.
 */
async function postJson(url, path, body) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

/**
 * A fake `llm.stream` yielding the given chunks.
 * @param {object[]} chunks - chunks to yield.
 * @param {object} [capture] - object receiving the last options.
 * @returns {Function} the stream implementation.
 */
function fakeLlm(chunks, capture) {
  return {
    stream(options) {
      if (capture !== undefined) capture.options = options
      return (async function* generate() {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

console.log('host: route registration')

await test('mounts exactly one prefix route on the documented path', () => {
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([]) })
  apply(ctx, {})
  assert.equal(mounted.length, 1)
  assert.equal(mounted[0].kind, 'prefix')
  assert.equal(mounted[0].path, ROUTE_PATH)
})

await test('declares webServer as a hard dependency', () => {
  // The regression that broke the cold web boot: with an empty inject set the
  // fiber epoch never changes, so the only way to reach webServer was a bare
  // ctx.inject call whose child fiber left the entry inactive. Cordis must own
  // the wait instead.
  assert.equal(Array.isArray(inject), true)
  assert.equal(inject.includes('webServer'), true, 'webServer must be declared in inject')
})

await test('apply returns the route disposer for framework teardown', () => {
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([]) })
  const disposer = apply(ctx, {})
  assert.equal(typeof disposer, 'function', 'apply must return a disposer so a reload can unmount')
  assert.equal(mounted.length, 1)
  disposer()
  assert.equal(mounted.length, 0, 'the disposer did not remove the route')
})

await test('a repeat activation pass on the same server reuses the route', () => {
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([]) })
  apply(ctx, {})
  assert.equal(mounted.length, 1)

  // Same server, module claim already taken: the second pass must not call
  // register again, which would throw inside the owner.
  apply(ctx, {})
  assert.equal(mounted.length, 1, 'the route was registered twice on one server')
})

await test('a second server receives its own registration and does not collide', () => {
  const first = fakeContext({ llm: fakeLlm([]) })
  apply(first.ctx, {})
  assert.equal(first.mounted.length, 1)

  const firstDisposer = apply(first.ctx, {})
  assert.equal(firstDisposer, undefined, 'the repeat pass reused the live route')

  // A fresh server starts with the module claim reset (as framework teardown
  // leaves it) and must be able to take the route without colliding. Resetting
  // also disposes the previous server's route, which is the intended ownership
  // hand-off rather than a leak.
  const second = fakeContext({ llm: fakeLlm([]) })
  apply(second.ctx, {})
  assert.equal(second.mounted.length, 1, 'the second server never received the route')
  assert.equal(first.mounted.length, 0, 'the previous route was left registered')
})

await test('an absent webServer never throws and leaves the entry activatable', () => {
  // Cordis will not run apply() until webServer exists, but a defensive path
  // must still not throw: a throwing body marks the entry failed.
  const { ctx } = fakeContext({ llm: fakeLlm([]), initialWebServer: 'absent' })
  let threw
  let disposer
  try {
    disposer = apply(ctx, {})
  } catch (error) {
    threw = error
  }
  assert.equal(threw, undefined, `apply threw instead of degrading: ${String(threw)}`)
  assert.equal(disposer, undefined, 'nothing was mounted, so nothing should be returned')
})

await test('a throwing webServer.register is contained, not escaped', () => {
  // A throw in a Cordis plugin body marks the entry FAILED, and the startup
  // audit then aborts the whole web boot. Losing the route degrades one feature;
  // losing the boot loses the application, so the failure must stay contained.
  const { ctx } = fakeContext({
    llm: fakeLlm([]),
    webServer: {
      register() {
        throw new Error('webserver: duplicate prefix route "/plugins/dsh-prompt-enhancer"')
      },
    },
  })
  let threw
  let disposer
  try {
    disposer = apply(ctx, {})
  } catch (error) {
    threw = error
  }
  assert.equal(threw, undefined, `the failure escaped apply(): ${String(threw)}`)
  assert.equal(disposer, undefined, 'nothing was mounted, so nothing should be returned')
})

await test('a webServer whose register is missing is contained too', () => {
  const { ctx } = fakeContext({ llm: fakeLlm([]), webServer: {} })
  let threw
  try {
    apply(ctx, {})
  } catch (error) {
    threw = error
  }
  assert.equal(threw, undefined, `the failure escaped apply(): ${String(threw)}`)
})

await test('a disabled route mounts nothing', () => {
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([]) })
  apply(ctx, { enableRoute: false })
  assert.equal(mounted.length, 0)
})

await test('config may arrive as Cordis getters', () => {
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([]) })
  apply(ctx, { enableRoute: () => true, debugLog: () => false })
  assert.equal(mounted.length, 1)
})

await test('an invalid config still mounts the route and is reported', () => {
  // Regression: an invalid value was reported as a schema issue, and Cordis turns
  // issues into a thrown ValidationError from inside the fiber reload — so a
  // single typo stopped the plugin from activating. The plugin must stay
  // functional and say what it ignored.
  const logPath = process.env.DSH_PROMPT_ENHANCER_LOG
  const before = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''

  const { ctx, mounted } = fakeContext({ llm: fakeLlm([]) })
  apply(ctx, { defaultStyle: 'structure', debugLog: 'true', provider: 123 })

  assert.equal(mounted.length, 1, 'the route must still mount')
  const added = readFileSync(logPath, 'utf8').slice(before.length)
  assert.ok(added.includes('ignored invalid value'), `the coercion was not logged: ${added}`)
  assert.ok(added.includes('defaultStyle'), 'the report did not name the field')
})

await test('a valid config logs no coercion', () => {
  const logPath = process.env.DSH_PROMPT_ENHANCER_LOG
  const before = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([]) })
  apply(ctx, { provider: 'p', model: 'm', defaultStyle: 'concise', debugLog: true, enableRoute: true })
  assert.equal(mounted.length, 1)
  const added = readFileSync(logPath, 'utf8').slice(before.length)
  assert.ok(!added.includes('ignored invalid value'), `a valid config was reported: ${added}`)
})

console.log('host: /status')

await test('status reports the styles and default style', async () => {
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([]) })
  apply(ctx, { defaultStyle: 'concise' })
  const server = await startServer(mounted)
  try {
    const response = await fetch(`${server.url}${ROUTE_PATH}/status`)
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.deepEqual(body.styles, ['default', 'structured', 'concise', 'expand'])
    assert.equal(body.defaultStyle, 'concise')
    // The browser half cannot import the engine, so the cap is published here
    // instead of being duplicated as a number that can drift.
    assert.equal(body.maxDraftChars, MAX_DRAFT_CHARS)
  } finally {
    await server.close()
  }
})

await test('an unknown sub-path answers 404', async () => {
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([]) })
  apply(ctx, {})
  const server = await startServer(mounted)
  try {
    const response = await fetch(`${server.url}${ROUTE_PATH}/nope`)
    assert.equal(response.status, 404)
  } finally {
    await server.close()
  }
})

await test('a client failure report is accepted and logged', async () => {
  // The browser half posts its own activation failures here because the
  // renderer's console is not where anyone looks first.
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([]) })
  apply(ctx, { debugLog: true })
  const server = await startServer(mounted)
  try {
    const reply = await postJson(server.url, `${ROUTE_PATH}/client-error`, {
      message: 'locale namespace "promptEnhancer" already has locale "zh"',
      stack: 'Error: boom\n  at apply',
    })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.ok, true)
  } finally {
    await server.close()
  }
})

await test('a client heartbeat is accepted and distinguished from a failure', async () => {
  // Without the heartbeat, "the button is missing" cannot be told apart from
  // "the browser half never ran", because a silent early return leaves no trace.
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([]) })
  apply(ctx, { debugLog: true })
  const server = await startServer(mounted)
  try {
    const reply = await postJson(server.url, `${ROUTE_PATH}/client-error`, {
      phase: 'applied',
      hasLocale: true,
      hasSlots: false,
      dictionariesRegistered: true,
      controlRegistered: false,
    })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.ok, true)
  } finally {
    await server.close()
  }
})

await test('a client failure report tolerates a malformed body', async () => {
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([]) })
  apply(ctx, {})
  const server = await startServer(mounted)
  try {
    const response = await fetch(`${server.url}${ROUTE_PATH}/client-error`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json{',
    })
    // Diagnostics are best-effort: an unreadable report is still accepted, so a
    // reporting failure can never become a second failure.
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
  } finally {
    await server.close()
  }
})

await test('GET on /client-error answers 405', async () => {
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([]) })
  apply(ctx, {})
  const server = await startServer(mounted)
  try {
    const response = await fetch(`${server.url}${ROUTE_PATH}/client-error`)
    assert.equal(response.status, 405)
  } finally {
    await server.close()
  }
})

await test('GET on /enhance answers 405', async () => {
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([]) })
  apply(ctx, {})
  const server = await startServer(mounted)
  try {
    const response = await fetch(`${server.url}${ROUTE_PATH}/enhance`)
    assert.equal(response.status, 405)
  } finally {
    await server.close()
  }
})

console.log('host: /enhance')

await test('a successful rewrite returns the cleaned text', async () => {
  const capture = {}
  const llm = fakeLlm(
    [
      { type: 'text-delta', index: 0, text: '"请编写一个爬虫脚本，' },
      { type: 'text-delta', index: 0, text: '明确目标站点与字段。"' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    capture,
  )
  const { ctx, mounted } = fakeContext({ llm })
  apply(ctx, { provider: 'test-provider', model: 'test-model' })
  const server = await startServer(mounted)
  try {
    const reply = await postJson(server.url, `${ROUTE_PATH}/enhance`, { draft: '写个爬虫', style: 'structured' })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.ok, true)
    assert.equal(reply.body.text, '请编写一个爬虫脚本，明确目标站点与字段。')
    assert.equal(reply.body.style, 'structured')
    assert.equal(capture.options.provider, 'test-provider')
    assert.equal(capture.options.model, 'test-model')
    // Rewriting is deterministic work, so the request must be cold.
    assert.equal(capture.options.temperature, 0)
    assert.equal(capture.options.messages[0].role, 'system')
    assert.ok(capture.options.messages[0].content[0].text.includes('highest priority'))
  } finally {
    await server.close()
  }
})

await test('an unknown style falls back to the configured default', async () => {
  const capture = {}
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([{ type: 'text-delta', text: 'ok' }], capture) })
  apply(ctx, { provider: 'p', model: 'm', defaultStyle: 'expand' })
  const server = await startServer(mounted)
  try {
    const reply = await postJson(server.url, `${ROUTE_PATH}/enhance`, { draft: 'x', style: 'bogus' })
    assert.equal(reply.body.style, 'expand')
    assert.equal(capture.options.messages.length, 2)
  } finally {
    await server.close()
  }
})

await test('the requested style reaches the model request', async () => {
  const capture = {}
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([{ type: 'text-delta', text: 'ok' }], capture) })
  apply(ctx, { provider: 'p', model: 'm' })
  const server = await startServer(mounted)
  try {
    await postJson(server.url, `${ROUTE_PATH}/enhance`, { draft: 'x', style: 'concise' })
    const userText = capture.options.messages.find((message) => message.role === 'user').content[0].text
    assert.ok(userText.includes('compress aggressively'), 'the concise addendum never reached the model')
  } finally {
    await server.close()
  }
})

await test('an empty draft is refused without calling the model', async () => {
  let called = false
  const llm = {
    stream() {
      called = true
      return (async function* generate() {})()
    },
  }
  const { ctx, mounted } = fakeContext({ llm })
  apply(ctx, {})
  const server = await startServer(mounted)
  try {
    const reply = await postJson(server.url, `${ROUTE_PATH}/enhance`, { draft: '   ' })
    assert.equal(reply.body.ok, false)
    assert.ok(reply.body.error.includes('草稿为空'))
    assert.equal(called, false, 'the model was called for an empty draft')
  } finally {
    await server.close()
  }
})

await test('a missing llm service is reported, not thrown', async () => {
  const { ctx, mounted } = fakeContext({ llm: undefined })
  apply(ctx, {})
  const server = await startServer(mounted)
  try {
    const reply = await postJson(server.url, `${ROUTE_PATH}/enhance`, { draft: '写点东西' })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.ok, false)
    assert.ok(reply.body.error.includes('llm'))
  } finally {
    await server.close()
  }
})

await test('an unresolved provider is reported with its remedy', async () => {
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([]) })
  apply(ctx, {})
  const server = await startServer(mounted)
  try {
    const reply = await postJson(server.url, `${ROUTE_PATH}/enhance`, { draft: '写点东西' })
    assert.equal(reply.body.ok, false)
    assert.ok(reply.body.error.includes('provider'))
  } finally {
    await server.close()
  }
})

await test('the host default model is used when config leaves it open', async () => {
  const capture = {}
  const { ctx, mounted } = fakeContext({
    llm: fakeLlm([{ type: 'text-delta', text: 'ok' }], capture),
    agentDefaultModel: { currentSelection: () => ({ provider: 'from-service', model: 'svc-model' }) },
  })
  apply(ctx, {})
  const server = await startServer(mounted)
  try {
    const reply = await postJson(server.url, `${ROUTE_PATH}/enhance`, { draft: '写点东西' })
    assert.equal(reply.body.ok, true)
    assert.equal(capture.options.provider, 'from-service')
    assert.equal(capture.options.model, 'svc-model')
  } finally {
    await server.close()
  }
})

/** Send one raw request so a test can control every header. */
async function rawRequest(url, path, options) {
  const response = await fetch(`${url}${path}`, options)
  let body
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  return { status: response.status, body }
}

await test('a cross-site simple request is refused before the model is called', async () => {
  // Regression: `text/plain` is a CORS-safelisted type, so it needs NO preflight.
  // A foreign page could POST here with `mode: 'no-cors'` and each request spent
  // the user's model quota; a live probe returned 200 and a real rewrite.
  let modelCalls = 0
  const llm = {
    stream() {
      modelCalls += 1
      return (async function* generate() {
        yield { type: 'text-delta', text: 'should never happen' }
      })()
    },
  }
  const { ctx, mounted } = fakeContext({ llm })
  apply(ctx, { provider: 'p', model: 'm' })
  const server = await startServer(mounted)
  try {
    const reply = await rawRequest(server.url, `${ROUTE_PATH}/enhance`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
      body: JSON.stringify({ draft: 'x' }),
    })
    assert.equal(reply.status, 403, `expected 403, got ${String(reply.status)}`)
    assert.equal(modelCalls, 0, 'the model was called for a cross-site request')
  } finally {
    await server.close()
  }
})

await test('a DNS-rebinding shape is refused because Host is not loopback', async () => {
  // Regression: comparing `Origin` to `Host` accepted a rebinding shape. A page
  // served from `http://attacker.example:19387` sends an `Origin` and `Host` that
  // AGREE with each other, and they still agree when the attacker's name resolves
  // to 127.0.0.1 — so the old check passed. Requiring `Host` itself to be loopback
  // breaks it, because the browser sends the attacker's NAME in `Host`.
  let modelCalls = 0
  const llm = {
    stream() {
      modelCalls += 1
      return (async function* generate() {
        yield { type: 'text-delta', text: 'should never happen' }
      })()
    },
  }
  const { ctx, mounted } = fakeContext({ llm })
  apply(ctx, { provider: 'p', model: 'm' })
  const server = await startServer(mounted)
  try {
    const rebound = await rawRequest(server.url, `${ROUTE_PATH}/enhance`, {
      method: 'POST',
      headers: {
        // Self-consistent, and therefore accepted by a host-only comparison.
        host: 'attacker.example:19387',
        origin: 'http://attacker.example:19387',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ draft: 'x' }),
    })
    assert.equal(rebound.status, 403, `the rebinding shape was accepted: ${String(rebound.status)}`)
    assert.equal(modelCalls, 0, 'the model was called for a rebound request')
  } finally {
    await server.close()
  }
})

await test('the pure guard accepts loopback spellings and rejects the rest', () => {
  const request = (headers) => ({ method: 'POST', headers })
  const json = { 'content-type': 'application/json' }

  for (const host of ['127.0.0.1:19387', 'localhost:19387', '[::1]:19387']) {
    assert.equal(
      isSameOriginRequest(request({ host, ...json })),
      true,
      `a loopback Host was refused: ${host}`,
    )
  }
  for (const host of ['attacker.example:19387', '192.168.1.5:19387', '', '127.0.0.1.evil.example']) {
    assert.equal(isSameOriginRequest(request({ host, ...json })), false, `a non-loopback Host passed: ${host}`)
  }
  // A loopback Host with an agreeing Origin is fine; a foreign scheme is not.
  assert.equal(
    isSameOriginRequest(request({ host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387', ...json })),
    true,
  )
  assert.equal(
    isSameOriginRequest(request({ host: '127.0.0.1:19387', origin: 'file:///etc/passwd', ...json })),
    false,
  )
  assert.equal(
    isSameOriginRequest(request({ host: '127.0.0.1:19387', origin: 'https://evil.example', ...json })),
    false,
  )
})

await test('a cross-site declaration is refused even with a JSON content type', async () => {
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }]) })
  apply(ctx, { provider: 'p', model: 'm' })
  const server = await startServer(mounted)
  try {
    const reply = await rawRequest(server.url, `${ROUTE_PATH}/enhance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ draft: 'x' }),
    })
    assert.equal(reply.status, 403)
  } finally {
    await server.close()
  }
})

await test('the application\u2019s own renderer origin is accepted', () => {
  // Regression, measured against the RUNNING host: a fetch from the desktop
  // renderer (served from the privileged `dsh-app://` scheme) to
  // http://127.0.0.1:<port> is cross-origin, so the browser attaches
  // `Origin: dsh-app://app`. `new URL` parses that as hostname `app`, which is not
  // loopback, so the loopback rule rejected the application's own requests:
  //   POST /enhance  Host: 127.0.0.1:19387  Origin: dsh-app://app  ->  403
  const request = (headers) => ({ method: 'POST', headers })
  const json = { 'content-type': 'application/json' }

  assert.equal(
    isSameOriginRequest(request({ host: '127.0.0.1:19387', origin: 'dsh-app://app', ...json })),
    true,
    'the application\u2019s own origin was refused',
  )
  // But nothing else may ride in on the scheme.
  for (const origin of ['dsh-app://evil', 'dsh-app://', 'file:///etc/passwd', 'https://evil.example']) {
    assert.equal(
      isSameOriginRequest(request({ host: '127.0.0.1:19387', origin, ...json })),
      false,
      `a foreign origin was accepted: ${origin}`,
    )
  }
  // And the loopback Host rule still binds, including for the own origin.
  assert.equal(
    isSameOriginRequest(request({ host: 'attacker.example:19387', origin: 'dsh-app://app', ...json })),
    false,
    'the own origin bypassed the loopback Host rule',
  )
})

await test('the application\u2019s own requests are still served', async () => {
  // The guard must not break the client half. Its two POSTs send
  // `content-type: application/json` with no cross-site signal, and its `/status`
  // probe is a plain GET.
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }]) })
  apply(ctx, { provider: 'p', model: 'm' })
  const server = await startServer(mounted)
  try {
    const sameOrigin = await rawRequest(server.url, `${ROUTE_PATH}/enhance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({ draft: '写点东西' }),
    })
    assert.notEqual(sameOrigin.status, 403, 'a same-origin request was refused')

    const noOrigin = await rawRequest(server.url, `${ROUTE_PATH}/enhance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft: '写点东西' }),
    })
    assert.notEqual(noOrigin.status, 403, 'a request without an Origin header was refused')

    const probe = await fetch(`${server.url}${ROUTE_PATH}/status`)
    assert.equal(probe.status, 200, 'the status probe was refused')

    const report = await rawRequest(server.url, `${ROUTE_PATH}/client-error`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'client diagnostics' }),
    })
    assert.equal(report.status, 200, 'the diagnostics report was refused')
  } finally {
    await server.close()
  }
})

await test('a foreign Origin on the read-only probe is still refused', async () => {
  // The probe stays open by pathname, but a foreign origin must not be able to
  // read the plugin's configuration through it either.
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([]) })
  apply(ctx, {})
  const server = await startServer(mounted)
  try {
    const reply = await rawRequest(server.url, `${ROUTE_PATH}/status`, {
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(reply.status, 200, 'the status probe is intentionally open')
    // CORS is what stops the page from READING it: no allow-origin header is set.
    const response = await fetch(`${server.url}${ROUTE_PATH}/status`, {
      headers: { origin: 'https://evil.example' },
    })
    assert.equal(response.headers.get('access-control-allow-origin'), null)
  } finally {
    await server.close()
  }
})

await test('a token-limit finish still returns the rewritten text', async () => {  // Regression: `max-tokens` was reported as a failure, so the host discarded a
  // usable answer — at exactly the moment the length backstop exists for. With a
  // 1024-token budget and CJK output this happens in normal use.
  const llm = fakeLlm([
    { type: 'text-delta', text: '请帮我审查这段代码，指出其中的问题。' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ])
  const { ctx, mounted } = fakeContext({ llm })
  apply(ctx, { provider: 'p', model: 'm' })
  const server = await startServer(mounted)
  try {
    const reply = await postJson(server.url, `${ROUTE_PATH}/enhance`, { draft: '看看代码' })
    assert.equal(reply.body.ok, true, `the text was discarded: ${JSON.stringify(reply.body)}`)
    assert.equal(reply.body.text, '请帮我审查这段代码，指出其中的问题。')
  } finally {
    await server.close()
  }
})

await test('a truncated result is clamped to the output limit', async () => {
  // The token-limit path feeds the same clamp, so a runaway answer is still
  // bounded rather than passed through.
  const long = '这是一句完整的说明。'.repeat(200)
  const llm = fakeLlm([
    { type: 'text-delta', text: long },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ])
  const { ctx, mounted } = fakeContext({ llm })
  apply(ctx, { provider: 'p', model: 'm' })
  const server = await startServer(mounted)
  try {
    const reply = await postJson(server.url, `${ROUTE_PATH}/enhance`, { draft: '写点东西' })
    assert.equal(reply.body.ok, true)
    assert.ok(reply.body.text.length <= 1200, `unclamped length ${String(reply.body.text.length)}`)
  } finally {
    await server.close()
  }
})

await test('an aborted finish reason still discards the partial text', async () => {
  // The opposite of max-tokens: an abort carries no usable answer.
  const llm = fakeLlm([
    { type: 'text-delta', text: 'half a thought' },
    { type: 'finish', reason: { kind: 'aborted' } },
  ])
  const { ctx, mounted } = fakeContext({ llm })
  apply(ctx, { provider: 'p', model: 'm' })
  const server = await startServer(mounted)
  try {
    const reply = await postJson(server.url, `${ROUTE_PATH}/enhance`, { draft: '写点东西' })
    assert.equal(reply.body.ok, false)
  } finally {
    await server.close()
  }
})

await test('a model failure finish reason becomes a user-facing error', async () => {
  const llm = fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { message: 'quota exceeded' } } }])
  const { ctx, mounted } = fakeContext({ llm })
  apply(ctx, { provider: 'p', model: 'm' })
  const server = await startServer(mounted)
  try {
    const reply = await postJson(server.url, `${ROUTE_PATH}/enhance`, { draft: '写点东西' })
    assert.equal(reply.body.ok, false)
    assert.ok(reply.body.error.includes('quota exceeded'))
  } finally {
    await server.close()
  }
})

await test('an empty model response is reported', async () => {
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }]) })
  apply(ctx, { provider: 'p', model: 'm' })
  const server = await startServer(mounted)
  try {
    const reply = await postJson(server.url, `${ROUTE_PATH}/enhance`, { draft: '写点东西' })
    assert.equal(reply.body.ok, false)
    assert.ok(reply.body.error.includes('空内容'))
  } finally {
    await server.close()
  }
})

await test('a thrown stream becomes a reported failure, not a 500', async () => {
  const llm = {
    stream() {
      throw new Error('adapter exploded')
    },
  }
  const { ctx, mounted } = fakeContext({ llm })
  apply(ctx, { provider: 'p', model: 'm' })
  const server = await startServer(mounted)
  try {
    const reply = await postJson(server.url, `${ROUTE_PATH}/enhance`, { draft: '写点东西' })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.ok, false)
    assert.ok(reply.body.error.includes('adapter exploded'))
  } finally {
    await server.close()
  }
})

await test('a malformed body is answered 400', async () => {
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([]) })
  apply(ctx, {})
  const server = await startServer(mounted)
  try {
    const response = await fetch(`${server.url}${ROUTE_PATH}/enhance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json{',
    })
    assert.equal(response.status, 400)
  } finally {
    await server.close()
  }
})

await test('an over-large body is refused', async () => {
  const { ctx, mounted } = fakeContext({ llm: fakeLlm([]) })
  apply(ctx, {})
  const server = await startServer(mounted)
  try {
    const response = await fetch(`${server.url}${ROUTE_PATH}/enhance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft: 'x'.repeat(200000) }),
    })
    assert.equal(response.status, 400)
  } finally {
    await server.close()
  }
})

await test('a model stream that never ends is abandoned at the deadline', async () => {
  // Regression: with no deadline, a provider that produces no chunk left
  // `for await` pending forever — no response, no released controller, and
  // another full call on retry. The request must end on its own.
  let aborted = false
  const hanging = {
    stream(options) {
      return (async function* generate() {
        // Honour the signal the way a real adapter does: never yield, and reject
        // once aborted.
        await new Promise((_resolve, reject) => {
          const signal = options?.signal
          if (signal === undefined) return
          if (signal.aborted) {
            aborted = true
            reject(new Error('aborted'))
            return
          }
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(new Error('aborted'))
            },
            { once: true },
          )
        })
      })()
    },
  }

  const { ctx, mounted } = fakeContext({ llm: hanging })
  // A route without an explicit provider is refused before the model is called,
  // so the deadline would never be reached.
  apply(ctx, { provider: 'p', model: 'm' })
  const server = await startServer(mounted)
  try {
    const started = Date.now()
    const response = await fetch(`${server.url}${ROUTE_PATH}/enhance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft: '请帮我优化这段需求' }),
    })
    const elapsed = Date.now() - started
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.equal(body.ok, false, 'a stalled call must not report success')
    assert.ok(
      String(body.error).includes('超时'),
      `the error did not name the timeout: ${String(body.error)}`,
    )
    assert.ok(aborted, 'the adapter signal was never aborted')
    // The deadline must fire well before Node's own 300s requestTimeout.
    assert.ok(elapsed < 5000, `the request took ${String(elapsed)}ms`)
  } finally {
    await server.close()
  }
})

await test('a real adapter ending with an aborted finish still reports a timeout', async () => {
  // Regression: a real dsh-llm adapter does NOT throw on abort — it ENDS the
  // stream with a terminal `finish {kind:'aborted', failure}` chunk. The
  // `failure` branch therefore ran first and returned the raw English
  // "The operation was aborted", leaving the timeout branch as dead code.
  const shapes = []
  const adapterShaped = {
    stream(options) {
      return (async function* generate() {
        await new Promise((resolve) => {
          const signal = options?.signal
          if (signal === undefined) {
            resolve()
            return
          }
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener('abort', resolve, { once: true })
        })
        shapes.push('aborted')
        yield {
          type: 'finish',
          reason: {
            kind: 'aborted',
            failure: { message: 'The operation was aborted', code: 'ABORTED' },
          },
        }
      })()
    },
  }

  const { ctx, mounted } = fakeContext({ llm: adapterShaped })
  apply(ctx, { provider: 'p', model: 'm' })
  const server = await startServer(mounted)
  try {
    const response = await fetch(`${server.url}${ROUTE_PATH}/enhance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft: '请帮我优化这段需求' }),
    })
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.equal(body.ok, false)
    assert.deepEqual(shapes, ['aborted'], 'the adapter was not aborted')
    assert.ok(
      String(body.error).includes('超时'),
      `an aborted adapter must be reported as a timeout, got: ${String(body.error)}`,
    )
    assert.ok(
      !String(body.error).includes('The operation was aborted'),
      `the raw adapter failure leaked to the user: ${String(body.error)}`,
    )
  } finally {
    await server.close()
  }
})

await test('a sub-second deadline is not reported as "0 seconds"', () => {
  assert.ok(timeoutMessage(200).includes('200 毫秒'), timeoutMessage(200))
  assert.ok(!timeoutMessage(200).includes('0 秒'), timeoutMessage(200))
  assert.ok(timeoutMessage(60_000).includes('60 秒'), timeoutMessage(60_000))
})

await test('the deadline is read per request, so an override always applies', () => {
  assert.equal(modelTimeoutMs(), 300, 'the test override was not applied')
  assert.ok(modelTimeoutMs() > 0)
  const previous = process.env.DSH_PROMPT_ENHANCER_TIMEOUT_MS
  try {
    process.env.DSH_PROMPT_ENHANCER_TIMEOUT_MS = '1234'
    assert.equal(modelTimeoutMs(), 1234)
    process.env.DSH_PROMPT_ENHANCER_TIMEOUT_MS = 'not-a-number'
    assert.equal(modelTimeoutMs(), DEFAULT_MODEL_TIMEOUT_MS, 'a bad override must fall back')
    delete process.env.DSH_PROMPT_ENHANCER_TIMEOUT_MS
    assert.equal(modelTimeoutMs(), DEFAULT_MODEL_TIMEOUT_MS)
  } finally {
    if (previous === undefined) delete process.env.DSH_PROMPT_ENHANCER_TIMEOUT_MS
    else process.env.DSH_PROMPT_ENHANCER_TIMEOUT_MS = previous
  }
})

console.log(`\nhost integration: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
