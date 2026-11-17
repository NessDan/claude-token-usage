// The README's history figures, over every session on this machine, each request
// counted once (sessions in creation order, as the CLI's --all does), and each
// lapse counted once, by the request that found the cache lapsed.
// Run: npm run stats (node scripts/history-stats.ts). It only reads the transcripts.
import { listSessions, loadSession } from '../plugins/usage-meter/cli/sessions.ts'
import { priceFor } from '../plugins/usage-meter/lib/pricing.ts'
import { analyzeSession, requestCost } from '../plugins/usage-meter/lib/usage.ts'

const PERSON = new Set(['human', 'composer', 'bridge', 'sdk', 'queued'])
const files = listSessions()
const born = (f: { birthtimeMs: number; mtimeMs: number }) => (f.birthtimeMs > 0 ? f.birthtimeMs : f.mtimeMs)
const sorted = [...files].sort((a, b) => born(a) - born(b) || a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id))

const seen = new Set<string>()
let total = 0
let sessions = 0
let estimated = 0
let requests = 0
const bucket = () => ({ n: 0, usd: 0 })
const b = {
  personIdle: bucket(),
  personOther: bucket(),
  machineIdle: bucket(),
  machineOther: bucket(),
  midTurnIdle: bucket(),
  midTurnOther: bucket(),
  agents: bucket(),
}
const reasons = new Map<string, number>()
let worstReturn = { usd: 0, rewritten: 0, idleMs: 0, id: '' }
let costliestWait = { usd: 0, rewritten: 0, idleMs: 0, id: '' }
let longestWait = { usd: 0, rewritten: 0, idleMs: 0, id: '' }
let worstSession = { usd: 0, id: '' }
const advisor = { n: 0, usd: 0, inAgents: 0 }
const origins = new Map<string, number>()
const bump = (k: string) => reasons.set(k, (reasons.get(k) ?? 0) + 1)

for (const f of sorted) {
  let parsed
  try {
    parsed = loadSession(f).parsed
  } catch (err) {
    console.error(`skipped ${f.id}: ${(err as Error).message}`)
    continue
  }
  sessions += 1
  const rep = analyzeSession(parsed.exchanges, { price: priceFor, ttl: parsed.ttl ?? '1h' }, parsed.preamble)
  let sessionPenalty = 0
  for (const r of rep.reports) {
    const fresh = new Set<string>()
    for (const q of r.ex.reqs) {
      if (seen.has(q.key)) continue
      seen.add(q.key)
      fresh.add(q.key)
      requests += 1
      const usd = requestCost(q, priceFor)
      total += usd
      if (q.kind === 'advisor') {
        advisor.n += 1
        advisor.usd += usd
        if (q.agentId) advisor.inAgents += 1
      }
      if (q.estimated) estimated += 1
    }
    if (fresh.size === 0) continue
    origins.set(r.ex.origin, (origins.get(r.ex.origin) ?? 0) + 1)
    const c = r.cache
    if (r.firstKey && fresh.has(r.firstKey) && (c.state === 'cold' || c.state === 'partial') && c.penaltyUsd > 0) {
      const person = PERSON.has(r.ex.origin)
      const idle = c.reason === 'idle'
      const k = person ? (idle ? 'personIdle' : 'personOther') : idle ? 'machineIdle' : 'machineOther'
      b[k].n += 1
      b[k].usd += c.penaltyUsd
      sessionPenalty += c.penaltyUsd
      bump(`first:${person ? 'person' : 'machine'}:${c.reason}`)
      if (person && idle && c.penaltyUsd > worstReturn.usd) worstReturn = { usd: c.penaltyUsd, rewritten: c.rewritten, idleMs: c.idleMs ?? 0, id: f.id }
    }
    for (const x of r.coldLater) {
      if (!fresh.has(x.key)) continue
      sessionPenalty += x.penaltyUsd
      if (x.thread === 'agent') {
        b.agents.n += 1
        b.agents.usd += x.penaltyUsd
        bump(`agent:${x.reason}`)
        continue
      }
      const idle = x.reason === 'idle'
      const k = idle ? 'midTurnIdle' : 'midTurnOther'
      b[k].n += 1
      b[k].usd += x.penaltyUsd
      bump(`mid:${x.reason}`)
      if (idle && x.penaltyUsd > costliestWait.usd) costliestWait = { usd: x.penaltyUsd, rewritten: x.rewritten, idleMs: x.idleMs ?? 0, id: f.id }
      if (idle && (x.idleMs ?? 0) > longestWait.idleMs) longestWait = { usd: x.penaltyUsd, rewritten: x.rewritten, idleMs: x.idleMs ?? 0, id: f.id }
    }
  }
  if (sessionPenalty > worstSession.usd) worstSession = { usd: sessionPenalty, id: f.id }
}

const lost = Object.values(b).reduce((s, x) => s + x.usd, 0)
const r2 = (x: number) => Math.round(x * 100) / 100
const hours = (ms: number) => Math.round(ms / 360_000) / 10
console.log(JSON.stringify({
  sessions,
  requests,
  totalUsd: r2(total),
  lostUsd: r2(lost),
  lostPct: Math.round((lost / total) * 1000) / 10,
  buckets: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { n: v.n, usd: r2(v.usd) }])),
  reasons: Object.fromEntries(reasons),
  worstReturn: { ...worstReturn, usd: r2(worstReturn.usd), idleH: hours(worstReturn.idleMs) },
  costliestWait: { ...costliestWait, usd: r2(costliestWait.usd), idleH: hours(costliestWait.idleMs) },
  longestWait: { ...longestWait, usd: r2(longestWait.usd), idleH: hours(longestWait.idleMs) },
  worstSession: { ...worstSession, usd: r2(worstSession.usd) },
  advisor: { ...advisor, usd: r2(advisor.usd), each: advisor.n ? r2(advisor.usd / advisor.n) : 0 },
  estimatedRequests: estimated,
  origins: Object.fromEntries(origins),
}, null, 1))
