import type { Register, SessionUsage } from 'claude-code'

// ---------------------------------------------------------------------------
// longrun: timed autonomous runs for Claude Code.
//
//   /longrun <hours> <goal>   start (e.g. /longrun 6 finish the billing refactor)
//   /longrun status           show time left, limits, model
//   /longrun stop             end the run
//
// Run Claude Code with permissions bypassed yourself if you want it fully
// unattended (this mod never changes the permission mode). Do that on a git
// branch, in a container or in a throwaway checkout.
// ---------------------------------------------------------------------------

const CONFIG = {
  /** Claude must print this alone on a line when truly nothing is left. */
  marker: 'LONGRUN_DONE',
  /** "Are you really done?" audits before an early finish is accepted. */
  auditPasses: 1,
  /** Best/most expensive first. Each threshold in stepDownAt moves one tier down. */
  ladder: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'],
  /** Highest rate-limit % used (5h, 7d or spend) at which to step down a tier. */
  stepDownAt: [70, 90],
  /** At/above this %, stop working and resume when the window resets. */
  pauseAtPercent: 97,
  /** End the run when session cost passes this many USD. 0 = no cap. */
  maxCostUsd: 0,
  /** End the run after this many nudges in a row with no tool use in between. */
  maxIdleNudges: 3,
  /** Status line refresh interval. */
  statusEveryMs: 30_000,
}

const BASH_DENY: { re: RegExp; why: string }[] = [
  { re: /\brm\s+-[a-zA-Z]*(rf|fr)[a-zA-Z]*\s+(\/|~|\$HOME|\*)(\s|$|\/\*)/, why: 'recursive delete of root/home/everything' },
  { re: /\bgit\s+push\b[^;&|]*(--force|-f\b)[^;&|]*\b(main|master)\b/, why: 'force-push to main/master' },
  { re: /\bgit\s+push\s+\S+\s+(HEAD:)?(main|master)\b/, why: 'direct push to main/master (use a branch)' },
  { re: /\b(mkfs(\.\w+)?|dd\s+if=\S+\s+of=\/dev\/)/, why: 'disk-destroying command' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, why: 'fork bomb' },
  { re: /\bcurl\b[^|;&]*\|\s*(sudo\s+)?(ba|z)?sh\b/, why: 'piping a download into a shell' },
  { re: /\bchmod\s+-R\s+777\s+\//, why: 'recursive chmod 777 on root' },
]

type Run = {
  active: boolean
  goal: string
  startedAt: number
  deadline: number
  doneClaims: number
  wrapUp: boolean
  idleNudges: number
  pausedUntil?: number
  ended?: string
}

type Snap = {
  five?: number
  seven?: number
  spend?: number
  ctx?: number
  cost?: number
  /** Highest used-% across the plan windows; 0 when none reported. */
  pressure: number
  resetsAt?: string
}

type Decision =
  | { kind: 'allow'; end?: string }
  | { kind: 'block'; text: string }
  | { kind: 'pause'; until: number }

// ---- pure helpers: no `$` in here ------------------------------------------

const short = (m: string) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '')

const fmt = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(m / 60)
  return h ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

const pct = (n?: number) => (n === undefined ? '?' : `${Math.round(n)}%`)

function summarize(u: SessionUsage): Snap {
  const by = (k: string) => u.rateLimits.find((r) => r.kind === k)
  const five = by('five_hour')
  const seven = by('seven_day')
  const spend = by('spend_limit')
  const windows = [five, seven, spend].filter((w): w is NonNullable<typeof w> => !!w)
  const worst = [...windows].sort((a, b) => b.percentUsed - a.percentUsed)[0]
  return {
    five: five?.percentUsed,
    seven: seven?.percentUsed,
    spend: spend?.percentUsed,
    ctx: u.context.percent,
    cost: u.cost?.usd,
    pressure: worst?.percentUsed ?? 0,
    resetsAt: worst?.resetsAt,
  }
}

function pickModel(s: Snap): string {
  const tier = CONFIG.stepDownAt.filter((t) => s.pressure >= t).length
  return CONFIG.ladder[Math.min(tier, CONFIG.ladder.length - 1)] ?? CONFIG.ladder[0]!
}

function budgetLine(s: Snap, left: number, model: string): string {
  const parts = [`time left ${fmt(left)}`, `5h limit ${pct(s.five)}`, `7d limit ${pct(s.seven)}`]
  if (s.spend !== undefined) parts.push(`spend limit ${pct(s.spend)}`)
  parts.push(`context ${pct(s.ctx)}`)
  if (s.cost !== undefined) parts.push(`cost $${s.cost.toFixed(2)}`)
  parts.push(`model ${model ? short(model) : '?'}`)
  return parts.join(' | ')
}

const DONE_LINE = new RegExp(`^\\s*${CONFIG.marker}\\s*$`, 'm')

