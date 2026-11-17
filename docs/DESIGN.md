# Usage Meter: design notes

Decisions made while building this, and why. The person who asked for it was away, so every open question was decided here and written down instead of asked.

## The ask

See how much usage each message used up, in the Claude desktop app: your message, and Claude's reply. Make the "came back after hours and one message ate my limit" effect visible.

## What "usage per message" means

Claude bills per **API request**, not per message. One message usually sets off many requests:

- the tool loop, where every round trip re-sends the whole conversation;
- subagents and workflow agents;
- the advisor, which runs inside a request on another model.

The rule used everywhere:

| Row | What it counts | Why |
| --- | --- | --- |
| **You** | The input side of the first main-thread request after your message: cache reads, cache writes and uncached input. When that request calls the advisor, only its first executor pass counts here; the second re-reads the conversation for Claude's work. | What your message costs before Claude does anything: reading the conversation so far plus your text. It's the row the idle penalty lands on. |
| **Claude** | That request's output, plus every later request of the exchange: tool loop, subagents, workflow agents, the advisor, server-side passes | The work Claude chose to do to answer. |

An **exchange** is one prompt line and everything it set off, up to the next prompt. The prompt line can be:

- your typed message;
- a background task's notification;
- a message queued while Claude worked (delivered into the running turn, so it starts no turn of its own);
- another session's message, or any notice from a non-human origin, that arrives while Claude is idle.

Rows are worded by what started them. A row the person started (typed, from a phone, queued) says "you were away"; one a notification or another session started says what woke Claude and when.

Prompt-less usage gets its own **background** rows. Today that means the compaction summary request, which the mod sees live.

## Units

1. **Tokens.** Ground truth, read from the API's own usage report.
2. **API-equivalent dollars.** List prices from `lib/pricing.ts`, with Claude Code 2.1.321's own formula:
   - writes the API did not split by lifetime are priced at the 5-minute rate;
   - `inference_geo: "us"` costs 10% more;
   - each web search costs $0.01.

   They are a common scale, not a charge.

   Live figures (a running message's row, the band's "this message so far", the line under each answer, compaction rows) come from the hook's four counts per request, with one write count and no lifetime split. The main conversation's writes are priced at the session's lifetime; agents' and compaction's at 5 minutes, the lifetime Claude Code gives them even on a subscription. The hook reports the API's top-level usage, which leaves out an advisor run's own tokens and has no pass split, so live figures neither price the advisor's run nor apply the first-pass rule below. The pane's row gets the exact figures when the transcript is read after the turn; the line under the answer is never redrawn.
3. **Plan-limit points.** The change in each limit window between `turn.start` and `turn.complete`, read with `$.session.usage()`. They're coarse and account-wide, and they exist only while the mod is loaded. They're never derived from tokens.
   - A window whose reset time moved forward rolled over in between; the change then counts from the reset ("reset, now X%"). A falling percentage is only the fallback for a reading without a reset time, which 2.1.321 never produces.
   - The readings arrive with model responses. When none came in for over 2 minutes before a turn, its change also covers that gap, and the row is labelled with the earlier reading's time.
   - Each turn's change goes to exactly one row: the latest row that started a turn, has no change yet, and began between a minute before the turn's start and 5 s after. Queued messages and background rows never take one.

## Cold caches

Each request is judged against the previous request of its **thread**: the main conversation, or one agent's own chain. A warm request reads from the cache what the previous request sent. So:

- `expected` = the previous request's prompt size;
- `read` = what this request read from the cache.

| Case | Verdict |
| --- | --- |
| `read / expected` ≥ 0.7 | **warm** |
| `read / expected` ≤ 0.3 | **cold** |
| in between | **partial** |
| less than 4,096 tokens of context | not judged |
| a compaction since the previous request, before your message or mid-turn | **reset** (compaction), not penalised |
| on the same model, a prompt under 75% of the previous one (a rewind, tool-result clearing) | **reset** (shorter), not penalised. On another model the switch is judged as below: it threw the cache away whatever the size. |

An advisor request runs the executor twice over the same conversation. It is judged by its first pass, and the next request is judged against its last pass, so neither pass is mistaken for a prompt twice its size.

The reason for a cold verdict:

- **model switch**: the model changed.
- **idle**: the time since the previous request started reached the lifetime (minus 30 s). That time is estimated as the gap plus the previous response's output at ~100 tokens/s, because the API counts the lifetime from the start of a request.
- **invalidated**: anything else that changed the prefix: a tool, MCP server or plugin change, fast mode, effort on models that don't keep the cache across it, a Claude Code update or an app restart. The meter can't tell which; Claude Code's `/usage` names a likely cause.

