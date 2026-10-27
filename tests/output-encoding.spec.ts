import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import iconv from "iconv-lite";
import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
	extend: vi.fn(),
	acp: vi.fn(() => 936),
	console: vi.fn(() => 65001),
	oem: vi.fn(() => 437),
}));
vi.mock("@deepseek-ai/dsh-win32-process", () => ({
	extendWin32ProcessBindings: native.extend,
}));
import {
	AutomaticOutputDecoder,
	codePageEncoding,
	detectLegacyEncoding,
	localeEncoding,
	outputEncodingHints,
} from "../src/output-encoding.js";
import {
	DecodedOutputCollector,
	bindOutputStream,
} from "../src/output-capture.js";

native.extend.mockImplementation((create) =>
	create({
		kernel32: {},
		bind: (_library: unknown, name: string) =>
			({
				GetACP: native.acp,
				GetConsoleOutputCP: native.console,
				GetOEMCP: native.oem,
			})[name as "GetACP" | "GetOEMCP" | "GetConsoleOutputCP"],
	}),
);
afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

function decode(
	bytes: Buffer,
	hints: string[] = [],
	chunkSize = bytes.length || 1,
) {
	let text = "";
	const decoder = new AutomaticOutputDecoder((part) => {
		text += part;
	}, hints);
	for (let i = 0; i < bytes.length; i += chunkSize)
		decoder.push(bytes.subarray(i, i + chunkSize));
	decoder.end();
	return { text, encoding: decoder.encoding };
}

const fixtures: [string, string, string[], boolean][] = [
	["utf8", "你好，世界 🌍\n", ["cp936"], false],
	["utf8", "你好，世界 🌍\n", ["cp1252"], true],
	["gbk", "你好，世界，测试输出。\n", ["cp936"], false],
	["gb18030", "你好，世界 🌍\n", ["gb18030"], false],
	["shift_jis", "日本語の文字コードを確認します。\n", ["cp932"], false],
	["cp1252", "Bonjour, déjà vu, café et français.\n", ["cp1252"], false],
	["cp437", "Grüße!\n", ["cp437"], false],
	["utf16le", "你好，世界 🌍\n", ["cp1252"], true],
	["utf16be", "你好，世界 🌍\n", ["cp1252"], true],
	["utf32le", "你好，世界 🌍\n", ["cp1252"], true],
	["utf32be", "你好，世界 🌍\n", ["cp1252"], true],
];

