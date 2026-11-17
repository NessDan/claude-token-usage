import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'usage-meter',
  component: 'Pane',
  requestId: 'usage-meter',
  props: {
    title: 'Usage meter',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'usage-meter',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

/** A warm request on Opus 5.5: 200k read from the cache, 2k written, 1.5k out. */
const WARM = { input_tokens: 2, output_tokens: 1_500, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 2_000, model: 'claude-opus-5-5' }
/** The same conversation after the cache lapsed: everything written again. */
const COLD = { input_tokens: 2, output_tokens: 800, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 175_000, model: 'claude-opus-5-5' }

type Usage = typeof WARM

/** Stands in for the engine beneath the plugin: every event and call the meter makes is answered here. */
function engine(on: Parameters<Parameters<typeof test>[1]>[1], usages: Usage[], rateLimits: { kind: string; percentUsed: number }[][], toasts?: string[]) {
  let step = 0
  let reading = 0
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: { answer: string; usage?: Usage }) => ({ text: e.answer, usage: e.usage }))
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    const usage = usages[Math.min(step, usages.length - 1)]!
    step += 1
    yield { kind: 'stop', stopReason: 'end_turn', usage } as const
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage } as const
  })
  on('session.usage', () => {
    const limits = rateLimits[Math.min(reading, rateLimits.length - 1)] ?? []
    reading += 1
    return { value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: limits } }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_: unknown, e: { text: string }) => {
    toasts?.push(e.text)
    return { value: undefined }
  })
}

async function runStep($: { turn: { step: (e: object) => AsyncGenerator<unknown, unknown> } }, turnId: string, index: number) {
  const s = $.turn.step({ turnId, index, model: 'claude-opus-5-5', messageCount: 1 })
  let n = await s.next()
  while (!n.done) n = await s.next()
  return n.value
}

test('a message shows on the pane with what it used, on desktop and terminal', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 16, 20, 0, 0) })
  engine(on, [WARM, WARM], [[{ kind: 'seven_day', percentUsed: 65 }], [{ kind: 'seven_day', percentUsed: 65.4 }]])

  await $.turn.start({ text: 'Rename the chat please', turnId: 't1' })
  await clock.advance(2_000)
  await runStep($ as never, 't1', 0)
  await clock.advance(3_000)
  await runStep($ as never, 't1', 1)
  await $.turn.complete({ answer: 'done', durationMs: 5_000, isAborted: false, turnId: 't1', reason: 'answer', usage: WARM })
  await clock.advance(2_000)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Rename the chat please/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^You \$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Claude \$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /API-equivalent/ })).toBeDefined()
    // The weekly window moved 0.4 points while the turn ran: shown beside the message's cost.
    expect(await ui.find({ type: 'Text', text: /^\+0\.4%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^weekly$/ })).toBeDefined()
    // Plan limits are not repeated in the pane; the app already shows them.
    expect(await ui.find({ type: 'Text', text: /Plan limits/ })).toBeUndefined()
    const svg = await ui.find({ type: 'Svg' })
    expect(surface === 'desktop' ? svg !== undefined : svg === undefined).toBe(true)
    await ui.unmount()
  }
})

test('the band counts down the cache, then warns once it has lapsed', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 16, 20, 0, 0) })
  engine(on, [WARM], [[{ kind: 'seven_day', percentUsed: 65 }]])

  await $.turn.start({ text: 'hello', turnId: 't1' })
  await runStep($ as never, 't1', 0)
  await $.turn.complete({ answer: 'hi', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer', usage: WARM })
  await clock.advance(1_500)

  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Cache warm/ })).toBeDefined()
  await ui.unmount()

  // Two hours later the 1-hour cache has lapsed.
  await clock.advance(2 * 60 * 60 * 1_000)
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Cache expired/ })).toBeDefined()
  await ui.unmount()
})

test('a message sent after the cache lapsed is flagged with what re-writing cost', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 16, 20, 0, 0) })
  engine(on, [WARM, COLD], [[{ kind: 'seven_day', percentUsed: 65 }]])

  await $.turn.start({ text: 'first', turnId: 't1' })
  await runStep($ as never, 't1', 0)
  await $.turn.complete({ answer: 'one', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer', usage: WARM })
  await clock.advance(3 * 60 * 60 * 1_000)

  await $.turn.start({ text: 'back after three hours', turnId: 't2' })
  await runStep($ as never, 't2', 0)
  await $.turn.complete({ answer: 'two', durationMs: 1_000, isAborted: false, turnId: 't2', reason: 'answer', usage: COLD })
  await clock.advance(1_500)

  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /back after three hours/ })).toBeDefined()
  // One short line under the message says the cache had lapsed and what it cost...
  expect(await ui.find({ type: 'Text', text: /Cache had lapsed, after 3h away/ })).toBeDefined()
  // ...and the message's details say why, and how much was written again.
  await ui.press({ key: 'toggle-t2' })
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /You were away 3h/ })).toBeDefined()
  // The cache could have served the previous request's 202k-token prompt; it served 30k.
  expect(await ui.find({ type: 'Text', text: /re-wrote 172k tokens/ })).toBeDefined()
  await ui.unmount()
})

