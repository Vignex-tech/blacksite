// Runs one CI shard of the e2e suite (#65). Shards are separate CI jobs, each
// with its own server, so the browser specs that share one room (my_room) no
// longer have to run one after another on the same machine.
//   integration : every *.integration.spec.ts (SDK clients, 4 workers)
//   browser-a   : the browser specs listed in BROWSER_A below
//   browser-b   : every other browser spec, so a new spec lands here by default
// Usage: node scripts/e2e-shard.mjs <shard> [extra playwright args]
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const specs = readdirSync(path.join(here, '..', 'e2e')).filter((f) => f.endsWith('.spec.ts'))

// About 100 s of serial browser time each; see the budget in playwright.config.ts.
const BROWSER_A = ['m6-gate', 'm4-gate', 'hack.tabs', 'm5-gate', 'facing', 'two-players', 'client-loads', 'server']
const isA = (f) => BROWSER_A.some((n) => f === `${n}.spec.ts`)

export const shards = {
  integration: specs.filter((f) => f.endsWith('.integration.spec.ts')),
  'browser-a': specs.filter((f) => !f.endsWith('.integration.spec.ts') && isA(f)),
  'browser-b': specs.filter((f) => !f.endsWith('.integration.spec.ts') && !isA(f)),
}

const name = process.argv[2]
if (!shards[name]) {
  console.error(`unknown shard "${name}"; use one of: ${Object.keys(shards).join(', ')}`)
  process.exit(2)
}
const project = name === 'integration' ? 'server-integration' : 'chromium'
// --no-deps: the chromium project only depends on server-integration to keep
// the two apart inside one machine; a shard runs on its own server.
const files = shards[name].map((f) => `e2e/${f.replace(/[.]/g, '[.]')}$`)
const args = ['playwright', 'test', `--project=${project}`, '--no-deps', ...files, ...process.argv.slice(3)]
const r = spawnSync('npx', args, { stdio: 'inherit', shell: true })
process.exit(r.status ?? 1)
