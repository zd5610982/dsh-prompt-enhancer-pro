/**
 * Tests for the browser-half bundle: module registration contract, slot wiring,
 * and observable control behavior through the React stub.
 *
 * Run: node test/client.test.mjs
 */
import assert from 'node:assert/strict'

import * as reactStub from './react-stub.js'
import { loadClientBundle } from './bundle-harness.js'

let passed = 0
let failed = 0

/**
 * Run one assertion group, awaiting an async body before reporting.
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
 * Flatten a virtual tree into element nodes.
 * @param {unknown} node - virtual node or primitive.
 * @param {object[]} [out] - accumulator.
 * @returns {object[]} every element in the tree.
 */
function elements(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out)
    return out
  }
  if (typeof node === 'object') {
    out.push(node)
    for (const child of node.children) elements(child, out)
  }
  return out
}

/**
 * Collect visible text from a virtual tree.
 * @param {unknown} node - virtual node or primitive.
 * @returns {string} concatenated text.
 */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return node.children.map(textOf).join('')
}

/**
 * Find the first button whose text matches a predicate.
 * @param {unknown} tree - virtual tree.
 * @param {(text: string) => boolean} predicate - match test.
 * @returns {object | undefined} the matching button.
 */
function findButton(tree, predicate) {
  return elements(tree).find((node) => node.type === 'button' && predicate(textOf(node)))
}

/**
 * Render the control once with the given props.
 * @param {Function} component - PromptEnhancer.
 * @param {object} props - slot props.
 * @returns {unknown} the rendered tree.
 */
function render(component, props) {
  reactStub.beginRender()
  const tree = component(props)
  reactStub.endRender()
  return tree
}

/**
 * Wait until a predicate holds or the attempt budget runs out.
 * @param {() => boolean} predicate - condition to satisfy.
 * @param {number} [attempts] - maximum microtask/timer drains.
 * @returns {Promise<boolean>} whether the predicate became true.
 */
async function waitFor(predicate, attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return predicate()
}

/**
 * Drain pending microtasks and timers so a settled fetch chain lands.
 * @param {number} [rounds] - how many macrotask rounds to yield.
 * @returns {Promise<void>} fulfillment after the rounds.
 */
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Re-render until the control leaves its loading state.
 * @param {Function} component - PromptEnhancer from the bundle under test.
 * @param {object} props - slot props.
 * @returns {Promise<unknown>} the first settled render.
 */
