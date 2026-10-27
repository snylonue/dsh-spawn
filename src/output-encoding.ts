import { TextDecoder } from "node:util";
import { extendWin32ProcessBindings } from "@deepseek-ai/dsh-win32-process";
import chardet from "chardet";
import iconv from "iconv-lite";

/** Bound detection work independently of the process's output budget. */
const SAMPLE_BYTES = 8 * 1024;
const BOMS = [
	{ bytes: Buffer.from([0xff, 0xfe, 0, 0]), encoding: "utf32le" },
	{ bytes: Buffer.from([0, 0, 0xfe, 0xff]), encoding: "utf32be" },
	{ bytes: Buffer.from([0xef, 0xbb, 0xbf]), encoding: "utf8" },
	{ bytes: Buffer.from([0xff, 0xfe]), encoding: "utf16le" },
	{ bytes: Buffer.from([0xfe, 0xff]), encoding: "utf16be" },
];

/** An effective POSIX locale is a hint, not a promise about the child's output. */
export function localeEncoding(env: NodeJS.ProcessEnv): string | undefined {
	const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
	if (!locale) return undefined;
	if (locale === "C" || locale === "POSIX") return "ascii";
	const name = /\.([^@]+)(?:@.*)?$/.exec(locale)?.[1] ?? locale;
	return iconv.encodingExists(name) ? name : undefined;
}

/** Map actual Windows code-page numbers, not CP_ACP/CP_OEMCP selectors. */
export function codePageEncoding(page: number): string | undefined {
	const unicode: Record<number, string> = {
		65001: "utf8",
		1200: "utf16le",
		1201: "utf16be",
		12000: "utf32le",
		12001: "utf32be",
	};
	const encoding = unicode[page] ?? `cp${page}`;
	return page > 0 && iconv.encodingExists(encoding) ? encoding : undefined;
}

let windowsCodePages: (() => number[]) | undefined;

/** Bind lazily: importing the plugin on Unix never loads a native Windows API. */
function queryWindowsCodePages(): number[] {
	if (windowsCodePages === undefined) {
		const api = extendWin32ProcessBindings(({ bind, kernel32 }) => ({
			getACP: bind(kernel32, "GetACP", "uint32", []) as () => number,
			getConsoleOutputCP: bind(
				kernel32,
				"GetConsoleOutputCP",
				"uint32",
				[],
			) as () => number,
			getOEMCP: bind(kernel32, "GetOEMCP", "uint32", []) as () => number,
		}));
		windowsCodePages = () => [
			api.getACP(),
			api.getConsoleOutputCP(),
			api.getOEMCP(),
		];
	}
	return windowsCodePages();
}

/** Read metadata only; never change a locale, code page, or child environment. */
export function outputEncodingHints(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): string[] {
	const hints: string[] = [];
	if (platform === "win32") {
		try {
			for (const page of queryWindowsCodePages()) {
				const encoding = codePageEncoding(page);
				if (encoding !== undefined) hints.push(encoding);
			}
		} catch {
			// Missing native support must not stop execution or byte-based detection.
		}
	}
	const locale = localeEncoding(env);
	if (locale !== undefined) hints.push(locale);
	return [...new Set(hints)];
}

/** Avoid choosing a codec that visibly destroys the sample; a live tail may be partial. */
function roundTrips(bytes: Buffer, encoding: string, final: boolean): boolean {
	for (let trim = 0; trim <= (final ? 0 : 3) && trim < bytes.length; trim++) {
		const sample = bytes.subarray(0, bytes.length - trim);
		if (trim > 0 && !sample.some((byte) => byte >= 0x80)) continue;
		if (iconv.encode(iconv.decode(sample, encoding), encoding).equals(sample))
			return true;
	}
	return false;
}

