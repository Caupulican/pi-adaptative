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

function generate(source?: string, failure?: string, provider?: string) {
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
			PI_MODEL_CATALOG_PROVIDER: provider ?? "",
			PI_CATALOG_FIXTURE_SOURCE: source ?? "",
			PI_CATALOG_FIXTURE_FAILURE: failure ?? "",
		},
	});
	return { result, original, output: readFileSync(output, "utf8") };
}

function modelBlock(output: string, id: string): string {
	const start = output.indexOf(`id: "${id}"`);
	if (start < 0) throw new Error(`Missing generated model: ${id}`);
	const end = output.indexOf("satisfies Model<", start);
	if (end < 0) throw new Error(`Incomplete generated model: ${id}`);
	return output.slice(start, end);
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

	it("uses alias target compatibility without changing alias identity or advertised prices", () => {
		const { result, output } = generate();
		expect(result.status, result.stderr).toBe(0);
		const deepseek = modelBlock(output, "~deepseek/deepseek-flash-latest");
		expect(deepseek).toContain('"requiresReasoningContentOnAssistantMessages":true');
		expect(deepseek).toContain('"low":"low"');
		expect(deepseek).toContain('"medium":null');
		expect(deepseek).toContain('"xhigh":null');
		expect(deepseek).toContain('"max":"max"');
		expect(deepseek).toContain("input: 1,");
		expect(deepseek).toContain("output: 2,");
		const astra = modelBlock(output, "~openai/gpt-astra-latest");
		expect(astra).toContain('"off":null');
		expect(astra).toContain('"minimal":null');
		expect(astra).toContain('"max":"max"');
		expect(astra).toContain('defaultThinkingLevel: "medium"');
		const mercury = modelBlock(output, "inception/mercury-2.5");
		expect(mercury).toContain('"off":null');
	});

	it("publishes an OpenRouter refresh without replacing other providers with fixture data", () => {
		const { result, output } = generate(undefined, undefined, "openrouter");
		expect(result.status, result.stderr).toBe(0);
		expect(output).toContain('id: "fixture/router"');
		expect(output).not.toContain('id: "fixture-direct"');
		expect(output).not.toContain('id: "fixture/gateway"');
		expect(output).toContain('id: "claude-opus-4-6"');
	});

	it("routes Copilot GPT-6 through Responses while retaining the GPT-4 chat route", () => {
		const { result, output } = generate();
		expect(result.status, result.stderr).toBe(0);
		const copilotStart = output.indexOf('"github-copilot": {');
		expect(copilotStart).toBeGreaterThan(-1);
		const copilot = output.slice(copilotStart, output.indexOf("\n\t},", copilotStart));
		const astra = modelBlock(copilot, "gpt-6-astra");
		expect(astra).toContain('api: "openai-responses"');
		expect(astra).toContain('"off":null');
		expect(astra).toContain('"minimal":"low"');
		expect(modelBlock(copilot, "gpt-4.1")).toContain('api: "openai-completions"');
	});
});
