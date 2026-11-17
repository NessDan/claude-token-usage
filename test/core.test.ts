// Unit tests for the usage meter's core library, on synthetic transcripts
// shaped like Claude Code 2.1.3xx writes them.  Run: npm test

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { htmlReport } from '../plugins/usage-meter/cli/html-report.ts'
import { normalizeModel, priceFor } from '../plugins/usage-meter/lib/pricing.ts'
import { parseTranscript } from '../plugins/usage-meter/lib/transcript.ts'
import type { Req } from '../plugins/usage-meter/lib/usage.ts'
import {
  analyzeSession,
  estimateNext,
  fmtDuration,
  fmtTokens,
  fmtUsd,
  limitDeltas,
  tokensFromApiUsage,
  ZERO_TOKENS,
} from '../plugins/usage-meter/lib/usage.ts'
import { buildTranscriptView, reqOfLive, withLive } from '../plugins/usage-meter/lib/view.ts'

// ---------------------------------------------------------------- builders

const T0 = Date.UTC(2026, 10, 16, 20, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN

let uuidN = 0
const uuid = () => `u-${++uuidN}`

function prompt(at: number, text: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ type: 'user', uuid: uuid(), timestamp: iso(at), isSidechain: false, promptId: 'same-for-every-prompt', origin: { kind: 'human' }, message: { role: 'user', content: text }, ...extra })
}

function toolResult(at: number, toolUseResult: Record<string, unknown>) {
  return JSON.stringify({ type: 'user', uuid: uuid(), timestamp: iso(at), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }, toolUseResult })
}

type U = { in?: number; read?: number; w1h?: number; w5m?: number; out?: number; iterations?: unknown[] }

function usage(u: U) {
  const w1h = u.w1h ?? 0
  const w5m = u.w5m ?? 0
  return {
    input_tokens: u.in ?? 2,
    output_tokens: u.out ?? 100,
    cache_read_input_tokens: u.read ?? 0,
    cache_creation_input_tokens: w1h + w5m,
    cache_creation: { ephemeral_1h_input_tokens: w1h, ephemeral_5m_input_tokens: w5m },
    ...(u.iterations ? { iterations: u.iterations } : {}),
  }
}

/** One assistant line (one content block of a response). */
function reply(at: number, id: string, u: U, opts: { model?: string; sidechain?: boolean; agentId?: string; stop?: string | null; content?: unknown[] } = {}) {
  return JSON.stringify({
    type: 'assistant',
    uuid: uuid(),
    timestamp: iso(at),
    requestId: `req-${id}`,
    isSidechain: !!opts.sidechain,
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    message: {
      id: `msg-${id}`,
      model: opts.model ?? 'claude-opus-5-5',
      role: 'assistant',
      content: opts.content ?? [{ type: 'text', text: 'ok' }],
      stop_reason: opts.stop === undefined ? 'end_turn' : opts.stop,
      usage: usage(u),
    },
  })
}

const lines = (...l: string[]) => l.join('\n')
const req = (r: Partial<Req> & Pick<Req, 'at'>): Req => ({ key: `k${r.at}`, model: 'claude-opus-5-5', kind: 'main', tokens: { ...ZERO_TOKENS }, ...r })

// ---------------------------------------------------------------- parsing

