/**
 * End-to-end probe of the live enhance flow.
 *
 * Drives the route the browser half calls, exactly as the control does, and
 * prints what came back. Run while DSH is up:
 *
 *   node test/e2e-probe.mjs
 */
const PORT = Number(process.env.DSH_PORT ?? 19387)
const ROUTE = `http://127.0.0.1:${PORT}/plugins/dsh-prompt-enhancer`

async function post(draft, style) {
  const started = Date.now()
  const response = await fetch(`${ROUTE}/enhance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ draft, style }),
  })
  const elapsed = Date.now() - started
  let body
  try {
    body = await response.json()
  } catch (error) {
    body = { parseError: String(error) }
  }
  return { status: response.status, elapsed, body }
}

const cases = [
  { label: 'Chinese draft, default style', draft: '帮我看看这段代码有什么问题', style: 'default' },
  { label: 'Chinese draft, structured', draft: '写一个爬虫脚本', style: 'structured' },
  { label: 'English draft', draft: 'write a crawler script', style: 'default' },
  { label: 'empty draft (must refuse, no model call)', draft: '', style: 'default' },
  { label: 'whitespace-only draft', draft: '   \n  ', style: 'default' },
  { label: 'unknown style falls back to default', draft: '总结这篇文章', style: 'nonsense' },
  { label: 'very long draft (4000-char cap)', draft: '请帮我优化这段需求描述。'.repeat(400), style: 'default' },
  { label: 'braces and template syntax', draft: 'use {input} and ${var} literally', style: 'default' },
  { label: 'emoji and mixed language', draft: '把这个 🚀 deploy 流程写清楚', style: 'default' },
]

for (const item of cases) {
  try {
    const { status, elapsed, body } = await post(item.draft, item.style)
    const text = typeof body?.text === 'string' ? body.text : ''
    console.log('---')
    console.log(`case      : ${item.label}`)
    console.log(`status    : ${status}  (${elapsed} ms)`)
    console.log(`ok        : ${String(body?.ok)}`)
    if (body?.error !== undefined) console.log(`error     : ${String(body.error)}`)
    if (text.length > 0) {
      console.log(`chars     : ${text.length}`)
      console.log(`text      : ${text.slice(0, 220).replace(/\n/gu, ' / ')}`)
      if (text.length > 220) console.log(`            …(+${text.length - 220} more)`)
    }
  } catch (error) {
    console.log('---')
    console.log(`case      : ${item.label}`)
    console.log(`TRANSPORT FAILURE: ${String(error?.message ?? error)}`)
  }
}
