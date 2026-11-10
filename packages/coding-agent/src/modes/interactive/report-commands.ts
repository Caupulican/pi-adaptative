/**
 * Read-only report and easter-egg commands extracted from interactive-mode.
 *
 * These build informational output (usage/cost summary, changelog, hotkeys
 * table, render debug dump) or render an easter-egg component, appending to the
 * chat container and requesting a render. None mutate agent/session state, so
 * they operate through narrow `host` seams (chat container, TUI, and a few
 * read accessors) while interactive-mode keeps thin delegating wrappers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Container, Keybinding, MarkdownTheme, TUI } from "@caupulican/pi-tui";
import { Markdown, Spacer, Text, visibleWidth } from "@caupulican/pi-tui";
import { getDebugLogPath } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import {
	backgroundCostBreakdown,
	formatCompactTaskDuration,
	type SessionCostSummary,
} from "../../core/cost/cost-summary.ts";
import type { ExtensionRunner } from "../../core/extensions/index.ts";
import type { AppKeybinding, KeybindingsManager } from "../../core/keybindings.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import type { AutoLearnSettings } from "../../core/settings/settings-schema.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { formatKeyText } from "../../presentation/keybinding-hints.ts";
import { plainLabel } from "../../presentation/plain-text.ts";
import { theme } from "../../presentation/theme-model.ts";
import { getChangelogPath, parseChangelog } from "../../utils/changelog.ts";
import { getProcessMemoryMb } from "../../utils/process-memory.ts";
import { ArminComponent } from "./components/armin.ts";
import { DaxnutsComponent } from "./components/daxnuts.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import { EarendilAnnouncementComponent } from "./components/earendil-announcement.ts";
import { selfCompactionGauge } from "./components/self-compaction-gauge.ts";
import type { ShortcutSection } from "./components/shortcuts-window.ts";

export interface ReportRenderHost {
	readonly chatContainer: Container;
	readonly ui: TUI;
}

export interface UsageReportHost extends ReportRenderHost {
	readonly session: AgentSession;
	readonly settingsManager: Pick<SettingsManager, "getCostGuardSettings">;
	readonly modelRegistry: Pick<ModelRegistry, "isUsingSubscription">;
	getCurrentAutoLearnSettings(): Required<AutoLearnSettings>;
}

export interface ChangelogReportHost extends ReportRenderHost {
	getMarkdownThemeWithSettings(): MarkdownTheme;
}

export interface HotkeysReportHost extends ReportRenderHost {
	readonly extensionRunner: Pick<ExtensionRunner, "getShortcuts">;
	readonly keybindings: KeybindingsManager;
	/** Opens the shortcuts window over the conversation; nothing is written into it. */
	showShortcuts(sections: readonly ShortcutSection[]): void;
	getAppKeyDisplay(action: AppKeybinding): string;
	getEditorKeyDisplay(action: Keybinding): string;
}

export interface DebugReportHost extends ReportRenderHost {
	readonly session: AgentSession;
}

/** A count of tokens or characters, written the way the interface language writes numbers. */
function localeNumber(value: number): string {
	return interfaceText().reports.formats.number(value);
}

/** An amount of money, with the decimal separator of the interface language and the digits the line asks for. */
function usd(value: number, fractionDigits: number): string {
	return interfaceText().reports.formats.amount(value, fractionDigits);
}

export function formatCostReport(costs: SessionCostSummary, usingSubscription = false): string {
	const text = interfaceText().reports.cost;
	const { agentCost, agentReports, icmCost, icmReports } = backgroundCostBreakdown(costs);
	const subNote = costs.costEstimate ? text.estimated : usingSubscription ? text.subscription : "";
	const lines = [
		`${theme.fg("dim", text.current)} $${usd(costs.currentCost, 4)}${subNote}`,
		`${theme.fg("dim", text.root)} $${usd(costs.ownCost, 4)}`,
		`${theme.fg("dim", text.subagents)} $${usd(agentCost, 4)}${text.reports(agentReports)}`,
	];
	if (costs.reportedCost !== undefined) lines.push(`${theme.fg("dim", text.recorded)} $${usd(costs.reportedCost, 4)}`);
	if (costs.accountingStatus) lines.push(theme.fg("warning", text.historicalAccounting(costs.accountingStatus)));
	if (costs.apiEquivalentPartial)
		lines.push(
			theme.fg(
				"warning",
				text.partialCatalogTotal(costs.modelUnknownTokens ?? 0, costs.modelUnknownOperations ?? 0),
			),
		);
	if (costs.todayApiEquivalentPartial)
		lines.push(theme.fg("warning", text.partialTodayPricing(costs.todayModelUnknownTokens ?? 0)));
	if (icmReports > 0 || icmCost > 0) {
		lines.push(`${theme.fg("dim", text.icmSummaries)} $${usd(icmCost, 4)}${text.icmCalls(icmReports)}`);
	}
	lines.push(
		`${theme.fg("dim", text.today)} ${costs.todayCostEstimate ? "~" : ""}$${usd(costs.todayCost, 4)}${costs.todayCostEstimate ? text.estimated : ""}${costs.todayPending ? text.todayPending : ""}`,
		`${theme.fg("dim", text.rollover)} ${text.localMidnight}`,
	);
	return lines.join("\n");
}

