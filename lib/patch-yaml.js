/**
 * A tiny YAML subset parser, sufficient for profile patch layers.
 *
 * The patch format is a top-level list whose items have one key (`insert`,
 * `insert-before`, `insert-after`, `id`, `config`, `disabled`, `name`). Rather
 * than pull in a dependency, this parser implements the block-sequence and
 * block-mapping forms with scalar tags (`true`, `false`, `null`, numbers,
 * quoted and plain strings).
 *
 * It intentionally rejects anything it does not understand instead of guessing,
 * so a malformed patch fails loudly at pre-flight rather than silently at boot.
 */

/**
 * Parse a patch list.
 * @param {string} text - YAML document.
 * @returns {object[]} the parsed top-level list.
 */
export function parsePatchList(text) {
  const lines = []
  for (const raw of text.split(/\r?\n/u)) {
    const withoutComment = stripComment(raw)
    if (withoutComment.trim() === '') continue
    lines.push({ indent: withoutComment.length - withoutComment.trimStart().length, text: withoutComment.trim() })
  }
  const [value, next] = parseBlock(lines, 0, lines.length > 0 ? lines[0].indent : 0)
  if (next !== lines.length) throw new Error(`parsePatchList: unexpected content at line index ${next}`)
  if (!Array.isArray(value)) throw new Error('parsePatchList: the document root must be a list')
  return value
}

/**
 * Remove a trailing comment, respecting quotes.
 * @param {string} line - raw line.
 * @returns {string} the line without its comment.
 */
function stripComment(line) {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/u.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

/**
 * Parse one scalar token.
 * @param {string} token - raw scalar text.
 * @returns {unknown} the typed value.
 */
function parseScalar(token) {
  const text = token.trim()
  if (text === '' || text === '~' || text === 'null') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+$/u.test(text)) return Number.parseInt(text, 10)
  if (/^-?\d+\.\d+$/u.test(text)) return Number.parseFloat(text)
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * Parse a block starting at `start` with the given indentation.
 * @param {Array<{indent: number, text: string}>} lines - significant lines.
 * @param {number} start - first line index.
 * @param {number} indent - block indentation.
 * @returns {[unknown, number]} the parsed value and the next line index.
 */
function parseBlock(lines, start, indent) {
  if (start >= lines.length) return [null, start]
  if (lines[start].text.startsWith('- ') || lines[start].text === '-') return parseSequence(lines, start, indent)
  return parseMapping(lines, start, indent)
}

/**
 * Parse a block sequence.
 * @param {Array<{indent: number, text: string}>} lines - significant lines.
 * @param {number} start - first line index.
 * @param {number} indent - block indentation.
 * @returns {[unknown[], number]} the sequence and the next line index.
 */
function parseSequence(lines, start, indent) {
  const out = []
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line.indent !== indent || !(line.text.startsWith('- ') || line.text === '-')) break
    const rest = line.text === '-' ? '' : line.text.slice(2).trim()
    if (rest === '') {
      index += 1
      const [child, next] = parseBlock(lines, index, lines[index]?.indent ?? indent + 2)
      out.push(child)
      index = next
      continue
    }
    const inline = /^([A-Za-z0-9_.-]+):\s*(.*)$/u.exec(rest)
    if (inline !== null) {
      // A mapping that starts on the dash line.
      const item = {}
      const key = inline[1]
      const valueText = inline[2].trim()
      index += 1
      if (valueText === '') {
        const childIndent = index < lines.length ? lines[index].indent : indent + 2
        const [child, next] = parseBlock(lines, index, childIndent)
        item[key] = child
        index = next
      } else {
        item[key] = parseScalar(valueText)
      }
      // Continue the same mapping for the following, more-indented keys.
      //
      // A bare `-` must be excluded here as well as `- `. `parseMapping` breaks on
      // both, and on an exclusive `- ` test the loop asked it to parse a line it
      // refuses to consume: the index never advanced and the process spun at 100%
      // CPU forever. The `next <= index` guard below makes any future variant of
      // that mistake an error instead of a hang.
      const continuationIndent = indent + 2
      while (index < lines.length && lines[index].indent === continuationIndent && !isDashLine(lines[index].text)) {
        const [more, next] = parseMapping(lines, index, continuationIndent)
        if (next <= index) {
          throw new Error(`parsePatchList: no progress while parsing a continuation at line ${String(index + 1)}`)
        }
        Object.assign(item, more)
        index = next
      }
      out.push(item)
      continue
    }
    out.push(parseScalar(rest))
    index += 1
  }
  return [out, index]
}

/**
 * Whether a line begins a sequence item.
 *
 * Covers both `- value` and a bare `-`, which YAML allows as an empty item.
 * @param {string} text - trimmed line text.
 * @returns {boolean} true when the line starts a sequence entry.
 */
function isDashLine(text) {
  return text === '-' || text.startsWith('- ')
}

/**
 * Parse a block mapping.
 * @param {Array<{indent: number, text: string}>} lines - significant lines.
 * @param {number} start - first line index.
 * @param {number} indent - block indentation.
 * @returns {[object, number]} the mapping and the next line index.
 */
function parseMapping(lines, start, indent) {
  const out = {}
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line.indent !== indent) break
    if (isDashLine(line.text)) break
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/u.exec(line.text)
    if (match === null) throw new Error(`parsePatchList: cannot parse mapping line ${JSON.stringify(line.text)}`)
    const key = match[1]
    const valueText = match[2].trim()
    index += 1
    if (valueText === '') {
      const childIndent = index < lines.length ? lines[index].indent : indent + 2
      if (index >= lines.length || childIndent <= indent) {
        out[key] = null
        continue
      }
      const [child, next] = parseBlock(lines, index, childIndent)
      out[key] = child
      index = next
      continue
    }
    out[key] = parseScalar(valueText)
  }
  return [out, index]
}
