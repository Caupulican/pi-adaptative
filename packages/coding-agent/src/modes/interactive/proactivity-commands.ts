/**
 * `/proactivity`: the owner's controls over the idle review that raises notes. Typed at the prompt, so only the owner
 * can use it: the on/off switch and the standing preferences are never writable from a model turn or an unattended run.
 */

import type { AgentSession } from "../../core/agent-session.ts";
import { MAX_PROACTIVITY_PREFERENCES_CHARS } from "../../core/settings/settings-rules.ts";
import type {
	ProactivitySettings,
	ResolvedProactivitySettings,
	SettingsScope,
} from "../../core/settings/settings-schema.ts";

/** The settings this module reads and writes, declared by the module itself; the composition root passes the SettingsManager. */
export interface ProactivityCommandsSettingsSource {
	getProactivitySettings(): ResolvedProactivitySettings;
	setProactivitySettings(settings: ProactivitySettings, scope?: SettingsScope): void;
}

export interface ProactivityHost {
	readonly session: Pick<AgentSession, "backgroundLanes">;
	readonly settingsManager: ProactivityCommandsSettingsSource;
	showStatus(message: string): void;
}

const USAGE = "Usage: /proactivity [status|on|off|review|prefs <text>|prefs clear]";

/** The owner's settings with one field changed; every other field stays as it resolves now. */
function withChange(settings: ResolvedProactivitySettings, change: Partial<ProactivitySettings>): ProactivitySettings {
	return {
		enabled: settings.enabled,
		idleDelayMs: settings.idleDelayMs,
		minOwnerTurnsBetweenRuns: settings.minOwnerTurnsBetweenRuns,
		maxRunsPerSession: settings.maxRunsPerSession,
		maxUsd: settings.maxUsd,
		maxNotesPerRun: settings.maxNotesPerRun,
		delivery: settings.delivery,
		preferences: settings.preferences,
		...(settings.model === undefined ? {} : { model: settings.model }),
		...change,
	};
}

export function formatProactivityStatus(host: Pick<ProactivityHost, "settingsManager" | "session">): string {
	const settings = host.settingsManager.getProactivitySettings();
	const skip = host.session.backgroundLanes.getLastProactivitySkipReason();
	return [
		`Proactivity: ${settings.enabled ? "on" : "off"}`,
		`Review after ${Math.round(settings.idleDelayMs / 1000)}s idle, at least ${settings.minOwnerTurnsBetweenRuns} new owner turn(s) apart, ${settings.maxRunsPerSession} per session, up to ${settings.maxNotesPerRun} note(s), $${settings.maxUsd.toFixed(2)} bound per review.`,
		`Delivery: ${settings.delivery === "turn" ? "wakes a turn" : "a visible note with the next turn"}`,
		`Preferences: ${settings.preferences.length > 0 ? settings.preferences : "none"}`,
		...(skip === undefined ? [] : [`Last gate: ${skip}`]),
	].join("\n");
}

export function handleProactivityCommand(host: ProactivityHost, text: string): void {
	const action = text.slice("/proactivity".length).trim() || "status";
	const settings = host.settingsManager.getProactivitySettings();
	if (action === "status") {
		host.showStatus(formatProactivityStatus(host));
		return;
	}
	if (action === "on" || action === "off") {
		host.settingsManager.setProactivitySettings(withChange(settings, { enabled: action === "on" }));
		host.showStatus(
			action === "on" ? "Proactivity on: idle reviews may raise notes." : "Proactivity off: no idle review runs.",
		);
		return;
	}
	if (action === "review") {
		host.showStatus("Proactive review: running…");
		void host.session.backgroundLanes
			.runProactiveReviewOnce()
			.then((outcome) => {
				if (!outcome.started) {
					host.showStatus(`Proactive review skipped: ${outcome.skipReason ?? "unknown"}`);
					return;
				}
				host.showStatus(
					outcome.delivered.length === 0
						? "Proactive review: nothing to raise."
						: `Proactive review raised ${outcome.delivered.length} note(s).`,
				);
			})
			.catch((error: unknown) => {
				host.showStatus(`Proactive review failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		return;
	}
	if (action === "prefs" || action.startsWith("prefs ")) {
		const words = action.slice("prefs".length).trim();
		if (words.length === 0) {
			host.showStatus(
				settings.preferences.length > 0
					? `Preferences: ${settings.preferences}`
					: "No proactivity preferences are saved.",
			);
			return;
		}
		if (words === "clear") {
			host.settingsManager.setProactivitySettings(withChange(settings, { preferences: "" }));
			host.showStatus("Cleared. No proactivity preferences are saved.");
			return;
		}
		if (words.length > MAX_PROACTIVITY_PREFERENCES_CHARS) {
			host.showStatus(
				`Nothing changed: preferences are at most ${MAX_PROACTIVITY_PREFERENCES_CHARS} characters; that one is ${words.length}.`,
			);
			return;
		}
		host.settingsManager.setProactivitySettings(withChange(settings, { preferences: words }));
		host.showStatus(`Saved. Every review reads: ${words}`);
		return;
	}
	host.showStatus(USAGE);
}
