/**
 * `dsh-spawn` — the typed process/path API that replaces `bash` in the
 * `PTC-spawn` agent preset (id `ptc-spawn`).
 *
 * Four model-facing tools, all callable inside a `run_code` program as
 * `tools.<name>(...)`:
 *
 * - `spawn`      run one program by argv (never a shell string), confined by the
 *               mounted shell executor's sandbox policy and escalatable through
 *               the shared approval choreography.
 * - `which`     resolve a program name on the PATH a spawned program would receive.
 * - `stat`      sandbox-aware metadata for one path.
 * - `list_dir`  bounded, depth-limited directory listing.
 *
 * The job-aware `spawn` implementation deliberately mirrors
 * `@deepseek-ai/dsh-tool-bash`'s process plumbing (job registration, promotion
 * on timeout, spill-aware rendering, sandbox markers) so a session that loses
 * `bash` keeps the same observable semantics for background work and policy
 * denials. Two deliberate divergences: the surface is `command` + `args`
 * instead of a shell command line (and no `run_in_background` name), and the
 * model/log-facing result is the structured JSON value rather than bash's
 * stdout/`[stderr]`/`[exit code: N]` prose, so a consumer reads fields.
 *
 * @module dsh-spawn
 */
import { stat as hostStat } from 'node:fs/promises'
import { isAbsolute, sep } from 'node:path'
import {
  defineTool,
  TOOL_ABORTED,
  type ToolCallView,
  type ToolDefinition,
  type ToolResult,
  type ToolResultView,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import {
  ESCALATION_TARGETS,
  approveEscalation,
  escalationHintMarker,
  sandboxDenialMarker,
  sandboxPermissionsDescription,
  validateEscalationArgs,
  type SandboxExecutionPolicy,
  type SandboxMode,
} from '@deepseek-ai/dsh-sandbox'
import {
  DSH_ENV_PREFIX,
  type CollectedOutput,
  type ShellExecSpec,
  type ShellExecution,
  type ShellExecutor,
  type ShellRunResult,
  type ShellSandboxInfo,
} from '@deepseek-ai/dsh-shell'
import type { JobId, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { ShellEnvRegistry } from '@deepseek-ai/dsh-shell-env'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { FileSystem } from '@deepseek-ai/dsh-fs'

// ── host packages ────────────────────────────────────────────────────────────
//
// `@deepseek-ai/dsh-tools` / `dsh-llm` / `dsh-sandbox` / `dsh-shell` are
// peer dependencies: the dsh launcher installs a runtime resolution into
// Node's ESM and CommonJS resolvers, and this package's peer declarations route
// each bare request to the module instance the running harness loaded, even
// when the bundle is a symlink.

// ── types ───────────────────────────────────────────────────────────────────

/** The JSON subset every tool value and host DTO here is made of. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * The canonical `spawn` value: the discriminated union its output schema
 * declares, plus the stop reason a foreground call can additionally carry.
 */
type SpawnValue =
  | { kind: 'background'; jobId: string }
  | { kind: 'promoted'; jobId: string; timeoutMs: number; output: string }
  | ({ kind: 'foreground' } & ShellRunResult & { stopped?: string })

/** The structured render: the value plus the advisory hints, when any. */
type RenderedSpawn = SpawnValue | (SpawnValue & { hints: string[] })

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    spawn: 'spawn'
  }
}

/** One registered background job, as `startJob` hands it to the waiter. */
interface AttachedJob {
  id: JobId
  process(): ShellExecution | undefined
  stopped(): string | undefined
}

/** The `which` argument and value. */
interface NameArgs { command: string }
interface WhichValue { path: string | null }

/** The `stat` value. */
interface StatValue {
  path: string
  exists: boolean
  type?: string
  size?: number
  mtimeMs?: number
}

/** The `list_dir` value. */
interface ListDirEntry { path: string; type: string; size?: number }
interface ListDirValue { path: string; entries: ListDirEntry[]; truncated: boolean }

/** The validated `spawn` arguments this plugin reads. */
interface SpawnArgs {
  command: string
  args?: string[]
  description: string
  timeoutMs?: number
  cwd?: string
  stdin?: string
  env?: Record<string, string>
  background?: boolean
  sandbox_permissions?: SandboxMode
  justification?: string
}

/** The one path/name argument the query tools take. */
interface PathArgs {
  path: string
  depth?: number
}

/** The resolution facts captured when the `spawn` tool was built. */
interface SpawnToolOptions {
  escalationModes: readonly SandboxMode[]
  resolveSandboxPolicy(spawn: ToolRunContext): SandboxExecutionPolicy | undefined
}

/**
 * The plugin-context members this plugin touches.
 */
