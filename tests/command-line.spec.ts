import { PassThrough, Readable } from "node:stream";
import { readFileSync, unlinkSync } from "node:fs";
import iconv from "iconv-lite";
import { describe, expect, it, vi } from "vitest";
import { createJobs } from "./helpers.js";

type Any = any;

/** Import the built plugin and return one exported binding. */
async function plugin(): Promise<Any> {
	return import(new URL("../dist/index.js", import.meta.url).href);
}

/** Import the built direct runner. */
async function directExec(): Promise<Any> {
	return import(new URL("../dist/direct-exec.js", import.meta.url).href);
}

/** A provider handle exposing the raw pipes the runner asks for. */
function handle(
	stdout: string,
	stderr: string,
	exitCode: number,
	signal: string | null = null,
) {
	return {
		stdin: undefined,
		stdout: Readable.from([Buffer.from(stdout)]),
		stderr: Readable.from([Buffer.from(stderr)]),
		control: undefined,
		collected: {},
		done: Promise.resolve({ exitCode, signal }),
		terminate: () => {},
		waitForExit: async () => true,
	};
}

/** One resolved spec the runner consumes. */
function spec(overrides: Any = {}) {
	return {
		command: "prog",
		workdir: "/tmp",
		timeoutMs: 60000,
		onExpiry: "none",
		stdoutMaxBytes: 65536,
		sandboxPolicy: undefined,
		...overrides,
	};
}

/** A fake sandbox provider and subprocess context, recording both call streams. */
function runner(confined?: Any, spawned: Any = handle("out", "", 0)) {
	const calls: Any = { spawn: [], confine: [] };
	const sandbox = {
		confine: async (argv: Any, policy: Any, signal: Any) => {
			calls.confine.push({ argv, policy, signal });
			return (
				confined ?? {
					argv: ["runner", ...argv],
					enforcement: "full",
					denialSignatures: [],
					runnerFailureRules: [],
				}
			);
		},
	};
	const ctx: Any = {
		sandbox,
		subprocess: {
			spawn: (s: Any) => {
				calls.spawn.push(s);
				return spawned;
			},
		},
	};
	return { ctx, calls };
}

const READ_ONLY = { mode: "read-only", workspaceRoot: "/ws" };

