// A self-contained HTML report of one session: stat tiles, a stacked column per
// message (your message / Claude's reply), and the full table.
//
// Prompts are the person's own text and may hold anything: everything that
// reaches the page is escaped, and the tooltip script reads its data from a
// JSON block and writes it with textContent.

import type { ParsedTranscript } from '../lib/transcript.ts'
import type { ExchangeReport, SessionReport, Ttl } from '../lib/usage.ts'
import { estimateNext, fmtDuration, fmtTokens, fmtUsd, promptTokens } from '../lib/usage.ts'
import { modelLabel, PRICES_AS_OF, priceFor } from '../lib/pricing.ts'
import type { SessionFile } from './sessions.ts'
import { projectName } from './sessions.ts'

export type HtmlInput = { file: SessionFile; parsed: ParsedTranscript; report: SessionReport; ttl: Ttl; generatedAt: number }

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function niceStep(max: number, ticks: number): number {
  const raw = max / Math.max(1, ticks)
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const f = raw / pow
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return nice * pow
}

function tickLabel(v: number): string {
  if (v === 0) return '$0'
  if (v < 1) return `$${v.toFixed(2)}`
  if (v < 10) return `$${v.toFixed(v % 1 ? 1 : 0)}`
  if (v < 10_000) return `$${Math.round(v).toLocaleString('en-US')}`
  return `$${Math.round(v / 1000)}K`
}

function cacheLabel(r: ExchangeReport): { icon: string; text: string; cls: string } {
  const c = r.cache
  switch (c.state) {
    case 'warm':
      return { icon: '●', text: 'warm', cls: 'good' }
    case 'cold':
      return {
        icon: '▲',
        text: c.reason === 'idle' ? 'cold · idle' : c.reason === 'model-switch' ? 'cold · model switch' : 'cold · invalidated',
        cls: 'warn',
      }
    case 'partial':
      return { icon: '△', text: 'partial', cls: 'warn' }
    case 'reset':
      return { icon: '↺', text: c.reason === 'compaction' ? 'rebuilt (compaction)' : 'shorter context', cls: 'muted' }
    case 'first':
      return { icon: '○', text: 'first message', cls: 'muted' }
    default:
      return { icon: '·', text: '-', cls: 'muted' }
  }
}

/** Rounded-top bar segment path (data end rounded, baseline end square). */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h))
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`
}

function chart(reports: readonly ExchangeReport[]): string {
  const n = reports.length
  if (n === 0) return '<p class="muted">No messages yet.</p>'
  const W = 1000
  const plotTop = 18
  const plotH = 250
  const axisH = 34
  const left = 56
  const right = 8
  const plotW = W - left - right
  const max = Math.max(...reports.map(r => r.total.usd), 0.0001)
  const step = niceStep(max, 4)
  const top = Math.ceil(max / step) * step
  const y = (v: number) => plotTop + plotH - (v / top) * plotH
  const band = plotW / n
  const barW = Math.max(1.5, Math.min(24, band * 0.7))
  const gap = band > 6 ? 2 : 1
  const parts: string[] = []
  for (let t = 0; t <= top + step / 2; t += step) {
    const yy = y(t)
    parts.push(`<line class="grid" x1="${left}" x2="${W - right}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}"/>`)
    parts.push(`<text class="tick" x="${left - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end">${tickLabel(t)}</text>`)
  }
  const labelEvery = Math.max(1, Math.ceil(n / Math.floor(plotW / 34)))
  reports.forEach((r, i) => {
    const cx = left + band * i + band / 2
    const x = cx - barW / 2
    const yYou = y(r.you.usd)
    const hYou = plotTop + plotH - yYou
    const yTot = y(r.total.usd)
    const hClaude = Math.max(0, yYou - yTot - (hYou > 0 && r.claude.usd > 0 ? gap : 0))
    if (hYou > 0.3) {
      parts.push(
        r.claude.usd > 0 && hClaude > 0.3
          ? `<rect class="s1" x="${x.toFixed(2)}" y="${yYou.toFixed(2)}" width="${barW.toFixed(2)}" height="${hYou.toFixed(2)}"/>`
          : `<path class="s1" d="${topRounded(x, yYou, barW, hYou, 4)}"/>`,
      )
    }
    if (hClaude > 0.3) parts.push(`<path class="s2" d="${topRounded(x, yTot, barW, hClaude, 4)}"/>`)
    if (isColdExchange(r)) {
      parts.push(`<text class="flag" x="${cx.toFixed(1)}" y="${(yTot - 5).toFixed(1)}" text-anchor="middle">▲</text>`)
    }
    if (i % labelEvery === 0 || (i === n - 1 && i % labelEvery >= Math.ceil(labelEvery / 2) + 1)) {
      parts.push(`<text class="tick" x="${cx.toFixed(1)}" y="${plotTop + plotH + 18}" text-anchor="middle">${r.ex.n}</text>`)
    }
    parts.push(
      `<rect class="hit" data-i="${i}" tabindex="0" role="img" aria-label="Message ${r.ex.n}: you ${esc(fmtUsd(r.you.usd))}, Claude ${esc(fmtUsd(r.claude.usd))}" x="${(left + band * i).toFixed(2)}" y="${plotTop}" width="${band.toFixed(2)}" height="${plotH}"/>`,
    )
  })
  parts.push(`<line class="axis" x1="${left}" x2="${W - right}" y1="${plotTop + plotH}" y2="${plotTop + plotH}"/>`)
  parts.push(`<text class="tick" x="${left + plotW / 2}" y="${plotTop + plotH + axisH - 2}" text-anchor="middle">message #</text>`)
  return `<svg class="chart" viewBox="0 0 ${W} ${plotTop + plotH + axisH}" role="group" aria-label="Cost per message, stacked: your message and Claude's reply">${parts.join('')}</svg>`
}

