/**
 * Cold-boot verification against the REAL Cordis engine.
 *
 * The regression that broke startup was a lifecycle bug, not a logic bug: the
 * plugin reached a service that appeared later through a bare `ctx.inject(...)`
 * call, which left its entry inactive and made the startup audit abort the web
 * boot. Offline unit tests with fake contexts cannot catch that, because they
 * never run Cordis' fiber state machine.
 *
 * This test imports the same `@deepseek-ai/cordis` the app ships, mounts the
 * plugin exactly as the loader does, provides a `webServer` service, and
 * asserts the fiber reaches ACTIVE with the route registered and the disposer
 * owned by the framework.
 *
 * `@deepseek-ai/cordis` is not a dependency of this plugin, so the suite skips
 * itself when the app's copy is not resolvable (for example on a machine where
 * the checkout does not sit next to the installation). To run it with the app's
 * engine, expose the installed `node_modules` on the resolution path, e.g.
 *
 *   node --experimental-default-type=module test/cordis.test.mjs   (with NODE_PATH set)
 *
 * or run it from a directory whose ancestor `node_modules` contains the package.
 *
 * Run: node test/cordis.test.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

/**
 * Resolve the app's Cordis, or report that this environment cannot run the suite.
 * @returns {string | undefined} a file URL for the module, when resolvable.
 */
function resolveCordis() {
  try {
    // On Windows an absolute path must be a file:// URL before dynamic import.
    return pathToFileURL(require.resolve('@deepseek-ai/cordis')).href
  } catch {
    return undefined
  }
}

const cordisUrl = resolveCordis()
if (cordisUrl === undefined) {
  console.log('cordis cold boot: SKIPPED — @deepseek-ai/cordis is not resolvable from here')
  console.log('  (this suite needs the app\'s own Cordis; see the header comment)')
  process.exit(0)
}
const { Context, Service } = await import(cordisUrl)

const pluginModule = await import('../lib/index.js')

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
/** Fiber state codes from Cordis: 0 PENDING, 2 ACTIVE, 3 FAILED, 4 DISPOSED. */
const FIBER_ACTIVE = 2
const FIBER_FAILED = 3

/**
 * Yield to Cordis until the fiber reaches a terminal-looking state.
 *
 * Activation spans several microtask turns (epoch change, reload, execute,
 * state update), so polling the observable state is far more reliable than
 * counting `await Promise.resolve()` calls.
 * @param {object} fiber - the Cordis fiber.
 * @param {(state: number) => boolean} predicate - state to wait for.
 * @param {number} [rounds] - maximum drains.
 * @returns {Promise<number>} the observed state.
 */