describe('transcript parsing', () => {
  test('a response written as several lines counts once, with its final output', () => {
    const t = parseTranscript(lines(
      prompt(T0, 'hi'),
      reply(T0 + 1000, 'a', { read: 1000, out: 3 }, { stop: null }),
      reply(T0 + 1500, 'a', { read: 1000, out: 3 }, { stop: null }),
      reply(T0 + 2000, 'a', { read: 1000, out: 250 }),
    ))
    assert.equal(t.exchanges.length, 1)
    assert.equal(t.exchanges[0]!.reqs.length, 1)
    assert.equal(t.exchanges[0]!.reqs[0]!.tokens.output, 250)
    assert.equal(t.exchanges[0]!.reqs[0]!.at, T0 + 1000)
    assert.equal(t.mergedLines, 2)
  })

  test('every prompt line starts its own exchange, even with a shared promptId', () => {
    const t = parseTranscript(lines(
      prompt(T0, 'one'),
      reply(T0 + 1000, 'a', { read: 5000 }),
      prompt(T0 + MIN, 'two'),
      reply(T0 + MIN + 1000, 'b', { read: 5000 }),
    ))
    assert.deepEqual(t.exchanges.map(e => e.prompt), ['one', 'two'])
  })

  test('meta lines, tool results, interrupt markers and model-less commands start no row', () => {
    const t = parseTranscript(lines(
      prompt(T0, 'real question'),
      prompt(T0 + 10, 'skill body', { isMeta: true }),
      reply(T0 + 1000, 'a', { read: 5000 }),
      toolResult(T0 + 2000, {}),
      prompt(T0 + 3000, '[Request interrupted by user]', { origin: undefined }),
      prompt(T0 + 4000, '<command-name>/model</command-name><command-args>opus</command-args>', { origin: undefined }),
    ))
    assert.equal(t.exchanges.length, 1)
    assert.equal(t.exchanges[0]!.prompt, 'real question')
  })

  test('a task notification shows its summary; a queued message starts its own row', () => {
    const note = '<task-notification>\n<task-id>w1</task-id>\n<status>completed</status>\n<summary>Workflow "Research" completed</summary>\n</task-notification>'
    const t = parseTranscript(lines(
      prompt(T0, note, { origin: { kind: 'task-notification' } }),
      reply(T0 + 1000, 'a', { read: 5000 }),
      JSON.stringify({ type: 'attachment', uuid: uuid(), timestamp: iso(T0 + 2000), attachment: { type: 'queued_command', prompt: 'also do this' } }),
      reply(T0 + 3000, 'b', { read: 5100 }),
    ))
    assert.deepEqual(t.exchanges.map(e => [e.origin, e.prompt]), [['task-notification', 'Workflow "Research" completed'], ['queued', 'also do this']])
  })

  test('the advisor run inside a request becomes its own request on its own model', () => {
    // As on 2026-11-17: the top level holds the two executor passes only.
    const iterations = [
      { type: 'message', input_tokens: 2, output_tokens: 494, cache_read_input_tokens: 236_726, cache_creation_input_tokens: 1_936, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_936 } },
      { type: 'advisor_message', model: 'claude-fable-5-2', input_tokens: 225_620, output_tokens: 15_937, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { type: 'message', input_tokens: 2, output_tokens: 1_122, cache_read_input_tokens: 238_662, cache_creation_input_tokens: 1_866, cache_creation: { ephemeral_5m_input_tokens: 1_866, ephemeral_1h_input_tokens: 0 } },
    ]
    const top = { in: 4, out: 1_616, read: 475_388, w1h: 1_936, iterations }
    const raw = JSON.parse(reply(T0 + 1000, 'adv', top))
    raw.message.usage.cache_creation_input_tokens = 3_802 // the top level's split covers the first pass only
    const t = parseTranscript(lines(prompt(T0, 'q'), JSON.stringify(raw)))
    const reqs = t.exchanges[0]!.reqs
    assert.equal(reqs.length, 2)
    const main = reqs.find(r => r.kind === 'main')!
    const adv = reqs.find(r => r.kind === 'advisor')!
    assert.equal(main.tokens.output, 1_616)
    assert.equal(main.tokens.cacheWrite1h, 1_936)
    assert.equal(main.tokens.cacheWrite5m, 1_866)
    assert.equal(main.tokens.cacheWriteUnknown, 0)
    assert.equal(adv.model, 'claude-fable-5-2')
    assert.equal(adv.tokens.input, 225_620)
    assert.equal(adv.tokens.output, 15_937)
  })

  test("an advisor call inside an agent is an advisor request, never a lapse in the agent's cache", () => {
    const main = lines(
      prompt(T0, 'start an agent'),
      reply(T0 + 1000, 'a', { read: 5000 }),
      toolResult(T0 + 2000, { status: 'async_launched', agentId: 'ag1' }),
    )
    const iterations = [
      { type: 'message', input_tokens: 2, output_tokens: 300, cache_read_input_tokens: 52_000, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 } },
      { type: 'advisor_message', model: 'claude-fable-5-2', input_tokens: 60_000, output_tokens: 2_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { type: 'message', input_tokens: 2, output_tokens: 400, cache_read_input_tokens: 52_500, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 } },
    ]
    const agent = lines(
      reply(T0 + 10_000, 'x1', { read: 50_000, w5m: 2_000 }, { sidechain: true, agentId: 'ag1' }),
      reply(T0 + 20_000, 'x2', { in: 4, out: 700, read: 104_500, w5m: 800, iterations }, { sidechain: true, agentId: 'ag1' }),
      reply(T0 + 30_000, 'x3', { read: 53_000, w5m: 400 }, { sidechain: true, agentId: 'ag1' }),
    )
    const t = parseTranscript(main, [{ path: 'C:/s/subagents/agent-ag1.jsonl', text: agent }])
    const reqs = t.exchanges[0]!.reqs
    assert.deepEqual(reqs.map(r => r.kind).sort(), ['advisor', 'agent', 'agent', 'agent', 'main'])
    const adv = reqs.find(r => r.kind === 'advisor')!
    assert.equal(adv.model, 'claude-fable-5-2')
    assert.equal(adv.agentId, 'ag1')
    const s = analyzeSession(t.exchanges, { price: priceFor, ttl: '1h' }, t.preamble)
    assert.equal(s.reports[0]!.claude.advisorRequests, 1)
    assert.equal(s.reports[0]!.claude.agentRequests, 3)
    assert.deepEqual(s.reports[0]!.coldLater, [])
    assert.equal(s.agentColdCount, 0)
  })

  test('a refusal fallback: the served pass is the request, the declined pass is billed on its own model', () => {
    const iterations = [
      { type: 'message', model: 'claude-fable-5', input_tokens: 2, output_tokens: 3_092, cache_read_input_tokens: 0, cache_creation_input_tokens: 35_753 },
      { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 2, output_tokens: 800, cache_read_input_tokens: 0, cache_creation_input_tokens: 35_753 },
    ]
    const t = parseTranscript(lines(prompt(T0, 'q'), reply(T0 + 1000, 'f', { out: 800, w5m: 35_753, iterations }, { model: 'claude-opus-5' })))
    const reqs = t.exchanges[0]!.reqs
    assert.equal(reqs.length, 2)
    const served = reqs.find(r => r.kind === 'main')!
    const declined = reqs.find(r => r.kind === 'side')!
    assert.equal(served.model, 'claude-opus-5')
    assert.equal(served.tokens.output, 800)
    assert.equal(declined.model, 'claude-fable-5')
    assert.equal(declined.tokens.output, 3_092)
    assert.equal(declined.key, 'msg-f#declined0')
    // The declined pass is Claude's cost, outside the conversation's cache thread.
    const s = analyzeSession(t.exchanges, { price: priceFor, ttl: '1h' }, t.preamble)
    assert.equal(s.lastMain?.key, 'msg-f')
  })

  test('an output count the file only had a lower bound for is estimated from the content', () => {
    const long = 'x'.repeat(4_000) // ~1,000 tokens
    const t = parseTranscript(lines(
      prompt(T0, 'q'),
      reply(T0 + 1000, 'p', { read: 5000, out: 3 }, { stop: null, content: [{ type: 'text', text: long }] }),
    ))
    assert.equal(t.exchanges[0]!.reqs[0]!.tokens.output, 1_000)
    assert.equal(t.estimatedOutputs, 1)
  })

  test('an agent is charged to the message that launched it, and a resumed agent to the one that resumed it', () => {
    const main = lines(
      prompt(T0, 'start an agent'),
      reply(T0 + 1000, 'a', { read: 5000 }),
      toolResult(T0 + 2000, { status: 'async_launched', agentId: 'ag1' }),
      prompt(T0 + 10 * MIN, 'second message'),
      reply(T0 + 10 * MIN + 1000, 'b', { read: 5200 }),
      toolResult(T0 + 10 * MIN + 2000, { resumedAgentId: 'ag1' }),
    )
    const agent = lines(
      reply(T0 + 5_000, 'x1', { read: 1000 }, { sidechain: true, agentId: 'ag1' }),
      // Still running when the second message arrives: still the first message's agent.
      reply(T0 + 10 * MIN + 500, 'x2', { read: 1000 }, { sidechain: true, agentId: 'ag1' }),
      // After the SendMessage that resumed it in the second message.
      reply(T0 + 10 * MIN + 5_000, 'x3', { read: 1000 }, { sidechain: true, agentId: 'ag1' }),
    )
    const t = parseTranscript(main, [{ path: 'C:/s/subagents/agent-ag1.jsonl', text: agent }])
    const first = t.exchanges[0]!.reqs.filter(r => r.kind === 'agent').map(r => r.key)
    const second = t.exchanges[1]!.reqs.filter(r => r.kind === 'agent').map(r => r.key)
    assert.deepEqual(first, ['msg-x1', 'msg-x2'])
    assert.deepEqual(second, ['msg-x3'])
  })

  test('a workflow run is charged to the message that launched it', () => {
    const main = lines(
      prompt(T0, 'run a workflow'),
      reply(T0 + 1000, 'a', { read: 5000 }),
      toolResult(T0 + 2000, { status: 'async_launched', taskType: 'local_workflow', transcriptDir: 'C:\\x\\subagents\\workflows\\wf_abc' }),
      prompt(T0 + 5 * MIN, 'meanwhile'),
      reply(T0 + 5 * MIN + 1000, 'b', { read: 5100 }),
    )
    const agent = reply(T0 + 6 * MIN, 'w1', { read: 9000 }, { sidechain: true, agentId: 'wa1' })
    const t = parseTranscript(main, [{ path: 'C:/s/subagents/workflows/wf_abc/agent-wa1.jsonl', text: agent }])
    assert.equal(t.exchanges[0]!.reqs.filter(r => r.kind === 'agent').length, 1)
    assert.equal(t.exchanges[1]!.reqs.filter(r => r.kind === 'agent').length, 0)
  })

  test('a resumed workflow run is charged to the message that resumed it, from the resume on', () => {
    const dir = 'C:/x/subagents/workflows/wf_abc'
    const main = lines(
      prompt(T0, 'run a workflow'),
      reply(T0 + 1000, 'a', { read: 5000 }),
      toolResult(T0 + 2000, { status: 'async_launched', taskType: 'local_workflow', taskId: 'w1', transcriptDir: dir }),
      prompt(T0 + 30 * MIN, 'resume it'),
      reply(T0 + 30 * MIN + 1000, 'b', { read: 5100 }),
      toolResult(T0 + 30 * MIN + 2000, { status: 'async_launched', taskType: 'local_workflow', taskId: 'w1', transcriptDir: dir }),
    )
    const t = parseTranscript(main, [
      { path: 'C:/s/subagents/workflows/wf_abc/agent-wa1.jsonl', text: reply(T0 + 5 * MIN, 'w1', { read: 9000 }, { sidechain: true, agentId: 'wa1' }) },
      { path: 'C:/s/subagents/workflows/wf_abc/agent-wa2.jsonl', text: reply(T0 + 31 * MIN, 'w2', { read: 9000 }, { sidechain: true, agentId: 'wa2' }) },
    ])
    assert.deepEqual(t.exchanges[0]!.reqs.filter(r => r.kind === 'agent').map(r => r.key), ['msg-w1'])
    assert.deepEqual(t.exchanges[1]!.reqs.filter(r => r.kind === 'agent').map(r => r.key), ['msg-w2'])
  })

  test("another session's message starts a turn when Claude was idle, and none when it arrives mid-turn", () => {
    const peer = (at: number, text: string) => prompt(at, text, { isMeta: true, origin: { kind: 'peer' } })
    const t = parseTranscript(lines(
      prompt(T0, 'hi'),
      reply(T0 + 1000, 'a', { read: 5000 }, { stop: 'tool_use' }),
      peer(T0 + 2000, 'delivered into the running turn'),
      reply(T0 + 3000, 'b', { read: 5100 }),
      peer(T0 + 10 * MIN, 'a message from another session'),
      reply(T0 + 10 * MIN + 1000, 'c', { read: 5200 }),
    ))
    assert.deepEqual(t.exchanges.map(e => [e.origin, e.prompt]), [['human', 'hi'], ['peer', 'a message from another session']])
    assert.equal(t.exchanges[0]!.reqs.length, 2)
  })

  test('a compaction after the last request is reported until a request follows it', () => {
    const before = lines(
      prompt(T0, 'first'),
      reply(T0 + 1000, 'a', { read: 200_000, w1h: 2_000 }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: uuid(), timestamp: iso(T0 + HOUR) }),
    )
    const t = parseTranscript(before)
    assert.equal(t.compactedAt, T0 + HOUR)
    assert.equal(buildTranscriptView(t, '1h', T0 + 2 * HOUR).compactedAt, T0 + HOUR)
    const after = parseTranscript(lines(before, prompt(T0 + HOUR + 10, 'next'), reply(T0 + HOUR + 1000, 'b', { read: 20_000, w1h: 5_000 })))
    assert.equal(after.compactedAt, undefined)
    assert.equal(after.exchanges[1]!.compactedBefore, true)
  })

  test('the cache lifetime comes from the api-request entries', () => {
    const t = parseTranscript(JSON.stringify({ type: 'api-request', cacheControl: [{ path: ['system', 1], value: { type: 'ephemeral', ttl: '1h' } }, { path: ['messages', 3, 'content', 0], value: { type: 'ephemeral', ttl: '5m' } }] }))
    assert.equal(t.ttl, '5m')
  })
})

