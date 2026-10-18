import { Context } from "@deepseek-ai/cordis";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import * as spawnPlugin from "@snylonue/dsh-spawn";
import * as listDirPlugin from "@snylonue/dsh-spawn/list-dir";
import * as statPlugin from "@snylonue/dsh-spawn/stat";
import { describe, expect, it, vi } from "vitest";

async function setup(withWorkingDirectory = true) {
	const ctx = new Context();
	ctx.provide("systemPrompt", {
		tools: () => () => {},
		section: () => () => {},
		getSectionOrder: () => 0,
	} as any);
	ctx.provide("shell", {} as any);
	ctx.provide("subprocess", {} as any);
	ctx.provide("shellEnv", {} as any);
	ctx.provide("jobs", {} as any);
	ctx.provide("sandbox", {} as any);
	ctx.provide("sandboxPolicy", {} as any);
	ctx.provide("fs", {} as any);
	if (withWorkingDirectory)
		ctx.provide("workingDirectory", {
			ensure: async () => "/ws/current",
		} as any);
	await ctx.plugin(ToolRuntime);
	await ctx.plugin(spawnPlugin);
	return ctx;
}

describe("independent path tool plugins", () => {
	it("registers only spawn from the main entry", async () => {
		const ctx = await setup();
		try {
			expect(ctx.tools.get("spawn")).toBeDefined();
			expect(ctx.tools.get("stat")).toBeUndefined();
			expect(ctx.tools.get("list_dir")).toBeUndefined();
		} finally {
			await ctx.fiber.dispose();
		}
	});

	it.each([
		{ name: "stat", other: "list_dir", plugin: statPlugin },
		{ name: "list_dir", other: "stat", plugin: listDirPlugin },
	])(
		"can disable and re-enable $name independently",
		async ({ name, other, plugin }) => {
			const ctx = await setup();
			try {
				const stat = await ctx.plugin(statPlugin);
				const listDir = await ctx.plugin(listDirPlugin);
				const spawn = ctx.tools.get("spawn");
				const otherTool = ctx.tools.get(other);
				expect(ctx.tools.get(name)).toBeDefined();
				expect(otherTool).toBeDefined();

				await (name === "stat" ? stat : listDir).dispose();
				expect(ctx.tools.get(name)).toBeUndefined();
				expect(ctx.tools.get(other)).toBe(otherTool);
				expect(ctx.tools.get("spawn")).toBe(spawn);

				await ctx.plugin(plugin);
				expect(ctx.tools.get(name)).toBeDefined();
				expect(ctx.tools.get(other)).toBe(otherTool);
				expect(ctx.tools.get("spawn")).toBe(spawn);
			} finally {
				await ctx.fiber.dispose();
			}
		},
	);
});

it.each([
	{ name: "stat", plugin: statPlugin },
	{ name: "list_dir", plugin: listDirPlugin },
])(
	"$name follows cwd changes rather than the immutable header",
	async ({ name, plugin }) => {
		const ctx = await setup();
		const resolved: string[] = [];
		const agent = { session: { header: { cwd: "/ws" } } };
		let current = "/ws/first";
		Object.assign(ctx.workingDirectory, { ensure: async () => current });
		Object.assign(ctx.fs, {
			resolve: async (_path: string, options: any) => {
				resolved.push(options.cwd);
				return { displayPath: options.cwd };
			},
			stat: async () => undefined,
			listDir: async () => [],
		});
		try {
			await ctx.plugin(plugin);
			const tool = ctx.tools.get(name)!;
			const run = { agent, signal: new AbortController().signal } as any;
			await tool.execute({ path: "." }, run);
			current = "/ws/second";
			await tool.execute({ path: "." }, run);
			expect(resolved).toEqual(["/ws/first", "/ws/second"]);
		} finally {
			await ctx.fiber.dispose();
		}
	},
);

it.each([
	{ name: "stat", plugin: statPlugin },
	{ name: "list_dir", plugin: listDirPlugin },
])(
	"$name propagates directory recovery errors without accessing the filesystem",
	async ({ name, plugin }) => {
		const ctx = await setup();
		const resolve = vi.fn(async () => ({ displayPath: "/ws" }));
		Object.assign(ctx.fs, {
			resolve,
			stat: async () => undefined,
			listDir: async () => [],
		});
		try {
			await ctx.plugin(plugin);
			const tool = ctx.tools.get(name)!;
			const run = {
				agent: { session: { header: { cwd: "/ws" } } },
				signal: new AbortController().signal,
			} as any;
			Object.assign(ctx.workingDirectory, {
				ensure: async () => {
					throw new Error("recovery failed");
				},
			});
			await expect(tool.execute({ path: "." }, run)).rejects.toThrow(
				"recovery failed",
			);
			expect(resolve).not.toHaveBeenCalled();
		} finally {
			await ctx.fiber.dispose();
		}
	},
);

it.each([
	{ name: "spawn", plugin: spawnPlugin },
	{ name: "stat", plugin: statPlugin },
	{ name: "list_dir", plugin: listDirPlugin },
])(
	"$name requires the current host working-directory service",
	async ({ name, plugin }) => {
		const ctx = await setup(false);
		try {
			if (name !== "spawn") await ctx.plugin(plugin);
			expect(ctx.tools.get(name)).toBeUndefined();
			ctx.provide("workingDirectory", {
				ensure: async () => "/ws/current",
			} as any);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(ctx.tools.get(name)).toBeDefined();
		} finally {
			await ctx.fiber.dispose();
		}
	},
);
