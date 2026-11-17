// A compact SVG of the latest messages for the desktop pane: one stacked
// column per message (your message at the bottom, Claude's reply on top), a
// warning mark over the ones that hit a lapsed cache, a <title> tooltip per
// column. Pure string building; colors are fixed (the pane's Svg is drawn in a
// frame of its own) and chosen to read on light and dark surfaces alike.

import type { MeterRow } from '../types/index.d.ts'
import { fmtUsd } from './usage.ts'

export const YOU_COLOR = '#3987e5'
export const CLAUDE_COLOR = '#eb6834'
export const WARN_COLOR = '#fab219'
/** A calm fill for meters that carry no series (the cache countdown, a plan limit). */
export const NEUTRAL_COLOR = '#9a978f'
const MUTED = '#898781'
const GRID = 'rgba(137,135,129,0.28)'
/** The faint rail a meter or bar sits on, readable on light and dark surfaces. */
const TRACK = 'rgba(137,135,129,0.22)'

function px(n: number): string {
  return n.toFixed(2)
}

function svgDoc(width: number, height: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px(width)}" height="${height}" viewBox="0 0 ${px(width)} ${height}">${body}</svg>`
}

/**
 * A word-sized bar of one split: your message (blue) and Claude's reply
 * (orange), 2 px apart, ends rounded. `length` (0 to 1) is how much of the
 * width it fills, so rows can be compared at a glance; `track` draws the rest
 * of the width as a faint rail.
 */
export function splitBarSvg(you: number, claude: number, width: number, height: number, length = 1, track = false): string {
  const r = height / 2
  const w = Math.max(0, Math.min(1, length)) * width
  const parts: string[] = []
  if (track) parts.push(`<rect x="0" y="0" width="${px(width)}" height="${height}" rx="${r}" fill="${TRACK}"/>`)
  const a = Math.max(0, you)
  const b = Math.max(0, claude)
  const total = a + b
  if (total > 0 && w >= 1) {
    const both = a > 0 && b > 0 && w >= 8
    const gap = both ? 2 : 0
    const avail = Math.max(0, w - gap)
    // A part that is not zero keeps at least 2 px, so it stays visible.
    let wa = both ? Math.min(Math.max((a / total) * avail, 2), avail - 2) : a >= b ? avail : 0
    const wb = both ? avail - wa : a >= b ? 0 : avail
    if (!both && a >= b) wa = avail
    parts.push(`<clipPath id="c"><rect x="0" y="0" width="${px(w)}" height="${height}" rx="${r}"/></clipPath><g clip-path="url(#c)">`)
    if (wa > 0) parts.push(`<rect x="0" y="0" width="${px(wa)}" height="${height}" fill="${YOU_COLOR}"/>`)
    if (wb > 0) parts.push(`<rect x="${px(wa + gap)}" y="0" width="${px(wb)}" height="${height}" fill="${CLAUDE_COLOR}"/>`)
    parts.push('</g>')
  }
  return svgDoc(width, height, parts.join(''))
}

/** A thin meter: a faint rail with `fraction` of it filled. */
export function meterSvg(fraction: number, width: number, height: number, fill: string): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0))
  const r = height / 2
  const w = f * width
  const filled = w >= 0.5 ? `<rect x="0" y="0" width="${px(Math.max(w, height))}" height="${height}" rx="${r}" fill="${fill}"/>` : ''
  return svgDoc(width, height, `<rect x="0" y="0" width="${px(width)}" height="${height}" rx="${r}" fill="${TRACK}"/>${filled}`)
}

/** The account's use of the weekly limit, under this chat's slice. */
const USED = 'rgba(154,151,143,0.55)'

/**
 * The weekly limit as one meter: the faint rail is the whole limit, the gray
 * part what the account has used of it this week (`used`, 0 to 1; undefined
 * when there is no reading in this week yet), and on top, from the left, this
 * chat's share (`you` + `claude`, fractions of the limit), split as your
 * messages (blue) and Claude's replies (orange).
 */
export function weekMeterSvg(you: number, claude: number, used: number | undefined, width: number, height: number): string {
  const f = (x: number | undefined) => Math.max(0, Math.min(1, x !== undefined && Number.isFinite(x) ? x : 0))
  const r = height / 2
  const parts = [`<rect x="0" y="0" width="${px(width)}" height="${height}" rx="${r}" fill="${TRACK}"/>`]
  const a = f(you) * width
  const b = f(claude) * width
  const chat = Math.min(width, a + b)
  const u = Math.max(f(used) * width, chat)
  if (u >= 0.5) parts.push(`<rect x="0" y="0" width="${px(Math.max(u, height))}" height="${height}" rx="${r}" fill="${USED}"/>`)
  if (chat > 0) {
    // A slice too thin to see keeps 3 px; the figure beside the meter says how big it is.
    const w = Math.max(chat, 3)
    const both = a > 0 && b > 0 && w >= 8
    const gap = both ? 1.5 : 0
    const wa = both ? Math.min(Math.max((a / (a + b)) * (w - gap), 2), w - gap - 2) : a >= b ? w : 0
    const wb = both ? w - gap - wa : a >= b ? 0 : w
    parts.push(`<clipPath id="c"><rect x="0" y="0" width="${px(w)}" height="${height}" rx="${r}"/></clipPath><g clip-path="url(#c)">`)
    if (wa > 0) parts.push(`<rect x="0" y="0" width="${px(wa)}" height="${height}" fill="${YOU_COLOR}"/>`)
    if (wb > 0) parts.push(`<rect x="${px(wa + gap)}" y="0" width="${px(wb)}" height="${height}" fill="${CLAUDE_COLOR}"/>`)
    parts.push('</g>')
  }
  return svgDoc(width, height, parts.join(''))
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function niceTop(max: number): number {
  if (max <= 0) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(max)))
  for (const f of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (max <= f * pow) return f * pow
  return 10 * pow
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h))
  return `M${x.toFixed(2)},${(y + h).toFixed(2)}V${(y + rr).toFixed(2)}Q${x.toFixed(2)},${y.toFixed(2)} ${(x + rr).toFixed(2)},${y.toFixed(2)}H${(x + w - rr).toFixed(2)}Q${(x + w).toFixed(2)},${y.toFixed(2)} ${(x + w).toFixed(2)},${(y + rr).toFixed(2)}V${(y + h).toFixed(2)}Z`
}

