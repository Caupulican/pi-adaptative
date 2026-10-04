import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Vitest aliases that point every `pi-ai` entry point at its TypeScript source.
 *
 * Derived from the package's own export map rather than restated here. A hand-written list drifts:
 * nine provider entry points (anthropic, bedrock-provider, the openai family, …) were missing from
 * the previous copy, so any test project resolving through Vite instead of Node's `pi-source`
 * condition fell through to `./dist`, which only exists on a machine that has built the package —
 * green locally, `Cannot find package` on a clean checkout.
 */
const aiPackagePattern = "@(?:caupulican/pi-ai|earendil-works/pi-ai|mariozechner/pi-ai)";
const aiPackageRoot = new URL("../ai/", import.meta.url);

interface ExportConditions {
	"pi-source"?: string;
}

const aiExports = (
	JSON.parse(readFileSync(new URL("package.json", aiPackageRoot), "utf-8")) as {
		exports: Record<string, ExportConditions>;
	}
).exports;

function escapeSubpath(subpath: string): string {
	return subpath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const piAiSourceAliases = Object.entries(aiExports).flatMap(([subpath, conditions]) => {
	const source = conditions["pi-source"];
	if (!source) return [];
	// Every pattern is anchored, so the bare-package entry cannot shadow a subpath.
	const suffix = subpath === "." ? "" : `/${escapeSubpath(subpath.slice(2))}`;
	return [
		{
			find: new RegExp(`^${aiPackagePattern}${suffix}$`),
			replacement: fileURLToPath(new URL(source, aiPackageRoot)),
		},
	];
});