async function waitForState(fiber, predicate, rounds = 200) {
  for (let i = 0; i < rounds; i += 1) {
    if (predicate(fiber.state)) return fiber.state
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return fiber.state
}

/**
 * Wait until the fiber is ACTIVE, or report the state it settled in.
 * @param {object} fiber - the Cordis fiber.
 * @returns {Promise<number>} the observed state.
 */
function waitForActive(fiber) {
  return waitForState(fiber, (state) => state === FIBER_ACTIVE || state === FIBER_FAILED)
}

/**
 * A stand-in for the host's web server service.
 */
class FakeWebServer extends Service {
  /** Routes registered through this service. */
  routes = []

  /**
   * @param {object} ctx - owning context.
   */
  constructor(ctx) {
    super(ctx, 'webServer')
  }

  /**
   * Register one route.
   * @param {{ kind: string, path: string, handler: Function }} route - the route.
   * @returns {() => void} the disposer.
   */
  register(route) {
    if (this.routes.some((existing) => existing.kind === route.kind && existing.path === route.path)) {
      throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    }
    this.routes.push(route)
    return () => {
      const index = this.routes.indexOf(route)
      if (index >= 0) this.routes.splice(index, 1)
    }
  }
}

/**
 * Mount the plugin on a fresh root with the given services.
 * @param {(ctx: object) => void} [provideBefore] - services to mount first.
 * @returns {Promise<{ root: object, fiber: object, webServer: object | undefined }>} the mounted tree.
 */
async function mountPlugin(provideBefore) {
  const root = new Context()
  let webServer
  if (provideBefore !== undefined) {
    webServer = new FakeWebServer(root)
    provideBefore(root)
  }
  const fiber = root.plugin(pluginModule, { provider: 'p', model: 'm', debugLog: false })
  await waitForActive(fiber)
  return { root, fiber, webServer }
}

console.log('cordis: cold boot with webServer already available')

await test('the plugin entry reaches ACTIVE', async () => {
  pluginModule.releaseRouteOnce()
  const root = new Context()
  const webServer = new FakeWebServer(root)
  const fiber = root.plugin(pluginModule, { provider: 'p', model: 'm', debugLog: false })
  await waitForActive(fiber)
  assert.notEqual(fiber.state, FIBER_FAILED, 'the entry failed to activate')
  assert.equal(fiber.state, FIBER_ACTIVE, `expected ACTIVE, got ${String(fiber.state)}`)
  assert.equal(webServer.routes.length, 1, 'the route was not registered')
  assert.equal(webServer.routes[0].path, '/plugins/dsh-prompt-enhancer')
  await root.fiber.dispose()
})

await test('the declared dependency is exactly webServer', () => {
  assert.equal(Array.isArray(pluginModule.inject), true)
  assert.deepEqual([...pluginModule.inject], ['webServer'])
})

console.log('cordis: cold boot where webServer arrives later')

await test('the entry waits for webServer instead of failing', async () => {
  // This is the exact startup ordering that broke: the plugin is mounted
  // before webServer exists. Cordis must keep the entry pending, then activate
  // it once the service appears — never report it as failed.
  pluginModule.releaseRouteOnce()
  const root = new Context()
  const fiber = root.plugin(pluginModule, { provider: 'p', model: 'm', debugLog: false })
  await Promise.resolve()
  await Promise.resolve()

  assert.notEqual(fiber.state, FIBER_FAILED, 'the entry failed while waiting for webServer')

  // Now the service arrives, exactly as dsh-host-webserver does at boot.
  const webServer = new FakeWebServer(root)
  await waitForActive(fiber)

  assert.notEqual(fiber.state, FIBER_FAILED, 'the entry failed once webServer appeared')
  assert.equal(fiber.state, FIBER_ACTIVE, `expected ACTIVE after the service arrived, got ${String(fiber.state)}`)
  assert.equal(webServer.routes.length, 1, 'the route was not registered after the service arrived')

  await root.fiber.dispose()
  pluginModule.releaseRouteOnce()
})

await test('apply hands the framework a disposer that removes the route', async () => {
  // Ownership contract, measured directly against a real Cordis context so the
  // returned effect is in this test's hands. Cordis runs this same effect on
  // fiber teardown; asserting the framework's internal unload *ordering* here
  // would test Cordis, not the plugin.
  pluginModule.releaseRouteOnce()
  const root = new Context()
  const webServer = new FakeWebServer(root)
  const disposer = pluginModule.apply(root, { provider: 'p', model: 'm', debugLog: false })
  assert.equal(webServer.routes.length, 1, 'apply did not register the route')
  assert.equal(typeof disposer, 'function', 'apply did not return a disposer')
  disposer()
  assert.equal(webServer.routes.length, 0, 'the disposer did not remove the route')
})

await test('re-applying on the same server never trips the duplicate guard', async () => {
  pluginModule.releaseRouteOnce()
  const root = new Context()
  const webServer = new FakeWebServer(root)
  const first = pluginModule.apply(root, { provider: 'p', model: 'm', debugLog: false })
  assert.equal(typeof first, 'function')
  assert.equal(webServer.routes.length, 1)

  // A second activation pass on the same live server reuses the route instead
  // of registering a duplicate, which dsh-host-webserver rejects with a throw.
  const second = pluginModule.apply(root, { provider: 'p', model: 'm', debugLog: false })
  assert.equal(webServer.routes.length, 1, 'a duplicate route was registered')
  assert.equal(second, undefined, 'the repeat pass returned its own disposer')

  // The original owner still owns teardown.
  first()
  assert.equal(webServer.routes.length, 0)

  // After teardown the same server is mountable again.
  const third = pluginModule.apply(root, { provider: 'p', model: 'm', debugLog: false })
  assert.equal(webServer.routes.length, 1, 'the route did not come back after teardown')
  assert.equal(typeof third, 'function')
  third()
  assert.equal(webServer.routes.length, 0)
})

await test('a fiber that is disposed does not throw', async () => {
  pluginModule.releaseRouteOnce()
  const root = new Context()
  const webServer = new FakeWebServer(root)
  const fiber = root.plugin(pluginModule, { provider: 'p', model: 'm', debugLog: false })
  await waitForActive(fiber)
  assert.equal(webServer.routes.length, 1)
  await root.fiber.dispose()
  // The framework owns route removal here; this asserts teardown is clean.
  assert.notEqual(fiber.state, FIBER_FAILED, 'disposal reported a failure')
  pluginModule.releaseRouteOnce()
})

console.log(`\ncordis cold boot: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
