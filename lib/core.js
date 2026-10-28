/**
 * Prompt-enhancement engine: the pure, dependency-free half of the plugin.
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested without Cordis, an HTTP server, or a model. The host half owns the
 * model call; the browser half owns the button.
 *
 * The prompt structure mirrors the proven two-layer design of the original
 * WorkBuddy feature: the role, analysis process, principles and constraints
 * live in the SYSTEM message, while the USER message carries a short task line
 * plus the draft. The original keeps the same redundancy on purpose — a single
 * layer drifts on long inputs.
 */

/** Available enhancement styles, in menu order. `default` is the neutral rewrite. */
export const STYLES = ['default', 'structured', 'concise', 'expand']

/** Style used when the caller names none. */
export const DEFAULT_STYLE = 'default'

/** Hard cap for one enhancement request body, guarding the HTTP route. */
export const MAX_REQUEST_BYTES = 65536

/**
 * Hard cap for one draft's length, in characters.
 *
 * "Character" means a Unicode code point, not a UTF-16 unit — see
 * {@link draftLength}. The user-facing message names the same unit, so the
 * number a user counts in their draft is the number the cap enforces.
 */
export const MAX_DRAFT_CHARS = 4000

/**
 * Count a draft's characters.
 *
 * `String.prototype.length` counts UTF-16 code units, so one emoji counts as two.
 * With a 4000 limit that refused a 2001-character emoji draft while reporting
 * "over 4000 characters" — a number the user cannot see. Iterating code points
 * makes the cap mean what the message says.
 * @param {string} draft - the draft to measure.
 * @returns {number} the number of Unicode code points.
 */
export function draftLength(draft) {
  if (typeof draft !== 'string') return 0
  let count = 0
  for (const _ of draft) count += 1
  return count
}

/** Soft cap for the rewrite's length, in characters (the prompt asks for this). */
export const TARGET_CHAR_LIMIT = 800

/**
 * Hard backstop for the rewrite's length, in characters.
 *
 * The prompt asks for ~{@link TARGET_CHAR_LIMIT}; a model that ignores it is
 * clamped at the nearest sentence boundary well above that, so a normal result
 * is never touched while a runaway one cannot land in the composer.
 */
export const OUTPUT_CHAR_LIMIT = 1200

/** Request temperature: rewriting is deterministic work, so run it cold. */
export const TEMPERATURE = 0

/** Hard cap for the model output length, in tokens. */
export const MAX_OUTPUT_TOKENS = 1024

/**
 * Model-facing system prompt.
 *
 * Carries the role, the internal analysis process, the enhancement principles,
 * the constraints, and few-shot examples. The analysis process is explicitly
 * marked "never output" so the model reasons silently.
 */
export const SYSTEM_PROMPT = [
  'You are a Prompt Engineering Expert. When given a user prompt, analyze and enhance it into a',
  'clearer, more specific, and more effective version while strictly maintaining its core purpose.',
  'The enhanced prompt will be sent to a general-purpose AI assistant.',
  '',
  'ANALYSIS PROCESS (internal, never output):',
  '1. Identify the main objective of the original prompt.',
  '2. Note ambiguities, gaps, and missing context.',
  '3. Assess the clarity of instructions.',
  '',
  'ENHANCEMENT PRINCIPLES:',
  '- Write clear, specific instructions; include necessary context.',
  '- Set explicit parameters, constraints, and expected output format.',
  '- Match tone and complexity to the use case; remove redundant information.',
  '- Be realistic: do NOT invent requirements, facts, or technologies the user did not mention.',
  "- Do NOT answer the user's question - only expand/rewrite it.",
  '- Do NOT explain HOW to do things; focus on WHAT is needed.',
  '- Do NOT request guides, how-tos, or code snippets unless the user asked for them.',
  '',
  'IMPORTANT CONSTRAINTS:',
  '1. Language matching is the highest priority. You MUST respond in the exact same language as the',
  "   user's input. Chinese in -> Chinese out; English in -> English out; other languages likewise.",
  '   If the input mixes languages, keep a natural matching mix - do not unify into one language.',
  '   Never include language analysis or language labels in the output.',
  `2. Keep the enhanced prompt concise - around ${String(TARGET_CHAR_LIMIT)} characters maximum.`,
  '3. Output only the enhanced prompt text: no commentary, no preface, no markdown fences, no labels.',
  '',
  'EXAMPLES:',
  'Input:  "帮我看看这段代码"',
  'Output: "请分析这段代码的主要功能、执行流程和关键逻辑，指出潜在的边界情况与可优化点，并给出简要说明。"',
  '',
  'Input:  "这段代码有 bug，can you help me fix it?"',
  'Output: "请分析这段代码中的 bug，explain the root cause, and provide a minimal fix together with verification steps."',
].join('\n')

