/**
 * `dsh-spawn` — the typed process/path API that replaces `bash` in the
 * `PTC-spawn` agent preset (id `ptc-spawn`).
 *
 * Three model-facing tools, all callable inside a `run_code` program as
 * `tools.<name>(...)`:
 *
 * - `spawn`      run one program by argv (never a shell string), spawned
 *               directly through `ctx.subprocess` under the composition's sandbox
 *               policy (see `./direct-exec.js`) and escalatable through the
 *               shared approval choreography.
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
  type ShellRunResult,
  type ShellSandboxInfo,
} from '@deepseek-ai/dsh-shell'
import type { JobId, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import { assertDirectlyExecutable, runProgram } from './direct-exec.js'
// The empty type-only imports pull in each host package's Cordis `Context`
// augmentation (`ctx.subprocess`, `ctx.shellEnv`, `ctx.fs`,
// `ctx.systemPrompt`) without adding any of them to the runtime import graph.
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'

// ── host packages ────────────────────────────────────────────────────────────
//
// `@deepseek-ai/dsh-tools` / `dsh-llm` / `dsh-sandbox` / `dsh-shell` /
// `dsh-subprocess` / `dsh-timeout` are peer dependencies: the dsh launcher
// installs a runtime resolution into Node's ESM and CommonJS resolvers, and
// this package's peer declarations route each bare request to the module
// instance the running harness loaded, even when the bundle is a symlink.

// ── types ───────────────────────────────────────────────────────────────────

/**
 * The canonical `spawn` value: the discriminated union its output schema
 * declares, plus the stop reason a foreground call can additionally carry.
 */
/** One captured stream's model-facing value. */
type StreamValue = { text: string; truncated: boolean; spillPath?: string }

/**
 * The canonical `spawn` value: the discriminated union its output schema
 * declares, plus the stop reason a foreground call can additionally carry. A
 * clean foreground run carries only `exitCode`/`stdout`/`stderr`; the
 * diagnostics a consumer needs to explain an abnormal run are optional and set
 * only when they say something.
 */
type ForegroundValue = {
  kind: 'foreground'
  exitCode: number | null
  stdout: StreamValue
  stderr: StreamValue
  signal?: string
  timedOut?: boolean
  aborted?: boolean
  stopped?: string
  timeoutMs?: number
  sandbox?: { mode: SandboxMode; denied: boolean; enforcement?: string; runnerFailed?: boolean }
}

type SpawnValue =
  | { kind: 'background'; jobId: string }
  | { kind: 'promoted'; jobId: string; timeoutMs: number; output: string }
  | ForegroundValue

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

export const name = 'dsh-spawn'
export const inject = ['tools', 'shell', 'subprocess', 'systemPrompt', 'shellEnv']

