/** Project-level ripgrep-style filters over ctx.fs; npm ignore owns glob parsing.
 * Reference: BurntSushi/ripgrep crates/ignore/src/{dir,walk}.rs.
 * Keep all I/O on the host filesystem service, including worktree metadata.
 */
import { posix, win32 } from "node:path";
import type { FileSystem, FsTarget } from "@deepseek-ai/dsh-fs";
import ignore, { type Ignore } from "ignore";

export interface IgnoreScope {
	matcher: Ignore;
	/** Slash-separated path from this rule file's base to the current directory. */
	prefix: string;
	/** info/exclude < .gitignore < .ignore < .rgignore, regardless of depth. */
	priority: number;
}

export interface IgnoreState {
	scopes: IgnoreScope[];
	inRepository: boolean;
}

function executionPaths(path: string) {
	return win32.isAbsolute(path) && !posix.isAbsolute(path) ? win32 : posix;
}

/** Ignore absent and symlinked rule files, but propagate other I/O failures. */
async function readOptionalText(
	fs: FileSystem,
	directory: string,
	name: string,
	signal: AbortSignal,
): Promise<string | undefined> {
	const info = await fs.lstat(name, { cwd: directory }, signal);
	if (info?.type !== "file") return undefined;
	const target = await fs.resolve(name, { cwd: directory, signal });
	return fs.readText(target, signal);
}

async function readIgnoreScope(
	fs: FileSystem,
	directory: string,
	name: string,
	priority: number,
	signal: AbortSignal,
): Promise<IgnoreScope | undefined> {
	const text = await readOptionalText(fs, directory, name, signal);
	return text === undefined
		? undefined
		: {
				matcher: ignore({ ignorecase: false }).add(text),
				prefix: "",
				priority,
			};
}

/** Match rules only: true = ignored, false = whitelisted, undefined = no match.
 * Keep the whitelist distinction so callers can apply hidden filtering separately.
 */
export function matchIgnoreRules(
	scopes: readonly IgnoreScope[],
	name: string,
	isDirectory: boolean,
): boolean | undefined {
	let ignored: boolean | undefined;
	let priority = -1;
	for (const scope of scopes) {
		if (scope.priority < priority) continue;
		const result = scope.matcher.test(
			scope.prefix + name + (isDirectory ? "/" : ""),
		);
		if (result.ignored || result.unignored) {
			ignored = result.ignored;
			priority = scope.priority;
		}
	}
	return ignored;
}

/** Carry rules into a visible directory without changing sibling branches. */
export function descendIgnoreScopes(
	scopes: readonly IgnoreScope[],
	name: string,
): IgnoreScope[] {
	return scopes.map((scope) => {
		let { matcher } = scope;
		const path = `${scope.prefix}${name}/`;
		// Higher-priority rules or an explicit starting path can re-include a
		// directory. Clear the older matcher's implicit parent exclusion only;
		// its rules that directly match children must still apply.
		if (matcher.test(path).ignored) {
			const literal = path.replace(/[\\*?[\]#! ]/g, "\\$&");
			matcher = ignore({ ignorecase: false })
				.add(matcher)
				.add({ pattern: `!/${literal}` });
		}
		return { ...scope, matcher, prefix: path };
	});
}

/** Resolve info/exclude for normal repositories, submodules and worktrees. */
async function readRepositoryExclude(
	fs: FileSystem,
	directory: string,
	gitType: string,
	signal: AbortSignal,
): Promise<IgnoreScope | undefined> {
	const paths = executionPaths(directory);
	let gitDirectory = paths.join(directory, ".git");
	if (gitType === "file") {
		const marker = await readOptionalText(fs, directory, ".git", signal);
		if (!marker?.startsWith("gitdir:")) return undefined;
		const value = marker.slice("gitdir:".length).trim();
		if (!value) return undefined;
		gitDirectory = paths.resolve(directory, value);
	} else if (gitType !== "directory") {
		return undefined;
	}
	const commonDirectory = await readOptionalText(
		fs,
		gitDirectory,
		"commondir",
		signal,
	);
	if (commonDirectory?.trim()) {
		gitDirectory = paths.resolve(gitDirectory, commonDirectory.trim());
	}
	// The patterns are relative to the repository root, not to info/.
	return readIgnoreScope(fs, gitDirectory, "info/exclude", 0, signal);
}

/** Load each kind of ignore file with rg's source-type precedence. */
export async function directoryIgnoreState(
	fs: FileSystem,
	directory: string,
	inherited: IgnoreState,
	signal: AbortSignal,
): Promise<IgnoreState> {
	signal.throwIfAborted();
	const git = await fs.lstat(".git", { cwd: directory }, signal);
	const repository = git ?? (await fs.lstat(".jj", { cwd: directory }, signal));
	const state: IgnoreState = {
		scopes: repository
			? inherited.scopes.filter((scope) => scope.priority >= 2)
			: [...inherited.scopes],
		inRepository: inherited.inRepository || repository !== undefined,
	};
	if (git) {
		const scope = await readRepositoryExclude(fs, directory, git.type, signal);
		if (scope) state.scopes.push(scope);
	}
	const files = state.inRepository
		? ([
				[".gitignore", 1],
				[".ignore", 2],
				[".rgignore", 3],
			] as const)
		: ([
				[".ignore", 2],
				[".rgignore", 3],
			] as const);
	for (const [name, priority] of files) {
		const scope = await readIgnoreScope(fs, directory, name, priority, signal);
		if (scope) state.scopes.push(scope);
	}
	return state;
}

/** Parent .ignore/.rgignore files cross repo boundaries; Git rules do not.
 * Explicit starting directories are traversed even if hidden or ignored.
 */
export async function ancestorIgnoreState(
	fs: FileSystem,
	root: FsTarget,
	signal: AbortSignal,
): Promise<IgnoreState> {
	const rootPath = fs.processPath(root);
	const paths = executionPaths(rootPath);
	const ancestors = [rootPath];
	let current = rootPath;
	while (true) {
		signal.throwIfAborted();
		const parent = paths.dirname(current);
		if (parent === current) break;
		ancestors.unshift(parent);
		current = parent;
	}
	let state: IgnoreState = { scopes: [], inRepository: false };
	for (const [index, directory] of ancestors.entries()) {
		const child = ancestors[index + 1];
		if (child === undefined) break;
		state = await directoryIgnoreState(fs, directory, state, signal);
		state.scopes = descendIgnoreScopes(state.scopes, paths.basename(child));
	}
	return state;
}
