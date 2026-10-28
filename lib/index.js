/**
 * Host half of the prompt enhancer.
 *
 * Responsibilities:
 *  - declare a Standard-Schema `Config` so Cordis activates the plugin;
 *  - register one HTTP route that the browser half calls;
 *  - resolve the model route lazily, so a missing `llm` or
 *    `agentDefaultModel` service degrades one feature instead of hanging
 *    `apply()` forever;
 *  - run the rewrite through `ctx.llm.stream` and return the cleaned text.
 *
 * The browser half lives in `./client.js` and arrives through the package's
 * `dsh.client` declaration.
 */
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_STYLE,
  MAX_DRAFT_CHARS,
  MAX_REQUEST_BYTES,
  STYLES,
  buildRequest,
  cleanResult,
  collectAssistantText,
  denialReason,
  normalizeStyle,
} from './core.js'
import { optionalBoolean, optionalEnum, optionalString, parseConfig, passthrough, standardSchema } from './schema.js'

/** HTTP path serving this plugin's API. */
export const ROUTE_PATH = '/plugins/dsh-prompt-enhancer-pro'

/** Locale namespace owned by the browser half. */
export const LOCALE_NS = 'promptEnhancer'

/**
 * Re-exported so the host test can assert that `/status` publishes the same cap
 * the route enforces, without spelling the number a second time.
 */
export { MAX_DRAFT_CHARS }

/**
 * Origins that ARE this application, accepted even though they are not loopback.
 *
 * The desktop renderer serves the UI from the privileged `dsh-app://` scheme, and
 * a `fetch` from there to `http://127.0.0.1:<port>` is cross-origin, so the
 * browser attaches `Origin: dsh-app://app`. `new URL` parses that as hostname
 * `app` — not loopback — so a host-only loopback rule REJECTED the application's
 * own requests. Measured against the running host:
 *
 *   POST /enhance  Host: 127.0.0.1:19387  Origin: dsh-app://app  ->  403
 *
 * A privileged scheme cannot be produced by a web page, so accepting it does not
 * widen the attack surface: anything served over http/https must still satisfy the
 * loopback `Host` rule and the JSON content-type rule.
 * @type {Set<string>}
 */
const APP_ORIGINS = new Set(['dsh-app://app'])

/**
 * The hostname part of a `Host` or `Origin` authority, without its port.
 *
 * `new URL` cannot be used on a bare `Host` value, and a bracketed IPv6 literal
 * needs its brackets removed before it can be compared to `::1`.
 * @param {string} authority - e.g. `127.0.0.1:19387` or `[::1]:19387`.
 * @returns {string} the lowercased hostname, or an empty string.
 */
function authorityHostname(authority) {
  const value = authority.trim().toLowerCase()
  if (value.length === 0) return ''
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? '' : value.slice(1, end)
  }
  const colon = value.lastIndexOf(':')
  // A bare IPv6 literal has several colons and no brackets; only strip a port
  // when there is exactly one colon.
  if (colon !== -1 && value.indexOf(':') === colon) return value.slice(0, colon)
  return value
}

/**
 * Whether a hostname names the local machine.
 *
 * This is the load-bearing half of the same-origin guard. Comparing `Origin`
 * against `Host` alone accepted a DNS-rebinding shape: a page served from
 * `http://attacker.example:19387` sends `Origin` and `Host` that agree with each
 * other, and they agree even when `attacker.example` resolves to 127.0.0.1.
 * Requiring `Host` itself to be loopback breaks the attack, because the browser
 * sends the attacker's NAME in `Host`, never `127.0.0.1`.
 * @param {string} hostname - a hostname without a port.
 * @returns {boolean} true when the name denotes the local machine.
 */
function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '0:0:0:0:0:0:0:1'
}

