/**
 * Autocomplete-provider construction extracted from interactive-mode.
 *
 * `createBaseAutocompleteProvider` assembles the slash-command/model/template/
 * extension/skill completion set for the editor; the source-tag helpers annotate
 * completions with their scope/origin. It reads session/settings state and
 * repopulates the shared `skillCommands` map through a narrow host seam;
 * interactive-mode keeps `setupAutocompleteProvider` (which applies the wrapper
 * chain and installs the provider on the editors) host-side.
 */

import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { AutocompleteItem, AutocompleteProvider, SlashCommand } from "@caupulican/pi-tui";
import { CombinedAutocompleteProvider, fuzzyFilter } from "@caupulican/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import { parseGitUrl } from "../../utils/git.ts";

export interface AutocompleteProviderHost {
	readonly session: AgentSession;
	readonly settingsManager: Pick<SettingsManager, "getEnableSkillCommands">;
	readonly sessionManager: Pick<SessionManager, "getCwd">;
	readonly fdPath: string | undefined;
	readonly skillCommands: Map<string, string>;
}

export function getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined {
	if (!sourceInfo) {
		return undefined;
	}

	const scopePrefix = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
	const source = sourceInfo.source.trim();

	if (source === "auto" || source === "local" || source === "cli") {
		return scopePrefix;
	}

	if (source.startsWith("npm:")) {
		return `${scopePrefix}:${source}`;
	}

	const gitSource = parseGitUrl(source);
	if (gitSource) {
		const ref = gitSource.ref ? `@${gitSource.ref}` : "";
		return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
	}

	return scopePrefix;
}

export function prefixAutocompleteDescription(
	description: string | undefined,
	sourceInfo?: SourceInfo,
): string | undefined {
	const sourceTag = getAutocompleteSourceTag(sourceInfo);
	if (!sourceTag) {
		return description;
	}
	return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
}

export function createBaseAutocompleteProvider(host: AutocompleteProviderHost): AutocompleteProvider {
	// Define commands for autocomplete
	const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
		name: command.name,
		description: command.description,
	}));

	const modelCommand = slashCommands.find((command) => command.name === "model");
	if (modelCommand) {
		modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
			// Get available models (scoped or from registry)
			const models =
				host.session.scopedModels.length > 0
					? host.session.scopedModels.map((s) => s.model)
					: host.session.modelRegistry.getAvailable();

			if (models.length === 0) return null;

			// Create items with provider/id format
			const items = models.map((m) => ({
				id: m.id,
				provider: m.provider,
				label: `${m.provider}/${m.id}`,
			}));

			// Fuzzy filter by model ID + provider (allows "opus anthropic" to match)
			const filtered = fuzzyFilter(items, prefix, (item) => `${item.id} ${item.provider}`);

			if (filtered.length === 0) return null;

			return filtered.map((item) => ({
				value: item.label,
				label: item.id,
				description: item.provider,
			}));
		};
	}

	// Convert prompt templates to SlashCommand format for autocomplete
	const templateCommands: SlashCommand[] = host.session.promptTemplates.map((cmd) => ({
		name: cmd.name,
		description: prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
		...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
	}));

	// Convert extension commands to SlashCommand format
	const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
	const extensionCommands: SlashCommand[] = host.session.extensionRunner
		.getRegisteredCommands()
		.filter((cmd) => !builtinCommandNames.has(cmd.name))
		.map((cmd) => ({
			name: cmd.invocationName,
			description: prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
			getArgumentCompletions: cmd.getArgumentCompletions,
		}));

	// Build skill commands from session.skills (if enabled)
	host.skillCommands.clear();
	const skillCommandList: SlashCommand[] = [];
	if (host.settingsManager.getEnableSkillCommands()) {
		for (const skill of host.session.resourceLoader.getActiveSkills()) {
			const commandName = `skill:${skill.name}`;
			host.skillCommands.set(commandName, skill.filePath);
			skillCommandList.push({
				name: commandName,
				description: prefixAutocompleteDescription(skill.description, skill.sourceInfo),
			});
		}
	}

	return new CombinedAutocompleteProvider(
		[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
		host.sessionManager.getCwd(),
		host.fdPath,
	);
}