async function waitForSettled(component, props) {
  let tree = render(component, props)
  for (let i = 0; i < 50 && textOf(tree).includes('取消增强'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    tree = render(component, props)
  }
  return tree
}

/**
 * Build a fetch stub answering /status and /enhance deterministically.
 * @param {(body: object) => object} enhanceReply - response body for /enhance.
 * @returns {Function} the fetch implementation.
 */
function stubFetch(enhanceReply) {
  return async (url, init) => {
    if (String(url).endsWith('/status')) {
      return {
        ok: true,
        json: async () => ({ ok: true, styles: ['default', 'structured', 'concise', 'expand'], defaultStyle: 'default' }),
      }
    }
    const body = init !== undefined && typeof init.body === 'string' ? JSON.parse(init.body) : {}
    return { ok: true, json: async () => enhanceReply(body) }
  }
}

console.log('bundle: registration contract')

const bundle = loadClientBundle()

await test('the bundle id matches the package name', () => {
  assert.equal(bundle.id, 'dsh-prompt-enhancer-pro')
})

await test('the bundle registers exactly one module', () => {
  assert.equal(bundle.loaded.length, 1)
})

await test('exports an apply function', () => {
  assert.equal(typeof bundle.exports.apply, 'function')
})

await test('declares its client dependencies so Cordis owns the wait', () => {
  // The bundle runs in a vm realm, so its Array prototype differs from ours;
  // compare by shape/content rather than by identity.
  assert.ok(Array.isArray(bundle.exports.inject))
  const declared = [...bundle.exports.inject]
  assert.deepEqual(declared.sort(), ['locale', 'slots'])
})

console.log('bundle: slot wiring')

/**
 * Load a fresh bundle instance.
 *
 * The registration guards are module-level state inside the bundle, so a test
 * that exercises first-time registration must start from a fresh instance.
 * @param {object} [options] - harness overrides, e.g. a pristine `console`.
 * @returns {object} a freshly loaded bundle.
 */
function freshBundle(options) {
  return loadClientBundle(options)
}

/**
 * Build a fake client context recording slot registrations.
 *
 * `locale.register` mirrors the real dsh-client-locale contract: it REJECTS a
 * second registration for the same namespace. That behavior is what turned a
 * repeat activation pass into a failed entry, so the harness must reproduce it.
 * @param {boolean} [strictLocale] - whether a duplicate namespace throws.
 * @returns {object} the fake context and its records.
 */
function fakeContext(strictLocale = true) {
  const records = { locales: [], injects: [], registrations: [], effects: [] }
  const registeredNamespaces = new Set()
  const ctx = {
    locale: {
      register: (ns, dictionaries) => {
        if (registeredNamespaces.has(ns)) {
          if (strictLocale) throw new Error(`locale namespace "${ns}" already has locale "zh"`)
          return () => {}
        }
        registeredNamespaces.add(ns)
        records.locales.push({ ns, dictionaries })
        return () => {
          registeredNamespaces.delete(ns)
        }
      },
    },
    effect: (body) => {
      const cleanup = body()
      records.effects.push(cleanup)
      return () => {}
    },
    slots: {
      inject: (name, callback) => {
        records.injects.push(name)
        callback()
        return () => {}
      },
      register: (config, component) => {
        records.registrations.push({ config, component })
        return () => {}
      },
    },
  }
  return { ctx, records }
}

await test('apply registers into conversation.input.right', () => {
  const fresh = freshBundle()
  const { ctx, records } = fakeContext()
  fresh.exports.apply(ctx)
  assert.equal(records.injects.length, 1)
  assert.equal(records.injects[0], 'conversation.input.right')
  assert.equal(records.registrations.length, 1)
  assert.equal(records.registrations[0].config.name, 'conversation.input.right')
  assert.equal(records.registrations[0].config.id, 'prompt-enhancer-pro')
  // The slot gets the wrapper, which exists so a render throw can be reported
  // instead of vanishing into the runtime's silent `data-slot-error` boundary.
  assert.equal(records.registrations[0].component, fresh.exports.PromptEnhancerForSlot)
})

await test('the console hook installs once across module instances', () => {
  // Regression: every fresh bundle wrapped the previous bundle's wrapper, so a
  // single log line recursed until the process ran out of memory. A pristine
  // console is injected because the marker is process-wide by design (a real
  // page has one console), so earlier tests would otherwise leave it patched.
  const pristine = { error: () => {}, log: () => {}, warn: () => {} }
  const untouched = pristine.error

  const first = freshBundle({ console: pristine })
  const second = freshBundle({ console: pristine })

  first.exports.apply(fakeContext().ctx)
  const installed = pristine.error
  assert.notEqual(installed, untouched, 'the first instance did not install a hook')

  // The second instance must recognise the existing hook and leave it alone,
  // whether it comes through apply() or a direct install.
  second.exports.installRenderDiagnostics()
  assert.equal(pristine.error, installed, 'a direct install stacked another hook')

  // Reporting a failure logs through that same hook; it must not come back
  // through the hook again (that is the recursion).
  let depth = 0
  let maxDepth = 0
  const hook = pristine.error
  pristine.error = (...args) => {
    depth += 1
    maxDepth = Math.max(maxDepth, depth)
    try {
      if (depth > 10) throw new Error('console hook recursed')
      return hook(...args)
    } finally {
      depth -= 1
    }
  }
  second.exports.apply({
    locale: {
      register: () => {
        throw new Error('locale namespace "promptEnhancer" already has locale "zh"')
      },
    },
    effect: (body) => {
      body()
      return () => {}
    },
    slots: undefined,
  })
  assert.ok(maxDepth <= 2, `nested logging depth reached ${String(maxDepth)}`)
})

await test('apply registers both locales', () => {
  const fresh = freshBundle()
  const { ctx, records } = fakeContext()
  fresh.exports.apply(ctx)
  assert.equal(records.locales.length, 1)
  assert.deepEqual(Object.keys(records.locales[0].dictionaries).sort(), ['en', 'zh'])
})

console.log('bundle: diagnostic attribution and teardown')

await test('an error naming another bundle is forwarded as observed, not blamed', () => {
  // Regression: the relay wrote every page error to the host as
  // `CLIENT FAILURE (phase=failed ...)`, so another plugin's crash was logged as
  // this plugin's activation failure.
  const sent = []
  const listeners = []
  const fresh = freshBundle({
    console: { error: () => {}, log: () => {}, warn: () => {} },
    window: { addEventListener: (type, listener) => listeners.push({ type, listener }) },
    fetchImpl: async (url, init) => {
      sent.push(String(init?.body ?? ''))
      return { ok: true, json: async () => ({}) }
    },
  })
  fresh.exports.installRenderDiagnostics()
  const relay = listeners.find((entry) => entry.type === 'error')

  relay.listener({ error: new Error('some-other-plugin exploded') })
  const observed = sent.find((body) => body.includes('some-other-plugin'))
  assert.ok(observed !== undefined, 'the other bundle\u2019s error was not forwarded at all')
  assert.ok(
    observed.includes('"phase":"observed"'),
    `another bundle's error must not be blamed on us: ${observed}`,
  )
  assert.ok(!observed.includes('"phase":"failed"'), `blamed on this plugin: ${observed}`)

  // A failure naming THIS plugin is still attributed.
  sent.length = 0
  relay.listener({ error: new Error('in PromptEnhancerView: boom') })
  const blamed = sent.find((body) => body.includes('PromptEnhancerView'))
  assert.ok(blamed !== undefined, 'our own failure was not reported')
  assert.ok(blamed.includes('"phase":"failed"'), `our own failure was not attributed: ${blamed}`)
})

await test('a resource-load failure with no message is not reported as "undefined"', () => {
  // A failed subresource fires an error event with neither `error` nor `message`;
  // the old code forwarded the literal string "undefined".
  const sent = []
  const listeners = []
  const fresh = freshBundle({
    console: { error: () => {}, log: () => {}, warn: () => {} },
    window: { addEventListener: (type, listener) => listeners.push({ type, listener }) },
    fetchImpl: async (_url, init) => {
      sent.push(String(init?.body ?? ''))
      return { ok: true, json: async () => ({}) }
    },
  })
  fresh.exports.installRenderDiagnostics()
  const relay = listeners.find((entry) => entry.type === 'error')
  relay.listener({ type: 'error', target: { src: 'x' } })
  assert.deepEqual(sent, [], `an empty error event was reported: ${JSON.stringify(sent)}`)
})

await test('the disposer removes the window listeners and restores console.error', () => {
  // Regression: the listeners and the console hook were never undone, so every
  // bundle reload on the same page added two more listeners, each re-POSTing
  // every error to the host.
  const listeners = []
  const removed = []
  const pristine = { error: () => {}, log: () => {}, warn: () => {} }
  const fresh = freshBundle({
    console: pristine,
    window: {
      addEventListener: (type, listener) => listeners.push({ type, listener }),
      removeEventListener: (type, listener) => removed.push({ type, listener }),
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  })

  const dispose = fresh.exports.installRenderDiagnostics()
  assert.equal(typeof dispose, 'function', 'no disposer was returned')
  assert.equal(listeners.length, 2, 'the two relays were not installed')
  const hooked = pristine.error
  assert.notEqual(hooked, undefined)

  dispose()

  assert.equal(removed.length, 2, 'the listeners were not removed')
  for (const entry of listeners) {
    assert.ok(
      removed.some((r) => r.type === entry.type && r.listener === entry.listener),
      `listener for ${entry.type} was not removed by identity`,
    )
  }
  assert.notEqual(pristine.error, hooked, 'console.error was not restored')
})

await test('a second install after disposal works again', () => {
  const listeners = []
  const fresh = freshBundle({
    console: { error: () => {}, log: () => {}, warn: () => {} },
    window: {
      addEventListener: (type, listener) => listeners.push({ type, listener }),
      removeEventListener: () => {},
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  })
  const first = fresh.exports.installRenderDiagnostics()
  assert.equal(listeners.length, 2)
  first()
  const second = fresh.exports.installRenderDiagnostics()
  assert.equal(typeof second, 'function', 'the latch was not released on disposal')
  assert.equal(listeners.length, 4, 'the relays were not reinstalled')
})

await test('apply hands the diagnostics to ctx.effect so Cordis can tear them down', () => {
  const listeners = []
  const removed = []
  const pristine = { error: () => {}, log: () => {}, warn: () => {} }
  const fresh = freshBundle({
    console: pristine,
    window: {
      addEventListener: (type, listener) => listeners.push({ type, listener }),
      removeEventListener: (type, listener) => removed.push({ type, listener }),
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  })
  const { ctx, records } = fakeContext()
  fresh.exports.apply(ctx)

  // fakeContext runs the effect body and records its disposer, exactly as Cordis
  // does when it takes ownership.
  assert.equal(records.effects.length >= 1, true, 'no effect was registered')
  assert.equal(listeners.length, 2, 'the diagnostics were not installed through the effect')
  assert.notEqual(pristine.error, undefined)

  // Cordis teardown runs the recorded cleanup, which must undo the listeners.
  const diagnosticDisposer = records.effects.find((entry) => typeof entry === 'function')
  assert.ok(diagnosticDisposer !== undefined, 'the effect returned no disposer')
  diagnosticDisposer()
  assert.equal(removed.length, 2, 'Cordis teardown did not remove the listeners')
})
await test('a repeat activation pass does not throw on the locale registry', () => {
  // The regression that aborted the web boot: Cordis re-executes the body on
  // an epoch change, and `locale.register` rejects a duplicate namespace. The
  // second pass must be a no-op instead of throwing (a throw marks the entry
  // FAILED, and the startup audit then aborts the whole boot).
  const fresh = freshBundle()
  const { ctx, records } = fakeContext(true)
  fresh.exports.apply(ctx)
  let threw
  try {
    fresh.exports.apply(ctx)
  } catch (error) {
    threw = error
  }
  assert.equal(threw, undefined, `the repeat pass threw: ${String(threw)}`)
  assert.equal(records.locales.length, 1, 'the dictionary was registered twice')
  assert.equal(records.injects.length, 1, 'the control was injected twice')
  assert.equal(records.registrations.length, 1, 'the control was registered twice')
})

await test('a repeat pass against a fresh context still does not re-register', () => {
  // Same page, a different context: the module-level guard is what prevents a
  // duplicate namespace, because the locale registry is per page.
  const fresh = freshBundle()
  fresh.exports.apply(fakeContext(true).ctx)
  const second = fakeContext(true)
  let threw
  try {
    fresh.exports.apply(second.ctx)
  } catch (error) {
    threw = error
  }
  assert.equal(threw, undefined, `the second context threw: ${String(threw)}`)
  assert.equal(second.records.locales.length, 0)
  assert.equal(second.records.registrations.length, 0)
})

await test('a throwing locale registry is contained on the first pass', () => {
  // Belt and braces for the startup abort: a throw from any registration must
  // not escape. A plugin that adds a button must never be able to stop the
  // application from starting.
  const fresh = freshBundle()
  const exploding = {
    locale: {
      register: () => {
        throw new Error('locale namespace "promptEnhancer" already has locale "zh"')
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
      register: () => () => {},
    },
  }
  let threw
  try {
    fresh.exports.apply(exploding)
  } catch (error) {
    threw = error
  }
  assert.equal(threw, undefined, `the failure escaped apply(): ${String(threw)}`)
})

await test('a throwing slots registration is contained too', () => {
  const fresh = freshBundle()
  const exploding = {
    locale: undefined,
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
        throw new Error('slot registration exploded')
      },
    },
  }
  let threw
  try {
    fresh.exports.apply(exploding)
  } catch (error) {
    threw = error
  }
  assert.equal(threw, undefined, `the failure escaped apply(): ${String(threw)}`)
})

await test('a context without an effect method still registers everything', () => {
  // Regression: `ctx.effect` was called unconditionally, and on a client context
  // that lacks it that threw `ctx.effect is not a function` INSIDE this plugin's
  // own body. Two consequences: the dictionary registration had been failing
  // silently, and the control could never register, so the button disappeared.
  // A client context is not a Cordis host context; the method must be probed.
  const fresh = freshBundle()
  const records = { locales: 0, registrations: 0 }
  const ctx = {
    // Deliberately NO `effect`.
    locale: {
      register: () => {
        records.locales += 1
        return () => {}
      },
    },
    slots: {
      inject: (_name, callback) => {
        callback()
        return () => {}
      },
      register: () => {
        records.registrations += 1
        return () => {}
      },
    },
  }

  let threw
  try {
    fresh.exports.apply(ctx)
  } catch (error) {
    threw = error
  }
  assert.equal(threw, undefined, `apply threw without effect: ${String(threw)}`)
  assert.equal(records.locales, 1, 'the dictionary was not registered')
  assert.equal(records.registrations, 1, 'the control was not registered')
})

await test('a context whose effect throws is contained', () => {
  // `effect` existing is not the same as `effect` working. A throw from it must
  // not prevent the control from registering.
  const fresh = freshBundle()
  const records = { registrations: 0 }
  const ctx = {
    effect: () => {
      throw new Error('effect is not supported here')
    },
    locale: {
      register: () => () => {},
    },
    slots: {
      inject: (_name, callback) => {
        callback()
        return () => {}
      },
      register: () => {
        records.registrations += 1
        return () => {}
      },
    },
  }
  let threw
  try {
    fresh.exports.apply(ctx)
  } catch (error) {
    threw = error
  }
  assert.equal(threw, undefined, `apply threw: ${String(threw)}`)
  assert.equal(records.registrations, 1, 'a broken effect blocked the registration')
})

await test('an undeclared service is never read from the context', () => {
  // Regression: the heartbeat probed a fixed list including `webServer` and
  // `llm`, but the client half declares only `slots` and `locale`. Reading an
  // undeclared service on a Cordis context THROWS
  // `cannot get property "webServer" without inject`, and because that read ran
  // inside apply() the throw broke activation.
  //
  // The fake context stands in for Cordis: any property outside the declared set
  // throws on access, so a stray read fails this test.
  const fresh = freshBundle()
  const declared = new Set(fresh.exports.inject)
  const records = { registrations: 0 }
  const target = {
    locale: { register: () => () => {} },
    slots: {
      inject: (_name, callback) => {
        callback()
        return () => {}
      },
      register: () => {
        records.registrations += 1
        return () => {}
      },
    },
  }
  const ctx = new Proxy(target, {
    has: (_t, key) => typeof key === 'string' && (declared.has(key) || key === 'effect'),
    get: (t, key) => {
      if (typeof key === 'string' && !declared.has(key) && key !== 'effect' && !(key in t)) {
        throw new Error(`cannot get property "${key}" without inject`)
      }
      return Reflect.get(t, key)
    },
  })

  let threw
  try {
    fresh.exports.apply(ctx)
  } catch (error) {
    threw = error
  }
  assert.equal(threw, undefined, `apply read an undeclared service: ${String(threw)}`)
  assert.equal(records.registrations, 1, 'the control was not registered')
})

await test('the heartbeat names only declared services', () => {
  // A service that exists but is not declared must never appear in the report.
  const sent = []
  const fresh = freshBundle({
    fetchImpl: async (_url, init) => {
      sent.push(String(init?.body ?? ''))
      return { ok: true, json: async () => ({}) }
    },
  })
  fresh.exports.apply({
    locale: { register: () => () => {} },
    // Present, but undeclared: must be ignored rather than read.
    webServer: { register: () => () => {} },
    llm: { stream: () => {} },
    slots: {
      inject: (_name, callback) => {
        callback()
        return () => {}
      },
      register: () => () => {},
    },
  })
  const heartbeat = sent.find((body) => body.includes('applied'))
  assert.ok(heartbeat !== undefined, 'no heartbeat was sent')
  assert.ok(!heartbeat.includes('webServer'), `an undeclared service was reported: ${heartbeat}`)
  assert.ok(!heartbeat.includes('llm'), `an undeclared service was reported: ${heartbeat}`)
  assert.ok(heartbeat.includes('slots'), 'the declared services were not reported')
})

await test('the heartbeat distinguishes a pending control from a refused one', () => {
  // Regression: `slots.inject` runs its callback only once the slot's declarer
  // appears. On a cold start the page loads before the chat surface, so the
  // boolean report said `control=no` for a perfectly healthy page — and reading
  // that as "the button is missing" sent us chasing a non-existent bug.
  const report = (injectCallbackNow) => {
    const sent = []
    const fresh = freshBundle({
      fetchImpl: async (_url, init) => {
        sent.push(String(init?.body ?? ''))
        return { ok: true, json: async () => ({}) }
      },
    })
    fresh.exports.apply({
      locale: { register: () => () => {} },
      slots: {
        // The declarer has NOT appeared yet when the flag is false.
        inject: (_name, callback) => {
          if (injectCallbackNow) callback()
          return () => {}
        },
        register: () => () => {},
      },
    })
    return sent.find((body) => body.includes('applied')) ?? ''
  }

  const pending = report(false)
  assert.ok(pending.includes('"control":"pending"'), `expected pending, got: ${pending}`)

  const live = report(true)
  assert.ok(live.includes('"control":"yes"'), `expected yes, got: ${live}`)
})

await test('discharging the control effect releases the guard, so a later pass re-registers', () => {
  // Regression: the guard held a release function that NOTHING ever called, so it
  // was a one-way latch. Cordis unloads an entry before re-running its body, so
  // after the first unload the control could never be registered again — the
  // button disappears for the rest of the page's life, with no log line.
  const fresh = freshBundle()
  const first = fakeContext()
  fresh.exports.apply(first.ctx)
  assert.equal(first.records.registrations.length, 1, 'the first pass did not register')

  // Cordis teardown runs every cleanup the entry's effects returned.
  const cleanup = first.records.effects.findLast((entry) => typeof entry === 'function')
  assert.ok(cleanup !== undefined, 'no effect cleanup was recorded')

  // A second pass while the effect is still live must stay a no-op.
  fresh.exports.apply(fakeContext().ctx)
  const between = fakeContext()
  fresh.exports.apply(between.ctx)
  assert.equal(between.records.registrations.length, 0, 'the live guard did not hold')

  cleanup()

  // After teardown the guard must be free again.
  const after = fakeContext()
  fresh.exports.apply(after.ctx)
  assert.equal(
    after.records.registrations.length,
    1,
    'the guard stayed latched after teardown, so the control could never come back',
  )
})

await test('a throwing slots.register does not latch the control guard', () => {
  // If registration throws, the guard must be released so a later pass can try
  // again; latching on a failure makes the control permanently absent.
  const fresh = freshBundle()
  const records = { registrations: 0 }
  const ctx = {
    locale: {
      register: () => () => {},
    },
    effect: (body) => {
      const cleanup = body()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
    slots: {
      inject: (_name, callback) => {
        callback()
        return () => {}
      },
      register: () => {
        records.registrations += 1
        throw new Error('slot registration exploded')
      },
    },
  }
  fresh.exports.apply(ctx)
  assert.equal(records.registrations, 1)

  // The failed attempt must not consume the guard.
  fresh.exports.apply(ctx)
  assert.equal(records.registrations, 2, 'the guard latched on a failed registration')
})

await test('the once-guard keeps a repeat pass away from the registry entirely', () => {
  // With the guard in place the second pass never reaches `locale.register`, so
  // even a registry that would throw on a duplicate is never asked.
  const fresh = freshBundle()
  const first = fakeContext(true)
  fresh.exports.apply(first.ctx)

  let registerCalls = 0
  const counting = {
    locale: {
      register: () => {
        registerCalls += 1
        throw new Error('locale namespace "promptEnhancer" already has locale "zh"')
      },
    },
    effect: (body) => {
      body()
      return () => {}
    },
    slots: { inject: () => {}, register: () => () => {} },
  }
  fresh.exports.apply(counting)
  assert.equal(registerCalls, 0, 'the repeat pass called into the registry')
})

await test('apply tolerates a context without slots', () => {
  const fresh = freshBundle()
  let threw = false
  try {
    fresh.exports.apply({ locale: undefined, effect: () => {}, slots: undefined })
  } catch {
    threw = true
  }
  assert.equal(threw, false)
})

await test('apply tolerates a context without locale', () => {
  const fresh = freshBundle()
  const { ctx, records } = fakeContext()
  ctx.locale = undefined
  fresh.exports.apply(ctx)
  assert.equal(records.registrations.length, 1)
})

console.log('bundle: dictionaries')

await test('every dictionary key the component asks for exists in both locales', () => {
  const { zh, en } = bundle.exports.dictionaries
  for (const key of Object.keys(zh)) {
    assert.ok(key in en, `en is missing ${key}`)
  }
  for (const style of bundle.exports.STYLE_ORDER) {
    assert.ok(`style.${style}` in zh, `zh is missing style.${style}`)
    assert.ok(`style.${style}` in en, `en is missing style.${style}`)
  }
})

console.log('bundle: diagnostics do not become a noise source')

await test('benign browser notices are recognised as not ours', () => {
  // Regression: the window relay forwarded EVERY page error, so the benign
  // Chromium notice `ResizeObserver loop completed with undelivered
  // notifications` was logged as this plugin's activation failure — forty lines
  // in eight milliseconds, each a synchronous disk write.
  const fresh = freshBundle()
  assert.equal(
    fresh.exports.isBenignBrowserNotice('ResizeObserver loop completed with undelivered notifications.'),
    true,
  )
  assert.equal(fresh.exports.isBenignBrowserNotice('Script error.'), true)
  // A real error must still be reportable.
  assert.equal(fresh.exports.isBenignBrowserNotice('TypeError: l is not a function'), false)
  assert.equal(fresh.exports.isBenignBrowserNotice('slot entry crashed'), false)
})

await test('a benign notice reaching the window relay is dropped, not forwarded', () => {
  // The harness fetch stub is the observation point: every report reaches the
  // host through it, so counting stub calls counts real reports.
  const pristine = { error: () => {}, log: () => {}, warn: () => {} }
  const listeners = []
  const fakeWindow = {
    addEventListener: (type, listener) => listeners.push({ type, listener }),
  }
  const calls = []
  const fresh = freshBundle({
    console: pristine,
    window: fakeWindow,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init?.body })
      return { ok: true, json: async () => ({}) }
    },
  })
  fresh.exports.installRenderDiagnostics()

  const errorRelay = listeners.find((entry) => entry.type === 'error')
  assert.ok(errorRelay !== undefined, 'no window error relay was installed')

  errorRelay.listener({ message: 'ResizeObserver loop completed with undelivered notifications.' })
  assert.equal(calls.length, 0, 'the benign notice was reported as a failure')

  // A genuine error still gets through.
  errorRelay.listener({ error: new TypeError('real problem') })
  assert.equal(calls.length, 1, 'a genuine error was dropped')
})

await test('a repeated identical failure is counted, not logged every frame', () => {
  // A layout-driven error repeats every frame. Fifty repeats must not become
  // fifty log lines, each a synchronous disk write.
  const pristine = { error: () => {}, log: () => {}, warn: () => {} }
  const calls = []
  const fresh = freshBundle({
    console: pristine,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init?.body })
      return { ok: true, json: async () => ({}) }
    },
  })
  const error = new Error('layout churn')
  for (let i = 0; i < 50; i += 1) fresh.exports.reportClientFailure(error)
  // The first report and the 50th milestone report; the rest are suppressed.
  assert.ok(calls.length <= 2, `the same failure was reported ${String(calls.length)} times`)
})