/**
 * Whether a request looks like it came from this application.
 *
 * The route sits OUTSIDE the host's `/api` authentication (that middleware only
 * wraps `/api/*`), so it must defend itself. Without a check, a page on any
 * origin can reach it with a CORS "simple request" — `text/plain` needs no
 * preflight — and each such request spends the user's model quota. A live probe
 * confirmed this: a foreign-Origin POST with `text/plain` returned 200 and a
 * real rewrite.
 *
 * Four signals. (1) is the one that carries the weight:
 *
 *  1. `Host` must be a loopback name. This is what defeats DNS rebinding; see
 *     {@link isLoopbackHostname}.
 *  2. `Origin`, when present, must be this application's own origin (see
 *     {@link APP_ORIGINS}), this very host, or a loopback name. A cross-site page
 *     cannot lie about its `Origin`.
 *  3. `Sec-Fetch-Site`, when present, must not say `cross-site`.
 *  4. A request with a body must declare JSON. This is a CORS non-safelisted
 *     content type, so a cross-site attempt is forced into a preflight, which
 *     this route answers with 405 and no CORS headers — the browser blocks it.
 *
 * Deliberately NOT checked: that the `Origin` scheme equals the request's scheme.
 * A Node request does not expose its own scheme, and the only substitutes are
 * proxy headers, which a client controls — trusting them would weaken the check
 * rather than strengthen it. The scheme allow-list in (2) covers what is
 * verifiable.
 *
 * The caller is the browser half, which sends `content-type: application/json`.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} true when the request may be served.
 */
export function isSameOriginRequest(req) {
  const headers = req?.headers ?? {}
  const host = typeof headers.host === 'string' ? headers.host.toLowerCase() : ''
  const hostname = authorityHostname(host)

  // (1) The request must be addressed to the local machine.
  if (!isLoopbackHostname(hostname)) return false

  // (2) Origin, when present, must be this application, this host, or loopback.
  const origin = typeof headers.origin === 'string' ? headers.origin.trim() : ''
  // The renderer's own origin is matched as written, before URL parsing: it carries
  // a privileged scheme, and parsing reports its hostname as `app`, not loopback.
  const isOwnOrigin = APP_ORIGINS.has(origin.toLowerCase())
  if (origin.length > 0 && !isOwnOrigin) {
    try {
      const parsed = new URL(origin)
      const scheme = parsed.protocol.replace(/:$/u, '').toLowerCase()
      if (scheme !== 'http' && scheme !== 'https') return false
      const originHost = parsed.hostname.toLowerCase()
      if (parsed.host.toLowerCase() !== host && !isLoopbackHostname(originHost)) return false
    } catch {
      return false
    }
  }

  // (3) An explicit cross-site declaration is refused.
  const site = headers['sec-fetch-site']
  if (typeof site === 'string' && site.trim().toLowerCase() === 'cross-site') return false

  // (4) A body must be JSON.
  const method = String(req?.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const contentType = typeof headers['content-type'] === 'string' ? headers['content-type'].toLowerCase() : ''
    if (!contentType.includes('application/json')) return false
  }

  return true
}

/**
 * Default hard deadline for one model call, in milliseconds.
 *
 * Node's own `requestTimeout` is 300s, which is far too long to hold a UI in a
 * loading state. A rewrite is a short task; anything past this is a stall, and
 * giving up reports it instead of hanging.
 * @type {number}
 */
export const DEFAULT_MODEL_TIMEOUT_MS = 60_000

/**
 * Resolve the model deadline for a request.
 *
 * Read per request rather than once at module load, so a test (or a user) can set
 * `DSH_PROMPT_ENHANCER_TIMEOUT_MS` at any point and be believed.
 * @returns {number} the deadline in milliseconds.
 */
export function modelTimeoutMs() {
  const raw = process.env.DSH_PROMPT_ENHANCER_TIMEOUT_MS
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const value = Number(raw)
    if (Number.isFinite(value) && value > 0) return value
  }
  return DEFAULT_MODEL_TIMEOUT_MS
}

/**
 * The user-facing message for a deadline that expired.
 *
 * Sub-second deadlines are reported in milliseconds: rounding 200ms to seconds
 * produced "超过 0 秒无响应", which reads like a bug rather than a limit.
 * @param {number} deadlineMs - the deadline that expired, in milliseconds.
 * @returns {string} the message.
 */
export function timeoutMessage(deadlineMs) {
  if (deadlineMs < 1000) return `增强超时（超过 ${String(deadlineMs)} 毫秒无响应），请重试。`
  return `增强超时（超过 ${String(Math.max(1, Math.round(deadlineMs / 1000)))} 秒无响应），请重试。`
}

/**
 * Config field map. The same declarations serve both roles: Cordis validates
 * the exported `Config` through {@link standardSchema}, and {@link apply}
 * re-resolves the live config through {@link parseConfig} at request time.
 *
 * `provider` and `model` default to empty, which makes the resolver fall back
 * to the host's default model selection.
 */
