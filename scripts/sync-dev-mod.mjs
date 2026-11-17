// Copies plugins/usage-meter into a Claude Code session's mods folder, which
// that session hot-reloads when its turn ends.
//
//   node scripts/sync-dev-mod.mjs <mods folder>
//   e.g. node scripts/sync-dev-mod.mjs %USERPROFILE%\.claude\dev-mods\<session-id>
//
// The engine writes .claude-plugin/types/ into the copy itself; it is left alone.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '..', 'plugins', 'usage-meter')
const target = process.argv[2]
if (!target) {
  console.error('usage: node scripts/sync-dev-mod.mjs <mods folder>')
  process.exit(2)
}
const dest = join(resolve(target), 'usage-meter')
const skip = (rel) => rel === join('.claude-plugin', 'types') || rel.startsWith(join('.claude-plugin', 'types') + sep) || rel.split(sep).includes('node_modules')

mkdirSync(dest, { recursive: true })
// Remove files the source no longer has (outside the engine's types folder).
const prune = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const rel = relative(dest, p)
    if (skip(rel)) continue
    if (!existsSync(join(src, rel))) {
      rmSync(p, { recursive: true, force: true })
      continue
    }
    if (statSync(p).isDirectory()) prune(p)
  }
}
prune(dest)
cpSync(src, dest, { recursive: true, filter: (p) => !skip(relative(src, p)) })
console.log(`Copied ${src}\n    to ${dest}`)