export interface SelfCompactionReportHost extends ReportRenderHost {
	readonly session: AgentSession;
}

export function formatSelfCompactionInfo(session: Pick<AgentSession, "getSelfCompactionInfo">): string {
	const text = interfaceText().reports.selfCompaction;
	const { view, settings, promptSources, note, running } = session.getSelfCompactionInfo();
	const label = (words: string) => theme.fg("dim", words);
	const count = (tokens: number | null) => (tokens === null ? text.unknown : localeNumber(tokens));
	const lines = [theme.bold(text.title)];
	if (view.settingsError) {
		lines.push(`${label(text.state)} ${text.settingsRejected(view.settingsError)}`);
	} else if (!view.thresholds) {
		lines.push(`${label(text.state)} ${view.enabled ? text.unavailable : text.disabled}`);
	} else {
		const t = view.thresholds;
		const gauge = selfCompactionGauge(view);
		const gaugeText = gauge ? [gauge.bar, gauge.percent, gauge.tag].filter(Boolean).join(" ") : text.unknown;
		lines.push(`${label(text.gauge)} ${gaugeText}`);
		lines.push(
			`${label(text.phase)} ${text.phaseDetail(view.phase, String(view.level))}; ${text.tools(view.toolsLocked)}`,
		);
		lines.push(
			`${label(text.usage)} ${text.usageDetail(count(view.usedTokens), localeNumber(t.contextWindow), view.usedPercent, count(view.cachedTokens))}`,
		);
		lines.push(
			`${label(text.lines)} ${text.linesDetail(count(t.noticeTokens), String(settings.notice), count(t.warningTokens), String(settings.warning), count(t.forcedTokens), String(settings.forced))}`,
		);
		const early = t.earlyTokens === null ? text.hostCompactionOff : count(t.earlyTokens);
		lines.push(`${label(text.hostCompaction)} ${text.hostCompactionDetail(early, count(t.hardTokens))}`);
		lines.push(
			`${label(text.until)} ${text.untilDetail(count(view.tokensUntilWarning), count(view.tokensUntilForced))}`,
		);
	}
	lines.push(`${label(text.cycles)} ${view.cycles}`);
	lines.push(
		`${label(text.handoff)} ${text.handoffDetail(view.handoff.status, view.handoff.attempts, view.handoff.lastError ?? undefined, view.handoff.ownerRequested, running)}`,
	);
	lines.push(
		`${label(text.prompts)} ${text.promptsDetail(promptSources.notice, promptSources.warning, promptSources.summary)}`,
	);
	if (note !== null) {
		lines.push(`${label(text.savedNote(localeNumber(note.length)))}`, note);
	}
	lines.push("", `${label(text.nowHint)}${text.nowHintDetail}`);
	return lines.join("\n");
}

export function handleSelfCompactInfoCommand(host: SelfCompactionReportHost): void {
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new Text(formatSelfCompactionInfo(host.session), 1, 0));
	host.ui.requestRender();
}

