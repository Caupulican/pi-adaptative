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

			expect(prompt).toContain("show file paths clearly");
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

			expect(prompt).toContain("Issue independent read-only tool calls together in one assistant turn");
			expect(prompt).toContain("Keep dependent calls, mutations, and stateful commands ordered");
		});

		test("includes the compact Pi-Adaptative and language-agnostic N+2 contract", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toMatch(/^You are Pi-Adaptative, a self-evolving assistant\./);
			expect(prompt).toContain("Treat a clear outcome expressed in normal conversation as a goal");
			expect(prompt).toContain("Move work expected to exceed 15 seconds into managed background execution");
			expect(prompt).toContain("N+2 ARCHITECTURE");
			expect(prompt).toContain("Apply these language-agnostic principles");
			expect(prompt).toContain("Never concatenate growing prefixes");
			expect(prompt).toContain("Detect → Verify → Score → Gate");
			expect(prompt.match(/N\+2 ARCHITECTURE/g)).toHaveLength(1);
			expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(6_500);
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

			expect(prompt).toContain("Resolve `docs/...` and `examples/...` from those roots");
		});
	});

	describe("startup resources", () => {
		test("injects context file contents at startup", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [{ path: "/repo/AGENTS.md", content: "SECRET PROJECT INSTRUCTIONS" }],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain('<project_instructions path="/repo/AGENTS.md">');
			expect(prompt).toContain("Project-specific instructions and guidelines");
			expect(prompt).toContain("SECRET PROJECT INSTRUCTIONS");
			expect(prompt).not.toContain("available_context_files");
		});

		test("lists skill names, descriptions, and locations without injecting full instructions", () => {
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

			expect(prompt).toContain("<name>secret-skill-name</name>");
			expect(prompt).toContain("<description>SECRET SKILL DESCRIPTION</description>");
			expect(prompt).toContain("<location>/skills/secret/SKILL.md</location>");
			expect(prompt).toContain("Use the read tool to load a skill's file");
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
