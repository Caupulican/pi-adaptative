import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerLocalModel, unregisterLocalModel } from "../src/core/models/local-registration.ts";

describe("local model registration in models.json", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = join(tmpdir(), `pi-localreg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (agentDir && existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
	});

	it("creates models.json with the ollama provider and survives re-registration idempotently", () => {
		const first = registerLocalModel({ agentDir, ref: "qwen3:1.7b", baseUrl: "http://127.0.0.1:11434" });
		expect(first.ok).toBe(true);
		registerLocalModel({ agentDir, ref: "qwen3:1.7b", baseUrl: "http://127.0.0.1:11434" });
		registerLocalModel({ agentDir, ref: "pi-lifter:latest", baseUrl: "http://127.0.0.1:11434" });

		const json = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf-8"));
		expect(json.providers.ollama.baseUrl).toBe("http://127.0.0.1:11434/v1");
		expect(json.providers.ollama.api).toBe("openai-completions");
		expect(json.providers.ollama.models.map((model: { id: string }) => model.id)).toEqual([
			"qwen3:1.7b",
			"pi-lifter:latest",
		]);
	});

	it("preserves unrelated user providers and removes cleanly (provider dropped when empty)", () => {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({ providers: { corp: { baseUrl: "https://x/v1", api: "openai-completions", models: [] } } }),
			"utf-8",
		);
		registerLocalModel({ agentDir, ref: "qwen3:0.6b", baseUrl: "http://127.0.0.1:11434" });
		const removed = unregisterLocalModel({ agentDir, ref: "qwen3:0.6b" });
		expect(removed.ok).toBe(true);
		const json = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf-8"));
		expect(json.providers.corp).toBeDefined();
		expect(json.providers.ollama).toBeUndefined();
	});

	it("NEVER rewrites a hand-authored file with comments; hands back a manual snippet", () => {
		const original = '// my precious config\n{ "providers": {} }\n';
		writeFileSync(join(agentDir, "models.json"), original, "utf-8");
		const result = registerLocalModel({ agentDir, ref: "qwen3:0.6b", baseUrl: "http://127.0.0.1:11434" });
		expect(result.ok).toBe(false);
		expect(result.manualSnippet).toContain("qwen3:0.6b");
		expect(readFileSync(join(agentDir, "models.json"), "utf-8")).toBe(original);
	});
});
