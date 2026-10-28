/**
 * Run every test suite in one process and report a single verdict.
 *
 * Run: node test/run-all.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const suites = [
  'core.test.mjs',
  'client.test.mjs',
  'host.test.mjs',
  'cordis.test.mjs',
  'cordis-client.test.mjs',
  'profile.test.mjs',
]

// Keep the suites' activation logging out of the real boot log. A log mixed
// with test noise cannot answer "did the app start cleanly?".
const logDir = mkdtempSync(join(tmpdir(), 'dsh-prompt-enhancer-tests-'))
const env = { ...process.env, DSH_PROMPT_ENHANCER_LOG: join(logDir, 'boot.log') }

let failed = 0
for (const suite of suites) {
  const result = spawnSync(process.execPath, [join(here, suite)], { encoding: 'utf8', env })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const summary = output
    .split('\n')
    .filter((line) => line.includes('passed,'))
    .pop()
  console.log(`### ${suite}`)
  if (summary !== undefined) console.log(`    ${summary.trim()}`)
  if (result.status !== 0) {
    failed += 1
    console.log(output.split('\n').filter((line) => line.includes('FAIL')).join('\n'))
    console.log(`    exit code: ${result.status}`)
  }
}

console.log(`\n(test activation log: ${join(logDir, 'boot.log')})`)
console.log(failed === 0 ? 'ALL SUITES PASSED' : `${failed} SUITE(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
