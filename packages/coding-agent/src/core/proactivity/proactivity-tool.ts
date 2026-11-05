import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import { MAX_PROACTIVITY_PREFERENCES_CHARS } from "../settings/settings-rules.ts";
import type { ProactivitySettings, ResolvedProactivitySettings } from "../settings/settings-schema.ts";
import { operationTextResult as result } from "../tools/operation-result.ts";
import { withProactivityChange } from "./proactivity-settings.ts";

export const PROACTIVITY_TOOL_NAME = "proactivity";

/** The settings this tool reads and writes, declared by the tool itself; the composition root passes the SettingsManager. */
export interface ProactivityToolSettingsSource {
	getProactivitySettings(): ResolvedProactivitySettings;
	setProactivitySettings(settings: ProactivitySettings): void;
}

const parameters = Type.Object(
	{
		action: Type.Union(
			[
				Type.Literal("view"),
				Type.Literal("set_preferences"),
				Type.Literal("clear_preferences"),
				Type.Literal("turn_off"),
				Type.Literal("turn_on"),
			],
			{ description: "view: read the current setting. The others change it and need the owner's confirmation." },
		),
		text: Type.Optional(
			Type.String({
				maxLength: MAX_PROACTIVITY_PREFERENCES_CHARS,
				description:
					"set_preferences only: the whole standing preferences, replacing what is saved. Read them with view first and merge the change in.",
			}),
		),
	},
	{ additionalProperties: false },
);

function describe(settings: ResolvedProactivitySettings): string {
	return `Proactive review: ${settings.enabled ? "on" : "off"}. Preferences: ${settings.preferences.length > 0 ? settings.preferences : "none"}.`;
}

/**
 * How the owner shapes what the assistant raises unasked. A change is made only after the owner confirms it on their own
 * screen, so a run with no owner present (a worker, a print-mode run) cannot change it, and neither can a model that
 * decides to on its own: the confirmation is the host's, not the model's.
 */
export function createProactivityToolDefinition(getSettings: () => ProactivityToolSettingsSource): ToolDefinition {
	return defineTool({
		name: PROACTIVITY_TOOL_NAME,
		label: "Proactivity",
		description:
			"View or change how the assistant raises things the owner did not ask about. Call it when the owner states a standing wish about the tone or frequency of being interrupted, such as 'you check in too much', 'not at night' or 'stop reminding me about tests': read the current preferences with view, then set_preferences with the whole document merged with the change. A request to be told when something happens, or to check something on a schedule ('tell me when the changelog is stale'), is a routine: use the routine tool. The owner confirms every change on their own screen; with no owner present nothing changes. Never change it for any other reason.",
		parameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const settingsSource = getSettings();
			const current = settingsSource.getProactivitySettings();
			if (params.action === "view") return result(describe(current));
			if (!ctx.hasUI) return result("Nothing changed: owner confirmation is unavailable.", true);
			if (signal?.aborted) return result("Nothing changed: the request was cancelled.", true);
			const change = ((): { enabled?: boolean; preferences?: string; summary: string } | undefined => {
				switch (params.action) {
					case "turn_off":
						return { enabled: false, summary: "turn the proactive review off" };
					case "turn_on":
						return { enabled: true, summary: "turn the proactive review on" };
					case "clear_preferences":
						return { preferences: "", summary: "clear your standing proactivity preferences" };
					case "set_preferences": {
						const text = params.text?.trim() ?? "";
						return text.length === 0
							? undefined
							: { preferences: text, summary: `save these standing preferences: ${text}` };
					}
					default:
						return undefined;
				}
			})();
			if (change === undefined) return result("Nothing changed: set_preferences needs the text.", true);
			const confirmed = await ctx.ui.confirm("Proactivity", `Allow the assistant to ${change.summary}?`, { signal });
			if (signal?.aborted) return result("Nothing changed: the request was cancelled.", true);
			if (!confirmed) return result("Nothing changed: the owner did not confirm.", true);
			const latest = settingsSource.getProactivitySettings();
			if (
				(change.preferences !== undefined && latest.preferences !== current.preferences) ||
				(change.enabled !== undefined && latest.enabled !== current.enabled)
			) {
				return result(
					"Nothing changed: this setting changed during confirmation. Read it again before retrying.",
					true,
				);
			}
			settingsSource.setProactivitySettings(
				withProactivityChange(latest, {
					...(change.enabled === undefined ? {} : { enabled: change.enabled }),
					...(change.preferences === undefined ? {} : { preferences: change.preferences }),
				}),
			);
			return result(`Saved. ${describe(settingsSource.getProactivitySettings())}`);
		},
	}) as ToolDefinition;
}
