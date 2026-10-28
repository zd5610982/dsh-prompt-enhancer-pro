/**
 * Minimal Standard Schema v1 helper and config-resolution helpers.
 *
 * Cordis validates a plugin's exported `Config` before it calls `apply()`:
 *
 *   const result = runtime.Config['~standard'].validate(config)
 *   if (result.issues) throw new ValidationError(result.issues)
 *
 * A plain object has no `~standard`, so `undefined.validate(...)` throws a
 * TypeError and the plugin silently never activates. Declaring Config through
 * this helper keeps that failure mode out of the picture without adding a
 * dependency on a schema library.
 *
 * The field map is deliberately read-vs-checker: a Cordis `volatile()` field
 * arrives as a getter function, so a function value means "getter to call" and
 * any other value means "already resolved".
 */

/** @typedef {{ message: string, path?: readonly (string | number)[] }} ValidationIssue */
/** @typedef {(value: unknown) => { value?: unknown, issues?: ValidationIssue[] }} FieldCheck */

/**
 * Build a Standard Schema v1 object from a field map.
 *
 * `validate` never reports an issue: see {@link parseConfig} for why a config
 * typo must not be able to stop the plugin from activating. Cordis therefore
 * always receives a resolved value, and every ignored field is reported through
 * the plugin's own log instead.
 * @param {Record<string, unknown | FieldCheck>} fields - per-key either a static
 *   value (used as the default) or a checker that normalizes the raw value.
 * @param {(message: string, key: string) => void} [onIssue] - called for each ignored value.
 * @returns {object} a Standard Schema v1 compatible schema object.
 */
export function standardSchema(fields, onIssue) {
  return {
    '~standard': {
      version: 1,
      vendor: 'dsh-prompt-enhancer',
      /**
       * Normalize one raw config object.
       * @param {unknown} input - the config value handed over by Cordis.
       * @returns {{ value: Record<string, unknown> }} the resolved config.
       */
      validate(input) {
        const raw = input === null || typeof input !== 'object' ? {} : input
        return parseConfig(fields, raw, onIssue)
      },
    },
  }
}

/**
 * Resolve one raw config object against a field map.
 *
 * A missing key falls back to the field's static default (or `undefined` when
 * the field is a checker). A present key is resolved through its checker; a
 * present key without a checker keeps the value, calling it first when Cordis
 * delivered a `volatile()` getter.
 *
 * An invalid value is COERCED to its default rather than reported as an issue.
 * The distinction matters: Cordis turns `issues` into a thrown `ValidationError`
 * from inside the fiber's reload, so a single typo (`defaultStyle: 'structure'`,
 * `debugLog: 'true'`, `provider: 123`) would stop this plugin from activating at
 * all — and a plugin whose whole job is to add a button must never be able to do
 * that. The cost is that a typo is no longer fatal, so every coercion is handed
 * to `onIssue` for the caller to report; the user learns the value was ignored
 * instead of being locked out.
 *
 * @param {Record<string, unknown | FieldCheck>} fields - the field map.
 * @param {Record<string, unknown>} raw - the raw config object.
 * @param {(message: string, key: string) => void} [onIssue] - called for each ignored value.
 * @returns {{ value: Record<string, unknown> }} the resolved config.
 */
export function parseConfig(fields, raw, onIssue) {
  const out = {}
  for (const key of Object.keys(fields)) {
    const spec = fields[key]
    const present = Object.prototype.hasOwnProperty.call(raw, key)

    if (!present) {
      // A checker carries its own default so an absent key resolves the same
      // way an explicit `null` does, instead of collapsing to `undefined`.
      out[key] = typeof spec === 'function' ? spec.defaultValue : spec
      continue
    }

    if (typeof spec === 'function') {
      const result = spec(raw[key])
      if (result === undefined || result === null) {
        onIssue?.('checker returned no result', key)
        out[key] = spec.defaultValue
        continue
      }
      if (Array.isArray(result.issues) && result.issues.length > 0) {
        for (const issue of result.issues) onIssue?.(String(issue.message), key)
        out[key] = spec.defaultValue
        continue
      }
      out[key] = result.value
      continue
    }

    const value = raw[key]
    out[key] = typeof value === 'function' ? value() : value
  }
  return { value: out }
}

/**
 * A checker that accepts any value verbatim. Use it for Cordis `volatile()`
 * raw fields, whose value is read lazily at call time.
 * @param {unknown} value - raw config value.
 * @returns {{ value: unknown }} the value.
 */
export function passthrough(value) {
  return { value }
}

/**
 * Build a checker accepting a string, with a default for absence.
 * @param {string} fallback - value used when the field is undefined or null.
 * @returns {FieldCheck} the checker.
 */
export function optionalString(fallback) {
  const check = (value) => {
    if (value === undefined || value === null) return { value: fallback }
    if (typeof value !== 'string') return { issues: [{ message: 'expected a string' }] }
    return { value }
  }
  check.defaultValue = fallback
  return check
}

/**
 * Build a checker accepting a boolean, with a default for absence.
 * @param {boolean} fallback - value used when the field is undefined or null.
 * @returns {FieldCheck} the checker.
 */
export function optionalBoolean(fallback) {
  const check = (value) => {
    if (value === undefined || value === null) return { value: fallback }
    if (typeof value !== 'boolean') return { issues: [{ message: 'expected a boolean' }] }
    return { value }
  }
  check.defaultValue = fallback
  return check
}

/**
 * Build a checker accepting a string from a fixed set, with a default for absence.
 * @param {readonly string[]} allowed - accepted values.
 * @param {string} fallback - value used when the field is undefined or null.
 * @returns {FieldCheck} the checker.
 */
export function optionalEnum(allowed, fallback) {
  const check = (value) => {
    if (value === undefined || value === null) return { value: fallback }
    if (typeof value !== 'string' || !allowed.includes(value)) {
      return { issues: [{ message: `expected one of: ${allowed.join(', ')}` }] }
    }
    return { value }
  }
  check.defaultValue = fallback
  return check
}