/** Strong byte evidence wins; otherwise local metadata breaks ambiguous short samples. */
export function detectLegacyEncoding(
	bytes: Buffer,
	hints: readonly string[],
	final = true,
): string {
	const matches = chardet
		.analyse(bytes)
		.filter(
			(match) =>
				match.confidence > 0 &&
				iconv.encodingExists(match.name) &&
				roundTrips(bytes, match.name, final),
		);
	const best = matches[0];
	if (best !== undefined && best.confidence >= 80) return best.name;
	for (const hint of hints) {
		if (iconv.encodingExists(hint) && roundTrips(bytes, hint, final))
			return hint;
	}
	return best?.name ?? "utf8";
}

/** BOM-first, UTF-8-first streaming decoding with a bounded legacy detection sample. */
export class AutomaticOutputDecoder {
	private pending = Buffer.alloc(0);
	private codec?: {
		encoding: string;
		decoder: ReturnType<typeof iconv.getDecoder>;
	};
	private ended = false;
	private emitted = false;
	private highSurrogate = "";

	constructor(
		private readonly onText: (text: string) => void,
		private readonly hints: readonly string[],
	) {}

	/** Exposed for diagnostics/tests; callers never need to select an encoding. */
	get encoding(): string | undefined {
		return this.codec?.encoding;
	}

	push(bytes: Buffer): void {
		if (this.ended) return;
		let offset = 0;
		while (offset < bytes.length) {
			if (this.codec) {
				this.emit(this.codec.decoder.write(bytes.subarray(offset)));
				return;
			}
			const length = Math.min(
				bytes.length - offset,
				SAMPLE_BYTES - this.pending.length,
			);
			this.pending = Buffer.concat([
				this.pending,
				bytes.subarray(offset, offset + length),
			]);
			offset += length;
			this.probe(false);
		}
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		this.probe(true);
		this.emit(this.codec?.decoder.end());
		if (this.highSurrogate.length > 0) {
			this.highSurrogate = "";
			this.emit("\ufffd");
		}
	}

	private emit(text: string | undefined): void {
		if (!text) return;
		// Some codecs (notably UTF-16BE) emit a surrogate pair in separate writes.
		// Keep the high surrogate until its low half arrives, before any UTF-8 encoding.
		let complete = this.highSurrogate + text;
		this.highSurrogate = "";
		const last = complete.charCodeAt(complete.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) {
			this.highSurrogate = complete.slice(-1);
			complete = complete.slice(0, -1);
		}
		if (complete.length === 0) return;
		this.emitted = true;
		this.onText(complete.toWellFormed());
	}

	private choose(encoding: string): void {
		const decoder = iconv.getDecoder(encoding, { stripBOM: !this.emitted });
		this.codec = { encoding, decoder };
		this.emit(decoder.write(this.pending));
		this.pending = Buffer.alloc(0);
	}

	private probe(final: boolean): void {
		const bytes = this.pending;
		if (bytes.length === 0) return;
		if (!this.emitted) {
			const boms = BOMS.filter(({ bytes: bom }) => {
				const length = Math.min(bytes.length, bom.length);
				return bytes.subarray(0, length).equals(bom.subarray(0, length));
			});
			if (!final && boms.some(({ bytes: bom }) => bom.length > bytes.length))
				return;
			const bom = boms.find(({ bytes: bom }) => bom.length <= bytes.length);
			if (bom !== undefined) {
				this.choose(bom.encoding);
				return;
			}
		}
		if (bytes.every((byte) => byte < 0x80)) {
			// ASCII can be shown immediately, but must not lock a later GBK/etc. line to UTF-8.
			this.emit(bytes.toString("utf8"));
			this.pending = Buffer.alloc(0);
			return;
		}
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
				stream: !final,
			});
			if (
				[...text].some((character) => character.charCodeAt(0) > 0x7f) ||
				final ||
				bytes.length === SAMPLE_BYTES
			)
				this.choose("utf8");
			// An incomplete UTF-8 sequence is not evidence of a legacy encoding.
			return;
		} catch {
			// Invalid UTF-8: obtain enough byte evidence before selecting a legacy codec.
		}
		if (final || bytes.length === SAMPLE_BYTES || bytes.includes(0x0a)) {
			this.choose(detectLegacyEncoding(bytes, this.hints, final));
		}
	}
}
