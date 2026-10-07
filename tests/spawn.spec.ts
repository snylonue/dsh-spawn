import { describe, expect, it } from 'vitest'
import { ARGS, composeSpawn, foreground, rendered, wrapped } from './helpers.js'

const NL = String.fromCharCode(10)

describe('spawn declaration', () => {
  it('is described as a no-shell argv API', async () => {
    const { tool } = await composeSpawn()
    expect(tool.description).toContain('no shell')
    expect(tool.description).toContain('Nothing is interpreted by a shell')
    expect(tool.description).not.toContain('[exit code: N]')
    expect(tool.description.split(NL).filter((line: string) => line.trim())).toHaveLength(1)
    expect(tool.description.length).toBeLessThan(1100)
  })

  it('exposes the argv contract in its parameter descriptions', async () => {
    const { tool } = await composeSpawn()
    expect(tool.parameters.required).toEqual(['command', 'description'])
    expect(tool.parameters.properties.command.description).toContain('never a shell command line')
    expect(tool.parameters.properties.args.description).toContain('literal')
  })
})

describe('spawn rendering', () => {
  it('renders the structured value verbatim', async () => {
    const { tool } = await composeSpawn()
    const plain = foreground()
    expect(rendered(tool, plain)).toEqual(plain)
    const failed = rendered(tool, foreground({ exitCode: 3, stderr: { text: 'bad' } }))
    expect(failed.kind).toBe('foreground')
    expect(failed.exitCode).toBe(3)
    expect(failed.stdout.text).toBe('hello')
    expect(failed.stderr.text).toBe('bad')
    expect(failed.hints).toBeUndefined()
  })

  it('adds advisory hints without flattening the value', async () => {
    const { tool } = await composeSpawn()
    expect(rendered(tool, foreground({ timedOut: true, timeoutMs: 250 })).hints).toEqual(['timed out after 250ms'])
    expect(rendered(tool, foreground({ signal: 'SIGKILL', exitCode: null })).hints).toEqual(['killed by signal: SIGKILL'])
    expect(rendered(tool, foreground({ stopped: 'tool call aborted' })).hints).toEqual(['stopped: tool call aborted'])
    const denied = rendered(tool, foreground({ sandbox: { mode: 'workspace-write', denied: true } }))
    expect(denied.sandbox.denied).toBe(true)
    expect(denied.hints).toHaveLength(1)
    expect(denied.hints[0]).toMatch(/file access denied/)
    expect(rendered(tool, { kind: 'background', jobId: 'job-1' }).hints).toBeUndefined()
    const promoted = rendered(tool, { kind: 'promoted', jobId: 'job-2', timeoutMs: 5000, output: 'partial' })
    expect(promoted.jobId).toBe('job-2')
    expect(promoted.hints).toHaveLength(2)
  })
})

describe('spawn presentation', () => {
  it('presents a terminal card from the structured content', async () => {
    const { tool } = await composeSpawn()
    expect(tool.presentResult(ARGS, wrapped(foreground()))).toEqual({ card: 'terminal', output: 'hello', exitCode: 0 })
    const split = foreground({ stdout: { text: 'a' }, stderr: { text: 'b' } })
    expect(tool.presentResult(ARGS, wrapped(split)).output).toBe('a' + NL + '[stderr]' + NL + 'b')
    const empty = foreground({ stdout: { text: '' } })
    expect(tool.presentResult(ARGS, wrapped(empty)).output).toBe('(no output)')
    expect(tool.presentResult(ARGS, wrapped(foreground({ signal: 'SIGTERM', exitCode: null }))).signal).toBe('SIGTERM')
    const spilled = foreground({ stdout: { text: 'x', truncated: true, spillPath: '/tmp/spill' } })
    expect(tool.presentResult(ARGS, wrapped(spilled)).output).toContain('/tmp/spill')
  })

  it('still presents older results with explicit empty stderr and false truncation', async () => {
    const { tool } = await composeSpawn()
    const legacy = foreground({ stdout: { text: 'hello', truncated: false }, stderr: { text: '', truncated: false } })
    expect(tool.presentResult(ARGS, wrapped(legacy))).toEqual({ card: 'terminal', output: 'hello', exitCode: 0 })
    const truncated = foreground({ stderr: { text: '', truncated: true, spillPath: '/tmp/err-spill' } })
    expect(tool.presentResult(ARGS, wrapped(truncated)).output).toContain('/tmp/err-spill')
  })

  it('presents background, promoted and failed results', async () => {
    const { tool } = await composeSpawn()
    expect(tool.presentResult(ARGS, wrapped({ kind: 'background', jobId: 'job-9' }))).toEqual({
      card: 'generic',
      content: [{ type: 'text', text: 'started background job job-9' }],
    })
    const promoted = tool.presentResult(ARGS, wrapped({ kind: 'promoted', jobId: 'job-8', timeoutMs: 5000, output: 'partial' }))
    expect(promoted.content[0].text).toContain('still running after 5000ms')
    const failed = tool.presentResult(ARGS, { content: [{ type: 'text', text: 'boom' }], isError: true })
    expect(failed.card).toBe('generic')
    expect(failed.content[0].text).toContain('boom')
    const raw = tool.presentResult(ARGS, { content: [{ type: 'text', text: 'not json' }], isError: false })
    expect(raw.content[0].text).toContain('not json')
  })

  it('falls back to the generic card for invalidated replay arguments', async () => {
    const { tool } = await composeSpawn()
    expect(tool.presentResult({}, wrapped(foreground()))).toBeUndefined()
  })
})