/** How many requests found a cache lapsed, in words. */
function coldNote(s: SessionReport): string {
  const parts: string[] = []
  const firstLapsed = s.reports.filter(r => (r.cache.state === 'cold' || r.cache.state === 'partial') && r.cache.penaltyUsd > 0)
  const yours = firstLapsed.filter(r => byPerson(r.ex.origin)).length
  const others = firstLapsed.length - yours
  if (yours) parts.push(`${yours} of your messages`)
  if (others) parts.push(`${others} turn${others === 1 ? '' : 's'} you didn't start`)
  if (s.midTurnColdCount) parts.push(`${s.midTurnColdCount} mid-turn`)
  if (s.agentColdCount) parts.push(`${s.agentColdCount} in agents`)
  return parts.length ? `cold starts: ${parts.join(', ')}` : 'no cold starts'
}

/** Whether a row was started by the person (typed, from a phone, queued) rather than a notification or another session. */
function byPerson(origin: string): boolean {
  return ['human', 'composer', 'bridge', 'sdk', 'queued'].includes(origin)
}

/** Your message, or a later request on the main thread, found the conversation's cache lapsed. */
function isColdExchange(r: ExchangeReport): boolean {
  return r.cache.state === 'cold' || r.coldLater.some(c => c.thread === 'main' && c.state === 'cold')
}

function tile(label: string, value: string, note?: string, cls = ''): string {
  return `<div class="tile ${cls}"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${note ? `<div class="note">${esc(note)}</div>` : ''}</div>`
}

