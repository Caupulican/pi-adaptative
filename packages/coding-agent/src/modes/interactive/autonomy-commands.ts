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
import { interfaceText } from "../../core/language/interface-text.ts";
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
	const words = interfaceText().autonomyCommands.autonomy;
	const autonomy = host.settingsManager.getAutonomySettings();
	const settings = host.getEffectiveAutoLearnSettings();
	const autoLearnState = host.getPrunedAutoLearnState();
	const tenant = host.getAutoLearnTenantKey();
	const running = Object.entries(autoLearnState.runs ?? {}).filter(([, run]) => run.tenant === tenant);
	const otherTenantRunning = Object.values(autoLearnState.runs ?? {}).filter((run) => run.tenant !== tenant).length;
	const safety = autonomy.mode === "full" ? words.authorityFull : words.authorityGated;
	const reflectionLine =
		autonomy.mode === "full"
			? words.reflectionRoot(settings.reflectionReview, settings.reflectionCooldownMinutes)
			: words.reflectionTool(
					settings.reflectionReview,
					settings.reflectionMinToolCalls,
					settings.reflectionCooldownMinutes,
				);
	return [
		words.statusTitle,
		words.mode(autonomy.mode, autonomy.mode === "full"),
		words.goalLoopRounds(autonomy.maxStallTurns),
		words.autoLearn(settings.enabled, settings.model, settings.applyHighConfidence),
		words.longSession(settings.longSessionMessages, settings.longSessionContextPercent, settings.cooldownMinutes),
		reflectionLine,
		words.runningLearners(running.length, settings.maxConcurrentLearners),
		words.otherProjectLearners(otherTenantRunning),
		words.historyRetention,
		words.learningAuthority(safety),
		words.executionAuthority,
		words.auditDir(host.getAutoLearnDataDir()),
		words.artifactFolder(host.getAutoLearnTenantDataDir()),
		words.presets,
	].join("\n");
}

export function handleAutonomyCommand(host: AutonomyHost, text: string): void {
	const words = interfaceText().autonomyCommands.autonomy;
	const action = text.slice("/autonomy".length).trim() || "status";
	if (AUTONOMY_MODES.includes(action as AutonomyMode)) {
		const mode = action as AutonomyMode;
		host.applyAutonomyMode(mode);
		host.showStatus(words.modeSet(mode, mode === "full"));
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
			host.showStatus(words.rollbackUsage);
			return;
		}
		void host.session
			.rollbackLearningWrite(auditId)
			.then((result) => {
				if (!result.ok)
					harnessLog.debug("ui", "a learning rollback was skipped", { auditId, reason: result.reason });
				host.showStatus(result.ok ? words.rolledBack(auditId) : words.rollbackSkipped(plainLabel(result.reason)));
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				host.showStatus(words.rollbackFailed(message));
			});
		return;
	}
	if (action.startsWith("fitness")) {
		const rest = action.slice("fitness".length).trim().split(/\s+/).filter(Boolean);
		const modelPattern = rest[0];
		if (!modelPattern) {
			host.showStatus(words.fitnessUsage);
			return;
		}
		const trials = rest[1] ? Number(rest[1]) : undefined;
		host.showStatus(words.fitnessRunning(modelPattern));
		void host.session
			.runModelFitness({ model: modelPattern, trials: Number.isFinite(trials) ? trials : undefined })
			.then((outcome) => {
				presentModelFitnessOutcome(host, outcome);
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				host.showStatus(words.fitnessFailed(message));
			});
		return;
	}
	if (action === "research") {
		host.showStatus(words.researchRunning);
		void host.session.backgroundLanes
			.runResearchLaneOnce()
			.then((outcome) => {
				if (!outcome.started) {
					harnessLog.debug("ui", "research lane skipped", { skipReason: outcome.skipReason });
					host.showStatus(words.researchSkipped(plainLabel(outcome.skipReason ?? "unknown")));
					return;
				}
				const status = outcome.record?.status ?? "unknown";
				const reason = outcome.record?.reasonCode
					? words.researchReason(plainLabel(outcome.record.reasonCode))
					: "";
				host.showStatus(words.researchResult(status, reason));
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				host.showStatus(words.researchLaneFailed(message));
			});
		return;
	}
	host.showStatus(words.usage);
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
	host.showStatus(interfaceText().autonomyCommands.autonomy.autoLearnUsage);
}
