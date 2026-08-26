import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { createDirectoryLink } from "./helpers/filesystem-links.ts";

const PROMPT_PATH_CASES = [
	"absolute-project-path",
	"process-relative-project-path",
	"ancestor-provider-path",
	"repository-root-project-path",
	"external-alias-into-project",
	"project-alias-to-external",
	"project-read-error",
] as const;

type PromptPathCase = (typeof PROMPT_PATH_CASES)[number];

describe("SDK project-context file admission", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	let disposables: Array<{ dispose(): void | Promise<void> }>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-sdk-project-context-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		disposables = [];
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const disposable of disposables.reverse()) await disposable.dispose();
		rmSync(root, { recursive: true, force: true });
	});

	function track<T extends { dispose(): void | Promise<void> }>(disposable: T): T {
		disposables.push(disposable);
		return disposable;
	}

	function settings(projectContextFiles: "off" | "on-demand", extensionAllow: string[] = []): SettingsManager {
		if (extensionAllow.length === 0) return SettingsManager.inMemory({ projectContextFiles });
		return SettingsManager.inMemory({
			projectContextFiles,
			resourceProfiles: {
				"sdk-paths": {
					extensions: { allow: extensionAllow },
					skills: { allow: ["*"] },
					prompts: { allow: ["*"] },
				},
			},
			activeResourceProfiles: ["sdk-paths"],
		});
	}

	function writeGlobalPrompts(): void {
		writeFileSync(join(agentDir, "SYSTEM.md"), "GLOBAL SYSTEM");
		writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "GLOBAL APPEND");
	}

	function createPromptCandidate(kind: PromptPathCase): string {
		switch (kind) {
			case "absolute-project-path": {
				const path = join(cwd, "providers", "absolute.md");
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, "PROJECT ABSOLUTE");
				return path;
			}
			case "process-relative-project-path": {
				const path = join(cwd, "providers", "relative.md");
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, "PROJECT RELATIVE");
				return relative(process.cwd(), path);
			}
			case "ancestor-provider-path": {
				const path = join(root, "AGENTS.md");
				writeFileSync(path, "PROJECT ANCESTOR");
				return path;
			}
			case "repository-root-project-path": {
				mkdirSync(join(root, ".git"), { recursive: true });
				const path = join(root, "config", "provider.md");
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, "PROJECT REPOSITORY ROOT");
				return path;
			}
			case "external-alias-into-project": {
				const target = join(cwd, "providers", "canonical-target");
				const alias = join(root, "alias-into-project");
				mkdirSync(target, { recursive: true });
				writeFileSync(join(target, "provider.md"), "PROJECT CANONICAL TARGET");
				createDirectoryLink(target, alias);
				return join(alias, "provider.md");
			}
			case "project-alias-to-external": {
				const target = join(root, "external-target");
				const alias = join(cwd, "providers", "alias-to-external");
				mkdirSync(target, { recursive: true });
				mkdirSync(dirname(alias), { recursive: true });
				writeFileSync(join(target, "provider.md"), "EXTERNAL THROUGH PROJECT ALIAS");
				createDirectoryLink(target, alias);
				return join(alias, "provider.md");
			}
			case "project-read-error": {
				const path = join(cwd, "providers", "directory-not-file");
				mkdirSync(path, { recursive: true });
				return path;
			}
		}
	}

	function writeExtension(path: string, sentinel: string): void {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "imported");\nexport default function extension() {}\n`,
		);
	}

	function writeSkillDirectory(path: string, name: string): string {
		mkdirSync(path, { recursive: true });
		const filePath = join(path, `${name}.md`);
		writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name} description\n---\n${name} body\n`);
		return filePath;
	}

	function writePromptDirectory(path: string, name: string): string {
		mkdirSync(path, { recursive: true });
		const filePath = join(path, `${name}.md`);
		writeFileSync(filePath, `---\ndescription: ${name} description\n---\n${name} body\n`);
		return filePath;
	}

	function createSkill(name: string, filePath: string): Skill {
		return {
			name,
			description: `${name} description`,
			filePath,
			baseDir: dirname(filePath),
			sourceInfo: createSyntheticSourceInfo(filePath, { source: "custom" }),
			disableModelInvocation: false,
		};
	}

	it.each(PROMPT_PATH_CASES)(
		"blocks project-backed system and append inputs before read when global-only: %s",
		async (kind) => {
			writeGlobalPrompts();
			const candidate = createPromptCandidate(kind);
			const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
			const loader = track(
				new DefaultResourceLoader({
					cwd,
					agentDir,
					settingsManager: settings("off"),
					systemPrompt: candidate,
					appendSystemPrompt: [candidate],
				}),
			);

			await loader.reload();

			expect(loader.getSystemPrompt(), kind).toBe("GLOBAL SYSTEM");
			expect(loader.getAppendSystemPrompt(), kind).toEqual(["GLOBAL APPEND"]);
			expect(consoleError, kind).not.toHaveBeenCalled();
		},
	);

	it("preserves caller-memory, true external, and on-demand prompt inputs", async () => {
		writeGlobalPrompts();
		const projectPrompt = join(cwd, "providers", "project.md");
		const externalPrompt = join(root, "outside", "external.md");
		mkdirSync(dirname(projectPrompt), { recursive: true });
		mkdirSync(dirname(externalPrompt), { recursive: true });
		writeFileSync(projectPrompt, "PROJECT ON DEMAND");
		writeFileSync(externalPrompt, "EXTERNAL SDK FILE");

		const inline = track(
			new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: settings("off"),
				systemPrompt: "INLINE SYSTEM\nNOT A FILE",
				appendSystemPrompt: ["INLINE APPEND\nNOT A FILE"],
			}),
		);
		await inline.reload();
		expect(inline.getSystemPrompt()).toBe("INLINE SYSTEM\nNOT A FILE");
		expect(inline.getAppendSystemPrompt()).toEqual(["INLINE APPEND\nNOT A FILE"]);

		const external = track(
			new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: settings("off"),
				systemPrompt: externalPrompt,
				appendSystemPrompt: [externalPrompt],
			}),
		);
		await external.reload();
		expect(external.getSystemPrompt()).toBe("EXTERNAL SDK FILE");
		expect(external.getAppendSystemPrompt()).toEqual(["EXTERNAL SDK FILE"]);

		const onDemand = track(
			new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: settings("on-demand"),
				systemPrompt: projectPrompt,
				appendSystemPrompt: [projectPrompt],
			}),
		);
		await onDemand.reload();
		expect(onDemand.getSystemPrompt()).toBe("PROJECT ON DEMAND");
		expect(onDemand.getAppendSystemPrompt()).toEqual(["PROJECT ON DEMAND"]);
	});

	it("keeps remaining explicit append content after blocking a project path", async () => {
		writeGlobalPrompts();
		const projectPrompt = join(cwd, "providers", "blocked-append.md");
		mkdirSync(dirname(projectPrompt), { recursive: true });
		writeFileSync(projectPrompt, "PROJECT APPEND MUST STAY BLOCKED");
		const loader = track(
			new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: settings("off"),
				appendSystemPrompt: [projectPrompt, "INLINE APPEND REMAINS"],
			}),
		);
		await loader.reload();

		expect(loader.getAppendSystemPrompt()).toEqual(["INLINE APPEND REMAINS"]);
	});

	it("does not touch blocked prompt paths before applying caller-memory overrides", async () => {
		const projectDirectory = join(cwd, "providers", "override-source-directory");
		mkdirSync(projectDirectory, { recursive: true });
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const loader = track(
			new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: settings("off"),
				systemPrompt: projectDirectory,
				appendSystemPrompt: [projectDirectory],
				systemPromptOverride: () => "INLINE SYSTEM OVERRIDE",
				appendSystemPromptOverride: () => ["INLINE APPEND OVERRIDE"],
			}),
		);

		await loader.reload();

		expect(loader.getSystemPrompt()).toBe("INLINE SYSTEM OVERRIDE");
		expect(loader.getAppendSystemPrompt()).toEqual(["INLINE APPEND OVERRIDE"]);
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("blocks project-local explicit extensions, skills, and prompts before load while preserving external paths", async () => {
		const projectExtension = join(cwd, "sdk", "project-extension.ts");
		const externalExtension = join(root, "outside", "external-extension.ts");
		const projectExtensionSentinel = join(root, "project-extension-imported");
		const externalExtensionSentinel = join(root, "external-extension-imported");
		writeExtension(projectExtension, projectExtensionSentinel);
		writeExtension(externalExtension, externalExtensionSentinel);

		const projectSkillDirectory = join(root, ".pi", "skills", "project-sdk-skill");
		const externalSkillDirectory = join(root, "outside", "external-skills");
		writeSkillDirectory(projectSkillDirectory, "project-sdk-skill");
		writeSkillDirectory(externalSkillDirectory, "external-sdk-skill");

		const projectPromptDirectory = join(cwd, "sdk", "project-prompts");
		const externalPromptDirectory = join(root, "outside", "external-prompts");
		writePromptDirectory(projectPromptDirectory, "project-sdk-prompt");
		writePromptDirectory(externalPromptDirectory, "external-sdk-prompt");

		const loader = track(
			new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: settings("off", ["project-extension.ts", "external-extension.ts"]),
				additionalExtensionPaths: [projectExtension, externalExtension],
				additionalSkillPaths: [projectSkillDirectory, externalSkillDirectory],
				additionalPromptTemplatePaths: [projectPromptDirectory, externalPromptDirectory],
			}),
		);

		await loader.reload();

		expect(existsSync(projectExtensionSentinel)).toBe(false);
		expect(existsSync(externalExtensionSentinel)).toBe(true);
		const extensionPaths = loader.getExtensions().extensions.map((extension) => extension.path);
		expect(extensionPaths).not.toContain(projectExtension);
		expect(extensionPaths).toContain(externalExtension);
		const skillNames = loader.getSkills().skills.map((skill) => skill.name);
		const promptNames = loader.getPrompts().prompts.map((prompt) => prompt.name);
		expect(skillNames).not.toContain("project-sdk-skill");
		expect(skillNames).toContain("external-sdk-skill");
		expect(promptNames).not.toContain("project-sdk-prompt");
		expect(promptNames).toContain("external-sdk-prompt");
	});

	it("does not let a trusted external-resource root reclassify project instruction files", async () => {
		const externalRoot = join(root, "outside", "trusted-catalog");
		writeSkillDirectory(join(cwd, "skills", "project-trusted-root-skill"), "project-trusted-root-skill");
		writePromptDirectory(join(cwd, "prompts"), "project-trusted-root-prompt");
		writeSkillDirectory(join(externalRoot, "skills", "external-trusted-root-skill"), "external-trusted-root-skill");
		writePromptDirectory(join(externalRoot, "prompts"), "external-trusted-root-prompt");

		const createSettings = (projectContextFiles: "off" | "on-demand") =>
			SettingsManager.inMemory({
				projectContextFiles,
				externalResourceRoots: [cwd, externalRoot],
				trustedResourceRoots: [cwd, externalRoot],
			});
		const off = track(new DefaultResourceLoader({ cwd, agentDir, settingsManager: createSettings("off") }));
		await off.reload();

		const offSkills = off.getSkills().skills.map((skill) => skill.name);
		const offPrompts = off.getPrompts().prompts.map((prompt) => prompt.name);
		expect(offSkills).not.toContain("project-trusted-root-skill");
		expect(offSkills).toContain("external-trusted-root-skill");
		expect(offPrompts).not.toContain("project-trusted-root-prompt");
		expect(offPrompts).toContain("external-trusted-root-prompt");

		const onDemand = track(
			new DefaultResourceLoader({ cwd, agentDir, settingsManager: createSettings("on-demand") }),
		);
		await onDemand.reload();
		expect(onDemand.getSkills().skills.map((skill) => skill.name)).toContain("project-trusted-root-skill");
		expect(onDemand.getPrompts().prompts.map((prompt) => prompt.name)).toContain("project-trusted-root-prompt");
	});

	it("filters deferred project-file overrides but preserves materialized and external override data", async () => {
		const projectSkillPath = writeSkillDirectory(join(cwd, "overrides", "project-skill"), "project-override-skill");
		const externalSkillPath = writeSkillDirectory(join(root, "outside", "external-skill"), "external-override-skill");
		const projectPathOnly = join(cwd, "overrides", "PROJECT_RULES.md");
		const projectMaterialized = join(cwd, "overrides", "MATERIALIZED.md");
		const externalPathOnly = join(root, "outside", "EXTERNAL_RULES.md");
		writeFileSync(projectPathOnly, "PROJECT PATH ONLY");
		writeFileSync(projectMaterialized, "PROJECT FILE CONTENT THAT MUST NOT BE READ");
		writeFileSync(externalPathOnly, "EXTERNAL PATH ONLY");
		const projectPromptPath = join(cwd, "overrides", "materialized-prompt.md");
		writeFileSync(projectPromptPath, "PROJECT FILE CONTENT THAT MUST NOT BE READ");

		const loader = track(
			new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: settings("off"),
				skillsOverride: () => ({
					skills: [
						createSkill("project-override-skill", projectSkillPath),
						createSkill("external-override-skill", externalSkillPath),
					],
					diagnostics: [],
				}),
				promptsOverride: () => ({
					prompts: [
						{
							name: "materialized-project-prompt",
							description: "Caller materialized prompt",
							content: "INLINE MATERIALIZED PROMPT",
							filePath: projectPromptPath,
							sourceInfo: createSyntheticSourceInfo(projectPromptPath, { source: "custom" }),
						},
					],
					diagnostics: [],
				}),
				agentsFilesOverride: () => ({
					agentsFiles: [
						{ path: projectPathOnly },
						{ path: projectMaterialized, content: "INLINE MATERIALIZED CONTEXT" },
						{ path: externalPathOnly },
					],
				}),
			}),
		);

		await loader.reload();

		expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["external-override-skill"]);
		expect(loader.getPrompts().prompts).toMatchObject([
			{ name: "materialized-project-prompt", content: "INLINE MATERIALIZED PROMPT" },
		]);
		expect(loader.getAgentsFiles().agentsFiles).toEqual([
			{ path: projectMaterialized, content: "INLINE MATERIALIZED CONTEXT" },
			{ path: externalPathOnly },
		]);
	});

	it("enforces the same boundary through createAgentSessionServices resourceLoaderOptions", async () => {
		writeGlobalPrompts();
		const projectAgents = join(cwd, "AGENTS.md");
		writeFileSync(projectAgents, "PROJECT SDK SERVICE CONTENT");

		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager: settings("off"),
			resourceLoaderOptions: {
				systemPrompt: projectAgents,
				appendSystemPrompt: [projectAgents],
			},
		});
		const dispose = services.resourceLoader.dispose?.bind(services.resourceLoader);
		if (dispose) disposables.push({ dispose });

		expect(services.resourceLoader.getSystemPrompt()).toBe("GLOBAL SYSTEM");
		expect(services.resourceLoader.getAppendSystemPrompt()).toEqual(["GLOBAL APPEND"]);
	});

	it("excludes project paths from discoverable extension listings while preserving external and on-demand paths", async () => {
		const projectExtension = join(cwd, "sdk", "discoverable-project.ts");
		const externalExtension = join(root, "outside", "discoverable-external.ts");
		writeExtension(projectExtension, join(root, "discoverable-project-imported"));
		writeExtension(externalExtension, join(root, "discoverable-external-imported"));

		const off = track(
			new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: settings("off"),
				additionalExtensionPaths: [projectExtension, externalExtension],
			}),
		);
		const offPaths = await off.getDiscoverableExtensionPaths();
		expect.soft(offPaths).not.toContain(projectExtension);
		expect.soft(offPaths).toContain(externalExtension);

		const onDemand = track(
			new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: settings("on-demand"),
				additionalExtensionPaths: [projectExtension],
			}),
		);
		expect(await onDemand.getDiscoverableExtensionPaths()).toContain(projectExtension);
	});

	it("blocks loadSingleExtension before a project module is imported", async () => {
		const extensionPath = join(cwd, "sdk", "single-project.ts");
		const sentinel = join(root, "single-project-imported");
		writeExtension(extensionPath, sentinel);
		const loader = track(new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings("off") }));
		await loader.reload();

		const result = await loader.loadSingleExtension(extensionPath);

		expect(result.extension).toBeNull();
		expect(result.error).toMatch(/project context files are disabled/i);
		expect(existsSync(sentinel)).toBe(false);
	});

	it("blocks loadIsolatedExtension before a project module is imported", async () => {
		const extensionPath = join(cwd, "sdk", "isolated-project.ts");
		const sentinel = join(root, "isolated-project-imported");
		writeExtension(extensionPath, sentinel);
		const loader = track(new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings("off") }));
		await loader.reload();

		const result = await loader.loadIsolatedExtension(extensionPath, cwd);

		expect(result.extension).toBeNull();
		expect(result.error).toMatch(/project context files are disabled/i);
		expect(existsSync(sentinel)).toBe(false);
	});

	it("preserves direct extension imports for true external paths and on-demand mode", async () => {
		const externalExtension = join(root, "outside", "single-external.ts");
		const externalSentinel = join(root, "single-external-imported");
		const projectExtension = join(cwd, "sdk", "single-on-demand.ts");
		const projectSentinel = join(root, "single-on-demand-imported");
		writeExtension(externalExtension, externalSentinel);
		writeExtension(projectExtension, projectSentinel);

		const off = track(new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings("off") }));
		await off.reload();
		const externalResult = await off.loadSingleExtension(externalExtension);
		expect(externalResult.error).toBeNull();
		expect(externalResult.extension).not.toBeNull();
		expect(existsSync(externalSentinel)).toBe(true);

		const onDemand = track(new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings("on-demand") }));
		await onDemand.reload();
		const projectResult = await onDemand.loadSingleExtension(projectExtension);
		expect(projectResult.error).toBeNull();
		expect(projectResult.extension).not.toBeNull();
		expect(existsSync(projectSentinel)).toBe(true);
	});

	it("classifies extension-contributed skill and prompt paths independently of caller metadata", async () => {
		const projectSkillDirectory = join(cwd, "contributed", "project-skill");
		const projectPromptDirectory = join(cwd, "contributed", "project-prompts");
		const externalSkillDirectory = join(root, "outside", "contributed-external-skill");
		const externalPromptDirectory = join(root, "outside", "contributed-external-prompts");
		writeSkillDirectory(projectSkillDirectory, "contributed-project-skill");
		const projectPrompt = writePromptDirectory(projectPromptDirectory, "contributed-project-prompt");
		writeSkillDirectory(externalSkillDirectory, "contributed-external-skill");
		const externalPrompt = writePromptDirectory(externalPromptDirectory, "contributed-external-prompt");
		const metadata = (baseDir: string) => ({
			source: "extension:sdk-admission-test",
			scope: "user" as const,
			origin: "top-level" as const,
			baseDir,
		});
		const contributed = {
			skillPaths: [
				{ path: projectSkillDirectory, metadata: metadata(projectSkillDirectory) },
				{ path: externalSkillDirectory, metadata: metadata(externalSkillDirectory) },
			],
			promptPaths: [
				{ path: projectPrompt, metadata: metadata(projectPromptDirectory) },
				{ path: externalPrompt, metadata: metadata(externalPromptDirectory) },
			],
		};

		const off = track(new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings("off") }));
		await off.reload();
		off.extendResources(contributed);
		const offSkills = off.getSkills().skills.map((skill) => skill.name);
		const offPrompts = off.getPrompts().prompts.map((prompt) => prompt.name);
		expect.soft(offSkills).not.toContain("contributed-project-skill");
		expect.soft(offPrompts).not.toContain("contributed-project-prompt");
		expect.soft(offSkills).toContain("contributed-external-skill");
		expect.soft(offPrompts).toContain("contributed-external-prompt");

		const onDemand = track(new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings("on-demand") }));
		await onDemand.reload();
		onDemand.extendResources(contributed);
		expect(onDemand.getSkills().skills.map((skill) => skill.name)).toContain("contributed-project-skill");
		expect(onDemand.getPrompts().prompts.map((prompt) => prompt.name)).toContain("contributed-project-prompt");
	});

	it("admits the same project-local SDK resources when on-demand mode is enabled", async () => {
		const projectPrompt = join(cwd, "sdk", "on-demand-system.md");
		mkdirSync(dirname(projectPrompt), { recursive: true });
		writeFileSync(projectPrompt, "PROJECT ON DEMAND SYSTEM");
		const extensionPath = join(cwd, "sdk", "on-demand-extension.ts");
		const extensionSentinel = join(root, "on-demand-extension-imported");
		writeExtension(extensionPath, extensionSentinel);
		const skillDirectory = join(cwd, "sdk", "on-demand-skills");
		writeSkillDirectory(skillDirectory, "on-demand-sdk-skill");
		const promptDirectory = join(cwd, "sdk", "on-demand-prompts");
		writePromptDirectory(promptDirectory, "on-demand-sdk-prompt");
		const overrideSkillPath = writeSkillDirectory(
			join(cwd, "sdk", "on-demand-override-skill"),
			"on-demand-override-skill",
		);
		const agentsPath = join(cwd, "sdk", "ON_DEMAND_RULES.md");
		writeFileSync(agentsPath, "ON DEMAND PATH-ONLY CONTEXT");

		const loader = track(
			new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: settings("on-demand", ["on-demand-extension.ts"]),
				systemPrompt: projectPrompt,
				appendSystemPrompt: [projectPrompt],
				additionalExtensionPaths: [extensionPath],
				additionalSkillPaths: [skillDirectory],
				additionalPromptTemplatePaths: [promptDirectory],
				skillsOverride: (base) => ({
					skills: [...base.skills, createSkill("on-demand-override-skill", overrideSkillPath)],
					diagnostics: base.diagnostics,
				}),
				agentsFilesOverride: () => ({ agentsFiles: [{ path: agentsPath }] }),
			}),
		);

		await loader.reload();

		expect(loader.getSystemPrompt()).toBe("PROJECT ON DEMAND SYSTEM");
		expect(loader.getAppendSystemPrompt()).toEqual(["PROJECT ON DEMAND SYSTEM"]);
		expect(existsSync(extensionSentinel)).toBe(true);
		expect(loader.getExtensions().extensions.map((extension) => extension.path)).toContain(extensionPath);
		expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(
			expect.arrayContaining(["on-demand-sdk-skill", "on-demand-override-skill"]),
		);
		expect(loader.getPrompts().prompts.map((prompt) => prompt.name)).toContain("on-demand-sdk-prompt");
		expect(loader.getAgentsFiles().agentsFiles).toEqual([{ path: agentsPath }]);
	});
});
