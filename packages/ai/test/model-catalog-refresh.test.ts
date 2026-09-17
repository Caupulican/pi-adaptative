import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const generator = fileURLToPath(new URL("../scripts/generate-models.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/model-catalog-refresh-fetch.mjs", import.meta.url));
const directories: string[] = [];
const sources = [
	"https://models.dev/api.json",
	"https://openrouter.ai/api/v1/models",
	"https://ai-gateway.vercel.sh/v1/models",
];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function generate(source?: string, failure?: string) {
	const directory = mkdtempSync(join(tmpdir(), "pi-model-catalog-"));
	directories.push(directory);
	const output = join(directory, "models.generated.ts");
	const original = "// Existing committed catalog must survive a failed refresh.\n";
	writeFileSync(output, original);
	const result = spawnSync(process.execPath, ["--import", fixture, generator], {
		encoding: "utf8",
		timeout: 10_000,
		env: {
			...process.env,
			NODE_OPTIONS: "",
			PI_FETCH_MODELS: "1",
			PI_MODEL_CATALOG_OUTPUT_PATH: output,
			PI_CATALOG_FIXTURE_SOURCE: source ?? "",
			PI_CATALOG_FIXTURE_FAILURE: failure ?? "",
		},
	});
	return { result, original, output: readFileSync(output, "utf8") };
}

describe("model catalog refresh publication", () => {
	it.each(sources)("preserves the existing catalog when %s fails", (source) => {
		for (const failure of ["network", "http", "json", "empty"]) {
			const { result, original, output } = generate(source, failure);
			const diagnostic =
				failure === "network"
					? "Fixture network failure"
					: failure === "http"
						? "Model catalog request failed (503)"
						: failure === "json"
							? "SyntaxError"
							: "returned no usable models";
			expect(result.error, `${source}: ${failure}`).toBeUndefined();
			expect(result.status, `${source}: ${failure}`).toBe(1);
			expect(result.stderr, `${source}: ${failure}`).toContain(diagnostic);
			expect(output, `${source}: ${failure}`).toBe(original);
		}
	});

	it("publishes all source models when every source succeeds", () => {
		const { result, original, output } = generate();
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(output).not.toBe(original);
		expect(output).toContain('id: "fixture-direct"');
		expect(output).toContain('id: "fixture/router"');
		expect(output).toContain('id: "fixture/gateway"');
	});
});