await test('our own reporting line is not re-reported by the console hook', () => {
  // Regression: the console hook re-reported its own output, so every entry
  // appeared twice, the second time wrapped in the first's prefix.
  const pristine = { error: () => {}, log: () => {}, warn: () => {} }
  const calls = []
  const fresh = freshBundle({
    console: pristine,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init?.body })
      return { ok: true, json: async () => ({}) }
    },
  })
  fresh.exports.installRenderDiagnostics()
  const hooked = pristine.error

  // Drive our own reporting line through the hooked console.
  hooked('dsh-prompt-enhancer: client failure: boom', new Error('boom'))
  assert.equal(calls.length, 0, 'our own reporting line was re-reported')

  // But a React boundary line naming the component IS ours.
  hooked('The above error occurred in the <PromptEnhancerForSlot> component:')
  assert.equal(calls.length, 1, 'the real component error was not collected')
})

console.log('bundle: control rendering')

// The registered component resolves the input state and then renders the view.
// Visual-state tests drive the view directly so they do not depend on React's
// hook dispatch (which this stub does not model).
const Component = bundle.exports.PromptEnhancerView

/**
 * Build a selector hook the way the app does.
 *
 * The real `useInput` is a `useSyncExternalStoreWithSelector` derivative that
 * CALLS the selector it is handed. A convenience stub that ignored the argument
 * would hide the exact bug that broke the control in the app, so this one
 * throws when the selector is missing.
 * @param {object} state - the input state to read.
 * @returns {Function} the selector hook.
 */
