/** Independently configurable `list_dir` tool plugin. */
import type { Context } from "@deepseek-ai/cordis";
import {
	defineTool,
	type ToolDefinition,
	type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-fs";

/** The `list_dir` value. */
interface ListDirEntry {
	path: string;
	type: string;
	size?: number;
}
interface ListDirValue {
	path: string;
	entries: ListDirEntry[];
	truncated: boolean;
}

/** The one path/name argument the query tools take. */
interface PathArgs {
	path: string;
	depth?: number;
}

const LIST_DIR_MAX_ENTRIES = 2000;
const LIST_DIR_MAX_DEPTH = 3;

function listDirTool(ctx: Context): ToolDefinition {
	return defineTool({
		name: "list_dir",
		description: `List a directory's entries, one level deep by default; \`depth\` recurses up to ${LIST_DIR_MAX_DEPTH} levels. Results stop at ${LIST_DIR_MAX_ENTRIES} entries and report \`truncated\`.`,
		parameters: {
			path: {
				type: "string",
				required: true,
				description:
					"Directory to list; a relative path resolves against the session workspace.",
			},
			depth: {
				type: "integer",
				description: `Directory levels to walk (1..${LIST_DIR_MAX_DEPTH}); defaults to 1.`,
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string", required: true },
					entries: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								path: { type: "string", required: true },
								type: { type: "string", required: true },
								size: { type: "number" },
							},
						},
					},
					truncated: { type: "boolean", required: true },
				},
			},
			render: (_args: PathArgs, value: ListDirValue) => [
				{
					type: "text",
					text:
						value.entries.length === 0
							? `${value.path}: (empty)`
							: `${value.path}:\n${value.entries
									.map(
										(entry) =>
											`${entry.type === "directory" ? "dir " : "file"} ${entry.path}${entry.size !== undefined ? ` (${entry.size} bytes)` : ""}`,
									)
									.join(
										"\n",
									)}${value.truncated ? "\n[listing truncated]" : ""}`,
				},
			],
		},
		isConcurrencySafe: () => true,
		async execute(args: PathArgs, spawn: ToolRunContext) {
			const cwd = spawn.agent?.session.header.cwd;
			const root = await ctx.fs.resolve(args.path, {
				...(cwd !== undefined ? { cwd } : {}),
				signal: spawn.signal,
			});
			const depth = Math.max(1, Math.min(LIST_DIR_MAX_DEPTH, args.depth ?? 1));
			const entries = [];
			let truncated = false;
			let level = [{ target: root, depth: 1 }];
			while (level.length > 0 && !truncated) {
				const next = [];
				for (const item of level) {
					const children = await ctx.fs.listDir(item.target, spawn.signal);
					for (const child of children) {
						if (entries.length >= LIST_DIR_MAX_ENTRIES) {
							truncated = true;
							break;
						}
						entries.push({
							path: child.target.displayPath,
							type: child.type,
							...(child.size !== undefined ? { size: child.size } : {}),
						});
						if (item.depth < depth && child.type === "directory") {
							next.push({ target: child.target, depth: item.depth + 1 });
						}
					}
					if (truncated) break;
				}
				level = next;
			}
			return { path: root.displayPath, entries, truncated };
		},
	});
}

export const name = "tool-list-dir";
export const inject = ["tools", "fs"];

export function apply(ctx: Context): void {
	ctx.tools.register(listDirTool(ctx));
}
