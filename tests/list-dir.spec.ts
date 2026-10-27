import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { FsError, FsTargetKey, type FsTarget } from "@deepseek-ai/dsh-fs";
import * as listDirPlugin from "@snylonue/dsh-spawn/list-dir";
import { describe, expect, it, vi } from "vitest";

/** Opaque keys and non-path display strings catch accidental target parsing. */
function setup(files: Record<string, string | null>, windows = false) {
	const paths = windows ? win32 : posix;
	const nodes = new Map(
		Object.entries(files).map(
			([path, content]) => [paths.normalize(path), content] as const,
		),
	);
	for (const path of [...nodes.keys()]) {
		let parent = paths.dirname(path);
		while (!nodes.has(parent)) {
			nodes.set(parent, null);
			const next = paths.dirname(parent);
			if (next === parent) break;
			parent = next;
		}
	}
	const targets = new Map<string, string>();
	const target = (path: string): FsTarget => {
		const key = "opaque:" + path;
		targets.set(key, path);
		return { targetKey: FsTargetKey(key), displayPath: "shown:" + path };
	};
	const processPath = (value: FsTarget) => targets.get(value.targetKey)!;
	const fs = {
		processPath,
		resolve: vi.fn(async (path: string, opts?: { cwd?: string }) =>
			target(paths.resolve(opts?.cwd ?? (windows ? "C:/repo" : "/repo"), path)),
		),
		lstat: vi.fn(async (path: string, opts: { cwd?: string }) => {
			const full = paths.resolve(opts.cwd!, path);
			return nodes.has(full)
				? { type: nodes.get(full) === null ? "directory" : "file" }
				: undefined;
		}),
		readText: vi.fn(async (value: FsTarget) => {
			const content = nodes.get(processPath(value));
			if (typeof content !== "string") throw new Error("not a text file");
			return content;
		}),
		listDir: vi.fn(async (value: FsTarget) => {
			const parent = processPath(value);
			if (!nodes.has(parent))
				throw new FsError("missing directory", "FS_NOT_FOUND");
			if (nodes.get(parent) !== null)
				throw new FsError("not a directory", "FS_NOT_DIRECTORY");
			return [...nodes.entries()]
				.filter(([path]) => path !== parent && paths.dirname(path) === parent)
				.map(([path, content]) => ({
					name: paths.basename(path),
					target: target(path),
					type: content === null ? "directory" : "file",
					...(content !== null ? { size: content.length } : {}),
				}));
		}),
	};
	let tool: any;
	listDirPlugin.apply({
		fs,
		tools: {
			register: (definition: any) => {
				tool = definition;
			},
		},
	} as any);
	const signal = new AbortController().signal;
	const run = (args: Record<string, unknown> = {}) =>
		tool.execute({ path: ".", ...args }, { signal });
	const listed = () =>
		fs.listDir.mock.calls.map(([value]) => processPath(value));
	return { fs, run, listed, signal };
}

const names = (value: any): string[] =>
	value.entries.map((entry: any) => entry.path.slice("shown:".length));