interface PluginContext {
  shell: ShellExecutor
  shellEnv: ShellEnvRegistry
  get(name: string): any
  inject(names: string[], apply: (ctx: PluginContext) => void): void
  logger: { warn(...args: unknown[]): void }
  systemPrompt: {
    section(section: { name: string; order: number; text: string }): void
    getSectionOrder(name: string): number
  }
  tools: { register(definition: ToolDefinition): () => void }
  jobs?: JobRegistry
  subprocess?: SubprocessRuntime
  fs?: FileSystem
  effect(dispose: () => void, name?: string): void
  fiber: { state: number }
}

export const name = 'dsh-spawn'
export const inject = ['tools', 'shell', 'systemPrompt', 'shellEnv']

/** Upper bound on one `list_dir` result, so a deep listing never floods the program. */
const LIST_DIR_MAX_ENTRIES = 2000
/** Upper bound on `list_dir` recursion; depth is clamped into [1, 3]. */
const LIST_DIR_MAX_DEPTH = 3
/** A program name or absolute path, with no shell metacharacters to be quoted away. */
const PROGRAM_NAME = /^[A-Za-z0-9_./:@+-]+$/

// ── argv → one quoted command line ──────────────────────────────────────────

/**
 * Quote one argv entry for a POSIX shell: single-quote the whole word, so
 * `$`, globs, backticks, `;`, spaces and newlines inside it stay literal, and
 * an embedded single quote becomes the standard `'\''` escape.
 * @param value - the exact argv entry the program must receive.
 * @returns the entry as one literal shell word.
 */
