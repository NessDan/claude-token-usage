// Summarizes one session transcript for the usage-meter mod, which can only
// read files up to 4 MiB itself. Prints the session's MeterView as JSON.
//
//   node summarize.ts <session.jsonl> [--ttl 1h|5m]
//
// Needs Node 22.18+ (runs TypeScript directly).

import { loadSession } from '../cli/sessions.ts'
import { buildTranscriptView } from '../lib/view.ts'

const args = process.argv.slice(2)
const path = args.find(a => !a.startsWith('--'))
const ttlArg = args[args.indexOf('--ttl') + 1]
const ttl = ttlArg === '5m' ? '5m' : '1h'

if (!path) {
  process.stderr.write('usage: node summarize.ts <session.jsonl> [--ttl 1h|5m]\n')
  process.exit(2)
}

try {
  const { file, parsed } = loadSession(path)
  // The file's own session id: a fork's copied history stays out of its spend.
  process.stdout.write(JSON.stringify(buildTranscriptView(parsed, ttl, Date.now(), file.id)))
} catch (err) {
  process.stderr.write(`summarize: ${(err as Error).message}\n`)
  process.exit(1)
}