/**
 * The plugin's config field map.
 *
 * Exported so the pre-flight test can assert against the REAL map instead of a
 * hand-copied duplicate: a copy silently stops guarding the moment a key is
 * renamed here, which is exactly when the check is needed.
 * @type {Record<string, unknown>}
 */
export const CONFIG_FIELDS = {
  provider: optionalString(''),
  model: optionalString(''),
  defaultStyle: optionalEnum(STYLES, DEFAULT_STYLE),
  debugLog: optionalBoolean(true),
  enableRoute: optionalBoolean(true),
  /** Escape hatch: an unvalidated raw value kept for diagnostics. */
  extra: passthrough,
}

/** Plugin configuration, normalized by Cordis before `apply()` runs. */
export const Config = standardSchema(CONFIG_FIELDS)

/**
 * Hard dependencies.
 *
 * `webServer` is declared rather than reached for lazily. Cordis ties a fiber's
 * activation epoch to its injection set: with an empty set the epoch never
 * changes, and the only way to reach a service that appears later is a bare
 * `ctx.inject(...)` call, whose child fiber can leave this entry inactive —
 * which the startup audit reports as a failed entry and aborts the web boot.
 * Declaring the dependency makes Cordis itself wait for the service, so the
 * entry activates exactly when the route can be mounted.
 */
export const inject = ['webServer']

/**
 * Read a config field that may be a plain value or a Cordis getter function.
 * @param {unknown} value - configured field.
 * @param {unknown} fallback - value used when the field resolves to undefined.
 * @returns {unknown} the resolved value.
 */
function readConfig(value, fallback) {
  const resolved = typeof value === 'function' ? value() : value
  return resolved === undefined || resolved === null ? fallback : resolved
}

/**
 * Append one line to the plugin's boot log.
 *
 * Activation failures inside Cordis are otherwise invisible: the desktop app
 * files them under the Electron crash log while the UI stays silent. The log
 * makes "did apply() run?" answerable with one command.
 * @param {boolean} enabled - whether logging is on.
 * @param {string} line - text to record.
 * @returns {void}
 */
function bootLog(enabled, line) {
  if (!enabled) return
  try {
    appendFileSync(
      bootLogPath(),
      `${new Date().toISOString()} [pid ${process.pid}] ${line}\n`,
      'utf8',
    )
  } catch {
    // A logging failure must never break plugin activation.
  }
}

/**
 * Resolve the boot-log path.
 *
 * `DSH_PROMPT_ENHANCER_LOG` overrides it, which keeps offline test runs out of
 * the real log. That matters for diagnosis: a log containing test noise cannot
 * answer "did the app start cleanly?".
 * @returns {string} the absolute log path.
 */
function bootLogPath() {
  const override = process.env.DSH_PROMPT_ENHANCER_LOG
  if (typeof override === 'string' && override.length > 0) return override
  return join(homedir(), '.dsh', 'prompt-enhancer-pro-boot.log')
}

/**
 * Resolve the provider/model route for one request.
 *
 * Order: explicit config, then the host's agent default model, then the raw
 * plugin config again (a Cordis `volatile()` field can be a live getter whose
 * value changes after activation).
 * @param {object} ctx - host plugin context.
 * @param {object} cfg - normalized plugin config.
 * @returns {{ provider: string, model: string }} the resolved route.
 */
function resolveRoute(ctx, cfg) {
  const provider = String(readConfig(cfg.provider, '') ?? '')
  const model = String(readConfig(cfg.model, '') ?? '')
  if (provider.length > 0 && model.length > 0) return { provider, model }

  let fallback
  try {
    const service = ctx.get('agentDefaultModel')
    fallback = service?.currentSelection?.()
  } catch {
    fallback = undefined
  }
  return {
    provider: provider.length > 0 ? provider : String(fallback?.provider ?? ''),
    model: model.length > 0 ? model : String(fallback?.model ?? ''),
  }
}

/**
 * Read and parse a JSON request body with a size cap.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<object>} the parsed body.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_REQUEST_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object') throw new Error('body must be a JSON object')
  return parsed
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status code.
 * @param {object} body - JSON-serializable payload.
 * @returns {void}
 */
function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Per-request cancellation registry, so a reloading page does not leak streams. */
const inFlight = new Set()

/**
 * The live route registration, if any.
 *
 * Deliberately NOT keyed by the service object: Cordis hands out a fresh
 * wrapper on every service read, so an object-keyed map never matches across
 * reads and the plugin would silently register a second route that the owner
 * rejects with a throw. One plugin owns one route, so one slot is enough.
 * @type {{ server: object, release: () => void } | undefined}
 */
