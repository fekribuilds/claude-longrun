# claude-longrun

A Claude Code plugin marketplace with one mod, **longrun**: give Claude a time
budget and a goal, go away, and come back to finished work.

> Mods are an early-access Claude Code feature. The API can change between
> releases without notice, so this may need updates after a Claude Code upgrade.

## Install (works in every project)

```bash
claude plugin marketplace add fekribuilds/claude-longrun
claude plugin install longrun@claude-longrun
```

That installs at user scope, so it is available in all your projects. Others run
the same two commands on their machine. Update later with
`claude plugin marketplace update claude-longrun`, then restart Claude Code or run
`/reload-plugins`.

Inside Claude Code you can do the same with `/plugin marketplace add fekribuilds/claude-longrun`.

## Use

In any project, start a session (add `--dangerously-skip-permissions` for a fully
unattended run, on a git branch or in a container):

```
/longrun 6 finish the billing refactor and get all tests green
/longrun status
/longrun stop
```

## What it does

- **Works until the deadline.** Each time Claude tries to stop, a Stop hook sends
  it back to work with the time left, usage limits, and a nudge.
- **Stops early when truly done.** Claude prints `LONGRUN_DONE` alone on a line;
  the first claim triggers one audit (re-read goal, run tests, review diff), the
  second ends the run. Three nudges in a row with no tool use also end it.
- **Wrap-up turn at the deadline** to leave a clean repo and a summary.
- **Switches models by usage limits** (Opus, then Sonnet, then Haiku) based on
  5-hour, 7-day and spend-limit percentages.
- **Knows its budget.** A `budget` tool and every nudge report time left, limit %,
  context %, cost and model.
- **Pauses and resumes** around rate-limit windows when the reset falls before
  the deadline.
- **Bash guard** against a few catastrophic commands. A safety net, not a sandbox.

Settings live in `CONFIG` at the top of `plugins/longrun/hooks/register.ts`.
More detail in [plugins/longrun/README.md](plugins/longrun/README.md).

## Caveats

- Plan-limit percentages exist only on subscription plans; on an API key set
  `maxCostUsd` instead.
- The pause-and-resume timer lives in the session and is lost if you quit.
- Validated and unit-tested for the stop logic; model switching, pause/resume and
  the Bash guard have not been exercised in a live session.

## License

MIT