/**
 * User-message template. `{input}` is replaced with the draft by
 * {@link buildUserContent}; this text never contains user data.
 *
 * Kept deliberately short: the rules live in the system message, and repeating
 * the whole rule set here would crowd out the draft.
 */
export const USER_TEMPLATE = [
  'Rewrite the following user input into a clearer, more specific prompt.',
  'Follow all rules from the system message. Return only the rewritten prompt text.',
  '',
  'USER INPUT:',
  '{input}',
].join('\n')

/**
 * Extra instruction appended per non-default style.
 *
 * Every non-default style must actually change something. `expand` used to be an
 * empty string, so the menu's fourth item produced byte-identical requests to
 * `default` — a control that silently did nothing.
 *
 * `structured` deliberately does NOT name literal headings: the previous wording
 * gave Chinese labels and simultaneously asked for the draft's own language, so
 * an English draft got a contradictory instruction.
 * @type {Record<string, string>}
 */
export const STYLE_ADDENDUM = {
  structured:
    'Additionally: organize the rewrite under four short headings — the goal, the deliverable(s), the ' +
    'constraints, and how the result will be judged acceptable. Write the headings and the body in the ' +
    'draft\'s own language.',
  concise:
    'Additionally: compress aggressively. Keep the request complete but drop every sentence that does not ' +
    'change what the assistant must do.',
  expand:
    'Additionally: make implicit requirements explicit. Where the draft leaves a decision open — scope, ' +
    'format, constraints, what is out of scope — state the assumption you are making instead of leaving it ' +
    'unstated. Do not add requirements the draft does not imply.',
}

/**
 * Normalize a requested style id.
 * @param {unknown} value - candidate style id.
 * @returns {string} a member of {@link STYLES}.
 */
export function normalizeStyle(value) {
  return typeof value === 'string' && STYLES.includes(value) ? value : DEFAULT_STYLE
}

/**
 * Build the user-message text: the task line, the optional style addendum, and
 * the draft.
 *
 * The draft is spliced in with a REPLACER FUNCTION, never as a string. In a
 * string replacement JavaScript treats `$` as an escape: `$&` inserts the matched
 * `{input}`, a backtick-quoted `$` inserts everything before the match, `$'`
 * inserts everything after it, and `$$` collapses to one `$`. A draft containing
 * shell syntax is exactly this feature's target input, so `a$&b` used to reach
 * the model as `a{input}b` and `cost $$5` as `cost $5`. A function replacer
 * disables every `$` pattern.
 * @param {string} draft - the user's raw draft.
 * @param {string} [style] - normalized style id.
 * @returns {string} the complete user message content.
 */
export function buildUserContent(draft, style = DEFAULT_STYLE) {
  const parts = [USER_TEMPLATE.replace('{input}', () => String(draft))]
  const addendum = STYLE_ADDENDUM[normalizeStyle(style)]
  if (typeof addendum === 'string' && addendum.length > 0) parts.push('', addendum)
  return parts.join('\n')
}

/**
 * Create a message identity.
 *
 * The harness brands message ids as opaque strings; a UUID is sufficient and
 * keeps this module free of harness imports.
 * @returns {string} a fresh id.
 */
