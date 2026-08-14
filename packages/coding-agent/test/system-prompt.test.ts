import { describe, expect, test } from "vitest";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file path guidance even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("show paths");
		});
	});

	describe("default tools", () => {
		test("batches independent read-only calls without weakening ordered mutations", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "grep", "edit"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Batch independent reads");
			expect(prompt).toContain("order dependent/mutating/stateful calls");
		});

		test("includes the compact Pi-Adaptative and language-agnostic N+2 contract", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toMatch(/^Pi-Adaptative: self-evolving assistant\./);
			expect(prompt).toContain("Clear conversational outcome is goal");
			expect(prompt).toContain("Work over 15 seconds: managed background run");
			expect(prompt).toContain("N+2 ARCHITECTURE");
			expect(prompt).toContain("Language-agnostic principles");
			expect(prompt).toContain("Never concatenate growing prefixes");
			expect(prompt).toContain("User outcome governs, method does not");
			expect(prompt).toContain("Outcome risk: show evidence");
			expect(prompt).toContain("Detect, verify, score, gate");
			expect(prompt.match(/N\+2 ARCHITECTURE/g)).toHaveLength(1);
			expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(3_000);
		});

		test("applies ultra-terse output without dropping meaning-bearing words or exact technical text", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("ULTRA-TERSE OUTPUT");
			expect(prompt).toContain("Never drop not/never/no/only/except");
			expect(prompt).toContain("never invent abbreviations or use causal arrows");
			expect(prompt).toContain("Preserve numbers, units, code symbols, function/API names, commands, errors");
			expect(prompt).toContain("Full grammar: security, irreversible actions, ambiguous order");
		});

		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test("routes Pi documentation through its absolute roots", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("PI DOCS: root=");
			expect(prompt).toContain("README.md, `docs/...`, `examples/...`");
		});
	});

	describe("startup resources", () => {
		test("injects context file contents at startup", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [{ path: "/repo/AGENTS.md", content: "SECRET PROJECT INSTRUCTIONS" }],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain('FILE "/repo/AGENTS.md"');
			expect(prompt).toContain("PROJECT-SPECIFIC INSTRUCTIONS");
			expect(prompt).toContain("SECRET PROJECT INSTRUCTIONS");
			expect(prompt).toContain("END FILE");
			expect(prompt).not.toContain("<project_instructions");
		});

		test("lists on-demand project paths without injecting their contents", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [
					{ path: "/home/user/.pi/agent/AGENTS.md", content: "GLOBAL RULES" },
					{ path: "/repo/AGENTS.md" },
				],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain('FILE "/home/user/.pi/agent/AGENTS.md"');
			expect(prompt).toContain("GLOBAL RULES");
			expect(prompt).toContain("PROJECT RULE PATHS — contents not preloaded.");
			expect(prompt).toContain('"/repo/AGENTS.md"');
			expect(prompt).not.toContain('FILE "/repo/AGENTS.md"');
		});

		test("keeps skill metadata out of the stable prompt and emits only the mandatory vault rule", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "skill"],
				toolSnippets: { skill: "Search, load, unload specialized instructions on demand." },
				contextFiles: [],
				skills: [
					{
						name: "secret-skill-name",
						description: "SECRET SKILL DESCRIPTION",
						filePath: "/skills/secret/SKILL.md",
						baseDir: "/skills/secret",
						sourceInfo: createSyntheticSourceInfo("/skills/secret/SKILL.md", { source: "test" }),
						disableModelInvocation: false,
					},
				],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("SKILL VAULT, NON-NEGOTIABLE");
			expect(prompt).toContain("iff");
			expect(prompt).toContain("specialist help");
			expect(prompt).not.toContain("secret-skill-name");
			expect(prompt).not.toContain("SECRET SKILL DESCRIPTION");
			expect(prompt).not.toContain("/skills/secret/SKILL.md");
		});

		test("omits the vault rule when the skill tool is not active", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("SKILL VAULT, NON-NEGOTIABLE");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});
});
