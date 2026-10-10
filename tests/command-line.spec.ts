import { describe, expect, it } from "vitest";

type Any = any;

/** Import the built plugin and return one exported binding. */
async function plugin(): Promise<Any> {
	return import(new URL("../dist/index.js", import.meta.url).href);
}

/** Import the built direct runner. */
async function directExec(): Promise<Any> {
	return import(new URL("../dist/direct-exec.js", import.meta.url).href);
}

/** An offset reader over a fixed string. */
function reader(text: string) {
	return {
		readFrom: (from: number) => ({
			text: text.slice(from),
			nextOffset: text.length,
			lossy: false,
		}),
	};
}

/** A provider handle exposing the collect readers the runner asks for. */
function handle(
	stdout: string,
	stderr: string,
	exitCode: number,
	signal: string | null = null,
) {
	return {
		stdin: undefined,
		stdout: undefined,
		stderr: undefined,
		control: undefined,
		collected: { stdout: reader(stdout), stderr: reader(stderr) },
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
		subprocess: {
			spawn: (s: Any) => {
				calls.spawn.push(s);
				return spawned;
			},
		},
	};
	return { ctx, sandbox, calls };
}

const READ_ONLY = { mode: "read-only", workspaceRoot: "/ws" };

describe("direct argv execution", () => {
	it("spawns the program argv with no shell layer", async () => {
		const { runProgram } = await directExec();
		const { ctx, sandbox, calls } = runner();
		const proc = await runProgram(
			ctx,
			sandbox,
			spec(),
			["/usr/bin/node", "--version"],
			undefined,
		);
		const result = await proc.result();
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
		const { ctx, sandbox, calls } = runner(confined);
		const result = await (
			await runProgram(
				ctx,
				sandbox,
				spec({
					sandboxPolicy: { mode: "workspace-write", workspaceRoot: "/ws" },
				}),
				["/usr/bin/node", "--version"],
				undefined,
			)
		).result();
		expect(calls.confine[0].argv).toEqual(["/usr/bin/node", "--version"]);
		expect(calls.spawn[0].argv).toEqual(confined.argv);
		expect(result.sandbox).toEqual({
			mode: "workspace-write",
			denied: false,
			enforcement: "partial",
		});
	});

	it("marks a matching non-zero exit as a sandbox denial", async () => {
		const { runProgram } = await directExec();
		const confined = {
			argv: ["sandbox-runner", "prog"],
			enforcement: "full",
			denialSignatures: ["Permission denied"],
			runnerFailureRules: [],
		};
		const { ctx, sandbox } = runner(
			confined,
			handle("", "cat: /x: Permission denied", 1),
		);
		const result = await (
			await runProgram(
				ctx,
				sandbox,
				spec({ sandboxPolicy: READ_ONLY }),
				["prog"],
				undefined,
			)
		).result();
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
		const { ctx, sandbox } = runner(confined, handle("", "runner exploded", 3));
		await expect(
			(
				await runProgram(
					ctx,
					sandbox,
					spec({ sandboxPolicy: READ_ONLY }),
					["prog"],
					undefined,
				)
			).result(),
		).rejects.toThrow();
	});

	it("reports full access without confining", async () => {
		const { runProgram } = await directExec();
		const { ctx, sandbox, calls } = runner();
		const result = await (
			await runProgram(
				ctx,
				sandbox,
				spec({
					sandboxPolicy: { mode: "danger-full-access", workspaceRoot: "/ws" },
				}),
				["prog"],
				undefined,
			)
		).result();
		expect(calls.confine).toHaveLength(0);
		expect(result.sandbox).toEqual({
			mode: "danger-full-access",
			denied: false,
		});
	});

	it("rejects a Windows batch-file target with an actionable error", async () => {
		const { assertDirectlyExecutable } = await directExec();
		expect(() =>
			assertDirectlyExecutable("C:\\Users\\me\\npm.cmd", "win32"),
		).toThrow(/batch file/);
		expect(() =>
			assertDirectlyExecutable("C:\\tools\\run.BAT", "win32"),
		).toThrow(/batch file/);
		expect(() =>
			assertDirectlyExecutable("C:\\nodejs\\node.exe", "win32"),
		).not.toThrow();
		expect(() =>
			assertDirectlyExecutable("/usr/bin/npm.cmd", "linux"),
		).not.toThrow();
	});
});

/** Run the registered spawn tool against a fake composition and return the spawn call. */
async function capturedSpawn(
	command: string,
	args: string[],
	spawned: Any = handle("ok", "", 0),
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
				onExpiry: "kill",
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
		get: () => undefined,
		logger: { warn: () => {} },
		systemPrompt: { section: () => {}, getSectionOrder: () => 0 },
		shellEnv: { collect: () => ({}) },
		tools: {
			register: (definition: Any) => {
				captured = definition;
				return () => {};
			},
		},
		inject: () => {},
	};
	mod.apply(ctx);
	const input = { command, args };
	const result = await captured.execute(input, {
		signal: new AbortController().signal,
		callId: "call-1",
	});
	return {
		...calls.spawn[0],
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
				onExpiry: "kill",
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
		get: (name: string) =>
			name === "sandbox"
				? sandbox
				: name === "sandboxPolicy"
					? { resolve: () => policy }
					: undefined,
		logger: { warn: () => {} },
		systemPrompt: { section: () => {}, getSectionOrder: () => 0 },
		shellEnv: { collect: () => ({}) },
		tools: {
			register: (definition: Any) => {
				captured = definition;
				return () => {};
			},
		},
		inject: () => {},
	};
	mod.apply(ctx);
	await captured.execute(
		{ command, args },
		{ signal: new AbortController().signal, callId: "call-1" },
	);
	return calls;
}

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

	it("retains truncation and spill facts even with empty captured stderr", async () => {
		const spawned = handle("tail", "", 0);
		spawned.collected.stdout.readFrom = () => ({
			text: "tail",
			nextOffset: 100,
			lossy: true,
			spillPath: "/tmp/out-spill",
		});
		spawned.collected.stderr.readFrom = () => ({
			text: "",
			nextOffset: 100,
			lossy: true,
			spillPath: "/tmp/err-spill",
		});
		const { result, rendered } = await capturedSpawn("node", [], spawned);
		expect(result).toEqual({
			kind: "foreground",
			exitCode: 0,
			stdout: { text: "tail", truncated: true, spillPath: "/tmp/out-spill" },
			stderr: { text: "", truncated: true, spillPath: "/tmp/err-spill" },
		});
		expect(rendered).toEqual(result);
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

	it('confines argv through ctx.get("sandbox") when the executor sandboxes', async () => {
		const calls = await capturedConfinedSpawn("node", ["--version"]);
		expect(calls.confine[0].argv).toEqual(["/resolved/node", "--version"]);
		expect(calls.spawn[0].argv).toEqual([
			"runner",
			"/resolved/node",
			"--version",
		]);
	});
});