// ---------------------------------------------------------------- the cache and the split

describe('cache judgement and attribution', () => {
  const prev = { read: 200_000, w1h: 2_000, out: 1_500 }

  test('your message after two hours away re-writes the conversation, and the penalty is priced', () => {
    const t = parseTranscript(lines(
      prompt(T0, 'first'),
      reply(T0 + 1000, 'a', prev),
      prompt(T0 + 2 * HOUR, 'back'),
      reply(T0 + 2 * HOUR + 1000, 'b', { read: 30_000, w1h: 175_000, out: 800 }),
    ))
    const s = analyzeSession(t.exchanges, { price: priceFor, ttl: '1h' }, t.preamble)
    const r = s.reports[1]!
    assert.equal(r.cache.state, 'cold')
    assert.equal(r.cache.reason, 'idle')
    assert.equal(r.cache.expected, 202_002)
    assert.equal(r.cache.rewritten, 172_002)
    // Opus 5.5: 1-hour write $8/MTok, read $0.20/MTok.
    assert.ok(Math.abs(r.cache.penaltyUsd - (172_002 * (8 - 0.2)) / 1e6) < 1e-9)
    assert.equal(s.coldCount, 1)
    // Your message: the first request's input side; Claude: its output.
    const youUsd = (2 * 4 + 30_000 * 0.2 + 175_000 * 8) / 1e6
    assert.ok(Math.abs(r.you.usd - youUsd) < 1e-9)
    assert.ok(Math.abs(r.claude.usd - (800 * 20) / 1e6) < 1e-9)
  })

  test('the same gap inside the 1-hour lifetime is warm', () => {
    const t = parseTranscript(lines(
      prompt(T0, 'first'),
      reply(T0 + 1000, 'a', prev),
      prompt(T0 + 40 * MIN, 'next'),
      reply(T0 + 40 * MIN + 1000, 'b', { read: 202_000, w1h: 2_500 }),
    ))
    const s = analyzeSession(t.exchanges, { price: priceFor, ttl: '1h' }, t.preamble)
    assert.equal(s.reports[1]!.cache.state, 'warm')
    assert.equal(s.penaltyUsd, 0)
  })

  test('a compaction between messages is a deliberate rebuild, not a penalty', () => {
    const t = parseTranscript(lines(
      prompt(T0, 'first'),
      reply(T0 + 1000, 'a', prev),
      prompt(T0 + 2 * HOUR, 'back'),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: uuid(), timestamp: iso(T0 + 2 * HOUR + 500) }),
      reply(T0 + 2 * HOUR + 1000, 'b', { read: 30_000, w1h: 20_000 }),
    ))
    const s = analyzeSession(t.exchanges, { price: priceFor, ttl: '1h' }, t.preamble)
    assert.equal(s.reports[1]!.cache.state, 'reset')
    assert.equal(s.penaltyUsd, 0)
  })

  test('a wait inside a turn (a pending question) that outlasts the cache is flagged mid-turn', () => {
    const t = parseTranscript(lines(
      prompt(T0, 'do it'),
      reply(T0 + 1000, 'a', prev),
      reply(T0 + 3 * HOUR, 'b', { read: 30_000, w1h: 180_000 }),
    ))
    const s = analyzeSession(t.exchanges, { price: priceFor, ttl: '1h' }, t.preamble)
    const r = s.reports[0]!
    assert.equal(r.coldLater.length, 1)
    assert.equal(r.coldLater[0]!.thread, 'main')
    assert.equal(r.coldLater[0]!.reason, 'idle')
    assert.equal(s.midTurnColdCount, 1)
  })

  test('after an advisor call the next message is judged against the last executor pass', () => {
    const iterations = [
      { type: 'message', input_tokens: 2, output_tokens: 494, cache_read_input_tokens: 236_726, cache_creation_input_tokens: 1_936, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_936 } },
      { type: 'advisor_message', model: 'claude-fable-5-2', input_tokens: 225_620, output_tokens: 15_937, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { type: 'message', input_tokens: 2, output_tokens: 1_122, cache_read_input_tokens: 238_662, cache_creation_input_tokens: 1_866, cache_creation: { ephemeral_5m_input_tokens: 1_866, ephemeral_1h_input_tokens: 0 } },
    ]
    const raw = JSON.parse(reply(T0 + 1000, 'adv', { in: 4, out: 1_616, read: 475_388, w1h: 1_936, iterations }))
    raw.message.usage.cache_creation_input_tokens = 3_802
    const t = parseTranscript(lines(
      prompt(T0, 'q'),
      JSON.stringify(raw),
      prompt(T0 + 10 * MIN, 'next'),
      reply(T0 + 10 * MIN + 1000, 'b', { read: 240_528, w1h: 900 }),
    ))
    const s = analyzeSession(t.exchanges, { price: priceFor, ttl: '1h' }, t.preamble)
    // Your message is what the first pass read; the second pass re-read it for Claude.
    assert.equal(s.reports[0]!.you.tokens.cacheRead, 236_726)
    assert.equal(s.reports[0]!.claude.tokens.cacheRead, 238_662)
    assert.equal(s.reports[1]!.cache.state, 'warm')
    assert.equal(s.reports[1]!.cache.expected, 240_530)
    const adv = t.exchanges[0]!.reqs.find(r => r.kind === 'main')!
    assert.equal(estimateNext(adv, T0 + 5 * MIN, '1h', priceFor).contextTokens, 241_652)
  })

  test('a much shorter conversation is a rebuild on the same model, and a model change on another', () => {
    const run = (model: string) => {
      const t = parseTranscript(lines(
        prompt(T0, 'first'),
        reply(T0 + 1000, 'a', prev),
        prompt(T0 + 2 * MIN, 'after a rewind'),
        reply(T0 + 2 * MIN + 1000, 'b', { read: 0, w1h: 100_000 }, { model }),
      ))
      return analyzeSession(t.exchanges, { price: priceFor, ttl: '1h' }, t.preamble)
    }
    const same = run('claude-opus-5-5')
    assert.deepEqual([same.reports[1]!.cache.state, same.reports[1]!.cache.reason], ['reset', 'shorter'])
    assert.equal(same.penaltyUsd, 0)
    const other = run('claude-sonnet-5-5')
    assert.deepEqual([other.reports[1]!.cache.state, other.reports[1]!.cache.reason], ['cold', 'model-switch'])
  })

  test('a compaction in the middle of a turn rebuilds the cache on purpose: no lapse', () => {
    const t = parseTranscript(lines(
      prompt(T0, 'long task'),
      reply(T0 + 1000, 'a', prev, { stop: 'tool_use' }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: uuid(), timestamp: iso(T0 + 2 * MIN) }),
      reply(T0 + 3 * MIN, 'b', { read: 10_000, w1h: 160_000 }),
    ))
    const s = analyzeSession(t.exchanges, { price: priceFor, ttl: '1h' }, t.preamble)
    assert.deepEqual(s.reports[0]!.coldLater, [])
    assert.equal(s.penaltyUsd, 0)
  })

  test('each lapse carries the request that found it, and mid-turn ones keep their reason in the view', () => {
    const t = parseTranscript(lines(
      prompt(T0, 'first'),
      reply(T0 + 1000, 'a', prev, { stop: 'tool_use' }),
      reply(T0 + 31_000, 'b', { read: 0, w1h: 205_000 }, { model: 'claude-sonnet-5-5' }),
    ))
    const s = analyzeSession(t.exchanges, { price: priceFor, ttl: '1h' }, t.preamble)
    assert.equal(s.reports[0]!.firstKey, 'msg-a')
    assert.deepEqual(s.reports[0]!.coldLater.map(c => [c.key, c.thread, c.reason]), [['msg-b', 'main', 'model-switch']])
    const v = buildTranscriptView(t, '1h', T0 + MIN)
    assert.deepEqual(v.rows[0]!.midTurn.map(m => m.reason), ['model-switch'])
  })

  test('a model change is told apart from idleness', () => {
    const t = parseTranscript(lines(
      prompt(T0, 'first'),
      reply(T0 + 1000, 'a', prev),
      prompt(T0 + 2 * MIN, 'next'),
      reply(T0 + 2 * MIN + 1000, 'b', { read: 30_000, w1h: 175_000 }, { model: 'claude-sonnet-5-5' }),
    ))
    const s = analyzeSession(t.exchanges, { price: priceFor, ttl: '1h' }, t.preamble)
    assert.equal(s.reports[1]!.cache.reason, 'model-switch')
  })
})

