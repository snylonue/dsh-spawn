/** Shared test helpers for the required jobs and sandbox composition. */
export interface ComposedSpawn {
	tool: any;
}

/** A job registry stub that runs the producer and waits for its settlement. */
export function createJobs(): any {
	let nextId = 0;
	const hooks = new Map<string, any>();
	return {
		start: (spec: any) => {
			const id = "spawn-" + ++nextId;
			hooks.set(id, spec.run());
			return id;
		},
		wait: async (id: string, timeoutMs: number) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					hooks.get(id).done,
					new Promise((resolve) => {
						timer = setTimeout(() => resolve({ status: "running" }), timeoutMs);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		},
		kill: (id: string, _owner: unknown, reason: unknown) =>
			hooks.get(id).cancel(reason),
		remove: (id: string) => {
			hooks.delete(id);
		},
		read: () => ({
			chunks: [],
			lossy: false,
			job: { output: { spillPaths: [] } },
		}),
	};
}

/** Compose the built plugin and return the registered definition. */
export async function composeSpawn(): Promise<ComposedSpawn> {
	const mod: any = await import(
		new URL("../dist/index.js", import.meta.url).href
	);
	let captured: any;
	const ctx: any = {
		jobs: createJobs(),
		sandbox: {
			confine: () => {
				throw new Error("unexpected confinement");
			},
		},
		sandboxPolicy: {
			resolve: () => ({ mode: "workspace-write", workspaceRoot: "/ws" }),
		},
		systemPrompt: { section: () => {}, getSectionOrder: () => 0 },
		tools: {
			register: (definition: any) => {
				captured = definition;
				return () => {};
			},
		},
	};
	mod.apply(ctx);
	return { tool: captured };
}

/** The arguments every `spawn` render/present assertion reuses. */
export const ARGS = { command: "echo", args: ["hello"] };

/** One foreground `spawn` value, overridable per assertion. */
export function foreground(extra: Record<string, unknown> = {}): any {
	return {
		kind: "foreground",
		exitCode: 0,
		stdout: { text: "hello" },
		...extra,
	};
}

/** Parse back the structured value the renderer produced. */
export function rendered(tool: any, value: any): any {
	return JSON.parse(tool.output.render(ARGS, value)[0].text);
}

/** A normalized tool result, as presenters receive it. */
export function wrapped(value: any, isError = false): any {
	return { content: [{ type: "text", text: JSON.stringify(value) }], isError };
}