function selectorHook(state) {
  return reactStub.makeSelectorHook(() => state)
}

/**
 * Build slot props for one view render.
 *
 * `input` is passed resolved, exactly as the registered component does after it
 * has read the store.
 * @param {object} overrides - prop overrides.
 * @returns {object} props.
 */
function propsFor(overrides = {}) {
  return {
    input: { draft: '写个爬虫脚本' },
    inputActions: { setDraft: () => {}, captureInsertion: () => ({}), insertText: () => true },
    t: (key) => bundle.exports.dictionaries.zh[key] ?? key,
    ...overrides,
  }
}

await test('the registered component always calls its hook, with a selector', () => {
  // Regression A: `useInput()` without a selector threw `TypeError: l is not a
  // function` from inside React; the slot boundary turned that into an invisible
  // `data-slot-error` div.
  reactStub.reset()
  const state = { draft: '写个爬虫脚本' }
  let seenSelector
  const observing = (selector) => {
    seenSelector = selector
    return selector(state)
  }
  const element = bundle.exports.PromptEnhancer({ ...propsFor(), useInput: observing, input: undefined })
  assert.equal(element.type, bundle.exports.PromptEnhancerView)
  assert.equal(typeof seenSelector, 'function', 'useInput was called without a selector')
  assert.equal(seenSelector(state), state, 'the selector is not the identity selector')
  assert.equal(element.props.input, state, 'the resolved input was not passed to the view')
})