// ---------------------------------------------------------------- pricing and estimates

describe('pricing', () => {
  test('ids are normalized and matched exactly, not by prefix', () => {
    assert.equal(normalizeModel('us.anthropic.claude-opus-4-1-20250805-v1:0').id, 'claude-opus-4-1')
    assert.equal(normalizeModel('claude-opus-4-5@20251101').id, 'claude-opus-4-5')
    assert.equal(normalizeModel('claude-sonnet-4-5[1m]').id, 'claude-sonnet-4-5')
    assert.equal(normalizeModel('claude-opus-4-0').id, 'claude-opus-4')
    assert.deepEqual(normalizeModel('claude-opus-5-5-fast'), { id: 'claude-opus-5-5', fast: true })
    assert.equal(priceFor('claude-opus-4-20250514').input, 15)
    assert.equal(priceFor('claude-opus-4-5-20251101').input, 5)
    assert.equal(priceFor('claude-fable-5').cacheRead, 1)
    assert.equal(priceFor('claude-fable-5-1').cacheRead, 0.25)
  })

  test('fast mode, long prompts on Haiku 5.5 and US-only inference change the rate', () => {
    assert.equal(priceFor('claude-opus-5-5', { fast: true }).output, 40)
    assert.equal(priceFor('claude-haiku-5-5', { promptTokens: 100_001 }).input, 0.5)
    assert.equal(priceFor('claude-haiku-5-5', { promptTokens: 100_000 }).input, 0.1)
    assert.ok(Math.abs(priceFor('claude-sonnet-5-5', { geo: 'us' }).input - 2.2) < 1e-9)
  })

  test('an unknown model is priced at the default and flagged', () => {
    const p = priceFor('claude-something-new')
    assert.equal(p.known, false)
    assert.equal(p.input, 4)
  })

  test('writes the API did not split by lifetime are priced at the 5-minute rate, as Claude Code does', () => {
    const t = tokensFromApiUsage({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 })
    assert.equal(t.cacheWriteUnknown, 1_000_000)
    const s = analyzeSession([{ id: 'x', n: 1, prompt: '', origin: 'human', at: T0, reqs: [req({ at: T0, tokens: t })] }], { price: priceFor })
    assert.ok(Math.abs(s.total.usd - 5) < 1e-9)
  })
})

