import * as path from "node:path";
import { type Container, Spacer, Text } from "@caupulican/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ExtensionRunner } from "../../core/extensions/index.ts";
import type { ResourceDiagnostic } from "../../core/resource-loader.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import type { SessionManager } from "../../kernel/node.ts";
import { type ThemeColor, theme } from "../../presentation/theme-model.ts";
import { getCwdRelativePath } from "../../utils/paths.ts";
import { ExpandableText } from "./components/expandable-text.ts";
import * as resourceDisplay from "./resource-display.ts";

export interface LoadedResourcesViewHost {
	session: AgentSession;
	sessionManager: Pick<SessionManager, "getCwd">;
	settingsManager: Pick<SettingsManager, "getQuietStartup">;
	extensionRunner: Pick<ExtensionRunner, "getRegisteredCommands" | "getCommandDiagnostics" | "getShortcutDiagnostics">;
	chatContainer: Container;
	verbose: boolean;
	expanded: boolean;
}

export interface LoadedResourcesViewOptions {
	extensions?: Array<{ path: string; sourceInfo?: SourceInfo }>;
	force?: boolean;
	showDiagnosticsWhenQuiet?: boolean;
}

function getBuiltInCommandConflictDiagnostics(host: LoadedResourcesViewHost): ResourceDiagnostic[] {
	const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
	return host.extensionRunner
		.getRegisteredCommands()
		.filter((command) => builtinNames.has(command.name))
		.map((command) => ({
			type: "warning" as const,
			message:
				command.invocationName === command.name
					? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
					: `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
			path: command.sourceInfo.path,
		}));
}

function formatContextPath(host: LoadedResourcesViewHost, value: string): string {
	const cwd = path.resolve(host.sessionManager.getCwd());
	const absolutePath = path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
	return getCwdRelativePath(absolutePath, cwd) ?? resourceDisplay.formatDisplayPath(absolutePath);
}

/** Render startup resources and diagnostics without making InteractiveMode own their formatting rules. */
export function renderLoadedResources(host: LoadedResourcesViewHost, options: LoadedResourcesViewOptions = {}): void {
	const settingsManager = host.settingsManager;
	const resourceLoader = host.session.resourceLoader;
	const showListing = options.force || host.verbose || !settingsManager.getQuietStartup();
	const showDiagnostics = showListing || options.showDiagnosticsWhenQuiet === true;
	if (!showListing && !showDiagnostics) return;

	const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);
	const formatCompactList = (items: string[], listOptions?: { sort?: boolean }): string => {
		const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
		if (listOptions?.sort !== false) labels.sort((a, b) => a.localeCompare(b));
		return theme.fg("dim", `  ${labels.join(", ")}`);
	};
	const addLoadedSection = (
		name: string,
		collapsedBody: string,
		expandedBody = collapsedBody,
		color: ThemeColor = "mdHeading",
	): void => {
		host.chatContainer.addChild(
			new ExpandableText(
				() => `${sectionHeader(name, color)}\n${collapsedBody}`,
				() => `${sectionHeader(name, color)}\n${expandedBody}`,
				host.expanded,
			),
		);
		host.chatContainer.addChild(new Spacer(1));
	};

	const skillsResult = resourceLoader.getSkills();
	const promptsResult = resourceLoader.getPrompts();
	const themesResult = resourceLoader.getThemes();
	const extensions =
		options.extensions ??
		resourceLoader.getExtensions().extensions.map((extension) => ({
			path: extension.path,
			sourceInfo: extension.sourceInfo,
		}));
	const sourceInfos = new Map<string, SourceInfo>();
	for (const extension of extensions) {
		if (extension.sourceInfo) sourceInfos.set(extension.path, extension.sourceInfo);
	}
	for (const skill of skillsResult.skills) {
		if (skill.sourceInfo) sourceInfos.set(skill.filePath, skill.sourceInfo);
	}
	for (const prompt of promptsResult.prompts) {
		if (prompt.sourceInfo) sourceInfos.set(prompt.filePath, prompt.sourceInfo);
	}
	for (const loadedTheme of themesResult.themes) {
		if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
			sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
		}
	}

	if (showListing) {
		const contextFiles = resourceLoader.getAgentsFiles().agentsFiles;
		if (contextFiles.length > 0) {
			host.chatContainer.addChild(new Spacer(1));
			const contextList = contextFiles
				.map((file) => theme.fg("dim", `  ${resourceDisplay.formatDisplayPath(file.path)}`))
				.join("\n");
			addLoadedSection(
				"Context",
				formatCompactList(
					contextFiles.map((file) => formatContextPath(host, file.path)),
					{ sort: false },
				),
				contextList,
			);
		}

		const skills = resourceLoader.getActiveSkills();
		if (skills.length > 0) {
			const groups = resourceDisplay.buildScopeGroups(
				skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
			);
			const skillList = resourceDisplay.formatScopeGroups(groups, {
				formatPath: (item) => resourceDisplay.formatDisplayPath(item.path),
				formatPackagePath: (item) => resourceDisplay.getShortPath(item.path, item.sourceInfo),
			});
			addLoadedSection("Skills", formatCompactList(skills.map((skill) => skill.name)), skillList);
		}

		const templates = host.session.promptTemplates;
		if (templates.length > 0) {
			const groups = resourceDisplay.buildScopeGroups(
				templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
			);
			const templateByPath = new Map(templates.map((template) => [template.filePath, template]));
			const templateList = resourceDisplay.formatScopeGroups(groups, {
				formatPath: (item) => {
					const template = templateByPath.get(item.path);
					return template ? `/${template.name}` : resourceDisplay.formatDisplayPath(item.path);
				},
				formatPackagePath: (item) => {
					const template = templateByPath.get(item.path);
					return template ? `/${template.name}` : resourceDisplay.formatDisplayPath(item.path);
				},
			});
			addLoadedSection("Prompts", formatCompactList(templates.map((template) => `/${template.name}`)), templateList);
		}

		if (extensions.length > 0) {
			const groups = resourceDisplay.buildScopeGroups(extensions);
			const extensionList = resourceDisplay.formatScopeGroups(groups, {
				formatPath: (item) => resourceDisplay.formatExtensionDisplayPath(item.path),
				formatPackagePath: (item) =>
					resourceDisplay.formatExtensionDisplayPath(resourceDisplay.getShortPath(item.path, item.sourceInfo)),
			});
			addLoadedSection(
				"Extensions",
				formatCompactList(resourceDisplay.getCompactExtensionLabels(extensions)),
				extensionList,
			);
		}

		const customThemes = themesResult.themes.filter((loadedTheme) => loadedTheme.sourcePath);
		if (customThemes.length > 0) {
			const groups = resourceDisplay.buildScopeGroups(
				customThemes.map((loadedTheme) => ({
					path: loadedTheme.sourcePath!,
					sourceInfo: loadedTheme.sourceInfo,
				})),
			);
			const themeList = resourceDisplay.formatScopeGroups(groups, {
				formatPath: (item) => resourceDisplay.formatDisplayPath(item.path),
				formatPackagePath: (item) => resourceDisplay.getShortPath(item.path, item.sourceInfo),
			});
			addLoadedSection(
				"Themes",
				formatCompactList(
					customThemes.map(
						(loadedTheme) =>
							loadedTheme.name ??
							resourceDisplay.getCompactPathLabel(loadedTheme.sourcePath!, loadedTheme.sourceInfo),
					),
				),
				themeList,
			);
		}
	}

	if (!showDiagnostics) return;
	const addDiagnostics = (name: string, diagnostics: readonly ResourceDiagnostic[]): void => {
		if (diagnostics.length === 0) return;
		const warningLines = resourceDisplay.formatDiagnostics(diagnostics, sourceInfos);
		host.chatContainer.addChild(new Text(`${theme.fg("warning", `[${name}]`)}\n${warningLines}`, 0, 0));
		host.chatContainer.addChild(new Spacer(1));
	};
	addDiagnostics("Skill conflicts", skillsResult.diagnostics);
	addDiagnostics("Prompt conflicts", promptsResult.diagnostics);

	const extensionDiagnostics: ResourceDiagnostic[] = resourceLoader
		.getExtensions()
		.errors.map((error) => ({ type: "error", message: error.error, path: error.path }));
	extensionDiagnostics.push(...host.extensionRunner.getCommandDiagnostics());
	extensionDiagnostics.push(...getBuiltInCommandConflictDiagnostics(host));
	extensionDiagnostics.push(...host.extensionRunner.getShortcutDiagnostics());
	addDiagnostics("Extension issues", extensionDiagnostics);
	addDiagnostics("Theme conflicts", themesResult.diagnostics);
}
