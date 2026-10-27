import { readFileSync, unlinkSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Context } from "@deepseek-ai/cordis";
import type { ShellExecSpec } from "@deepseek-ai/dsh-shell";
import type { SubprocessHandle } from "@deepseek-ai/dsh-subprocess";
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local";
import iconv from "iconv-lite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProgram } from "../src/direct-exec.js";

function spec(overrides: Partial<ShellExecSpec> = {}): ShellExecSpec {
	return {
		command: process.execPath,
		workdir: process.cwd(),
		timeoutMs: 5000,
		onExpiry: "none",
		stdoutMaxBytes: 65536,
		sandboxPolicy: undefined,
		...overrides,
	};
}

function writeBytes(channel: "stdout" | "stderr", bytes: Buffer): string {
	return (
		"process." +
		channel +
		".write(Buffer.from(" +
		JSON.stringify([...bytes]) +
		"));"
	);
}

let ctx: Context;
beforeEach(async () => {
	ctx = new Context();
	await ctx.plugin(LocalSubprocessRuntime).await();
});
afterEach(async () => {
	await ctx.fiber.dispose();
});

describe("real subprocess output", () => {
	it("decodes stdout and stderr independently through the actual host provider", async () => {
		const out = "UTF-8 正常输出 🌍\n";
		const err = "错误信息，测试中文编码。\n";
		const code =
			writeBytes("stdout", Buffer.from(out)) +
			writeBytes("stderr", iconv.encode(err, "gbk")) +
			"process.exitCode=7;";
		const proc = await runProgram(
			ctx,
			spec({ env: { LC_ALL: "zh_CN.GBK" } }),
			[process.execPath, "-e", code],
			undefined,
		);
		expect(await proc.result).toMatchObject({
			exitCode: 7,
			stdout: { text: out, truncated: false },
			stderr: { text: err, truncated: false },
		});
	});

	it("handles a BOM and UTF-16 characters split across real writes", async () => {
		const text = "你好，世界 🌍\n";
		const bytes = iconv.encode(text, "utf16be", { addBOM: true });
		const code =
			"const bytes=" +
			JSON.stringify([...bytes]) +
			";let i=0;const timer=setInterval(()=>{if(i===bytes.length){clearInterval(timer);return;}process.stdout.write(Buffer.from([bytes[i++]]));},2);";
		const proc = await runProgram(
			ctx,
			spec(),
			[process.execPath, "-e", code],
			undefined,
		);
		expect((await proc.result).stdout.text).toBe(text);
	});

	it("exposes live legacy progress through the same cursor-free reader used by jobs", async () => {
		let handle: SubprocessHandle | undefined;
		const firstData = Promise.withResolvers<void>();
		const original = ctx.subprocess.spawn.bind(ctx.subprocess);
		vi.spyOn(ctx.subprocess, "spawn").mockImplementation((request) => {
			handle = original(request);
			handle.stdout?.once("data", () =>
				setImmediate(() => firstData.resolve()),
			);
			return handle;
		});
		const first =
			"第一段：这是中文程序输出，应该自动识别编码，而不是依赖模型提供参数。\n";
		const last = "第二段中文输出\n";
		const code =
			writeBytes("stdout", iconv.encode(first, "gbk")) +
			"setTimeout(()=>{" +
			writeBytes("stdout", iconv.encode(last, "gbk")) +
			"},300);";
		const proc = await runProgram(
			ctx,
			spec({ env: { LC_ALL: "zh_CN.GBK" } }),
			[process.execPath, "-e", code],
			undefined,
		);
		await firstData.promise;
		const initial = proc.observed.stdout.readFrom(0);
		expect(initial.text).toBe(first);
		const final = await proc.result;
		expect(proc.observed.stdout.readFrom(initial.nextOffset).text).toBe(last);
		expect(proc.observed.stdout.readFrom(0).text).toBe(first + last);
		expect(final.stdout.text).toBe(first + last);
		expect(handle?.stdout?.destroyed).toBe(true);
		expect(handle?.stderr?.destroyed).toBe(true);
	});

	it("does not inject encoding variables or mutate the ambient environment", async () => {
		const names = [
			"LANG",
			"LC_ALL",
			"LC_CTYPE",
			"PYTHONUTF8",
			"PYTHONIOENCODING",
			"JAVA_TOOL_OPTIONS",
		];
		const before = Object.fromEntries(
			names.map((key) => [key, process.env[key]]),
		);
		const spawn = vi.spyOn(ctx.subprocess, "spawn");
		const code =
			"const keys=" +
			JSON.stringify(names) +
			";process.stdout.write(JSON.stringify(Object.fromEntries(keys.map(key=>[key,process.env[key]]))));";
		const proc = await runProgram(
			ctx,
			spec(),
			[process.execPath, "-e", code],
			undefined,
		);
		const result = await proc.result;
		expect(JSON.parse(result.stdout.text)).toEqual(
			JSON.parse(JSON.stringify(before)),
		);
		for (const key of names)
			expect(spawn.mock.calls[0]?.[0].env).not.toHaveProperty(key);
		expect(
			Object.fromEntries(names.map((key) => [key, process.env[key]])),
		).toEqual(before);
	});

	it("flushes decoded output and closes owned raw pipes on cancellation", async () => {
		const firstData = Promise.withResolvers<void>();
		const original = ctx.subprocess.spawn.bind(ctx.subprocess);
		let handle: SubprocessHandle | undefined;
		vi.spyOn(ctx.subprocess, "spawn").mockImplementation((request) => {
			handle = original(request);
			handle.stdout?.once("data", () =>
				setImmediate(() => firstData.resolve()),
			);
			return handle;
		});
		const controller = new AbortController();
		const text =
			"取消前保留：这是中文程序输出，应该自动识别编码，而不是依赖模型提供参数。\n";
		const code =
			writeBytes("stdout", iconv.encode(text, "gbk")) +
			"setInterval(()=>{},1000);";
		const proc = await runProgram(
			ctx,
			spec({ env: { LC_ALL: "zh_CN.GBK" } }),
			[process.execPath, "-e", code],
			controller.signal,
		);
		try {
			await firstData.promise;
			controller.abort(new Error("test cancellation"));
			const result = await proc.result;
			expect(result.aborted).toBe(true);
			expect(result.stdout.text).toBe(text);
			expect(handle?.stdout?.destroyed).toBe(true);
			expect(handle?.stderr?.destroyed).toBe(true);
		} finally {
			proc.kill();
		}
	});

	it("keeps the full legacy stream in a UTF-8 spill with a bounded character-safe tail", async () => {
		const line = "中文完整输出，超过内存预算。\n";
		const text = line.repeat(1000);
		// Keep the child command below Windows CreateProcess command-line limits.
		const code =
			"const bytes=Buffer.from(" +
			JSON.stringify(iconv.encode(line, "gbk").toString("hex")) +
			',"hex");for(let i=0;i<1000;i++)process.stdout.write(bytes);';
		const proc = await runProgram(
			ctx,
			spec({ stdoutMaxBytes: 61, env: { LC_ALL: "zh_CN.GBK" } }),
			[process.execPath, "-e", code],
			undefined,
		);
		const result = await proc.result;
		try {
			expect(result.stdout.truncated).toBe(true);
			expect(result.stdout.spillPath).toBeDefined();
			if (result.stdout.spillPath === undefined)
				throw new Error("missing spill");
			expect(readFileSync(result.stdout.spillPath, "utf8")).toBe(text);
			expect(result.stdout.text).not.toContain("\ufffd");
			expect(text.endsWith(result.stdout.text)).toBe(true);
			expect(Buffer.byteLength(result.stdout.text)).toBeLessThanOrEqual(61);
		} finally {
			if (result.stdout.spillPath) unlinkSync(result.stdout.spillPath);
		}
	});

	it("drains large output on both raw pipes before publishing the final result", async () => {
		const out = "UTF-8 中文输出\n".repeat(10000);
		const err = "GBK 错误信息，测试中文编码。\n".repeat(10000);
		const code =
			"const out=Buffer.from(" +
			JSON.stringify(Buffer.from("UTF-8 中文输出\n").toString("hex")) +
			",'hex');const err=Buffer.from(" +
			JSON.stringify(
				iconv.encode("GBK 错误信息，测试中文编码。\n", "gbk").toString("hex"),
			) +
			",'hex');for(let i=0;i<10000;i++){process.stdout.write(out);process.stderr.write(err);}";
		const proc = await runProgram(
			ctx,
			spec({ stdoutMaxBytes: 1024 * 1024, env: { LC_ALL: "zh_CN.GBK" } }),
			[process.execPath, "-e", code],
			undefined,
		);
		expect(await proc.result).toMatchObject({
			stdout: { text: out, truncated: false },
			stderr: { text: err, truncated: false },
		});
	});

	it("still rejects real executable startup failures", async () => {
		const proc = await runProgram(
			ctx,
			spec(),
			[process.execPath + ".missing"],
			undefined,
		);
		await expect(proc.result).rejects.toThrow();
		// Let the provider finish its range observation before its enclosing fiber is disposed.
		await delay(0);
	});
});
