/**
 * End-to-end client-half verification against the REAL Cordis engine.
 *
 * The second startup abort came from the browser half: Cordis re-executes a
 * plugin body when the fiber's injection epoch changes, and
 * `dsh-client-locale`'s `register()` throws on a duplicate namespace. A body
 * that registered on every pass therefore threw on the second pass, the fiber
 * went FAILED, and the startup audit aborted the whole web boot.
 *
 * Fake-context tests cannot prove this: they never run Cordis' fiber state
 * machine, so they never trigger a second execution. This suite mounts the real
 * bundle through real Cordis with a locale service that rejects duplicates —
 * exactly the real registry's contract.
 *
 * Requires `@deepseek-ai/cordis` to be resolvable; it skips itself otherwise.
 *
 * Run: node test/cordis-client.test.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { loadClientBundle } from './bundle-harness.js'

const require = createRequire(import.meta.url)

/**
 * Resolve the app's Cordis, or report that this environment cannot run the suite.
 * @returns {string | undefined} a file URL for the module, when resolvable.
 */
function resolveCordis() {
  try {
    return pathToFileURL(require.resolve('@deepseek-ai/cordis')).href
  } catch {
    return undefined
  }
}

const cordisUrl = resolveCordis()
if (cordisUrl === undefined) {
  console.log('cordis client boot: SKIPPED — @deepseek-ai/cordis is not resolvable from here')
  console.log('  (expose the installation\'s node_modules on the resolution path to run it)')
  process.exit(0)
}
const { Context } = await import(cordisUrl)

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

/** Fiber state codes: 0 PENDING, 2 ACTIVE, 3 FAILED. */
const FIBER_ACTIVE = 2
const FIBER_FAILED = 3

/**
 * A locale service that mirrors dsh-client-locale's contract exactly.
 *
 * @returns {object} the service plus its records.
 */
function strictLocale() {
  const namespaces = new Set()
  const records = { registrations: [], disposers: [] }
  return {
    records,
    service: {
      /**
       * Register dictionaries for one namespace.
       * @param {string} ns - namespace.
       * @param {object} dictionaries - locale to dictionary map.
       * @returns {() => void} the disposer.
       */
      register(ns, dictionaries) {
        if (namespaces.has(ns)) {
          throw new Error(`locale namespace "${ns}" already has locale "zh"`)
        }
        namespaces.add(ns)
        records.registrations.push({ ns, dictionaries })
        const dispose = () => {
          namespaces.delete(ns)
        }
        records.disposers.push(dispose)
        return dispose
      },
    },
  }
}

/**
 * A slots service recording what the plugin registers.
 * @returns {object} the service plus its records.
 */
function recordingSlots() {
  const records = { injects: [], registrations: [] }
  return {
    records,
    service: {
      /**
       * Register a contribution into a slot once its declarer exists.
       * @param {string} name - slot name.
       * @param {Function} callback - registration callback.
       * @returns {() => void} the disposer.
       */
      inject(name, callback) {
        records.injects.push(name)
        callback()
        return () => {}
      },
      /**
       * Register one entry into a slot.
       * @param {object} config - entry config.
       * @param {Function} component - the control component.
       * @returns {() => void} the disposer.
       */
      register(config, component) {
        records.registrations.push({ config, component })
        return () => {}
      },
    },
  }
}

/**
 * Wait until the fiber reaches a terminal-looking state.
 * @param {object} fiber - the Cordis fiber.
 * @param {number} [rounds] - maximum drains.
 * @returns {Promise<number>} the observed state.
 */