await test('the hook runs even when no useInput is supplied, so the count cannot change', () => {
  // Regression B: the hook used to sit behind `if (typeof useInput !== 'function')
  // return undefined`, so the hook count changed between renders. React then
  // reported `Minified React error #311` ("Rendered fewer/more hooks than
  // expected") from an unrelated hook, which pointed nowhere near the cause.
  // The hook must be called unconditionally; a null snapshot is the fallback.
  const calls = []
  const counting = () => {
    calls.push('called')
    return null
  }
  const withHook = bundle.exports.PromptEnhancer({ ...propsFor(), useInput: counting, input: undefined })
  const withoutHook = bundle.exports.PromptEnhancer({ ...propsFor(), useInput: undefined, input: undefined })
  assert.equal(calls.length, 1, 'the hook was not called when useInput was present')
  assert.equal(withHook.type, bundle.exports.PromptEnhancerView)
  assert.equal(withoutHook.type, bundle.exports.PromptEnhancerView)
  // The absent case must not throw and must render a view with no input.
  assert.equal(withoutHook.props.input, undefined)
})

await test('useComposerInput calls the hook exactly once and never conditionally', () => {
  const calls = []
  const hook = (selector) => {
    calls.push(selector)
    return selector({ draft: 'x' })
  }
  const resolved = bundle.exports.useComposerInput(hook)
  assert.equal(calls.length, 1)
  assert.equal(resolved.draft, 'x')
  assert.equal(bundle.exports.useComposerInput(undefined), null)
})

