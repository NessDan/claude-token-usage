// Anthropic first-party list prices, US dollars per million tokens, for turning
// token counts into API-equivalent dollars. On a Claude subscription nobody pays
// these: they are a common scale for comparing messages, nothing more.
//
// Source: https://platform.claude.com/docs/en/about-claude/pricing (fetched
// 2026-11-16) and the fast-mode page. Cache writes are 1.25x input (5-minute
// lifetime) and 2x input (1-hour) on every model; cache reads are 0.1x input
// except where a row says otherwise (0.05x on Opus 5.5 and Sonnet 5.5, 0.025x
// on Fable/Mythos 5.1 and 5.2). Fast-mode cache rates apply the same
// multipliers to the fast card, as Claude Code's own cost table does.
// The cost formula follows Claude Code 2.1.321's own: writes with no lifetime
// split are priced at the 5-minute rate, inference_geo "us" adds 10%, and each
// web search adds $0.01.

import type { PricedRates, PriceQuery, Rates } from './usage.ts'

type Entry = {
  /** The model id, normalized (see normalizeModel). */
  id: string
  label: string
  rates: Rates
  /** Fast-mode card (usage.speed === "fast"). */
  fast?: Rates
  /** The card for prompts past `over` tokens (input + cache reads + cache writes). */
  long?: { over: number; rates: Rates }
}

/** Writes at 1.25x / 2x input; reads at `readX` times input. */
function card(input: number, output: number, readX = 0.1): Rates {
  return { input, output, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2, cacheRead: round(input * readX) }
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6
}

const TABLE: Entry[] = [
  { id: 'claude-fable-5-2', label: 'Fable 5.2', rates: card(8, 40, 0.025), fast: card(16, 80, 0.025) },
  { id: 'claude-mythos-5-2', label: 'Mythos 5.2', rates: card(8, 40, 0.025), fast: card(16, 80, 0.025) },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', rates: card(10, 50, 0.025) },
  { id: 'claude-mythos-5-1', label: 'Mythos 5.1', rates: card(10, 50, 0.025) },
  { id: 'claude-fable-5', label: 'Fable 5', rates: card(10, 50) },
  { id: 'claude-mythos-5', label: 'Mythos 5', rates: card(10, 50) },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', rates: card(4, 20, 0.05), fast: card(8, 40, 0.05) },
  { id: 'claude-opus-5', label: 'Opus 5', rates: card(5, 25), fast: card(10, 50) },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', rates: card(5, 25), fast: card(10, 50) },
  // Fast mode on 4.6 / 4.7 is gone; Claude Code still prices old fast rows at this legacy card.
  { id: 'claude-opus-4-7', label: 'Opus 4.7', rates: card(5, 25), fast: card(30, 150) },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', rates: card(5, 25), fast: card(30, 150) },
  { id: 'claude-opus-4-5', label: 'Opus 4.5', rates: card(5, 25) },
  { id: 'claude-opus-4-1', label: 'Opus 4.1', rates: card(15, 75) },
  { id: 'claude-opus-4', label: 'Opus 4', rates: card(15, 75) },
  { id: 'claude-3-opus', label: 'Opus 3', rates: card(15, 75) },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', rates: card(2, 10, 0.05) },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', rates: card(2, 10) },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', rates: card(3, 15) },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', rates: card(3, 15) },
  { id: 'claude-sonnet-4', label: 'Sonnet 4', rates: card(3, 15) },
  { id: 'claude-3-7-sonnet', label: 'Sonnet 3.7', rates: card(3, 15) },
  { id: 'claude-3-5-sonnet', label: 'Sonnet 3.5', rates: card(3, 15) },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', rates: card(0.1, 0.5), long: { over: 100_000, rates: card(0.5, 2.5) } },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', rates: card(1, 5) },
  { id: 'claude-3-5-haiku', label: 'Haiku 3.5', rates: card(0.8, 4) },
  { id: 'claude-3-haiku', label: 'Haiku 3', rates: card(0.25, 1.25) },
]

const BY_ID = new Map(TABLE.map(e => [e.id, e]))

/** Priced as Opus 5.5 (the default model) when the model is not in the table, and flagged. */
const FALLBACK: Entry = { id: '', label: 'unknown model (priced as Opus 5.5)', rates: card(4, 20, 0.05) }

/**
 * Reduces a model id to the family id the table is keyed by: drops a "[1m]"
 * tag, provider prefixes (us./eu./global./anthropic.), Bedrock "-v1:0" and
 * Vertex "@date" suffixes, a trailing "-YYYYMMDD" date and Foundry's "-fast",
 * and maps Claude Code's "-0" catalog ids (claude-opus-4-0).
 */
export function normalizeModel(model: string): { id: string; fast: boolean } {
  let m = model.trim().toLowerCase()
  m = m.replace(/\[[^\]]*\]$/, '')
  m = m.replace(/^(?:us|eu|apac|jp|au|global)\./, '').replace(/^anthropic\./, '')
  m = m.replace(/@.*$/, '')
  m = m.replace(/-v\d+(?::\d+)?$/, '')
  m = m.replace(/-\d{8}$/, '')
  let fast = false
  if (m.endsWith('-fast')) {
    fast = true
    m = m.slice(0, -'-fast'.length)
  }
  m = m.replace(/^(claude-(?:opus|sonnet|haiku)-4)-0$/, '$1')
  return { id: m, fast }
}

export function findEntry(model: string): Entry | undefined {
  const { id } = normalizeModel(model)
  const exact = BY_ID.get(id)
  if (exact) return exact
  // Aliases a session may report instead of an id.
  if (id === 'opus' || id === 'opusplan') return BY_ID.get('claude-opus-5-5')
  if (id === 'sonnet') return BY_ID.get('claude-sonnet-5-5')
  if (id === 'haiku') return BY_ID.get('claude-haiku-5-5')
  if (id === 'fable') return BY_ID.get('claude-fable-5-2')
  return undefined
}

/** The rates a request is billed at, by model, fast mode, prompt size and inference region. */
export function priceFor(model: string, q: PriceQuery = {}): PricedRates {
  const entry = findEntry(model)
  const e = entry ?? FALLBACK
  const fast = q.fast || normalizeModel(model).fast
  let rates = e.rates
  if (fast && e.fast) rates = e.fast
  else if (e.long && (q.promptTokens ?? 0) > e.long.over) rates = e.long.rates
  if (q.geo === 'us') {
    rates = {
      input: rates.input * 1.1,
      output: rates.output * 1.1,
      cacheRead: rates.cacheRead * 1.1,
      cacheWrite5m: rates.cacheWrite5m * 1.1,
      cacheWrite1h: rates.cacheWrite1h * 1.1,
    }
  }
  return { ...rates, known: entry !== undefined, label: e.label }
}

/** Dollars per web search (usage.server_tool_use.web_search_requests). */
export const WEB_SEARCH_USD = 0.01

/** A short display name for a model id. */
/** A model's display name; one missing from the price table says how it was priced. */
export function modelLabel(model: string): string {
  const e = findEntry(model)
  if (e) return e.label
  return !model || model === 'mixed' ? model : `${model} (not in the price table: priced as Opus 5.5)`
}

export const PRICES_AS_OF = 'Nov 2026'
