#!/usr/bin/env node
// Per-message usage for Claude Code conversations, from the transcripts on disk.
//
//   node cli/usage-report.ts                 the most recently active session
//   node cli/usage-report.ts <session-id>    a session by id (or a path to its .jsonl)
//   node cli/usage-report.ts --list          recent sessions with totals
//   node cli/usage-report.ts --all           every session, most lost to lapsed caches first
//   node cli/usage-report.ts --html out.html also write an HTML report
//
// Needs Node 22.18+ (runs TypeScript directly). No dependencies.

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { ExchangeReport, SessionReport } from '../lib/usage.ts'
import {
  analyzeSession,
  estimateNext,
  fmtDuration,
  fmtTokens,
  fmtUsd,
  promptTokens,
  requestCost,
} from '../lib/usage.ts'
import { modelLabel, PRICES_AS_OF, priceFor } from '../lib/pricing.ts'
import type { SessionFile } from './sessions.ts'
import { listSessions, loadSession, projectName, projectSlug, projectsRoot } from './sessions.ts'
import { htmlReport } from './html-report.ts'

type Options = {
  target?: string
  list?: number
  all: boolean
  html?: string
  json: boolean
  limit?: number
  detail?: number
  project?: string
  color: boolean
  help: boolean
}

function parseArgs(argv: string[]): Options {
  const o: Options = { all: false, json: false, help: false, color: !!process.stdout.isTTY && !process.env.NO_COLOR }
  /** The value after a flag, when there is one that is not itself a flag. */
  const valueAfter = (i: number): string | undefined => {
    const v = argv[i + 1]
    return v !== undefined && !v.startsWith('-') ? v : undefined
  }
  const need = (flag: string, v: string | undefined): string => {
    if (v === undefined) {
      console.error(`${flag} needs a value. Try --help.`)
      process.exit(2)
    }
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-h' || a === '--help') o.help = true
    else if (a === '--list') {
      const v = valueAfter(i)
      o.list = v && /^\d+$/.test(v) ? Number(v) : 15
      if (v && /^\d+$/.test(v)) i++
    } else if (a === '--all') o.all = true
    else if (a === '--html') {
      const v = valueAfter(i)
      o.html = v ?? 'usage-report.html'
      if (v) i++
    } else if (a === '--json') o.json = true
    else if (a === '--limit') o.limit = Number(need(a, valueAfter(i++)))
    else if (a === '--detail') o.detail = Number(need(a, valueAfter(i++)))
    else if (a === '--project') o.project = need(a, valueAfter(i++))
    else if (a === '--no-color') o.color = false
    else if (a === '--latest') o.target = undefined
    else if (!a.startsWith('-')) o.target = a
    else {
      console.error(`Unknown option ${a}. Try --help.`)
      process.exit(2)
    }
  }
  return o
}

const HELP = `Per-message usage for Claude Code conversations, from the transcripts on disk.

  node cli/usage-report.ts [session-id | file.jsonl] [options]

  (no target)       the most recently active session
  --project <dir>   only sessions that ran in <dir>
  --list [n]        the n most recent sessions with totals (default 15)
  --all             every session, most lost to lapsed caches first
  --detail <n>      every request of message #n
  --limit <n>       only the last n messages
  --html <file>     also write an HTML report of the session
  --json            the analysis as JSON
  --no-color

What the columns mean:
  You      the input side of the first request after your message: reading the
           conversation so far plus your new text (cheap when the cache is warm)
  Claude   everything Claude did to answer: its output, tool-loop requests,
           subagents, workflow agents and the advisor
  Cache    warm: the conversation came from the prompt cache
           cold: the cache did not serve the conversation, so it was written
                 again. ·idle: the gap ran past the cache's lifetime. ·model:
                 the model changed (each model has its own cache). No suffix:
                 something early in the conversation changed.
           partial: part of the conversation was written again
           compacted, shorter: rebuilt on purpose, after a compaction or a
                 much shorter conversation (a rewind); no penalty
           first: the session's first message
  Dollars are API list-price equivalents: a common scale for comparing messages,
  not what a subscription charges. Prices as of ${PRICES_AS_OF}.
`

// ---------------------------------------------------------------- colors

