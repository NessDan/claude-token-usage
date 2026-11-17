// Finding and loading Claude Code session transcripts on disk (Node only).

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import type { ParsedTranscript } from '../lib/transcript.ts'
import { agentIdFromPath, createTranscriptParser, runIdFromPath } from '../lib/transcript.ts'

/** Calls `fn` for each line of the file, reading it in chunks (transcripts run to hundreds of megabytes). */
export function forEachFileLine(path: string, fn: (line: string) => void): void {
  const fd = openSync(path, 'r')
  const buf = Buffer.allocUnsafe(4 * 1024 * 1024)
  const decoder = new StringDecoder('utf8')
  let rest = ''
  try {
    for (;;) {
      const read = readSync(fd, buf, 0, buf.length, null)
      if (read <= 0) break
      const text = rest + decoder.write(buf.subarray(0, read))
      let start = 0
      for (;;) {
        const end = text.indexOf('\n', start)
        if (end === -1) break
        fn(text.slice(start, end))
        start = end + 1
      }
      rest = text.slice(start)
    }
    rest += decoder.end()
    if (rest) fn(rest)
  } finally {
    closeSync(fd)
  }
}

export type SessionFile = {
  /** The session id (the file name without .jsonl). */
  id: string
  /** The transcript's path. */
  path: string
  /** The project folder's name (the slug of the directory the session ran in). */
  project: string
  mtimeMs: number
  /** When the file was created (0 where the filesystem does not record it). */
  birthtimeMs: number
  size: number
}

/** Where Claude Code keeps transcripts: $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects. */
export function projectsRoot(): string {
  const base = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
  return join(base, 'projects')
}

/** The folder name Claude Code gives a project directory: every character outside [A-Za-z0-9-] becomes "-". */
export function projectSlug(dir: string): string {
  return resolve(dir).replace(/[^A-Za-z0-9-]/g, '-')
}

const UUID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

export function listSessions(root = projectsRoot(), onlyProject?: string): SessionFile[] {
  if (!existsSync(root)) return []
  const out: SessionFile[] = []
  for (const project of readdirSync(root)) {
    if (onlyProject && project !== onlyProject) continue
    const dir = join(root, project)
    let names: string[]
    try {
      if (!statSync(dir).isDirectory()) continue
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!UUID_FILE.test(name)) continue
      const path = join(dir, name)
      try {
        const st = statSync(path)
        out.push({ id: name.slice(0, -'.jsonl'.length), path, project, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs || 0, size: st.size })
      } catch {
        // vanished between listing and stat
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** Every agent transcript under <session>/subagents, workflows included: its path and agent id. */
export function agentFiles(sessionPath: string): { path: string; agentId: string; runId?: string }[] {
  const dir = join(sessionPath.replace(/\.jsonl$/i, ''), 'subagents')
  const out: { path: string; agentId: string; runId?: string }[] = []
  const walk = (d: string, depth: number) => {
    if (depth > 6) return
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const name of names) {
      const p = join(d, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p, depth + 1)
      else if (/^agent-.+\.jsonl$/.test(name)) out.push({ path: p, agentId: agentIdFromPath(p) ?? p, runId: runIdFromPath(p) })
    }
  }
  walk(dir, 0)
  return out
}

export function loadSession(file: SessionFile | string): { file: SessionFile; parsed: ParsedTranscript } {
  const f: SessionFile =
    typeof file === 'string'
      ? (() => {
          const st = statSync(file)
          const dirName = basename(resolve(file, '..'))
          return { id: basename(file).replace(/\.jsonl$/i, ''), path: resolve(file), project: dirName, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs || 0, size: st.size }
        })()
      : file
  const p = createTranscriptParser()
  forEachFileLine(f.path, line => p.line(line))
  for (const a of agentFiles(f.path)) forEachFileLine(a.path, line => p.agentLine(line, a.agentId, a.runId))
  return { file: f, parsed: p.result() }
}

/** A readable project name from its slug: the last path segment, best effort. */
export function projectName(slug: string): string {
  const parts = slug.split(/-{2,}/)
  const tail = parts[parts.length - 1] ?? slug
  const m = /(?:^|-)Code-(.+)$/.exec(slug)
  return (m ? m[1] : tail) || slug
}
