import { describe, expect, it } from 'vitest'

type Dialect = 'posix' | 'powershell'

/** Import the built plugin and return one exported binding. */
async function plugin(): Promise<any> {
  return import(new URL('../dist/index.js', import.meta.url).href)
}

/** Build a command line with the plugin's pure builder. */
async function build(command: string, args: string[] | undefined, dialect: Dialect): Promise<string> {
  const mod = await plugin()
  return mod.buildCommandLine(command, args, dialect)
}

/**
 * Run the registered `spawn` tool against a fake executor and return the
 * command line it handed to `ctx.shell.resolve`. This is the wiring the real
 * composition uses: the dialect the builder sees is the platform default.
 */
async function capturedCommandLine(command: string, args: string[]): Promise<string> {
  const mod = await plugin()
  let captured: any
  let spec: any
  const ctx: any = {
    shell: {
      sandboxMode: undefined,
      resolve: (request: any) => ({
        workdir: '/tmp',
        timeoutMs: 1000,
        onExpiry: 'kill',
        stdoutMaxBytes: 1,
        sandboxPolicy: undefined,
        ...request,
      }),
      execute: async (resolved: any) => {
        spec = resolved
        return {
          result: async () => ({
            exitCode: 0,
            signal: null,
            timedOut: false,
            aborted: false,
            timeoutMs: 1000,
            stdout: { text: '', truncated: false },
            stderr: { text: '', truncated: false },
          }),
        }
      },
    },
    get: () => undefined,
    logger: { warn: () => {} },
    systemPrompt: { section: () => {}, getSectionOrder: () => 0 },
    shellEnv: { collect: () => ({}) },
    tools: { register: (definition: any) => { captured = definition; return () => {} } },
    inject: () => {},
  }
  mod.apply(ctx)
  const spawn = { signal: new AbortController().signal, callId: 'call-1' }
  await captured.execute({ command, args, description: 'run a program' }, spawn)
  return spec.command
}

describe('spawn command line', () => {
  it('quotes every word as a POSIX literal', async () => {
    expect(await build('node', ['--version'], 'posix')).toBe("'node' '--version'")
    expect(await build('echo', ['a b', ''], 'posix')).toBe("'echo' 'a b' ''")
    expect(await build('node', ["it's"], 'posix')).toBe("'node' 'it'\\''s'")
  })

  it('invokes a PowerShell command through the call operator', async () => {
    expect(await build('node', ['--version'], 'powershell')).toBe("& 'node' '--version'")
    expect(await build('whoami', undefined, 'powershell')).toBe("& 'whoami'")
    expect(await build('echo', ['a b', ''], 'powershell')).toBe("& 'echo' 'a b' ''")
    expect(await build('node', ["it's"], 'powershell')).toBe("& 'node' 'it''s'")
  })

  it('accepts native Windows program paths', async () => {
    const node = 'C:\\Users\\me\\AppData\\Roaming\\nvm\\v20.11.0\\node.exe'
    expect(await build(node, ['--version'], 'powershell')).toBe(`& '${node}' '--version'`)
    expect(await build('C:\\Program Files\\nodejs\\node.exe', undefined, 'powershell')).toBe(
      "& 'C:\\Program Files\\nodejs\\node.exe'",
    )
    expect(await build('C:/Users/me/node.exe', undefined, 'posix')).toBe("'C:/Users/me/node.exe'")
  })

  it('rejects a shell command line instead of a program', async () => {
    await expect(build('node; rm -rf /', [], 'posix')).rejects.toThrow(/invalid command/)
    await expect(build('$(whoami)', [], 'powershell')).rejects.toThrow(/invalid command/)
    await expect(build('a|b', [], 'posix')).rejects.toThrow(/invalid command/)
    await expect(build('', [], 'posix')).rejects.toThrow(/invalid command/)
  })

  it('runs the built line through the mounted executor', async () => {
    // On this POSIX test host the composition default is the POSIX dialect.
    expect(await capturedCommandLine('node', ['--version'])).toBe("'node' '--version'")
  })
})