describe("list_dir rg-style filtering", () => {
	it.each([
		{ label: "defaults", args: {}, ignore: true, hidden: false },
		{
			label: "default ignore",
			args: { hidden: true },
			ignore: true,
			hidden: true,
		},
		{
			label: "default hidden",
			args: { ignore: false },
			ignore: false,
			hidden: false,
		},
		{
			label: "true/false",
			args: { ignore: true, hidden: false },
			ignore: true,
			hidden: false,
		},
		{
			label: "true/true",
			args: { ignore: true, hidden: true },
			ignore: true,
			hidden: true,
		},
		{
			label: "false/false",
			args: { ignore: false, hidden: false },
			ignore: false,
			hidden: false,
		},
		{
			label: "false/true",
			args: { ignore: false, hidden: true },
			ignore: false,
			hidden: true,
		},
	])(
		"keeps ignore and hidden independent ($label)",
		async ({ args, ignore, hidden }) => {
			const { run, fs, listed } = setup({
				"/repo/.ignore":
					"ignored.txt\n.hidden-ignored\nignored-dir/\n.hidden-ignored-dir/\n",
				"/repo/visible.txt": "",
				"/repo/ignored.txt": "",
				"/repo/.hidden": "",
				"/repo/.hidden-ignored": "",
				"/repo/visible-dir/inside": "",
				"/repo/ignored-dir/inside": "",
				"/repo/.hidden-dir/inside": "",
				"/repo/.hidden-ignored-dir/inside": "",
			});
			const paths = names(await run({ depth: 3, ...args }));
			expect(paths).toContain("/repo/visible.txt");
			expect(paths).toContain("/repo/visible-dir/inside");
			expect(paths.includes("/repo/ignored.txt")).toBe(!ignore);
			expect(paths.includes("/repo/.hidden")).toBe(hidden);
			expect(paths.includes("/repo/.hidden-ignored")).toBe(hidden && !ignore);
			expect(paths.includes("/repo/.ignore")).toBe(hidden);
			for (const [directory, visible] of [
				["ignored-dir", !ignore],
				[".hidden-dir", hidden],
				[".hidden-ignored-dir", hidden && !ignore],
			] as const) {
				expect(paths.includes("/repo/" + directory)).toBe(visible);
				expect(paths.includes("/repo/" + directory + "/inside")).toBe(visible);
				expect(listed().includes("/repo/" + directory)).toBe(visible);
			}
			if (!ignore) {
				expect(fs.readText).not.toHaveBeenCalled();
				expect(fs.lstat).not.toHaveBeenCalled();
			}
		},
	);

	it("does not read hidden whitelists when ignore is disabled", async () => {
		const { run, fs } = setup({
			"/repo/.ignore": "!.env\n",
			"/repo/.env": "",
			"/repo/visible": "",
		});
		expect(names(await run({ ignore: false }))).toEqual(["/repo/visible"]);
		expect(fs.readText).not.toHaveBeenCalled();
		expect(names(await run({ ignore: false, hidden: true }))).toContain(
			"/repo/.env",
		);
		expect(fs.readText).not.toHaveBeenCalled();
	});

	it("prunes hidden directories and excludes hidden entries from the result cap even without ignore rules", async () => {
		const files: Record<string, string | null> = {
			"/repo/.cache/.ignore": "*",
			"/repo/.cache/inside": "",
		};
		for (let index = 0; index < 2100; index++)
			files["/repo/.hidden-" + index] = "";
		files["/repo/visible"] = "";
		const { run, fs, listed } = setup(files);
		const result = await run({ ignore: false, depth: 3 });
		expect(names(result)).toEqual(["/repo/visible"]);
		expect(result.truncated).toBe(false);
		expect(listed()).toEqual(["/repo"]);
		expect(fs.readText).not.toHaveBeenCalled();
		const all = await run({ ignore: false, hidden: true });
		expect(all.entries).toHaveLength(2000);
		expect(all.truncated).toBe(true);
	});

	it.each([null, "gitdir: elsewhere"])(
		"prunes hidden entries, including .git (%s), by default",
		async (marker) => {
			const { run, listed } = setup({
				"/repo/.git": marker,
				"/repo/.git/config": "",
				"/repo/.env": "secret",
				"/repo/.cache/file": "",
				"/repo/src/.secret/file": "",
				"/repo/src/visible": "",
				"/repo/empty": null,
			});
			expect(names(await run({ depth: 3 }))).toEqual([
				"/repo/empty",
				"/repo/src",
				"/repo/src/visible",
			]);
			expect(listed()).toEqual(["/repo", "/repo/empty", "/repo/src"]);
			expect(
				names(await run({ depth: 3, ignore: false, hidden: true })),
			).toContain("/repo/.cache/file");
		},
	);

	it("honors explicit whitelists before hidden filtering without unhiding descendants", async () => {
		const { run, listed } = setup({
			"/repo/.ignore": "!.env\n!.cache/\n",
			"/repo/.env": "",
			"/repo/.secret": "",
			"/repo/.cache/visible": "",
			"/repo/.cache/.secret": "",
			"/repo/.git/config": "",
		});
		expect(names(await run({ depth: 3 }))).toEqual([
			"/repo/.env",
			"/repo/.cache",
			"/repo/.cache/visible",
		]);
		expect(listed()).not.toContain("/repo/.git");
	});

	it("uses source priority before depth, and depth within a source", async () => {
		const { run } = setup({
			"/repo/.git": null,
			"/repo/.git/info/exclude": "*.txt\n",
			"/repo/.gitignore": "!git.txt\n*.log\n",
			"/repo/.ignore": "!src/ignore.log\n",
			"/repo/.rgignore": "src/blocked.txt\n",
			"/repo/src/.gitignore": "ignore.log\n!blocked.txt\n",
			"/repo/src/.ignore": "!blocked.txt\n!local.txt\n",
			"/repo/git.txt": "",
			"/repo/excluded.txt": "",
			"/repo/src/ignore.log": "",
			"/repo/src/blocked.txt": "",
			"/repo/src/local.txt": "",
		});
		expect(names(await run({ depth: 2 }))).toEqual([
			"/repo/git.txt",
			"/repo/src",
			"/repo/src/ignore.log",
			"/repo/src/local.txt",
		]);
	});

	it("only applies Git rules in repositories; .ignore and .rgignore also work outside them", async () => {
		const { run, fs } = setup({
			"/repo/.gitignore": "*.log",
			"/repo/.ignore": "*.tmp",
			"/repo/.rgignore": "!keep.tmp",
			"/repo/visible.log": "",
			"/repo/drop.tmp": "",
			"/repo/keep.tmp": "",
		});
		expect(names(await run())).toEqual(["/repo/visible.log", "/repo/keep.tmp"]);
		expect(
			fs.readText.mock.calls.some(([target]) =>
				fs.processPath(target).endsWith(".gitignore"),
			),
		).toBe(false);
	});

	it("resolves worktree commondir excludes relative to the working tree", async () => {
		const { run } = setup({
			"/repo/.git": "gitdir: ../store/worktrees/topic\n",
			"/store/worktrees/topic/commondir": "../..\n",
			"/store/info/exclude": "*.log\n/root.txt\n",
			"/repo/drop.log": "",
			"/repo/root.txt": "",
			"/repo/src/root.txt": "",
		});
		expect(names(await run({ depth: 2 }))).toEqual([
			"/repo/src",
			"/repo/src/root.txt",
		]);
	});

	it("does not follow listed symbolic links, including directory links", async () => {
		const { run, fs, listed } = setup({
			"/repo/link/file": "",
			"/repo/file-link": "",
			"/repo/visible": "",
		});
		const lstat = fs.lstat.getMockImplementation()!;
		fs.lstat.mockImplementation(async (path, opts) =>
			path === "link" || path === "file-link"
				? { type: "symlink" }
				: lstat(path, opts),
		);
		expect(names(await run({ depth: 3 }))).toEqual(["/repo/visible"]);
		expect(listed()).toEqual(["/repo"]);
		expect(names(await run({ depth: 3, ignore: false }))).toContain(
			"/repo/link/file",
		);
	});

	it("applies root rules by default, with negation, anchoring and case sensitivity", async () => {
		const { run } = setup({
			"/repo/.git": "gitdir: elsewhere",
			"/repo/.gitignore": "*.log\n!keep.log\n/root.txt\ncache/\n",
			"/repo/drop.log": "",
			"/repo/keep.log": "kept",
			"/repo/UPPER.LOG": "",
			"/repo/root.txt": "",
			"/repo/src/root.txt": "",
			"/repo/src/drop.log": "",
			"/repo/cache/file": "",
		});
		const value = await run({ depth: 3 });
		expect(names(value)).toEqual(
			expect.arrayContaining([
				"/repo/keep.log",
				"/repo/UPPER.LOG",
				"/repo/src/root.txt",
			]),
		);
		expect(names(value)).not.toEqual(
			expect.arrayContaining(["/repo/drop.log"]),
		);
		expect(names(value)).not.toContain("/repo/root.txt");
		expect(names(value)).not.toContain("/repo/src/drop.log");
		expect(names(value)).not.toContain("/repo/cache");
		expect(
			value.entries.find((entry: any) => entry.path === "shown:/repo/keep.log")
				.size,
		).toBe(4);
		expect(value.truncated).toBe(false);
	});

	it("uses nested rules without leaking them to siblings", async () => {
		const { run } = setup({
			"/repo/.git": null,
			"/repo/.gitignore": "*.log\n",
			"/repo/a/.gitignore": "!keep.log\n/local.txt\n",
			"/repo/a/keep.log": "",
			"/repo/a/drop.log": "",
			"/repo/a/local.txt": "",
			"/repo/b/keep.log": "",
			"/repo/b/local.txt": "",
		});
		const paths = names(await run({ depth: 2 }));
		expect(paths).toContain("/repo/a/keep.log");
		expect(paths).toContain("/repo/b/local.txt");
		for (const path of [
			"/repo/a/drop.log",
			"/repo/a/local.txt",
			"/repo/b/keep.log",
		])
			expect(paths).not.toContain(path);
	});

	it.each([null, "gitdir: worktree"])(
		"inherits ancestor rules when listing a subdirectory, stopping at a .git boundary (%s)",
		async (marker) => {
			const { run, fs } = setup({
				"/.gitignore": "*.txt\n",
				"/repo/.git": marker,
				"/repo/.gitignore": "*.log\n",
				"/repo/src/.gitignore": "!keep.log\n",
				"/repo/src/keep.log": "",
				"/repo/src/drop.log": "",
				"/repo/src/keep.txt": "",
			});
			const paths = names(await run({ path: "src" }));
			expect(paths).toContain("/repo/src/keep.log");
			expect(paths).toContain("/repo/src/keep.txt");
			expect(paths).not.toContain("/repo/src/drop.log");
			expect(
				fs.readText.mock.calls.some(
					([target]) => fs.processPath(target) === "/.gitignore",
				),
			).toBe(false);
		},
	);

	it("prunes ignored directories before listing or reading their rules", async () => {
		const { run, listed, fs } = setup({
			"/repo/.git": null,
			"/repo/.gitignore": "build/\n!build/keep.txt\n",
			"/repo/build/.gitignore": "!keep.txt\n",
			"/repo/build/keep.txt": "",
		});
		expect(names(await run({ depth: 3 }))).not.toContain("/repo/build");
		expect(listed()).toEqual(["/repo"]);
		expect(fs.readText).toHaveBeenCalledTimes(1);
		// rg traverses explicitly requested directories, even if normally ignored.
		expect(names(await run({ path: "build" }))).toContain(
			"/repo/build/keep.txt",
		);
		expect(listed()).toEqual(["/repo", "/repo/build"]);
	});

	it.each(["keep", "[keep]", "keep "])(
		"preserves children of a directory re-included by a deeper rule file: %s",
		async (name) => {
			const { run } = setup({
				"/repo/.git": null,
				"/repo/.gitignore": "src/*\n*.log\n",
				"/repo/src/.gitignore": "!*/\n",
				["/repo/src/" + name + "/inside.txt"]: "",
				["/repo/src/" + name + "/drop.log"]: "",
				"/repo/src/hidden.txt": "",
			});
			const paths = names(await run({ depth: 3 }));
			expect(paths).toContain("/repo/src/" + name + "/inside.txt");
			expect(paths).not.toContain("/repo/src/" + name + "/drop.log");
			expect(paths).not.toContain("/repo/src/hidden.txt");
		},
	);

	it("can include ignored entries without reading any ignore files", async () => {
		const { run, fs } = setup({
			"/repo/.gitignore": "build/\n",
			"/repo/build/file": "",
		});
		expect(names(await run({ depth: 2, ignore: false }))).toContain(
			"/repo/build/file",
		);
		expect(fs.lstat).not.toHaveBeenCalled();
		expect(fs.readText).not.toHaveBeenCalled();
	});

	it("does not spend the result limit on ignored entries", async () => {
		const files: Record<string, string | null> = {
			"/repo/.git": null,
			"/repo/.gitignore": "*.tmp\n",
		};
		for (let index = 0; index < 2200; index++)
			files["/repo/" + index + ".tmp"] = "";
		files["/repo/keep.txt"] = "";
		const { run } = setup(files);
		const result = await run();
		expect(names(result)).toEqual(["/repo/keep.txt"]);
		expect(result.truncated).toBe(false);
		expect((await run({ ignore: false })).truncated).toBe(true);
	});

	it.each([false, true])(
		"only reports truncation for additional visible entries (%s)",
		async (extra) => {
			const files: Record<string, string | null> = {
				"/repo/.git": null,
				"/repo/.gitignore": "*.tmp\n",
			};
			for (let index = 0; index < 2000; index++)
				files["/repo/" + index + ".txt"] = "";
			files["/repo/last.tmp"] = "";
			if (extra) files["/repo/extra.txt"] = "";
			const { run } = setup(files);
			const result = await run();
			expect(result.entries).toHaveLength(2000);
			expect(result.truncated).toBe(extra);
		},
	);

	it("does not follow .gitignore symlinks", async () => {
		const { run, fs } = setup({
			"/repo/.git": null,
			"/repo/.gitignore": "*",
			"/repo/keep": "",
		});
		const lstat = fs.lstat.getMockImplementation()!;
		fs.lstat.mockImplementation(async (path, opts) =>
			path === ".gitignore" ? { type: "symlink" } : lstat(path, opts),
		);
		expect(names(await run())).toContain("/repo/keep");
		expect(fs.readText).not.toHaveBeenCalled();
	});

	it("propagates rule read errors rather than silently disabling filtering", async () => {
		const { run, fs } = setup({ "/repo/.git": null, "/repo/.gitignore": "*" });
		const error = new FsError("denied", "FS_PERMISSION_DENIED");
		fs.readText.mockRejectedValue(error);
		await expect(run()).rejects.toBe(error);
	});

	it("honors cancellation", async () => {
		const { run, signal, fs } = setup({ "/repo/.git": "" });
		vi.spyOn(signal, "throwIfAborted").mockImplementation(() => {
			throw new Error("cancelled");
		});
		await expect(run()).rejects.toThrow("cancelled");
		expect(fs.listDir).not.toHaveBeenCalled();
	});

	it("supports ancestor rules in a Windows execution world", async () => {
		const { run } = setup(
			{
				"C:/repo/.git": "",
				"C:/repo/.gitignore": "*.log",
				"C:/repo/src/drop.log": "",
				"C:/repo/src/keep.txt": "",
			},
			true,
		);
		const paths = names(await run({ path: "src" }));
		expect(paths).toContain(win32.normalize("C:/repo/src/keep.txt"));
		expect(paths).not.toContain(win32.normalize("C:/repo/src/drop.log"));
	});

	it("inherits rules outside repositories and reloads them for each call", async () => {
		const { run, fs } = setup({
			"/parent/.ignore": "*.log",
			"/parent/project/drop.log": "",
			"/parent/project/keep.txt": "",
		});
		expect(names(await run({ path: "/parent/project" }))).toEqual([
			"/parent/project/keep.txt",
		]);
		fs.readText.mockResolvedValue("*.txt");
		expect(names(await run({ path: "/parent/project" }))).toEqual([
			"/parent/project/drop.log",
		]);
	});

	it.each(["missing", "file"])(
		"still rejects a %s directory target",
		async (path) => {
			const { run } = setup({ "/repo/.git": "", "/repo/file": "" });
			await expect(run({ path })).rejects.toMatchObject({
				code: path === "missing" ? "FS_NOT_FOUND" : "FS_NOT_DIRECTORY",
			});
		},
	);

	it("keeps the default depth of one and clamps recursion to three", async () => {
		const { run } = setup({ "/repo/.git": "", "/repo/a/b/c/d/file": "" });
		expect(names(await run())).toContain("/repo/a");
		expect(names(await run())).not.toContain("/repo/a/b");
		expect(names(await run({ depth: 99 }))).toContain("/repo/a/b/c");
		expect(names(await run({ depth: 99 }))).not.toContain("/repo/a/b/c/d");
	});
});

