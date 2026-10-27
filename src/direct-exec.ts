/**
 * Direct argv execution for `dsh-spawn`: spawn the program through
 * `ctx.subprocess` (`argv`, never a shell string) under `ctx.sandbox`
 * confinement, with output-collection, spill, and sandbox-fact semantics but
 * no shell layer. The job registry owns waiting deadlines and promotion.
 *
 * This is the seam that makes the tool's "no shell" contract real: every
 * platform spawns from an argv vector, so the platform's own command-line
 * construction (CreateProcess on Windows, execve on POSIX) carries the
 * arguments verbatim and no quoting is ever written here.
 *
 * @module dsh-spawn/direct-exec
 */
import type { Context } from "@deepseek-ai/cordis";
import {
	prepareManagedProcessBinding,
	logSpillFailure,
} from "@deepseek-ai/dsh-subprocess-local/output";
import { DecodedOutputCollector, bindOutputStream } from "./output-capture.js";
import { outputEncodingHints } from "./output-encoding.js";
import {
	SandboxUnavailableError,
	classifyRunnerFailure,
	isRunnerSpawnFailure,
	matchesSignature,
	type ConfinedArgv,
	type SandboxPolicy,
} from "@deepseek-ai/dsh-sandbox";
import type {
	CollectedOutput,
	SubprocessHandle,
	SubprocessOutputReader,
} from "@deepseek-ai/dsh-subprocess";
import type {
	ShellSandboxInfo,
	ShellExecSpec,
	ShellRunResult,
} from "@deepseek-ai/dsh-shell";

