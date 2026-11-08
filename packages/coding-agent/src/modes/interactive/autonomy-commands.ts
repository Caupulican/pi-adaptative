/**
 * `/autonomy` and `/auto-learn` command bodies extracted from interactive-mode.
 *
 * These render the autonomy/auto-learn status blocks and dispatch the autonomy
 * sub-actions (mode presets, diagnostics, rollback, one-off fitness/research
 * lanes) through a narrow `AutonomyHost` seam. `applyAutonomyMode`,
 * `launchAutoLearn`, and the auto-learn getters stay host-side (shared with the
 * settings selector and AutoLearnController); interactive-mode keeps thin
 * delegating wrappers.
 */

import type { Container, TUI } from "@caupulican/pi-tui";
import { Spacer, Text } from "@caupulican/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import { formatAutonomyDiagnostics } from "../../core/autonomy/status.ts";
import type {
	AutoLearnSettings,
	AutonomyMode,
	AutonomySettings,
	SettingsScope,
} from "../../core/settings/settings-schema.ts";
import { harnessLog } from "../../kernel/harness-log.ts";
import { plainLabel } from "../../presentation/plain-text.ts";
import { AUTONOMY_MODES, type AutoLearnState } from "./auto-learn-controller.ts";
import { presentModelFitnessOutcome } from "./model-fitness-presentation.ts";

/** The settings this module reads, declared by the module itself; the composition root passes the SettingsManager. */
export interface AutonomyCommandsSettingsSource {
	getAutonomySettings(): Required<AutonomySettings>;
}

export interface AutonomyHost {
	readonly session: AgentSession;
	readonly settingsManager: AutonomyCommandsSettingsSource;
	readonly chatContainer: Container;
	readonly ui: TUI;
	showStatus(message: string): void;
	applyAutonomyMode(mode: AutonomyMode, scope?: SettingsScope): void;
	launchAutoLearn(
		reason: string,
		force?: boolean,
		options?: {
			cooldownKind?: "auto" | "reflection";
			promptKind?: "auto" | "reflection";
			turnDigest?: string;
			bypassReflectionCooldown?: boolean;
		},
	): string;
	formatAutoLearnStatus(): string;
	getEffectiveAutoLearnSettings(): Required<AutoLearnSettings>;
	getPrunedAutoLearnState(): AutoLearnState;
	getAutoLearnTenantKey(): string;
	getAutoLearnDataDir(): string;
	getAutoLearnTenantDataDir(): string;
}

export function formatAutonomyStatus(
	host: Pick<
		AutonomyHost,
		| "settingsManager"
		| "getEffectiveAutoLearnSettings"
		| "getPrunedAutoLearnState"
		| "getAutoLearnTenantKey"
		| "getAutoLearnDataDir"
		| "getAutoLearnTenantDataDir"
	>,
): string {
	const autonomy = host.settingsManager.getAutonomySettings();
	const settings = host.getEffectiveAutoLearnSettings();
	const autoLearnState = host.getPrunedAutoLearnState();
	const tenant = host.getAutoLearnTenantKey();
	const running = Object.entries(autoLearnState.runs ?? {}).filter(([, run]) => run.tenant === tenant);
	const otherTenantRunning = Object.values(autoLearnState.runs ?? {}).filter((run) => run.tenant !== tenant).length;
	const safety =
		autonomy.mode === "full"
			? "read-only learners return proposals; this session applies eligible memory, skill and autoLearn tuning entries and records extension, source and ineligible entries as findings"
			: "proposal-gated outside configured high-confidence memory policy";
	const reflectionLine =
		autonomy.mode === "full"
			? `Reflection cue: ${settings.reflectionReview ? "enabled" : "disabled"}; root-only durable cue for the next ordinary turn; cooldown=${settings.reflectionCooldownMinutes}m`
			: `Reflection cue: ${settings.reflectionReview ? "enabled" : "disabled"}; tool trigger=${settings.reflectionMinToolCalls}; next ordinary turn; cooldown=${settings.reflectionCooldownMinutes}m`;
	return [
		"Autonomy status",
		`Mode: ${autonomy.mode}${autonomy.mode === "full" ? " (standing autonomy)" : ""}`,
		`Goal loop rounds: ${autonomy.maxStallTurns}`,
		`Auto Learn: ${settings.enabled ? "enabled" : "disabled"}; model=${settings.model}; applyHighConfidence=${settings.applyHighConfidence}`,
		`Long-session trigger: ${settings.longSessionMessages} messages or ${settings.longSessionContextPercent}% context; cooldown=${settings.cooldownMinutes}m`,
		reflectionLine,
		`Running learners: ${running.length}/${settings.maxConcurrentLearners}`,
		`Learners of other projects: ${otherTenantRunning}`,
		"History retention: 7 days for internal Auto Learn prompts/logs/sessions",
		`Learning authority: ${safety}`,
		"Execution authority: /edge list (independent of learning preset)",
		`Audit/log dir: ${host.getAutoLearnDataDir()}`,
		`Artifact folder: ${host.getAutoLearnTenantDataDir()}`,
		"Use /autonomy off|safe|balanced|full to switch presets. Advanced overrides remain in /settings → Auto Learn Advanced.",
	].join("\n");
}