export function htmlReport(input: HtmlInput): string {
  const { file, parsed, report, ttl } = input
  const reps = report.reports
  const title = parsed.title ?? reps[0]?.ex.prompt ?? 'Untitled session'
  const first = reps[0]?.ex.at
  const last = parsed.lastAt
  const when = first ? `${new Date(first).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}${last ? ` – ${new Date(last).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}` : ''
  const maxTotal = Math.max(...reps.map(r => r.total.usd), 0.0001)
  const mainTtl = report.mainTtl ?? ttl
  const next = estimateNext(report.lastMain, input.generatedAt, mainTtl, priceFor, parsed.compactedAt)
  const data = reps.map(r => {
    // The conversation's lapses (its first request, mid-turn) with their own figure; agents' apart.
    const mid = r.coldLater.filter(c => c.thread === 'main')
    const firstLapsed = r.cache.state === 'cold' || r.cache.state === 'partial'
    const rewritten = (firstLapsed ? r.cache.rewritten : 0) + mid.reduce((s, c) => s + c.rewritten, 0)
    const conversationPenalty = (firstLapsed ? r.cache.penaltyUsd : 0) + mid.reduce((s, c) => s + c.penaltyUsd, 0)
    const agentPenalty = r.coldLater.filter(c => c.thread === 'agent').reduce((s, c) => s + c.penaltyUsd, 0)
    return {
      n: r.ex.n,
      at: new Date(r.ex.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      prompt: r.ex.prompt.slice(0, 160),
      you: fmtUsd(r.you.usd),
      claude: (r.estimatedRequests ? '≈' : '') + fmtUsd(r.claude.usd),
      total: (r.estimatedRequests ? '≈' : '') + fmtUsd(r.total.usd),
      cache: cacheLabel(r).text,
      cold: isColdExchange(r),
      rewritten: rewritten ? fmtTokens(rewritten) : '',
      penalty: conversationPenalty > 0 ? fmtUsd(conversationPenalty) : '',
      agentPenalty: agentPenalty > 0.005 ? fmtUsd(agentPenalty) : '',
      idle: r.cache.idleMs !== undefined ? fmtDuration(r.cache.idleMs) : '',
    }
  })
  // Escapes for a <script> block: the less-than sign (so a closing script tag cannot end it) and the two JS line separators.
  const BS = String.fromCharCode(92)
  const json = JSON.stringify(data)
    .split('<').join(BS + 'u003c')
    .split(String.fromCharCode(0x2028)).join(BS + 'u2028')
    .split(String.fromCharCode(0x2029)).join(BS + 'u2029')

  const rows = reps
    .map(r => {
      const c = cacheLabel(r)
      const wTotal = (r.total.usd / maxTotal) * 100
      const wYou = r.total.usd > 0 ? (r.you.usd / r.total.usd) * wTotal : 0
      const extra: string[] = []
      if (r.claude.agentRequests) extra.push(`${r.claude.agentRequests} in ${r.claude.agents || 1} agent${r.claude.agents === 1 ? '' : 's'}`)
      if (r.claude.advisorRequests) extra.push(`${r.claude.advisorRequests} advisor`)
      const notes: string[] = []
      if (r.cache.state === 'cold' && r.cache.rewritten) {
        notes.push(
          `<div class="why warn">▲ ${byPerson(r.ex.origin) ? 'Your message' : 'This turn'} re-wrote ${esc(fmtTokens(r.cache.rewritten))} tokens of conversation${r.cache.reason === 'idle' ? (byPerson(r.ex.origin) ? ` after ${esc(fmtDuration(r.cache.idleMs ?? 0))} away` : `, ${esc(fmtDuration(r.cache.idleMs ?? 0))} after Claude's last request`) : r.cache.reason === 'model-switch' ? ' (model changed)' : ' (cache invalidated)'}: +${esc(fmtUsd(r.cache.penaltyUsd))} over a warm cache</div>`,
        )
      }
      for (const m of r.coldLater.filter(x => x.thread === 'main')) {
        notes.push(
          `<div class="why warn">▲ Mid-turn: re-wrote ${esc(fmtTokens(m.rewritten))} tokens${m.reason === 'idle' ? ` after waiting ${esc(fmtDuration(m.idleMs ?? 0))} (a question or permission prompt pending, or a long tool)` : m.reason === 'model-switch' ? ' (the model changed)' : ` (the cache missed ${esc(fmtDuration(m.idleMs ?? 0))} after the previous request)`}: +${esc(fmtUsd(m.penaltyUsd))}</div>`,
        )
      }
      const agentCold = r.coldLater.filter(x => x.thread === 'agent')
      if (agentCold.length) {
        notes.push(`<div class="why muted">△ ${agentCold.length} agent request${agentCold.length === 1 ? '' : 's'} found the agent's cache lapsed: +${esc(fmtUsd(agentCold.reduce((s, x) => s + x.penaltyUsd, 0)))}</div>`)
      }
      const note = notes.join('')
      return `<tr>
  <td class="num">${r.ex.n}</td>
  <td class="nowrap">${esc(new Date(r.ex.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</td>
  <td class="num">${r.cache.idleMs !== undefined ? esc(fmtDuration(r.cache.idleMs)) : '–'}</td>
  <td class="nowrap ${c.cls}">${c.icon} ${esc(c.text)}</td>
  <td class="num">${esc(fmtUsd(r.you.usd))}</td>
  <td class="num">${r.estimatedRequests ? '≈' : ''}${esc(fmtUsd(r.claude.usd))}</td>
  <td class="num strong">${r.estimatedRequests ? '≈' : ''}${esc(fmtUsd(r.total.usd))}</td>
  <td class="barcell"><div class="seg" style="width:${wTotal.toFixed(2)}%"><span class="b1" style="flex-basis:${wTotal > 0 ? ((wYou / wTotal) * 100).toFixed(2) : 0}%"></span><span class="b2"></span></div></td>
  <td class="nowrap">${r.claude.mainRequests}${extra.length ? ` + ${esc(extra.join(' + '))}` : ''}</td>
  <td class="prompt">${r.ex.origin !== 'human' ? `<span class="muted">[${esc(r.ex.origin)}]</span> ` : ''}${esc(r.ex.prompt)}${note}</td>
</tr>`
    })
    .join('\n')

  const sumTokens = promptTokens(report.total.tokens) + report.total.tokens.output
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Usage report</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --s1: #2a78d6; --s2: #eb6834; --warn: #fab219; --warn-ink: #8a5a00; --good: #006300;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --s1: #3987e5; --s2: #d95926; --warn: #fab219; --warn-ink: #fab219; --good: #0ca30c;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
  --s1: #3987e5; --s2: #d95926; --warn: #fab219; --warn-ink: #fab219; --good: #0ca30c;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; }
