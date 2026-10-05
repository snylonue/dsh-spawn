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
