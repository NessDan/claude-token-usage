# How Claude Code usage works (and why it spikes)

Everything below was checked against Anthropic's own documentation in November 2026, for Claude Code 2.1.321. Links point to the source of each claim. Where Anthropic doesn't say something, this page says so instead of guessing.

## 1. Every message re-sends the whole conversation

The model has no memory between requests. Each request Claude Code makes carries:

- the system prompt and the tool definitions;
- the whole conversation so far;
- the new part.

One message from you usually sets off many requests. Claude reads, calls a tool, reads the result (another request), and so on until it answers. Subagents, workflow agents and the advisor make requests of their own.

The API reports four token counts for each request:

| Count | What it is |
| --- | --- |
| `input_tokens` | the part that was neither read from nor written to the cache |
| `cache_read_input_tokens` | the part the prompt cache served |
| `cache_creation_input_tokens` | the part written into the cache (split into 5-minute and 1-hour lifetimes) |
| `output_tokens` | what Claude wrote, thinking included |

([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching))

## 2. The prompt cache, and why it matters so much

The rates, relative to the normal input price of the model ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)):

| | Rate |
| --- | --- |
| Reading from the cache | 0.1× on most models. 0.05× on Opus 5.5 and Sonnet 5.5, and 0.025× on Fable/Mythos 5.1 and 5.2. |
| Writing to the cache, 5-minute lifetime | 1.25× |
| Writing to the cache, 1-hour lifetime | 2× |

So the same conversation costs:

- **20× more** to write again than to read on most models;
- **40× more** on Opus 5.5 and Sonnet 5.5;
- **80× more** on Fable 5.1 and 5.2.

That's all at the 1-hour rate. A 300,000-token conversation on Opus 5.5 costs about $0.06 to read from the cache and $2.40 to write back into it, in API dollars.