let mountedRoute

/**
 * Release the route: run the live registration's disposer and forget it.
 * Exported so a host that replaces the web server can hand ownership over, and
 * so tests can start from a clean module state.
 * @returns {void}
 */
export function releaseRouteOnce() {
  const live = mountedRoute
  mountedRoute = undefined
  if (live === undefined) return
  try {
    live.release()
  } catch {
    // A failing remover must not break plugin teardown.
  }
}

/**
 * Plugin body.
 * @param {object} ctx - host plugin context.
 * @param {object} cfg - normalized plugin config.
 * @returns {void}
 */
export function apply(ctx, config) {
  // `config` arrives already normalized by Cordis; re-resolving against the same
  // field map keeps this body working when invoked directly (tests, probes) and
  // preserves `volatile()` fields as late-read getters.
  //
  // The presence of a `debugLog` field decides whether issues can be logged at
  // all, so coercion reports are buffered and flushed once that is known — the
  // log is the only place a user learns an ignored value was ignored.
  const coerced = []
  const cfg = parseConfig(
    CONFIG_FIELDS,
    config === null || typeof config !== 'object' ? {} : config,
    (message, key) => coerced.push({ key, message }),
  ).value

  const debugLog = readConfig(cfg.debugLog, true) !== false
  bootLog(debugLog, 'apply() entered')
  for (const { key, message } of coerced) {
    bootLog(debugLog, `config: ignored invalid value for "${key}" (${message}); using the default`)
  }

  /**
   * Serve one enhancement request.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {Promise<void>} fulfillment after the response is written.
   */
  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    // Refuse anything that does not look like this application talking to itself.
    // Checked first, before the body is read, so a foreign page cannot make this
    // plugin spend quota or allocate. `status` is a read-only probe the browser
    // half uses to learn the available styles, so it is deliberately open.
    if (url.pathname !== `${ROUTE_PATH}/status` && !isSameOriginRequest(req)) {
      bootLog(debugLog, `refused a request that is not from this application: ${url.pathname}`)
      sendJson(res, 403, { ok: false, error: 'forbidden: this endpoint only serves the application itself' })
      return
    }

    if (url.pathname === `${ROUTE_PATH}/status`) {
      sendJson(res, 200, {
        ok: true,
        styles: STYLES,
        defaultStyle: String(readConfig(cfg.defaultStyle, DEFAULT_STYLE)),
        route: ROUTE_PATH,
        // The browser half cannot import the engine (its only module is `react`),
        // so it used to hard-code 4000 and drift silently the moment this number
        // changed. Publishing it keeps one source of truth; the client falls back
        // to its own copy if this probe never answers.
        maxDraftChars: MAX_DRAFT_CHARS,
      })
      return
    }

    if (url.pathname === `${ROUTE_PATH}/client-error`) {
      // The browser half reports its own activation state here so it lands in
      // the boot log, next to the host-side lines, instead of only inside the
      // renderer's console where it is easy to miss. Two phases arrive: a
      // heartbeat once the client body has run, and a failure when it threw.
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'use POST' })
        return
      }
      let report = {}
      try {
        report = await readJsonBody(req)
      } catch {
        report = {}
      }

      // Every report leaves a line, whatever its shape: a report that is
      // received but not logged is indistinguishable from no report at all,
      // which is exactly the ambiguity this route exists to remove.
      //
      // An unknown phase is treated as `observed`, not as this plugin's failure:
      // claiming a failure we cannot attribute is worse than under-reporting it.
      const rawPhase = typeof report.phase === 'string' ? report.phase : ''
      const phase = rawPhase === 'applied' || rawPhase === 'failed' ? rawPhase : 'observed'
      // `control` is a tri-state string from a current client and a boolean from
      // an older bundle that may still be cached in a page. Both are accepted so
      // the log stays readable across a refresh.
      const controlState =
        typeof report.control === 'string'
          ? report.control
          : report.controlRegistered === true
            ? 'yes'
            : report.controlRegistered === false
              ? 'no'
              : '?'
      const detail = [
        `locale=${report.hasLocale === true ? 'yes' : report.hasLocale === false ? 'no' : '?'}`,
        `slots=${report.hasSlots === true ? 'yes' : report.hasSlots === false ? 'no' : '?'}`,
        `dictionaries=${report.dictionariesRegistered === true ? 'yes' : report.dictionariesRegistered === false ? 'no' : '?'}`,
        `control=${controlState}`,
      ].join(' ')

      // Three phases. `observed` exists so the browser half can forward an error
      // it cannot attribute to itself WITHOUT this half writing it as this
      // plugin's activation failure. Both keep the message, so no diagnostic is
      // lost; only the attribution differs.
      if (phase === 'applied') {
        bootLog(debugLog, `CLIENT APPLIED: ${detail}`)
      } else if (phase === 'observed') {
        const observed = typeof report.message === 'string' ? report.message : 'unknown page error'
        bootLog(debugLog, `CLIENT OBSERVED (not attributed to this plugin): ${observed}`)
      } else {
        const message = typeof report.message === 'string' ? report.message : 'unknown client failure'
        const stack = typeof report.stack === 'string' ? `\n${report.stack}` : ''
        bootLog(debugLog, `CLIENT FAILURE (phase=${phase} ${detail}): ${message}${stack}`)
      }
      sendJson(res, 200, { ok: true })
      return
    }

    if (url.pathname !== `${ROUTE_PATH}/enhance`) {
      sendJson(res, 404, { ok: false, error: 'unknown path' })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'use POST' })
      return
    }

    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: `bad request: ${String(error?.message ?? error)}` })
      return
    }

    const draft = typeof body.draft === 'string' ? body.draft : ''
    // Style resolution order: a valid requested style wins; anything else
    // (absent, empty, or unknown) uses the configured default.
    const configuredDefault = normalizeStyle(readConfig(cfg.defaultStyle, DEFAULT_STYLE))
    const style = typeof body.style === 'string' && STYLES.includes(body.style) ? body.style : configuredDefault

    const route = resolveRoute(ctx, cfg)
    const llm = (() => {
      try {
        return ctx.get('llm')
      } catch {
        return undefined
      }
    })()

    const denial = denialReason({
      draft,
      llmAvailable: llm !== undefined && typeof llm.stream === 'function',
      provider: route.provider,
      model: route.model,
    })
    if (denial !== undefined) {
      bootLog(debugLog, `denied: ${denial}`)
      sendJson(res, 200, { ok: false, error: denial })
      return
    }

    const controller = new AbortController()
    inFlight.add(controller)
    const onAborted = () => controller.abort()
    req.once('aborted', onAborted)
    res.once('close', onAborted)

    // A deadline is mandatory, not a nicety: without it a provider that never
    // produces a chunk leaves `for await` pending forever, so the response never
    // goes out and the request's controller is never released. Every retry then
    // multiplies the cost. The timeout fires the same signal the client's
    // disconnect uses, so adapters only need to honour one thing.
    const deadlineMs = modelTimeoutMs()
    let timedOut = false
    const timeoutSignal = AbortSignal.timeout(deadlineMs)
    const deadline = () => {
      timedOut = true
      controller.abort()
    }
    timeoutSignal.addEventListener('abort', deadline, { once: true })

    try {
      bootLog(debugLog, `enhance start provider=${route.provider} model=${route.model} style=${style}`)
      const stream = llm.stream(
        buildRequest({ draft, style, provider: route.provider, model: route.model, signal: controller.signal }),
      )
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      const { text, failure, truncated } = collectAssistantText(chunks)

      // The deadline is checked BEFORE the failure branch. A real dsh-llm adapter
      // does not throw on abort — it ends the stream with a terminal
      // `finish {kind:'aborted', failure}` chunk, so `failure` is set and the
      // `timedOut` branch below would never be reached. Users saw a raw English
      // "The operation was aborted" instead of a timeout message, and the timeout
      // branch was effectively dead code. Only the fake adapter in the tests threw.
      if (timedOut) {
        bootLog(debugLog, `enhance timeout after ${String(deadlineMs)}ms`)
        sendJson(res, 200, { ok: false, error: timeoutMessage(deadlineMs) })
        return
      }

      if (failure !== undefined) {
        const detail = failure.failure?.message ?? failure.kind ?? 'unknown'
        sendJson(res, 200, { ok: false, error: `模型调用失败：${String(detail)}` })
        return
      }

      // A token-limit cut is a normal outcome, not a failure: the clamp exists
      // for exactly this, so keep the answer and note that it was trimmed.
      if (truncated) bootLog(debugLog, 'enhance note: model hit the token limit; the result was clamped')

      const result = cleanResult(text)
      if (result.length === 0) {
        sendJson(res, 200, { ok: false, error: '模型返回了空内容。' })
        return
      }
      bootLog(debugLog, `enhance ok chars=${result.length}`)
      sendJson(res, 200, { ok: true, text: result, style })
    } catch (error) {
      if (timedOut) {
        bootLog(debugLog, `enhance timeout after ${String(deadlineMs)}ms`)
        sendJson(res, 200, { ok: false, error: timeoutMessage(deadlineMs) })
        return
      }
      bootLog(debugLog, `enhance threw: ${String(error?.message ?? error)}`)
      sendJson(res, 200, { ok: false, error: `增强失败：${String(error?.message ?? error)}` })
    } finally {
      timeoutSignal.removeEventListener('abort', deadline)
      inFlight.delete(controller)
      req.off('aborted', onAborted)
      res.off('close', onAborted)
    }
  }

  if (readConfig(cfg.enableRoute, true) === false) {
    bootLog(debugLog, 'route disabled by config')
    return undefined
  }

  return mountRoute(ctx, cfg, debugLog, handler)
}