/** Differential checks against the actual rg binary; no content-search/binary
 * filtering, global Git configuration, or per-user rg configuration is involved.
 */
const rgAvailable = spawnSync("rg", ["--version"]).status === 0;
const rgCases: {
	name: string;
	start?: string;
	files: Record<string, string | null>;
}[] = [
	{
		name: "hidden entries and scoped Git patterns",
		files: {
			".git": null,
			".git/config": "",
			".env": "",
			".cache/file": "",
			".gitignore": "*.log\n!keep.log\n",
			"keep.log": "",
			"drop.log": "",
			"src/visible": "",
			"src/.secret": "",
			empty: null,
		},
	},
	{
		name: "source priority dominates depth",
		files: {
			".git": null,
			".git/info/exclude": "*.txt\n",
			".gitignore": "!git.txt\n*.log\n",
			".ignore": "!src/ignore.log\n",
			".rgignore": "src/blocked.txt\n",
			"src/.gitignore": "ignore.log\n!blocked.txt\n",
			"src/.ignore": "!blocked.txt\n!local.txt\n",
			"git.txt": "",
			"excluded.txt": "",
			"src/ignore.log": "",
			"src/blocked.txt": "",
			"src/local.txt": "",
		},
	},
	{
		name: "non-repository ignore rules",
		files: {
			".gitignore": "*.log\n",
			".ignore": "*.tmp\n",
			".rgignore": "!keep.tmp\n",
			"visible.log": "",
			"drop.tmp": "",
			"keep.tmp": "",
		},
	},
	{
		name: "hidden whitelists and reopened parent exclusions",
		files: {
			".git": null,
			".gitignore": "build/\n*.log\n",
			".ignore": "!build/\n!.env\n!.cache/\n",
			".env": "",
			".cache/visible": "",
			".cache/.secret": "",
			"build/keep.txt": "",
			"build/drop.log": "",
			"build/.secret": "",
		},
	},
	{
		name: "same-source deeper rules reopen escaped directory names",
		files: {
			".git": null,
			".gitignore": "src/*\n*.log\n",
			"src/.gitignore": "!*/\n",
			"src/[keep]/inside.txt": "",
			"src/[keep]/drop.log": "",
			"src/keep /inside.txt": "",
			"src/keep /drop.log": "",
			"src/hidden.txt": "",
		},
	},
	{
		name: "explicit ignored starting directory",
		start: "build",
		files: {
			".git": null,
			".gitignore": "build/\n*.log\n",
			"build/keep.txt": "",
			"build/drop.log": "",
			"build/.secret": "",
		},
	},
	{
		name: "explicit hidden starting directory",
		start: ".cache",
		files: { ".cache/visible": "", ".cache/.secret": "" },
	},
	{
		name: "nested repositories reset Git rules but retain .ignore rules",
		files: {
			".git": null,
			".gitignore": "*.log\n",
			".ignore": "*.tmp\n",
			"nested/.git": null,
			"nested/keep.log": "",
			"nested/drop.tmp": "",
			"drop.log": "",
		},
	},
	{
		name: "parent .ignore files cross repository boundaries",
		start: "project",
		files: {
			".ignore": "*.tmp\n",
			".gitignore": "*.log\n",
			"project/.git": null,
			"project/keep.log": "",
			"project/drop.tmp": "",
		},
	},
	{
		name: "worktree shared info/exclude",
		files: {
			".git": "gitdir: .store/worktrees/topic\n",
			".store/worktrees/topic/commondir": "../..\n",
			".store/info/exclude": "*.log\n/root.txt\n",
			"drop.log": "",
			"root.txt": "",
			"src/root.txt": "",
			"keep.txt": "",
		},
	},
];

