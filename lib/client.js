/**
 * Browser half of the prompt enhancer.
 *
 * Hand-written lazy-CJS bundle for the harness module loader. It deliberately
 * requires only `react`: an external plugin's bundle can resolve nothing but
 * the frozen platform seed table (React, Cordis, ...), so every other helper is
 * inlined here.
 *
 * The control registers into `conversation.input.right`, the session-scoped
 * list slot that `ui-conversation` renders before the model picker. That slot
 * projects `inputActions` (setDraft / insertText / captureInsertion) and the
 * `input` hook carrying the current draft.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-prompt-enhancer',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'promptEnhancer'
    /** HTTP base served by the host half. */
    const ROUTE = '/plugins/dsh-prompt-enhancer'
    /** Fallback style order, used until /status answers. */
    const STYLE_ORDER = ['default', 'structured', 'concise', 'expand']
    /**
     * Style ids the host half applies an extra instruction for.
     *
     * Metadata only; it has no consumer inside this bundle. Kept in sync with
     * `STYLE_ADDENDUM` in `lib/core.js`, which appends to all three.
     */
    const STYLE_WITH_ADDENDUM = new Set(['structured', 'concise', 'expand'])
    /**
     * Fallback draft cap, mirroring `MAX_DRAFT_CHARS` in `lib/core.js`.
     *
     * The browser half cannot import the engine (its only module is `react`), so a
     * local copy is unavoidable — but it is only a FALLBACK. The host publishes the
     * real number through `/status` and the component prefers it, so drift costs
     * nothing while the probe answers and this value only has to be sane.
     * @type {number}
     */
    const FALLBACK_MAX_DRAFT_CHARS = 4000

    /**
     * One-time registration guards.
     *
     * Cordis re-executes a plugin body whenever the fiber's injection epoch
     * changes, and this bundle's module instance survives that. Both registries
     * below are one-shot by contract:
     *   - `locale.register` throws `locale namespace "<ns>" already has locale`
     *     on a repeat call;
     *   - a second `slots.inject` for the same slot would register the control
     *     twice.
     * Without these guards a repeat pass throws, Cordis marks the entry FAILED,
     * and the startup audit aborts the whole web boot.
     */
    /**
     * The client services this plugin declares.
     *
     * One source of truth on purpose: `exports.inject` is built from it, and the
     * startup heartbeat may only report services listed here. Reading an
     * UNDECLARED service on a Cordis context throws
     * `cannot get property "webServer" without inject` — and because that read
     * happened inside `apply`, the throw escaped and broke activation.
     * @type {string[]}
     */
    const INJECTED_SERVICES = ['slots', 'locale']

    let dictionariesRegistered = false
    /**
     * Marks the console.error we installed, so a later module instance can tell
     * an already-patched function from a pristine one.
     * @type {symbol}
     */
    const CONSOLE_HOOK = Symbol.for('dsh-prompt-enhancer.consoleHook')
    /**
     * Control registration state.
     *
     * `null` means "not registered"; a function is the release callback of the
     * live registration. Tracking the release rather than a boolean is what lets
     * a later activation pass re-register after Cordis unloaded the previous one.
     * @type {null | (() => void)}
     */
    let controlRegistered = null
    /**
     * Whether an injection into the composer slot is in flight.
     *
     * `slots.inject` runs its callback only once the slot's declarer appears, and
     * on a cold start the page loads before the chat surface does. The heartbeat
     * fires at apply time, so without this flag it reported `control=no` for a
     * perfectly healthy page and made a timing artefact look like a missing
     * button. `control=pending` says "waiting for the slot", `control=no` says
     * "registration was refused".
     * @type {boolean}
     */
    let controlPending = false
    let applyReported = false
    /** Whether the global render-diagnostics hooks are already installed. */
    let renderDiagnosticsInstalled = false
    /** True while a failure is being reported, so the console hook cannot recurse. */
    let reportingFailure = false
    /**
     * Prefix on every console line this plugin emits. The console hook skips
     * anything carrying it, so our own reporting is never re-reported.
     * @type {string}
     */
    const SELF_REPORT_PREFIX = 'dsh-prompt-enhancer:'

    /**
     * Stand-in store for when the slot hands over no `useInput` hook.
     *
     * `useSyncExternalStore` requires referentially stable functions: a fresh
     * closure each render is seen as a changed snapshot and re-renders forever.
     * Hence module-level constants rather than inline arrow functions.
     * @returns {null} always, meaning "no input state".
     */
    const NO_INPUT_SNAPSHOT = () => null

    /** No-op subscription paired with {@link NO_INPUT_SNAPSHOT}. */
    const NO_INPUT_SUBSCRIBE = () => () => {}

    const zh = {
      'action.enhance': '增强提示词',
      'action.loading': '正在增强…',
      'action.revert': '恢复原文',
      'action.retry': '重试',
      'action.cancel': '取消增强',
      'menu.title': '选择增强风格',
      'menu.hint': '右键切换风格',
      'style.default': '默认改写',
      'style.structured': '结构化',
      'style.concise': '精简',
      'style.expand': '扩充',
      'hint.empty': '先输入草稿再增强',
      'hint.edited': '草稿已改动，未覆盖',
      'hint.revertStale': '草稿已改动，未恢复原文',
      'error.network': '无法连接增强服务',
      'error.empty': '模型返回了空内容。',
      'error.tooLong': '草稿过长，请精简后再试',
      'error.forbidden': '请求被拒绝：仅允许本应用自身调用',
    }
    const en = {
      'action.enhance': 'Enhance prompt',
      'action.loading': 'Enhancing…',
      'action.revert': 'Revert',
      'action.retry': 'Retry',
      'action.cancel': 'Cancel enhancement',
      'menu.title': 'Enhancement style',
      'menu.hint': 'Right-click to change style',
      'style.default': 'Default rewrite',
      'style.structured': 'Structured',
      'style.concise': 'Concise',
      'style.expand': 'Expand',
      'hint.empty': 'Type a draft first',
      'hint.edited': 'Draft changed; not overwritten',
      'hint.revertStale': 'Draft changed; original not restored',
      'error.network': 'Enhancement service unreachable',
      'error.empty': 'The model returned nothing.',
      'error.tooLong': 'Draft too long; shorten it and retry',
      'error.forbidden': 'Refused: only the application itself may call this',
    }

    /**
     * Inline sparkle glyph, so the bundle needs no icon package.
     * @returns {object} a React element.
     */
    function sparkleIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          fill: 'currentColor',
          d: 'M8 1.2l1.35 3.9 3.9 1.35-3.9 1.35L8 11.7 6.65 7.8 2.75 6.45l3.9-1.35L8 1.2zm4.4 8.2l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z',
        }),
      )
    }

    /**
     * Read a style's localized label.
     * @param {object} t - translate function.
     * @param {string} style - style id.
     * @returns {string} the label.
     */
    function styleLabel(t, style) {
      return t(`style.${style}`)
    }

    /**
     * Read the composer input state into the props the view needs.
     *
     * The hook is called on EVERY render, with no guard, no early return and no
     * try/catch:
     *
     *  - Skipping it (or calling it inside a condition) changes the hook count
     *    between renders. React then loses the mapping from state to hook and
     *    reports `Minified React error #311`, "Rendered fewer/more hooks than
     *    expected", from an unrelated hook further down — it points nowhere near
     *    the cause. See https://react.dev/reference/eslint-plugin-react-hooks/lints/rules-of-hooks
     *  - Wrapping it in try/catch is just as bad: catching leaves React's hook
     *    cursor advanced differently from the previous render, so the very next
     *    hook throws the same #311.
     *
     * When the slot provides no hook, `useSyncExternalStore` is still called —
     * with a static store that always reads `null`. That keeps the call
     * unconditional, which is the only thing React actually requires.
     * @param {unknown} useInput - the slot's input selector hook.
     * @returns {object | null} the input state, or null when there is none.
     */
    function useComposerInput(useInput) {
      return typeof useInput === 'function'
        ? useInput((state) => state)
        : react.useSyncExternalStore(NO_INPUT_SUBSCRIBE, NO_INPUT_SNAPSHOT, NO_INPUT_SNAPSHOT)
    }

    /**
     * The registered component: resolve the input state, then render the view.
     *
     * Its hook count is exactly one whatever the props are, so React's hook
     * ordering cannot drift between renders.
     * @param {object} props - slot props.
     * @returns {object | null} the control element.
     */
    function PromptEnhancer(props) {
      const input = useComposerInput(props.useInput)
      return react.createElement(PromptEnhancerView, { ...props, input: input ?? undefined })
    }

    /**
     * The composer control: enhance, cancel, revert, and pick a style.
     *
     * Pure in its inputs, so a test can render it directly with a resolved
     * `input` and exercise every visual state.
     * @param {object} props - slot props plus the resolved input state.
     * @returns {object | null} a React element, or null when the slot is unusable.
     */
    function PromptEnhancerView(props) {
      const { inputActions, t: providedT, input } = props

      const translate = typeof providedT === 'function' ? providedT : (key) => zh[key] ?? key
      const draft = input !== undefined && input !== null && typeof input.draft === 'string' ? input.draft : ''
      const actions = inputActions
      const usable = actions !== undefined && typeof actions.setDraft === 'function'

      const [phase, setPhase] = react.useState('idle')
      const [error, setError] = react.useState('')
      const [notice, setNotice] = react.useState('')
      const [backup, setBackup] = react.useState(null)
      /**
       * The text this control last wrote, or null.
       *
       * Reverting is only safe while the composer still holds exactly this. Once
       * the user edits the rewrite, "恢复原文" would silently discard their work.
       */
      const [rewritten, setRewritten] = react.useState(null)
      const [menuOpen, setMenuOpen] = react.useState(false)
      const [styles, setStyles] = react.useState(STYLE_ORDER)
      const [style, setStyle] = react.useState('default')
      /**
       * The host's draft cap, published through `/status`.
       *
       * Starts at the local fallback so the check works before the probe answers,
       * and is replaced by the host's real number when it does. The host remains
       * authoritative either way: this only decides whether a request is worth
       * sending.
       */
      const [maxDraftChars, setMaxDraftChars] = react.useState(FALLBACK_MAX_DRAFT_CHARS)

      const mounted = react.useRef(true)
      const controller = react.useRef(null)
      const draftRef = react.useRef(draft)
      draftRef.current = draft
      /**
       * Whether the user has chosen a style by hand.
       *
       * The `/status` probe is asynchronous, so its answer could land after the
       * user picked from the menu and silently reset the choice.
       */
      const styleTouched = react.useRef(false)

      react.useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
          controller.current?.abort()
        }
      }, [])

      react.useEffect(() => {
        let cancelled = false
        fetch(`${ROUTE}/status`)
          .then((response) => (response.ok ? response.json() : undefined))
          .then((payload) => {
            if (cancelled || payload === undefined) return
            if (Array.isArray(payload.styles) && payload.styles.length > 0) setStyles(payload.styles)
            // Prefer the host's own cap over the local fallback.
            if (Number.isInteger(payload.maxDraftChars) && payload.maxDraftChars > 0) {
              setMaxDraftChars(payload.maxDraftChars)
            }
            // Never override a style the user already chose.
            if (!styleTouched.current && typeof payload.defaultStyle === 'string') {
              setStyle(payload.defaultStyle)
            }
          })
          .catch(() => {})
        return () => {
          cancelled = true
        }
      }, [])

      /**
       * Run one enhancement for the given style.
       * @param {string} chosenStyle - style id to request.
       * @returns {Promise<void>} fulfillment when the attempt settles.
       */
      const enhance = react.useCallback(
        async (chosenStyle) => {
          if (!usable) return
          const current = draftRef.current
          if (current.trim().length === 0) {
            setError(translate('hint.empty'))
            return
          }
          // Refuse an over-long draft here rather than spending a round trip to
          // learn the host's answer. The unit matches the host: code points, so a
          // draft of emoji is measured the way the user counts it.
          if ([...current].length > maxDraftChars) {
            setError(translate('error.tooLong'))
            return
          }

          controller.current?.abort()
          const next = new AbortController()
          controller.current = next

          setMenuOpen(false)
          setError('')
          setNotice('')
          setPhase('loading')

          try {
            const response = await fetch(`${ROUTE}/enhance`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ draft: current, style: chosenStyle }),
              signal: next.signal,
            })
            const payload = await response.json()
            if (!mounted.current || next.signal.aborted) return
            if (payload?.ok !== true) {
              setPhase('idle')
              // `??` only falls back on null/undefined, so an empty string became
              // a silent no-op: no message, no error state, nothing to see.
              const reported = typeof payload?.error === 'string' ? payload.error.trim() : ''
              setError(reported.length > 0 ? reported : translate('error.network'))
              return
            }
            // Refuse to overwrite content the user changed while the model ran.
            if (draftRef.current !== current) {
              setPhase('idle')
              setNotice(translate('hint.edited'))
              return
            }
            // A success payload without usable text must not reach the composer.
            // `String(undefined)` used to write the literal "undefined" and set a
            // backup, which then left only "恢复原文" as a way back.
            const rewritten = typeof payload.text === 'string' ? payload.text : ''
            if (rewritten.trim().length === 0) {
              setPhase('idle')
              setError(translate('error.empty'))
              return
            }
            setBackup(current)
            setRewritten(rewritten)
            actions.setDraft(rewritten)
            setPhase('idle')
          } catch (cause) {
            if (!mounted.current || next.signal.aborted) return
            setPhase('idle')
            setError(translate('error.network'))
          } finally {
            if (controller.current === next) controller.current = null
          }
        },
        [actions, maxDraftChars, translate, usable],
      )

      /**
       * Cancel the in-flight request.
       * @returns {void}
       */
      const cancel = react.useCallback(() => {
        controller.current?.abort()
        controller.current = null
        setPhase('idle')
        // A menu left open by a pre-loading right click would otherwise appear
        // once the request settles.
        setMenuOpen(false)
      }, [])

      /**
       * Restore the pre-enhancement draft.
       *
       * Guarded against a stale backup: if the composer no longer holds the text
       * this control wrote, the user has edited it since, and reverting would
       * discard that work without asking.
       * @returns {void}
       */
      const revert = react.useCallback(() => {
        if (backup === null || !usable) return
        if (rewritten !== null && draftRef.current !== rewritten) {
          setBackup(null)
          setRewritten(null)
          setError('')
          setNotice(translate('hint.revertStale'))
          return
        }
        actions.setDraft(backup)
        setBackup(null)
        setRewritten(null)
        setError('')
        setNotice('')
      }, [actions, backup, rewritten, translate, usable])

      // Deliberately NOT a null return. A silent null is indistinguishable from
      // "the plugin never loaded", which makes a wiring problem impossible to
      // see. Rendering a disabled control with the reason keeps the failure
      // visible in the UI it affects.
      const blockedReason = usable
        ? ''
        : 'inputActions 不可用（槽位未提供写回能力）'

      const busy = phase === 'loading'
      // Revert must not be gated on a non-empty draft: after enhancing, clearing
      // the composer used to leave the button labelled "恢复原文" but disabled,
      // and a disabled button dispatches no click — the original draft became
      // unreachable for the rest of the page's life.
      const canEnhance = usable && (draft.trim().length > 0 || busy || backup !== null)

      const buttonLabel = !usable
        ? translate('action.enhance')
        : busy
          ? translate('action.cancel')
          : backup !== null
            ? translate('action.revert')
            : error.length > 0
              ? translate('action.retry')
              : translate('action.enhance')

      const onButtonClick = () => {
        if (busy) {
          cancel()
          return
        }
        if (backup !== null) {
          revert()
          return
        }
        void enhance(style)
      }

      const onButtonContextMenu = (event) => {
        event.preventDefault()
        // Opening while a request runs used to latch `menuOpen` while `!busy`
        // suppressed the render, so the menu appeared by itself the moment the
        // request settled. `phase` is read directly because `busy` is derived
        // further down.
        if (phase === 'loading') return
        setMenuOpen((open) => !open)
      }

      const styleMenu =
        menuOpen && !busy
          ? h(
              'div',
              {
                style: {
                  position: 'absolute',
                  bottom: 'calc(100% + 6px)',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  zIndex: 30,
                  minWidth: 148,
                  padding: 4,
                  borderRadius: 8,
                  border: '1px solid var(--dsw-alias-border, rgba(127,127,127,0.28))',
                  background: 'var(--dsw-alias-bg-elevated, Canvas)',
                  boxShadow: '0 6px 20px rgba(0,0,0,0.16)',
                  color: 'var(--dsw-alias-text, CanvasText)',
                },
                role: 'menu',
              },
              styles.map((candidate) =>
                h(
                  'button',
                  {
                    key: candidate,
                    type: 'button',
                    role: 'menuitemradio',
                    'aria-checked': candidate === style,
                    onClick: () => {
                      // Mark the choice so a late /status answer cannot reset it.
                      styleTouched.current = true
                      setStyle(candidate)
                      setMenuOpen(false)
                      void enhance(candidate)
                    },
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      width: '100%',
                      padding: '6px 8px',
                      border: 'none',
                      borderRadius: 6,
                      background: 'transparent',
                      color: 'inherit',
                      font: 'inherit',
                      fontSize: 12,
                      textAlign: 'left',
                      cursor: 'pointer',
                    },
                    onMouseEnter: (event) => {
                      event.currentTarget.style.background = 'var(--dsw-alias-bg-hover, rgba(127,127,127,0.14))'
                    },
                    onMouseLeave: (event) => {
                      event.currentTarget.style.background = 'transparent'
                    },
                  },
                  h('span', { style: { width: 12 }, 'aria-hidden': 'true' }, candidate === style ? '✓' : ''),
                  h('span', null, styleLabel(translate, candidate)),
                ),
              ),
            )
          : null

      const message = blockedReason.length > 0 ? blockedReason : error.length > 0 ? error : notice

      return h(
        'div',
        { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        styleMenu,
        h(
          'button',
          {
            type: 'button',
            onClick: onButtonClick,
            onContextMenu: onButtonContextMenu,
            disabled: !canEnhance,
            title: blockedReason.length > 0 ? blockedReason : `${styleLabel(translate, style)}（${translate('menu.hint')}）`,
            'aria-label': buttonLabel,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              height: 28,
              padding: '0 9px',
              borderRadius: 14,
              border: '1px solid var(--dsw-alias-border, rgba(127,127,127,0.28))',
              background: 'transparent',
              color: canEnhance ? 'var(--dsw-alias-text, CanvasText)' : 'var(--dsw-alias-text-disabled, rgba(127,127,127,0.55))',
              font: 'inherit',
              fontSize: 12,
              lineHeight: 1,
              cursor: canEnhance ? 'pointer' : 'not-allowed',
              whiteSpace: 'nowrap',
              opacity: canEnhance ? 1 : 0.6,
            },
          },
          h('span', { style: { display: 'inline-flex' } }, sparkleIcon()),
          h('span', null, buttonLabel),
        ),
        message.length > 0
          ? h(
              'span',
              {
                style: {
                  marginLeft: 6,
                  maxWidth: 220,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 12,
                  color: error.length > 0 ? 'var(--dsw-alias-danger, #d4380d)' : 'var(--dsw-alias-text-secondary, GrayText)',
                },
                role: error.length > 0 ? 'alert' : 'status',
              },
              message,
            )
          : null,
      )
    }

    /**
     * Browser plugin body.
     *
     * Declares `slots` and `locale` as dependencies so Cordis owns the wait for
     * them, then registers exactly once.
     *
     * Two independent defences, because a throw here marks the entry FAILED and
     * `web boot` then aborts the whole application:
     *
     *  1. One-shot guards. Cordis re-executes a plugin body on an injection
     *     epoch change, and this module instance survives that. Both registries
     *     below reject a repeat (dsh-client-locale throws
     *     `locale namespace "x" already has locale "y"`), so a repeat pass must
     *     be a no-op.
     *  2. A catch-all. This is best-effort UI: a plugin able to add a button
     *     must never be able to prevent the app from starting. A failure is
     *     reported to the host for diagnostics and then swallowed.
     *
     * @param {object} ctx - client plugin context.
     * @returns {void}
     */
    /**
     * Register one owned resource, preferring Cordis ownership.
     *
     * `ctx.effect` owns a resource's lifetime: the callback's return value runs
     * on teardown. Real client plugins use it (dsh-client-locale does), but it is
     * NOT guaranteed to be present on every client context — a bundle must not
     * assume it. Accessing a missing method threw `ctx.effect is not a function`
     * inside this plugin's own body, which meant the dictionary registration had
     * been failing silently and the control could not register at all.
     *
     * When `effect` is available the resource is owned; when it is not, the
     * resource is simply registered without a teardown hook. Either way this
     * function never throws because of a missing method.
     * @param {object} ctx - client plugin context.
     * @param {() => (() => void) | undefined} body - installer returning a disposer.
     * @returns {boolean} whether Cordis took ownership.
     */
    function ownEffect(ctx, body) {
      if (typeof ctx?.effect !== 'function') return false
      try {
        ctx.effect(body, 'prompt-enhancer: owned resource')
        return true
      } catch (error) {
        // `effect` existing is not the same as `effect` working. Report and let
        // the caller install without ownership, rather than losing the resource.
        reportClientFailure(error)
        return false
      }
    }

    function apply(ctx) {
      try {
        installDiagnosticsOnce(ctx)

        const hasLocale = ctx?.locale !== undefined && typeof ctx.locale.register === 'function'
        const hasSlots = ctx?.slots !== undefined && typeof ctx.slots.inject === 'function'

        if (!dictionariesRegistered && hasLocale) {
          const owned = ownEffect(ctx, () => {
            // A release resets the guard so a later activation pass can register
            // again after Cordis tore this resource down.
            dictionariesRegistered = true
            const release = ctx.locale.register(NS, { zh, en })
            return () => {
              dictionariesRegistered = false
              release()
            }
          })
          if (!owned) {
            // No ownership available: register once, and let the guard follow the
            // actual outcome rather than being set before the attempt.
            try {
              ctx.locale.register(NS, { zh, en })
              dictionariesRegistered = true
            } catch (error) {
              // The duplicate-namespace refusal is the expected case on a second
              // pass; the dictionary is already there, so the guard stays set.
              dictionariesRegistered = true
              void error
            }
          }
        }

        if (controlRegistered === null && hasSlots) {
          registerControl(ctx)
        }

        // One heartbeat per page load. Without it, "the button is missing"
        // cannot be told apart from "this half never ran", because a silent
        // early return leaves no trace anywhere.
        if (!applyReported) {
          applyReported = true
          reportClientEvent('applied', {
            hasLocale,
            hasSlots,
            dictionariesRegistered,
            // Three states, because two were not enough: `no` used to mean both
            // "not registered yet" and "registration was refused", and reading it
            // as the latter sent us chasing a button that was never missing.
            control: controlRegistered !== null ? 'yes' : controlPending ? 'pending' : 'no',
            // Report only services this plugin DECLARED. Two traps live here and
            // both were hit:
            //
            //  - Enumerating `Object.keys(ctx)` reads every service, and on a
            //    Cordis context a read registers an injection, so it could widen
            //    this fiber's injection set and trigger the epoch change this
            //    plugin guards against.
            //  - Probing an undeclared service is worse than wasteful: Cordis
            //    throws `cannot get property "webServer" without inject`, which
            //    propagated out of apply(). The client half injects only
            //    `slots` and `locale`; `webServer` and `llm` are host-half
            //    services and must never be touched from here.
            services: INJECTED_SERVICES.filter((name) => ctx != null && name in ctx).join(','),
          })
        }
      } catch (error) {
        reportClientFailure(error)
      }
    }

    /**
     * The component registered into the slot.
     *
     * A render throw inside this half is otherwise completely silent: the slot
     * runtime wraps every list entry in an error boundary that swallows the
     * error and leaves an empty `data-slot-error` div, with nothing in any file
     * on disk. `installRenderDiagnostics` exists to turn that silence into a
     * report; this is just the component.
     * @param {object} props - slot props.
     * @returns {object} the control element.
     */
    function PromptEnhancerForSlot(props) {
      return react.createElement(PromptEnhancer, props)
    }

    /**
     * Browser notices that are never this plugin's failure.
     *
     * `ResizeObserver loop completed with undelivered notifications` is a benign
     * layout notification Chromium emits when an observer resizes within its own
     * callback; it is extremely common, fires repeatedly, and belongs to whatever
     * element is being measured. Forwarding it made this plugin's log claim a
     * failure it did not have, forty lines at a time — the opposite of a
     * diagnostic. Anything a future session is tempted to add here needs the same
     * proof: that the text cannot originate from this plugin's own code.
     * @type {RegExp[]}
     */
    const BENIGN_BROWSER_NOTICES = [
      /ResizeObserver loop/i,
      /^Script error\.?$/i,
      /Transition was skipped/i,
    ]

    /** Signature of the last reported failure, so a repeat is counted instead of re-logged. */
    let lastFailureSignature = ''
    /** How many times the current signature repeated without a different one in between. */
    let lastFailureRepeats = 0

    /** Matches this plugin's component or file names in a stack or message. */
    const SELF_NAME = /promptenhancer|prompt-enhancer/i

    /**
     * Whether a failure may be ATTRIBUTED to this plugin.
     *
     * The window relay sees EVERYTHING the page throws, so it uses this to decide
     * whether the host should log the failure as `CLIENT FAILURE` (this plugin's
     * activation broke) or as `CLIENT OBSERVED` (forwarded, not blamed).
     *
     * Attribution is claimed only when the text names this plugin. Everything else
     * is forwarded as observed: a failure naming another bundle is clearly not
     * ours, and one naming no bundle cannot be proven to be ours either.
     * Under-claiming is the safe error — a false `CLIENT FAILURE` is what sends
     * someone hunting for a bug in this plugin.
     * @param {string} text - the message, or an `Error.message`.
     * @returns {boolean} true when this plugin is the plausible cause.
     */
    function isLikelyOurs(text) {
      return typeof text === 'string' && text.length > 0 && SELF_NAME.test(text)
    }

    /**
     * Capture render-time failures and send them to the host log.
     *
     * The console hook exists because React reports a render error to the slot's
     * boundary and to `console.error`, and the boundary swallows it into an empty
     * `data-slot-error` div with nothing in any file on disk. The window relay
     * exists because some failures never reach the console at all.
     *
     * Three rules keep this from becoming a noise source:
     *
     *  1. It does not claim another plugin's failures. Both channels pass through
     *     {@link isLikelyOurs} first, so an unrelated crash is not logged as this
     *     plugin's activation failure.
     *  2. It drops benign browser notices rather than logging them.
     *  3. It reports each distinct failure once. Layout-driven errors repeat every
     *     frame; without this, one benign notice became eighty log lines, each a
     *     synchronous disk write, drowning the real signal.
     *
     * Everything it installs is undone by the returned disposer.
     * @returns {(() => void) | undefined} a disposer, or undefined when already installed.
     */
    function installRenderDiagnostics() {
      if (renderDiagnosticsInstalled) return undefined
      renderDiagnosticsInstalled = true

      /** Undo functions, run in reverse on teardown. */
      const undo = []

      try {
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          const relay = (label) => (event) => {
            try {
              const detail = event?.error ?? event?.reason ?? event?.message
              const text = detail instanceof Error ? detail.message : String(detail ?? '')
              if (isBenignBrowserNotice(text)) return
              // A resource-load failure fires with neither error nor message; the
              // old code reported the string "undefined".
              if (text.length === 0) return
              // Keep the diagnostic, drop the blame: a failure naming another
              // bundle is still forwarded, but as OBSERVED rather than FAILURE.
              const ours = isLikelyOurs(text)
              reportClientFailure(
                detail instanceof Error ? detail : new Error(`${label}: ${text}`),
                ours ? 'failed' : 'observed',
              )
            } catch {
              // Diagnostics must never throw.
            }
          }
          const onError = relay('window error')
          const onRejection = relay('unhandled rejection')
          window.addEventListener('error', onError)
          window.addEventListener('unhandledrejection', onRejection)
          undo.push(() => {
            try {
              window.removeEventListener('error', onError)
              window.removeEventListener('unhandledrejection', onRejection)
            } catch {
              // A host without the full window surface cannot hold the listener.
            }
          })
        }
      } catch {
        // A host without the full window surface just gets no relay.
      }

      try {
        const consoleObject = globalThis.console
        const current = consoleObject?.error
        // Idempotent across module instances: every fresh bundle would otherwise
        // wrap the previous bundle's wrapper, stacking hooks until a single
        // log line recurses forever. The marker means a later instance reuses the
        // existing hook instead of adding one, so there is nothing to undo then.
        if (
          consoleObject !== undefined &&
          typeof current === 'function' &&
          current[CONSOLE_HOOK] !== true
        ) {
          const original = current.bind(consoleObject)
          const hooked = (...args) => {
            original(...args)
            if (reportingFailure) return
            reportingFailure = true
            try {
              const first = args[0]
              const text = first instanceof Error ? first.message : args.map((value) => String(value)).join(' ')
              // Skip our own reporting output: without this every entry is
              // logged twice, the second time wrapped in the first's prefix.
              if (text.includes(SELF_REPORT_PREFIX)) return
              if (isBenignBrowserNotice(text)) return
              if (!isLikelyOurs(text)) return
              reportClientFailure(first instanceof Error ? first : new Error(text))
            } catch {
              // Diagnostics must never throw.
            } finally {
              reportingFailure = false
            }
          }
          hooked[CONSOLE_HOOK] = true
          consoleObject.error = hooked
          undo.push(() => {
            try {
              // Only restore if OUR hook is still the current one, so a later
              // instance's hook is not silently discarded.
              if (consoleObject.error === hooked) consoleObject.error = original
            } catch {
              // A frozen console cannot be restored.
            }
          })
        }
      } catch {
        // A frozen console just gets no hook.
      }

      return () => {
        renderDiagnosticsInstalled = false
        for (const step of undo.reverse()) step()
      }
    }

    /**
     * Install the diagnostics once per module instance, handing the teardown to
     * Cordis when possible.
     * @param {object} ctx - client plugin context.
     * @returns {void}
     */
    function installDiagnosticsOnce(ctx) {
      const owned = ownEffect(ctx, installRenderDiagnostics)
      // Without ownership the diagnostics still stand; they simply have no
      // automatic release, exactly like the locale and slot registrations.
      if (!owned) installRenderDiagnostics()
    }

    /**
     * Whether a message is a browser notice this plugin must not claim.
     * @param {string} text - the message.
     * @returns {boolean} true when it should be dropped.
     */
    function isBenignBrowserNotice(text) {
      return BENIGN_BROWSER_NOTICES.some((pattern) => pattern.test(text))
    }

    /**
     * Register the composer control, owned by Cordis.
     *
     * The guard must be released when the registration is disposed. Cordis
     * unloads an entry before re-running its body on an epoch change, so a guard
     * that only latched on would leave the control unregistered forever after
     * the first unload — the button vanishes for the rest of the page's life,
     * with nothing in any log.
     *
     * Ownership is handed to `ctx.effect`, whose returned disposer Cordis runs
     * on teardown. That is the only reliable hook for this: the previous
     * implementation stored a release function that nobody ever called, so the
     * guard became a one-way latch.
     *
     * `slots.inject` runs its callback when the slot's declarer appears, which
     * may be later than this call, so the body tolerates a `register` that has
     * not happened yet and a `register` that throws. Ownership is taken through
     * {@link ownEffect} when the context offers it, and skipped when it does not
     * — never assumed, because assuming it threw `ctx.effect is not a function`.
     * @param {object} ctx - client plugin context.
     * @returns {void}
     */
    function registerControl(ctx) {
      const slots = ctx?.slots
      if (slots === undefined || typeof slots.inject !== 'function') return

      /** Releases the live registration, when there is one. */
      let releaseRegistration = () => {}
      /** Releases the injection subscription, when the service returns one. */
      let releaseInjection = () => {}

      const install = () => {
        /** Whether the slot actually accepted an entry this pass. */
        let accepted = false
        const injected = slots.inject('conversation.input.right', () => {
          try {
            if (typeof slots.register !== 'function') return undefined
            const result = slots.register(
              {
                name: 'conversation.input.right',
                id: 'prompt-enhancer',
                order: 0,
                locale: NS,
              },
              PromptEnhancerForSlot,
            )
            accepted = true
            if (typeof result === 'function') releaseRegistration = result
            return typeof result === 'function' ? result : undefined
          } catch (error) {
            // A failed registration must leave the guard RELEASED, so a later
            // activation pass can try again. Latching on a failure is what made
            // the control permanently absent before.
            accepted = false
            reportClientFailure(error)
            return undefined
          }
        })

        if (typeof injected === 'function') releaseInjection = injected
        // The callback may not have run yet: `slots.inject` waits for the slot's
        // declarer. Record that so the heartbeat can say "pending" rather than
        // implying the button was lost.
        controlPending = accepted === false

        // The guard means "an accepted registration is live". It is set only
        // after the slot accepted an entry — never merely because this ran, and
        // never after a throw.
        if (accepted) {
          controlPending = false
          controlRegistered = () => {
            controlRegistered = null
            controlPending = false
            try {
              releaseRegistration()
            } catch (error) {
              reportClientFailure(error)
            }
          }
        }

        return () => {
          controlRegistered = null
          controlPending = false
          try {
            releaseRegistration()
          } catch {
            // A failing remover must not break teardown.
          }
          try {
            releaseInjection()
          } catch {
            // Same for the subscription.
          }
        }
      }

      // Cordis owns the teardown when it can; without `effect` the registration
      // still stands, it simply has no automatic release.
      const owned = ownEffect(ctx, install)
      if (!owned) install()
    }

    /**
     * Send one client-side event to the host half so it lands in the boot log.
     *
     * Fire-and-forget: diagnostics must never become a failure path.
     * @param {'applied' | 'failed'} phase - what happened.
     * @param {object} detail - JSON-serializable detail.
     * @returns {void}
     */
    function reportClientEvent(phase, detail) {
      try {
        void fetch(`${ROUTE}/client-error`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phase, ...detail }),
        }).catch(() => {})
      } catch {
        // Ignore: the console line beside this is enough.
      }
    }

    /**
     * Report one client-side registration failure without letting it escape.
     *
     * Report one client-side failure without letting it escape.
     *
     * Always logs to the browser console (the desktop app records renderer
     * errors in its crash log), and posts to the host half so the failure also
     * lands in `~/.dsh/prompt-enhancer-boot.log`. The post is deliberately
     * fire-and-forget: diagnostics must never create a new failure path.
     *
     * A repeated identical failure is counted rather than logged again. Without
     * that, an error raised on every frame turned into one synchronous disk
     * write per frame; the real signal disappears in the flood.
     * @param {unknown} error - the caught error.
     * @param {'failed' | 'observed'} [phase] - `failed` claims this plugin's own
     *   activation broke; `observed` forwards something we cannot attribute to
     *   ourselves, so the host log does not blame this plugin for it. Defaults to
     *   `failed`, which is what every internal call site wants.
     * @returns {void}
     */
    function reportClientFailure(error, phase = 'failed') {
      const message = error instanceof Error ? error.message : String(error)
      const stack = error instanceof Error ? error.stack : undefined

      const signature = `${message}\u0000${stack ?? ''}`
      if (signature === lastFailureSignature) {
        lastFailureRepeats += 1
        // Only every 50th repeat is written, so a persistent error stays visible
        // without saturating the log.
        if (lastFailureRepeats % 50 !== 0) return
      } else {
        lastFailureSignature = signature
        lastFailureRepeats = 1
      }

      const repeatNote = lastFailureRepeats > 1 ? ` (repeated x${String(lastFailureRepeats)})` : ''
      reportingFailure = true
      try {
        console.error(`${SELF_REPORT_PREFIX} client failure: ${message}${repeatNote}`, error)
      } catch {
        // A console that throws must not matter either.
      } finally {
        reportingFailure = false
      }
      reportClientEvent(phase, {
        message: `${message}${repeatNote}`,
        stack,
      })
    }

    exports.apply = apply
    // Derived, never duplicated: the heartbeat may only report services this
    // exact list declares.
    exports.inject = [...INJECTED_SERVICES]
    exports.PromptEnhancer = PromptEnhancer
    exports.PromptEnhancerView = PromptEnhancerView
    exports.useComposerInput = useComposerInput
    exports.PromptEnhancerForSlot = PromptEnhancerForSlot
    exports.installRenderDiagnostics = installRenderDiagnostics
    exports.isBenignBrowserNotice = isBenignBrowserNotice
    exports.reportClientFailure = reportClientFailure
    exports.NO_INPUT_SNAPSHOT = NO_INPUT_SNAPSHOT
    exports.STYLE_ORDER = STYLE_ORDER
    exports.STYLE_WITH_ADDENDUM = STYLE_WITH_ADDENDUM
    exports.FALLBACK_MAX_DRAFT_CHARS = FALLBACK_MAX_DRAFT_CHARS
    exports.dictionaries = { zh, en }
    return module.exports
  },
})
