/**
 * Direct argv execution for `dsh-spawn`: spawn the program through
 * `ctx.subprocess` (`argv`, never a shell string) under `ctx.sandbox`
 * confinement, with the shell executors' deadline, output-collection, spill,
 * and sandbox-fact semantics but no shell layer.
 *
 * This is the seam that makes the tool's "no shell" contract real: every
 * platform spawns from an argv vector, so the platform's own command-line
 * construction (CreateProcess on Windows, execve on POSIX) carries the
 * arguments verbatim and no quoting is ever written here.
 *
 * @module dsh-spawn/direct-exec
 */
import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import {
  SandboxUnavailableError,
  classifyRunnerFailure,
  isRunnerSpawnFailure,
  matchesSignature,
  type ConfinedArgv,
  type SandboxPolicy,
  type SandboxProvider,
} from '@deepseek-ai/dsh-sandbox'
import type {
  CollectedOutput,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputReader,
} from '@deepseek-ai/dsh-subprocess'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ShellExecution, ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'

/** Model-friendly environment overrides, mirroring the platform's shell executor. */
const ENV_OVERRIDES: Record<string, string> =
  process.platform === 'win32'
    ? { NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' }
    : { NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' }
/** SIGTERM→SIGKILL grace period; mirrors `dsh-bash-local`/`dsh-pwsh-local`. */
const DEFAULT_GRACE_MS = 3_000
/** Per-stream spill cap; mirrors `dsh-bash-local`/`dsh-pwsh-local`. */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024
/** Timeout reason code this runner owns (the executors' `BASH_TIMEOUT` twin). */
const SPAWN_TIMEOUT = 'SPAWN_TIMEOUT'

/** The reader a process that failed before spawn exposes as both streams. */
const EMPTY_READER: SubprocessOutputReader = {
  readFrom: () => ({ text: '', lossy: false, nextOffset: 0 }),
}

/**
 * Reject a Windows batch-file target: `CreateProcess` (and Node's `spawn`,
 * since the CVE-2024-27980 fix) cannot execute a `.cmd`/`.bat` without a
 * command shell, and building that shell string is the quoting layer this
 * module exists to avoid. The caller gets an actionable error instead of the
 * provider's `EINVAL`.
 * @param executable - the resolved `argv[0]`.
 * @param platform - the execution platform; defaults to the host.
 * @throws Error when the executable is a Windows batch file.
 */
export function assertDirectlyExecutable(executable: string, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) return
  throw new Error(
    `invalid command: ${JSON.stringify(executable)} is a Windows batch file, which cannot run without a command shell; invoke "cmd" with args ["/c", ...] or a real executable instead`,
  )
}

/** Project a settled collect-mode reader into the final `CollectedOutput` shape. */
function finalOutput(reader: SubprocessOutputReader): CollectedOutput {
  const read = reader.readFrom(0)
  return {
    text: read.text,
    truncated: read.lossy,
    ...(read.spillPath !== undefined ? { spillPath: read.spillPath } : {}),
  }
}

/** The confining view of a resolved policy, or undefined when it is full access. */
function confinedPolicyOf(spec: ShellExecSpec): SandboxPolicy | undefined {
  const policy = spec.sandboxPolicy
  if (policy === undefined || policy.mode === 'danger-full-access') return undefined
  return { ...policy, mode: policy.mode }
}

/**
 * Spawn one argv vector under this process's sandbox policy and adapt the
 * provider handle to the shell execution shape the tool's job plumbing uses.
 * @param ctx - the plugin context (needs `ctx.subprocess`).
 * @param sandbox - the sandbox provider, read through `ctx.get` so a composition without one still loads.
 * @param spec - resolved budgets/policy, from `ctx.shell.resolve`.
 * @param argv - the exact program argv; `argv[0]` is already an executable path.
 * @param signal - the caller's cancellation; overrides `spec.signal` when given.
 * @returns a live `ShellExecution`-shaped handle.
 */
export async function runProgram(
  ctx: Context,
  sandbox: SandboxProvider | undefined,
  spec: ShellExecSpec,
  argv: readonly string[],
  signal: AbortSignal | undefined,
): Promise<ShellExecution> {
  const policy = spec.sandboxPolicy
  const confinedPolicy = confinedPolicyOf(spec)
  const effectiveSignal = signal ?? spec.signal
  if (confinedPolicy !== undefined && sandbox === undefined) {
    throw new Error('dsh-spawn: a confining mode is set but ctx.sandbox is missing from this composition')
  }

  let spawnSignal: AbortSignal | undefined
  let classify: () => { timedOut: boolean; aborted: boolean }
  let disarm = () => {}
  if (spec.onExpiry === 'kill') {
    const d = deadline(effectiveSignal, spec.timeoutMs, SPAWN_TIMEOUT)
    spawnSignal = d.signal
    classify = () => {
      const timedOut = timeoutOf(d.signal, SPAWN_TIMEOUT) !== undefined
      return { timedOut, aborted: d.signal.aborted && !timedOut }
    }
    disarm = () => {
      d[Symbol.dispose]()
    }
  } else {
    spawnSignal = effectiveSignal
    classify = () => ({ timedOut: false, aborted: effectiveSignal?.aborted === true })
  }

  let confined: ConfinedArgv | undefined
  let preparationTimedOut = false
  if (confinedPolicy !== undefined) {
    const bound = spawnSignal ?? new AbortController().signal
    let rejectCancelled: (reason?: unknown) => void = () => {}
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancelled = reject
    })
    const cancel = () => rejectCancelled(bound.reason)
    bound.addEventListener('abort', cancel, { once: true })
    try {
      confined = await Promise.race([
        Promise.resolve().then(() => {
          bound.throwIfAborted()
          return sandbox!.confine(argv, confinedPolicy, bound)
        }),
        cancelled,
      ])
      bound.throwIfAborted()
    } catch (error) {
      if (!classify().timedOut) {
        disarm()
        throw error
      }
      preparationTimedOut = true
    } finally {
      bound.removeEventListener('abort', cancel)
    }
  }

  let running: SubprocessHandle | undefined
  let syncError: unknown
  try {
    if (!preparationTimedOut) {
      running = ctx.subprocess.spawn({
        argv: confined !== undefined ? confined.argv : argv,
        cwd: spec.workdir,
        stdio: {
          stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
          stdout: { maxBytes: spec.stdoutMaxBytes, spill: { maxBytes: DEFAULT_MAX_SPILL_BYTES } },
          stderr: { maxBytes: spec.stdoutMaxBytes, spill: { maxBytes: DEFAULT_MAX_SPILL_BYTES } },
        },
        graceMs: DEFAULT_GRACE_MS,
        signal: spawnSignal,
        env: { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv },
      })
    }
  } catch (error) {
    syncError = error
  }

  let collected: { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader }
  if (running !== undefined) {
    const streams = running.collected
    /* v8 ignore start -- the provider exposes both readers for a requested collect stream; defensive. */
    if (streams.stdout === undefined || streams.stderr === undefined) {
      throw new Error('dsh-spawn: the subprocess provider dropped a requested collect stream')
    }
    /* v8 ignore stop */
    collected = { stdout: streams.stdout, stderr: streams.stderr }
  } else {
    collected = { stdout: EMPTY_READER, stderr: EMPTY_READER }
  }

  const spawned: Promise<SubprocessOutcome> = preparationTimedOut
    ? Promise.resolve({ exitCode: null, signal: null })
    : running !== undefined
      ? running.done
      : Promise.reject(syncError)

  let providerFailure: { error: unknown; note: string } | undefined
  let providerFailureReported = false
  const consumeProviderFailure = () => {
    if (providerFailure === undefined || providerFailureReported) return ''
    providerFailureReported = true
    return providerFailure.note
  }
  const observedStderr: SubprocessOutputReader = {
    readFrom: (fromByte) => {
      if (providerFailure === undefined) return collected.stderr.readFrom(fromByte)
      const note = Buffer.from(providerFailure.note, 'utf8')
      return {
        text: note.subarray(Math.min(fromByte, note.length)).toString('utf8'),
        nextOffset: note.length,
        lossy: false,
      }
    },
  }

  /**
   * Stamp settlement facts, mirroring the sandbox shell executor: a runner
   * that failed before the command could run reports `runnerFailed`, a
   * non-zero exit whose stderr matches the backend's denial dialect reports
   * `denied`, and an unconfined run under a sandboxing composition reports the
   * mode with no denial.
   */
  const settleSandbox = (
    target: ShellExecution,
    exitCode: number | null,
    stderr: string,
    providerRejected: boolean,
    providerError: unknown,
  ): void => {
    if (confinedPolicy === undefined) {
      if (policy !== undefined) target.sandbox = { mode: policy.mode, denied: false }
      return
    }
    const runnerFailed = providerRejected
      ? isRunnerSpawnFailure(providerError, confined?.argv[0], spec.workdir)
      : confined !== undefined && classifyRunnerFailure(exitCode, stderr, confined.runnerFailureRules) !== undefined
    const denied =
      !runnerFailed && confined !== undefined && matchesSignature(exitCode, stderr, confined.denialSignatures)
    target.sandbox = {
      mode: confinedPolicy.mode,
      denied,
      ...(confined !== undefined ? { enforcement: confined.enforcement } : {}),
      ...(runnerFailed ? { runnerFailed: true } : {}),
    }
  }

  let stdoutOffset = 0
  let stderrOffset = 0
  let resultPromise: Promise<ShellRunResult> | undefined
  const proc: ShellExecution = {
    status: 'running',
    exitCode: null,
    signal: null,
    observed: { stdout: collected.stdout, stderr: observedStderr },
    done: spawned.then(
      (outcome) => {
        if (proc.status === 'running') {
          proc.status = spawnSignal?.aborted === true || outcome.signal !== null ? 'killed' : 'completed'
        }
        proc.exitCode = outcome.exitCode
        proc.signal = outcome.signal
        settleSandbox(proc, outcome.exitCode, collected.stderr.readFrom(0).text, false, undefined)
        disarm()
      },
      (error) => {
        if (running !== undefined && (proc.status === 'killed' || spawnSignal?.aborted === true)) {
          proc.status = 'killed'
          settleSandbox(proc, null, collected.stderr.readFrom(0).text, false, undefined)
          disarm()
          return
        }
        proc.status = 'killed'
        let detail = 'unprintable provider failure'
        try {
          detail = String(error)
        } catch {}
        providerFailure = { error, note: `subprocess failed before reporting an outcome: ${detail}` }
        settleSandbox(proc, null, providerFailure.note, true, error)
        disarm()
      },
    ),
    readOutput: () => {
      const out = collected.stdout.readFrom(stdoutOffset)
      const err = collected.stderr.readFrom(stderrOffset)
      stdoutOffset = out.nextOffset
      stderrOffset = err.nextOffset
      const failure = consumeProviderFailure()
      const failureSeparator = err.text.length > 0 && !err.text.endsWith('\n') ? '\n' : ''
      const errText = err.text + (failure.length > 0 ? `${failureSeparator}${failure}` : '')
      const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
      return {
        delta: out.text + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ''),
        lossy: out.lossy || err.lossy,
        ...(out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {}),
        ...(err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {}),
      }
    },
    kill: () => {
      if (proc.status !== 'running') return false
      proc.status = 'killed'
      running?.terminate()
      return true
    },
    result: () => {
      resultPromise ??= proc.done.then((): ShellRunResult => {
        if (providerFailure !== undefined) {
          if (effectiveSignal?.aborted === true) effectiveSignal.throwIfAborted()
          if (
            confinedPolicy !== undefined &&
            confined !== undefined &&
            isRunnerSpawnFailure(providerFailure.error, confined.argv[0], spec.workdir)
          ) {
            throw new SandboxUnavailableError(confinedPolicy.mode, String(providerFailure.error))
          }
          throw providerFailure.error
        }
        const base: ShellRunResult = {
          exitCode: proc.exitCode,
          signal: proc.signal,
          ...classify(),
          timeoutMs: spec.timeoutMs,
          stdout: finalOutput(collected.stdout),
          stderr: finalOutput(collected.stderr),
        }
        if (confinedPolicy !== undefined) {
          const runnerFailure =
            confined !== undefined
              ? classifyRunnerFailure(base.exitCode, base.stderr.text, confined.runnerFailureRules)
              : undefined
          if (runnerFailure !== undefined) throw new SandboxUnavailableError(confinedPolicy.mode, runnerFailure.detail)
          return {
            ...base,
            sandbox: {
              mode: confinedPolicy.mode,
              denied:
                confined !== undefined && matchesSignature(base.exitCode, base.stderr.text, confined.denialSignatures),
              ...(confined !== undefined ? { enforcement: confined.enforcement } : {}),
            },
          }
        }
        return policy !== undefined ? { ...base, sandbox: { mode: policy.mode, denied: false } } : base
      })
      return resultPromise
    },
  }
  return proc
}