/** Upper bound on one `list_dir` result, so a deep listing never floods the program. */
const LIST_DIR_MAX_ENTRIES = 2000
/** Upper bound on `list_dir` recursion; depth is clamped into [1, 3]. */
const LIST_DIR_MAX_DEPTH = 3

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
function streamText(output: StreamValue): string {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/**
 * The terminal card's human body: stdout, then stderr framed as its own
 * section. Presentation only: the model-facing result is structured JSON.
 */
function spawnBody(result: { stdout: StreamValue; stderr: StreamValue }): string {
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
  if (value.signal !== null && value.signal !== undefined) hints.push(`killed by signal: ${value.signal}`)
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
function canonicalRunResult(result: ShellRunResult): Omit<ForegroundValue, 'kind'> {
  const output = (stream: CollectedOutput): StreamValue => ({
    text: stream.text,
    truncated: stream.truncated,
    ...(stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {}),
  })
  const sandbox = result.sandbox
  return {
    exitCode: result.exitCode,
    stdout: output(result.stdout),
    stderr: output(result.stderr),
    ...(result.signal !== undefined && result.signal !== null ? { signal: result.signal } : {}),
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.aborted ? { aborted: true } : {}),
    ...(result.timedOut || result.aborted ? { timeoutMs: result.timeoutMs } : {}),
    ...(sandbox !== undefined && (sandbox.denied || sandbox.runnerFailed === true)
      ? {
          sandbox: {
            mode: sandbox.mode,
            denied: sandbox.denied,
            ...(sandbox.enforcement !== undefined ? { enforcement: sandbox.enforcement } : {}),
            ...(sandbox.runnerFailed !== undefined ? { runnerFailed: sandbox.runnerFailed } : {}),
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
  return `Run one program directly — no shell: \`command\` is a PATH name or absolute path, \`args\` its argv. Nothing is interpreted by a shell, so compose pipelines in the program. Long output is tail-truncated (spill path included); a non-zero exit is a normal result; a sandbox denial marker means do not retry another way. Verify the resolved path before any delete or move.`
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
function presentedResult(result: ToolResult): SpawnValue | undefined {
  const raw = resultText(result)
  if (raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    // The render side only ever emits a `SpawnValue`, and every consumer narrows
    // on `kind` and falls back to the generic card, so the shape is not
    // re-validated here. Replay arguments are untrusted, hence the one cast.
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as SpawnValue) : undefined
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
      ...(value.signal ? { signal: value.signal } : { exitCode: value.exitCode ?? 0 }),
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
function spawnTool(ctx: Context, jobs: JobRegistry | undefined, options: SpawnToolOptions): ToolDefinition {
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

  const startJob = (registry: JobRegistry, args: SpawnArgs, spawn: ToolRunContext, spec: ShellExecSpec, argv: readonly string[]): AttachedJob => {
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
              proc = await runProgram(ctx, ctx.get('sandbox'), spec, argv, signal)
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
        timedOut: true,
        timeoutMs,
        stdout: { text: '', truncated: false },
        stderr: { text: '', truncated: false },
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
        description: 'PATH name or absolute path; never a shell command line.'
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'argv entries, passed verbatim; shell metacharacters are literal.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'Short active-voice summary of the run, 5-10 words (shown in the UI).',
      },
      timeoutMs: {
        type: 'number',
        description: promote
          ? 'Timeout in ms; on expiry the run moves to the background as a job.'
          : 'Timeout in ms; the program is killed on expiry.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory; defaults to the session workspace; a relative path resolves against it.',
      },
      stdin: {
        type: 'string',
        description: "Bytes written to the program's stdin, then closed.",
      },
      env: {
        type: 'json',
        description:
          `Extra environment variables as string values; ${DSH_ENV_PREFIX}* names are harness-managed and rejected.`,
      },
      ...(background
        ? {
            background: {
              type: 'boolean',
              description: 'Start as a background job and return its job id immediately.',
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
              description: 'Required with sandbox_permissions: why this exact program needs wider access.',
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
              signal: { type: 'string' },
              timedOut: { type: 'boolean' },
              aborted: { type: 'boolean' },
              stopped: { type: 'string' },
              timeoutMs: { type: 'number' },
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
      validateSpawnArgs(args, standingPolicy?.mode)
      // Resolve argv[0] in the execution world before any approval or spawn,
      // so a missing program or a relative path fails here — not inside a job.
      const executable = await ctx.subprocess.resolveExecutable(args.command, args.env, spawn.signal)
      assertDirectlyExecutable(executable)
      const argv = [executable, ...(args.args ?? [])]
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
      // `ctx.shell.resolve` only fills the budgets and caps (timeout, workdir,
      // stdout cap, policy); the program itself is spawned from `argv`.
      const request = {
        command: args.command,
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
          jobId: startJob(jobs, args, spawn, ctx.shell.resolve({ ...request, onExpiry: 'none' }), argv).id,
        }
      }
      if (jobs !== undefined && promote) {
        const spec = ctx.shell.resolve({ ...request, onExpiry: 'none' })
        let attached
        try {
          attached = startJob(jobs, args, spawn, spec, argv)
        } catch (error) {
          ctx.logger.warn(
            `dsh-spawn: job registration refused, running in the foreground with the timeout kill instead: ${String(error)}`,
          )
        }
        if (attached !== undefined) return waitOnJob(jobs, attached, spawn, spec)
      }
      const spec = ctx.shell.resolve({ ...request, signal: spawn.signal })
      const result = await (await runProgram(ctx, ctx.get('sandbox'), spec, argv, spawn.signal)).result()
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

function statTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'stat',
    description: 'Return metadata for one path: existence, type, byte size, and mtime when available.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Path to inspect; a relative path resolves against the session workspace.',
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
      const target = await ctx.fs.resolve(args.path, { ...(cwd !== undefined ? { cwd } : {}), signal: spawn.signal })
      const info = await ctx.fs.stat(target, spawn.signal)
      if (info === undefined) return { path: target.displayPath, exists: false }
      const mtimeMs = await hostMtime(ctx.fs.processPath(target))
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

function listDirTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: 'list_dir',
    description: `List a directory's entries, one level deep by default; \`depth\` recurses up to ${LIST_DIR_MAX_DEPTH} levels. Results stop at ${LIST_DIR_MAX_ENTRIES} entries and report \`truncated\`.`,
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Directory to list; a relative path resolves against the session workspace.',
      },
      depth: {
        type: 'integer',
        description: `Directory levels to walk (1..${LIST_DIR_MAX_DEPTH}); defaults to 1.`,
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
      const root = await ctx.fs.resolve(args.path, { ...(cwd !== undefined ? { cwd } : {}), signal: spawn.signal })
      const depth = Math.max(1, Math.min(LIST_DIR_MAX_DEPTH, args.depth ?? 1))
      const entries = []
      let truncated = false
      let level = [{ target: root, depth: 1 }]
      while (level.length > 0 && !truncated) {
        const next = []
        for (const item of level) {
          const children = await ctx.fs.listDir(item.target, spawn.signal)
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
 * Register the three tools. `spawn` waits for the optional job registry so its
 * background and promotion paths exist exactly when `job_output`/`job_kill`
 * do; the two path tools wait for their own capability seams and are simply
 * absent in a composition that lacks them.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
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
    text: 'Programs run by `spawn` take an explicit argv and no shell; read the returned `exitCode` (or `signal`) on every result.',
  })

  const options = { escalationModes, resolveSandboxPolicy }
  let foregroundOnly = ctx.get('jobs') === undefined ? ctx.tools.register(spawnTool(ctx, undefined, options)) : undefined
  ctx.inject(['jobs'], (jobCtx: Context) => {
    foregroundOnly?.()
    foregroundOnly = undefined
    const unregister = ctx.tools.register(spawnTool(ctx, jobCtx.jobs, options))
    jobCtx.effect(() => () => {
      unregister()
      if (ctx.fiber.state === FiberState.ACTIVE) foregroundOnly = ctx.tools.register(spawnTool(ctx, undefined, options))
    })
  })

  ctx.inject(['fs'], (fsCtx: Context) => {
    fsCtx.tools.register(statTool(fsCtx))
    fsCtx.tools.register(listDirTool(fsCtx))
  })
}