function shellQuote(value: string): string {
  if (value.length === 0) return "''"
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Build the single shell command line the executor runs from a program name
 * and an argv array. Every word is quoted, so nothing is interpreted; the
 * program name itself is validated first because quoting cannot make a
 * nonsense program name meaningful.
 * @param command - bare PATH name or absolute path.
 * @param args - arguments passed verbatim as separate argv entries.
 * @returns one command line whose every word is a literal.
 */
function buildCommandLine(command: string, args: string[] | undefined): string {
  if (typeof command !== 'string' || command.length === 0 || !PROGRAM_NAME.test(command)) {
    throw new Error(
      `invalid command: expected a program name or absolute path without shell metacharacters, got ${JSON.stringify(command)}`,
    )
  }
  return [command, ...(args ?? [])].map(shellQuote).join(' ')
}

/** Display form for cards; never executed, so no validation is needed. */
function displayCommand(command: string, args: string[] | undefined): string {
  return [command, ...(args ?? [])].join(' ')
}

// ── job adaptation (same semantics as @deepseek-ai/dsh-tool-bash) ───────────

/**
 * Sandbox facts worth the terminal detail: a runner that never ran the
 * command, or a denial (with the escalation hint this composition offers).
 */
function sandboxNotes(sandbox: ShellSandboxInfo | undefined, escalationModes: readonly string[]): string[] {
  if (sandbox?.runnerFailed) {
    return [
      `[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`,
    ]
  }
  if (sandbox?.denied) {
    const notes = [sandboxDenialMarker(sandbox.mode)]
    if (escalationModes.length > 0) notes.push(escalationHintMarker('command'))
    return notes
  }
  return []
}

/** Map a settled background process onto the generic job-outcome vocabulary. */
function processOutcome(proc: ShellExecution, escalationModes: readonly string[] = []): JobOutcome {
  const base: JobOutcome =
    proc.status === 'killed'
      ? {
          status: 'killed',
          detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit',
        }
      : {
          status: 'completed',
          detail: `exit code: ${proc.exitCode ?? 0}`,
        }
  const notes = sandboxNotes(proc.sandbox, escalationModes)
  return notes.length === 0 ? base : { ...base, detail: `${base.detail}; ${notes.join(' ')}` }
}

/** The process's non-consuming stream readers as registry pull sources. */
function processSources(proc: () => ShellExecution | undefined) {
  const source = (channel: 'stdout' | 'stderr') => ({
    channel,
    read: (fromByte: number) => {
      const live = proc()
      return live === undefined
        ? { text: '', nextOffset: fromByte, lossy: false }
        : live.observed[channel].readFrom(fromByte)
    },
  })
  return [source('stdout'), source('stderr')]
}

/** The ring chunks of one consuming registry read, rendered as the shell tools render a process read. */
function ringDelta(chunks: readonly { channel?: string; text: string }[]): string {
  const out = chunks
    .filter((chunk) => chunk.channel !== 'stderr')
    .map((chunk) => chunk.text)
    .join('')
  const err = chunks
    .filter((chunk) => chunk.channel === 'stderr')
    .map((chunk) => chunk.text)
    .join('')
  const separator = out.length > 0 && !out.endsWith('\n') ? '\n' : ''
  return out + (err.length > 0 ? `${separator}[stderr]\n${err}` : '')
}

/** Adapt asynchronous shell preparation after job admission without exposing a partial process. */
function processJob(start: (signal: AbortSignal) => Promise<ShellExecution>, outcome: (proc: ShellExecution) => JobOutcome): { cancel(reason: unknown): void; done: Promise<JobOutcome> } {
  const controller = new AbortController()
  let process: ShellExecution | undefined
  return {
    cancel: (reason: unknown) => {
      if (controller.signal.aborted) return
      controller.abort(reason)
      process?.kill()
    },
    done: (async () => {
      try {
        process = await start(controller.signal)
        try {
          if (controller.signal.aborted) process.kill()
        } finally {
          await process.done
        }
        return outcome(process)
      } catch (error) {
        return {
          status: controller.signal.aborted && process === undefined ? 'killed' : 'failed',
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    })(),
  }
}

// ── rendering ───────────────────────────────────────────────────────────────

/** Append the truncation notice (with the full-output spill path) to a stream's text. */
function streamText(output: CollectedOutput): string {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/**
 * The terminal card's human body: stdout, then stderr framed as its own
 * section. Presentation only: the model-facing result is structured JSON.
 */
function spawnBody(result: ShellRunResult): string {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  return body.length === 0 ? '(no output)' : body
}

/**
 * Advisory sentences the structured fields cannot phrase: a policy denial (with
 * the escalation this composition offers), a sandbox runner that never ran the
 * command, a deadline, a stop, or a promotion. Every other fact about a run is
 * carried by its own field, so a consumer reads fields instead of markers.
 */
function spawnHints(value: SpawnValue, escalationModes: readonly string[] = []): string[] {
  if (value.kind === 'promoted') {
    return [
      `still running after ${value.timeoutMs}ms; moved to background job ${value.jobId}`,
      'read newer output with job_output, stop it with job_kill',
    ]
  }
  if (value.kind !== 'foreground') return []
  const hints = []
  if (value.sandbox?.runnerFailed) {
    hints.push(
      `the sandbox runner itself failed under ${value.sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure`,
    )
  }
  if (value.sandbox?.denied) {
    hints.push(sandboxDenialMarker(value.sandbox.mode))
    if (escalationModes.length > 0) hints.push(escalationHintMarker('command'))
  }
  if (value.timedOut) hints.push(`timed out after ${value.timeoutMs}ms`)
  if (value.stopped !== undefined) hints.push(`stopped: ${value.stopped}`)
  if (value.signal !== null) hints.push(`killed by signal: ${value.signal}`)
  return hints
}

/**
 * Shape one settled run into the structured result the model and the session
 * log receive: the canonical value verbatim — its `kind` tag, `exitCode` /
 * `signal` / `timedOut` / `stopped`, `stdout` / `stderr` with their `truncated`
 * / `spillPath` facts, and `sandbox` — plus a `hints` array only when a denial,
 * a deadline, a stop, or a promotion needs a sentence the fields alone do not
 * phrase. Nothing is flattened into prose, so a consumer reads fields instead
 * of parsing markers.
 */
function structuredResult(value: SpawnValue, escalationModes: readonly string[] = []): RenderedSpawn {
  const hints = spawnHints(value, escalationModes)
  return hints.length === 0 ? value : { ...value, hints }
}

/** Shape a foreground call that stopped waiting into the completed card's text. */
function renderPromoted(promoted: Extract<SpawnValue, { kind: 'promoted' }>): string {
  return `${promoted.output.length > 0 ? (promoted.output.endsWith('\n') ? promoted.output : `${promoted.output}\n`) : ''}[still running after ${promoted.timeoutMs}ms; moved to background job ${promoted.jobId}]\nThe program keeps running in the background. You will be notified when it finishes; read newer output with job_output, stop it with job_kill.`
}

/** Shape the one consuming registry read a foreground call embeds in its result. */
function renderJobRead(delta: string, lossy: boolean, spillPaths: readonly string[], sandbox: ShellSandboxInfo | undefined, escalationModes: readonly string[] = []): string {
  const notices = []
  if (lossy) {
    notices.push(
      `[some output was dropped from memory; full output: ${spillPaths.length > 0 ? spillPaths.join(', ') : '(unavailable)'}]`,
    )
  }
  if (sandbox?.runnerFailed) {
    notices.push(
      `[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`,
    )
  } else if (sandbox?.denied) {
    notices.push(sandboxDenialMarker(sandbox.mode))
    if (escalationModes.length > 0) notices.push(escalationHintMarker('command'))
  }
  if (notices.length === 0) return delta
  return `${delta}${delta.length > 0 && !delta.endsWith('\n') ? '\n' : ''}${notices.join('\n')}`
}

/** The structured abort the foreground paths throw when the caller cancels the call. */
function toolAborted() {
  const error = new HarnessError('tool call aborted', TOOL_ABORTED)
  error.name = 'AbortError'
  return error
}

/** Detach the executor DTO from readonly Service Definition types into plain JSON data. */
function canonicalRunResult(result: ShellRunResult): ShellRunResult {
  const output = (stream: CollectedOutput): CollectedOutput => ({
    text: stream.text,
    truncated: stream.truncated,
    ...(stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {}),
  })
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    stdout: output(result.stdout),
    stderr: output(result.stderr),
    ...(result.sandbox !== undefined
      ? {
          sandbox: {
            mode: result.sandbox.mode,
            denied: result.sandbox.denied,
            ...(result.sandbox.enforcement !== undefined ? { enforcement: result.sandbox.enforcement } : {}),
            ...(result.sandbox.runnerFailed !== undefined ? { runnerFailed: result.sandbox.runnerFailed } : {}),
          },
        }
      : {}),
  }
}

// ── spawn ────────────────────────────────────────────────────────────────────

const BACKGROUND_OUTPUT_PROPERTIES = {
  kind: { type: 'string', required: true, const: 'background' },
  jobId: { type: 'string', required: true },
} as const

function spawnDescription() {
  return `Run one program directly — no shell — and return its stdout/stderr: \`command\` is a PATH name or absolute path, \`args\` its argv. Nothing is interpreted by a shell: no globbing, pipes, redirection, or variable expansion; pass the program and its arguments separately, never a command line, and compose pipelines in the program instead. Managed \`${DSH_ENV_PREFIX}*\` variables expose current harness environment facts. \`background: true\` starts a job (collect with \`job_output\`, stop with \`job_kill\`); a foreground call that reaches its timeout is promoted to one. Long output is truncated to its tail and the full path is reported when available. Read the structured result (\`exitCode\`/\`signal\`, \`stdout\`/\`stderr\`, \`sandbox\`); a non-zero exit is a normal result, not a tool error. Programs may run under a file sandbox; a blocked file operation is reported as \`[sandbox: file access denied under <mode> mode]\`, a policy denial: do not retry another way. Before any delete or move, verify the resolved absolute target path.`
}

function validateSpawnArgs(args: SpawnArgs, effectiveMode: SandboxMode | undefined): void {
  if (args.description.trim().length === 0) throw new Error('invalid description: expected a non-empty string')
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  }
  if (args.env !== undefined) {
    if (args.env === null || typeof args.env !== 'object' || Array.isArray(args.env)) {
      throw new Error('invalid env: expected an object mapping variable names to string values')
    }
    for (const [key, value] of Object.entries(args.env)) {
      if (key.length === 0) throw new Error('invalid env: empty variable name')
      if (key.startsWith(DSH_ENV_PREFIX)) {
        throw new Error(
          `invalid env: ${JSON.stringify(key)} is in the harness-managed ${DSH_ENV_PREFIX} namespace and cannot be set`,
        )
      }
      if (typeof value !== 'string') throw new Error(`invalid env: value for ${JSON.stringify(key)} must be a string`)
    }
  }
  if (args.sandbox_permissions !== undefined && args.sandbox_permissions === effectiveMode) return
  const justification =
    args.sandbox_permissions === undefined && args.justification?.trim() === '' ? undefined : args.justification
  validateEscalationArgs(args.sandbox_permissions, justification)
}

function presentSpawnCall(args: SpawnArgs): ToolCallView {
  const command = displayCommand(args.command, args.args)
  if (args.background === true) {
    return {
      card: 'generic',
      title: command,
      kind: 'execute',
      rawInput: command,
      content: [{ type: 'text', text: args.description }],
    }
  }
  return {
    card: 'terminal',
    title: command,
    description: args.description,
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
  }
}

/** The raw model-facing text of a result, when it is a single text block. */
function resultText(result: ToolResult): string | undefined {
  const block = result.content.length === 1 ? result.content[0] : undefined
  return block?.type === 'text' ? block.text : undefined
}

/**
 * Recover the structured value a presenter draws from. The render emits the
 * canonical value as JSON, so a live call and a replayed log entry alike carry
 * their own structure; a failed call renders error text instead and yields
 * undefined, which the generic fallback then shows verbatim.
 */
function presentedResult(result: ToolResult): any {
  const raw = resultText(result)
  if (raw === undefined) return undefined
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function presentSpawnResult(_args: SpawnArgs, result: ToolResult): ToolResultView | undefined {
  const value = result.isError ? undefined : presentedResult(result)
  if (value?.kind === 'foreground') {
    return {
      card: 'terminal',
      output: spawnBody(value),
      ...(value.signal !== null ? { signal: value.signal } : { exitCode: value.exitCode ?? 0 }),
    }
  }
  if (value !== undefined) {
    return {
      card: 'generic',
      content: [
        {
          type: 'text',
          text: value.kind === 'background' ? `started background job ${value.jobId}` : renderPromoted(value),
        },
      ],
    }
  }
  const raw = resultText(result)
  if (raw === undefined) return undefined
  return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }] }
}

