import { Context } from "@deepseek-ai/cordis";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import * as spawnPlugin from "dsh-spawn";
import * as statPlugin from "dsh-spawn/stat";
import * as listDirPlugin from "dsh-spawn/list-dir";

async function setup() {
	const ctx = new Context();
	ctx.provide("systemPrompt", {
		tools: () => () => {},
		section: () => () => {},
		getSectionOrder: () => 0,
	} as any);
	ctx.provide("shell", {} as any);
	ctx.provide("subprocess", {} as any);
	ctx.provide("shellEnv", {} as any);
	ctx.provide("fs", {} as any);
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
