/** Independently configurable `list_dir` tool plugin. */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-fs";
import {
	defineTool,
	type ToolDefinition,
	type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-working-directory";
import {
	ancestorIgnoreState,
	descendIgnoreScopes,
	directoryIgnoreState,
	type IgnoreState,
	matchIgnoreRules,
} from "./gitignore.js";

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

/** Directory query options. */
interface PathArgs {
	path: string;
	depth?: number;
	ignore?: boolean;
	hidden?: boolean;
}

const LIST_DIR_MAX_ENTRIES = 2000;
const LIST_DIR_MAX_DEPTH = 3;

function listDirTool(ctx: Context): ToolDefinition {
	return defineTool({
		name: "list_dir",
		description: `List a directory's entries, one level deep by default; \`depth\` recurses up to ${LIST_DIR_MAX_DEPTH} levels. Results stop at ${LIST_DIR_MAX_ENTRIES} entries and report \`truncated\`.`,
		parameters: {
			ignore: {
				type: "boolean",
				description:
					"Apply .gitignore, .ignore, .rgignore and repository exclude rules, and skip symbolic links. Defaults to true. Hidden entries are controlled separately by hidden.",
			},
			hidden: {
				type: "boolean",
				description:
					"Include hidden files and directories; defaults to false. Ignore rules still apply. Explicit ignore-file whitelists can include hidden entries even when false.",
			},
			path: {
				type: "string",
				required: true,
				description:
					"Directory to list; a relative path resolves against the current session directory.",
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
			const cwd =
				spawn.agent === undefined
					? undefined
					: await ctx.workingDirectory.ensure(spawn.agent, spawn.signal);
			const root = await ctx.fs.resolve(args.path, {
				...(cwd !== undefined ? { cwd } : {}),
				signal: spawn.signal,
			});
			const depth = Math.max(1, Math.min(LIST_DIR_MAX_DEPTH, args.depth ?? 1));
			const entries: ListDirEntry[] = [];
			let truncated = false;
			const applyIgnore = args.ignore ?? true;
			const includeHidden = args.hidden ?? false;
			const state: IgnoreState = applyIgnore
				? await ancestorIgnoreState(ctx.fs, root, spawn.signal)
				: { scopes: [], inRepository: false };
			let level = [{ target: root, depth: 1, state }];
			while (level.length > 0 && !truncated) {
				const next = [];
				for (const item of level) {
					spawn.signal.throwIfAborted();
					const children = await ctx.fs.listDir(item.target, spawn.signal);
					const directory = applyIgnore ? ctx.fs.processPath(item.target) : "";
					const state = applyIgnore
						? await directoryIgnoreState(
								ctx.fs,
								directory,
								item.state,
								spawn.signal,
							)
						: item.state;
					for (const child of children) {
						const ignored = applyIgnore
							? matchIgnoreRules(
									state.scopes,
									child.name,
									child.type === "directory",
								)
							: undefined;
						if (ignored === true) continue;
						// Preserve rg-style explicit whitelists without coupling the two flags.
						if (
							!includeHidden &&
							ignored !== false &&
							child.name.startsWith(".")
						)
							continue;
						if (applyIgnore) {
							// listDir targets follow links; probe the original entry, not its target.
							const info = await ctx.fs.lstat(
								child.name,
								{ cwd: directory },
								spawn.signal,
							);
							if (info?.type === "symlink") continue;
						}
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
							next.push({
								target: child.target,
								depth: item.depth + 1,
								state: {
									scopes: descendIgnoreScopes(state.scopes, child.name),
									inRepository: state.inRepository,
								},
							});
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
export const inject = ["tools", "fs", "workingDirectory"];

export function apply(ctx: Context): void {
	ctx.tools.register(listDirTool(ctx));
}
