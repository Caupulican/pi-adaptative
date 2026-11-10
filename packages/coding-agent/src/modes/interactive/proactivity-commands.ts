/**
 * `/proactivity`: direct owner controls over the idle review. Model proposals use the separate proactivity tool,
 * which requires confirmation on the owner's screen before changing the switch or standing preferences.
 */

import type { AgentSession } from "../../core/agent-session.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import type { ParentWakeDelivery } from "../../core/proactivity/proactivity-controller.ts";
import { withProactivityChange } from "../../core/proactivity/proactivity-settings.ts";
import { MAX_PROACTIVITY_PREFERENCES_CHARS } from "../../core/settings/settings-rules.ts";
import type {
	ProactivitySettings,
	ResolvedProactivitySettings,
	SettingsScope,
} from "../../core/settings/settings-schema.ts";
import { harnessLog } from "../../kernel/harness-log.ts";
import { plainLabel } from "../../presentation/plain-text.ts";

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

export function formatProactivityStatus(host: Pick<ProactivityHost, "settingsManager" | "session">): string {
	const words = interfaceText().autonomyCommands.proactivity;
	const settings = host.settingsManager.getProactivitySettings();
	const lanes = host.session.backgroundLanes;
	const skip = lanes.getLastProactivitySkipReason();
	const { measured, lastDelivery, lastEventDelivery } = lanes.getProactivityDailyState();
	const intake = lanes.getRoutineIntakeStatus();
	const { suppressed } = lanes.getProactivityFeedbackState();
	harnessLog.debug("ui", "proactivity status reads gate and hold codes", {
		skip,
		intakeReason: intake?.reason,
		lastDeliveryHold: lastDelivery?.hold,
		lastEventDeliveryHold: lastEventDelivery?.hold,
	});
	const delivered = (delivery: ParentWakeDelivery) =>
		delivery.mode === "turn"
			? words.wokeParent
			: delivery.hold === undefined
				? words.waitsForOwner
				: words.waitsForOwnerHeld(plainLabel(delivery.hold));
	const intakeState =
		intake === undefined
			? []
			: [
					words.intake(
						intake.state === "active"
							? words.intakeOn
							: words.intakeOff(
									intake.reason === undefined ? "" : words.intakeReason(plainLabel(intake.reason)),
								),
						intake.judge === undefined ? "" : words.intakeJudgedBy(intake.judge),
						intake.spentUsd.toFixed(4),
						intake.sessionMaxUsd.toFixed(2),
						intake.last === undefined
							? ""
							: words.intakeLast(
									intake.last.status,
									intake.last.sources,
									intake.last.created,
									intake.last.refused,
								),
					),
				];
	return [
		words.on(settings.enabled),
		words.reviewBounds(
			Math.round(settings.idleDelayMs / 1000),
			settings.minOwnerTurnsBetweenRuns,
			settings.maxRunsPerSession,
			settings.maxNotesPerRun,
			settings.maxUsd.toFixed(2),
		),
		words.dailyBounds(settings.maxUsdPerDay.toFixed(2), settings.maxTurnWakesPerDay),
		words.delivery(settings.delivery === "turn"),
		words.preferences(settings.preferences.length > 0 ? settings.preferences : words.none),
		words.ciEvents(settings.ciEvents),
		...intakeState,
		...(measured === undefined
			? []
			: [words.lastMeasured(measured.reviewUsd.toFixed(4), measured.turnWakes, measured.eventWakes)]),
		...suppressed.map((topic) => words.setAside(topic.label, new Date(topic.until).toISOString())),
		...(skip === undefined ? [] : [words.lastGate(plainLabel(skip))]),
		...(lastDelivery === undefined ? [] : [words.lastNoteDelivery(delivered(lastDelivery))]),
		...(lastEventDelivery === undefined ? [] : [words.lastEventDelivery(delivered(lastEventDelivery))]),
	].join("\n");
}

export function handleProactivityCommand(host: ProactivityHost, text: string): void {
	const labels = interfaceText().autonomyCommands.proactivity;
	const action = text.slice("/proactivity".length).trim() || "status";
	const settings = host.settingsManager.getProactivitySettings();
	if (action === "status") {
		host.showStatus(formatProactivityStatus(host));
		return;
	}
	if (action === "on" || action === "off") {
		host.settingsManager.setProactivitySettings(withProactivityChange(settings, { enabled: action === "on" }));
		host.showStatus(action === "on" ? labels.switchedOn : labels.switchedOff);
		return;
	}
	if (action === "review") {
		host.showStatus(labels.reviewRunning);
		void host.session.backgroundLanes
			.runProactiveReviewOnce()
			.then((outcome) => {
				if (!outcome.started) {
					harnessLog.debug("ui", "proactive review skipped", { skipReason: outcome.skipReason });
					host.showStatus(labels.reviewSkipped(plainLabel(outcome.skipReason ?? "unknown")));
					return;
				}
				if (outcome.deliveryHold !== undefined)
					harnessLog.debug("ui", "proactive review notes held", { deliveryHold: outcome.deliveryHold });
				host.showStatus(
					outcome.delivered.length === 0
						? labels.reviewNothing
						: `${labels.reviewRaised(outcome.delivered.length)}${
								outcome.deliveryHold === undefined ? "." : labels.reviewHeld(plainLabel(outcome.deliveryHold))
							}`,
				);
			})
			.catch((error: unknown) => {
				host.showStatus(labels.reviewFailed(error instanceof Error ? error.message : String(error)));
			});
		return;
	}
	if (action === "prefs" || action.startsWith("prefs ")) {
		const words = action.slice("prefs".length).trim();
		if (words.length === 0) {
			host.showStatus(
				settings.preferences.length > 0 ? labels.preferencesShown(settings.preferences) : labels.noPreferences,
			);
			return;
		}
		if (words === "clear") {
			host.settingsManager.setProactivitySettings(withProactivityChange(settings, { preferences: "" }));
			host.showStatus(labels.cleared);
			return;
		}
		if (words.length > MAX_PROACTIVITY_PREFERENCES_CHARS) {
			host.showStatus(labels.preferencesTooLong(MAX_PROACTIVITY_PREFERENCES_CHARS, words.length));
			return;
		}
		host.settingsManager.setProactivitySettings(withProactivityChange(settings, { preferences: words }));
		host.showStatus(labels.preferencesSaved(words));
		return;
	}
	host.showStatus(labels.usage);
}
