# usage-meter

A Claude Code mod that shows how much usage **each message** used. Each one is split into your message (reading the conversation plus your text) and Claude's reply (its output, tool calls, subagents, workflow agents and the advisor). It's measured in tokens as the API reported them, API-equivalent dollars, and the plan-limit points Claude Code measured while the message ran.

It also makes the prompt cache visible:

- **A countdown above the prompt** while the cache is warm.
- **A warning once it has lapsed**, with what your next message will cost to re-write the conversation.
- **A flag on every message that paid for a lapsed cache**, including waits inside a turn, such as a question left pending for hours, and turns a background task or another session started.
- **After a compaction**, a note that the next message rebuilds the cache from the summary.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install usage-meter --marketplace NessDan/claude-token-usage
```

From a shell:

```bash
claude plugin install usage-meter --marketplace NessDan/claude-token-usage
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `NessDan/claude-token-usage`, then **Add plugin**. Every new session then loads it; a chat already open gets it with `/reload-plugins`.

## Use

- **The pane** opens beside the chat in the desktop app, or type `/usage-meter`. Messages are listed newest first. Each of the newest 40 can list its requests: the first 40 main-thread requests and advisor calls one by one (the rest as one line), and each agent as one line.
- **A line under each of Claude's replies** shows what the turn had used when the reply ended (display only). It's counted live, so it leaves out the advisor model's own tokens and anything agents do after the reply; the pane's row adds them once the transcript is read. `/usage-meter notes-off` turns it off.
- **The band above the prompt** has a Hide button, which says how to bring it back. `/usage-meter hide` and `/usage-meter show` do the same by command, and `/usage-meter` on its own shows the band and opens the pane.
- **The report**, for any session on disk, from a terminal in a clone of the repository (Node 22.18+):

  ```bash
  node plugins/usage-meter/cli/usage-report.ts --all
  ```

  `--help` lists the options, including `--html` for a page with a chart.

## How it counts

- **Usage is read from two sources:**
  - live, from every model request as it finishes;
  - after each turn, from the session's transcript, which gives the cache split by lifetime, the advisor model's own tokens and agents' transcripts. Older transcripts (Claude Code 2.1.219 to 2.1.293) lost part of some agents' output counts; those are estimated and marked ≈.

  Transcripts over 4 MB are summarized by `scripts/summarize.ts` through Node.
- **Dollars are Anthropic API list prices.** A subscription doesn't charge them; they are for comparison.
- **Plan points are Claude Code's own readings.** They're account-wide, so they include your other sessions running at the same time. When no reading had come in for a few minutes before a message, its change also covers that time, and the row says since when.

The repository README and `docs/` explain the details.