The lifetime is the tier the thread last wrote with (`ephemeral_1h` or `ephemeral_5m`). Otherwise it's the session's (`api-request.cacheControl`), else 1 hour on a subscription and 5 minutes off one.

**Penalty** = re-written tokens × (write rate − read rate): what the lapse cost over a warm cache.

Cold verdicts are kept per place:

- on your message (the You row);
- mid-turn on the main thread, each with its reason: a wait past the lifetime (a question or permission prompt answered late, or a long tool run), a model change, or a miss within the lifetime;
- inside agents, whose cache lasts 5 minutes.

## Reading transcripts (`lib/transcript.ts`)

Facts from a survey of 2,400 transcript files on this machine (Claude Code 2.1.2xx to 2.1.321):

- **Responses span several lines.** One response is one line per content block, each repeating its usage. Lines are merged by `message.id`, else `requestId`, keeping the line with the most output.
- **Old agent lines are partial.** Lines without `stop_reason` (2.1.219 to 2.1.293 sidechains) carry a lower bound for output; it is estimated as content characters ÷ 4 when that is larger. Such requests are marked estimated, and the figures that include them carry ≈: the pane's header, row totals, Claude figures, chart tooltips and the band's last message; the CLI table's Claude and total columns, its session line and the --list/--all totals; the HTML report's Claude and Total columns, tiles and tooltips. Per-request lines carry none; --json gives counts (`estimatedRequests`). Hidden thinking is not in the file, so the estimate runs low.
- **Iterations.** In `usage.iterations`:
  - `message` entries add up to the top level, and carry the per-pass 5m/1h split, so they're used for it. With two or more passes (around an advisor call), the first and last are also kept apart for the cache judgement;
  - `advisor_message` is the advisor's own run, on its own model, and the top level leaves it out, so it becomes its own request, outside every cache thread, whether the main conversation or an agent asked for it (the advisor reads uncached by design, so it is never judged a lapse);
  - `fallback_message` is the response served, and the top level equals it, so it gives the request's tokens, model and cache split. Each declined `message` pass before it was billed too: it becomes a request of its own (a "declined attempt"), outside the cache threads.
