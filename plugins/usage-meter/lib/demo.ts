// Sample data for the pane (`/usage-meter demo`): a made-up chat of ten
// messages and three other chats, with the weekly estimate calibrated, so the
// pane can be seen whole, the weekly split by chat included, before a person's
// own data gets there. The pane says it is sample data while it shows it.
// Display only: nothing here reaches the ledger, the calibration or the store.

import type { MeasureState, MeterRow, MeterView, WeeklyState } from '../types/index.d.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** What the pane draws in place of the chat's own state. */
export type DemoPane = { view: MeterView; calib: WeeklyState; measure: MeasureState; ownUsd: number; ownKey: string }

/** The made-up chat's messages: what was asked, what it cost, and how much of that was your message. */
const MESSAGES: { prompt: string; total: number; you: number; reqs: number; agentReqs?: number; agents?: number }[] = [
  { prompt: 'Sketch a per-message usage meter', total: 12.4, you: 0.9, reqs: 14 },
  { prompt: 'Split each message into you and Claude', total: 8.6, you: 0.7, reqs: 9 },
  { prompt: 'Draw the cost chart', total: 31.2, you: 1.6, reqs: 22, agentReqs: 18, agents: 2 },
  { prompt: 'Why did that one cost so much?', total: 46.8, you: 21.0, reqs: 16 },
  { prompt: 'Add a countdown for the cache', total: 9.4, you: 0.8, reqs: 10 },
  { prompt: 'Estimate the weekly share', total: 52.3, you: 2.1, reqs: 31, agentReqs: 24, agents: 3 },
  { prompt: 'Pool the estimate across chats', total: 38.7, you: 1.9, reqs: 26 },
  { prompt: 'Split the weekly bar by chat', total: 21.5, you: 1.3, reqs: 18 },
  { prompt: 'Give each chat its own color', total: 14.9, you: 1.1, reqs: 12 },
  { prompt: 'Take a screenshot for the README', total: 12.2, you: 1.0, reqs: 11 },
]

/** The other chats on the made-up computer this week. */
const OTHERS: { id: string; title: string; usd: number; daysAgo: number }[] = [
  { id: 'demo-chat-a', title: 'Fix the flaky parser test', usd: 120, daysAgo: 3 },
  { id: 'demo-chat-b', title: 'Write the release notes', usd: 80, daysAgo: 2 },
  { id: 'demo-chat-c', title: 'Plan the next milestone', usd: 45, daysAgo: 1 },
]

/** The cold message: you were away 2h 13m, past the 1-hour cache. */
const COLD = 3

export function demoPane(now: number): DemoPane {
  const first = now - (MESSAGES.length * 22 + 15) * MIN
  const rows: MeterRow[] = MESSAGES.map((m, i) => {
    const cold = i === COLD
    const tokens = Math.round(m.total * 160_000)
    const row: MeterRow = {
      id: `demo-${i + 1}`,
      n: i + 1,
      at: first + i * 22 * MIN,
      prompt: m.prompt,
      origin: 'human',
      you: m.you,
      claude: Math.round((m.total - m.you) * 100) / 100,
      total: m.total,
      youRead: cold ? 0 : 236_000 + i * 18_000,
      youWrite: cold ? 236_000 : 2_400,
      out: Math.round(tokens * 0.012),
      tokens,
      mainReqs: m.reqs,
      agentReqs: m.agentReqs ?? 0,
      agents: m.agents ?? 0,
      advisorReqs: 0,
      cache: i === 0 ? 'first' : cold ? 'cold' : 'warm',
      rewritten: cold ? 236_000 : 0,
      penalty: cold ? 18.4 : 0,
      midTurn: [],
      agentCold: { count: 0, penalty: 0 },
    }
    if (cold) {
      row.reason = 'idle'
      row.idleMs = 2 * HOUR + 13 * MIN
    }
    return row
  })
  const sum = (f: (r: MeterRow) => number) => Math.round(rows.reduce((s, r) => s + f(r), 0) * 100) / 100
  const ownUsd = sum(r => r.total)
  const view: MeterView = {
    rows,
    hiddenRows: 0,
    totals: {
      usd: ownUsd,
      you: sum(r => r.you),
      claude: sum(r => r.claude),
      penalty: sum(r => r.penalty),
      cold: 1,
      midTurnCold: 0,
      agentCold: 0,
      tokens: rows.reduce((s, r) => s + r.tokens, 0),
      requests: rows.reduce((s, r) => s + r.mainReqs + r.agentReqs, 0),
      messages: rows.length,
    },
    lastMain: { at: now - 18 * MIN, model: 'claude-opus-5-5', input: 2, read: 420_000, write: 3_000, output: 1_800 },
    ttl: '1h',
    source: 'transcript',
    builtAt: now,
  }
  // The week resets in three days and some hours, on the hour; 62% of it is used.
  const resets = Math.ceil((now + 3 * DAY + 5 * HOUR) / HOUR) * HOUR
  const start = resets - 7 * DAY
  const latest = { pct: 62, resets, at: now - 2 * MIN }
  const calib: WeeklyState = {
    ready: true,
    pointsPerUsd: 0.1,
    points: 12,
    usd: 120,
    edgeUsd: 6,
    chats: OTHERS.length + 1,
    stretches: 2,
    from: now - 2 * DAY,
    to: now - HOUR,
    latest,
    week: {
      start,
      chats: [
        { id: 'demo-own', usd: ownUsd, from: first },
        ...OTHERS.map(c => ({ id: c.id, title: c.title, usd: c.usd, from: now - c.daysAgo * DAY })),
      ],
    },
    minPoints: 3,
    at: now,
  }
  const measure: MeasureState = { rateLimits: [{ kind: 'seven_day', percentUsed: latest.pct, resetsAt: new Date(resets).toISOString() }], at: now - MIN }
  return { view, calib, measure, ownUsd, ownKey: 'demo-own' }
}