async function waitForState(fiber, rounds = 300) {
  for (let i = 0; i < rounds; i += 1) {
    if (fiber.state === FIBER_ACTIVE || fiber.state === FIBER_FAILED) return fiber.state
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return fiber.state
}

/**
 * Mount the real client bundle through real Cordis.
 * @param {object} options - setup options.
 * @param {boolean} [options.localeFirst] - provide locale before mounting.
 * @param {boolean} [options.slotsFirst] - provide slots before mounting.
 * @returns {Promise<object>} the mounted tree, services, and bundle.
 */
async function mountClientHalf({ localeFirst = true, slotsFirst = true } = {}) {
  const bundle = loadClientBundle()
  const root = new Context()
  const locale = strictLocale()
  const slots = recordingSlots()
  if (localeFirst) root.provide('locale', locale.service)
  if (slotsFirst) root.provide('slots', slots.service)

  const plugin = { apply: bundle.exports.apply, inject: bundle.exports.inject, name: 'client-half' }
  const fiber = root.plugin(plugin, {})
  if (!localeFirst) root.provide('locale', locale.service)
  if (!slotsFirst) root.provide('slots', slots.service)

  return { bundle, root, fiber, locale, slots }
}

console.log('cordis client boot: services available at mount')

await test('the client half reaches ACTIVE', async () => {
  const { root, fiber, locale, slots } = await mountClientHalf()
  const state = await waitForState(fiber)
  assert.notEqual(state, FIBER_FAILED, 'the client half failed to activate')
  assert.equal(state, FIBER_ACTIVE, `expected ACTIVE, got ${String(state)}`)
  assert.equal(locale.records.registrations.length, 1, 'the dictionary was not registered once')
  assert.equal(slots.records.registrations.length, 1, 'the control was not registered once')
  await root.fiber.dispose()
})

await test('the bundle declares slots and locale', () => {
  const bundle = loadClientBundle()
  assert.deepEqual([...bundle.exports.inject].sort(), ['locale', 'slots'])
})

console.log('cordis client boot: services arrive later (the failing startup order)')

await test('the client half activates once its services appear', async () => {
  // This is the ordering that matters: the fiber starts PENDING because its
  // declared services are absent, then a service arrival changes the injection
  // epoch and Cordis re-executes the body. A body that registered on every pass
  // threw here; the one-shot guards must make the repeat a no-op.
  //
  // The services must be mounted on a context that is created AFTER the plugin
  // fiber exists, so their arrival is what changes the epoch.
  const bundle = loadClientBundle()
  const root = new Context()
  const locale = strictLocale()
  const slots = recordingSlots()

  const plugin = { apply: bundle.exports.apply, inject: bundle.exports.inject, name: 'client-half' }
  const fiber = root.plugin(plugin, {})
  await Promise.resolve()
  await Promise.resolve()
  assert.notEqual(fiber.state, FIBER_FAILED, 'the client half failed while waiting')

  // A later provider context publishes the services, so the fiber's epoch moves.
  const provider = root.extend({})
  provider.provide('locale', locale.service)
  provider.provide('slots', slots.service)

  const state = await waitForState(fiber)
  assert.notEqual(state, FIBER_FAILED, 'the client half failed once its services arrived')
  assert.equal(state, FIBER_ACTIVE, `expected ACTIVE, got ${String(state)}`)
  assert.equal(
    locale.records.registrations.length,
    1,
    `the dictionary was registered ${String(locale.records.registrations.length)} times`,
  )
  assert.equal(slots.records.registrations.length, 1, 'the control was registered more than once')
  await root.fiber.dispose()
})

await test('a repeated body execution never throws a duplicate-namespace error', async () => {
  // Force the situation directly: run the body twice against the same strict
  // registry. Without the guard this is the exact reproduction of the abort.
  const bundle = loadClientBundle()
  const locale = strictLocale()
  const slots = recordingSlots()
  const ctx = {
    locale: locale.service,
    slots: slots.service,
    effect: (body) => {
      body()
      return () => {}
    },
  }
  bundle.exports.apply(ctx)
  let threw
  try {
    bundle.exports.apply(ctx)
  } catch (error) {
    threw = error
  }
  assert.equal(threw, undefined, `the repeat pass threw: ${String(threw)}`)
  assert.equal(locale.records.registrations.length, 1)
  assert.equal(slots.records.registrations.length, 1)
})

await test('teardown then re-mount works, so a rebuild can re-register', async () => {
  const first = await mountClientHalf()
  await waitForState(first.fiber)
  assert.equal(first.locale.records.registrations.length, 1)
  await first.root.fiber.dispose()
  await new Promise((resolve) => setTimeout(resolve, 0))

  // A second page load uses a fresh module instance, so a fresh bundle.
  const second = await mountClientHalf()
  const state = await waitForState(second.fiber)
  assert.notEqual(state, FIBER_FAILED, 'the re-mount failed')
  assert.equal(second.locale.records.registrations.length, 1)
  await second.root.fiber.dispose()
})

console.log(`\ncordis client boot: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