describe("automatic byte decoding", () => {
	for (const [encoding, text, hints, bom] of fixtures) {
		it.each([1, 2, 5, 65536])(
			"decodes " + encoding + (bom ? " with BOM" : "") + " in %i-byte chunks",
			(size) => {
				const bytes = iconv.encode(text, encoding, { addBOM: bom });
				expect(decode(bytes, hints, size).text).toBe(text);
			},
		);
	}

	it("uses byte evidence without locale hints for a substantial GBK sample", () => {
		const text =
			"这是中文程序输出，应该自动识别编码，而不是依赖模型提供参数。".repeat(50);
		expect(decode(iconv.encode(text, "gbk")).text).toBe(text);
	});

	it("lets strong byte evidence override conflicting Windows-style hints", () => {
		const text =
			"这是中文程序输出，应该自动识别编码，而不是依赖模型提供参数。\n";
		expect(
			decode(iconv.encode(text, "gbk"), ["cp1252", "utf8", "cp437"]).text,
		).toBe(text);
	});

	it("delivers ASCII immediately without locking the encoding", () => {
		let text = "";
		const decoder = new AutomaticOutputDecoder(
			(part) => {
				text += part;
			},
			["cp936"],
		);
		decoder.push(Buffer.from("starting...\n"));
		expect(text).toBe("starting...\n");
		expect(decoder.encoding).toBeUndefined();
		decoder.push(iconv.encode("你好，世界\n", "gbk"));
		decoder.end();
		expect(text).toBe("starting...\n你好，世界\n");
	});

	it("does not mistake an incomplete UTF-8 character for a legacy encoding", () => {
		vi.useFakeTimers();
		let text = "";
		const decoder = new AutomaticOutputDecoder(
			(part) => {
				text += part;
			},
			["cp936"],
		);
		const bytes = Buffer.from("你");
		decoder.push(bytes.subarray(0, 1));
		vi.advanceTimersByTime(1000);
		expect(text).toBe("");
		expect(decoder.encoding).toBeUndefined();
		decoder.push(bytes.subarray(1));
		decoder.end();
		expect(text).toBe("你");
	});

	it.each(["newline", "EOF"])(
		"buffers legacy samples without timers until %s",
		(boundary) => {
			vi.useFakeTimers();
			let text = "";
			const decoder = new AutomaticOutputDecoder((part) => {
				text += part;
			}, ["cp936"]);
			decoder.push(iconv.encode("你好，世界", "gbk"));
			expect(vi.getTimerCount()).toBe(0);
			vi.advanceTimersByTime(1000);
			expect(text).toBe("");
			expect(decoder.encoding).toBeUndefined();
			if (boundary === "newline") decoder.push(Buffer.from("\n"));
			else decoder.end();
			expect(text).toBe("你好，世界" + (boundary === "newline" ? "\n" : ""));
			decoder.end();
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("keeps BOM characters that occur after emitted ASCII", () => {
		let text = "";
		const decoder = new AutomaticOutputDecoder((part) => {
			text += part;
		}, []);
		decoder.push(Buffer.from("prefix"));
		decoder.push(Buffer.from("\ufeff你好"));
		decoder.end();
		expect(text).toBe("prefix\ufeff你好");
	});

	it("handles a large chunk without stalling at the detection sample cap", () => {
		const text = "中文输出".repeat(100000);
		expect(decode(iconv.encode(text, "gbk"), ["cp936"]).text).toBe(text);
	});

	it("carries a UTF-8 character that straddles the sample cap", () => {
		const text = "a".repeat(8191) + "你好";
		expect(decode(Buffer.from(text)).text).toBe(text);
	});

	it("flushes an unfinished character after a known UTF-8 prefix", () => {
		let text = "";
		const decoder = new AutomaticOutputDecoder(
			(part) => {
				text += part;
			},
			["cp936"],
		);
		decoder.push(Buffer.from("你好"));
		decoder.push(Buffer.from([0xe4]));
		decoder.end();
		decoder.end();
		decoder.push(Buffer.from("ignored"));
		expect(text).toBe("你好\ufffd");
	});

	it("uses a local hint for ambiguous legacy text and ignores unsupported hints", () => {
		const bytes = iconv.encode("你好", "gbk");
		const encoding = detectLegacyEncoding(bytes, ["not-an-encoding", "cp936"]);
		expect(iconv.decode(bytes, encoding)).toBe("你好");
	});

	it("supports an empty stream", () => {
		expect(decode(Buffer.alloc(0))).toEqual({ text: "", encoding: undefined });
	});
});

describe("platform encoding hints", () => {
	it.each([
		[
			{ LC_ALL: "zh_CN.GB18030", LC_CTYPE: "en_US.UTF-8", LANG: "C" },
			"GB18030",
		],
		[{ LC_ALL: "", LC_CTYPE: "ja_JP.Shift_JIS", LANG: "C" }, "Shift_JIS"],
		[{ LANG: "en_US.ISO-8859-1@euro" }, "ISO-8859-1"],
		[{ LC_CTYPE: "UTF-8" }, "UTF-8"],
		[{ LANG: "C" }, "ascii"],
		[{ LANG: "POSIX" }, "ascii"],
		[{ LANG: "C.UTF-8" }, "UTF-8"],
		[{ LANG: "unrecognized" }, undefined],
		[{}, undefined],
	])("reads locale precedence without mutating %j", (env, expected) => {
		const before = { ...env };
		expect(localeEncoding(env)).toBe(expected);
		expect(env).toEqual(before);
	});

	it("never loads native Windows bindings on Unix", () => {
		expect(outputEncodingHints({ LANG: "zh_CN.GBK" }, "linux")).toEqual([
			"GBK",
		]);
		expect(outputEncodingHints({ LANG: "en_US.UTF-8" }, "darwin")).toEqual([
			"UTF-8",
		]);
		expect(native.extend).not.toHaveBeenCalled();
	});

	it("queries ACP, console output and OEM independently on Windows", () => {
		expect(outputEncodingHints({}, "win32")).toEqual([
			"cp936",
			"utf8",
			"cp437",
		]);
		expect(native.acp).toHaveBeenCalled();
		expect(native.console).toHaveBeenCalled();
		expect(native.oem).toHaveBeenCalled();
	});

	it("deduplicates hints and ignores a missing console", () => {
		native.console.mockReturnValueOnce(0);
		expect(outputEncodingHints({ LANG: "zh_CN.cp936" }, "win32")).toEqual([
			"cp936",
			"cp437",
		]);
	});

	it("keeps byte detection usable if native metadata fails", () => {
		native.acp.mockImplementationOnce(() => {
			throw new Error("native unavailable");
		});
		expect(outputEncodingHints({ LANG: "zh_CN.GBK" }, "win32")).toEqual([
			"GBK",
		]);
	});

	it.each([
		[936, "cp936"],
		[437, "cp437"],
		[65001, "utf8"],
		[1200, "utf16le"],
		[1201, "utf16be"],
		[12000, "utf32le"],
		[12001, "utf32be"],
		[0, undefined],
		[999999, undefined],
	])("maps code page %i", (page, expected) => {
		expect(codePageEncoding(page as number)).toBe(expected);
	});
});

describe("decoded output collection", () => {
	it.each(["utf16le", "utf16be"])(
		"keeps a split %s surrogate pair intact before UTF-8 collection",
		(encoding) => {
			const out = new DecodedOutputCollector(100, "stdout", []);
			const bytes = iconv.encode("🌍", encoding, { addBOM: true });
			for (const byte of bytes) out.push(Buffer.from([byte]));
			out.seal();
			expect(out.readFrom(0)).toEqual({
				text: "🌍",
				nextOffset: 4,
				lossy: false,
			});
		},
	);

	it("replaces one unfinished UTF-16 surrogate at EOF, not every chunk", () => {
		const out = new DecodedOutputCollector(100, "stdout", []);
		out.push(Buffer.from([0xfe, 0xff, 0xd8, 0x3d]));
		expect(out.readFrom(0).text).toBe("");
		out.seal();
		expect(out.readFrom(0).text).toBe("\ufffd");
	});

	it("shares complete characters between independent incremental and batch readers", () => {
		const out = new DecodedOutputCollector(100, "stdout", ["cp936"]);
		out.push(Buffer.from([0xe4]));
		expect(out.readFrom(0)).toEqual({ text: "", nextOffset: 0, lossy: false });
		out.push(Buffer.from([0xbd, 0xa0]));
		const first = out.readFrom(0);
		expect(first).toEqual({ text: "你", nextOffset: 3, lossy: false });
		out.push(Buffer.from("好🌍"));
		out.seal();
		expect(out.readFrom(first.nextOffset)).toEqual({
			text: "好🌍",
			nextOffset: 10,
			lossy: false,
		});
		expect(out.readFrom(0).text).toBe("你好🌍");
		expect(out.readFrom(first.nextOffset).text).toBe("好🌍");
	});

	it("does not introduce a replacement when a tail budget cuts a character", () => {
		const out = new DecodedOutputCollector(4, "stdout", []);
		out.push(Buffer.from("中文"));
		out.seal();
		expect(out.readFrom(0)).toEqual({ text: "文", nextOffset: 6, lossy: true });
	});

	it("keeps lossiness correct when an earlier reader cursor is evicted", () => {
		const out = new DecodedOutputCollector(4, "stdout", []);
		out.push(Buffer.from("abc"));
		const first = out.readFrom(0);
		out.push(Buffer.from("defgh"));
		out.seal();
		expect(out.readFrom(first.nextOffset)).toEqual({
			text: "efgh",
			nextOffset: 8,
			lossy: true,
		});
	});

	it("writes complete normalized UTF-8 spill files and obeys the spill cap", () => {
		const dir = mkdtempSync(join(tmpdir(), "dsh-spawn-encoding-test-"));
		const failed = vi.fn();
		try {
			const out = new DecodedOutputCollector(4, "stdout", ["cp936"], {
				dir,
				maxBytes: 1000,
				onFailure: failed,
			});
			out.push(iconv.encode("你好，世界\n", "gbk"));
			out.seal();
			const read = out.readFrom(0);
			expect(read.lossy).toBe(true);
			if (read.spillPath === undefined) throw new Error("missing spill");
			expect(readFileSync(read.spillPath, "utf8")).toBe("你好，世界\n");
			expect(read.text).not.toContain("\ufffd");
			expect(failed).not.toHaveBeenCalled();
			const capped = new DecodedOutputCollector(1, "stderr", [], {
				dir,
				maxBytes: 3,
				onFailure: failed,
			});
			capped.push(Buffer.from("too long"));
			capped.seal();
			expect(capped.readFrom(0)).toEqual({
				text: "g",
				nextOffset: 8,
				lossy: true,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("degrades to the decoded tail if spilling fails", () => {
		const parent = mkdtempSync(join(tmpdir(), "dsh-spawn-encoding-test-"));
		const failed = vi.fn();
		try {
			const out = new DecodedOutputCollector(3, "stdout", [], {
				dir: join(parent, "missing"),
				maxBytes: 100,
				onFailure: failed,
			});
			out.push(Buffer.from("abcdef"));
			out.seal();
			expect(out.readFrom(0)).toEqual({
				text: "def",
				nextOffset: 6,
				lossy: true,
			});
			expect(failed).toHaveBeenCalledOnce();
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("flushes pending bytes and destroys an inherited pipe on stop", () => {
		const pipe = new PassThrough();
		const out = new DecodedOutputCollector(100, "stdout", ["cp936"]);
		const stop = bindOutputStream(pipe, out);
		pipe.write(iconv.encode("你好", "gbk"));
		stop();
		stop();
		expect(out.readFrom(0).text).toBe("你好");
		expect(pipe.destroyed).toBe(true);
		expect(pipe.listenerCount("data")).toBe(0);
		expect(() => pipe.emit("error", new Error("late error"))).not.toThrow();
	});
});