h2 { font-size: 16px; margin: 32px 0 12px; font-weight: 600; }
.sub, .muted { color: var(--muted); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-top: 20px; }
.tile .label { color: var(--ink-2); font-size: 13px; }
.tile .value { font-size: 26px; font-weight: 600; margin-top: 2px; }
.tile .note { color: var(--muted); font-size: 12px; margin-top: 2px; }
.tile.hero .value { font-size: 48px; line-height: 1.1; }
.tile.warn .value::before { content: "▲ "; color: var(--warn); font-size: 18px; vertical-align: 4px; }
.legend { display: flex; gap: 18px; align-items: center; color: var(--ink-2); font-size: 13px; margin-bottom: 8px; flex-wrap: wrap; }
.legend i { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.legend .k1 { background: var(--s1); } .legend .k2 { background: var(--s2); }
.legend .kw { color: var(--warn); font-style: normal; margin-right: 4px; }
.chartwrap { position: relative; }
svg.chart { width: 100%; height: auto; display: block; }
svg .grid { stroke: var(--grid); stroke-width: 1; }
svg .axis { stroke: var(--axis); stroke-width: 1; }
svg .tick { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
svg .s1 { fill: var(--s1); } svg .s2 { fill: var(--s2); }
svg .flag { fill: var(--warn); font-size: 10px; }
svg .hit { fill: transparent; cursor: default; outline: none; }
svg .hit:hover, svg .hit:focus { fill: var(--ink); fill-opacity: 0.05; }
.tip { position: absolute; pointer-events: none; background: var(--surface); color: var(--ink); border: 1px solid var(--border);
  border-radius: 8px; padding: 8px 10px; font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.12); max-width: 300px; display: none; z-index: 2; }
.tip .row { display: flex; gap: 8px; align-items: center; }
.tip .row b { min-width: 52px; text-align: right; font-variant-numeric: tabular-nums; }
.tip .key { width: 12px; height: 2px; display: inline-block; }
.tip .head { color: var(--ink-2); margin-bottom: 4px; }
.tip .p { color: var(--muted); margin-top: 4px; }
.tip .w { color: var(--warn-ink); margin-top: 4px; }
.tablewrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th { text-align: left; color: var(--ink-2); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--axis); white-space: nowrap; }
td { padding: 6px 8px; border-bottom: 1px solid var(--grid); vertical-align: top; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.strong { font-weight: 600; }
td.nowrap { white-space: nowrap; }
td.prompt { min-width: 240px; color: var(--ink-2); }
td.barcell { width: 120px; min-width: 90px; padding-top: 11px; }
.seg { display: flex; gap: 2px; height: 8px; min-width: 2px; }
.seg span { display: block; height: 8px; border-radius: 4px; }
.seg .b1 { background: var(--s1); flex: 0 0 auto; } .seg .b2 { background: var(--s2); flex: 1 1 auto; }
.good { color: var(--good); }
.warn { color: var(--warn-ink); }
.why { margin-top: 3px; font-size: 12px; }
.explain { columns: 2 320px; column-gap: 32px; color: var(--ink-2); }
.explain p { margin: 0 0 10px; break-inside: avoid; }
code { font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>${esc(title)}</h1>
  <div class="sub">${esc(projectName(file.project))} · session ${esc(file.id)} · ${esc(when)} · ${esc(parsed.models.map(modelLabel).join(', ') || 'no model calls')} · ${esc(ttl)} cache</div>

  <div class="tiles">
    ${tile('Session, API-equivalent', (parsed.estimatedOutputs ? '≈' : '') + fmtUsd(report.total.usd), `${fmtTokens(sumTokens)} tokens in ${report.total.requests} requests`, 'card hero')}
    ${tile('Your messages', fmtUsd(report.you.usd), 'reading the conversation + your text', 'card')}
    ${tile("Claude's replies", (parsed.estimatedOutputs ? '≈' : '') + fmtUsd(report.claude.usd), 'output, tools, agents, advisor', 'card')}
    ${tile('Lost to cold caches', fmtUsd(report.penaltyUsd), coldNote(report), `card${report.penaltyUsd > 0 ? ' warn' : ''}`)}
    ${next.state === 'compacted' ? tile('Next message, input side', 'rebuilds', 'compacted after the last request: the cache is rebuilt from the summary', 'card') : next.state !== 'none' ? tile('Next message, input side', fmtUsd(next.usd), next.state === 'warm' ? `cache warm for ${fmtDuration(next.msLeft)}` : `cache expired: re-writes ${fmtTokens(next.contextTokens)} tokens`, `card${next.state === 'cold' ? ' warn' : ''}`) : ''}
  </div>

  <h2>Cost per message</h2>
  <div class="card">
    <div class="legend"><span><i class="k1"></i>Your message</span><span><i class="k2"></i>Claude's reply</span><span><em class="kw">▲</em>cache had lapsed (cold start)</span></div>
    <div class="chartwrap">${chart(reps)}<div class="tip" id="tip" role="status"></div></div>
  </div>

  <h2>Every message</h2>
  <div class="card tablewrap">
    <table>
      <thead><tr><th class="num">#</th><th>Time</th><th class="num">Gap</th><th>Cache</th><th class="num">You</th><th class="num">Claude</th><th class="num">Total</th><th>Split</th><th>Requests</th><th>Message</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>

  <h2>How to read this</h2>
  <div class="card explain">
    <p><b>You</b> is what your message cost before Claude did anything: the first request after it re-sends the whole conversation plus your new text. With a warm cache most of that is read from the cache, which is cheap.</p>
    <p><b>Claude</b> is everything Claude did to answer: thinking and writing, each tool round trip (every one re-sends the conversation), subagents and workflow agents, the advisor.</p>
    <p><b>Cold start (▲)</b>: the prompt cache keeps the conversation for a while after each request (${esc(ttl)} here). Come back later than that, or change something early in the conversation, and the next request writes the whole conversation into the cache again, at the cache-write rate instead of the much lower cache-read rate.</p>
    ${parsed.estimatedOutputs ? `<p><b>≈</b> marks figures that include estimated output: ${parsed.estimatedOutputs} request${parsed.estimatedOutputs === 1 ? '' : 's'} had only part of their output count in the transcript (mostly agents under Claude Code 2.1.219 to 2.1.293). The estimate comes from the text they wrote and is likely low, since thinking isn't in the file.</p>` : ''}
    <p><b>Dollars</b> are Anthropic API list prices (${esc(PRICES_AS_OF)}) applied to the token counts in the transcript. A subscription does not charge them; they are a common scale for comparing messages. Plan-limit percentages are not computed here: Anthropic does not publish how tokens map to them.</p>
  </div>
  <p class="muted">Generated ${esc(new Date(input.generatedAt).toLocaleString('en-US'))} by usage-meter from ${esc(file.path)}.</p>
</main>
<script type="application/json" id="data">${json}</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('data').textContent);
  const tip = document.getElementById('tip');
  const wrap = tip.parentElement;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const row = (color, value, label) => {
    const r = el('div', 'row');
    const k = el('span', 'key'); k.style.background = color; r.append(k, el('b', '', value), el('span', '', label)); return r;
  };
  const show = (target) => {
    const d = data[Number(target.getAttribute('data-i'))];
    if (!d) return;
    tip.replaceChildren(
      el('div', 'head', '#' + d.n + ' · ' + d.at + (d.idle ? ' · after ' + d.idle : '')),
      row('var(--s1)', d.you, 'your message'),
      row('var(--s2)', d.claude, "Claude's reply"),
      row('transparent', d.total, 'total'),
    );
    if (d.cold && d.penalty) tip.append(el('div', 'w', '▲ cache lapsed: re-wrote ' + d.rewritten + ' tokens (+' + d.penalty + ')'));
    if (d.agentPenalty) tip.append(el('div', '', '△ agent caches lapsed: +' + d.agentPenalty));
    else tip.append(el('div', 'p', 'cache: ' + d.cache));
    if (d.prompt) tip.append(el('div', 'p', d.prompt));
    tip.style.display = 'block';
    const b = target.getBoundingClientRect(), w = wrap.getBoundingClientRect();
    let x = b.left - w.left + b.width / 2 + 12;
    if (x + tip.offsetWidth > w.width) x = b.left - w.left + b.width / 2 - tip.offsetWidth - 12;
    tip.style.left = Math.max(0, x) + 'px';
    tip.style.top = '8px';
  };
  const hide = () => { tip.style.display = 'none'; };
  for (const h of document.querySelectorAll('svg .hit')) {
    h.addEventListener('pointerenter', () => show(h));
    h.addEventListener('focus', () => show(h));
    h.addEventListener('pointerleave', hide);
    h.addEventListener('blur', hide);
  }
})();
</script>
</body>
</html>
`
}