/** Model-friendly environment overrides, mirroring the platform's shell executor. */
const ENV_OVERRIDES: Record<string, string> =
	process.platform === "win32"
		? { NO_COLOR: "1", PAGER: "cat", GIT_PAGER: "cat" }
		: { NO_COLOR: "1", TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" };
/** SIGTERM→SIGKILL grace period; mirrors `dsh-bash-local`/`dsh-pwsh-local`. */
const DEFAULT_GRACE_MS = 3_000;
/** Per-stream spill cap; mirrors `dsh-bash-local`/`dsh-pwsh-local`. */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024;

/** Internal process handle consumed by the job adapter and foreground waiter. */
export interface ProgramExecution {
	observed: { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader };
	kill(): void;
	/** One shared result; infrastructure failures reject for both foreground and jobs. */
	result: Promise<ShellRunResult>;
}

/** Project a settled collect-mode reader into the final `CollectedOutput` shape. */
function finalOutput(reader: SubprocessOutputReader): CollectedOutput {
	const read = reader.readFrom(0);
	return {
		text: read.text,
		truncated: read.lossy,
		...(read.spillPath !== undefined ? { spillPath: read.spillPath } : {}),
	};
}

/** The confining view of a resolved policy, or undefined when it is full access. */
function confinedPolicyOf(spec: ShellExecSpec): SandboxPolicy | undefined {
	const policy = spec.sandboxPolicy;
	if (policy === undefined || policy.mode === "danger-full-access")
		return undefined;
	return { ...policy, mode: policy.mode };
}

/** Prepare sandbox argv, stopping the wait even if the provider ignores cancellation. */
async function prepareSandbox(
	ctx: Context,
	argv: readonly string[],
	policy: SandboxPolicy,
	signal: AbortSignal,
): Promise<ConfinedArgv> {
	signal.throwIfAborted();

	const { promise: cancelled, reject } = Promise.withResolvers<never>();
	const cancel = () => reject(signal.reason);
	signal.addEventListener("abort", cancel, { once: true });
	async function prepare(): Promise<ConfinedArgv> {
		signal.throwIfAborted();
		return await ctx.sandbox.confine(argv, policy, signal);
	}

	try {
		const confined = await Promise.race([prepare(), cancelled]);
		signal.throwIfAborted();
		return confined;
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}

/**
 * Spawn one argv vector under this process's sandbox policy and adapt the
 * provider handle to the output, cancellation, and result interfaces the tool uses.
 * @param ctx - the plugin context (needs `ctx.subprocess` and `ctx.sandbox`).
 * @param spec - resolved output budgets/policy, from `ctx.shell.resolve` with `onExpiry: "none"`.
 * @param argv - the exact program argv; `argv[0]` is already an executable path.
 * @param signal - the caller's cancellation; overrides `spec.signal` when given.
 * @returns a live process handle with one shared result promise.
 */
export async function runProgram(
	ctx: Context,
	spec: ShellExecSpec,
	argv: readonly string[],
	signal: AbortSignal | undefined,
): Promise<ProgramExecution> {
	const policy = spec.sandboxPolicy;
	const confinedPolicy = confinedPolicyOf(spec);
	const spawnSignal = signal ?? spec.signal;

	let confined: ConfinedArgv | undefined;
	if (confinedPolicy !== undefined) {
		const bound = spawnSignal ?? new AbortController().signal;
		confined = await prepareSandbox(ctx, argv, confinedPolicy, bound);
	}

	// Attribute spawn failures to the sandbox runner only when the evidence matches.
	const spawnFailure = (error: unknown): never => {
		spawnSignal?.throwIfAborted();
		if (
			confinedPolicy !== undefined &&
			isRunnerSpawnFailure(error, confined?.argv[0], spec.workdir)
		) {
			throw new SandboxUnavailableError(confinedPolicy.mode, String(error));
		}
		throw error;
	};

	// Capture raw pipes ourselves: provider collect readers have already assumed UTF-8.
	const env = { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv };
	const hints = outputEncodingHints({ ...process.env, ...env });
	const binding = prepareManagedProcessBinding(
		ctx.logger === undefined
			? {}
			: { onSpillFailure: logSpillFailure(ctx.logger, "dsh-spawn") },
	);
	const spill = {
		maxBytes: DEFAULT_MAX_SPILL_BYTES,
		dir: binding.spillDir,
		onFailure: binding.onSpillFailure,
	};
	const stdout = new DecodedOutputCollector(
		spec.stdoutMaxBytes,
		"stdout",
		hints,
		spill,
	);
	const stderr = new DecodedOutputCollector(
		spec.stdoutMaxBytes,
		"stderr",
		hints,
		spill,
	);

	let running: SubprocessHandle;
	try {
		spawnSignal?.throwIfAborted();
		running = ctx.subprocess.spawn({
			argv: confined?.argv ?? argv,
			cwd: spec.workdir,
			stdio: {
				stdin: spec.stdin !== undefined ? { data: spec.stdin } : "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
			graceMs: DEFAULT_GRACE_MS,
			signal: spawnSignal,
			env,
		});
	} catch (error) {
		stdout.seal();
		stderr.seal();
		return spawnFailure(error);
	}

	if (running.stdout === undefined || running.stderr === undefined) {
		running.terminate();
		running.stdout?.destroy();
		running.stderr?.destroy();
		stdout.seal();
		stderr.seal();
		void running.done.catch(() => {});
		throw new Error(
			"dsh-spawn: the subprocess provider dropped a requested raw pipe",
		);
	}
	const stopStdout = bindOutputStream(running.stdout, stdout);
	const stopStderr = bindOutputStream(running.stderr, stderr);

	return {
		observed: { stdout, stderr },
		kill: () => running.terminate(),
		result: running.done
			.finally(() => {
				// Mirror provider collect-mode cleanup, including a survivor holding a pipe open.
				try {
					stopStdout();
				} finally {
					stopStderr();
				}
			})
			.catch((error) => {
				// Cancellation may reject instead of returning exit facts.
				if (spawnSignal?.aborted) return { exitCode: null, signal: null };
				return spawnFailure(error);
			})
			.then((outcome): ShellRunResult => {
				const result: ShellRunResult = {
					...outcome,
					timedOut: false,
					aborted: spawnSignal?.aborted === true,
					timeoutMs: spec.timeoutMs,
					stdout: finalOutput(stdout),
					stderr: finalOutput(stderr),
				};
				let sandbox: ShellSandboxInfo | undefined;
				if (confinedPolicy !== undefined) {
					const runnerFailure = classifyRunnerFailure(
						result.exitCode,
						result.stderr.text,
						confined?.runnerFailureRules ?? [],
					);
					if (runnerFailure !== undefined) {
						throw new SandboxUnavailableError(
							confinedPolicy.mode,
							runnerFailure.detail,
						);
					}
					sandbox = {
						mode: confinedPolicy.mode,
						denied: matchesSignature(
							result.exitCode,
							result.stderr.text,
							confined?.denialSignatures ?? [],
						),
						...(confined !== undefined
							? { enforcement: confined.enforcement }
							: {}),
					};
				} else if (policy !== undefined) {
					sandbox = { mode: policy.mode, denied: false };
				}
				return {
					...result,
					...(sandbox !== undefined ? { sandbox } : {}),
				};
			}),
	};
}