const rgCombinations = rgCases.flatMap((fixture) =>
	[true, false].flatMap((ignore) =>
		[false, true].map((hidden) => ({ ...fixture, ignore, hidden })),
	),
);

it.skipIf(!rgAvailable).each(rgCombinations)(
	"matches rg --files: $name (ignore=$ignore, hidden=$hidden)",
	async ({ files, start, ignore, hidden }) => {
		const root = await realpath(
			await mkdtemp(join(tmpdir(), "dsh-list-dir-rg-")),
		);
		try {
			const absoluteFiles: Record<string, string | null> = {};
			for (const [relative, content] of Object.entries(files)) {
				const path = join(root, relative);
				absoluteFiles[path] = content;
				if (content === null) await mkdir(path, { recursive: true });
				else {
					await mkdir(dirname(path), { recursive: true });
					await writeFile(path, content);
				}
			}
			const startingPath = join(root, start ?? ".");
			const { run } = setup(absoluteFiles, process.platform === "win32");
			const value = await run({ path: startingPath, depth: 3, ignore, hidden });
			const actual = value.entries
				.filter((entry: any) => entry.type === "file")
				.map((entry: any) => entry.path.slice("shown:".length))
				.sort();
			const reference = spawnSync(
				"rg",
				[
					"--no-config",
					"--files",
					"--no-ignore-global",
					"--null",
					...(ignore ? [] : ["--no-ignore"]),
					...(hidden ? ["--hidden"] : []),
					"--max-depth",
					"3",
					"--",
					startingPath,
				],
				{ cwd: root, encoding: "utf8" },
			);
			if (reference.error) throw reference.error;
			expect(reference.signal).toBeNull();
			expect([0, 1]).toContain(reference.status);
			expect(reference.stderr).toBe("");
			expect(value.truncated).toBe(false);
			expect(actual).toEqual(
				reference.stdout.split("\0").filter(Boolean).sort(),
			);
		} finally {
			// Only remove the exact temporary directory created by this test.
			expect(await realpath(root)).toBe(root);
			await rm(root, { recursive: true, force: true });
		}
	},
);