/**
 * Resolve an explicit cwd first, making a relative one session-workspace-relative;
 * otherwise use the filesystem identity of the session cwd and leave executor
 * defaulting as the fallback. A resolved sandbox-policy root wins so cwd and
 * confinement use the exact same per-call identity.
 */
function resolveWorkdir(modelWorkdir: string | undefined, spawn: ToolRunContext, policyWorkspaceRoot: string | undefined): string | undefined {
  const headerCwd = spawn.agent?.session.header.cwd
  const sessionCwd = policyWorkspaceRoot ?? headerCwd
  if (modelWorkdir === undefined) return sessionCwd
  if (sessionCwd !== undefined && !isAbsolute(modelWorkdir)) return `${sessionCwd}${sep}${modelWorkdir}`
  return modelWorkdir
}

/**
 * Build the `spawn` definition. With a job registry every call registers its
 * process as a job at its start; without one the tool is foreground-only and
 * the executor's deadline kills the program.
 * @param ctx - the plugin context.
 * @param jobs - the job registry, when composed.
 * @param options - resolution facts captured at apply time.
 * @returns the registry-ready tool definition.
 */
function spawnTool(ctx: PluginContext, jobs: JobRegistry | undefined, options: SpawnToolOptions): ToolDefinition {
  const { escalationModes, resolveSandboxPolicy } = options
  const background = jobs !== undefined
  const promote = background

  const approveSpawnEscalation = (mode: SandboxMode, justification: string, spawn: ToolRunContext, standingPolicy: SandboxExecutionPolicy | undefined) => {
    if (escalationModes.length === 0) {
      throw new Error('sandbox_permissions is not available in this composition (no sandboxing executor to escalate)')
    }
    if (standingPolicy === undefined) {
      throw new Error('sandbox_permissions is not available without a sandbox execution policy')
    }
    return approveEscalation(
      { requestedMode: mode, justification, effectiveMode: standingPolicy.mode, subject: 'command' },
      {
        approver: ctx.get('approval'),
        agent: spawn.agent,
        callId: spawn.callId,
        toolName: 'spawn',
        signal: spawn.signal,
      },
    )
  }

  const startJob = (registry: JobRegistry, args: SpawnArgs, spawn: ToolRunContext, spec: ShellExecSpec): AttachedJob => {
    let proc: ShellExecution
    let stopped: string | undefined
    return {
      id: registry.start({
        kind: 'spawn',
        label: displayCommand(args.command, args.args),
        ...(spawn.agent ? { owner: spawn.agent.id } : {}),
        output: processSources(() => proc),
        run: () => {
          const hooks = processJob(
            async (signal) => {
              proc = await ctx.shell.execute({ ...spec, signal })
              return proc
            },
            (started) => processOutcome(started, escalationModes),
          )
          return {
            done: hooks.done,
            cancel: (reason: unknown) => {
              stopped = typeof reason === 'string' ? reason : undefined
              hooks.cancel(reason)
            },
          }
        },
      }),
      process: () => proc,
      stopped: () => stopped,
    }
  }

  const waitOnJob = async (registry: JobRegistry, attached: AttachedJob, spawn: ToolRunContext, spec: ShellExecSpec): Promise<SpawnValue> => {
    const owner = spawn.agent?.id
    const timeoutMs = spec.timeoutMs
    const stop = async (reason: string) => {
      registry.kill(attached.id, owner, reason)
      const settled = await registry.wait(attached.id, timeoutMs, owner)
      if (settled.status !== 'running' && settled.status !== 'stopping') registry.remove(attached.id, owner)
      return settled
    }
    let view
    try {
      view = await registry.wait(attached.id, timeoutMs, owner, spawn.signal)
    } catch {
      await stop('tool call aborted')
      throw toolAborted()
    }
    if ((view.status === 'running' || view.status === 'stopping') && attached.process() === undefined) {
      await stop('timed out during preparation')
      return {
        kind: 'foreground',
        exitCode: null,
        signal: null,
        timedOut: true,
        aborted: false,
        timeoutMs,
        stdout: { text: '', truncated: false },
        stderr: { text: '', truncated: false },
        ...(spec.sandboxPolicy !== undefined
          ? { sandbox: { mode: spec.sandboxPolicy.mode, denied: false } }
          : {}),
      }
    }
    if (view.status === 'running' || view.status === 'stopping') {
      const read = registry.read(attached.id, owner)
      return {
        kind: 'promoted',
        jobId: attached.id,
        timeoutMs,
        output: renderJobRead(
          ringDelta(read.chunks),
          read.lossy,
          read.job.output.spillPaths ?? [],
          attached.process()?.sandbox,
          escalationModes,
        ),
      }
    }
    registry.remove(attached.id, owner)
    const process = attached.process()
    if (process === undefined) throw new Error(view.detail)
    const result = await process.result()
    const stopped = attached.stopped()
    return {
      kind: 'foreground',
      ...canonicalRunResult(result),
      ...(stopped !== undefined ? { stopped } : {}),
    }
  }

  return defineTool({
    name: 'spawn',
    description: spawnDescription(),
    parameters: {
      command: {
        type: 'string',
        required: true,
        description:
          'The program to run: a PATH name or an absolute path; never a shell command line.'
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Arguments passed verbatim as separate argv entries, in order. Shell metacharacters inside an entry are literal characters.',
      },
      description: {
        type: 'string',
        required: true,
        description:
          'Clear, concise description of what this program does in active voice, 5-10 words (shown in the UI). Examples: ["git","status"] → "Show working tree status"; ["pnpm","test"] → "Run test suite".',
      },
      timeoutMs: {
        type: 'number',
        description: promote
          ? 'Timeout in milliseconds. The executor applies its configured default and cap; on expiry the program moves to the background as a job instead of being killed.'
          : "Timeout in milliseconds. The executor applies its configured default and cap, and kills the program on expiry.",
      },
      cwd: {
        type: 'string',
        description:
          'Working directory for this program. Defaults to the session workspace; a relative path is resolved against it.',
      },
      stdin: {
        type: 'string',
        description: "Bytes written to the program's stdin, then closed. Omit to leave stdin empty.",
      },
      env: {
        type: 'json',
        description:
          'Extra environment variables for this program, as a JSON object of string values. They merge after the credential scrub, so they cannot displace harness-managed `' +
          DSH_ENV_PREFIX +
          '*` facts.',
      },
      ...(background
        ? {
            background: {
              type: 'boolean',
              description:
                'Start the program as a background job and return its job id immediately (collect with job_output, stop with job_kill). No timeout applies.',
            },
          }
        : {}),
      ...(escalationModes.length > 0
        ? {
            sandbox_permissions: {
              type: 'string',
              enum: [...escalationModes],
              description: sandboxPermissionsDescription('command'),
            },
            justification: {
              type: 'string',
              description:
                'Required with sandbox_permissions: one sentence for the user explaining why this exact program needs the wider access. Use the language of the user\u2019s current request.',
            },
          }
        : {}),
    },
    output: {
      schema: {
        oneOf: [
          { type: 'object', additionalProperties: false, properties: BACKGROUND_OUTPUT_PROPERTIES },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'promoted' },
              jobId: { type: 'string', required: true },
              timeoutMs: { type: 'number', required: true },
              output: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
              signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              timedOut: { type: 'boolean', required: true },
              aborted: { type: 'boolean', required: true },
              stopped: { type: 'string' },
              timeoutMs: { type: 'number', required: true },
              stdout: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  text: { type: 'string', required: true },
                  truncated: { type: 'boolean', required: true },
                  spillPath: { type: 'string' },
                },
              },
              stderr: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  text: { type: 'string', required: true },
                  truncated: { type: 'boolean', required: true },
                  spillPath: { type: 'string' },
                },
              },
              sandbox: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  mode: { type: 'string', required: true },
                  denied: { type: 'boolean', required: true },
                  enforcement: { type: 'string' },
                  runnerFailed: { type: 'boolean' },
                },
              },
            },
          },
        ],
      },
      render: (_args: SpawnArgs, value: SpawnValue) => [
        { type: 'text', text: JSON.stringify(structuredResult(value, escalationModes), null, 2) },
      ],
    },
    async execute(args: SpawnArgs, spawn: ToolRunContext): Promise<SpawnValue> {
      const standingPolicy = resolveSandboxPolicy(spawn)
      const commandLine = buildCommandLine(args.command, args.args)
      validateSpawnArgs(args, standingPolicy?.mode)
      const approvedMode =
        args.sandbox_permissions !== undefined && args.justification !== undefined
          ? await approveSpawnEscalation(args.sandbox_permissions, args.justification, spawn, standingPolicy)
          : undefined
      const policy =
        approvedMode === undefined || standingPolicy === undefined
          ? standingPolicy
          : { ...standingPolicy, mode: approvedMode }
      const workdir = resolveWorkdir(args.cwd, spawn, standingPolicy?.workspaceRoot)
      const dshEnv = ctx.shellEnv.collect(spawn)
      const request = {
        command: commandLine,
        ...(workdir !== undefined ? { workdir } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        ...(args.stdin !== undefined ? { stdin: args.stdin } : {}),
        ...(args.env !== undefined ? { env: args.env } : {}),
        dshEnv,
        ...(policy !== undefined ? { sandboxPolicy: policy } : {}),
      }
      if (args.background === true) {
        if (jobs === undefined) {
          throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        }
        if (spawn.signal.aborted) throw toolAborted()
        return {
          kind: 'background',
          jobId: startJob(jobs, args, spawn, ctx.shell.resolve({ ...request, onExpiry: 'none' })).id,
        }
      }
      if (jobs !== undefined && promote) {
        const spec = ctx.shell.resolve({ ...request, onExpiry: 'none' })
        let attached
        try {
          attached = startJob(jobs, args, spawn, spec)
        } catch (error) {
          ctx.logger.warn(
            `dsh-spawn: job registration refused, running in the foreground with the timeout kill instead: ${String(error)}`,
          )
        }
        if (attached !== undefined) return waitOnJob(jobs, attached, spawn, spec)
      }
      const result = await (
        await ctx.shell.execute(ctx.shell.resolve({ ...request, signal: spawn.signal }))
      ).result()
      if (result.aborted) throw toolAborted()
      return { kind: 'foreground', ...canonicalRunResult(result) }
    },
    presentCall: presentSpawnCall,
    presentResult: presentSpawnResult,
  })
}