function kickoff(goal: string, hours: number): string {
  return [
    `LONG RUN MODE. You may work autonomously for up to ${hours}h on: ${goal}`,
    '',
    'Rules:',
    '- Nobody is watching. Do not ask questions; make reasonable decisions and record them in LONGRUN_NOTES.md.',
    '- Work on a git branch, commit often with clear messages, never push to main/master.',
    '- Keep going while there is valuable work left: implement, run tests, review your own diff, fix, improve. Do not invent busywork.',
    `- When truly nothing is left (goal met, tests and lint pass, self-review done), end your message with ${CONFIG.marker} alone on its own line. I will audit that claim once before accepting it.`,
    '- Call the mcp__longrun__budget tool whenever you want to see time left, rate-limit usage, context fill and the current model.',
    '- If usage limits run out, the session pauses and resumes by itself after the window resets.',
  ].join('\n')
}

/** What to do when Claude tries to stop. Pure: the hook applies the result. */
function decide(
  r: Run,
  s: Snap,
  now: number,
  last: string,
  touchedTools: boolean,
  line: string,
): Decision {
  const left = r.deadline - now

  if (CONFIG.maxCostUsd > 0 && (s.cost ?? 0) >= CONFIG.maxCostUsd) {
    return { kind: 'allow', end: `cost cap $${CONFIG.maxCostUsd} reached` }
  }

  // Out of plan limits: sleep until the window resets, if that is before the deadline.
  if (s.pressure >= CONFIG.pauseAtPercent) {
    const resetAt = s.resetsAt ? Date.parse(s.resetsAt) : NaN
    if (Number.isFinite(resetAt) && resetAt + 30_000 < r.deadline) {
      return { kind: 'pause', until: resetAt + 30_000 }
    }
    return { kind: 'allow', end: `usage limits exhausted (${pct(s.pressure)}) and no reset before the deadline` }
  }

  // Deadline reached: one wrap-up turn, then allow the stop.
  if (left <= 0) {
    if (!r.wrapUp) {
      r.wrapUp = true
      return {
        kind: 'block',
        text: `Time is up (${line}). Do not start new work. Get the repo into a clean, consistent state (tests passing if possible, work committed), update LONGRUN_NOTES.md, and give a short final summary: what is done, what is left, how to continue.`,
      }
    }
    return { kind: 'allow', end: 'deadline reached' }
  }

  // Claimed done: audit, then accept.
  if (DONE_LINE.test(last)) {
    r.doneClaims++
    if (r.doneClaims > CONFIG.auditPasses) {
      return { kind: 'allow', end: 'Claude finished the work before the deadline' }
    }
    return {
      kind: 'block',
      text: `You declared the work done with ${fmt(left)} left. Audit that claim now: re-read the goal ("${r.goal}"), run the full test suite and linter, review your whole diff for bugs and loose ends, and list anything still open. If something is open, fix it and keep working (do not print ${CONFIG.marker}). If truly nothing is left, print ${CONFIG.marker} alone on its own line again.`,
    }
  }

  // Stopped without claiming done: nudge, but not forever if it is stuck.
  r.doneClaims = 0
  r.idleNudges = touchedTools ? 0 : r.idleNudges + 1
  if (r.idleNudges >= CONFIG.maxIdleNudges) {
    return { kind: 'allow', end: `stalled: ${CONFIG.maxIdleNudges} nudges in a row with no tool use` }
  }
  return {
    kind: 'block',
    text: `Keep going, ${fmt(left)} remain (${line}). Pick the most valuable remaining work toward the goal ("${r.goal}"): finish unfinished items, add or fix tests, review your own changes, tighten edge cases. Do not stop to ask questions. If there is genuinely nothing left, print ${CONFIG.marker} alone on its own line.`,
  }
}

// ---- the mod ----------------------------------------------------------------