- **Prompts.** Every non-meta prompt line starts an exchange. So does a meta line from a non-human `origin.kind` (another session's message) when the main thread's last request did not stop for a tool, that is, when Claude was idle. `promptId` is not a key: older builds reused one per session. Interrupt markers and model-less commands start no row. A turn that starts with no prompt line at all (a meta line with no origin after Claude's turn ended, such as some hook continuations) opens no row: its requests stay in the previous row, and a long gap before them is labelled a mid-turn wait. One such case is in this machine's history.
- **Agents** live only in their own files under `<session>/subagents/**/agent-*.jsonl`. Each is charged to the exchange that launched it: the Agent result's `agentId`, from that exchange's start. A SendMessage resume (`resumedAgentId`) counts from the moment of the resume. A Workflow result's `transcriptDir` names the run, so workflow agents go to the exchange that launched it. A resumed run keeps its run id: from the resume on, its agents go to the exchange that resumed it. Anything else goes by time.
- **Compaction.** `compact_boundary` marks it. The summary request itself is not in the transcript. A compaction after the last main request is reported as `compactedAt`: the next message rebuilds the cache from the summary, so no estimate is quoted from the old context.
- **Size.** Most bytes are tool results. Lines are pre-filtered by substring before `JSON.parse` and never retained, so a 360 MB transcript parses in about a second.

## The mod (`hooks/register.tsx`)

**Live capture:**

- `turn.step` (an async generator, `yield* next(e)` once) gives each request's usage, main and agents.
- `turn.start` and `turn.complete` (main loop) give the plan-limit readings around each turn.
- `session.compact` gives the summarizer's usage (a background row). The main conversation's compaction (not a subagent's, nor one only prepared in advance) also marks the next message as rebuilding from the summary.
- `prompt.submit` gives the origin of the prompt that starts the next turn: the person, a task notification, another session.
- `session.measure` gives the latest limits.

**Reconcile.** After each turn the transcript is re-read and replaces the live rows it now covers:

- in-process with `$.fs.read`, which reads whole files up to 4 MiB;
- otherwise through `node scripts/summarize.ts` (`$.process.run`), which prints the transcript's view as JSON.

A live exchange is covered when its first main request was sent before the transcript's newest main request; covered ones are dropped, newer ones stay. Their cache verdicts are seeded with the transcript's last main request.

An agent's steps go to the message it belongs to, which `agent.spawn` says as the engine starts it: a new subagent, and one a SendMessage resumes, belong to the turn running then; one another agent starts, to where that agent belongs; a workflow's agents, to the turn that launched their run, or resumed it (a Workflow call with `resumeFromRunId`, seen on `tool.call`). An agent the meter never saw start (it started before the mod loaded) is taken to be the running turn's. Once the transcript holds an agent's message, the agent's later steps go to a "background agents" row, unless a later turn resumes it; so do steps heard with no turn running. That row never counts as running and is dropped at the next read, since the transcript files those requests under the message that launched or resumed them.

One case stays approximate: a workflow whose launching turn ended before its first agent started, while a later message runs, has its agents counted in that later message's live figures until the next read. The pane row is corrected at the read; the line under that message's answer is not.

A `/clear` or resume changes the transcript path. Everything restarts at once, and a read of the old file still in flight is discarded (a session generation counter). Two spellings of one path (slashes, drive-letter case) are the same file.

**Finding the transcript:**

- the path comes from the `classic.*` events (`transcript_path`);
- a mod loaded mid-session hears none of those, so it is found from `$.session.id()` under `<config>/projects/<slug>/<id>.jsonl`, scanning project folders as a fallback.

**State.** All state the drawings read is in `$.state`, declared in `types/index.d.ts`:

- the view;
- the live exchanges;
- the limit log;
- the readings;
- the transcript path;
- UI toggles;
- a 30-second tick for the countdown.

Lists are capped.

**Drawing.**

- *Pane:* quiet labelled sections (this chat, cache, cost per message, messages), one prominent number in each and the detail in muted text, after Refactoring UI's hierarchy, Linear's calm, low-chrome density and Tufte's word-sized graphics. On desktop, small SVGs carry the graphics: a split bar of your messages against Claude's replies, a countdown meter for the cache, and a chart of the last 40 messages; the terminal gets a text meter and a sparkline. Plan limits are left out, since the app already shows them. Messages are newest first, 80 drawn, each as two lines: the prompt and its cost, then its number and time with a dim Details toggle and its weekly share (`weeklyShare`) as prominent as the cost. A third line appears only when a cache lapsed. The rest of a row (the You/Claude split, the full explanation, the measured plan change, the request lines) and the notes on the figures sit behind toggles.
- *Band above the prompt:* the cache countdown, or what the next message will cost to re-write.
- *Toast:* when a turn this load saw finish had to re-write the conversation (its first request found the cache fully lapsed, or a mid-turn request did) and those lapses cost $0.25 or more; agents' lapses aren't counted toward it. Never about an older message, on a reload or a resume.
- *The line under each answer:* each lapse with its own figure: the first request's (worded by why), mid-turn ones, agents'.

## Tested

- `test/core.test.ts`: 39 unit tests on synthetic transcripts (`npm test`).
- `plugins/usage-meter/tests/meter.test.tsx`: 8 tests in the engine's own test kit (`claude plugin test`). They drive live turns and check the pane, the band and the line under each answer, on desktop and terminal, including a turn a background task started, an agent that keeps working after its message was read, and an agent a later message resumes.
- `claude plugin validate` and a strict `tsc` against the build's own declarations.
- Real headless runs of Claude Code 2.1.321 with the mod loaded, checked in the debug log:
  - every hook ran;
  - the transcript was found and read in-process;
  - forced onto the Node helper, `node` ran and the summary was read.

  The model call itself was not exercised: the standalone CLI's sign-in has expired, and signing in is the person's to do.
- The report run over all 196 sessions on this machine.
- The live mod in the session that built it, checked against a snapshot of what it draws: rows, plan readings and a flagged cold start. After the last fixes: the session's total within 0.1% of Claude Code's own cost figure for it, and an agent started mid-turn filed under that turn as the engine raised `agent.spawn`.
- An adversarial review in four lenses (math and parsing, the mod API, honesty and UX, robustness and security). It confirmed 21 findings and rejected 2. All 21 are fixed, and each fix was checked one of three ways:
  - the unit and engine tests above cover the parsing, cache, plan-limit, live-view and wording fixes;
  - the reviewers' own repro tests, run against the fixed mod, pass: `/clear` during a read, the background-agent rows, two spellings of one path, and the toast on resume or reload;
  - the CLI's flag handling and its session order were re-run on the sessions on this machine.
- A second review checked every document and user-facing sentence claim by claim against the code and the data, with a skeptic re-checking each finding. It confirmed 26 and rejected 1. The code ones are fixed (advisor runs inside agents had been judged as agent cache lapses; live agent writes were priced at the 1-hour rate; mid-turn lapses were all called waits; a mid-turn compaction counted as a lapse; resumed copies counted their original's lapses again; ≈ and penalty pairings were inconsistent), and the wording ones are corrected. The figures in the README were recomputed afterwards.