export function handleUsageCommand(host: UsageReportHost): void {
	const text = interfaceText().reports.usage;
	const stats = host.session.getSessionStats();
	const costs = host.session.getCostSummary();
	const context = host.session.getContextUsage();
	const autoLearn = host.getCurrentAutoLearnSettings();
	const costGuard = host.session.getLastCostGuardDecision();
	const costGuardSettings = host.settingsManager.getCostGuardSettings();
	const activeModel = host.session.model;
	const usingSubscription = activeModel ? host.modelRegistry.isUsingSubscription(activeModel) : false;
	const isChatGptSubscription = usingSubscription && activeModel?.provider === "openai-codex";

	let info = `${theme.bold(text.title)}\n\n`;
	info += `${theme.bold(text.sessionTokens)}\n`;
	info += `${theme.fg("dim", text.input)} ${localeNumber(stats.tokens.input)}\n`;
	info += `${theme.fg("dim", text.output)} ${localeNumber(stats.tokens.output)}\n`;
	info += `${theme.fg("dim", text.cacheRead)} ${localeNumber(stats.tokens.cacheRead)}\n`;
	info += `${theme.fg("dim", text.cacheWrite)} ${localeNumber(stats.tokens.cacheWrite)}\n`;
	info += `${theme.fg("dim", text.total)} ${localeNumber(stats.tokens.total)}\n\n`;

	info += `${theme.bold(text.costTitle)}\n`;
	info += `${formatCostReport(costs, usingSubscription)}\n\n`;

	const taskMetrics = host.session.getTaskAndModelMetrics();
	if (taskMetrics && (taskMetrics.tasks.length > 0 || taskMetrics.models.length > 0)) {
		if (taskMetrics.unassignedCostUsd > 0)
			info += `${theme.fg("dim", text.unassignedReceipts)} $${usd(taskMetrics.unassignedCostUsd, 4)}${text.noTaskIdentity}\n`;
		if (taskMetrics.currentTask) {
			const ct = taskMetrics.currentTask;
			const stepsPart =
				ct.stepsTotal !== undefined && ct.stepsCompleted !== undefined
					? text.steps(ct.stepsCompleted, ct.stepsTotal)
					: "";
			info += `${theme.bold(text.taskMetricsTitle)}\n`;
			info += `${theme.fg("dim", text.currentTask)} ${ct.title}${text.taskStatus(ct.status)}\n`;
			info += `${theme.fg("dim", text.durationRounds)} ${ct.timingEstimated ? "~" : ""}${text.durationDetail(formatCompactTaskDuration(ct.activeMs), formatCompactTaskDuration(ct.wallMs), ct.rounds, ct.toolCalls)}${stepsPart}\n`;
			if (ct.goalActiveMs !== undefined)
				info += `${theme.fg("dim", text.goalClock)} ${formatCompactTaskDuration(ct.goalActiveMs)}\n`;
			if (ct.workerActiveMs !== undefined)
				info += `${theme.fg("dim", text.workerActive)} ${formatCompactTaskDuration(ct.workerActiveMs)}\n`;
			const icmPart = ct.icmCostUsd > 0 ? text.icmPart(`$${usd(ct.icmCostUsd, 4)}`) : "";
			info += `${theme.fg("dim", text.taskCost)} ${text.taskCostDetail(`$${usd(ct.totalCostUsd, 4)}`, `$${usd(ct.rootCostUsd, 4)}`, `$${usd(ct.subagentCostUsd, 4)}`, icmPart)}\n\n`;
		}
		if (taskMetrics.models.length > 0) {
			info += `${theme.bold(text.modelBreakdownTitle)}\n`;
			for (const row of taskMetrics.models.slice(0, 8)) {
				info += `${theme.fg("dim", text.modelLabel(row.model, plainLabel(row.role)))} $${usd(row.costUsd, 4)}${text.modelUsage(row.calls, row.role === "subagent", localeNumber(row.tokens))}\n`;
			}
			info += "\n";
		}
	}

	const processMemory = getProcessMemoryMb();
	info += `${theme.bold(text.processTitle)}\n`;
	info += `${theme.fg("dim", text.memory)} ${text.memoryDetail(String(processMemory.rssMb), String(processMemory.heapUsedMb), String(processMemory.externalMb))}\n\n`;

	info += `${theme.bold(text.optimizationTitle)}\n`;
	const contextPercent = context?.percent;
	const contextTokens = context?.tokens;
	if (
		context &&
		contextPercent !== undefined &&
		contextPercent !== null &&
		contextTokens !== undefined &&
		contextTokens !== null
	) {
		info += `${theme.fg("dim", text.context)} ${text.contextDetail(contextPercent.toFixed(1), localeNumber(contextTokens), localeNumber(context.contextWindow))}\n`;
	} else {
		info += `${theme.fg("dim", text.context)} ${text.contextUnknown}\n`;
	}
	info += `${theme.fg("dim", text.autoCompaction)} ${host.session.autoCompactionEnabled ? text.enabled : text.disabled}\n`;
	const compactionGates = stats.compactionGates ?? {
		gateFailures: 0,
		deterministicGapFills: 0,
		compactionsWithGateFailures: 0,
		checks: {},
	};
	info += `${theme.fg("dim", text.gateFailures)} ${text.gateFailuresDetail(compactionGates.gateFailures, compactionGates.deterministicGapFills)}\n`;
	const failingChecks = Object.entries(compactionGates.checks).sort(
		([leftName, left], [rightName, right]) => right.failures - left.failures || leftName.localeCompare(rightName),
	);
	if (failingChecks.length > 0) {
		const visibleChecks = failingChecks.slice(0, 3).map(([check, checkStats]) => {
			let score = "";
			if (checkStats.minScore !== undefined && checkStats.maxScore !== undefined) {
				const range =
					checkStats.minScore === checkStats.maxScore
						? checkStats.minScore.toFixed(2)
						: `${checkStats.minScore.toFixed(2)}-${checkStats.maxScore.toFixed(2)}`;
				const threshold =
					checkStats.threshold === undefined
						? ""
						: ` ${checkStats.comparator === "maximum" ? ">" : "<"} ${checkStats.threshold.toFixed(2)}`;
				score = ` (${range}${threshold})`;
			}
			return `${plainLabel(check)} x${checkStats.failures}${score}`;
		});
		if (failingChecks.length > visibleChecks.length) {
			visibleChecks.push(text.moreChecks(failingChecks.length - visibleChecks.length));
		}
		info += `${theme.fg("dim", text.failingChecks)} ${visibleChecks.join("; ")}\n`;
	}
	if (!costGuardSettings.enabled) {
		info += `${theme.fg("dim", text.costGuard)} ${text.disabled}\n`;
	} else if (isChatGptSubscription) {
		info += `${theme.fg("dim", text.costGuard)} ${text.costGuardNotApplicable}\n`;
	} else if (costGuard) {
		const status = costGuard.over ? text.costGuardOver : text.costGuardOk;
		info += `${theme.fg("dim", text.costGuard)} ${text.costGuardMeasured(status, usd(costGuard.estUsd, 4), usd(costGuard.thresholdUsd, 4), costGuard.action)}\n`;
	} else {
		info += `${theme.fg("dim", text.costGuard)} ${text.costGuardPending}\n`;
	}
	const hostTurn = host.session.hostTurnReasoning.getLastDecision();
	const loweredHostTurns = host.session.hostTurnReasoning.getLoweredRequestCount();
	if (hostTurn) {
		const effect = hostTurn.held
			? text.hostTurnHeld(hostTurn.sessionLevel, hostTurn.resolvedLevel)
			: hostTurn.lowered
				? text.hostTurnLowered(hostTurn.sessionLevel, hostTurn.resolvedLevel)
				: text.hostTurnInherited;
		const last = hostTurn.customType ? plainLabel(hostTurn.customType) : text.hostTurnLastNone;
		info += `${theme.fg("dim", text.hostTurn)} ${effect}${text.hostTurnDetail(loweredHostTurns, last)}\n`;
	} else {
		info += `${theme.fg("dim", text.hostTurn)} ${text.hostTurnNone}\n`;
	}
	info += `${theme.fg("dim", text.autoLearn)} ${autoLearn.enabled ? text.enabled : text.disabled}\n`;
	info += `${theme.fg("dim", text.scavengerModel)} ${autoLearn.model || text.activeModel}\n`;
	info += `${theme.fg("dim", text.reflectionCue)} ${autoLearn.reflectionReview ? text.enabled : text.disabled}${text.reflectionCueDetail(autoLearn.reflectionMinToolCalls)}\n`;
	info += `${theme.fg("dim", text.concurrency)} ${text.concurrencyDetail(autoLearn.maxConcurrentLearners, autoLearn.cooldownMinutes)}\n\n`;

	info += `${theme.bold(text.modelRouter)}\n`;
	info += `${host.session.getModelRouterStatus((label) => theme.fg("dim", label))}\n\n`;

	info += `${theme.bold(text.manualControls)}\n`;
	info += `${theme.fg("dim", "/compact")}: ${text.manualCompact}\n`;
	info += `${theme.fg("dim", "/settings")}: ${text.manualSettings}\n`;
	info += `${theme.fg("dim", "/auto-learn status|run")}: ${text.manualAutoLearn}\n`;
	info += `${theme.fg("dim", "/context")}: ${text.manualContext}\n`;

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new Text(info, 1, 0));
	host.ui.requestRender();
}

