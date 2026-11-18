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
3. **Plan-limit points.** The change in each limit window between `turn.start` and `turn.complete`, read with `$.session.usage()`. They're coarse and account-wide, and they exist only while the mod is loaded. They're never derived from tokens. The one estimate that turns dollars into points, the weekly share, is marked ≈ and has its own section below.
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

- `turn.step` (an async generator, `yield* next(e)` once) gives each request's usage, main and agents. After each one, at most every 5 seconds, the readings are polled for the weekly ledger.
- `turn.start` and `turn.complete` (main loop) give the plan-limit readings around each turn.
- `session.compact` gives the summarizer's usage (a background row). The main conversation's compaction (not a subagent's, nor one only prepared in advance) also marks the next message as rebuilding from the summary.
- `prompt.submit` gives the origin of the prompt that starts the next turn: the person, a task notification, another session. The desktop app's own notices (`<side-sessions-event>`, `<ci-monitor-event>`) arrive as plain user text with no origin, after Claude Code's reminders; `appEventOf` spots them, live and in the transcript, so their row reads as what they are ("Sessions Claude started reported back") and counts as a machine's turn, not yours. A reply made in the app starts each part with `<!-- reply N -->` and the quoted lines it answers; the row shows the person's own words (`ownWords`), the quote only when nothing else was typed.
- `session.measure` gives the latest limits, and a weekly step for the ledger when a window moved.

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
- a 30-second tick for the countdown;
- the weekly calibration.

Lists are capped. The weekly ledger is the one thing kept outside the session, in `$.store` (below).

**Drawing.**

- *Pane:* quiet labelled sections (this chat, weekly limit, cache, cost per message, messages), one prominent number in each and the detail in muted text, after Refactoring UI's hierarchy, Linear's calm, low-chrome density and Tufte's word-sized graphics. On desktop, small SVGs carry the graphics: a split bar of your messages against Claude's replies, a countdown meter for the cache, and a chart of the last 40 messages. On the desktop the chart is one Svg per message (`chartSlots`), each in a keyed Box that is its own hover target: hovering lights the column, reveals the message's number, cost and first words beside the section's title (a `scope` group, so the readout sits outside the column), and shows ↓ under the bar. Pressing ↓ scrolls the pane to the row (`$.ui.scroll` to the row's key, then `nearest` to its Details button in case a Box key is no target), and the column and row stay lit for six seconds, so a press that landed can be told from a scroll that didn't move; a toast says so when both scrolls are refused. An Svg can't say where it was clicked and a Button holds only text, so ↓ is the click target. It sits in the layout, in a row kept for it: the pointer passes through an absolutely placed box to its parent, so a button floated over the bar never gets the click. That row has no width of its own, so a ↓ wider than a narrow column spills over both sides, centered, instead of widening the column and shifting every bar after it: hovering changes how the chart looks, never where anything is. Mobile and the editor keep the single SVG with tooltips (`miniChartSvg`), since mobile draws each Svg in a web view of its own; the terminal gets a text meter and a sparkline. The account's limits as such are left out, since the app already shows them; the weekly limit section is about this chat's part of the weekly one. It shows this chat's share since the last weekly reset (`weekWindow`, from the newest reading this chat or the calibration has): this chat's own ledger series (`chatSeries`, so a fork's copied history stays out) since the window began, times the rate, and the reset time, on a meter of the whole limit split by chat (`stackedMeterSvg`): this chat in orange, each other chat here in a color of its own (the four biggest by name, else three and the rest together; colors in the order the chats first spent this week, so a chat that grows past another keeps its color; the hues follow the dataviz reference palette, skipping blue, which means your messages, and the status colors, and pass its checks on both surfaces), and Unknown in gray: the reading's percent less every chat's estimate, which is what the meter can't see (claude.ai, the phone, another computer, a chat on an older meter). A list under the bar names each part with its share, in the bar's order. The other chats come from their ledger entries, which carry each chat's title (its session title from the settings hooks' events, else its first message); the calibration works out each one's dollars since the window began (`weekByChat`). After a reset inside the week (`lastReset`: the reading dropped, as with a Fable reset), the section counts from the moment a chat here first saw the drop: each chat's spend since then, and what the reading showed at that moment as one darker gray part, first, "Used before" that time, since the meter can't tell whose that use was (it also holds use elsewhere between the reset and that moment). A reading left over from before the reset and seen just after it (nearer the old level than the new, within 10 minutes) is set aside, so it can't pass for a second reset or a climb of many points (`withoutStale`); a message whose turn spans the drop says the limit reset rather than showing a negative change. Until the rate is ready the bar is the account's use alone, the section shows the account-wide change measured around the chat's messages this week, as text only, never drawn as the chat's slice, and the list gives each chat's dollars this week. Messages are newest first, 80 drawn, each as two lines: the prompt and its cost, then its number and time with a dim Details toggle and its weekly share (`weeklyShare`) as prominent as the cost: the estimate (≈) once calibrated, else the measured change ("+1%", or "<1%" when the reading didn't move). A third line appears only when a cache lapsed. The rest of a row (the You/Claude split, the full explanation, the measured plan change, the request lines) and the notes on the figures sit behind toggles; the notes say what the weekly estimate is based on (or how far its calibration has got) and what makes it run high.
- *Sample data:* `/usage-meter demo` draws the pane from `lib/demo.ts` (a made-up chat of ten messages, three other chats, the weekly estimate calibrated) with "Sample data" at the top, so the whole pane, the weekly split by chat included, can be seen before a person's own data gets there, and the README's screenshot shows no one's real chats. Display only: nothing of it reaches the ledger, the calibration or the store.
- *Band above the prompt:* the cache countdown, or what the next message will cost to re-write.
- *Toast:* when a turn this load saw finish had to re-write the conversation (its first request found the cache fully lapsed, or a mid-turn request did) and those lapses cost $0.25 or more; agents' lapses aren't counted toward it. Never about an older message, on a reload or a resume.
- *The line under each answer:* the weekly share once calibrated, and each lapse with its own figure: the first request's (worded by why), mid-turn ones, agents'.

## The weekly share (`lib/weekly.ts`)

**The ask.** Show what share of the weekly limit each message used ("≈0.12% of weekly"), and make sure five chats running at once don't throw the figure off.

**Why it is estimated.** Claude Code 2.1.321 gives plugins only the `five_hour` and `seven_day` windows, as a percentage "with at most one decimal". On this account they move in whole-point steps, so the change measured around one message reads +0% or +1%.

**The method.** The steps themselves are exact. Between the moment the reading first showed 41% and the moment it first showed 45%, the window moved 4 points, and the meter knows what was spent in between. The rate is points ÷ API-equivalent dollars, and a message's share is its dollars × the rate. Anthropic publishes no formula for plan usage, so this assumes it runs in proportion to API prices, measured on the person's own account.

**Pooled across chats.** The readings are account-wide, so a chat that divided the points by its own spend while four others worked would put every share about five times too high.

- Every chat running the meter keeps a ledger entry in `$.store` under `ledger1:<session id>`: its spend by the minute, and the weekly readings it saw. The calibration reads every chat's entry.
- **One key per chat**, because of how 2.1.321 keeps the store: one JSON file for the plugin. `get` reads the file afresh, and `set` locks it across processes, re-reads it, replaces one key and rewrites the whole file (checked in the binary). A shared key written by get-modify-set from several chats would lose updates; a key per chat cannot.
- **Compact strings** (base-36 pairs), because the file is rewritten pretty-printed on every write and all keys together are capped at 4 MiB. Entries are kept 8 days, and any chat deletes one older than that.
- A chat writes its entry within 30 seconds of a new request or reading, at once when it sees a step, and after each transcript read.

**Spend comes from the transcript.** The hook's live usage leaves out the advisor model's own run, about $2.40 a call at Fable 5.2's rates for a 225k-token conversation, and a denominator without it would put every share too high. So a chat's spend is:

- its transcript's own requests, priced as the rows are (`MeterView.spend`, built before the row cap, so it survives the Node helper's JSON);
- the live requests the transcript doesn't hold yet, judged request by request: a main-thread request sent after the transcript's newest one, or an agent's that finished after the read;
- compaction's summary requests, which the transcript never holds.