function newMessageId() {
  const c = globalThis.crypto
  if (c !== undefined && typeof c.randomUUID === 'function') return c.randomUUID()
  return `pe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Build the complete `llm.stream` request for one enhancement.
 * @param {object} input - request inputs.
 * @param {string} input.draft - the user's raw draft.
 * @param {string} [input.style] - requested style id.
 * @param {string} input.provider - provider route.
 * @param {string} input.model - exact model id.
 * @param {AbortSignal} [input.signal] - cancellation signal.
 * @returns {object} the options object for `ctx.llm.stream`.
 */
export function buildRequest({ draft, style, provider, model, signal }) {
  return {
    provider,
    model,
    // Cold sampling keeps the same draft producing the same rewrite.
    temperature: TEMPERATURE,
    maxTokens: MAX_OUTPUT_TOKENS,
    ...(signal === undefined ? {} : { signal }),
    messages: [
      {
        id: newMessageId(),
        role: 'system',
        content: [{ type: 'text', text: SYSTEM_PROMPT }],
        source: { kind: 'system-prompt' },
      },
      {
        id: newMessageId(),
        role: 'user',
        content: [{ type: 'text', text: buildUserContent(draft, style) }],
        source: { kind: 'draft' },
      },
    ],
  }
}

/**
 * Extract the text carried by chunks produced by {@link buildRequest}'s stream.
 *
 * Only visible assistant text counts: reasoning deltas and tool-call deltas are
 * ignored.
 *
 * A terminal reason is not automatically a failure:
 *
 *  - `max-tokens` means the model was CUT OFF, not that it failed. The text it
 *    did produce is usable, so it is returned and flagged `truncated` for the
 *    caller to clamp. Treating it as a failure discarded a good answer at
 *    exactly the moment the length backstop exists for — the token budget is
 *    tight enough for CJK that this is a normal outcome, not an edge case.
 *  - `aborted` and `error` mean no usable answer arrived; their text is dropped.
 *  - A missing or malformed terminal reason is ignored rather than dereferenced:
 *    `{ type: 'finish', reason: null }` used to throw a TypeError here.
 *
 * @param {Iterable<object>} chunks - stream chunks.
 * @returns {{ text: string, failure: object | undefined, truncated: boolean }} collected text, the first real failure, and whether the model was cut off.
 */
export function collectAssistantText(chunks) {
  let text = ''
  let truncated = false
  for (const chunk of chunks) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
      continue
    }
    if (chunk.type !== 'finish') continue

    const reason = chunk.reason
    // A malformed terminal chunk is not a failure; the text collected so far is
    // still the answer. It must not be dereferenced.
    if (reason === null || typeof reason !== 'object') continue
    const kind = reason.kind
    if (kind === undefined || kind === 'stop') continue
    if (kind === 'max-tokens') {
      truncated = true
      continue
    }
    // aborted / error / anything unrecognised carries no usable answer.
    return { text, failure: reason, truncated }
  }
  return { text, failure: undefined, truncated }
}

/**
 * Characters that always end a sentence, across scripts.
 *
 * ASCII `.`, `;` and `?` are handled separately because they also appear inside
 * tokens — `Node.js`, `test/core.test.mjs`, `https://example.com/a?b=1` — where
 * stopping would cut the answer mid-URL.
 * @type {string}
 */
const ALWAYS_SENTENCE_END = '。！？；\n！？'

/**
 * Whether the character at `index` ends a sentence.
 *
 * An ASCII `.`, `;` or `?` only ends a sentence when whitespace or the end of
 * the text follows it.
 * @param {string} text - candidate text.
 * @param {number} index - index of the character.
 * @returns {boolean} true when a sentence ends here.
 */
function endsSentence(text, index) {
  const char = text[index]
  if (char === undefined) return false
  if (ALWAYS_SENTENCE_END.includes(char)) return true
  if (char !== '.' && char !== ';' && char !== '?') return false
  const next = text[index + 1]
  return next === undefined || next === ' ' || next === '\t' || next === '\n' || next === '\r'
}

/** A line that opens or closes a fenced code block. */
const FENCE = /^\s*(?:```|~~~)/u

/**
 * Index of the last fence opener with no matching closer before `end`, or -1.
 *
 * A clamp must not cut inside a fence: half a code block is worse than a shorter
 * answer, and the trailing fence would be left dangling.
 * @param {string} text - candidate text.
 * @param {number} end - exclusive upper bound to consider.
 * @returns {number} the index of the opener, or -1 when `end` is outside a fence.
 */
function unclosedFenceStart(text, end) {
  let open = -1
  let lineStart = 0
  while (lineStart < end) {
    const lineEnd = text.indexOf('\n', lineStart)
    const stop = lineEnd === -1 || lineEnd >= end ? end : lineEnd
    if (FENCE.test(text.slice(lineStart, stop))) open = open === -1 ? lineStart : -1
    if (lineEnd === -1 || lineEnd >= end) break
    lineStart = lineEnd + 1
  }
  return open
}

/**
 * Move `index` so it never splits a surrogate pair.
 *
 * `slice` counts UTF-16 units, so cutting between the halves of an emoji leaves a
 * lone surrogate — invalid text that renders as a replacement glyph.
 * @param {string} text - candidate text.
 * @param {number} index - proposed cut boundary.
 * @returns {number} a boundary on a code-point edge.
 */
function safeBoundary(text, index) {
  if (index <= 0) return 0
  const code = text.charCodeAt(index - 1)
  const isHighSurrogate = code >= 0xd800 && code <= 0xdbff
  return isHighSurrogate ? index - 1 : index
}

/**
 * Trim a runaway rewrite to the last sentence boundary before `limit`.
 *
 * Only used as a backstop: a result within the limit is returned untouched, so
 * the common case never notices.
 *
 * Three rules keep the clamp from producing something worse than the overflow:
 *  - it never cuts inside a fenced code block;
 *  - it never lands between a surrogate pair;
 *  - it refuses a boundary so early that the result would be nearly empty, and
 *    falls back to the longest safe prefix instead. A boundary at 3 characters
 *    for a 1200-character answer is a failure, not a truncation.
 *
 * @param {string} text - candidate text.
 * @param {number} [limit] - maximum length.
 * @returns {string} the text, clamped when it exceeded the limit.
 */
export function clampToSentence(text, limit = OUTPUT_CHAR_LIMIT) {
  if (text.length <= limit) return text

  const ceiling = safeBoundary(text, Math.min(limit, text.length))
  const hardCut = () => text.slice(0, ceiling).trimEnd()

  const fenceStart = unclosedFenceStart(text, ceiling)
  if (fenceStart >= 0) {
    const beforeFence = text.slice(0, safeBoundary(text, fenceStart)).trimEnd()
    // Break before the fence whenever there is real content to keep: a clean
    // break at 400 characters beats 1200 characters that end mid-statement
    // inside an unterminated code block. Only an empty prefix falls through.
    return beforeFence.length > 0 ? beforeFence : hardCut()
  }

  let cut = -1
  for (let i = ceiling - 1; i >= 0; i -= 1) {
    if (endsSentence(text, i)) {
      cut = i
      break
    }
  }
  if (cut < 0) return hardCut()

  const boundary = safeBoundary(text, cut + 1)
  const clamped = text.slice(0, boundary).trimEnd()
  // A boundary this early discards almost everything; the hard cut is closer to
  // the requested length and still valid.
  return clamped.length >= ceiling / 2 ? clamped : hardCut()
}

/**
 * Labelling prefixes a model may add despite rule 3.
 *
 * `Input:` and `Output:` are included deliberately: the few-shot block in
 * SYSTEM_PROMPT is written in exactly that shape, so a model imitating the
 * examples will copy `Output:` back — contradicting the "no labels" rule this
 * stripper exists to enforce. Both `Here is` and `Here's` spellings are matched.
 *
 * Three properties this pattern must keep, each learned from a bug:
 *
 *  1. Every internal gap is `[ \t]*`, never `\s*`. A newline-crossing gap let a
 *     trailing decoration group swallow the FIRST character of the next line, so
 *     `增强后：\n```\nX` lost a backtick and left a broken fence. A label and its
 *     separator share a line; nothing here may reach past it.
 *  2. Decoration AFTER the separator is never consumed. Doing so removed only the
 *     opener of a balanced pair and orphaned the closer: `增强后：**请写一个爬虫**`
 *     came back as `请写一个爬虫**`.
 *  3. Decoration WRAPPING the label is matched as a pair through a backreference,
 *     so both markers go together: `**Output:**` loses both asterisks. Matching
 *     the opener and closer independently cannot do that — the closer is optional
 *     and the engine may treat one `*` of `**` as the closer.
 *
 * @type {RegExp}
 */
const LABEL_PREFIX =
  /^[ \t]*(?:[-*•][ \t]*)?(?:(\*\*|__|`)[ \t]*)?(?:Here(?:\s+is|(?:'|’)s)\s+the\s+enhanced\s+prompt|增强后的?提示词|增强后|增强结果|优化后的?提示词|优化后|优化结果|改写后的?提示词|改写后|改写结果|重写后|改进后|已增强|Output|Input|Enhanced(?:\s+prompt)?|Rewritten(?:\s+prompt)?|Improved(?:\s+prompt)?|Optimized(?:\s+prompt)?|Refined(?:\s+prompt)?|Prompt)\1?[ \t]*[:：\-—]\1?[ \t]*/iu

/**
 * Strip a labelling prefix a model may add despite rule 3.
 *
 * Only a leading label followed by a separator is removed, so a rewrite that
 * legitimately starts with the same word but continues without one is left
 * alone. Applied up to twice, because models stack labels
 * (`增强后：增强后：x`) and one pass left the inner one behind.
 * @param {string} text - candidate text.
 * @returns {string} the text without a leading label.
 */
export function stripLabelPrefix(text) {
  let out = text
  for (let pass = 0; pass < 2; pass += 1) {
    const next = out.replace(LABEL_PREFIX, '')
    if (next === out) break
    out = next
  }
  return out
}

/**
 * Remove a pair of wrapping quotes, or a lone quote on one side.
 *
 * Asymmetric stripping damaged real content: `请实现 "parse" 函数` ends with a
 * quote that belongs to the text, and removing only that one left the quotes
 * unbalanced. A pair is removed together; a single stray quote is removed only
 * when the other side has none, which is the "model quoted the whole answer"
 * case.
 * @param {string} text - candidate text.
 * @returns {string} the text without unbalanced wrapping quotes.
 */
function stripWrappingQuotes(text) {
  const QUOTES = '"\'“”‘’'
  const first = text[0]
  const last = text[text.length - 1]
  if (first === undefined) return text

  const firstIsQuote = QUOTES.includes(first)
  const lastIsQuote = last !== undefined && QUOTES.includes(last)

  if (firstIsQuote && lastIsQuote && text.length > 1) return text.slice(1, -1).trim()
  if (firstIsQuote && !lastIsQuote) {
    // Only strip a lone leading quote when no other quote follows, so a genuinely
    // quoted phrase keeps its opening mark.
    return text.slice(1).includes(first) ? text.trim() : text.slice(1).trim()
  }
  if (lastIsQuote && !firstIsQuote) {
    return text.slice(0, -1).includes(last) ? text.trim() : text.slice(0, -1).trim()
  }
  return text.trim()
}

/**
 * Clean one model result.
 *
 * Order matters and mirrors the original feature: trim, drop wrapping quotes
 * (the few-shot examples are quoted, so a model tends to quote back), strip a
 * single wrapping code fence, strip a labelling prefix, then clamp a runaway
 * result to a sentence boundary.
 * @param {string} value - raw model output.
 * @returns {string} the cleaned prompt text.
 */
export function cleanResult(value) {
  let text = String(value).trim()

  text = stripWrappingQuotes(text)

  // A single wrapping code fence added despite rule 3.
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/
  const fenced = fence.exec(text)
  if (fenced !== null) text = fenced[1].trim()

  // A leading "enhanced:" style label.
  text = stripLabelPrefix(text).trim()

  return clampToSentence(text)
}

/**
 * Describes why one enhancement request cannot be served.
 * @param {object} input - resolution inputs.
 * @param {string} [input.draft] - the requested draft.
 * @param {boolean} input.llmAvailable - whether an `llm` service is mounted.
 * @param {string} [input.provider] - resolved provider route.
 * @param {string} [input.model] - resolved model id.
 * @returns {string | undefined} a user-facing reason, or undefined when servable.
 */
export function denialReason({ draft, llmAvailable, provider, model }) {
  if (typeof draft !== 'string' || draft.trim().length === 0) return '草稿为空，没有需要增强的内容。'
  if (draftLength(draft) > MAX_DRAFT_CHARS) return `草稿过长（上限 ${MAX_DRAFT_CHARS} 字符）。`
  if (!llmAvailable) return '宿主未提供 llm 服务，无法调用模型。'
  if (typeof provider !== 'string' || provider.length === 0) {
    return '未解析到 provider：请在插件 config 里显式配置 provider/model。'
  }
  if (typeof model !== 'string' || model.length === 0) {
    return '未解析到 model：请在插件 config 里显式配置 provider/model。'
  }
  return undefined
}
