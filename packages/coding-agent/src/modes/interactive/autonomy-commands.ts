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
import { formatModelFitnessReport } from "../../core/research/model-fitness.ts";
import type { AutoLearnSettings, AutonomyMode, SettingsManager, SettingsScope } from "../../core/settings-manager.ts";
import { AUTONOMY_MODES, type AutoLearnState } from "./auto-learn-controller.ts";

export interface AutonomyHost {
	readonly session: AgentSession;
	readonly settingsManager: SettingsManager;
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

export function formatAutonomyStatus(host: AutonomyHost): string {
	const autonomy = host.settingsManager.getAutonomySettings();
	const settings = host.getEffectiveAutoLearnSettings();
	const autoLearnState = host.getPrunedAutoLearnState();
	const tenant = host.getAutoLearnTenantKey();
	const running = Object.entries(autoLearnState.runs ?? {}).filter(([, run]) => run.tenant === tenant);
	const otherTenantRunning = Object.values(autoLearnState.runs ?? {}).filter((run) => run.tenant !== tenant).length;
	const safety =
		autonomy.mode === "full"
			? "standing grant for memory, skills, user/project extensions, autonomy/autoLearn tuning, and authorized selfModification.sourcePath edits; hard stops still require explicit foreground approval"
			: "proposal-gated outside configured high-confidence memory policy";
	const reflectionLine =
		autonomy.mode === "full"
			? `Reflection review: ${settings.reflectionReview ? "enabled" : "disabled"}; post-turn when concurrency allows; cooldown=${settings.reflectionCooldownMinutes}m`
			: `Reflection review: ${settings.reflectionReview ? "enabled" : "disabled"}; tool trigger=${settings.reflectionMinToolCalls}; cooldown=${settings.reflectionCooldownMinutes}m`;
	return [
		"Autonomy status",
		`Mode: ${autonomy.mode}${autonomy.mode === "full" ? " (standing autonomy)" : ""}`,
		`Goal loop rounds: ${autonomy.maxStallTurns}`,
		`Auto Learn: ${settings.enabled ? "enabled" : "disabled"}; model=${settings.model}; applyHighConfidence=${settings.applyHighConfidence}`,
		`Long-session trigger: ${settings.longSessionMessages} messages or ${settings.longSessionContextPercent}% context; cooldown=${settings.cooldownMinutes}m`,
		reflectionLine,
		`Running tenant learners: ${running.length}/${settings.maxConcurrentLearners}`,
		`Other tenant learners: ${otherTenantRunning}`,
		"History retention: 7 days for internal Auto Learn prompts/logs/sessions",
		`Standing authority: ${safety}`,
		`Audit/log dir: ${host.getAutoLearnDataDir()}`,
		`Tenant artifact dir: ${host.getAutoLearnTenantDataDir()}`,
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
				host.showStatus(
					result.ok ? `Rolled back learning change ${auditId}.` : `Rollback skipped: ${result.reason}`,
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
				if (!outcome.started) {
					host.showStatus(`Model fitness skipped: ${outcome.skipReason}`);
					return;
				}
				host.chatContainer.addChild(new Spacer(1));
				host.chatContainer.addChild(new Text(formatModelFitnessReport(outcome.model, outcome.report), 1, 0));
				host.ui.requestRender();
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				host.showStatus(`Model fitness failed: ${message}`);
			});
		return;
	}
	if (action === "research") {
		host.showStatus("Research lane: running…");
		void host.session
			.runResearchLaneOnce()
			.then((outcome) => {
				if (!outcome.started) {
					host.showStatus(`Research lane skipped: ${outcome.skipReason ?? "unknown"}`);
					return;
				}
				const status = outcome.record?.status ?? "unknown";
				const reason = outcome.record?.reasonCode ? ` (${outcome.record.reasonCode})` : "";
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
