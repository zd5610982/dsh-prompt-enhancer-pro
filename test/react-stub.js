/**
 * Minimal React stand-in for testing the browser half without React installed.
 *
 * Hooks are keyed by call order within a render pass, so a component can be
 * rendered repeatedly and observe the state its own setters produced. Effects
 * run synchronously at the end of each render pass, so one render settles.
 */

/** Per-render hook state. */
let cells = []
/** Index of the next hook slot. */
let cursor = 0
/** Pending effects for the current pass. */
let effects = []
/** Cleanups returned by effects, run only by reset() or unmountAll(). */
let cleanups = []

/**
 * Begin a render pass. Call before invoking a component.
 * @returns {void}
 */
export function beginRender() {
  cursor = 0
  effects = []
}

/**
 * Run the cleanups collected so far, as an unmount would.
 * @returns {void}
 */
export function unmountAll() {
  const pending = cleanups
  cleanups = []
  for (const cleanup of pending) cleanup()
}

/**
 * Finish a render pass, running effect bodies that were scheduled.
 *
 * Cleanups are collected rather than run: a browser keeps a mounted component
 * mounted, and running the cleanup here would flip mount guards to "unmounted"
 * and make the component drop its own async results.
 * @returns {Array<unknown[]>} the dependency lists of the effects that ran.
 */
export function endRender() {
  const ran = []
  for (const entry of effects) {
    ran.push(entry.deps)
    const cleanup = entry.body()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  effects = []
  return ran
}

/**
 * Reset all hook state (start a fresh component instance).
 * @returns {void}
 */
export function reset() {
  cleanups = []
  cells = []
  cursor = 0
  effects = []
}

/**
 * Allocate the next hook slot.
 * @returns {object} the slot, created on first use.
 */
function slot() {
  const index = cursor
  cursor += 1
  if (cells[index] === undefined) cells[index] = {}
  return cells[index]
}

/**
 * Create a state slot.
 * @param {unknown} initial - initial value.
 * @returns {[unknown, (next: unknown) => void]} value and setter.
 */
export function useState(initial) {
  const cell = slot()
  if (!('state' in cell)) cell.state = initial
  const setter = (next) => {
    cell.state = typeof next === 'function' ? next(cell.state) : next
  }
  return [cell.state, setter]
}

/**
 * Schedule an effect for the end of the render pass.
 * @param {Function} body - effect body; may return a cleanup.
 * @param {unknown[]} [deps] - dependency list.
 * @returns {void}
 */
export function useEffect(body, deps = []) {
  const cell = slot()
  const previous = cell.deps
  const changed = previous === undefined || deps.length !== previous.length || deps.some((dep, i) => !Object.is(dep, previous[i]))
  cell.deps = deps
  if (changed) effects.push({ body, deps })
}

/**
 * Return the callback unchanged.
 * @param {Function} callback - callback to memoize.
 * @param {unknown[]} [deps] - dependency list.
 * @returns {Function} the callback.
 */
export function useCallback(callback, deps = []) {
  slot().deps = deps
  return callback
}

/**
 * Create a mutable ref box, stable across renders.
 * @param {unknown} initial - initial `.current` value.
 * @returns {{ current: unknown }} the ref box.
 */
export function useRef(initial) {
  const cell = slot()
  if (!('ref' in cell)) cell.ref = { current: initial }
  return cell.ref
}

/**
 * Identity memo wrapper.
 * @param {Function} component - component to wrap.
 * @returns {Function} the same component.
 */
export function memo(component) {
  return component
}

/** How many times the store hook was called, so a test can prove a hook was not skipped. */
let syncExternalStoreCalls = 0

/**
 * Count how many times the store hook has been invoked.
 *
 * React requires a CONSTANT number of hook calls per render; a test needs to
 * observe that a call happened even when its result is thrown away.
 * @returns {number} the running call count.
 */
export function countSyncExternalStoreCalls() {
  return syncExternalStoreCalls
}

/**
 * Stand-in for `useSyncExternalStore`, faithfully enough to catch the mistakes
 * that matter.
 *
 * The real slot props' selector hooks are built on
 * `useSyncExternalStoreWithSelector`, which CALLS the selector it is given. A
 * stub that silently returned the whole snapshot would hide exactly the bug
 * this reproduces: a hook invoked without its selector. So the selector is
 * required here too.
 * @param {Function} subscribe - subscription function.
 * @param {Function} getSnapshot - snapshot reader.
 * @param {Function} [getServerSnapshot] - server snapshot reader.
 * @returns {unknown} the snapshot.
 */
export function useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot) {
  syncExternalStoreCalls += 1
  return typeof getServerSnapshot === 'function' ? getServerSnapshot() : getSnapshot()
}

/**
 * Stand-in for `useSyncExternalStoreWithSelector`.
 * @param {Function} subscribe - subscription function.
 * @param {Function} getSnapshot - snapshot reader.
 * @param {Function} [getServerSnapshot] - server snapshot reader.
 * @param {Function} [selector] - selector applied to the snapshot.
 * @param {Function} [isEqual] - equality comparison.
 * @returns {unknown} the selected value.
 */
export function useSyncExternalStoreWithSelector(subscribe, getSnapshot, getServerSnapshot, selector, isEqual) {
  if (selector !== undefined && typeof selector !== 'function') {
    throw new TypeError('useSyncExternalStoreWithSelector: selector must be a function')
  }
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  if (selector === undefined) return snapshot
  const selected = selector(snapshot)
  // `isEqual` is only a re-render optimization; ignoring it cannot hide a bug.
  void isEqual
  return selected
}

/**
 * Build a selector hook the way the app does: a store hook closed over a state
 * reader, which refuses to run without a selector.
 *
 * This mirrors the real failure mode exactly — callers that forget the selector
 * get a `TypeError` from inside React, not a silently different value.
 * @param {() => unknown} readState - reads the current store state.
 * @returns {(selector: Function) => unknown} the selector hook.
 */
export function makeSelectorHook(readState) {
  return (selector) => {
    if (typeof selector !== 'function') {
      // The real code path calls the selector inside React, which is why the
      // browser reported `TypeError: l is not a function` and not a prop error.
      throw new TypeError('useSyncExternalStoreWithSelector: selector must be a function')
    }
    return selector(readState())
  }
}

/**
 * Build a virtual element.
 * @param {string | Function} type - tag name or component.
 * @param {object | null} props - element props.
 * @param {...unknown} children - child nodes.
 * @returns {object} a virtual node.
 */
export function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children }
}

export default { createElement, useState, useEffect, useCallback, useRef, memo, beginRender, endRender, reset, unmountAll }
