import type { Readable } from "node:stream";
import type {
	SubprocessOutputReader,
	SubprocessOutputRead,
} from "@deepseek-ai/dsh-subprocess";
import {
	OutputCollector,
	type SpillOptions,
} from "@deepseek-ai/dsh-subprocess-local/output";
import { AutomaticOutputDecoder } from "./output-encoding.js";

/** Normalize complete characters to UTF-8 before bounded collection and spill. */
export class DecodedOutputCollector implements SubprocessOutputReader {
	private readonly collector: OutputCollector;
	private readonly decoder: AutomaticOutputDecoder;
	private sealed = false;

	constructor(
		maxBytes: number,
		label: string,
		hints: readonly string[],
		spill?: SpillOptions,
	) {
		this.collector = new OutputCollector(maxBytes, label, spill);
		this.decoder = new AutomaticOutputDecoder(
			(text) => this.collector.push(Buffer.from(text, "utf8")),
			hints,
		);
	}

	push(bytes: Buffer): void {
		if (!this.sealed) this.decoder.push(bytes);
	}

	seal(): void {
		if (this.sealed) return;
		this.sealed = true;
		this.decoder.end();
		this.collector.seal();
	}

	/** Cursors address normalized UTF-8 bytes; independent readers never share decoder state. */
	readFrom(fromByte: number): SubprocessOutputRead {
		const metadata = this.collector.readFrom(fromByte);
		const { bytes, totalBytes } = this.collector.snapshot();
		const windowStart = totalBytes - bytes.length;
		let start = metadata.lossy ? 0 : Math.max(0, fromByte - windowStart);
		// A byte-budget tail can start inside a UTF-8 character: drop that partial character.
		while (start < bytes.length && (bytes.readUInt8(start) & 0xc0) === 0x80)
			start++;
		return { ...metadata, text: bytes.subarray(start).toString("utf8") };
	}
}

/** Consume raw pipes immediately; the provider still owns its bounded exit/drain wait. */
export function bindOutputStream(
	stream: Readable,
	collector: DecodedOutputCollector,
): () => void {
	const onData = (bytes: Buffer) => collector.push(bytes);
	const seal = () => collector.seal();
	stream.on("data", onData);
	stream.once("end", seal);
	stream.once("close", seal);
	stream.on("error", seal);
	let stopped = false;
	return () => {
		if (stopped) return;
		stopped = true;
		try {
			// Capture already-buffered bytes even when spawn/provider failure beats the next data tick.
			while (stream.read() !== null) {
				/* read() emits data to our listener */
			}
		} finally {
			stream.off("data", onData);
			stream.off("end", seal);
			stream.off("close", seal);
			// Keep an error listener for late pipe errors after provider settlement.
			stream.destroy();
			collector.seal();
		}
	};
}