/**
 * Mount the plugin's HTTP route, tolerating every failure.
 *
 * A throw inside a Cordis plugin body marks the entry FAILED. The consequence
 * differs by half, and the README records the full picture:
 *
 *  - THIS half: `dsh-app-boot`'s startup audit only raises `StartupError` for a
 *    fixed `requiredStartupEntryIds` set (agent-loop, webserver, modules,
 *    connection, headless-runner, acp, sdk-jsonrpc-server). `prompt-enhancer` is
 *    not in it, so a failure here degrades to a warning.
 *  - The browser half: the renderer's audit has no notion of "required" and
 *    throws on ANY non-active client entry — including `pending`. That is what
 *    aborts the page's web boot and raises the disable prompt.
 *
 * Either way a throw buys nothing: losing the route degrades one feature, and
 * defensive code here keeps a wording change in the host from turning a warning
 * into a startup failure. So nothing here is allowed to escape.
 *
 * @param {object} ctx - host plugin context.
 * @param {object} cfg - normalized plugin config.
 * @param {boolean} debugLog - whether to append to the boot log.
 * @param {Function} handler - the route handler.
 * @returns {(() => void) | undefined} the route disposer, when mounted.
 */
function mountRoute(ctx, cfg, debugLog, handler) {
  try {
    /**
     * Resolve the web server service, tolerating both the own-property form a
     * real Cordis context exposes and the resolver form a child context uses.
     * @param {object} scope - host or child context.
     * @returns {object | undefined} the service, when present.
     */
    const webServerOf = (scope) => {
      const direct = scope.webServer
      if (direct !== undefined) return direct
      try {
        return scope.get?.('webServer')
      } catch {
        return undefined
      }
    }

    const server = webServerOf(ctx)
    if (server === undefined || typeof server.register !== 'function') {
      bootLog(debugLog, 'webServer service is not usable; the enhance control will report an unreachable service')
      return undefined
    }

    // Idempotent, checked BEFORE registering: the owner rejects a duplicate
    // (kind, path) with a throw, so a repeat activation pass must reuse the live
    // route. Identity is not keyed on the service object because Cordis returns
    // a fresh wrapper per read.
    if (mountedRoute !== undefined) {
      bootLog(debugLog, 'route already mounted; reusing it')
      return undefined
    }

    const disposer = server.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler,
    })

    /**
     * Remove this registration and forget it.
     * @returns {void}
     */
    const release = () => {
      mountedRoute = undefined

      // Abort requests still in flight. Without this the set was dead state that
      // only grew: a reload left the old handler streaming into a dead socket
      // until the adapter finished, still consuming quota.
      for (const controller of [...inFlight]) {
        try {
          controller.abort()
        } catch {
          // An abort that throws must not block teardown.
        }
      }
      inFlight.clear()

      try {
        disposer()
      } catch (error) {
        bootLog(debugLog, `route disposer failed: ${String(error?.message ?? error)}`)
      }
    }

    mountedRoute = { server, release }
    bootLog(debugLog, 'HTTP routes mounted')
    return release
  } catch (error) {
    bootLog(debugLog, `ROUTE MOUNT FAILED (plugin stays loaded, feature unavailable): ${String(error?.message ?? error)}`)
    return undefined
  }
}