let useColor = false
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = paint('2')
const bold = paint('1')
const blue = paint('38;2;57;135;229')
const orange = paint('38;2;235;104;52')
const warn = paint('38;2;250;178;25')
const good = paint('38;2;12;163;12')

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

function width(s: string): number {
  return [...stripAnsi(s)].length
}

function pad(s: string, w: number, right = false): string {
  const gap = Math.max(0, w - width(s))
  return right ? ' '.repeat(gap) + s : s + ' '.repeat(gap)
}

function cut(s: string, w: number): string {
  const chars = [...s]
  return chars.length > w ? `${chars.slice(0, Math.max(0, w - 1)).join('')}…` : s
}

// ---------------------------------------------------------------- formatting

function timeOf(ms: number, withDate: boolean): string {
  const d = new Date(ms)
  const hm = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (!withDate) return hm
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hm}`
}

function cacheCell(r: ExchangeReport): string {
  const c = r.cache
  switch (c.state) {
    case 'warm':
      return good('warm')
    case 'cold':
      return warn(c.reason === 'idle' ? '▲ cold·idle' : c.reason === 'model-switch' ? '▲ cold·model' : '▲ cold')
    case 'partial':
      return warn('△ partial')
    case 'reset':
      return dim(c.reason === 'compaction' ? 'compacted' : 'shorter')
    case 'first':
      return dim('first')
    default:
      return dim('-')
  }
}

function requestsCell(r: ExchangeReport): string {
  const main = r.claude.mainRequests
  const extra: string[] = []
  if (r.claude.agentRequests) extra.push(`${r.claude.agentRequests} in ${r.claude.agents || 1} agent${r.claude.agents === 1 ? '' : 's'}`)
  if (r.claude.advisorRequests) extra.push(`${r.claude.advisorRequests} advisor`)
  return extra.length ? `${main} + ${extra.join(' + ')}` : String(main)
}

function originMark(origin: string): string {
  if (origin === 'human') return ''
  if (origin === 'task-notification') return '[task] '
  if (origin === 'app-event') return '[app] '
  return `[${origin}] `
}

// ---------------------------------------------------------------- one session

/** One-line explanation of why a cache lapsed. */
/** Whether a row was started by the person (typed, from a phone, queued) rather than by a notification or another session. */
function byPerson(origin: string): boolean {
  return ['human', 'composer', 'bridge', 'sdk', 'queued'].includes(origin)
}

function whyCold(c: { reason?: string; idleMs?: number }, ttl: string, midTurn = false, origin = 'human'): string {
  if (c.reason === 'idle') {
    if (midTurn) return `waited ${fmtDuration(c.idleMs ?? 0)} inside the turn (a question or permission prompt was pending, or a tool ran long), past the ${ttl} cache`
    return byPerson(origin)
      ? `you were away ${fmtDuration(c.idleMs ?? 0)}, past the ${ttl} cache`
      : `started ${fmtDuration(c.idleMs ?? 0)} after Claude's last request, past the ${ttl} cache`
  }
  if (c.reason === 'model-switch') return 'the model changed, and each model has its own cache'
  if (midTurn) return `the cache missed ${fmtDuration(c.idleMs ?? 0)} after the previous request: something early in the conversation changed`
  return 'something early in the conversation changed: a tool, MCP server or plugin change, fast mode, effort on older models, a Claude Code update or an app restart'
}

