// The pure core of the usage meter: token arithmetic, cost, the per-message
// attribution rule, cold-cache detection, plan-limit deltas and formatting.
//
// No imports, no Node, no DOM: the Claude Code mod (a hooks module that runs
// in an environment of its own) and the Node CLI both import this file, so
// keep it to plain TypeScript that Node can run with type stripping (no
// enums, no namespaces, no parameter properties).

/** Token counts of one API request, or a sum of requests, split the way they are priced. */
export type Tokens = {
  /** Uncached input: neither read from nor written to the prompt cache. */
  input: number
  /** Input the prompt cache served (the cheap kind). */
  cacheRead: number
  /** Input written to the prompt cache with the 5-minute lifetime. */
  cacheWrite5m: number
  /** Input written to the prompt cache with the 1-hour lifetime. */
  cacheWrite1h: number
  /** Input written to the cache whose lifetime tier is not known (live hook data, old transcripts). */
  cacheWriteUnknown: number
  /** Generated tokens, thinking included. */
  output: number
}

export const ZERO_TOKENS: Tokens = Object.freeze({
  input: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheWriteUnknown: 0,
  output: 0,
})

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    cacheWriteUnknown: a.cacheWriteUnknown + b.cacheWriteUnknown,
    output: a.output + b.output,
  }
}

export function subtractTokens(a: Tokens, b: Tokens): Tokens {
  return {
    input: Math.max(0, a.input - b.input),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
    cacheWrite5m: Math.max(0, a.cacheWrite5m - b.cacheWrite5m),
    cacheWrite1h: Math.max(0, a.cacheWrite1h - b.cacheWrite1h),
    cacheWriteUnknown: Math.max(0, a.cacheWriteUnknown - b.cacheWriteUnknown),
    output: Math.max(0, a.output - b.output),
  }
}

/** All cache writes, whatever their tier. */
export function cacheWrites(t: Tokens): number {
  return t.cacheWrite5m + t.cacheWrite1h + t.cacheWriteUnknown
}

/** Everything the request was sent: uncached input, cache reads and cache writes. */
export function promptTokens(t: Tokens): number {
  return t.input + t.cacheRead + cacheWrites(t)
}

export function totalTokens(t: Tokens): number {
  return promptTokens(t) + t.output
}

/** The input side of a request (what reading the prompt cost); output zeroed. */
export function inputSide(t: Tokens): Tokens {
  return { ...t, output: 0 }
}

/** The output side of a request (what writing the answer cost); input zeroed. */
export function outputSide(t: Tokens): Tokens {
  return { ...ZERO_TOKENS, output: t.output }
}

/**
 * The API's usage object as Claude Code records it (transcript JSONL) or hands
 * it to a hook (TurnUsage / ModelUsage). Every field optional: old builds and
 * the hook shape leave some out.
 */
export type ApiUsage = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null
    ephemeral_1h_input_tokens?: number | null
  } | null
}

function n(x: number | null | undefined): number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0
}

