import { describe, expect, it } from "vitest";
import { deriveModelCapabilityProfile, type ModelCapabilityClass } from "../src/core/model-capability.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "../src/core/system-prompt.ts";

const OVERSIZED_CONTEXT_TAIL = "OVERSIZED_CONTEXT_TAIL_MUST_NOT_BE_PRELOADED";
const CONTEXT_PATH = "/repo/AGENTS.md";

function buildForCapability(capabilityClass: ModelCapabilityClass): string {
	const contextWindow =
		capabilityClass === "full"
			? 200_000
			: capabilityClass === "lean"
				? 16_384
				: capabilityClass === "minimal"
					? 8_192
					: 4_096;
	const options: BuildSystemPromptOptions = {
		modelCapability: deriveModelCapabilityProfile({ contextWindow }),
		selectedTools: capabilityClass === "chat" ? [] : ["read", "bash", "edit", "write"],
		toolSnippets: {
			read: "Read file contents",
			bash: "Execute shell commands",
			edit: "Make surgical edits",
			write: "Create files",
		},
		contextFiles: [
			{
				path: CONTEXT_PATH,
				content: `MANDATORY PROJECT RULES\n${"x".repeat(50_000)}\n${OVERSIZED_CONTEXT_TAIL}`,
			},
		],
		skills: [],
		cwd: "/repo",
	};
	return buildSystemPrompt(options);
}

describe("capability-shaped system prompts", () => {
	it("reframes an 8k model as a focused executor and defers oversized project instructions", () => {
		const prompt = buildForCapability("minimal");

		expect(prompt).toMatch(/^Pi-Adaptative focused coding executor\./);
		expect(prompt).toContain(CONTEXT_PATH);
		expect(prompt).toContain("read each relevant listed file completely before any mutation");
		expect(prompt).toContain("On failure, read error, expected shape");
		expect(prompt).not.toContain(OVERSIZED_CONTEXT_TAIL);
		expect(prompt).not.toContain("N+2 ARCHITECTURE");
		expect(prompt.length).toBeLessThanOrEqual(4_096);
	});

	it("keeps the rich prompt and eager project instructions for a full-capability model", () => {
		const prompt = buildForCapability("full");

		expect(prompt).toMatch(/^Pi-Adaptative: self-evolving assistant\./);
		expect(prompt).toContain("N+2 ARCHITECTURE");
		expect(prompt).toContain(OVERSIZED_CONTEXT_TAIL);
	});

	it("uses a bounded coding role and deferred resources for a lean model", () => {
		const prompt = buildForCapability("lean");

		expect(prompt).toMatch(/^Pi-Adaptative bounded coding agent\./);
		expect(prompt).toContain(CONTEXT_PATH);
		expect(prompt).not.toContain(OVERSIZED_CONTEXT_TAIL);
		expect(prompt).not.toContain("N+2 ARCHITECTURE");
		expect(prompt.length).toBeLessThanOrEqual(8_192);
	});

	it("uses a concise no-execution role for a chat-class model", () => {
		const prompt = buildForCapability("chat");

		expect(prompt).toMatch(/^Pi-Adaptative concise chat assistant\./);
		expect(prompt).toContain("No execution tools are active");
		expect(prompt).toContain(CONTEXT_PATH);
		expect(prompt).not.toContain(OVERSIZED_CONTEXT_TAIL);
		expect(prompt).not.toContain("N+2 ARCHITECTURE");
		expect(prompt.length).toBeLessThanOrEqual(2_048);
	});

	it.each(["full", "lean", "minimal"] as const)(
		"does not make %s tool-capable models ask twice for authorized model-blind migration",
		(capabilityClass) => {
			const prompt = buildForCapability(capabilityClass);

			expect(prompt).toContain("secret_store");
			expect(prompt).toContain("no duplicate confirmation");
		},
	);

	it("bounds adversarially many deferred instruction paths and fails closed before mutation", () => {
		const options: BuildSystemPromptOptions = {
			modelCapability: deriveModelCapabilityProfile({ contextWindow: 8_192 }),
			selectedTools: ["read", "edit"],
			toolSnippets: { read: "Read files", edit: "Edit files" },
			contextFiles: Array.from({ length: 100 }, (_, index) => ({
				path: `/repo/${"nested/".repeat(12)}${index}/AGENTS.md`,
				content: `${"ignored".repeat(1_000)}${index}`,
			})),
			skills: [],
			cwd: "/repo",
		};
		const prompt = buildSystemPrompt(options);

		expect(prompt).toContain("omitted=");
		expect(prompt).not.toContain("<omitted");
		expect(prompt).toContain("Do not mutate until the omitted instruction paths are supplied");
		expect(prompt).not.toContain("ignoredignored");
		expect(prompt.length).toBeLessThanOrEqual(4_096);
	});

	it("rejects aggregate harness expansion beyond a constrained profile budget but leaves full profiles unbounded", () => {
		const expansionMarker = "FUTURE_HARNESS_EXPANSION";
		const oversizedExpansion = `${expansionMarker}\n${"x".repeat(12_000)}`;
		const constrainedOptions: BuildSystemPromptOptions = {
			modelCapability: deriveModelCapabilityProfile({ contextWindow: 8_192 }),
			selectedTools: ["read"],
			toolSnippets: { read: "Read files" },
			appendSystemPrompt: oversizedExpansion,
			cwd: "/repo",
		};

		expect(() => buildSystemPrompt(constrainedOptions)).toThrow(
			"minimal system prompt exceeds its 4096-character capability budget",
		);

		const fullPrompt = buildSystemPrompt({
			...constrainedOptions,
			modelCapability: deriveModelCapabilityProfile({ contextWindow: 200_000 }),
		});
		expect(fullPrompt).toContain(oversizedExpansion);
	});
});