function printSession(file: SessionFile, o: Options): void {
  const { parsed } = loadSession(file)
  const ttl = parsed.ttl ?? '1h'
  const report = analyzeSession(parsed.exchanges, { price: priceFor, ttl }, parsed.preamble)
  const mainTtl = report.mainTtl ?? ttl
  if (o.html) {
    const out = resolve(o.html)
    writeFileSync(out, htmlReport({ file, parsed, report, ttl, generatedAt: Date.now() }), 'utf8')
    // On stderr, so it never mixes into --json output.
    console.error(`Wrote ${out}`)
  }
  if (o.json) {
    console.log(JSON.stringify({ session: file, title: parsed.title, ttl, report: jsonReport(report) }, null, 2))
    return
  }
  const cols = Math.max(100, process.stdout.columns ?? 120)
  const first = parsed.exchanges[0]
  const multiDay = first && parsed.lastAt ? new Date(first.at).toDateString() !== new Date(parsed.lastAt).toDateString() : false
  console.log('')
  console.log(bold(parsed.title ?? '(untitled session)') + dim(`  ·  ${projectName(file.project)}  ·  ${file.id}`))
  console.log(
    dim(
      `${first ? `started ${timeOf(first.at, true)}` : 'no messages'}  ·  ${report.reports.length} message${report.reports.length === 1 ? '' : 's'}  ·  ` +
        `${ttl} cache  ·  models: ${parsed.models.map(modelLabel).join(', ') || '-'}`,
    ),
  )
  console.log('')

  let rows = report.reports
  if (o.limit && o.limit > 0) rows = rows.slice(-o.limit)
  const maxUsd = Math.max(...rows.map(r => r.total.usd), 0.000001)
  const fixed = 4 + 1 + (multiDay ? 13 : 6) + 1 + 7 + 1 + 12 + 1 + 8 + 1 + 8 + 1 + 9 + 1 + 12 + 1 + 22 + 1
  const msgW = Math.max(16, cols - fixed)
  const header =
    pad('#', 4, true) + ' ' + pad('time', multiDay ? 13 : 6) + ' ' + pad('gap', 7, true) + ' ' + pad('cache', 12) + ' ' +
    pad('you', 8, true) + ' ' + pad('claude', 8, true) + ' ' + pad('total', 9, true) + ' ' + pad('', 12) + ' ' +
    pad('requests', 22) + ' ' + 'message'
  console.log(dim(header))
  for (const r of rows) {
    const gap = r.cache.idleMs !== undefined ? fmtDuration(r.cache.idleMs) : '-'
    const youFrac = r.total.usd > 0 ? r.you.usd / r.total.usd : 0
    const barW = Math.max(1, Math.round((r.total.usd / maxUsd) * 12))
    const youW = Math.min(barW, Math.round(barW * youFrac))
    const barStr = blue('█'.repeat(youW)) + orange('█'.repeat(barW - youW))
    console.log(
      pad(String(r.ex.n), 4, true) + ' ' +
        pad(timeOf(r.ex.at, multiDay), multiDay ? 13 : 6) + ' ' +
        pad(gap, 7, true) + ' ' +
        pad(cacheCell(r), 12) + ' ' +
        pad(blue(fmtUsd(r.you.usd)), 8, true) + ' ' +
        pad(orange((r.estimatedRequests ? '≈' : '') + fmtUsd(r.claude.usd)), 8, true) + ' ' +
        pad(bold((r.estimatedRequests ? '≈' : '') + fmtUsd(r.total.usd)), 9, true) + ' ' +
        pad(barStr, 12) + ' ' +
        pad(requestsCell(r), 22) + ' ' +
        cut(originMark(r.ex.origin) + r.ex.prompt, msgW),
    )
    if (r.cache.state === 'cold' && r.cache.rewritten > 0) {
      const who = byPerson(r.ex.origin) ? 'your message' : 'this turn'
      console.log(
        ' '.repeat(5) +
          warn(`▲ ${who} re-wrote ${fmtTokens(r.cache.rewritten)} tokens of conversation`) +
          dim(` (${whyCold(r.cache, mainTtl, false, r.ex.origin)}): `) +
          warn(`+${fmtUsd(r.cache.penaltyUsd)}`) +
          dim(' over a warm cache'),
      )
    }
    const midTurn = r.coldLater.filter(c => c.thread === 'main')
    for (const c of midTurn) {
      console.log(
        ' '.repeat(5) +
          warn(`▲ mid-turn, re-wrote ${fmtTokens(c.rewritten)} tokens`) +
          dim(` (${whyCold(c, mainTtl, true)}): `) +
          warn(`+${fmtUsd(c.penaltyUsd)}`),
      )
    }
    const inAgents = r.coldLater.filter(c => c.thread === 'agent')
    if (inAgents.length) {
      const usd = inAgents.reduce((s, c) => s + c.penaltyUsd, 0)
      console.log(' '.repeat(5) + dim(`△ ${inAgents.length} agent request${inAgents.length === 1 ? '' : 's'} found the agent's 5-minute cache lapsed: +${fmtUsd(usd)}`))
    }
  }
  console.log('')
  console.log(
    `${bold('Session')} ${bold((parsed.estimatedOutputs ? '≈' : '') + fmtUsd(report.total.usd))} ${dim('API-equivalent')}  ·  ` +
      `${blue('you')} ${fmtUsd(report.you.usd)}  ·  ${orange('Claude')} ${(parsed.estimatedOutputs ? '≈' : '') + fmtUsd(report.claude.usd)}  ·  ` +
      `${fmtTokens(sumTokens(report))} tokens in ${report.total.requests} requests`,
  )
  if (report.penaltyUsd > 0) {
    const parts: string[] = []
    // A turn's first request: a message of yours, or a turn a notification or another session started.
    const firstLapsed = report.reports.filter(r => (r.cache.state === 'cold' || r.cache.state === 'partial') && r.cache.penaltyUsd > 0)
    const yours = firstLapsed.filter(r => byPerson(r.ex.origin)).length
    const others = firstLapsed.length - yours
    if (yours) parts.push(`${yours} of your messages`)
    if (others) parts.push(`${others} turn${others === 1 ? '' : 's'} you didn't start`)
    if (report.midTurnColdCount) parts.push(`${report.midTurnColdCount} mid-turn`)
    if (report.agentColdCount) parts.push(`${report.agentColdCount} in agents`)
    console.log(warn(`▲ Lapsed caches (${parts.join(', ')}) cost ${fmtUsd(report.penaltyUsd)} more than warm caches would have.`))
  }
  if (parsed.preamble.length) console.log(dim(`(${parsed.preamble.length} request(s) before the first message are not shown in the rows.)`))
  if (parsed.estimatedOutputs) {
    console.log(dim(`≈ ${parsed.estimatedOutputs} agent request(s) had incomplete output counts in the transcript (Claude Code 2.1.219-2.1.293): their output is estimated from the text they wrote and is likely low.`))
  }
  const next = estimateNext(report.lastMain, Date.now(), mainTtl, priceFor, parsed.compactedAt)
  if (next.state !== 'none') {
    console.log(
      next.state === 'warm'
        ? dim(`Cache warm for ${fmtDuration(next.msLeft)} more: the next message re-reads ${fmtTokens(next.contextTokens)} tokens for about ${fmtUsd(next.warmUsd)}.`)
        : next.state === 'compacted'
          ? dim('The conversation was compacted after its last request: the next message rebuilds the cache from the summary.')
          : warn(`Cache expired ${fmtDuration(next.idleMs - (mainTtl === '5m' ? 300_000 : 3_600_000))} ago: the next message re-writes ${fmtTokens(next.contextTokens)} tokens, about ${fmtUsd(next.coldUsd)} (warm: ${fmtUsd(next.warmUsd)}).`),
    )
  }
  console.log(dim('You = reading the conversation + your message.  Claude = its output, tool calls, agents, advisor.  --help explains.'))

  if (o.detail !== undefined) printDetail(report, o.detail, ttl)
}