/** Converts an API usage object to Tokens, keeping the 5m/1h split where the object has it. */
export function tokensFromApiUsage(u: ApiUsage | null | undefined): Tokens {
  if (!u) return { ...ZERO_TOKENS }
  const writes = n(u.cache_creation_input_tokens)
  let w5 = n(u.cache_creation?.ephemeral_5m_input_tokens)
  let w1 = n(u.cache_creation?.ephemeral_1h_input_tokens)
  // A split larger than its own total belongs to another pass (refusal fallbacks
  // carry the declined pass's split): trust the total, not the split.
  if (w5 + w1 > writes) {
    w5 = 0
    w1 = 0
  }
  return {
    input: n(u.input_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite5m: w5,
    cacheWrite1h: w1,
    cacheWriteUnknown: Math.max(0, writes - w5 - w1),
    output: n(u.output_tokens),
  }
}

// ---------------------------------------------------------------- pricing

/** US dollars per million tokens. */
export type Rates = {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

export type PriceQuery = {
  /** Fast mode (usage.speed === "fast"), where a model has a premium rate. */
  fast?: boolean
  /** The request's whole prompt, for models whose rate steps up past a size. */
  promptTokens?: number
  /** usage.inference_geo: "us" costs 10% more on Claude 4.6 and later. */
  geo?: string
}

/** A model's rates for one request; `known` is false when the model is not in the table and a fallback was used. */
export type PricedRates = Rates & { known: boolean; label: string }

/** Looks rates up by model id. The pricing table lives in pricing.ts; the core only needs this function. */
export type Pricer = (model: string, q?: PriceQuery) => PricedRates

export type Ttl = '5m' | '1h'

/**
 * Dollars for `t` at `r`. Writes of unknown tier are priced at `assume`: the
 * 5-minute rate by default, as Claude Code's own cost formula does for writes
 * the API did not split by lifetime.
 */
export function costOf(t: Tokens, r: Rates, assume: Ttl = '5m'): number {
  const unknownRate = assume === '5m' ? r.cacheWrite5m : r.cacheWrite1h
  return (
    (t.input * r.input +
      t.output * r.output +
      t.cacheRead * r.cacheRead +
      t.cacheWrite5m * r.cacheWrite5m +
      t.cacheWrite1h * r.cacheWrite1h +
      t.cacheWriteUnknown * unknownRate) /
    1_000_000
  )
}

// ---------------------------------------------------------------- requests and exchanges

/**
 * Where a request came from.
 * main: the conversation's own thread. agent: a subagent or workflow agent.
 * advisor: the advisor model consulted inside a main request.
 * compact: a compaction (summary) request. side: anything else the engine sent (titles, classifiers).
 */
export type RequestKind = 'main' | 'agent' | 'advisor' | 'compact' | 'side'

/** One billed API request (a response), deduplicated. */
export type Req = {
  /** Dedupe key: the API request id, else the message id. */
  key: string
  /** When the response was recorded, ms since the epoch. */
  at: number
  model: string
  tokens: Tokens
  kind: RequestKind
  /** The subagent / workflow agent it ran in; absent on the main thread. */
  agentId?: string
  /** Fast mode. */
  fast?: boolean
  /** usage.inference_geo, when not the default. */
  geo?: string
  /** Web searches the request ran (billed per search). */
  webSearches?: number
  /** True when it came from live hook data rather than the transcript (no 5m/1h split). */
  live?: boolean
  /**
   * When the request ran the executor more than once over the same conversation
   * (around an advisor call), its first and last passes. `tokens` is their sum,
   * which is what is billed; the passes are what the conversation's size and
   * the cache are judged by.
   */
  firstPass?: Tokens
  lastPass?: Tokens
  /** Its output count was only a lower bound in the transcript and was estimated. */
  estimated?: boolean
  /** The first main-thread request after a compaction: the context was rebuilt on purpose, so its cache verdict is a reset. */
  afterCompaction?: boolean
  /**
   * The session id its transcript line carries. A forked session's file starts
   * with the original's history copied in, under the original's id.
   */
  session?: string
  /**
   * When the request was sent, where `at` is later. A cache entry's lifetime
   * runs from the start of the request that writes or reads it, while a
   * transcript's `at` is when the answer's first block was written: after the
   * model began answering, up to minutes later after long thinking. Read from
   * the api-request line Claude Code writes as it sends a request, else from
   * the line the request answers (the prompt or the tool results). See
   * `cacheClock`.
   */
  sentAt?: number
}

/** When a request's cache clock started: when it was sent, else when its answer began. */
export function cacheClock(r: { at: number; sentAt?: number }): number {
  return r.sentAt !== undefined && r.sentAt <= r.at ? r.sentAt : r.at
}

/** Dollars per web search, as the pricing page lists it. */
export const WEB_SEARCH_USD_EACH = 0.01

function queryOf(r: Req): PriceQuery {
  return { fast: r.fast, promptTokens: promptTokens(r.firstPass ?? r.tokens), geo: r.geo }
}

/** One message from the person (or a notification that started a turn) and everything it set off. */
export type Exchange = {
  /** promptId (transcript) or turnId (live). */
  id: string
  /** 1-based position among the session's exchanges. */
  n: number
  /** A short preview of what started it. */
  prompt: string
  /** Who started it: "human", "task-notification", "plugin", ... */
  origin: string
  /** When it started, ms since the epoch. */
  at: number
  /** When its last request finished. */
  endAt?: number
  /** True while the turn is still running (live only). */
  isOpen?: boolean
  reqs: Req[]
  /** A compaction (or /clear) happened since the previous exchange: the cache was rebuilt on purpose. */
  compactedBefore?: boolean
  /** Delivered into a turn already running (a message typed while Claude worked): it started no turn of its own. */
  inTurn?: boolean
  /** The account's plan-limit change while it ran (live only; account-wide). */
  limits?: LimitDelta[]
}

export type Part = {
  tokens: Tokens
  usd: number
  /** Requests that contributed. */
  requests: number
}

export type CacheState =
  /** The first request of a session: nothing to reuse yet. */
  | 'first'
  /** The cache served (most of) the conversation: the cheap path. */
  | 'warm'
  /** The cache served some of it. */
  | 'partial'
  /** The cache had lapsed or was invalidated: the conversation was written again. */
  | 'cold'
  /** A compaction, or a shorter conversation (rewind, cleared tool results), rebuilt the context on purpose. */
  | 'reset'
  /** Too little context to judge, or no main request. */
  | 'none'

/**
 * Why a request found the cache lapsed or rebuilt.
 * idle: the lifetime ran out. model-switch: the model changed (each has its own cache).
 * invalidated: something early in the conversation changed. compaction: a compaction ran.
 * shorter: a much shorter conversation was sent with no compaction recorded (rewind, cleared tool results).
 */
export type CacheReason = 'idle' | 'model-switch' | 'compaction' | 'invalidated' | 'shorter'

export type CacheInfo = {
  state: CacheState
  reason?: CacheReason
  /** Time since the previous main-thread request, ms. */
  idleMs?: number
  /** Prompt tokens the cache could have served (the previous main request's prompt). */
  expected?: number
  /** Prompt tokens it did serve. */
  read: number
  /** Tokens written again that a warm cache would have served. */
  rewritten: number
  /** What re-writing them cost over reading them, $. */
  penaltyUsd: number
}

export type AnalyzeOptions = {
  price: Pricer
  /** The cache lifetime to judge idleness against when the requests do not say (default 1h). */
  ttl?: Ttl
  /**
   * The rate for cache writes the API did not split by lifetime (old transcripts,
   * live hook data). Default 5m, as Claude Code's own cost formula prices them;
   * the mod passes the session's lifetime for live data.
   */
  unknownWrites?: Ttl
}

function emptyPart(): Part {
  return { tokens: { ...ZERO_TOKENS }, usd: 0, requests: 0 }
}

function addTo(part: Part, t: Tokens, usd: number, count: boolean): void {
  part.tokens = addTokens(part.tokens, t)
  part.usd += usd
  if (count) part.requests += 1
}

/** Dollars for one request, priced for its model, mode, size and region; web searches go with the output side. */
export function requestCost(r: Req, price: Pricer, unknownWrites: Ttl = '5m', which: 'all' | 'input' | 'output' = 'all'): number {
  const rates = price(r.model, queryOf(r))
  const t = which === 'input' ? inputSide(r.tokens) : which === 'output' ? outputSide(r.tokens) : r.tokens
  const searches = which === 'input' ? 0 : (r.webSearches ?? 0) * WEB_SEARCH_USD_EACH
  return costOf(t, rates, unknownWrites) + searches
}

export function ttlMs(ttl: Ttl): number {
  return ttl === '5m' ? 5 * 60_000 : 60 * 60_000
}

/** The rate at which a pass's cache writes were billed: its dominant tier, else the assumed one. */
function writeRateOf(t: Tokens, rates: Rates, ttl: Ttl): number {
  if (t.cacheWrite1h > 0 && t.cacheWrite1h >= t.cacheWrite5m) return rates.cacheWrite1h
  if (t.cacheWrite5m > 0) return rates.cacheWrite5m
  return ttl === '5m' ? rates.cacheWrite5m : rates.cacheWrite1h
}

/** Below this many prompt tokens a cache miss is not worth calling out. */
const MIN_JUDGED = 4_096

/** The cache lifetime a request's writes were made with, if it wrote any. */
export function ttlOfWrites(t: Tokens): Ttl | undefined {
  if (t.cacheWrite1h > 0 && t.cacheWrite1h >= t.cacheWrite5m) return '1h'
  if (t.cacheWrite5m > 0) return '5m'
  return undefined
}

/**
 * Judges one request against the previous request of the same thread (the
 * conversation's main thread, or one agent's own chain).
 *
 * A request reads from the cache what the previous request of its thread sent
 * (its whole prompt) while the cache is warm: Claude Code marks the end of each
 * request's messages for caching. So `expected` is the previous request's prompt
 * size, and a request that reads far less than that wrote the conversation again.
 * `ttl` is the lifetime the thread's cache entry was written with, when known.
 */
export function judgeRequest(r: Req | undefined, prev: Req | undefined, compactedBetween: boolean, price: Pricer, ttl: Ttl): CacheInfo {
  if (!r) return { state: 'none', read: 0, rewritten: 0, penaltyUsd: 0 }
  // An advisor request runs the executor twice over the same conversation: the
  // first pass is what reached the cache first, the last pass what the next
  // request builds on.
  const cur = r.firstPass ?? r.tokens
  const before = prev ? prev.lastPass ?? prev.tokens : undefined
  const read = cur.cacheRead
  if (!prev || !before) return { state: 'first', read, rewritten: 0, penaltyUsd: 0 }
  // The cache's clock: from when the previous request was sent to when this one was.
  const idleMs = Math.max(0, cacheClock(r) - cacheClock(prev))
  const expected = promptTokens(before)
  if (compactedBetween) {
    return { state: 'reset', reason: 'compaction', idleMs, expected, read, rewritten: 0, penaltyUsd: 0 }
  }
  // A much shorter conversation on the same model (a rewind, cleared tool
  // results) was rebuilt on purpose. On another model the cold path below runs:
  // the switch threw the cache away whatever the size.
  if (prev.model === r.model && expected >= MIN_JUDGED && promptTokens(cur) < expected * 0.75) {
    return { state: 'reset', reason: 'shorter', idleMs, expected, read, rewritten: 0, penaltyUsd: 0 }
  }
  if (expected < MIN_JUDGED) return { state: 'none', idleMs, expected, read, rewritten: 0, penaltyUsd: 0 }
  const ratio = read / expected
  const state: CacheState = ratio >= 0.7 ? 'warm' : ratio <= 0.3 ? 'cold' : 'partial'
  if (state === 'warm') return { state, idleMs, expected, read, rewritten: 0, penaltyUsd: 0 }
  const rewritten = Math.max(0, Math.min(cacheWrites(cur) + cur.input, expected - read))
  const rates = price(r.model, queryOf(r))
  const penaltyUsd = (rewritten * Math.max(0, writeRateOf(cur, rates, ttl) - rates.cacheRead)) / 1_000_000
  // The lifetime runs from the start of the previous request, and a request's
  // time is recorded when its response has begun arriving: a long response
  // (tens of thousands of tokens of thinking) eats the lifetime too.
  // ~100 tokens a second is a deliberately quick guess at the generation speed.
  const sincePrevStart = idleMs + (before.output / 100) * 1000
  const reason: CacheReason =
    prev.model !== r.model ? 'model-switch' : sincePrevStart >= ttlMs(ttl) - 30_000 ? 'idle' : 'invalidated'
  return { state, reason, idleMs, expected, read, rewritten, penaltyUsd }
}

/** Judges the first request of an exchange (your message) against the previous main-thread request. */
export function judgeCache(step0: Req | undefined, prev: Req | undefined, ex: Exchange, price: Pricer, ttl: Ttl): CacheInfo {
  return judgeRequest(step0, prev, !!ex.compactedBefore, price, ttl)
}

/** A request, after the first of an exchange, that found the cache lapsed: mid-turn on the main thread, or in an agent. */
export type ColdEvent = CacheInfo & {
  /** The request that found the cache lapsed (counting a lapse once across resumed copies goes by it). */
  key: string
  at: number
  /** "main": after a wait inside the turn (a question or permission prompt pending, or a long tool). "agent": inside a subagent or workflow agent. */
  thread: 'main' | 'agent'
  agentId?: string
}

/** Where each thread left off: its last request and the lifetime its cache entry was written with. */
export type ThreadState = Map<string, { last: Req; ttl?: Ttl }>

function threadKey(r: Req): string | undefined {
  if (r.kind === 'main') return 'main'
  if (r.kind === 'agent') return `agent:${r.agentId ?? '?'}`
  return undefined
}

export type ExchangeReport = {
  ex: Exchange
  /** Your message: the first request's input side (reading the conversation plus your new message). */
  you: Part
  /** Claude's reply: the first request's output plus every later request, subagents and advisor included. */
  claude: Part & { mainRequests: number; agentRequests: number; agents: number; advisorRequests: number }
  total: Part
  /** How the cache served your message (the exchange's first request). */
  cache: CacheInfo
  /** Later requests in the exchange that found their cache lapsed (cold or partial). */
  coldLater: ColdEvent[]
  /** Everything the exchange lost to lapsed caches: your message's plus the later ones, $. */
  penaltyUsd: number
  /** Models that were not in the price table (priced at a fallback). */
  unknownModels: string[]
  /** Requests whose output was estimated (the transcript held only a lower bound): Claude's figures are then approximate. */
  estimatedRequests: number
  /** The key of the first main-thread request, the one `cache` judged. */
  firstKey?: string
}

/**
 * The attribution rule, one exchange at a time:
 * - your message = the input side of the first main-thread request (the conversation
 *   so far plus your new message, read from or written to the cache);
 * - Claude's reply = that request's output plus every later request of the exchange:
 *   tool-loop requests, subagents and workflow agents, the advisor, compaction.
 * `threads` carries each thread's previous request in from earlier exchanges and is
 * updated in place, so every request is judged against its own thread's predecessor.
 */
export function analyzeExchange(ex: Exchange, threads: ThreadState, opts: AnalyzeOptions): ExchangeReport {
  const ttl = opts.ttl ?? '1h'
  const unknownWrites = opts.unknownWrites ?? '5m'
  const price = opts.price
  const reqs = [...ex.reqs].sort((a, b) => a.at - b.at)
  const mains = reqs.filter(r => r.kind === 'main')
  const step0 = mains[0]
  const you = emptyPart()
  const claude = { ...emptyPart(), mainRequests: mains.length, agentRequests: 0, agents: 0, advisorRequests: 0 }
  const total = emptyPart()
  const agentIds = new Set<string>()
  const unknown = new Set<string>()
  const coldLater: ColdEvent[] = []
  let cache: CacheInfo = { state: 'none', read: 0, rewritten: 0, penaltyUsd: 0 }
  let estimatedRequests = 0
  for (const r of reqs) {
    const rates = price(r.model, queryOf(r))
    if (!rates.known) unknown.add(r.model)
    if (r.estimated) estimatedRequests += 1
    const all = costOf(r.tokens, rates, unknownWrites) + (r.webSearches ?? 0) * WEB_SEARCH_USD_EACH
    addTo(total, r.tokens, all, true)

    const key = threadKey(r)
    if (key) {
      const was = threads.get(key)
      const lifetime = was?.ttl ?? (r.kind === 'agent' ? '5m' : ttl)
      // A compaction resets the cache on purpose, before your message or mid-turn.
      const compacted = !!r.afterCompaction || (r === step0 && !!ex.compactedBefore)
      const verdict = judgeRequest(r, was?.last, compacted, price, lifetime)
      if (r === step0) cache = verdict
      else if ((verdict.state === 'cold' || verdict.state === 'partial') && verdict.penaltyUsd > 0) {
        coldLater.push({ ...verdict, key: r.key, at: r.at, thread: r.kind === 'main' ? 'main' : 'agent', agentId: r.agentId })
      }
      threads.set(key, { last: r, ttl: ttlOfWrites(r.lastPass ?? r.tokens) ?? was?.ttl })
    }

    if (r === step0) {
      // Your message: the input side of the pass that read it. An advisor
      // request's later passes re-read the conversation for Claude's work.
      const inT = inputSide(r.firstPass ?? r.tokens)
      const inUsd = costOf(inT, rates, unknownWrites)
      addTo(you, inT, inUsd, true)
      addTo(claude, subtractTokens(r.tokens, inT), all - inUsd, true)
      continue
    }
    addTo(claude, r.tokens, all, true)
    if (r.kind === 'agent') {
      claude.agentRequests += 1
      if (r.agentId) agentIds.add(r.agentId)
    }
    if (r.kind === 'advisor') claude.advisorRequests += 1
  }
  claude.agents = agentIds.size
  const penaltyUsd = cache.penaltyUsd + coldLater.reduce((s, c) => s + c.penaltyUsd, 0)
  const rep: ExchangeReport = { ex, you, claude, total, cache, coldLater, penaltyUsd, unknownModels: [...unknown], estimatedRequests }
  if (step0) rep.firstKey = step0.key
  return rep
}

export type SessionReport = {
  reports: ExchangeReport[]
  total: Part
  you: Part
  claude: Part
  /** Dollars lost to lapsed caches over the session, everywhere. */
  penaltyUsd: number
  /** Messages of yours that found the conversation's cache lapsed. */
  coldCount: number
  /** Later main-thread requests that found it lapsed (after a wait inside a turn). */
  midTurnColdCount: number
  /** Agent requests that found their agent's cache lapsed. */
  agentColdCount: number
  lastMain?: Req
  /** The lifetime the conversation's cache was last written with, if the requests say. */
  mainTtl?: Ttl
}

/** Runs analyzeExchange over a session's exchanges in order, carrying each thread's last request along. */
export function analyzeSession(exchanges: readonly Exchange[], opts: AnalyzeOptions, preamble: readonly Req[] = []): SessionReport {
  const threads: ThreadState = new Map()
  for (const r of [...preamble].sort((a, b) => a.at - b.at)) {
    const key = threadKey(r)
    if (key) threads.set(key, { last: r, ttl: ttlOfWrites(r.lastPass ?? r.tokens) ?? threads.get(key)?.ttl })
  }
  const reports: ExchangeReport[] = []
  const total = emptyPart()
  const you = emptyPart()
  const claude = emptyPart()
  let penaltyUsd = 0
  let coldCount = 0
  let midTurnColdCount = 0
  let agentColdCount = 0
  for (const ex of exchanges) {
    const rep = analyzeExchange(ex, threads, opts)
    reports.push(rep)
    addTo(total, rep.total.tokens, rep.total.usd, false)
    total.requests += rep.total.requests
    addTo(you, rep.you.tokens, rep.you.usd, false)
    you.requests += rep.you.requests
    addTo(claude, rep.claude.tokens, rep.claude.usd, false)
    claude.requests += rep.claude.requests
    penaltyUsd += rep.penaltyUsd
    if (rep.cache.state === 'cold') coldCount += 1
    for (const c of rep.coldLater) {
      if (c.thread === 'main') midTurnColdCount += 1
      else agentColdCount += 1
    }
  }
  const main = threads.get('main')
  return { reports, total, you, claude, penaltyUsd, coldCount, midTurnColdCount, agentColdCount, lastMain: main?.last, mainTtl: main?.ttl }
}

export function lastMainOf(reqs: readonly Req[]): Req | undefined {
  let best: Req | undefined
  for (const r of reqs) if (r.kind === 'main' && (!best || r.at >= best.at)) best = r
  return best
}

/** The write lifetime of the last main-thread request that wrote to the cache. */
export function lastWriteTtl(reqs: readonly Req[]): Ttl | undefined {
  let best: Req | undefined
  let found: Ttl | undefined
  for (const r of reqs) {
    if (r.kind !== 'main') continue
    const t = ttlOfWrites(r.lastPass ?? r.tokens)
    if (t && (!best || r.at >= best.at)) {
      best = r
      found = t
    }
  }
  return found
}

// ---------------------------------------------------------------- the next message

export type NextEstimate = {
  /**
   * warm: the next message reads the conversation from the cache; cold: it writes it again.
   * compacted: the conversation was compacted after the last request, so the next message
   * rebuilds the cache from the summary: no figure can be built from the old context.
   */
  state: 'warm' | 'cold' | 'compacted' | 'none'
  ttl: Ttl
  /** Time since the last main-thread request. */
  idleMs: number
  /** While warm: how long the cache has left. */
  msLeft: number
  /** What the next request re-sends: the last request's prompt plus its answer. */
  contextTokens: number
  /** Input-side dollars if the cache is warm. */
  warmUsd: number
  /** Input-side dollars if the cache has lapsed. */
  coldUsd: number
  /** The figure that applies now. */
  usd: number
  model: string
}

/**
 * What sending the next message costs on the input side, now. The cache entry
 * lives `ttl` from the last request that used it; past that the whole context
 * is written again at the cache-write rate instead of read at the cache-read rate.
 * Leaves out the reply (unknowable) and the small new message itself.
 * `compactedAt`: when a compaction ran after `lastMain`, the old context no longer applies.
 */
export function estimateNext(lastMain: Req | undefined, now: number, ttl: Ttl, price: Pricer, compactedAt?: number): NextEstimate {
  if (!lastMain) {
    return { state: 'none', ttl, idleMs: 0, msLeft: 0, contextTokens: 0, warmUsd: 0, coldUsd: 0, usd: 0, model: '' }
  }
  // What the next request builds on: the last executor pass of the last request.
  const t = lastMain.lastPass ?? lastMain.tokens
  // The cache's lifetime runs from when the last request was sent, not from when its answer began.
  const idleMs = Math.max(0, now - cacheClock(lastMain))
  if (compactedAt !== undefined && compactedAt > lastMain.at) {
    return { state: 'compacted', ttl, idleMs, msLeft: 0, contextTokens: 0, warmUsd: 0, coldUsd: 0, usd: 0, model: lastMain.model }
  }
  const prompt = promptTokens(t)
  const contextTokens = prompt + t.output
  const rates = price(lastMain.model, { fast: lastMain.fast, promptTokens: contextTokens, geo: lastMain.geo })
  const writeRate = ttl === '5m' ? rates.cacheWrite5m : rates.cacheWrite1h
  const warmUsd = (prompt * rates.cacheRead + t.output * writeRate) / 1_000_000
  const coldUsd = (contextTokens * writeRate) / 1_000_000
  const msLeft = Math.max(0, ttlMs(ttl) - idleMs)
  const state = msLeft > 0 ? 'warm' : 'cold'
  return { state, ttl, idleMs, msLeft, contextTokens, warmUsd, coldUsd, usd: state === 'warm' ? warmUsd : coldUsd, model: lastMain.model }
}

// ---------------------------------------------------------------- plan limits

export type LimitReading = { kind: string; percentUsed: number; resetsAt?: string }

export type LimitDelta = {
  kind: string
  label: string
  before: number
  after: number
  /** Percentage points used while the exchange ran (account-wide). */
  delta: number
  /** The window reset in between; `delta` then counts from the reset. */
  didReset: boolean
}

const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly Opus',
  seven_day_sonnet: 'Weekly Sonnet',
  seven_day_fable: 'Weekly Fable',
  spend_limit: 'Spend limit',
}

export function limitLabel(kind: string): string {
  const known = LIMIT_LABELS[kind]
  if (known) return known
  const m = /^seven_day_(.+)$/.exec(kind)
  if (m && m[1]) return `Weekly ${m[1].charAt(0).toUpperCase()}${m[1].slice(1).replace(/_/g, ' ')}`
  return kind.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
}

/**
 * Percentage-point change of each window between two readings. A window is the
 * same window while its reset time is: a later reset time means it rolled over
 * in between, and the change then counts from the reset (the new reading).
 */
/** A reading this many points below the one before it, in the same window, is a reset inside the week (as lib/weekly.ts's RESET_DROP; both files stay free of imports). */
const RESET_DROP = 2

export function limitDeltas(before: readonly LimitReading[], after: readonly LimitReading[]): LimitDelta[] {
  const out: LimitDelta[] = []
  for (const a of after) {
    const b = before.find(x => x.kind === a.kind)
    if (!b) continue
    const bReset = b.resetsAt ? Date.parse(b.resetsAt) : NaN
    const aReset = a.resetsAt ? Date.parse(a.resetsAt) : NaN
    // A new window, or within the same one a reading that dropped (a reset inside the week: the
    // whole limit's, or one model's part of it, as a Fable reset); without reset times, any drop.
    const didReset =
      Number.isFinite(aReset) && Number.isFinite(bReset)
        ? aReset > bReset + 60_000 || a.percentUsed <= b.percentUsed - RESET_DROP
        : a.percentUsed < b.percentUsed
    const delta = didReset ? a.percentUsed : a.percentUsed - b.percentUsed
    out.push({ kind: a.kind, label: limitLabel(a.kind), before: b.percentUsed, after: a.percentUsed, delta: Math.round(delta * 10) / 10, didReset })
  }
  return out
}

// ---------------------------------------------------------------- formatting

export function fmtUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  if (usd < 10) return `$${usd.toFixed(2)}`
  if (usd < 1000) return `$${usd.toFixed(1)}`
  return `$${Math.round(usd).toLocaleString('en-US')}`
}

export function fmtTokens(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return '0'
  if (t < 1000) return String(Math.round(t))
  if (t < 10_000) return `${(t / 1000).toFixed(1)}k`
  if (t < 1_000_000) return `${Math.round(t / 1000)}k`
  if (t < 10_000_000) return `${(t / 1_000_000).toFixed(2)}M`
  return `${(t / 1_000_000).toFixed(1)}M`
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

export function fmtPoints(p: number): string {
  const r = Math.round(p * 10) / 10
  return `${r >= 0 ? '+' : ''}${r}%`
}

/** A one-line, whitespace-collapsed preview of a prompt. */
export function preview(text: string, max = 80): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** A bar of `width` cells, `fraction` of them filled. */
export function bar(fraction: number, width = 10): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0))
  const full = Math.round(f * width)
  return '█'.repeat(full) + '░'.repeat(width - full)
}
