import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "vitest";

it("targets only the current DSH host rather than retaining older-host ranges", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	);
	assert.equal(manifest.engines.dsh, "0.2.1-rc.2");
	assert.equal(manifest.peerDependencies["@deepseek-ai/cordis"], "~4.0.5");
	for (const group of ["dependencies", "devDependencies", "peerDependencies"])
		for (const [name, version] of Object.entries(manifest[group] ?? {}))
			if (name.startsWith("@deepseek-ai/dsh-"))
				assert.equal(version, "0.2.1-rc.2", name);
	assert.equal(
		manifest.peerDependenciesMeta?.["@deepseek-ai/dsh-working-directory"]
			?.optional,
		undefined,
	);
});