**How long the cache lasts** ([which TTL each request gets](https://code.claude.com/docs/en/prompt-caching#which-ttl-each-request-gets)):

- **On a subscription, within your plan's included usage, the main conversation gets the 1-hour cache.**
- With an API key, a cloud provider, or once you're drawing on usage credits (overage), it gets 5 minutes.
- Subagents, workflows, forks, compaction and session titles get 5 minutes even on a subscription.
- You can change this with `promptCacheTtl`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `ENABLE_PROMPT_CACHING_1H` and `FORCE_PROMPT_CACHING_5M` ([choose the TTL yourself](https://code.claude.com/docs/en/prompt-caching#choose-the-ttl-yourself)).

**What keeps it warm.** Every request that reads the cache restarts the timer, for free. The lifetime counts from the **start** of a request, so a very long response eats into it too ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)).

**What happens when you come back late.** "Your first message after a break longer than the cache lifetime misses the cache and reprocesses your full context" ([costs](https://code.claude.com/docs/en/costs#why-usage-climbs-in-a-long-session)). The usage meter shows this on the message that paid for it, and the band above the prompt counts down so you can see it coming.

**Other things that throw the cache away** ([actions that invalidate the cache](https://code.claude.com/docs/en/prompt-caching#actions-that-invalidate-the-cache)):

- switching models, including plan-mode model switches and automatic fallback;
- changing effort, on most models (with an API key or a subscription, Fable 5.1 and later, Opus 5.5, Sonnet 5.5 and Haiku 5.5 keep the cache);
- toggling fast mode: fast and standard speed keep separate caches, so the first time you turn it on the next request reads the whole conversation uncached, and each later toggle reads whatever the other speed hasn't cached;
- adding or removing MCP servers or tools, but only when tool search is off or unavailable (by default MCP tools sit behind tool search, which keeps the first request's tool list, so these changes keep the cache);
- compaction;
- dropping old images;
- the first conversation after a Claude Code update.

These keep the cache: editing files or CLAUDE.md, changing permission mode, invoking skills, `/rewind`, and spawning subagents.

## 3. Compaction and idle compaction

**Compaction.** When a conversation fills the context window, Claude Code summarizes it ([how compaction works](https://code.claude.com/docs/en/prompt-caching#compacting-the-conversation)).

- The summary is **a separate request that re-reads the conversation**. It's cheap while the cache is warm and expensive when it isn't.
- After compaction, the next request writes the new, much shorter context into the cache.
- The summary request isn't written to the session's transcript. The usage meter records it live and shows it as a row of its own.

**Idle compaction** is on by default (`idleCompaction`; [settings](https://code.claude.com/docs/en/settings-reference#idlecompaction)). It runs only when all of these hold:

- the conversation is on the **1-hour cache**;
- auto-compact is on;
- the conversation has reached **200,000 tokens** (`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`, minimum 100,000);
- about an hour has passed and the computer stays awake.

It summarizes the conversation so your next message sends the summary instead of everything. In the desktop app the notice reads "Compacted using a summary written while you were away" ([changelog 2.1.314](https://code.claude.com/docs/en/changelog)).

What that means in practice:

- It doesn't help conversations under the threshold.
- The summary itself costs some usage ([background token usage](https://code.claude.com/docs/en/costs#background-token-usage)).
- To turn it off, set `"idleCompaction": false`.

## 4. A question left waiting for hours

The docs don't cover this case directly, but the rules above settle it. If Claude asks you something, or waits for a permission, and you answer after the cache has lapsed, the request after your answer re-writes the conversation. It's the same cost as coming back to a new message, just inside a turn. The usage meter flags these as "mid-turn wait"; a lapse inside a turn with another cause (the model changed, or the cache missed within minutes) is labelled with that cause instead.

## 5. Usage you didn't ask for

These can use tokens while you're idle ([costs](https://code.claude.com/docs/en/costs#why-usage-climbs-in-a-long-session)):

- session recap;
- idle compaction;
- prompt suggestions (mostly cache reads);
- scheduled tasks and loops (each sends your full context);
- goal check-ins;
- messages from other sessions;
- background agents and workflows.

## 6. How this maps to plan limits

Anthropic publishes **no formula** for how tokens count against the Pro, Max or Ultra limits. What they do say:

- **Limit structure.**
  - Pro and Max have a 5-hour session limit and a weekly limit.
  - Ultra has a weekly limit, and verified Ultra accounts have no 5-hour limit.
  - Max and Ultra also have a separate weekly limit for Fable.
  - Claude and Claude Code share all of these ([help center](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)).
- **What drives usage.** "Your usage is affected by several factors, including the length and complexity of your conversations, the features you use, which Claude model you're chatting with, and the effort level you've selected" ([usage and length limits](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work)).
- **Caching on a subscription.** Writing about Claude Code's caching on a subscription: "You don't see these prices directly, but the same requests are what draw down your limits" ([claude.com](https://claude.com/resources/articles/maximizing-the-value-of-your-claude-code-sessions)).
- **Cached re-reads still count.** Re-reading history from the cache still draws usage, at the cached rate ([costs](https://code.claude.com/docs/en/costs#why-usage-climbs-in-a-long-session)).

That's why the meter shows **tokens** as the API reported them (except requests whose transcript kept only part of the output count, mostly agent requests from Claude Code 2.1.219 to 2.1.293: those are estimated from the text written, likely low, and marked ≈), **API-equivalent dollars** priced from those tokens at list rates as a common scale, and the **plan-limit change** Claude Code itself measured around each message. It never turns tokens or dollars into plan points, or plan points into either.

## 7. What already existed (November 2026)

**Built in:**

- `/usage` (also `/cost`, `/stats`) shows session totals, with a "Prompt cache (main)" line that counts misses for the session.
- The status line gets cache fields (`prompt_cache.warm`, `recache_tokens_if_cold`, ...) for terminal scripts.
- The desktop app shows context and plan rings.
- The VS Code extension has a prompt-cache clock. The desktop app has none.

**Community mods in the plugin directory:**

| Mod | What it shows |
| --- | --- |
| [Turn Usage](https://github.com/gmorubio/claude-mods/tree/HEAD/turn-usage) | A plan-% change under each reply, in whole points |
| [ccOverhead](https://github.com/shengyy/ccoverhead) | The last turn's cost and a "rewrote N tokens" cache state |
| [Token Weather Usage](https://github.com/augiefra/claude-mods/tree/HEAD/plugins/token-weather-usage) | The last prompt's cost and the cache time left |
| [Usage Bars](https://github.com/pepperonas/usage-bars) | A per-answer plan-% change |

**Outside the app:** [ccusage](https://github.com/ryoppippi/ccusage) (daily and session reports), [claude-code-log](https://github.com/daaain/claude-code-log) (per-message tokens in a browser page), and [cc-probeline](https://pkg.go.dev/github.com/labzink/cc-probeline) (a per-turn priced status line in the terminal).

**What none of them does:** a per-message ledger in the desktop app that splits your message from Claude's reply, puts tokens, dollars and plan points on the same row, and pins the idle penalty to the message that paid it.

## 8. Habits that save usage (from the docs above)

- **Before you step away from a long conversation, run `/compact`**, or let idle compaction do it if the conversation is over 200K tokens. A summary made while the cache is warm is cheap.
- **Start a new conversation (`/clear`, which costs nothing) for a new topic**, instead of dragging a long one along.
- **Answer pending questions and permission prompts within the hour**, or expect the next request to re-cache.
- **Don't switch model or fast mode mid-conversation** unless you mean to: the next request re-reads uncached whatever the new model or speed hasn't cached (all of it after a model switch, or the first time fast mode goes on). Changing effort does the same on other models and setups, but with an API key or a subscription, Fable 5.1 and later, Opus 5.5 (the default), Sonnet 5.5 and Haiku 5.5 keep the cache.
- **Agents and workflows are powerful but costly.** Each agent re-sends its own context on every step, and their cache lasts only 5 minutes.
