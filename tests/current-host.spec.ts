import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "vitest";

it("declares rc.2, rc.3, and rc.5 support while keeping the rc.2 build SDK", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	);
	assert.equal(manifest.engines.dsh, "0.2.2-rc.2 || 0.2.2-rc.3 || 0.2.2-rc.5");
	assert.equal(manifest.peerDependencies["@deepseek-ai/cordis"], "~4.1.0");
	for (const group of ["dependencies", "devDependencies", "peerDependencies"])
		for (const [name, version] of Object.entries(manifest[group] ?? {}))
			if (name.startsWith("@deepseek-ai/dsh-"))
				assert.equal(
					version,
					group === "peerDependencies" ? manifest.engines.dsh : "0.2.2-rc.2",
					name,
				);
	assert.equal(
		manifest.peerDependenciesMeta?.["@deepseek-ai/dsh-working-directory"]
			?.optional,
		undefined,
	);
});