A forked session's file starts with its original's history, copied under the original's `sessionId` (two such files on this machine, one with 711 copied response lines). Only lines carrying the file's own session id count, or the same requests would be in two chats' ledgers. A chat that has never seen a weekly reading (an API key: its spend isn't the plan's) writes nothing.

**Readings.**

- Every response, an agent's included, carries the readings and updates the session's, and the engine drops one older than the last it applied (checked in the binary). So the readings are polled after each request, at most every 5 seconds, and on a `session.measure` whose `changed` includes `rateLimits`.
- Never at `turn.start`: that reading is the last response's, possibly hours old.
- A chat folds its readings into runs: the value, the window's reset time, when the value was first known (the end of the response that first reported it), and the latest time it was known to hold (the start of the last request that reported it). An hour with no reading starts a new run.

**The calibration.**

- Readings are grouped by window (reset times within an hour) and split into spells wherever no chat had a reading for an hour, and wherever the reading drops 2 points or more below the highest seen before it in the same window: a reset inside the week (`RESET_DROP`), of the whole limit or of one model's part of it, as a Fable reset gives Fable's use back. Claude Code passes plugins only the overall weekly window, so a reset like that shows only as the reading dropping; a stale reading from another chat is at most a step behind. Splitting there lets the steps after a reset count: they sit below values already seen that week, so in one spell none of them could anchor.
- In each spell, a value counts as an **anchor** when a lower value was known to hold at most 10 minutes before it was first seen. The step happened inside that bracket, and the chats' spend inside it is how far the stretch's end could be off. A lower reading that arrives after a higher one (another chat's stale value) is no evidence.
- A spell's stretch runs from its first anchor to its last. The rate is all the stretches' points over all their spend, with each minute's dollars counted in proportion to the part of the minute inside.
- An idle spell boundary leaves out the points crossed while no chat here was working: use elsewhere while this computer was idle (the phone overnight) never enters the rate.
- Steps from the last 2 minutes wait, so every working chat has written its entry (never more than 30 seconds behind).
- It looks back 7 days.
- It shows once the stretches span 3 points and the spend inside the anchors' brackets stays under a quarter of the spend measured. Until then each message shows the measured change, and the pane's notes say how many points the calibration has.
- A chat works the calibration out again shortly after it loads, before the line under an answer and every 2 minutes (at most once a minute), and just over 2 minutes after it sees a step.

**Considered and not done.**

- *Calibrating on this chat's own spend:* about five times too high with five chats.
- *Summing spend from every transcript on disk*, which would also see chats not running the meter: the mod reads files up to 4 MiB, this machine's transcripts run to hundreds of megabytes, and a Node pass over all of them for every calibration is too slow. The readings would still need the ledger.
- *A Fable-specific figure:* Claude Code tracks per-model buckets (`model_scoped` on its `/usage` screen), but 2.1.321 doesn't pass them to plugins.

**What makes it run high.** Use the ledger can't see while chats here are working, which moves the readings without adding to the spend:

- claude.ai in a browser, the phone, or another computer;
- a chat on this computer that hasn't loaded this version of the meter (after an update, `/reload-plugins` in each open chat);
- a chat with the meter turned off.

A mix of models or caching unlike the calibration's can shift it either way. The pane's notes and the README say so.

## Tested

- `test/core.test.ts`: 57 unit tests on synthetic transcripts (`npm test`). The weekly share's include five chats at once against one chat spending the same (the same rate) and against one chat counting its own spend (five times too high), too few points, an idle gap with use elsewhere, a step seen too late to anchor, a weekly reset, a fork's copied history, the advisor's own run, and live requests the transcript doesn't hold yet.
- `plugins/usage-meter/tests/meter.test.tsx`: 17 tests in the engine's own test kit (`claude plugin test`). They drive live turns and check the pane, the band and the line under each answer, on desktop and terminal, including a turn a background task started, an agent that keeps working after its message was read, and an agent a later message resumes. For the weekly share, the store is seeded with five chats' ledger entries, this one among them. The tests check the estimate beside the row's cost, in the weekly limit section (this chat's spend this week, stored and live) and under the answer; what the notes say it's based on; this chat's entry keeping what it stored before the load; the measured change shown while calibrating; a step written at once; and a chat off a subscription writing nothing.
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