export function handleChangelogCommand(host: ChangelogReportHost): void {
	const text = interfaceText().reports.changelog;
	const changelogPath = getChangelogPath();
	const allEntries = parseChangelog(changelogPath);

	const changelogMarkdown =
		allEntries.length > 0
			? allEntries
					.reverse()
					.map((e) => e.content)
					.join("\n\n")
			: text.empty;

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new DynamicBorder());
	host.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", text.title)), 1, 0));
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, host.getMarkdownThemeWithSettings()));
	host.chatContainer.addChild(new DynamicBorder());
	host.ui.requestRender();
}

export function handleHotkeysCommand(host: HotkeysReportHost): void {
	// Navigation keybindings
	const cursorUp = host.getEditorKeyDisplay("tui.editor.cursorUp");
	const cursorDown = host.getEditorKeyDisplay("tui.editor.cursorDown");
	const cursorLeft = host.getEditorKeyDisplay("tui.editor.cursorLeft");
	const cursorRight = host.getEditorKeyDisplay("tui.editor.cursorRight");
	const cursorWordLeft = host.getEditorKeyDisplay("tui.editor.cursorWordLeft");
	const cursorWordRight = host.getEditorKeyDisplay("tui.editor.cursorWordRight");
	const cursorLineStart = host.getEditorKeyDisplay("tui.editor.cursorLineStart");
	const cursorLineEnd = host.getEditorKeyDisplay("tui.editor.cursorLineEnd");
	const jumpForward = host.getEditorKeyDisplay("tui.editor.jumpForward");
	const jumpBackward = host.getEditorKeyDisplay("tui.editor.jumpBackward");
	const pageUp = host.getEditorKeyDisplay("tui.editor.pageUp");
	const pageDown = host.getEditorKeyDisplay("tui.editor.pageDown");

	// Editing keybindings
	const submit = host.getEditorKeyDisplay("tui.input.submit");
	const newLine = host.getEditorKeyDisplay("tui.input.newLine");
	const deleteWordBackward = host.getEditorKeyDisplay("tui.editor.deleteWordBackward");
	const deleteWordForward = host.getEditorKeyDisplay("tui.editor.deleteWordForward");
	const deleteToLineStart = host.getEditorKeyDisplay("tui.editor.deleteToLineStart");
	const deleteToLineEnd = host.getEditorKeyDisplay("tui.editor.deleteToLineEnd");
	const yank = host.getEditorKeyDisplay("tui.editor.yank");
	const yankPop = host.getEditorKeyDisplay("tui.editor.yankPop");
	const undo = host.getEditorKeyDisplay("tui.editor.undo");
	const tab = host.getEditorKeyDisplay("tui.input.tab");

	// App keybindings
	const interrupt = host.getAppKeyDisplay("app.interrupt");
	const clear = host.getAppKeyDisplay("app.clear");
	const exit = host.getAppKeyDisplay("app.exit");
	const suspend = host.getAppKeyDisplay("app.suspend");
	const cycleThinkingLevel = host.getAppKeyDisplay("app.thinking.cycle");
	const cycleModelForward = host.getAppKeyDisplay("app.model.cycleForward");
	const selectModel = host.getAppKeyDisplay("app.model.select");
	const expandTools = host.getAppKeyDisplay("app.tools.expand");
	const toggleThinking = host.getAppKeyDisplay("app.thinking.toggle");
	const externalEditor = host.getAppKeyDisplay("app.editor.external");
	const cycleModelBackward = host.getAppKeyDisplay("app.model.cycleBackward");
	const followUp = host.getAppKeyDisplay("app.message.followUp");
	const dequeue = host.getAppKeyDisplay("app.message.dequeue");
	const pasteImage = host.getAppKeyDisplay("app.clipboard.pasteImage");

	const window = interfaceText().keys.window;
	const rows = window.rows;
	const sections: ShortcutSection[] = [
		{
			title: window.sections.navigation,
			rows: [
				{
					keys: `${cursorUp} / ${cursorDown} / ${cursorLeft} / ${cursorRight}`,
					action: rows.moveCursor,
				},
				{ keys: `${cursorWordLeft} / ${cursorWordRight}`, action: rows.moveByWord },
				{ keys: cursorLineStart, action: rows.lineStart },
				{ keys: cursorLineEnd, action: rows.lineEnd },
				{ keys: jumpForward, action: rows.jumpForward },
				{ keys: jumpBackward, action: rows.jumpBackward },
				{ keys: `${pageUp} / ${pageDown}`, action: rows.scrollByPage },
			],
		},
		{
			title: window.sections.editing,
			rows: [
				{ keys: submit, action: rows.send },
				{
					keys: newLine,
					action: rows.newLine(process.platform === "win32"),
				},
				{ keys: deleteWordBackward, action: rows.deleteWordBackwards },
				{ keys: deleteWordForward, action: rows.deleteWordForwards },
				{ keys: deleteToLineStart, action: rows.deleteToLineStart },
				{ keys: deleteToLineEnd, action: rows.deleteToLineEnd },
				{ keys: yank, action: rows.pasteDeleted },
				{ keys: yankPop, action: rows.cyclePasted },
				{ keys: undo, action: rows.undo },
			],
		},
		{
			title: window.sections.other,
			rows: [
				{ keys: tab, action: rows.pathCompletion },
				{ keys: interrupt, action: rows.cancelAutocomplete },
				{ keys: clear, action: rows.clearEditor },
				{ keys: exit, action: rows.exitWhenEmpty },
				{ keys: suspend, action: rows.suspend },
				{ keys: cycleThinkingLevel, action: rows.cycleThinkingLevel },
				{ keys: `${cycleModelForward} / ${cycleModelBackward}`, action: rows.cycleModels },
				{ keys: selectModel, action: rows.openModelSelector },
				{ keys: expandTools, action: rows.toggleToolOutput },
				{ keys: toggleThinking, action: rows.toggleThinking },
				{ keys: externalEditor, action: rows.externalEditor },
				{ keys: followUp, action: rows.queueFollowUp },
				{ keys: dequeue, action: rows.restoreQueued },
				{ keys: pasteImage, action: rows.pasteImage },
				{ keys: "/", action: rows.slashCommands },
				{ keys: "!", action: rows.runBash },
				{ keys: "!!", action: rows.runBashExcluded },
			],
		},
	];

	// Add extension-registered shortcuts
	const shortcuts = host.extensionRunner.getShortcuts(host.keybindings.getEffectiveConfig());
	if (shortcuts.size > 0) {
		sections.push({
			title: window.sections.extensions,
			rows: [...shortcuts].map(([key, shortcut]) => ({
				keys: formatKeyText(key, { capitalize: true }),
				action: shortcut.description ?? shortcut.extensionPath,
			})),
		});
	}

	host.showShortcuts(sections);
}

