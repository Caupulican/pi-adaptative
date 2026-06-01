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

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
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

		test("instructs models to resolve pi docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
		});
	});

	describe("lazy startup resources", () => {
		test("lists context file locations without injecting AGENTS content", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [{ path: "/repo/AGENTS.md", content: "SECRET PROJECT INSTRUCTIONS" }],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain('<context_file path="/repo/AGENTS.md" />');
			expect(prompt).toContain("Project-specific instruction files are available for lazy loading");
			expect(prompt).not.toContain("SECRET PROJECT INSTRUCTIONS");
			expect(prompt).not.toContain("<project_instructions");
		});

		test("lists skill locations without injecting skill frontmatter", () => {
			const prompt = buildSystemPrompt({
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

			expect(prompt).toContain('<skill location="/skills/secret/SKILL.md" />');
			expect(prompt).toContain("Skill frontmatter and instructions are not injected");
			expect(prompt).not.toContain("secret-skill-name");
			expect(prompt).not.toContain("SECRET SKILL DESCRIPTION");
			expect(prompt).not.toContain("<description>");
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