describe('the next message and plan limits', () => {
  const last = req({ at: T0, tokens: { ...ZERO_TOKENS, input: 2, cacheRead: 200_000, cacheWrite1h: 2_000, output: 1_500 } })

  test('warm: re-reading costs the read rate; cold: the whole context at the write rate', () => {
    const warm = estimateNext(last, T0 + 10 * MIN, '1h', priceFor)
    assert.equal(warm.state, 'warm')
    assert.equal(warm.contextTokens, 203_502)
    assert.equal(warm.msLeft, 50 * MIN)
    const cold = estimateNext(last, T0 + 3 * HOUR, '1h', priceFor)
    assert.equal(cold.state, 'cold')
    assert.ok(Math.abs(cold.coldUsd - (203_502 * 8) / 1e6) < 1e-9)
    assert.ok(cold.coldUsd > 30 * warm.warmUsd)
  })

  test('after a compaction the next message has no figure from the old context', () => {
    const next = estimateNext(last, T0 + 3 * HOUR, '1h', priceFor, T0 + 2 * HOUR)
    assert.equal(next.state, 'compacted')
    assert.equal(next.usd, 0)
    // A compaction older than the last request changes nothing.
    assert.equal(estimateNext(last, T0 + 10 * MIN, '1h', priceFor, T0 - HOUR).state, 'warm')
  })

  test('a window that rolled over is told by its reset time, even when usage climbed past the old reading', () => {
    const rolled = limitDeltas(
      [{ kind: 'five_hour', percentUsed: 40, resetsAt: '2026-11-16T22:00:00Z' }],
      [{ kind: 'five_hour', percentUsed: 45, resetsAt: '2026-11-17T03:00:00Z' }],
    )
    assert.deepEqual(rolled.map(x => [x.delta, x.didReset]), [[45, true]])
    const jitter = limitDeltas(
      [{ kind: 'five_hour', percentUsed: 40, resetsAt: '2026-11-16T22:00:00Z' }],
      [{ kind: 'five_hour', percentUsed: 41.5, resetsAt: '2026-11-16T22:00:20Z' }],
    )
    assert.deepEqual(jitter.map(x => [x.delta, x.didReset]), [[1.5, false]])
  })

  test('limit deltas are per window, and a reset in between counts from the reset', () => {
    const d = limitDeltas(
      [{ kind: 'seven_day', percentUsed: 65, resetsAt: 'a' }, { kind: 'five_hour', percentUsed: 98, resetsAt: 'x' }],
      [{ kind: 'seven_day', percentUsed: 65.4, resetsAt: 'a' }, { kind: 'five_hour', percentUsed: 1.5, resetsAt: 'y' }],
    )
    assert.deepEqual(d.map(x => [x.label, x.delta, x.didReset]), [['Weekly', 0.4, false], ['5-hour', 1.5, true]])
  })
})

