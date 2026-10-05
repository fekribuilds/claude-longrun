import { describe, expect, mock, test, tier } from 'claude-code/testing'

tier('user')

const usage = (five: number, resetsAt?: string) => ({
  startedAt: 0,
  context: { window: 200000, percent: 10, tokens: 20000 },
  rateLimits: [{ kind: 'five_hour', percentUsed: five, resetsAt }],
  cost: { usd: 1 },
})

const stopInput = (last: string) => ({
  session_id: 's1',
  transcript_path: '/t',
  cwd: '/work',
  hook_event_name: 'Stop' as const,
  stop_hook_active: false,
  last_assistant_message: last,
})

const START = Date.parse('2026-10-05T02:00:00Z')
const limits: { five: number; resetsAt?: string } = { five: 20 }

async function boot($: any, on: any, five = 20, resetsAt?: string, hours = '2') {
  limits.five = five
  limits.resetsAt = resetsAt
  const clock = mock.clock(on, { now: START })
  mock.store(on, {})
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('classic.Stop', () => ({}))
  on('classic.StopFailure', () => ({}))
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('session.id', () => ({ value: 's1' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('session.usage', () => ({ value: usage(limits.five, limits.resetsAt) }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', ($: any, e: any) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'longrun', args: `${hours} build the thing`, origin: { kind: 'composer' } })
  return clock
}

const submitted: string[] = []

describe('register', () => {
  test('starting a run sends the kickoff prompt from the timer', async ($, on) => {
    submitted.length = 0
    const clock: any = await boot($, on)
    expect(submitted).toEqual([]) // nothing is sent from inside the command handler
    await clock.advance(1500)
    expect(submitted.length).toBe(1)
    expect(submitted[0]).toContain('LONG RUN MODE')
    expect(submitted[0]).toContain('build the thing')
    expect(submitted[0]).toContain('authorized to spawn subagents')
    const status: any = await $.command.run({ command: 'longrun', args: 'status', origin: { kind: 'composer' } })
    expect(status.text).toContain('Last prompt sent by longrun: sent')
  })

  test('blocks the stop while time remains and Claude has not claimed done', async ($, on) => {
    await boot($, on)
    const r: any = await $.classic.Stop(stopInput('I changed a file.'))
    expect(r.block).toContain('Keep going')
    expect(r.block).toContain('time left')
  })

  test('a done claim is audited once, then accepted', async ($, on) => {
    await boot($, on)
    const first: any = await $.classic.Stop(stopInput('All good.\nLONGRUN_DONE'))
    expect(first.block).toContain('Audit that claim')
    const second: any = await $.classic.Stop(stopInput('Audit clean.\nLONGRUN_DONE'))
    expect(second.block).toBeUndefined()
  })

  test('after the deadline: one wrap-up turn, then it may stop', async ($, on) => {
    const clock: any = await boot($, on, 20, undefined, '0.002') // about 7 seconds
    await clock.advance(9_000)
    const wrap: any = await $.classic.Stop(stopInput('still going'))
    expect(wrap.block).toContain('Time is up')
    const done: any = await $.classic.Stop(stopInput('summary'))
    expect(done.block).toBeUndefined()
  })

  test('stops nudging after three turns with no tool use', async ($, on) => {
    await boot($, on)
    const a: any = await $.classic.Stop(stopInput('thinking'))
    const b: any = await $.classic.Stop(stopInput('thinking'))
    const c: any = await $.classic.Stop(stopInput('thinking'))
    expect(a.block).toBeDefined()
    expect(b.block).toBeDefined()
    expect(c.block).toBeUndefined()
  })

  const REPORT =
    'Done this run: refactored the billing module and added tests for the new invoice flow. Planned next: wire the retry logic into the payment client. Open: one flaky test in checkout. Risky: the migration is untested on real data. Do you want me to continue now?'

  const run = ($: any, args: string) => $.command.run({ command: 'longrun', args, origin: { kind: 'composer' } })

  test('wrap while idle sends the wrap-up message, then the report ends the run', async ($, on) => {
    submitted.length = 0
    const clock: any = await boot($, on)
    await clock.advance(1500) // kickoff goes out
    const r: any = await run($, 'wrap')
    expect(r.text).toContain('Claude is idle')
    await clock.advance(1500)
    expect(submitted.length).toBe(2)
    expect(submitted[1]).toContain('WRAP-UP REQUESTED')
    expect(submitted[1]).toContain('Do you want me to continue now?')
    const stop: any = await $.classic.Stop(stopInput(REPORT))
    expect(stop.block).toBeUndefined()
    const status: any = await run($, 'status')
    expect(status.text).toContain('wrapped up at your request')
    expect(status.text).toContain('/longrun continue')
  })

  test('wrap: if Claude does not report, it is asked once more, then released', async ($, on) => {
    submitted.length = 0
    const clock: any = await boot($, on)
    await clock.advance(1500)
    await run($, 'wrap')
    const a: any = await $.classic.Stop(stopInput('ok'))
    expect(a.block).toContain('Do not use any more tools')
    const b: any = await $.classic.Stop(stopInput('ok'))
    expect(b.block).toBeUndefined()
  })

  test('continue resumes a wrapped-up run', async ($, on) => {
    submitted.length = 0
    const clock: any = await boot($, on)
    await clock.advance(1500)
    await run($, 'wrap')
    await $.classic.Stop(stopInput(REPORT))
    const c: any = await run($, 'continue')
    expect(c.text).toContain('continuing')
    await clock.advance(3000)
    expect(submitted.some((t) => t.includes('continue the long run'))).toBe(true)
    // nudging is back on
    const r: any = await $.classic.Stop(stopInput('I changed a file.'))
    expect(r.block).toContain('Keep going')
  })

  test('wrap mid-turn is delivered when the turn ends', async ($, on) => {
    submitted.length = 0
    const clock: any = await boot($, on)
    await clock.advance(1500)
    await $.turn.start({ text: '', turnId: 't1' })
    const r: any = await run($, 'wrap')
    expect(r.text).toContain('next step')
    const stop: any = await $.classic.Stop(stopInput('finished a step'))
    expect(stop.block).toContain('WRAP-UP REQUESTED')
  })

  const MIN = 60_000
  const failure = (error: string) => ({
    session_id: 's1', transcript_path: '/t', cwd: '/work', hook_event_name: 'StopFailure' as const, error,
  })
  const resumes = () => submitted.filter((t) => t.includes('continue the long run') || t.includes('Resuming'))

  test('usage limit: waits for the real reset, then resumes', async ($, on) => {
    submitted.length = 0
    const reset = new Date(START + 60 * MIN).toISOString()
    const clock: any = await boot($, on, 20, undefined, '5')
    await clock.advance(1500)
    const base = submitted.length
    limits.five = 100
    limits.resetsAt = reset
    await $.turn.start({ text: '', turnId: 't1' })
    await $.classic.StopFailure(failure('rate_limit'))
    await clock.advance(10 * MIN)
    expect(submitted.length).toBe(base)
    const st: any = await run($, 'status')
    expect(st.text).toContain('Waiting for the usage limit')
    await clock.advance(55 * MIN) // past reset + grace
    expect(submitted.length).toBeGreaterThan(base)
  })

  test('transient error: resumes after idle', async ($, on) => {
    submitted.length = 0
    const clock: any = await boot($, on)
    await clock.advance(1500)
    const base = submitted.length
    await $.turn.start({ text: '', turnId: 't1' })
    await $.classic.StopFailure(failure('overloaded'))
    await clock.advance(10 * MIN)
    expect(submitted.length).toBeGreaterThan(base)
  })

  test('fatal error ends the run', async ($, on) => {
    submitted.length = 0
    const clock: any = await boot($, on)
    await clock.advance(1500)
    const base = submitted.length
    await $.turn.start({ text: '', turnId: 't1' })
    await $.classic.StopFailure(failure('billing_error'))
    await clock.advance(10 * MIN)
    expect(submitted.length).toBe(base)
    const st: any = await run($, 'status')
    expect(st.text).toContain('no active run')
  })

  test('user interrupt is not auto-resumed; continue resumes', async ($, on) => {
    submitted.length = 0
    const clock: any = await boot($, on)
    await clock.advance(1500)
    const base = submitted.length
    await $.turn.start({ text: '', turnId: 't1' })
    await $.turn.complete({ text: '', isAborted: true, reason: 'aborted' })
    await clock.advance(30 * MIN)
    expect(submitted.length).toBe(base)
    const c: any = await run($, 'continue')
    expect(c.text).toContain('resuming')
    await clock.advance(3000)
    expect(submitted.length).toBeGreaterThan(base)
  })

  test('deadline passing while waiting for the limit ends the run', async ($, on) => {
    submitted.length = 0
    const clock: any = await boot($, on, 20, undefined, '1')
    await clock.advance(1500)
    await $.turn.start({ text: '', turnId: 't1' })
    limits.five = 100
    limits.resetsAt = new Date(START + 300 * MIN).toISOString()
    await $.classic.StopFailure(failure('rate_limit'))
    await clock.advance(70 * MIN)
    const st: any = await run($, 'status')
    expect(st.text).toContain('no active run')
  })
})