// ── query tools ─────────────────────────────────────────────────────────────

/** The session workspace the path tools resolve relative paths against. */
function sessionCwd(spawn: ToolRunContext): string | undefined {
  return spawn.agent?.session.header.cwd
}

/**
 * Host-side `mtimeMs` for a resolved target, used only as an enrichment: the
 * filesystem service's own metadata has no timestamp, and a backend whose
 * process path is not a local absolute path simply reports none.
 */
async function hostMtime(processPath: string | undefined): Promise<number | undefined> {
  if (typeof processPath !== 'string' || !isAbsolute(processPath)) return undefined
  try {
    const info = await hostStat(processPath)
    return typeof info.mtimeMs === 'number' ? info.mtimeMs : undefined
  } catch {
    return undefined
  }
}

function whichTool(ctx: PluginContext): ToolDefinition {
  const subprocess = ctx.subprocess
  if (subprocess === undefined) throw new Error('dsh-spawn: which requires ctx.subprocess')
  return defineTool({
    name: 'which',
    description:
      'Resolve a program name against the PATH a spawned program would receive (including any workspace environment injected at the shell seam) and return its absolute path. Returns `path: null` when nothing matches or the name is not a plain program name.',
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'Bare program name (for example `rg`, `git`, `pnpm`) or an absolute path to verify.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] } },
      },
      render: (_args: NameArgs, value: WhichValue) => [{ type: 'text', text: value.path ?? '(not found)' }],
    },
    isConcurrencySafe: () => true,
    async execute(args: NameArgs, spawn: ToolRunContext) {
      // Resolve against the environment a `spawn` call would run under, so a
      // workspace environment injected at the shell seam (for example
      // dsh-direnv's `ctx.shell.resolve` wrapper) contributes its PATH here
      // too; otherwise `spawn` could run a workspace-provided program that
      // `which` reports as missing. `resolve` only prepares a spec — nothing
      // executes. A shell that cannot prepare one falls back to the execution
      // world's own PATH, which is what this tool used before.
      let env: Record<string, string> | undefined
      try {
        const prepared = ctx.shell.resolve({ command: args.command })
        if (typeof prepared === 'object' && prepared !== null && typeof prepared.env === 'object' && prepared.env !== null) {
          env = prepared.env
        }
      } catch {
        // Keep the fallback.
      }
      try {
        return { path: await subprocess.resolveExecutable(args.command, env, spawn.signal) }
      } catch {
        return { path: null }
      }
    },
  })
}

