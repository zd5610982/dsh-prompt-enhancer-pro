/**
 * Load the browser-half bundle the way the harness module loader does.
 *
 * The bundle is a lazy-CJS script that immediately calls
 * `window.__ModuleLoader__.load({ id, factory })`. This helper installs that
 * facade, evaluates the script, invokes the factory with a `require` backed by
 * the React stub, and hands back the registered module id plus its exports.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import * as reactStub from './react-stub.js'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Evaluate the plugin's client bundle in a sandbox.
 * @param {{ fetchImpl?: Function, console?: object, window?: object }} [options] - sandbox overrides.
 * @returns {{ id: string, exports: object, loaded: object[], fetchCalls: object[] }} registration and exports.
 */
export function loadClientBundle(options = {}) {
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  const loaded = []
  const fetchCalls = []
  // A test may supply a window facade (with addEventListener) to exercise the
  // diagnostics relays, which are otherwise dead code under a bare object.
  const window = options.window ?? {}

  window.__ModuleLoader__ = {
    /**
     * Record one bundle registration.
     * @param {{ id: string, factory: Function }} entry - registration.
     * @returns {void}
     */
    load(entry) {
      loaded.push(entry)
    },
  }

  /**
   * Resolve a bundle request against the allowed platform surface.
   * @param {string} specifier - requested module.
   * @returns {unknown} the module namespace.
   */
  const require = (specifier) => {
    if (specifier === 'react') return reactStub
    if (specifier === 'react/jsx-runtime') return reactStub
    throw new Error(`client bundle requested a non-platform module: ${specifier}`)
  }

  const sandbox = {
    window,
    fetch:
      options.fetchImpl ??
      (async (url, init) => {
        fetchCalls.push({ url, init })
        return { ok: true, json: async () => ({ ok: false, error: 'stub' }) }
      }),
    // A test can pass a pristine console to observe hook installation without
    // depending on whether an earlier test already patched the shared one.
    console: options.console ?? console,
    // Standard browser globals the bundle relies on. A vm context starts with
    // none of them, so the harness seeds the ones a browser always provides.
    AbortController,
    URL,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  }
  sandbox.globalThis = sandbox
  sandbox.window.fetch = sandbox.fetch

  vm.createContext(sandbox)
  new vm.Script(source, { filename: 'client.js' }).runInContext(sandbox)

  if (loaded.length !== 1) {
    throw new Error(`client bundle registered ${loaded.length} modules; expected exactly 1`)
  }
  const entry = loaded[0]
  const exports = entry.factory(require)
  return { id: entry.id, exports, loaded, fetchCalls }
}