describe("direct argv execution", () => {
	it("spawns the program argv with no shell layer", async () => {
		const { runProgram } = await directExec();
		const { ctx, calls } = runner();
		const proc = await runProgram(
			ctx,
			spec(),
			["/usr/bin/node", "--version"],
			undefined,
		);
		const result = await proc.result;
		expect(calls.confine).toHaveLength(0);
		expect(calls.spawn[0].argv).toEqual(["/usr/bin/node", "--version"]);
		expect(result).toMatchObject({
			exitCode: 0,
			stdout: { text: "out" },
			stderr: { text: "" },
		});
		expect(result.sandbox).toBeUndefined();
	});

	it("confines the exact argv and reports the sandbox facts", async () => {
		const { runProgram } = await directExec();
		const confined = {
			argv: ["sandbox-runner", "/usr/bin/node", "--version"],
			enforcement: "partial",
			denialSignatures: ["Permission denied"],
			runnerFailureRules: [],
		};
		const { ctx, calls } = runner(confined);
		const result = await (
			await runProgram(
				ctx,
				spec({
					sandboxPolicy: { mode: "workspace-write", workspaceRoot: "/ws" },
				}),
				["/usr/bin/node", "--version"],
				undefined,
			)
		).result;
		expect(calls.confine[0].argv).toEqual(["/usr/bin/node", "--version"]);
		expect(calls.spawn[0].argv).toEqual(confined.argv);
		expect(result.sandbox).toEqual({
			mode: "workspace-write",
			denied: false,
			enforcement: "partial",
		});
	});

	it("stops waiting when sandbox preparation ignores cancellation", async () => {
		const { runProgram } = await directExec();
		const { ctx, calls } = runner();
		ctx.sandbox.confine = () => new Promise(() => {});
		const controller = new AbortController();
		const reason = new Error("cancelled during preparation");
		const pending = runProgram(
			ctx,
			spec({ sandboxPolicy: READ_ONLY }),
			["prog"],
			controller.signal,
		);
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		expect(calls.spawn).toHaveLength(0);
	});

	it("does not prepare or spawn after cancellation", async () => {
		const { runProgram } = await directExec();
		const { ctx, calls } = runner();
		const reason = new Error("already cancelled");
		await expect(
			runProgram(
				ctx,
				spec({ sandboxPolicy: READ_ONLY }),
				["prog"],
				AbortSignal.abort(reason),
			),
		).rejects.toBe(reason);
		expect(calls.confine).toHaveLength(0);
		expect(calls.spawn).toHaveLength(0);
	});

	it("marks a matching non-zero exit as a sandbox denial", async () => {
		const { runProgram } = await directExec();
		const confined = {
			argv: ["sandbox-runner", "prog"],
			enforcement: "full",
			denialSignatures: ["Permission denied"],
			runnerFailureRules: [],
		};
		const pending = Promise.withResolvers<{ exitCode: number; signal: null }>();
		const { ctx } = runner(confined, {
			...handle("", "cat: /x: Permission denied", 1),
			done: pending.promise,
		});
		const proc = await runProgram(
			ctx,
			spec({ sandboxPolicy: READ_ONLY }),
			["prog"],
			undefined,
		);
		// Completion must also work with a frozen live handle.
		Object.freeze(proc);
		pending.resolve({ exitCode: 1, signal: null });
		const result = await proc.result;
		expect(result.sandbox).toMatchObject({ mode: "read-only", denied: true });
	});

	it("reports a runner failure as sandbox-unavailable", async () => {
		const { runProgram } = await directExec();
		const confined = {
			argv: ["sandbox-runner", "prog"],
			enforcement: "full",
			denialSignatures: [],
			runnerFailureRules: [{ fatalSignatures: ["runner exploded"] }],
		};
		const { ctx } = runner(confined, handle("", "runner exploded", 3));
		await expect(
			(
				await runProgram(
					ctx,
					spec({ sandboxPolicy: READ_ONLY }),
					["prog"],
					undefined,
				)
			).result,
		).rejects.toThrow();
	});

	it("preserves captured output when the provider fails", async () => {
		const { runProgram } = await directExec();
		const pending = Promise.withResolvers<{ exitCode: number; signal: null }>();
		const spawned = {
			...handle("partial output", "real stderr", 0),
			done: pending.promise,
		};
		const { ctx } = runner(undefined, spawned);
		const proc = await runProgram(ctx, spec(), ["prog"], undefined);
		const error = new Error("provider disconnected");
		const rejected = expect(proc.result).rejects.toBe(error);
		pending.reject(error);
		await rejected;
		expect(proc.observed.stdout.readFrom(0).text).toBe("partial output");
		expect(proc.observed.stderr.readFrom(0).text).toBe("real stderr");
	});

	it.each(["throw", "reject"])(
		"classifies sandbox runner spawn failures (%s)",
		async (failure) => {
			const { runProgram } = await directExec();
			const { ctx } = runner();
			const error = Object.assign(new Error("spawn runner ENOENT"), {
				code: "ENOENT",
				path: "runner",
				syscall: "spawn runner",
			});
			ctx.subprocess.spawn = () => {
				if (failure === "throw") throw error;
				return { ...handle("", "", 0), done: Promise.reject(error) };
			};
			await expect(
				(async () => {
					const proc = await runProgram(
						ctx,
						spec({ sandboxPolicy: READ_ONLY }),
						["prog"],
						undefined,
					);
					return await proc.result;
				})(),
			).rejects.toMatchObject({
				name: "SandboxUnavailableError",
				code: "SANDBOX_UNAVAILABLE",
			});
		},
	);

	it("reports full access without confining", async () => {
		const { runProgram } = await directExec();
		const { ctx, calls } = runner();
		const result = await (
			await runProgram(
				ctx,
				spec({
					sandboxPolicy: { mode: "danger-full-access", workspaceRoot: "/ws" },
				}),
				["prog"],
				undefined,
			)
		).result;
		expect(calls.confine).toHaveLength(0);
		expect(result.sandbox).toEqual({
			mode: "danger-full-access",
			denied: false,
		});
	});

	it("propagates executable resolution failure before registering a job", async () => {
		let start: Any;
		let spawn: Any;
		await expect(
			capturedSpawn("npm.cmd", [], handle("ok", "", 0), {}, (ctx) => {
				start = vi.spyOn(ctx.jobs, "start");
				spawn = vi.spyOn(ctx.subprocess, "spawn");
				ctx.subprocess.resolveExecutable = async () => {
					throw new Error("batch file requires a command shell");
				};
			}),
		).rejects.toThrow("batch file requires a command shell");
		expect(start).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	});
});