test('a turn a background task started after the cache lapsed is not blamed on you', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 16, 20, 0, 0) })
  engine(on, [WARM, COLD], [[{ kind: 'seven_day', percentUsed: 65 }]])

  await $.turn.start({ text: 'start the review', turnId: 't1' })
  await runStep($ as never, 't1', 0)
  await $.turn.complete({ answer: 'started', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer', usage: WARM })
  await clock.advance(3 * 60 * 60 * 1_000)

  const note = '<task-notification>\n<status>completed</status>\n<summary>Workflow "Review" completed</summary>\n</task-notification>'
  await $.turn.start({ text: note, turnId: 't2' })
  await runStep($ as never, 't2', 0)
  const done = (await $.turn.complete({ answer: 'reviewed', durationMs: 1_000, isAborted: false, turnId: 't2', reason: 'answer', usage: COLD })) as { text: string }
  expect(done.text).toMatch(/3h after Claude's last request/)
  expect(/away/.test(done.text)).toBe(false)
  await clock.advance(1_500)

  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Workflow "Review" completed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Cache had lapsed, 3h after Claude's last request/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /away/ })).toBeUndefined()
  await ui.press({ key: 'toggle-t2' })
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /notification woke Claude 3h after its last request/ })).toBeDefined()
  await ui.unmount()
})

test('an agent still working after its message was read from the transcript is not added to the next message', async ($, on) => {
  const T = Date.UTC(2026, 10, 16, 20, 0, 0)
  const clock = mock.clock(on, { now: T })
  const iso = (ms: number) => new Date(ms).toISOString()
  const MAIN = 'C:/cfg/projects/C--proj/sess1.jsonl'
  const cc = (u: Usage) => ({ input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cache_read_input_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: u.cache_creation_input_tokens } })
  // Message #1 as the transcript has it: it launches agent ag1 and ends.
  const transcript = [
    { type: 'user', uuid: 'u1', timestamp: iso(T), sessionId: 'sess1', origin: { kind: 'human' }, message: { role: 'user', content: 'start an agent' } },
    { type: 'assistant', uuid: 'a1', timestamp: iso(T + 1_500), requestId: 'r1', message: { id: 'm1', model: WARM.model, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: {} }], usage: cc(WARM) } },
    { type: 'user', uuid: 'u2', timestamp: iso(T + 2_500), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'launched' }] }, toolUseResult: { status: 'async_launched', agentId: 'ag1' } },
    { type: 'assistant', uuid: 'a2', timestamp: iso(T + 5_500), requestId: 'r2', message: { id: 'm2', model: WARM.model, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'started' }], usage: cc(WARM) } },
  ].map(o => JSON.stringify(o)).join('\n')
  const AGENT = { input_tokens: 3, output_tokens: 900, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 5_000, model: 'claude-opus-5-5' }
  engine(on, [WARM, AGENT, WARM, WARM, AGENT], [[{ kind: 'seven_day', percentUsed: 65 }]])
  const np = (p: string) => p.split(String.fromCharCode(92)).join('/')
  on('session.id', () => ({ value: 'sess1' }))
  on('session.root', () => ({ value: 'C:/proj' }))
  on('session.cwd', () => ({ value: 'C:/proj' }))
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? 'C:/cfg' : undefined }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: np(e.path) === MAIN }))
  on('fs.stat', (_: unknown, e: { path: string }) => (np(e.path) === MAIN ? { value: { kind: 'file', size: transcript.length, mtimeMs: 0, isLink: false } } : { deny: 'missing' }))
  on('fs.read', (_: unknown, e: { path: string }) => (np(e.path) === MAIN ? { value: transcript } : { deny: 'missing' }))
  on('ui.log', () => ({ value: undefined }))

  // Message #1: the agent's first step is heard while the turn runs.
  await $.turn.start({ text: 'start an agent', turnId: 't1' })
  await clock.advance(1_000)
  await runStep($ as never, 't1', 0)
  await clock.advance(1_000)
  const s = $.turn.step({ turnId: 'g0', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'ag1' } as never)
  for (let n = await s.next(); !n.done; n = await s.next()) {
    // drain
  }
  await clock.advance(3_000)
  await runStep($ as never, 't1', 1)
  await $.turn.complete({ answer: 'started', durationMs: 5_500, isAborted: false, turnId: 't1', reason: 'answer', usage: WARM })
  // The transcript is read after the turn: it now holds message #1.
  await clock.advance(2_000)

  // Message #2: the agent keeps working while it runs.
  await clock.advance(60_000)
  await $.turn.start({ text: 'something else', turnId: 't2' })
  await clock.advance(1_000)
  await runStep($ as never, 't2', 0)
  await clock.advance(1_000)
  const s2 = $.turn.step({ turnId: 'g1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'ag1' } as never)
  for (let n = await s2.next(); !n.done; n = await s2.next()) {
    // drain
  }
  const done = (await $.turn.complete({ answer: 'ok', durationMs: 2_000, isAborted: false, turnId: 't2', reason: 'answer', usage: WARM })) as { text: string }
  expect(done.text).toMatch(/Claude \$[0-9.]+ \(1 request · /)
  expect(/agent/.test(done.text)).toBe(false)

  // Until the next read, the pane shows the agent's step on a row of its own, never running.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Background agents still working/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /running/ })).toBeUndefined()
  await ui.unmount()
})

test('an agent a later message resumes is counted in that message', async ($, on) => {
  const T = Date.UTC(2026, 10, 16, 20, 0, 0)
  const clock = mock.clock(on, { now: T })
  const AGENT = { input_tokens: 3, output_tokens: 900, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 5_000, model: 'claude-opus-5-5' }
  engine(on, [WARM, AGENT, WARM, AGENT], [[{ kind: 'seven_day', percentUsed: 65 }]])
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'ag1' }))
  const agentStep = async (turnId: string) => {
    const s = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'ag1' } as never)
    for (let n = await s.next(); !n.done; n = await s.next()) {
      // drain
    }
  }
  const spawn = { tool_use_id: 'tu', prompt: 'go', description: 'helper', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false }

  // Message #1 starts the agent, which works and goes idle.
  await $.turn.start({ text: 'start a helper', turnId: 't1' })
  await $.agent.spawn(spawn as never)
  await runStep($ as never, 't1', 0)
  await agentStep('g0')
  await $.turn.complete({ answer: 'started', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer', usage: WARM })
  await clock.advance(60_000)

  // Message #2 resumes it with SendMessage: its work is this message's.
  await $.turn.start({ text: 'ask the helper again', turnId: 't2' })
  await $.agent.spawn({ ...spawn, resume: { agentId: 'ag1' } } as never)
  await runStep($ as never, 't2', 0)
  await agentStep('g1')
  const done = (await $.turn.complete({ answer: 'ok', durationMs: 1_000, isAborted: false, turnId: 't2', reason: 'answer', usage: WARM })) as { text: string }
  expect(done.text).toMatch(/1 request · 1 in 1 agent/)
})

