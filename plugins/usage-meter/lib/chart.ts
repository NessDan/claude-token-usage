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
const MUTED = '#898781'
const GRID = 'rgba(137,135,129,0.28)'

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
  for (const t of [0, max / 2, max]) {
    const yy = y(t).toFixed(1)
    parts.push(`<line x1="${left}" x2="${width - right}" y1="${yy}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>`)
    parts.push(`<text x="${left - 5}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end" font-size="9" fill="${MUTED}">${esc(t === 0 ? '$0' : fmtUsd(t))}</text>`)
  }
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