/** Run the registered spawn tool against a fake composition and return the spawn call. */
async function capturedSpawn(
	command: string,
	args: string[],
	spawned: Any = handle("ok", "", 0),
	options: Any = {},
	setup: (ctx: Any) => void = () => {},
	run: Any = {},
): Promise<Any> {
	const mod = await plugin();
	let captured: Any;
	const calls: Any = { spawn: [], resolveExecutable: [] };
	const ctx: Any = {
		shell: {
			sandboxMode: undefined,
			resolve: (request: Any) => ({
				workdir: "/tmp",
				timeoutMs: 1000,
				onExpiry: "none",
				stdoutMaxBytes: 4096,
				sandboxPolicy: undefined,
				...request,
			}),
		},
		subprocess: {
			resolveExecutable: async (c: string, env: Any) => {
				calls.resolveExecutable.push({ command: c, env });
				return "/resolved/" + c;
			},
			spawn: (s: Any) => {
				calls.spawn.push(s);
				return spawned;
			},
		},
		jobs: createJobs(),
		sandbox: {
			confine: () => {
				throw new Error("unexpected confinement");
			},
		},
		sandboxPolicy: {
			resolve: () => ({ mode: "danger-full-access", workspaceRoot: "/tmp" }),
		},
		systemPrompt: { section: () => {}, getSectionOrder: () => 0 },
		shellEnv: { collect: () => ({}) },
		tools: {
			register: (definition: Any) => {
				captured = definition;
				return () => {};
			},
		},
	};
	setup(ctx);
	mod.apply(ctx);
	const input = { command, args, ...options };
	const result = await captured.execute(input, {
		signal: new AbortController().signal,
		callId: "call-1",
		...run,
	});
	return {
		...calls.spawn[0],
		jobs: ctx.jobs,
		result,
		rendered: JSON.parse(captured.output.render(input, result)[0].text),
	};
}

/** Compose the tool with a confining executor; return the confine + spawn calls. */
async function capturedConfinedSpawn(
	command: string,
	args: string[],
): Promise<Any> {
	const mod = await plugin();
	let captured: Any;
	const calls: Any = { spawn: [], confine: [] };
	const spawned = handle("ok", "", 0);
	const policy = { mode: "workspace-write", workspaceRoot: "/ws" };
	const sandbox = {
		confine: async (argv: Any, p: Any, signal: Any) => {
			calls.confine.push({ argv, policy: p, signal });
			return {
				argv: ["runner", ...argv],
				enforcement: "full",
				denialSignatures: [],
				runnerFailureRules: [],
			};
		},
	};
	const ctx: Any = {
		shell: {
			sandboxMode: "workspace-write",
			resolve: (request: Any) => ({
				workdir: "/tmp",
				timeoutMs: 1000,
				onExpiry: "none",
				stdoutMaxBytes: 4096,
				sandboxPolicy: policy,
				...request,
			}),
		},
		subprocess: {
			resolveExecutable: async (c: string) => "/resolved/" + c,
			spawn: (s: Any) => {
				calls.spawn.push(s);
				return spawned;
			},
		},
		jobs: createJobs(),
		sandbox,
		sandboxPolicy: { resolve: () => policy },
		systemPrompt: { section: () => {}, getSectionOrder: () => 0 },
		shellEnv: { collect: () => ({}) },
		tools: {
			register: (definition: Any) => {
				captured = definition;
				return () => {};
			},
		},
	};
	mod.apply(ctx);
	await captured.execute(
		{ command, args },
		{ signal: new AbortController().signal, callId: "call-1" },
	);
	return calls;
}