test('a usage line is shown beneath each answer, and can be turned off', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 16, 20, 0, 0) })
  engine(on, [WARM], [[{ kind: 'seven_day', percentUsed: 65 }], [{ kind: 'seven_day', percentUsed: 65.2 }]])
  on('command.register', () => ({ value: { command: 'usage-meter' } }))

  await $.turn.start({ text: 'hello', turnId: 't1' })
  await runStep($ as never, 't1', 0)
  const done = (await $.turn.complete({ answer: 'hi', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer', usage: WARM })) as { text: string }
  expect(done.text).toMatch(/^Usage: you \$/)
  expect(done.text).toMatch(/Claude \$/)
  expect(done.text).toMatch(/Weekly \+0\.2%/)

  await $.command.run({ command: 'usage-meter', args: 'notes-off' } as never)
  await clock.advance(1_000)
  await $.turn.start({ text: 'again', turnId: 't2' })
  await runStep($ as never, 't2', 0)
  const quiet = (await $.turn.complete({ answer: 'hi again', durationMs: 1_000, isAborted: false, turnId: 't2', reason: 'answer', usage: WARM })) as { text: string }
  expect(quiet.text).toBe('hi again')
})

test('hiding the band says how to bring it back, and /usage-meter show does', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 16, 20, 0, 0) })
  const toasts: string[] = []
  engine(on, [WARM], [[{ kind: 'seven_day', percentUsed: 65 }]], toasts)
  on('command.register', () => ({ value: { command: 'usage-meter' } }))
  await $.turn.start({ text: 'hello', turnId: 't1' })
  await runStep($ as never, 't1', 0)
  await $.turn.complete({ answer: 'hi', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer', usage: WARM })
  await clock.advance(1_500)

  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Cache warm/ })).toBeDefined()
  await ui.press({ key: 'usage-meter-hide' })
  await ui.unmount()
  expect(toasts.some(t => /\/usage-meter show/.test(t))).toBe(true)

  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Cache warm/ })).toBeUndefined()
  await ui.unmount()

  await $.command.run({ command: 'usage-meter', args: 'show' } as never)
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Cache warm/ })).toBeDefined()
  await ui.unmount()
})

test('an empty session draws a waiting note', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  engine(on, [WARM], [[]])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Waiting for the first message/ })).toBeDefined()
  await ui.unmount()
})