function statTool(ctx: PluginContext): ToolDefinition {
  const fs = ctx.fs
  if (fs === undefined) throw new Error('dsh-spawn: stat requires ctx.fs')
  return defineTool({
    name: 'stat',
    description:
      'Return metadata for one path in the session filesystem: whether it exists, whether it is a file or directory, its byte size, and its modification time when the backend can report one. Never reads file contents.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Path to inspect. A relative path resolves against the session workspace.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          exists: { type: 'boolean', required: true },
          type: { type: 'string' },
          size: { type: 'number' },
          mtimeMs: { type: 'number' },
        },
      },
      render: (_args: PathArgs, value: StatValue) =>
        value.exists
          ? [
              {
                type: 'text',
                text: `${value.path}: ${value.type}${value.size !== undefined ? `, ${value.size} bytes` : ''}${value.mtimeMs !== undefined ? `, modified ${new Date(value.mtimeMs).toISOString()}` : ''}`,
              },
            ]
          : [{ type: 'text', text: `${value.path}: (absent)` }],
    },
    isConcurrencySafe: () => true,
    async execute(args: PathArgs, spawn: ToolRunContext) {
      const cwd = sessionCwd(spawn)
      const target = await fs.resolve(args.path, { ...(cwd !== undefined ? { cwd } : {}), signal: spawn.signal })
      const info = await fs.stat(target, spawn.signal)
      if (info === undefined) return { path: target.displayPath, exists: false }
      const mtimeMs = await hostMtime(fs.processPath(target))
      return {
        path: target.displayPath,
        exists: true,
        type: info.type,
        ...(info.size !== undefined ? { size: info.size } : {}),
        ...(mtimeMs !== undefined ? { mtimeMs } : {}),
      }
    },
  })
}