describe('formatting', () => {
  test('dollars, tokens and durations read naturally', () => {
    assert.equal(fmtUsd(0.004), '<$0.01')
    assert.equal(fmtUsd(0.31), '$0.31')
    assert.equal(fmtUsd(12.4), '$12.4')
    assert.equal(fmtUsd(1234), '$1,234')
    assert.equal(fmtTokens(950), '950')
    assert.equal(fmtTokens(12_345), '12k')
    assert.equal(fmtTokens(1_420_000), '1.42M')
    assert.equal(fmtDuration(35_000), '35s')
    assert.equal(fmtDuration(2 * HOUR + 13 * MIN), '2h 13m')
    assert.equal(fmtDuration(30 * HOUR), '1d 6h')
  })
})

// ---------------------------------------------------------------- the view

describe('the view the mod draws', () => {
  test('live exchanges after the transcript are added, with the plan points recorded live', () => {
    const t = parseTranscript(lines(prompt(T0, 'first'), reply(T0 + 1000, 'a', { read: 200_000, w1h: 2_000, out: 1_500 })))
    const base = buildTranscriptView(t, '1h', T0 + 2_000)
    const live = [{ id: 't2', at: T0 + 5 * MIN, prompt: 'second', origin: 'human', open: false, reqs: [{ key: 't2#0', at: T0 + 5 * MIN, model: 'claude-opus-5-5', input: 2, output: 300, read: 203_000, write: 600, kind: 'main' as const }] }]
    const v = withLive(base, live, [{ at: T0 + 5 * MIN + 20, deltas: [{ label: 'Weekly', delta: 0.2, didReset: false }] }], '1h', T0 + 6 * MIN, [
      { key: 'c1', at: T0 + 6 * MIN, model: 'claude-opus-5-5', input: 0, output: 4_000, read: 203_000, write: 0, kind: 'compact' },
    ])
    assert.deepEqual(v.rows.map(r => [r.n, r.prompt.slice(0, 11), r.cache]), [[1, 'first', 'first'], [2, 'second', 'warm'], [0, 'Compaction:', 'none']])
    assert.deepEqual(v.rows[1]!.limits, [{ label: 'Weekly', delta: 0.2, didReset: false }])
    assert.equal(v.totals.messages, 2)
    assert.ok(v.totals.usd > base.totals.usd)
  })
})