function sumTokens(s: SessionReport): number {
  const t = s.total.tokens
  return promptTokens(t) + t.output
}

function printDetail(report: SessionReport, n: number, ttl: '5m' | '1h'): void {
  const r = report.reports.find(x => x.ex.n === n)
  if (!r) {
    console.log(`\nNo message #${n}.`)
    return
  }
  console.log(`\n${bold(`Message #${n}`)}: ${r.ex.prompt}`)
  console.log(dim(pad('time', 9) + pad('kind', 9) + pad('model', 12) + pad('uncached', 10, true) + pad('cache read', 12, true) + pad('cache write', 13, true) + pad('output', 9, true) + pad('cost', 10, true)))
  for (const q of [...r.ex.reqs].sort((a, b) => a.at - b.at)) {
    const t = q.tokens
    const kind = q.kind === 'agent' ? `agent` : q.kind
    console.log(
      pad(new Date(q.at).toLocaleTimeString('en-US', { hour12: false }), 9) +
        pad(kind, 9) +
        pad(modelLabel(q.model), 12) +
        pad(fmtTokens(t.input), 10, true) +
        pad(fmtTokens(t.cacheRead), 12, true) +
        pad(fmtTokens(t.cacheWrite5m + t.cacheWrite1h + t.cacheWriteUnknown), 13, true) +
        pad(fmtTokens(t.output), 9, true) +
        pad(fmtUsd(requestCost(q, priceFor)), 10, true),
    )
  }
}

function jsonReport(s: SessionReport) {
  return {
    totalUsd: s.total.usd,
    youUsd: s.you.usd,
    claudeUsd: s.claude.usd,
    penaltyUsd: s.penaltyUsd,
    coldCount: s.coldCount,
    exchanges: s.reports.map(r => ({
      n: r.ex.n,
      at: new Date(r.ex.at).toISOString(),
      origin: r.ex.origin,
      prompt: r.ex.prompt,
      you: { usd: r.you.usd, tokens: r.you.tokens },
      claude: { usd: r.claude.usd, tokens: r.claude.tokens, mainRequests: r.claude.mainRequests, agentRequests: r.claude.agentRequests, agents: r.claude.agents, advisorRequests: r.claude.advisorRequests },
      totalUsd: r.total.usd,
      cache: r.cache,
      coldLater: r.coldLater,
      penaltyUsd: r.penaltyUsd,
      estimatedRequests: r.estimatedRequests,
      unknownModels: r.unknownModels,
    })),
  }
}

// ---------------------------------------------------------------- many sessions

function printList(files: SessionFile[], o: Options, sortByPenalty: boolean): void {
  type Row = {
    f: SessionFile
    title: string
    msgs: number
    usd: number
    /** Dollars of requests no earlier session file holds (a resumed or forked session repeats its parent's). */
    ownUsd: number
    ownPenalty: number
    penalty: number
    cold: number
    last: number
    isCopy: boolean
    /** Lapses inside agents, among the penalty. */
    agentCold: number
    /** Requests of this file's own whose output was estimated. */
    estimated: number
  }
  const rows: Row[] = []
  const seen = new Set<string>()
  // Oldest first, so a request belongs to the first session file that holds it:
  // by creation time (resumed and forked copies are created later than their
  // original, and keep its timestamps inside), else by last change.
  const born = (f: SessionFile) => (f.birthtimeMs > 0 ? f.birthtimeMs : f.mtimeMs)
  for (const f of [...files].sort((a, b) => born(a) - born(b) || a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id))) {
    try {
      const { parsed } = loadSession(f)
      const ttl = parsed.ttl ?? '1h'
      const rep = analyzeSession(parsed.exchanges, { price: priceFor, ttl }, parsed.preamble)
      let ownUsd = 0
      let ownPenalty = 0
      let ownCount = 0
      let ownMsgs = 0
      let ownCold = 0
      let ownAgentCold = 0
      let ownEstimated = 0
      let count = 0
      for (const r of rep.reports) {
        // The requests no earlier file holds. A lapse counts only where the request
        // that found the cache lapsed is one of them: a resumed copy repeats its
        // original's lapses along with its history.
        const fresh = new Set<string>()
        for (const q of r.ex.reqs) {
          count += 1
          if (seen.has(q.key)) continue
          seen.add(q.key)
          fresh.add(q.key)
          ownUsd += requestCost(q, priceFor)
          if (q.estimated) ownEstimated += 1
        }
        ownCount += fresh.size
        if (fresh.size > 0) ownMsgs += 1
        if (r.firstKey && fresh.has(r.firstKey)) {
          ownPenalty += r.cache.penaltyUsd
          if (r.cache.state === 'cold') ownCold += 1
        }
        for (const c of r.coldLater) {
          if (!fresh.has(c.key)) continue
          ownPenalty += c.penaltyUsd
          if (c.thread === 'main') ownCold += 1
          else ownAgentCold += 1
        }
      }
      rows.push({
        f,
        title: parsed.title ?? parsed.exchanges[0]?.prompt ?? '(empty)',
        msgs: ownMsgs,
        usd: ownUsd,
        ownUsd,
        ownPenalty,
        penalty: ownPenalty,
        cold: ownCold,
        last: parsed.lastAt ?? f.mtimeMs,
        isCopy: count > 0 && ownCount < count,
        agentCold: ownAgentCold,
        estimated: ownEstimated,
      })
    } catch (err) {
      console.error(dim(`skipped ${f.path}: ${(err as Error).message}`))
    }
  }
  if (sortByPenalty) rows.sort((a, b) => b.ownPenalty - a.ownPenalty || b.ownUsd - a.ownUsd)
  else rows.sort((a, b) => b.last - a.last)
  if (o.json) {
    console.log(
      JSON.stringify(
        rows.map(r => ({ id: r.f.id, project: r.f.project, title: r.title, messages: r.msgs, usd: r.usd, ownUsd: r.ownUsd, penaltyUsd: r.penalty, ownPenaltyUsd: r.ownPenalty, coldStarts: r.cold, agentLapses: r.agentCold, estimatedRequests: r.estimated, isResumedCopy: r.isCopy, lastActive: new Date(r.last).toISOString() })),
        null,
        2,
      ),
    )
    return
  }
  const cols = Math.max(100, process.stdout.columns ?? 120)
  const titleW = Math.max(20, cols - (10 + 1 + 18 + 1 + 13 + 1 + 5 + 1 + 9 + 1 + 9 + 1 + 5 + 2))
  console.log(dim(pad('session', 10) + ' ' + pad('project', 18) + ' ' + pad('last active', 13) + ' ' + pad('msgs', 5, true) + ' ' + pad('total', 9, true) + ' ' + pad('lapses', 9, true) + ' ' + pad('cold', 5, true) + '  title'))
  let usd = 0
  let penalty = 0
  let cold = 0
  let agentCold = 0
  let copies = 0
  let estimatedSessions = 0
  for (const r of rows) {
    usd += r.usd
    penalty += r.penalty
    cold += r.cold
    agentCold += r.agentCold
    if (r.isCopy) copies += 1
    if (r.estimated) estimatedSessions += 1
    console.log(
      pad(r.f.id.slice(0, 8), 10) + ' ' + pad(cut(projectName(r.f.project), 18), 18) + ' ' + pad(timeOf(r.last, true), 13) + ' ' +
        pad(String(r.msgs), 5, true) + ' ' + pad(bold((r.estimated ? '≈' : '') + fmtUsd(r.usd)), 9, true) + ' ' +
        pad(r.penalty > 0 ? warn(fmtUsd(r.penalty)) : dim('-'), 9, true) + ' ' + pad(r.cold ? String(r.cold) : dim('-'), 5, true) + '  ' +
        (r.isCopy ? dim('(continues an earlier session) ') : '') + cut(r.title, titleW),
    )
  }
  console.log('')
  console.log(
    `${rows.length} sessions  ·  ${bold(fmtUsd(usd))} API-equivalent  ·  lost to lapsed caches ${warn(fmtUsd(penalty))}: ${cold} cold start${cold === 1 ? '' : 's'} in conversations, ${agentCold} in agents` +
      dim(copies ? `\n${copies} sessions continue an earlier one (resume or fork): they repeat its history, so their rows count only what is new.` : '') +
      dim(estimatedSessions ? `\n≈ ${estimatedSessions} session${estimatedSessions === 1 ? '' : 's'} include agent output the transcript recorded only in part (Claude Code 2.1.219 to 2.1.293): estimated from the text written, likely low.` : ''),
  )
}

// ---------------------------------------------------------------- main

function main(): void {
  const o = parseArgs(process.argv.slice(2))
  useColor = o.color
  if (o.help) {
    console.log(HELP)
    return
  }
  const root = projectsRoot()
  const onlyProject = o.project ? projectSlug(o.project) : undefined
  const sessions = listSessions(root, onlyProject)
  if (o.all || o.list !== undefined) {
    if (sessions.length === 0) {
      console.log(`No transcripts under ${root}${onlyProject ? ` for ${o.project}` : ''}.`)
      return
    }
    printList(o.all ? sessions : sessions.slice(0, o.list), o, o.all)
    return
  }
  let target: SessionFile | string | undefined
  if (o.target) {
    if (/\.jsonl$/i.test(o.target)) target = resolve(o.target)
    else target = listSessions(root).find(s => s.id === o.target || s.id.startsWith(o.target!))
    if (!target) {
      console.error(`No session ${o.target} under ${root}.`)
      process.exit(1)
    }
  } else target = sessions[0]
  if (!target) {
    console.log(`No transcripts under ${root}.`)
    return
  }
  printSession(typeof target === 'string' ? loadSession(target).file : target, o)
}

main()