describe("spawn jobs", () => {
	it("automatically decodes legacy foreground output without an encoding argument", async () => {
		const text =
			"这是中文程序输出，应该自动识别编码，而不是依赖模型提供参数。\n";
		const spawned = {
			...handle("", "", 0),
			stdout: Readable.from([iconv.encode(text, "gbk")]),
		};
		const { result } = await capturedSpawn("node", [], spawned);
		expect(result.stdout.text).toBe(text);
	});

	it("feeds decoded incremental output to registered background pull sources", async () => {
		const pending = Promise.withResolvers<{ exitCode: number; signal: null }>();
		const pipe = new PassThrough();
		const firstText =
			"这是中文程序输出，应该自动识别编码，而不是依赖模型提供参数。\n";
		const spawned = {
			...handle("", "", 0),
			stdout: pipe,
			done: pending.promise,
		};
		let sources: Any[] = [];
		const { jobs, result } = await capturedSpawn(
			"node",
			[],
			spawned,
			{ background: true },
			(ctx) => {
				const start = ctx.jobs.start;
				ctx.jobs.start = (request: Any) => {
					sources = request.output;
					return start(request);
				};
			},
		);
		try {
			expect(result.kind).toBe("background");
			const source = sources.find((source) => source.channel === "stdout");
			pipe.write(iconv.encode(firstText, "gbk"));
			const first = source.read(0);
			expect(first).toMatchObject({
				text: firstText,
				nextOffset: Buffer.byteLength(firstText),
				lossy: false,
			});
			pipe.write(Buffer.from("d6d0cec40a", "hex"));
			expect(source.read(first.nextOffset).text).toBe("中文\n");
			expect(source.read(0).text).toBe(firstText + "中文\n");
		} finally {
			pending.resolve({ exitCode: 0, signal: null });
			await jobs.wait(result.jobId, 1000);
		}
	});

	it.each(["throw", "reject"])(
		"reports provider failures in foreground and background (%s)",
		async (failure) => {
			const setup = (ctx: Any) => {
				ctx.subprocess.spawn = () => {
					const error = new Error("provider disconnected");
					if (failure === "throw") throw error;
					return {
						...handle("partial", "stderr", 0),
						done: Promise.reject(error),
					};
				};
			};
			await expect(
				capturedSpawn("node", [], undefined, {}, setup),
			).rejects.toThrow("provider disconnected");
			const { jobs, result } = await capturedSpawn(
				"node",
				[],
				undefined,
				{ background: true },
				setup,
			);
			expect(await jobs.wait(result.jobId, 1000)).toEqual({
				status: "failed",
				detail: "provider disconnected",
			});
		},
	);

	it("reports sandbox runner failures as failed jobs", async () => {
		const { jobs, result } = await capturedSpawn(
			"node",
			[],
			handle("", "runner exploded", 3),
			{ background: true },
			(ctx) => {
				ctx.sandboxPolicy.resolve = () => READ_ONLY;
				ctx.sandbox.confine = async (argv: string[]) => ({
					argv: ["runner", ...argv],
					enforcement: "full",
					denialSignatures: [],
					runnerFailureRules: [{ fatalSignatures: ["runner exploded"] }],
				});
			},
		);
		expect(await jobs.wait(result.jobId, 1000)).toMatchObject({
			status: "failed",
			detail: expect.stringContaining("runner exploded"),
		});
	});

	it.each([
		[3, null, "completed", "exit code: 3"],
		[0, "SIGTERM", "killed", "signal: SIGTERM"],
	])(
		"retains command exit facts in background jobs (%s, %s)",
		async (exitCode, signal, status, detail) => {
			const { jobs, result } = await capturedSpawn(
				"node",
				[],
				handle("", "", exitCode as number, signal as string | null),
				{ background: true },
			);
			expect(await jobs.wait(result.jobId, 1000)).toEqual({ status, detail });
		},
	);

	it("keeps cancelled jobs killed when the provider rejects", async () => {
		const pending = Promise.withResolvers<{ exitCode: number; signal: null }>();
		const process = {
			...handle("partial", "", 0),
			done: pending.promise,
			terminate: () => pending.reject(new Error("terminated")),
		};
		const { jobs, result } = await capturedSpawn("node", [], process, {
			background: true,
		});
		jobs.kill(result.jobId, undefined, "user stopped");
		expect(await jobs.wait(result.jobId, 1000)).toMatchObject({
			status: "killed",
		});
	});

	it("cancels unfinished sandbox preparation when the job wait times out", async () => {
		let spawn: Any;
		let kill: Any;
		const { result } = await capturedSpawn(
			"node",
			[],
			handle("", "", 0),
			{ timeoutMs: 1 },
			(ctx) => {
				ctx.sandboxPolicy.resolve = () => READ_ONLY;
				ctx.sandbox.confine = () => new Promise(() => {});
				spawn = vi.spyOn(ctx.subprocess, "spawn");
				kill = vi.spyOn(ctx.jobs, "kill");
			},
		);
		expect(result).toEqual({
			kind: "foreground",
			exitCode: null,
			timedOut: true,
			timeoutMs: 1,
			stdout: { text: "" },
		});
		expect(kill).toHaveBeenCalledWith(
			"spawn-1",
			undefined,
			"timed out during preparation",
		);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("starts background work without waiting for it", async () => {
		let wait: Any;
		const spawned = await capturedSpawn(
			"node",
			[],
			handle("ok", "", 0),
			{ background: true },
			(ctx) => {
				wait = vi.spyOn(ctx.jobs, "wait");
			},
		);
		expect(spawned.result).toEqual({ kind: "background", jobId: "spawn-1" });
		expect(wait).not.toHaveBeenCalled();
		await spawned.jobs.wait(spawned.result.jobId, 1000);
	});

	it("promotes a running foreground job on timeout", async () => {
		const process = handle("partial", "", 0);
		let finish!: (outcome: { exitCode: number; signal: null }) => void;
		process.done = new Promise((resolve) => {
			finish = resolve;
		});
		const spawned = await capturedSpawn("node", [], process, { timeoutMs: 1 });
		try {
			expect(spawned.result).toMatchObject({
				kind: "promoted",
				jobId: "spawn-1",
				timeoutMs: 1,
			});
		} finally {
			finish({ exitCode: 0, signal: null });
			await spawned.jobs.wait(spawned.result.jobId, 1000);
		}
	});

	it("propagates job registration failure before spawning the program", async () => {
		let spawn: Any;
		await expect(
			capturedSpawn("node", [], handle("ok", "", 0), {}, (ctx) => {
				spawn = vi.spyOn(ctx.subprocess, "spawn");
				ctx.jobs.start = () => {
					throw new Error("registration refused");
				};
			}),
		).rejects.toThrow("registration refused");
		expect(spawn).not.toHaveBeenCalled();
	});
});

describe("spawn compact results", () => {
	it.each([
		["", "", 0],
		["ok", "", 0],
		["ok", "bad", 3],
		["", " \n", 0],
	])(
		"omits false truncation and empty stderr (%j, %j, %j)",
		async (stdout, stderr, exitCode) => {
			const { result, rendered } = await capturedSpawn(
				"node",
				[],
				handle(stdout, stderr, exitCode),
			);
			const expected = {
				kind: "foreground",
				exitCode,
				stdout: { text: stdout },
				...(stderr.length > 0 ? { stderr: { text: stderr } } : {}),
			};
			expect(result).toEqual(expected);
			expect(rendered).toEqual(expected);
		},
	);

	it("retains truncation and spill facts even with empty captured text", async () => {
		const { result, rendered } = await capturedSpawn(
			"node",
			[],
			handle("tail", "error", 0),
			{},
			(ctx) => {
				const resolve = ctx.shell.resolve;
				ctx.shell.resolve = (request: Any) => ({
					...resolve(request),
					stdoutMaxBytes: 0,
				});
			},
		);
		try {
			expect(result).toEqual({
				kind: "foreground",
				exitCode: 0,
				stdout: { text: "", truncated: true, spillPath: expect.any(String) },
				stderr: { text: "", truncated: true, spillPath: expect.any(String) },
			});
			expect(readFileSync(result.stdout.spillPath, "utf8")).toBe("tail");
			expect(readFileSync(result.stderr.spillPath, "utf8")).toBe("error");
			expect(rendered).toEqual(result);
		} finally {
			if (result.stdout.spillPath) unlinkSync(result.stdout.spillPath);
			if (result.stderr.spillPath) unlinkSync(result.stderr.spillPath);
		}
	});
});

describe("spawn tool routes argv to the subprocess", () => {
	it("resolves argv[0] and passes every argument verbatim", async () => {
		const args = ["-e", "process.exit(0); // $HOME $(whoami) | cat", "it's"];
		const spawned = await capturedSpawn("node", args);
		expect(spawned.argv).toEqual(["/resolved/node", ...args]);
	});

	it("spawns the resolved executable directly, with no shell wrapper", async () => {
		const spawned = await capturedSpawn("node", ["--version"]);
		expect(spawned.argv[0]).toBe("/resolved/node");
		expect(spawned.argv).toHaveLength(2);
		expect(spawned.cwd).toBe("/tmp");
	});

	it("confines argv through ctx.sandbox under the resolved policy", async () => {
		const calls = await capturedConfinedSpawn("node", ["--version"]);
		expect(calls.confine[0].argv).toEqual(["/resolved/node", "--version"]);
		expect(calls.spawn[0].argv).toEqual([
			"runner",
			"/resolved/node",
			"--version",
		]);
	});
});

describe("host-managed session directory", () => {
	it.each([
		[undefined, "/ws/current"],
		["child", "/ws/current/child"],
		["/elsewhere", "/elsewhere"],
	])(
		"resolves cwd %s without moving the sandbox root",
		async (cwd, expected) => {
			const agent = { id: "a", session: { header: { cwd: "/ws" } } };
			const ensure = vi.fn(async () => "/ws/current");
			const result = await capturedSpawn(
				"node",
				[],
				undefined,
				cwd === undefined ? {} : { cwd },
				(ctx) => {
					ctx.workingDirectory = { ensure };
					ctx.sandboxPolicy.resolve = () => ({
						mode: "danger-full-access",
						workspaceRoot: "/ws",
					});
				},
				{ agent },
			);
			expect(result.cwd).toBe(expected);
			expect(ensure).toHaveBeenCalledWith(agent, expect.any(AbortSignal));
		},
	);
	it("does not execute when directory recovery fails", async () => {
		const spawn = vi.fn();
		await expect(
			capturedSpawn(
				"node",
				[],
				undefined,
				{},
				(ctx) => {
					ctx.workingDirectory = {
						ensure: async () => {
							throw new Error("directory unavailable");
						},
					};
					ctx.subprocess.spawn = spawn;
				},
				{ agent: { session: { header: { cwd: "/ws" } } } },
			),
		).rejects.toThrow("directory unavailable");
		expect(spawn).not.toHaveBeenCalled();
	});
	it("does not replace the current directory with the immutable workspace when the service is missing", async () => {
		const spawn = vi.fn();
		await expect(
			capturedSpawn(
				"node",
				[],
				undefined,
				{},
				(ctx) => {
					ctx.workingDirectory = undefined;
					ctx.subprocess.spawn = spawn;
				},
				{ agent: { session: { header: { cwd: "/ws" } } } },
			),
		).rejects.toThrow();
		expect(spawn).not.toHaveBeenCalled();
	});
	it("preserves executor defaults for agentless calls", async () => {
		const result = await capturedSpawn("node", []);
		expect(result.cwd).toBe("/tmp");
	});
});

it("changing cwd does not expand sandbox write access", async () => {
	const confine = vi.fn(async (argv: string[]) => ({
		argv: ["runner", ...argv],
		enforcement: "full",
		denialSignatures: [],
		runnerFailureRules: [],
	}));
	const result = await capturedSpawn(
		"node",
		[],
		undefined,
		{},
		(ctx) => {
			ctx.workingDirectory = { ensure: async () => "/outside/current" };
			ctx.sandboxPolicy.resolve = () => ({
				mode: "workspace-write",
				workspaceRoot: "/ws",
			});
			ctx.sandbox.confine = confine;
		},
		{ agent: { session: { header: { cwd: "/ws" } } } },
	);
	expect(result.cwd).toBe("/outside/current");
	expect(confine).toHaveBeenCalledWith(
		expect.any(Array),
		expect.objectContaining({ workspaceRoot: "/ws", mode: "workspace-write" }),
		expect.any(AbortSignal),
	);
});