await test('an absent useInput still consumes a hook, so the count cannot vary', () => {
  // Regression guard for the residual hole in the first fix: `useInput === undefined`
  // must not skip the hook. React requires a CONSTANT number of hook calls per
  // component, so the absent case has to call useSyncExternalStore with a static
  // store rather than return early.
  const counts = reactStub.countSyncExternalStoreCalls()
  const resolved = bundle.exports.useComposerInput(undefined)
  assert.equal(resolved, null, 'the static store must read as "no input"')
  assert.equal(
    reactStub.countSyncExternalStoreCalls() - counts,
    1,
    'the absent case skipped the hook instead of using the static store',
  )
})

await test('the static fallback store keeps a stable identity across renders', () => {
  // A fresh closure per render is seen as a changed snapshot by
  // useSyncExternalStore and re-renders forever, so the fallback pair must be
  // module-level constants.
  const fallback = bundle.exports.NO_INPUT_SNAPSHOT
  assert.equal(typeof fallback, 'function')
  assert.equal(fallback(), null)
  assert.equal(bundle.exports.NO_INPUT_SNAPSHOT, fallback, 'the fallback identity changed')
  assert.equal(bundle.exports.useComposerInput(undefined), null)
})

await test('a throwing selector hook degrades to a visible disabled control', () => {
  // If reading the store ever fails, the component must degrade to a visible
  // disabled control instead of vanishing. A hook throw is no longer caught
  // inside the hook call (that corrupts React's hook state and produced
  // `Minified React error #311`), so the slot boundary handles it — this test
  // covers the view's own degradation path.
  reactStub.reset()
  const tree = render(Component, propsFor({ input: undefined }))
  assert.notEqual(tree, null)
  const button = elements(tree).find((node) => node.type === 'button')
  assert.ok(button !== undefined)
  assert.equal(button.props.disabled, true)
})

await test('idle state shows the enhance affordance', () => {
  reactStub.reset()
  const tree = render(Component, propsFor())
  const button = findButton(tree, (text) => text.includes('增强提示词'))
  assert.ok(button !== undefined, 'enhance button missing')
  assert.equal(button.props.disabled, false)
})

await test('an empty draft disables the control', () => {
  reactStub.reset()
  const tree = render(Component, propsFor({ input: { draft: '   ' } }))
  const button = elements(tree).find((node) => node.type === 'button')
  assert.ok(button !== undefined)
  assert.equal(button.props.disabled, true)
})