export function handleAutonomyCommand(host: AutonomyHost, text: string): void {
	const action = text.slice("/autonomy".length).trim() || "status";
	if (AUTONOMY_MODES.includes(action as AutonomyMode)) {
		const mode = action as AutonomyMode;
		host.applyAutonomyMode(mode);
		host.showStatus(`Autonomy mode set to ${mode}${mode === "full" ? " (standing autonomy)" : ""}.`);
		return;
	}
	if (action === "status") {
		host.chatContainer.addChild(new Spacer(1));
		host.chatContainer.addChild(new Text(formatAutonomyStatus(host), 1, 0));
		host.ui.requestRender();
		return;
	}
	if (action === "diagnostics") {
		host.chatContainer.addChild(new Spacer(1));
		host.chatContainer.addChild(
			new Text(formatAutonomyDiagnostics(host.session.getAutonomyDiagnosticSnapshot()), 1, 0),
		);
		host.ui.requestRender();
		return;
	}
	if (action.startsWith("rollback")) {
		const auditId = action.slice("rollback".length).trim();
		if (!auditId) {
			host.showStatus("Usage: /autonomy rollback <auditId> (see /autonomy diagnostics for audit ids)");
			return;
		}
		void host.session
			.rollbackLearningWrite(auditId)
			.then((result) => {
				if (!result.ok)
					harnessLog.debug("ui", "a learning rollback was skipped", { auditId, reason: result.reason });
				host.showStatus(
					result.ok ? `Rolled back learning change ${auditId}.` : `Rollback skipped: ${plainLabel(result.reason)}`,
				);
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				host.showStatus(`Rollback failed: ${message}`);
			});
		return;
	}
	if (action.startsWith("fitness")) {
		const rest = action.slice("fitness".length).trim().split(/\s+/).filter(Boolean);
		const modelPattern = rest[0];
		if (!modelPattern) {
			host.showStatus("Usage: /autonomy fitness <model-pattern> [trials]");
			return;
		}
		const trials = rest[1] ? Number(rest[1]) : undefined;
		host.showStatus(`Model fitness probe running on ${modelPattern}…`);
		void host.session
			.runModelFitness({ model: modelPattern, trials: Number.isFinite(trials) ? trials : undefined })
			.then((outcome) => {
				presentModelFitnessOutcome(host, outcome);
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				host.showStatus(`Model fitness failed: ${message}`);
			});
		return;
	}
	if (action === "research") {
		host.showStatus("Research lane: running…");
		void host.session.backgroundLanes
			.runResearchLaneOnce()
			.then((outcome) => {
				if (!outcome.started) {
					harnessLog.debug("ui", "research lane skipped", { skipReason: outcome.skipReason });
					host.showStatus(`Research lane skipped: ${plainLabel(outcome.skipReason ?? "unknown")}`);
					return;
				}
				const status = outcome.record?.status ?? "unknown";
				const reason = outcome.record?.reasonCode ? ` (${plainLabel(outcome.record.reasonCode)})` : "";
				host.showStatus(`Research lane ${status}${reason}`);
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				host.showStatus(`Research lane failed: ${message}`);
			});
		return;
	}
	host.showStatus("Usage: /autonomy [status|diagnostics|research|rollback <auditId>|off|safe|balanced|full]");
}

export function handleAutoLearnCommand(host: AutonomyHost, text: string): void {
	const action = text.slice("/auto-learn".length).trim() || "status";
	if (action === "run" || action === "now" || action === "run-now") {
		host.showStatus(host.launchAutoLearn("manual", true));
		return;
	}
	if (action === "status") {
		host.chatContainer.addChild(new Spacer(1));
		host.chatContainer.addChild(new Text(host.formatAutoLearnStatus(), 1, 0));
		host.ui.requestRender();
		return;
	}
	host.showStatus("Usage: /auto-learn [status|run]");
}
