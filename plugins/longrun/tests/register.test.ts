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

async function boot($: any, on: any, five = 20, resetsAt?: string) {
  const clock = mock.clock(on)
  mock.store(on, {})
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('classic.Stop', () => ({}))
  on('session.id', () => ({ value: 's1' }))
  on('tool.register', () => ({ value: undefined }))
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('session.usage', () => ({ value: usage(five, resetsAt) }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', () => ({ value: undefined }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'longrun', args: '2 build the thing', origin: { kind: 'composer' } })
  return clock
}

describe('register', () => {
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
    const clock: any = await boot($, on)
    await clock.advance(3 * 3_600_000)
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
})
