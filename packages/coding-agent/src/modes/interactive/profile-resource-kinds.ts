/**
 * The universe the library editor lists: every tool, skill, extension, agent file, prompt and theme the session can
 * discover, each with the description it carries. Discovery, not loading, so a resource the active profile blocks is
 * still listed and can be granted back.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSession } from "../../core/agent-session.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import { allToolNames } from "../../core/tools/index.ts";
import { getAvailableThemesWithPaths } from "../../presentation/theme/theme.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import type { ProfileResourceEditorKind } from "./components/profile-resource-editor.ts";

/** The last path segment, for a file on either kind of separator. */
function portableBasename(filePath: string): string {
	return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

/** What an extension is called in the library: its own description, its file name, or its folder. */
export function getProfileExtensionDisplayLabel(filePath: string, description?: string): string {
	const normalizedDescription = description?.trim();
	if (normalizedDescription) return normalizedDescription;
	const fileName = portableBasename(filePath);
	if (!/^index\.(?:ts|js)$/i.test(fileName)) return fileName;
	const parentPath = filePath.slice(0, Math.max(0, filePath.length - fileName.length)).replace(/[\\/]$/, "");
	return portableBasename(parentPath) || fileName;
}

/** The description a markdown file declares in its front matter, or nothing when it declares none. */
function frontmatterDescription(filePath: string): string | undefined {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
		if (typeof frontmatter.description === "string") return frontmatter.description;
	} catch {}
	return undefined;
}

/** The description a package.json beside an extension declares, or nothing when it declares none. */
function extensionDescription(filePath: string): string | undefined {
	try {
		let dir = filePath;
		if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
			dir = path.dirname(filePath);
		}
		const pkgPath = path.join(dir, "package.json");
		if (fs.existsSync(pkgPath)) {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
			if (typeof pkg.description === "string") {
				return pkg.description;
			}
		}
	} catch {}
	return undefined;
}

/** The id a skill file is known by: its folder for a SKILL.md, otherwise its own file name. */
function skillIdFromPath(skillPath: string): string {
	const parts = skillPath.split(/[\\/]/);
	const last = parts.pop() ?? skillPath;
	if (/^skill\.md$/i.test(last)) return parts.pop() ?? last;
	return last.replace(/\.md$/i, "");
}

/**
 * The six kinds the editor walks, each with its whole universe. The editor's universe must be profile-INDEPENDENT
 * (discovery, not loading): the loaded getters are narrowed by the active profile, so building the lists from them
 * alone makes currently-blocked skills, prompts and context files ungrantable. The loaded sets carry the rich metadata,
 * so they are unioned with the full pre-filter discovery paths.
 */
export async function profileResourceKinds(session: AgentSession): Promise<ProfileResourceEditorKind[]> {
	const loader = session.resourceLoader;
	const base = portableBasename;
	const allDiscoverableExtensions = await loader.getDiscoverableExtensionPaths();
	const loadedSkills = loader.getSkills().skills;
	const loadedSkillPaths = new Set(loadedSkills.map((skill) => skill.filePath));
	const skills = [
		...loadedSkills.map((skill) => ({ id: skill.name, path: skill.filePath, description: skill.description })),
		...loader
			.getDiscoverableSkillPaths()
			.filter((skillPath) => !loadedSkillPaths.has(skillPath))
			.map((skillPath) => ({
				id: skillIdFromPath(skillPath),
				path: skillPath,
				description: frontmatterDescription(skillPath),
			})),
	];
	const loadedPrompts = loader.getPrompts().prompts;
	const loadedPromptPaths = new Set(loadedPrompts.map((prompt) => prompt.filePath));
	const prompts = [
		...loadedPrompts.map((prompt) => ({
			id: prompt.name,
			path: prompt.filePath,
			description: prompt.description,
		})),
		...loader
			.getDiscoverablePromptPaths()
			.filter((promptPath) => !loadedPromptPaths.has(promptPath))
			.map((promptPath) => ({
				id: (promptPath.split(/[\\/]/).pop() ?? promptPath).replace(/\.md$/i, ""),
				path: promptPath,
				description: frontmatterDescription(promptPath),
			})),
	];
	const themes = getAvailableThemesWithPaths();
	const loadedAgentPaths = new Set(loader.getAgentsFiles().agentsFiles.map((file) => file.path));
	const agents = [
		...loader.getAgentsFiles().agentsFiles.map((file) => ({ path: file.path })),
		...loader
			.getDiscoverableAgentsFilePaths()
			.filter((agentPath) => !loadedAgentPaths.has(agentPath))
			.map((agentPath) => ({ path: agentPath })),
	];
	const kinds = interfaceText().profilesScreen.editor.kinds;

	return [
		{
			kind: "tools",
			label: kinds.tools,
			// Built-ins plus every currently registered tool (extension tools included), so an extension tool can be
			// granted by name without hand-editing settings JSON.
			items: [...new Set([...allToolNames, ...session.getAllTools().map((tool) => tool.name)])].map(
				(name: string) => ({ id: name }),
			),
		},
		{
			kind: "skills",
			label: kinds.skills,
			items: skills,
		},
		{
			kind: "extensions",
			label: kinds.extensions,
			items: allDiscoverableExtensions.map((extensionPath) => {
				const description = extensionDescription(extensionPath);
				return {
					id: path.resolve(extensionPath),
					label: getProfileExtensionDisplayLabel(extensionPath, description),
					path: extensionPath,
					description,
				};
			}),
		},
		{
			kind: "agents",
			label: kinds.agents,
			items: agents.map((file) => ({
				id: base(file.path),
				path: file.path,
				description: frontmatterDescription(file.path),
			})),
		},
		{
			kind: "prompts",
			label: kinds.prompts,
			items: prompts,
		},
		{
			kind: "themes",
			label: kinds.themes,
			items: themes.map((theme) => ({
				id: theme.name,
				path: theme.path,
			})),
		},
	];
}