export const register: Register = (on) => {
  let run: Run | undefined
  let storeKey = 'longrun'
  let toolCalls = 0
  let lastModel = ''

  on('session.start', async ($, e, next) => {
    storeKey = `longrun:${await $.session.id()}`
    const saved = (await $.store.get(storeKey)) as Run | null | undefined
    if (saved?.active) run = saved

    // Live status line, refreshed on a timer.
    $.clock.every(CONFIG.statusEveryMs, async () => {
      if (!run?.active) return
      const now = await $.clock.now()
      const s = summarize(await $.session.usage())
      const pause = run.pausedUntil ? `paused until reset (${fmt(run.pausedUntil - now)}) | ` : ''
      $.ui.status(`longrun ${pause}${budgetLine(s, run.deadline - now, lastModel)}`)
    })

    // Register last: a refused registration must not skip the rest.
    try {
      await $.tool.register({
        name: 'budget',
        description:
          'Report the long-run budget: time left before the deadline, 5-hour and 7-day usage-limit percentages, context window fill, session cost and current model.',
        inputSchema: { type: 'object', properties: {} },
      })
      await $.command.register({
        name: 'longrun',
        description: 'Timed autonomous run: /longrun <hours> <goal> | status | stop',
        argumentHint: '<hours> <goal> | status | stop',
        immediate: true,
      })
    } catch (err) {
      $.ui.toast(`longrun: registration failed: ${String(err)}`)
    }
    return next(e)
  })

  on('command.run', { command: 'longrun' }, async ($, e) => {
    const args = (e.args ?? '').trim()

    if (args === 'stop') {
      if (!run?.active) return { text: 'longrun: no active run.' }
      run.active = false
      run.ended = 'stopped by you'
      await $.store.set(storeKey, run)
      $.ui.status(undefined)
      return { text: 'longrun: run stopped. Claude will stop at its next turn end.' }
    }

    if (args === 'status' || args === '') {
      if (!run?.active) {
        return {
          text: `longrun: no active run${run?.ended ? ` (last run ended: ${run.ended})` : ''}. Usage: /longrun <hours> <goal>`,
        }
      }
      const now = await $.clock.now()
      const s = summarize(await $.session.usage())
      return { text: `longrun: ${budgetLine(s, run.deadline - now, lastModel)}\nGoal: ${run.goal}` }
    }

    const m = /^([0-9]*\.?[0-9]+)\s*h?\s*([\s\S]*)$/.exec(args)
    if (!m) return { text: 'longrun: usage is /longrun <hours> <goal>, e.g. /longrun 6 finish the billing refactor' }
    const hours = Number(m[1])
    if (!(hours > 0) || hours > 48) return { text: 'longrun: hours must be between 0 and 48.' }
    const goal = (m[2] ?? '').trim() || 'continue the current task and finish everything outstanding'

    const now = await $.clock.now()
    run = {
      active: true,
      goal,
      startedAt: now,
      deadline: now + hours * 3_600_000,
      doneClaims: 0,
      wrapUp: false,
      idleNudges: 0,
    }
    toolCalls = 0
    await $.store.set(storeKey, run)
    // Queued until the session is idle; do not await it inside this handler.
    void $.prompt.submit({ text: kickoff(goal, hours) }).catch(() => undefined)
    return { text: `longrun: started, ${hours}h budget. Goal: ${goal}` }
  })

  // Safety net: a long run is usually unattended with permissions bypassed.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!run?.active) return next(e)
    const cmd = String((e as { command?: unknown }).command ?? '')
    for (const { re, why } of BASH_DENY) {
      if (re.test(cmd)) {
        return { deny: `longrun blocked this command (${why}). Find a safer way to reach the goal.` }
      }
    }
    return next(e)
  })

  // Count real activity (the budget tool does not count as progress).
  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'mcp__longrun__budget') toolCalls++
    return next(e)
  })

  // The tool Claude calls to know its own remaining time and limits.
  on('tool.call', { tool: 'mcp__longrun__budget' }, async ($) => {
    if (!run?.active) return { result: 'No active longrun. Start one with /longrun <hours> <goal>.' }
    const now = await $.clock.now()
    const s = summarize(await $.session.usage())
    const noLimits = s.five === undefined && s.seven === undefined && s.spend === undefined
    const note = noLimits ? ' (no plan-limit readings yet: API-key use, or no response reported them)' : ''
    return { result: budgetLine(s, run.deadline - now, lastModel) + note }
  })

  // Choose the model per request from the usage limits (main loop only).
  on('turn.step', async function* ($, e, next) {
    if (!run?.active || e.agentId) return yield* next(e)
    const s = summarize(await $.session.usage())
    const model = pickModel(s)
    if (model !== lastModel) {
      if (lastModel) $.ui.log(`longrun: model ${short(lastModel)} -> ${short(model)} (limits at ${pct(s.pressure)})`)
      lastModel = model
    }
    return yield* next({ ...e, model })
  })

  // Keep the status line fresh after every turn.
  on('session.measure', async ($, e, next) => {
    if (run?.active) {
      const now = await $.clock.now()
      const s = summarize(await $.session.usage())
      const pause = run.pausedUntil ? `paused until reset (${fmt(run.pausedUntil - now)}) | ` : ''
      $.ui.status(`longrun ${pause}${budgetLine(s, run.deadline - now, lastModel)}`)
    }
    return next(e)
  })

  // The heart of it: refuse to stop while time and work remain.
  on('classic.Stop', async ($, e, next) => {
    const r = run
    if (!r?.active) return next(e)

    const now = await $.clock.now()
    const s = summarize(await $.session.usage())
    const line = budgetLine(s, r.deadline - now, lastModel)
    const touched = toolCalls > 0
    toolCalls = 0

    const d = decide(r, s, now, e.last_assistant_message ?? '', touched, line)

    if (d.kind === 'block') {
      await $.store.set(storeKey, r)
      return { block: d.text }
    }

    if (d.kind === 'pause') {
      r.pausedUntil = d.until
      await $.store.set(storeKey, r)
      $.ui.toast(`longrun: limits at ${pct(s.pressure)}, pausing until reset`)
      $.clock.after(Math.max(1000, d.until - now), async () => {
        if (!run?.active) return
        run.pausedUntil = undefined
        await $.store.set(storeKey, run)
        void $.prompt.submit({ text: 'The usage-limit window has reset. Continue the long run where you left off.' }).catch(() => undefined)
      })
      return next(e)
    }

    if (d.end) {
      r.active = false
      r.ended = d.end
      await $.store.set(storeKey, r)
      $.ui.status(undefined)
      $.ui.toast(`longrun ended: ${d.end}`)
    }
    return next(e)
  })
}