function listDirTool(ctx: PluginContext): ToolDefinition {
  const fs = ctx.fs
  if (fs === undefined) throw new Error('dsh-spawn: list_dir requires ctx.fs')
  return defineTool({
    name: 'list_dir',
    description: `List the entries of one directory in the session filesystem, one level at a time by default. \`depth\` recurses into subdirectories (maximum ${LIST_DIR_MAX_DEPTH}); results stop at ${LIST_DIR_MAX_ENTRIES} entries and report \`truncated\`. Entries are returned in stable name order and never include file contents.`,
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Directory to list. A relative path resolves against the session workspace.',
      },
      depth: {
        type: 'integer',
        description: `How many directory levels to walk: 1 lists direct children only (default), values are clamped to 1..${LIST_DIR_MAX_DEPTH}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                type: { type: 'string', required: true },
                size: { type: 'number' },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args: PathArgs, value: ListDirValue) => [
        {
          type: 'text',
          text:
            value.entries.length === 0
              ? `${value.path}: (empty)`
              : `${value.path}:\n${value.entries
                  .map((entry) => `${entry.type === 'directory' ? 'dir ' : 'file'} ${entry.path}${entry.size !== undefined ? ` (${entry.size} bytes)` : ''}`)
                  .join('\n')}${value.truncated ? '\n[listing truncated]' : ''}`,
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args: PathArgs, spawn: ToolRunContext) {
      const cwd = sessionCwd(spawn)
      const root = await fs.resolve(args.path, { ...(cwd !== undefined ? { cwd } : {}), signal: spawn.signal })
      const depth = Math.max(1, Math.min(LIST_DIR_MAX_DEPTH, args.depth ?? 1))
      const entries = []
      let truncated = false
      let level = [{ target: root, depth: 1 }]
      while (level.length > 0 && !truncated) {
        const next = []
        for (const item of level) {
          const children = await fs.listDir(item.target, spawn.signal)
          for (const child of children) {
            if (entries.length >= LIST_DIR_MAX_ENTRIES) {
              truncated = true
              break
            }
            entries.push({
              path: child.target.displayPath,
              type: child.type,
              ...(child.size !== undefined ? { size: child.size } : {}),
            })
            if (item.depth < depth && child.type === 'directory') {
              next.push({ target: child.target, depth: item.depth + 1 })
            }
          }
          if (truncated) break
        }
        level = next
      }
      return { path: root.displayPath, entries, truncated }
    },
  })
}

// ── plugin entry ────────────────────────────────────────────────────────────

/**
 * Register the four tools. `spawn` waits for the optional job registry so its
 * background and promotion paths exist exactly when `job_output`/`job_kill`
 * do; `which` and the two path tools wait for their own capability seams and
 * are simply absent in a composition that lacks them.
 * @param ctx - the plugin context.
 */
export function apply(ctx: PluginContext): void {
  const defaultMode = ctx.shell.sandboxMode
  const escalationModes = defaultMode === undefined ? [] : ESCALATION_TARGETS
  const sandboxPolicy = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (defaultMode !== undefined && sandboxPolicy === undefined) {
    throw new Error('dsh-spawn: the mounted shell executor confines but ctx.sandboxPolicy is missing')
  }
  const resolveSandboxPolicy = (spawn: ToolRunContext) =>
    sandboxPolicy?.resolve(spawn.agent === undefined ? {} : { session: spawn.agent.session })

  ctx.systemPrompt.section({
    name: 'tool:spawn',
    order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
    text: 'Programs run by `spawn` receive an explicit argv and no shell; pass each argument separately and read the returned `exitCode` (or `signal`) on every result. Investigate failures before moving on.',
  })

  const options = { escalationModes, resolveSandboxPolicy }
  let foregroundOnly = ctx.get('jobs') === undefined ? ctx.tools.register(spawnTool(ctx, undefined, options)) : undefined
  ctx.inject(['jobs'], (jobCtx: PluginContext) => {
    foregroundOnly?.()
    foregroundOnly = undefined
    const unregister = ctx.tools.register(spawnTool(ctx, jobCtx.jobs, options))
    jobCtx.effect(() => () => {
      unregister()
      if (ctx.fiber.state === 2) foregroundOnly = ctx.tools.register(spawnTool(ctx, undefined, options))
    })
  })

  ctx.inject(['subprocess'], (subprocessCtx: PluginContext) => {
    subprocessCtx.tools.register(whichTool(subprocessCtx))
  })

  ctx.inject(['fs'], (fsCtx: PluginContext) => {
    fsCtx.tools.register(statTool(fsCtx))
    fsCtx.tools.register(listDirTool(fsCtx))
  })
}