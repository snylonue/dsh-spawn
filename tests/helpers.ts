/**
 * Shared test helpers: compose the built plugin over a stub context the way a dsh
 * composition would, and build the value/result fixtures the render and presenter
 * paths take.
 */
export interface ComposedSpawn {
  tool: any
  sandboxed: boolean
}

/** Compose the built plugin and return the `spawn` definition it registers. */
export async function composeSpawn(): Promise<ComposedSpawn> {
  const mod: any = await import(new URL('../dist/index.js', import.meta.url).href)
  for (const sandboxed of [true, false]) {
    let captured: any
    const ctx: any = {
      shell: sandboxed ? { sandboxMode: 'workspace-write' } : {},
      get: () => undefined,
      logger: { warn: () => {} },
      systemPrompt: { section: () => {}, getSectionOrder: () => 0 },
      tools: { register: (definition: any) => { captured = definition; return () => {} } },
      inject: () => {},
    }
    try {
      mod.apply(ctx)
      if (captured !== undefined) return { tool: captured, sandboxed }
    } catch {
      // The sandboxed composition needs the running installation's sandbox
      // helpers; fall through to the sandbox-free composition.
    }
  }
  throw new Error('spawn did not register')
}

/** The `which` definition plus the seams it called, for resolution assertions. */
export interface ComposedWhich {
  tool: any
  shellResolves: any[]
  executableCalls: { command: string; path: string | undefined }[]
}

/**
 * Compose the built plugin and return the `which` definition it registers,
 * together with a shell seam that reports a workspace environment (the shape
 * dsh-direnv's `ctx.shell.resolve` wrapper produces) and a subprocess seam that
 * records the environment it was handed.
 */
export async function composeWhich(
  options: { env?: Record<string, string>; resolveThrows?: boolean } = {},
): Promise<ComposedWhich> {
  const mod: any = await import(new URL('../dist/index.js', import.meta.url).href)
  const shellResolves: any[] = []
  const executableCalls: { command: string; path: string | undefined }[] = []
  let captured: any
  const ctx: any = {
    shell: {
      resolve(request: any) {
        shellResolves.push(request)
        if (options.resolveThrows === true) throw new Error('no shell spec')
        return { ...request, ...(options.env === undefined ? {} : { env: options.env }) }
      },
    },
    shellEnv: { collect: () => ({}) },
    get: () => undefined,
    inject(names: string[], apply: (ctx: any) => void) {
      if (names.includes('subprocess') || names.includes('fs')) apply(ctx)
    },
    logger: { warn: () => {} },
    systemPrompt: { section: () => {}, getSectionOrder: () => 0 },
    tools: {
      register: (definition: any) => {
        if (definition.name === 'which') captured = definition
        return () => {}
      },
    },
    effect: () => {},
    subprocess: {
      resolveExecutable: async (command: string, env: { PATH?: string } | undefined) => {
        executableCalls.push({ command, path: env?.PATH })
        return `/resolved/${command}`
      },
    },
    fs: {},
  }
  mod.apply(ctx)
  if (captured === undefined) throw new Error('which did not register')
  return { tool: captured, shellResolves, executableCalls }
}

/** The arguments every `spawn` render/present assertion reuses. */
export const ARGS = { command: 'echo', args: ['hello'], description: 'Echo a greeting' }

/** One foreground `spawn` value, overridable per assertion. */
export function foreground(extra: Record<string, unknown> = {}): any {
  return {
    kind: 'foreground',
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 60_000,
    stdout: { text: 'hello', truncated: false },
    stderr: { text: '', truncated: false },
    ...extra,
  }
}

/** Parse back the structured value the renderer produced. */
export function rendered(tool: any, value: any): any {
  return JSON.parse(tool.output.render(ARGS, value)[0].text)
}

/** A normalized tool result, as presenters receive it. */
export function wrapped(value: any, isError = false): any {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError }
}