await test('a missing inputActions renders a disabled, self-explaining control', () => {
  // A silent null would be indistinguishable from "the plugin never loaded",
  // which hides exactly the wiring problem this control has to make visible.
  reactStub.reset()
  const tree = render(Component, propsFor({ inputActions: undefined }))
  assert.notEqual(tree, null, 'the control disappeared instead of explaining itself')
  const button = elements(tree).find((node) => node.type === 'button')
  assert.ok(button !== undefined)
  assert.equal(button.props.disabled, true)
  assert.ok(textOf(tree).includes('inputActions'), `no reason rendered: ${JSON.stringify(textOf(tree))}`)
})

await test('an absent useInput hook still renders a disabled control', () => {
  reactStub.reset()
  const tree = render(Component, propsFor({ input: undefined }))
  const button = elements(tree).find((node) => node.type === 'button')
  assert.ok(button !== undefined)
  assert.equal(button.props.disabled, true)
})

await test('the control renders an svg glyph without an icon package', () => {
  reactStub.reset()
  const tree = render(Component, propsFor())
  const svg = elements(tree).find((node) => node.type === 'svg')
  assert.ok(svg !== undefined)
})

await test('an empty draft and a click reports the empty-draft hint', () => {
  reactStub.reset()
  const tree = render(Component, propsFor({ input: { draft: '' } }))
  const button = elements(tree).find((node) => node.type === 'button')
  button.props.onClick()
  const after = render(Component, propsFor({ input: { draft: '' } }))
  assert.ok(textOf(after).includes('先输入草稿再增强'), `hint missing in ${JSON.stringify(textOf(after))}`)
})

await test('a right click opens the style menu', () => {
  reactStub.reset()
  const tree = render(Component, propsFor())
  const button = findButton(tree, (text) => text.includes('增强提示词'))
  button.props.onContextMenu({ preventDefault() {} })
  const after = render(Component, propsFor())
  const text = textOf(after)
  for (const label of ['默认改写', '结构化', '精简', '扩充']) {
    assert.ok(text.includes(label), `style menu is missing ${label}`)
  }
})

await test('a click enters the loading state', async () => {
  reactStub.reset()
  // A fetch that never settles keeps the request in flight.
  const pending = loadClientBundle({ fetchImpl: () => new Promise(() => {}) })
  const tree = render(pending.exports.PromptEnhancerView, propsFor())
  findButton(tree, (text) => text.includes('增强提示词')).props.onClick()
  const after = render(pending.exports.PromptEnhancerView, propsFor())
  assert.ok(textOf(after).includes('取消增强'), `cancel label missing in ${JSON.stringify(textOf(after))}`)
})

await test('clicking while loading cancels instead of re-requesting', async () => {
  reactStub.reset()
  const pending = loadClientBundle({ fetchImpl: () => new Promise(() => {}) })
  const tree = render(pending.exports.PromptEnhancerView, propsFor())
  findButton(tree, (text) => text.includes('增强提示词')).props.onClick()
  const loading = render(pending.exports.PromptEnhancerView, propsFor())
  const cancelButton = findButton(loading, (text) => text.includes('取消增强'))
  assert.ok(cancelButton !== undefined)
  cancelButton.props.onClick()
  const after = render(pending.exports.PromptEnhancerView, propsFor())
  assert.ok(textOf(after).includes('增强提示词'), 'control did not return to idle')
})

await test('a successful response writes the enhanced text back', async () => {
  reactStub.reset()
  const written = []
  const enhanced = loadClientBundle({
    fetchImpl: stubFetch(() => ({ ok: true, text: '请编写一个爬虫脚本，明确目标站点与字段。', style: 'default' })),
  })
  const actions = { setDraft: (text) => written.push(text), captureInsertion: () => ({}), insertText: () => true }
  const props = propsFor({ inputActions: actions })
  const tree = render(enhanced.exports.PromptEnhancerView, props)
  findButton(tree, (text) => text.includes('增强提示词')).props.onClick()
  const ok = await waitFor(() => written.length > 0)
  assert.ok(ok, 'the enhanced text was never written back')
  assert.deepEqual(written, ['请编写一个爬虫脚本，明确目标站点与字段。'])
})

await test('the request carries the draft and the selected style', async () => {
  reactStub.reset()
  const requests = []
  const enhanced = loadClientBundle({
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/status')) {
        return { ok: true, json: async () => ({ ok: true, styles: ['default', 'concise'], defaultStyle: 'concise' }) }
      }
      requests.push(JSON.parse(init.body))
      return { ok: true, json: async () => ({ ok: true, text: '结果' }) }
    },
  })
  const tree = render(enhanced.exports.PromptEnhancerView, propsFor())
  assert.ok(tree !== undefined)
  // /status is read once on mount; let it land before clicking so the
  // status-provided default style is the one used.
  await settle()
  const ready = render(enhanced.exports.PromptEnhancerView, propsFor())
  findButton(ready, (text) => text.includes('增强提示词')).props.onClick()
  const ok = await waitFor(() => requests.length > 0)
  assert.ok(ok, 'no enhance request was issued')
  assert.equal(requests[0].draft, '写个爬虫脚本')
  assert.equal(requests[0].style, 'concise', 'the status-provided default style was not used')
})

await test('a failed response surfaces the error text', async () => {
  reactStub.reset()
  const failing = loadClientBundle({
    fetchImpl: stubFetch(() => ({ ok: false, error: '宿主未提供 llm 服务，无法调用模型。' })),
  })
  const tree = render(failing.exports.PromptEnhancerView, propsFor())
  findButton(tree, (text) => text.includes('增强提示词')).props.onClick()
  const after = await waitForSettled(failing.exports.PromptEnhancerView, propsFor())
  assert.ok(textOf(after).includes('宿主未提供 llm 服务'), `error missing in ${JSON.stringify(textOf(after))}`)
})

