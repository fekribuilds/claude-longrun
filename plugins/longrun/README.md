# longrun: timed autonomous runs for Claude Code

A Claude Code mod (function hooks, early access). Give Claude a time budget and
a goal, go away, come back to finished work.

## Run it

```
cd <folder that contains longrun/>
claude --dangerously-skip-permissions --plugin-dir ./longrun
```

If your Claude Code build still gates mods, prefix with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.
Needs a build with mods (the docs describe v2.1.287+). Terminal and desktop Code tab.

Then, inside the session:

```
/longrun 6 finish the billing refactor and get all tests green
/longrun status
/longrun stop
```

## What it does

- **Keeps Claude working until the deadline.** A `classic.Stop` hook refuses each
  stop and re-prompts with time left, limits and a nudge to pick the most valuable
  remaining work.
- **Stops early when truly done.** Claude must print `LONGRUN_DONE` alone on a
  line. The first claim triggers one audit pass (re-read goal, run tests, review
  diff). A second claim ends the run. Three nudges in a row with no tool use also
  ends it (stuck guard).
- **Graceful stop.** `/longrun wrap` delivers a wrap-up request at Claude's next tool
  call (or at turn end, or immediately if it is idle). Claude finishes only the
  current step, reports what it did, what it planned next and what is risky, and
  asks "Do you want me to continue now?". `/longrun continue [hours]` resumes the
  run with the time that was left.
- **Wrap-up at the deadline.** One final turn to leave a clean repo, update
  `LONGRUN_NOTES.md`, and summarize. Then it stops.
- **Model switching by limits.** On every request in the main loop, `turn.step`
  picks a model from `CONFIG.ladder` based on the highest of the 5-hour, 7-day and
  spend-limit percentages (`stepDownAt: [70, 90]`).
- **Knows its remaining budget.** The `mcp__longrun__budget` tool returns time
  left, 5h/7d %, context %, cost and model. The same line is in every nudge and
  in the status line.
- **Pause and resume around limits.** At 97%+ it lets Claude stop, then submits a
  "continue" prompt after the window resets, if that is before the deadline.
- **Bash guard.** Blocks a few catastrophic commands (rm -rf on root/home,
  force-push or direct push to main/master, mkfs/dd to a device, curl | sh).
  This is a safety net, not a sandbox.

## Settings

Edit `CONFIG` at the top of `hooks/register.ts`: model ladder (use ids your plan
can run), step-down thresholds, pause threshold, `maxCostUsd` cap, audit passes.
Run `/reload-plugins` after editing.

## Limits to know about

- Permissions bypassed means nothing asks before acting. Use a git branch, a
  container or a throwaway checkout.
- Plan-limit percentages exist only on subscription plans. On an API key they are
  empty: model switching then stays on the top tier and pausing never triggers, so
  set `maxCostUsd` instead.
- The pause-and-resume timer lives in the session. If you quit Claude Code, the
  run state is saved but the timer is lost.
- Verified by `claude plugin validate` and `claude plugin test` (stop logic:
  nudging, done audit, deadline wrap-up, stuck guard). Model switching,
  pause/resume and the Bash guard are validated but were not exercised in a live
  session.