describe('live rows and the transcript', () => {
  test('a live exchange the transcript already holds adds no row, however late its turn started', () => {
    const t = parseTranscript(lines(
      prompt(T0, 'first'),
      reply(T0 + 1000, 'a', { read: 200_000, w1h: 2_000, out: 1_500 }),
      prompt(T0 + 5 * MIN, 'second'),
      reply(T0 + 5 * MIN + 3_000, 'b', { read: 203_000, w1h: 600, out: 300 }),
    ))
    const base = buildTranscriptView(t, '1h', T0 + 6 * MIN)
    // turn.start ran 2.5 s after the prompt line was written; its first request
    // was sent before the transcript's newest request was written.
    const live = [{ id: 't2', at: T0 + 5 * MIN + 2_500, prompt: 'second', origin: 'human', open: false, reqs: [{ key: 't2#0', at: T0 + 5 * MIN + 2_600, end: T0 + 5 * MIN + 4_000, model: 'claude-opus-5-5', input: 2, output: 300, read: 203_000, write: 600, kind: 'main' as const }] }]
    const v = withLive(base, live, [], '1h', T0 + 7 * MIN)
    assert.deepEqual(v.rows.map(r => r.prompt), ['first', 'second'])
    assert.equal(v.totals.usd, base.totals.usd)
  })

  test('agent steps heard after their turn ended show as background work, never running, until the transcript holds them', () => {
    const t = parseTranscript(lines(prompt(T0, 'start agents'), reply(T0 + 1000, 'a', { read: 200_000, w1h: 2_000 })))
    const step = { key: 'bg#0', at: T0 + 5 * MIN, end: T0 + 5 * MIN + 10_000, model: 'claude-opus-5-5', input: 2, output: 400, read: 30_000, write: 1_000, kind: 'agent' as const, agentId: 'ag1' }
    const bg = [{ id: 'background-agents', at: T0 + 5 * MIN, prompt: 'Background agents still working', origin: 'background', open: false, partial: true, reqs: [step] }]
    // The transcript was read before the step ended: the step is shown.
    const early = withLive(buildTranscriptView(t, '1h', T0 + 5 * MIN + 5_000), bg, [], '1h', T0 + 5 * MIN + 6_000)
    assert.deepEqual(early.rows.map(r => [r.prompt, !!r.open]), [['start agents', false], ['Background agents still working', false]])
    assert.equal(early.totals.messages, 1)
    // Read after it ended: the transcript has it, so it is not counted twice.
    const late = withLive(buildTranscriptView(t, '1h', T0 + 6 * MIN), bg, [], '1h', T0 + 6 * MIN + 1_000)
    assert.deepEqual(late.rows.map(r => r.prompt), ['start agents'])
  })
})