await test('a draft edited mid-flight is not overwritten', async () => {
  reactStub.reset()
  let draft = '原草稿'
  const written = []
  const guarded = loadClientBundle({ fetchImpl: stubFetch(() => ({ ok: true, text: '增强结果' })) })
  /**
   * Build props that read the CURRENT draft, the way the slot's selector hook
   * does. A frozen snapshot would make the component compare the new draft
   * against itself and hide the behaviour under test.
   * @returns {object} props.
   */
  const currentProps = () =>
    propsFor({
      input: { draft },
      inputActions: {
        setDraft: (text) => written.push(text),
        captureInsertion: () => ({}),
        insertText: () => true,
      },
    })
  const tree = render(guarded.exports.PromptEnhancerView, currentProps())
  findButton(tree, (text) => text.includes('增强提示词')).props.onClick()
  // The user keeps typing while the model runs.
  draft = '原草稿，我又加了一句'
  const after = await waitForSettled(guarded.exports.PromptEnhancerView, currentProps())
  assert.deepEqual(written, [], 'the control overwrote a draft the user had edited')
  assert.ok(textOf(after).includes('草稿已改动'), `notice missing in ${JSON.stringify(textOf(after))}`)
})

console.log('bundle: response-shape and menu-state robustness')

await test('a success payload without text never writes "undefined"', async () => {
  // `String(payload.text)` wrote the literal "undefined" and set a backup, which
  // left the user with only "恢复原文" as a way back.
  reactStub.reset()
  const written = []
  const odd = loadClientBundle({ fetchImpl: stubFetch(() => ({ ok: true })) })
  const tree = render(
    odd.exports.PromptEnhancerView,
    propsFor({
      inputActions: {
        setDraft: (text) => written.push(text),
        captureInsertion: () => ({}),
        insertText: () => true,
      },
    }),
  )
  findButton(tree, (text) => text.includes('增强提示词')).props.onClick()
  const after = await waitForSettled(odd.exports.PromptEnhancerView, propsFor())
  assert.deepEqual(written, [], `a malformed success clobbered the draft: ${JSON.stringify(written)}`)
  assert.ok(textOf(after).includes('空内容'), `no feedback shown in ${JSON.stringify(textOf(after))}`)
})

await test('an empty error string still produces feedback', async () => {
  // `??` only falls back on null/undefined, so '' produced no message at all.
  reactStub.reset()
  const silent = loadClientBundle({ fetchImpl: stubFetch(() => ({ ok: false, error: '' })) })
  const tree = render(silent.exports.PromptEnhancerView, propsFor())
  findButton(tree, (text) => text.includes('增强提示词')).props.onClick()
  const after = await waitForSettled(silent.exports.PromptEnhancerView, propsFor())
  const text = textOf(after)
  assert.ok(
    text.includes('无法连接增强服务') || text.includes('重试'),
    `an empty error left the user with nothing: ${JSON.stringify(text)}`,
  )
})

await test('the loading label names the real action', async () => {
  // The action while loading is CANCEL, but the label said "正在增强…".
  reactStub.reset()
  const pending = loadClientBundle({ fetchImpl: () => new Promise(() => {}) })
  const tree = render(pending.exports.PromptEnhancerView, propsFor())
  findButton(tree, (text) => text.includes('增强提示词')).props.onClick()
  const after = render(pending.exports.PromptEnhancerView, propsFor())
  const button = elements(after).find((node) => node.type === 'button')
  assert.ok(textOf(after).includes('取消增强'), 'the visible label does not name the action')
  assert.equal(button.props['aria-label'], '取消增强', 'the accessible name does not name the action')
})

await test('a right click during loading does not pop the menu open later', async () => {
  // `menuOpen` latched while `!busy` suppressed the render, so the menu appeared
  // by itself the moment the request settled.
  reactStub.reset()
  const pending = loadClientBundle({ fetchImpl: () => new Promise(() => {}) })
  const tree = render(pending.exports.PromptEnhancerView, propsFor())
  const button = findButton(tree, (text) => text.includes('增强提示词'))
  button.props.onClick()
  const loading = render(pending.exports.PromptEnhancerView, propsFor())
  findButton(loading, (text) => text.includes('取消增强')).props.onContextMenu({ preventDefault() {} })
  const afterSettle = await waitForSettled(pending.exports.PromptEnhancerView, propsFor())
  const text = textOf(afterSettle)
  assert.ok(
    !text.includes('默认改写'),
    `the style menu appeared by itself after the request: ${JSON.stringify(text)}`,
  )
})

console.log('bundle: the host-published draft cap is preferred over the fallback')

await test('the cap published by /status is the one enforced', async () => {
  // The browser half cannot import the engine, so it used to carry its own 4000.
  // The host now publishes the real number and the component must prefer it —
  // otherwise the two drift silently.
  reactStub.reset()
  const requests = []
  const fresh = freshBundle({
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/status')) {
        return { ok: true, json: async () => ({ ok: true, styles: ['default'], defaultStyle: 'default', maxDraftChars: 3 }) }
      }
      requests.push(init !== undefined && typeof init.body === 'string' ? JSON.parse(init.body) : {})
      return { ok: true, json: async () => ({ ok: true, text: 'ok' }) }
    },
  })
  const tree = render(
    fresh.exports.PromptEnhancerView,
    propsFor({ input: { draft: 'abcd' } }),
  )
  // Let the /status probe land before clicking.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const after = render(fresh.exports.PromptEnhancerView, propsFor({ input: { draft: 'abcd' } }))

  findButton(after !== undefined ? after : tree, (text) => text.includes('增强') || text.includes('过长'))?.props.onClick()
  assert.deepEqual(requests, [], 'a draft over the PUBLISHED cap was still sent to the host')
  assert.equal(fresh.exports.FALLBACK_MAX_DRAFT_CHARS, 4000, 'the fallback must stay a sane default')
})

console.log(`\nclient bundle: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
