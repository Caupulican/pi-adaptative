import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const aiEntryUrl = new URL("../src/index.ts", import.meta.url).href;
const leanEntryUrls = [
	new URL("../src/stream.ts", import.meta.url).href,
	new URL("../src/types.ts", import.meta.url).href,
	new URL("../src/usage.ts", import.meta.url).href,
	new URL("../src/utils/event-stream.ts", import.meta.url).href,
	new URL("../src/utils/json-parse.ts", import.meta.url).href,
	new URL("../src/utils/overflow.ts", import.meta.url).href,
	new URL("../src/utils/provider-retry.ts", import.meta.url).href,
	new URL("../src/utils/streaming-lines.ts", import.meta.url).href,
	new URL("../src/utils/tool-repair/text-protocol.ts", import.meta.url).href,
	new URL("../src/utils/tool-repair/registry.ts", import.meta.url).href,
	new URL("../src/utils/typebox-helpers.ts", import.meta.url).href,
	new URL("../src/utils/validation.ts", import.meta.url).href,
	new URL("../src/utils/validation-path.ts", import.meta.url).href,
	new URL("../src/utils/uuid.ts", import.meta.url).href,
] as const;

const LEAN_EXPORTS = {
	"./event-stream": "./dist/utils/event-stream.js",
	"./json-parse": "./dist/utils/json-parse.js",
	"./overflow": "./dist/utils/overflow.js",
	"./provider-retry": "./dist/utils/provider-retry.js",
	"./stream": "./dist/stream.js",
	"./streaming-lines": "./dist/utils/streaming-lines.js",
	"./text-tool-protocol": "./dist/utils/tool-repair/text-protocol.js",
	"./tool-repair-registry": "./dist/utils/tool-repair/registry.js",
	"./typebox-helpers": "./dist/utils/typebox-helpers.js",
	"./types": "./dist/types.js",
	"./usage": "./dist/usage.js",
	"./validation": "./dist/utils/validation.js",
	"./validation-path": "./dist/utils/validation-path.js",
	"./uuid": "./dist/utils/uuid.js",
} as const;

const HEAVY_MODULE_FRAGMENTS = [
	"/src/image-models.ts",
	"/src/models.generated.ts",
	"/src/models.ts",
	"/src/providers/images/",
	"/src/utils/tool-repair/replay.ts",
] as const;

const SDK_SPECIFIERS = [
	"@anthropic-ai/sdk",
	"openai",
	"@google/genai",
	"@mistralai/mistralai",
	"@aws-sdk/client-bedrock-runtime",
] as const;

type ProbeResult = {
	loadedSpecifiers: string[];
	loadedLocalModules: string[];
};

function runProbe(action: string, entry: string | readonly string[] = aiEntryUrl): ProbeResult {
	const entryUrls = typeof entry === "string" ? [entry] : entry;
	const script = `
		import { registerHooks } from "node:module";

		const targets = new Set(${JSON.stringify(SDK_SPECIFIERS)});
		const loaded = [];
		const loadedLocalModules = [];

		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (targets.has(specifier)) {
					loaded.push(specifier);
				}
				const resolution = nextResolve(specifier, context);
				if (resolution.url.includes("/src/")) {
					loadedLocalModules.push(resolution.url);
				}
				return resolution;
			},
		});

		const entryUrls = ${JSON.stringify(entryUrls)};
		const mod = await import(entryUrls[0]);
		for (let index = 1; index < entryUrls.length; index++) {
			await import(entryUrls[index]);
		}
		${action}
		console.log(JSON.stringify({
			loadedSpecifiers: [...new Set(loaded)],
			loadedLocalModules: [...new Set(loadedLocalModules)],
		}));
	`;

	const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
		cwd: packageRoot,
		encoding: "utf8",
	});

	if (result.status !== 0) {
		throw new Error(`Probe failed (exit ${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	}

	const stdoutLines = result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const lastLine = stdoutLines.at(-1);
	if (!lastLine) {
		throw new Error(`Probe produced no output\nSTDERR:\n${result.stderr}`);
	}

	return JSON.parse(lastLine) as ProbeResult;
}

describe("lazy provider module loading", () => {
	it("publishes lean static entrypoints without pulling unrelated heavy owners", () => {
		const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
			exports: Record<string, { import?: string }>;
		};
		for (const [subpath, importPath] of Object.entries(LEAN_EXPORTS)) {
			expect(packageJson.exports[subpath]?.import).toBe(importPath);
		}

		const result = runProbe("", leanEntryUrls);
		expect(
			result.loadedLocalModules.filter((url) => HEAVY_MODULE_FRAGMENTS.some((part) => url.includes(part))),
		).toEqual([]);
	});

	it("keeps the heavy-module probe sensitive to the batteries-included root barrel", () => {
		const result = runProbe("");
		expect(result.loadedLocalModules.some((url) => url.includes("/src/models.generated.ts"))).toBe(true);
	});

	it("does not load provider SDKs when importing the root barrel", () => {
		const result = runProbe("");
		expect(result.loadedSpecifiers).toEqual([]);
	});

	it("loads only the Anthropic SDK when calling the root lazy wrapper", () => {
		const result = runProbe(`
			const model = {
				id: "claude-sonnet-4-6",
				name: "Claude Sonnet 4",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 8192,
			};
			const context = { messages: [{ role: "user", content: "hi" }] };
			await mod.streamSimpleAnthropic(model, context).result();
		`);

		expect(result.loadedSpecifiers).toEqual(["@anthropic-ai/sdk"]);
	});

	it("loads only the Anthropic SDK when dispatching through streamSimple", () => {
		const result = runProbe(`
			const model = mod.getModel("anthropic", "claude-sonnet-4-6");
			const context = { messages: [{ role: "user", content: "hi" }] };
			await mod.streamSimple(model, context).result();
		`);

		expect(result.loadedSpecifiers).toEqual(["@anthropic-ai/sdk"]);
	});
});