describe('live pricing', () => {
  test("an agent's and a compaction's live writes count at 5 minutes, the conversation's at the session's lifetime", () => {
    const base = { at: T0, input: 2, output: 100, read: 50_000, write: 10_000, model: 'claude-opus-5-5' }
    assert.deepEqual(
      [reqOfLive({ ...base, key: 'm', kind: 'main' }, '1h').tokens, reqOfLive({ ...base, key: 'g', kind: 'agent', agentId: 'ag1' }, '1h').tokens, reqOfLive({ ...base, key: 'c', kind: 'compact' }, '1h').tokens].map(t => [t.cacheWrite1h, t.cacheWrite5m]),
      [[10_000, 0], [0, 10_000], [0, 10_000]],
    )
  })
})

describe('plan changes on rows', () => {
  test("a turn's plan change goes to the row that started the turn, not to a message delivered into it", () => {
    const t = parseTranscript(lines(
      prompt(T0, 'first'),
      reply(T0 + 1000, 'a', { read: 200_000, w1h: 2_000 }, { stop: 'tool_use' }),
      JSON.stringify({ type: 'attachment', uuid: uuid(), timestamp: iso(T0 + 3000), attachment: { type: 'queued_command', prompt: 'also this' } }),
      reply(T0 + 4000, 'b', { read: 202_000, w1h: 500 }),
    ))
    const base = buildTranscriptView(t, '1h', T0 + 5_000)
    assert.deepEqual(base.rows.map(r => [r.prompt, !!r.inTurn]), [['first', false], ['also this', true]])
    const deltas = [{ label: 'Weekly', delta: 0.3, didReset: false }]
    const v = withLive(base, [], [{ at: T0 + 100, deltas, since: T0 - 10 * MIN }], '1h', T0 + 6_000)
    assert.deepEqual(v.rows[0]!.limits, deltas)
    assert.equal(v.rows[0]!.limitsSince, T0 - 10 * MIN)
    assert.equal(v.rows[1]!.limits, undefined)
  })
})

describe('the HTML report', () => {
  test('a hostile prompt is escaped in the table and in the data block', () => {
    const evil = '</script><img src=x onerror=alert(1)>"\u2028'
    const t = parseTranscript(lines(prompt(T0, evil), reply(T0 + 1000, 'a', { read: 5000 })))
    const report = analyzeSession(t.exchanges, { price: priceFor, ttl: '1h' }, t.preamble)
    const html = htmlReport({ file: { id: 's', path: 'C:/x/s.jsonl', project: 'C--x', mtimeMs: 0, birthtimeMs: 0, size: 0 }, parsed: t, report, ttl: '1h', generatedAt: T0 })
    assert.ok(!html.includes('<img src=x'))
    const block = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html)
    assert.ok(block)
    assert.ok(!block[1]!.includes('<'))
    assert.ok(!block[1]!.includes('\u2028'))
    assert.equal(JSON.parse(block[1]!)[0].prompt, evil.replace(/\s+/g, ' ').trim())
  })

  test('after a compaction the next-message tile says it rebuilds, and estimated figures carry the mark', () => {
    const file = { id: 's', path: 'C:/x/s.jsonl', project: 'C--x', mtimeMs: 0, birthtimeMs: 0, size: 0 }
    const t = parseTranscript(lines(
      prompt(T0, 'q'),
      reply(T0 + 1000, 'p', { read: 5000, out: 3 }, { stop: null, content: [{ type: 'text', text: 'x'.repeat(4_000) }] }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: uuid(), timestamp: iso(T0 + HOUR) }),
    ))
    const report = analyzeSession(t.exchanges, { price: priceFor, ttl: '1h' }, t.preamble)
    const html = htmlReport({ file, parsed: t, report, ttl: '1h', generatedAt: T0 + 2 * HOUR })
    assert.ok(html.includes('compacted after the last request'))
    assert.ok(html.includes('class="num strong">≈'))
    assert.ok(html.includes('<td class="num">≈'))
    assert.ok(html.includes('marks figures that include estimated output'))
    // Without the compaction and the estimate, neither appears.
    const plain = parseTranscript(lines(prompt(T0, 'q'), reply(T0 + 1000, 'p', { read: 5000 })))
    const plainHtml = htmlReport({ file, parsed: plain, report: analyzeSession(plain.exchanges, { price: priceFor, ttl: '1h' }, plain.preamble), ttl: '1h', generatedAt: T0 + 2 * MIN })
    assert.ok(!plainHtml.includes('compacted after the last request'))
    assert.ok(!plainHtml.includes('class="num strong">≈'))
  })
})
