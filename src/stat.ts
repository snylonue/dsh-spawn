/** Independently configurable `stat` tool plugin. */
import { stat as hostStat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
	defineTool,
	type ToolDefinition,
	type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-fs";

/** The `stat` value. */
interface StatValue {
	path: string;
	exists: boolean;
	type?: string;
	size?: number;
	mtimeMs?: number;
}

interface PathArgs {
	path: string;
}

/**
 * Host-side `mtimeMs` for a resolved target, used only as an enrichment: the
 * filesystem service's own metadata has no timestamp, and a backend whose
 * process path is not a local absolute path simply reports none.
 */
async function hostMtime(
	processPath: string | undefined,
): Promise<number | undefined> {
	if (typeof processPath !== "string" || !isAbsolute(processPath))
		return undefined;
	try {
		const info = await hostStat(processPath);
		return typeof info.mtimeMs === "number" ? info.mtimeMs : undefined;
	} catch {
		return undefined;
	}
}

function statTool(ctx: Context): ToolDefinition {
	return defineTool({
		name: "stat",
		description:
			"Return metadata for one path: existence, type, byte size, and mtime when available.",
		parameters: {
			path: {
				type: "string",
				required: true,
				description:
					"Path to inspect; a relative path resolves against the session workspace.",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string", required: true },
					exists: { type: "boolean", required: true },
					type: { type: "string" },
					size: { type: "number" },
					mtimeMs: { type: "number" },
				},
			},
			render: (_args: PathArgs, value: StatValue) =>
				value.exists
					? [
							{
								type: "text",
								text: `${value.path}: ${value.type}${value.size !== undefined ? `, ${value.size} bytes` : ""}${value.mtimeMs !== undefined ? `, modified ${new Date(value.mtimeMs).toISOString()}` : ""}`,
							},
						]
					: [{ type: "text", text: `${value.path}: (absent)` }],
		},
		isConcurrencySafe: () => true,
		async execute(args: PathArgs, spawn: ToolRunContext) {
			const cwd = spawn.agent?.session.header.cwd;
			const target = await ctx.fs.resolve(args.path, {
				...(cwd !== undefined ? { cwd } : {}),
				signal: spawn.signal,
			});
			const info = await ctx.fs.stat(target, spawn.signal);
			if (info === undefined)
				return { path: target.displayPath, exists: false };
			const mtimeMs = await hostMtime(ctx.fs.processPath(target));
			return {
				path: target.displayPath,
				exists: true,
				type: info.type,
				...(info.size !== undefined ? { size: info.size } : {}),
				...(mtimeMs !== undefined ? { mtimeMs } : {}),
			};
		},
	});
}

export const name = "tool-stat";
export const inject = ["tools", "fs"];

export function apply(ctx: Context): void {
	ctx.tools.register(statTool(ctx));
}
