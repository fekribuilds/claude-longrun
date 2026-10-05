# claude-longrun

A Claude Code plugin marketplace with one mod, **longrun**: give Claude a time
budget and a goal, go away, and come back to finished work.

> Mods are an early-access Claude Code feature. The API can change between
> releases without notice, so this may need updates after a Claude Code upgrade.

## Install (works in every project)

```bash
claude plugin marketplace add <github-user>/claude-longrun
claude plugin install longrun@claude-longrun
```

That installs at user scope, so it is available in all your projects. Others run
the same two commands on their machine. Update later with
`claude plugin marketplace update claude-longrun`, then restart Claude Code or run
`/reload-plugins`.

Inside Claude Code you can do the same with `/plugin marketplace add <github-user>/claude-longrun`.

## Use

In any project, start a session (add `--dangerously-skip-permissions` for a fully
unattended run, on a git branch or in a container):

```
/longrun 6 finish the billing refactor and get all tests green
/longrun status
/longrun wrap        finish the current step, report, ask whether to continue
/longrun continue    resume after a wrap-up, interrupt or pause (optionally: /longrun continue 2)
/longrun stop        end the run immediately
```

## What it does

- **Works until the deadline.** Each time Claude tries to stop, a Stop hook sends
  it back to work with the time left, usage limits, and a nudge.
- **Stops early when truly done.** Claude prints `LONGRUN_DONE` alone on a line;
  the first claim triggers one audit (re-read goal, run tests, review diff), the
  second ends the run. Three nudges in a row with no tool use also end it.
- **Wrap-up turn at the deadline** to leave a clean repo and a summary.
- **`/longrun wrap`** lets you stop gracefully any time: Claude finishes only its
  current step, then reports what it did, what it planned next, and anything
  risky, and asks if you want to continue. `/longrun continue` resumes the timer.
- **Subagents allowed.** The run tells Claude it may spawn subagents on its own
  (`allowSubagents` in `CONFIG`).
- **Switches models by usage limits** (Opus, then Sonnet, then Haiku) based on
  5-hour, 7-day and spend-limit percentages.
- **Knows its budget.** A `budget` tool and every nudge report time left, limit %,
  context %, cost and model.
- **Recovers from usage limits and errors.** A usage limit, overloaded server or
  dropped connection ends a turn with an API error, and Claude Code does not call
  the Stop hook for those. A watchdog timer notices the quiet run, reads the real
  reset time, waits for it (plus a 2 minute grace so Claude Code's own
  auto-continue can go first), then resumes with the time left. Transient errors
  retry with backoff (3, 6, 12... min, up to 8 tries). Errors that need you
  (auth, billing, bad model) end the run. If the reset is after your deadline the
  run ends. If you press Esc the run pauses and is not auto-resumed; use
  `/longrun continue`.
- **Bash guard** against a few catastrophic commands. A safety net, not a sandbox.

Settings live in `CONFIG` at the top of `plugins/longrun/hooks/register.ts`.
More detail in [plugins/longrun/README.md](plugins/longrun/README.md).

## Caveats

- Plan-limit percentages exist only on subscription plans; on an API key set
  `maxCostUsd` instead.
- Auto-resume needs the session open: the watchdog is a timer inside the running
  Claude Code (keep VS Code / the terminal open and the computer awake).
- Validated and unit-tested for the stop logic; model switching, pause/resume and
  the Bash guard have not been exercised in a live session.

## License

MIT