export function handleDebugCommand(host: DebugReportHost): void {
	const text = interfaceText().reports.debug;
	const width = host.ui.terminal.columns;
	const height = host.ui.terminal.rows;
	const allLines = host.ui.render(width);

	const debugLogPath = getDebugLogPath();
	const debugData = [
		text.header(new Date().toISOString()),
		text.terminal(width, height),
		text.totalLines(allLines.length),
		"",
		text.renderedSection,
		...allLines.map((line, idx) => {
			const vw = visibleWidth(line);
			const escaped = JSON.stringify(line);
			return `[${idx}] (w=${vw}) ${escaped}`;
		}),
		"",
		text.messagesSection,
		...host.session.messages.map((msg) => JSON.stringify(msg)),
		"",
	].join("\n");

	fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
	fs.writeFileSync(debugLogPath, debugData);

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(
		new Text(`${theme.fg("accent", text.written)}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
	);
	host.ui.requestRender();
}

export function handleArminSaysHi(host: ReportRenderHost): void {
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new ArminComponent(host.ui));
	host.ui.requestRender();
}

export function handleDementedDelves(host: ReportRenderHost): void {
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new EarendilAnnouncementComponent());
	host.ui.requestRender();
}

export function handleDaxnuts(host: ReportRenderHost): void {
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new DaxnutsComponent(host.ui));
	host.ui.requestRender();
}

export function checkDaxnutsEasterEgg(host: ReportRenderHost, model: { provider: string; id: string }): void {
	if (model.provider === "opencode" && model.id.toLowerCase().includes("kimi-k2.5")) {
		handleDaxnuts(host);
	}
}