/** Whether a message hit a lapsed cache, on your message or mid-turn. */
export function isColdRow(r: MeterRow): boolean {
  return r.cache === 'cold' || r.midTurn.length > 0
}

export function miniChartSvg(rows: readonly MeterRow[], width = 360, height = 120): string {
  const list = rows.slice(-40)
  const n = list.length
  const left = 34
  const right = 4
  const top = 10
  const bottom = 16
  const plotW = width - left - right
  const plotH = height - top - bottom
  const max = niceTop(Math.max(...list.map(r => r.total), 0))
  const y = (v: number) => top + plotH - (v / max) * plotH
  const band = n ? plotW / n : plotW
  const barW = Math.max(2, Math.min(14, band * 0.62))
  const parts: string[] = []
  // One faint line at the top value; the baseline is drawn after the bars.
  parts.push(`<line x1="${left}" x2="${width - right}" y1="${y(max).toFixed(1)}" y2="${y(max).toFixed(1)}" stroke="${GRID}" stroke-width="1" stroke-dasharray="2 3"/>`)
  parts.push(`<text x="${left - 5}" y="${(y(max) + 3.5).toFixed(1)}" text-anchor="end" font-size="9" fill="${MUTED}">${esc(fmtUsd(max))}</text>`)
  parts.push(`<text x="${left - 5}" y="${(y(0) + 3.5).toFixed(1)}" text-anchor="end" font-size="9" fill="${MUTED}">$0</text>`)
  list.forEach((r, i) => {
    const cx = left + band * i + band / 2
    const x = cx - barW / 2
    const yYou = y(r.you)
    const hYou = top + plotH - yYou
    const yTot = y(r.total)
    const gap = hYou > 0.5 && r.claude > 0 ? 1.5 : 0
    const hClaude = Math.max(0, yYou - yTot - gap)
    const tip = `#${r.n}: you ${fmtUsd(r.you)}, Claude ${r.estimated ? '≈' : ''}${fmtUsd(r.claude)}${isColdRow(r) ? ' - cache had lapsed' : ''}\n${r.prompt.slice(0, 80)}`
    parts.push(`<g><title>${esc(tip)}</title>`)
    parts.push(`<rect x="${(left + band * i).toFixed(2)}" y="${top}" width="${band.toFixed(2)}" height="${plotH}" fill="transparent"/>`)
    if (hYou > 0.4) {
      parts.push(
        hClaude > 0.4
          ? `<rect x="${x.toFixed(2)}" y="${yYou.toFixed(2)}" width="${barW.toFixed(2)}" height="${hYou.toFixed(2)}" fill="${YOU_COLOR}"/>`
          : `<path d="${roundedTop(x, yYou, barW, hYou, 3)}" fill="${YOU_COLOR}"/>`,
      )
    }
    if (hClaude > 0.4) parts.push(`<path d="${roundedTop(x, yTot, barW, hClaude, 3)}" fill="${CLAUDE_COLOR}"/>`)
    if (isColdRow(r)) parts.push(`<text x="${cx.toFixed(1)}" y="${Math.max(8, yTot - 3).toFixed(1)}" text-anchor="middle" font-size="8" fill="${WARN_COLOR}">▲</text>`)
    parts.push('</g>')
  })
  parts.push(`<line x1="${left}" x2="${width - right}" y1="${top + plotH}" y2="${top + plotH}" stroke="${MUTED}" stroke-opacity="0.5" stroke-width="1"/>`)
  if (n) {
    parts.push(`<text x="${left}" y="${height - 3}" font-size="9" fill="${MUTED}">#${list[0]!.n}</text>`)
    parts.push(`<text x="${width - right}" y="${height - 3}" text-anchor="end" font-size="9" fill="${MUTED}">#${list[n - 1]!.n}</text>`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="system-ui, -apple-system, Segoe UI, sans-serif">${parts.join('')}</svg>`
}

/** A one-line sparkline of message totals for surfaces without Svg. */
export function sparkline(rows: readonly MeterRow[], width = 30): string {
  const list = rows.slice(-width)
  const max = Math.max(...list.map(r => r.total), 0)
  const glyphs = '▁▂▃▄▅▆▇█'
  return list.map(r => (max > 0 ? glyphs[Math.min(7, Math.floor((r.total / max) * 7.999))] : glyphs[0])).join('')
}
