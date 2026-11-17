// The usage meter's state contract: every value the mod keeps in $.state.
// Self-contained on purpose (a contract holds no import or reference).

/** One request as the pane lists it under an expanded message. */
export type MeterReq = {
  at: number
  kind: 'main' | 'agent' | 'advisor' | 'compact' | 'side'
  model: string
  /** Tokens read from the prompt cache. */
  read: number
  /** Tokens written to the prompt cache. */
  write: number
  /** Input sent without the cache (an advisor run reads the whole conversation this way). */
  uncached?: number
  out: number
  usd: number
  /** An agent's id, or a label for an aggregated line. */
  agent?: string
  /** Requests an aggregated line stands for. */
  count?: number
}

/** One message (an exchange: your message and everything it set off), as drawn. */
export type MeterRow = {
  id: string
  n: number
  at: number
  prompt: string
  /** "human", "task-notification", "queued", ... */
  origin: string
  /** Counted from live hook data, not yet from the transcript. */
  live?: boolean
  /** The turn is still running. */
  open?: boolean
  /** API-equivalent dollars: your message (the first request's input side), Claude's reply, both. */
  you: number
  claude: number
  total: number
  /** Your message's first request: tokens read from the cache, and written to it (with uncached input). */
  youRead: number
  youWrite: number
  /** Output tokens over the exchange. */
  out: number
  /** All tokens over the exchange. */
  tokens: number
  mainReqs: number
  agentReqs: number
  agents: number
  advisorReqs: number
  cache: 'first' | 'warm' | 'partial' | 'cold' | 'reset' | 'none'
  reason?: 'idle' | 'model-switch' | 'compaction' | 'invalidated' | 'shorter'
  idleMs?: number
  /** Delivered into a turn already running (typed while Claude worked): it started no turn of its own. */
  inTurn?: boolean
  /** Some of its requests' output was estimated (the transcript held only a lower bound). */
  estimated?: boolean
  /** Tokens your message wrote again because the cache had lapsed. */
  rewritten: number
  /** Dollars the exchange lost to lapsed caches, everywhere. */
  penalty: number
  /**
   * Later main-thread requests that found the cache lapsed, with why: `idle` is a
   * wait past the cache's lifetime (a question or permission prompt, a long tool).
   */
  midTurn: { idleMs: number; rewritten: number; penalty: number; reason?: 'idle' | 'model-switch' | 'compaction' | 'invalidated' | 'shorter' }[]
  agentCold: { count: number; penalty: number }
  /**
   * The account's plan-limit change from the reading before the message to the
   * end of its turn (live only, account-wide). `since`: when that reading was
   * taken, if well before the message (other use in between is included).
   */
  limits?: { label: string; delta: number; didReset: boolean; now?: number }[]
  limitsSince?: number
  /** Per-request lines, kept for the newest messages only. */
  detail?: MeterReq[]
}

export type MeterTotals = {
  usd: number
  you: number
  claude: number
  penalty: number
  cold: number
  midTurnCold: number
  agentCold: number
  tokens: number
  requests: number
  messages: number
}

/** The last main-thread request: what the next message re-sends, and since when the cache has been idle. */
export type MeterLastMain = {
  at: number
  model: string
  input: number
  read: number
  write: number
  output: number
  fast?: boolean
  geo?: string
}

/** Everything the pane and the band draw. */
export type MeterView = {
  sessionId?: string
  title?: string
  /** Oldest first; capped, the oldest left out. */
  rows: MeterRow[]
  hiddenRows: number
  totals: MeterTotals
  lastMain?: MeterLastMain
  ttl: '5m' | '1h'
  source: 'transcript' | 'live' | 'none'
  note?: string
  builtAt: number
  /** A compaction ran after the last main-thread request: the next message rebuilds from the summary. */
  compactedAt?: number
  /** Requests in the view whose output was estimated (see MeterRow.estimated). */
  estimatedRequests?: number
  /**
   * The session's own spend by the minute, encoded (lib/weekly.ts), for the
   * weekly-share ledger. Only a transcript's view has it; the drawn view does not.
   */
  spend?: string
}

/** The weekly-share calibration as last worked out from every chat's ledger (lib/weekly.ts). */
export type WeeklyState = {
  /** Enough data for an estimate. */
  ready: boolean
  /** Weekly percentage points per API-equivalent dollar spent on this computer. */
  pointsPerUsd: number
  /** Weekly points measured, and what the chats here spent over the same stretches. */
  points: number
  usd: number
  /** Spend inside the anchors' brackets: how far the stretches' ends could be off, $. */
  edgeUsd: number
  /** Chats whose spend fell in those stretches. */
  chats: number
  stretches: number
  /** The first and last anchor used. */
  from?: number
  to?: number
  /** Points needed before the estimate is shown. */
  minPoints: number
  /** When it was worked out. */
  at: number
}

/** A request seen live (turn.step), before the transcript has it. */
export type LiveReq = {
  key: string
  /** When the request was sent. */
  at: number
  /** When its response had finished. */
  end?: number
  model: string
  input: number
  output: number
  read: number
  write: number
  kind: 'main' | 'agent' | 'compact'
  agentId?: string
}

export type LiveExchange = {
  id: string
  at: number
  prompt: string
  origin: string
  open: boolean
  endAt?: number
  reqs: LiveReq[]
  /** Not opened by a turn.start this load heard (background agents' steps, a turn running when the meter loaded): dropped once the transcript is read. */
  partial?: boolean
}

export type LiveState = {
  /** Exchanges seen live since the transcript was last read, oldest first. */
  exchanges: LiveExchange[]
  /**
   * The exchange each agent belongs to: the turn that started or resumed it, as
   * `agent.spawn` was raised, else the one it was first heard in.
   */
  agentHome: Record<string, string>
  /** The exchange that launched or resumed each workflow run, by run id. */
  runHome?: Record<string, string>
  /** Requests the transcript never records (compaction's summary request), shown as rows of their own. */
  extras: LiveReq[]
  /** When the main conversation was last compacted, as heard live. */
  compactedAt?: number
}

export type LimitReadingState = { kind: string; percentUsed: number; resetsAt?: string }

export type LimitLogEntry = {
  /** When the turn started, ms. */
  at: number
  deltas: { label: string; delta: number; didReset: boolean; now?: number }[]
  /** When the "before" reading was taken, when that was well before the turn (0: unknown). */
  since?: number
}

export type MeasureState = {
  rateLimits: LimitReadingState[]
  costUsd?: number
  at: number
}

export type TranscriptRef = { path: string; sessionId: string }

export type MeterUi = {
  /** Messages whose request list is open, by row id. */
  expanded: string[]
  bandHidden: boolean
  /** No usage line beneath Claude's answers. */
  notesHidden: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      view: Shaped<MeterView | null>
      live: Shaped<LiveState>
      limitLog: Shaped<LimitLogEntry[]>
      measure: Shaped<MeasureState | null>
      transcript: TranscriptRef | null
      ui: Shaped<MeterUi>
      tick: number
      weekly: Shaped<WeeklyState | null>
    }
  }
}
