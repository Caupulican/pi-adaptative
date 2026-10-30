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
import type { ModelRegistry } from "../../core/model-registry.ts";
import type { AutoLearnSettings } from "../../core/settings/settings-schema.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { formatKeyText } from "../../presentation/keybinding-hints.ts";
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

export function formatCostReport(costs: SessionCostSummary, usingSubscription = false): string {
	const { agentCost, agentReports, icmCost, icmReports } = backgroundCostBreakdown(costs);
	const subNote = costs.costEstimate ? " (includes catalog estimates)" : usingSubscription ? " (subscription)" : "";
	const lines = [
		`${theme.fg("dim", "CURRENT (session total):")} $${costs.currentCost.toFixed(4)}${subNote}`,
		`${theme.fg("dim", "ROOT (foreground & System One):")} $${costs.ownCost.toFixed(4)}`,
		`${theme.fg("dim", "SUBAGENTS (workers & bots):")} $${agentCost.toFixed(4)} (${agentReports} reports)`,
	];
	if (costs.reportedCost !== undefined)
		lines.push(`${theme.fg("dim", "RECORDED (unmodified usage totals):")} $${costs.reportedCost.toFixed(4)}`);
	if (costs.accountingStatus) lines.push(`${theme.fg("warning", `Historical accounting ${costs.accountingStatus}`)}`);
	if (costs.apiEquivalentPartial)
		lines.push(
			theme.fg(
				"warning",
				`Catalog-equivalent total is partial: ${costs.modelUnknownTokens ?? 0} tokens / ${costs.modelUnknownOperations ?? 0} operations have no recorded model.`,
			),
		);
	if (costs.todayApiEquivalentPartial)
		lines.push(
			theme.fg(
				"warning",
				`Today's pricing is partial: ${costs.todayModelUnknownTokens ?? 0} tokens have no recorded model.`,
			),
		);
	if (icmReports > 0 || icmCost > 0) {
		lines.push(
			`${theme.fg("dim", "ICM history summaries (included in CURRENT):")} $${icmCost.toFixed(4)} (${icmReports} calls)`,
		);
	}
	lines.push(
		`${theme.fg("dim", "TODAY (host local day):")} ${costs.todayCostEstimate ? "~" : ""}$${costs.todayCost.toFixed(4)}${costs.todayCostEstimate ? " (includes catalog estimates)" : ""}${costs.todayPending ? " (partial; updating)" : ""}`,
		`${theme.fg("dim", "Today rollover:")} local midnight`,
	);
	return lines.join("\n");
}

export interface SelfCompactionReportHost extends ReportRenderHost {
	readonly session: AgentSession;
}

export function formatSelfCompactionInfo(session: Pick<AgentSession, "getSelfCompactionInfo">): string {
	const { view, settings, promptSources, note, running } = session.getSelfCompactionInfo();
	const label = (text: string) => theme.fg("dim", text);
	const count = (tokens: number | null) => (tokens === null ? "unknown" : tokens.toLocaleString("en-US"));
	const lines = [theme.bold("Self-compaction")];
	if (view.settingsError) {
		lines.push(`${label("State:")} disabled because its settings were rejected (${view.settingsError})`);
	} else if (!view.thresholds) {
		lines.push(
			`${label("State:")} ${view.enabled ? "unavailable (no compaction trigger or context window)" : "disabled"}`,
		);
	} else {
		const t = view.thresholds;
		const gauge = selfCompactionGauge(view);
		lines.push(
			`${label("Gauge:")} ${gauge ? [gauge.bar, gauge.percent, gauge.tag].filter(Boolean).join(" ") : "unknown"}`,
		);
		lines.push(
			`${label("Phase:")} ${view.phase} (level ${view.level}); tools ${view.toolsLocked ? "locked to self_compact" : "open"}`,
		);
		lines.push(
			`${label("Usage:")} ${count(view.usedTokens)} of ${t.contextWindow.toLocaleString("en-US")} tokens${view.usedPercent === null ? "" : ` (${view.usedPercent}%)`}, cached ${count(view.cachedTokens)}`,
		);
		lines.push(
			`${label("Lines:")} notice ${count(t.noticeTokens)} (${settings.notice} of the first trigger), warning ${count(t.warningTokens)} (${settings.warning}), forced ${count(t.forcedTokens)} (${settings.forced} of hard)`,
		);
		lines.push(
			`${label("Host compaction:")} early ${t.earlyTokens === null ? "off" : count(t.earlyTokens)}, hard ${count(t.hardTokens)}`,
		);
		lines.push(
			`${label("Until:")} warning ${count(view.tokensUntilWarning)}, forced ${count(view.tokensUntilForced)} tokens`,
		);
	}
	lines.push(`${label("Cycles completed:")} ${view.cycles}`);
	lines.push(
		`${label("Handoff:")} ${view.handoff.status}${view.handoff.attempts > 0 ? `, ${view.handoff.attempts} failed attempt(s)` : ""}${view.handoff.lastError ? `, last error: ${view.handoff.lastError}` : ""}${view.handoff.ownerRequested ? ", owner asked to compact now" : ""}${running ? ", runner active" : ""}`,
	);
	lines.push(
		`${label("Prompts:")} notice ${promptSources.notice}; warning ${promptSources.warning}; summary ${promptSources.summary}`,
	);
	if (note !== null) {
		lines.push(`${label(`Saved note (${note.length.toLocaleString("en-US")} chars):`)}`, note);
	}
	lines.push("", `${label("/self-compact-now")}: compact now, reusing a saved note or asking the agent for one`);
	return lines.join("\n");
}

export function handleSelfCompactInfoCommand(host: SelfCompactionReportHost): void {
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new Text(formatSelfCompactionInfo(host.session), 1, 0));
	host.ui.requestRender();
}

export function handleUsageCommand(host: UsageReportHost): void {
	const stats = host.session.getSessionStats();
	const costs = host.session.getCostSummary();
	const context = host.session.getContextUsage();
	const autoLearn = host.getCurrentAutoLearnSettings();
	const costGuard = host.session.getLastCostGuardDecision();
	const costGuardSettings = host.settingsManager.getCostGuardSettings();
	const activeModel = host.session.model;
	const usingSubscription = activeModel ? host.modelRegistry.isUsingSubscription(activeModel) : false;
	const isChatGptSubscription = usingSubscription && activeModel?.provider === "openai-codex";

	let info = `${theme.bold("Usage & Optimization")}\n\n`;
	info += `${theme.bold("Session tokens")}\n`;
	info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
	info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
	info += `${theme.fg("dim", "Cache read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
	info += `${theme.fg("dim", "Cache write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
	info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n\n`;

	info += `${theme.bold("Cost")}\n`;
	info += `${formatCostReport(costs, usingSubscription)}\n\n`;

	const taskMetrics = host.session.getTaskAndModelMetrics();
	if (taskMetrics && (taskMetrics.tasks.length > 0 || taskMetrics.models.length > 0)) {
		if (taskMetrics.unassignedCostUsd > 0)
			info += `${theme.fg("dim", "Unassigned asynchronous receipts:")} $${taskMetrics.unassignedCostUsd.toFixed(4)} (no task identity)\n`;
		if (taskMetrics.currentTask) {
			const ct = taskMetrics.currentTask;
			const stepsPart =
				ct.stepsTotal !== undefined && ct.stepsCompleted !== undefined
					? `, ${ct.stepsCompleted}/${ct.stepsTotal} steps`
					: "";
			info += `${theme.bold("Task & Goal Metrics")}\n`;
			info += `${theme.fg("dim", "Current/Last task:")} ${ct.title} (${ct.status})\n`;
			info += `${theme.fg("dim", "Duration & rounds:")} ${ct.timingEstimated ? "~" : ""}${formatCompactTaskDuration(ct.activeMs)} active (${formatCompactTaskDuration(ct.wallMs)} wall), ${ct.rounds} rounds, ${ct.toolCalls} tool calls${stepsPart}\n`;
			if (ct.goalActiveMs !== undefined)
				info += `${theme.fg("dim", "Recorded goal clock:")} ${formatCompactTaskDuration(ct.goalActiveMs)}\n`;
			if (ct.workerActiveMs !== undefined)
				info += `${theme.fg("dim", "Worker active time:")} ${formatCompactTaskDuration(ct.workerActiveMs)}\n`;
			info += `${theme.fg("dim", "Task cost:")} $${ct.totalCostUsd.toFixed(4)} (root $${ct.rootCostUsd.toFixed(4)} · sub $${ct.subagentCostUsd.toFixed(4)}${ct.icmCostUsd > 0 ? ` · ICM $${ct.icmCostUsd.toFixed(4)}` : ""})\n\n`;
		}
		if (taskMetrics.models.length > 0) {
			info += `${theme.bold("Model Cost Breakdown")}\n`;
			for (const row of taskMetrics.models.slice(0, 8)) {
				info += `${theme.fg("dim", `${row.model} (${row.role}):`)} $${row.costUsd.toFixed(4)} (${row.calls} ${row.role === "subagent" ? "reports" : "calls"}, ${row.tokens.toLocaleString()} tokens)\n`;
			}
			info += "\n";
		}
	}

	const processMemory = getProcessMemoryMb();
	info += `${theme.bold("Process")}\n`;
	info += `${theme.fg("dim", "Memory:")} rss ${processMemory.rssMb}MB, heap ${processMemory.heapUsedMb}MB, external ${processMemory.externalMb}MB\n\n`;

	info += `${theme.bold("Optimization state")}\n`;
	const contextPercent = context?.percent;
	const contextTokens = context?.tokens;
	if (
		context &&
		contextPercent !== undefined &&
		contextPercent !== null &&
		contextTokens !== undefined &&
		contextTokens !== null
	) {
		info += `${theme.fg("dim", "Context:")} ${contextPercent.toFixed(1)}% (${contextTokens.toLocaleString()}/${context.contextWindow.toLocaleString()})\n`;
	} else {
		info += `${theme.fg("dim", "Context:")} unknown until next provider usage sample\n`;
	}
	info += `${theme.fg("dim", "Auto-compaction:")} ${host.session.autoCompactionEnabled ? "enabled" : "disabled"}\n`;
	const compactionGates = stats.compactionGates ?? {
		gateFailures: 0,
		deterministicGapFills: 0,
		compactionsWithGateFailures: 0,
		checks: {},
	};
	info += `${theme.fg("dim", "Compaction gate failures:")} ${compactionGates.gateFailures} (${compactionGates.deterministicGapFills} deterministic gap-fill)\n`;
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
			return `${check} x${checkStats.failures}${score}`;
		});
		if (failingChecks.length > visibleChecks.length) {
			visibleChecks.push(`+${failingChecks.length - visibleChecks.length} more`);
		}
		info += `${theme.fg("dim", "Failing compaction checks:")} ${visibleChecks.join("; ")}\n`;
	}
	if (!costGuardSettings.enabled) {
		info += `${theme.fg("dim", "Cost guard:")} disabled\n`;
	} else if (isChatGptSubscription) {
		info += `${theme.fg("dim", "Cost guard:")} not applicable to ChatGPT subscription usage\n`;
	} else if (costGuard) {
		const status = costGuard.over ? "over" : "ok";
		info += `${theme.fg("dim", "Cost guard:")} ${status} $${costGuard.estUsd.toFixed(4)}/$${costGuard.thresholdUsd.toFixed(4)} (${costGuard.action})\n`;
	} else {
		info += `${theme.fg("dim", "Cost guard:")} enabled; awaiting the next provider projection\n`;
	}
	const hostTurn = host.session.hostTurnReasoning.getLastDecision();
	const loweredHostTurns = host.session.hostTurnReasoning.getLoweredRequestCount();
	if (hostTurn) {
		const effect = hostTurn.held
			? `${hostTurn.sessionLevel} to ${hostTurn.resolvedLevel} proposed, held at the lane's sent level`
			: hostTurn.lowered
				? `${hostTurn.sessionLevel} to ${hostTurn.resolvedLevel}`
				: "inherited";
		info += `${theme.fg("dim", "Host-turn thinking:")} ${effect} (${loweredHostTurns} lowered; last ${hostTurn.customType})\n`;
	} else {
		info += `${theme.fg("dim", "Host-turn thinking:")} no host-initiated turn yet\n`;
	}
	info += `${theme.fg("dim", "Auto Learn:")} ${autoLearn.enabled ? "enabled" : "disabled"}\n`;
	info += `${theme.fg("dim", "Scavenger model:")} ${autoLearn.model || "active"}\n`;
	info += `${theme.fg("dim", "Reflection cue:")} ${autoLearn.reflectionReview ? "enabled" : "disabled"} (root-only durable cue; ${autoLearn.reflectionMinToolCalls} tool-call trigger)\n`;
	info += `${theme.fg("dim", "Auto Learn concurrency:")} ${autoLearn.maxConcurrentLearners} learner(s), ${autoLearn.cooldownMinutes}m cooldown\n\n`;

	info += `${theme.bold("Model Router")}\n`;
	info += `${host.session.getModelRouterStatus((label) => theme.fg("dim", label))}\n\n`;

	info += `${theme.bold("Manual controls")}\n`;
	info += `${theme.fg("dim", "/compact")}: compact the active context now\n`;
	info += `${theme.fg("dim", "/settings")}: adjust Auto Learn, cost guard, compaction, and model-router config\n`;
	info += `${theme.fg("dim", "/auto-learn status|run")}: inspect status or explicitly launch background learning\n`;
	info += `${theme.fg("dim", "/context")}: inspect provider-visible context contributors without model tokens\n`;

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new Text(info, 1, 0));
	host.ui.requestRender();
}

export function handleChangelogCommand(host: ChangelogReportHost): void {
	const changelogPath = getChangelogPath();
	const allEntries = parseChangelog(changelogPath);

	const changelogMarkdown =
		allEntries.length > 0
			? allEntries
					.reverse()
					.map((e) => e.content)
					.join("\n\n")
			: "No changelog entries found.";

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new DynamicBorder());
	host.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
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

	const sections: ShortcutSection[] = [
		{
			title: "Navigation",
			rows: [
				{
					keys: `${cursorUp} / ${cursorDown} / ${cursorLeft} / ${cursorRight}`,
					action: "Move cursor / browse history (Up when empty)",
				},
				{ keys: `${cursorWordLeft} / ${cursorWordRight}`, action: "Move by word" },
				{ keys: cursorLineStart, action: "Start of line" },
				{ keys: cursorLineEnd, action: "End of line" },
				{ keys: jumpForward, action: "Jump forward to character" },
				{ keys: jumpBackward, action: "Jump backward to character" },
				{ keys: `${pageUp} / ${pageDown}`, action: "Scroll by page" },
			],
		},
		{
			title: "Editing",
			rows: [
				{ keys: submit, action: "Send message" },
				{
					keys: newLine,
					action: `New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""}`,
				},
				{ keys: deleteWordBackward, action: "Delete word backwards" },
				{ keys: deleteWordForward, action: "Delete word forwards" },
				{ keys: deleteToLineStart, action: "Delete to start of line" },
				{ keys: deleteToLineEnd, action: "Delete to end of line" },
				{ keys: yank, action: "Paste the most-recently-deleted text" },
				{ keys: yankPop, action: "Cycle through the deleted text after pasting" },
				{ keys: undo, action: "Undo" },
			],
		},
		{
			title: "Other",
			rows: [
				{ keys: tab, action: "Path completion / accept autocomplete" },
				{ keys: interrupt, action: "Cancel autocomplete / abort streaming" },
				{ keys: clear, action: "Clear editor (first) / exit (second)" },
				{ keys: exit, action: "Exit (when editor is empty)" },
				{ keys: suspend, action: "Suspend to background" },
				{ keys: cycleThinkingLevel, action: "Cycle thinking level" },
				{ keys: `${cycleModelForward} / ${cycleModelBackward}`, action: "Cycle models" },
				{ keys: selectModel, action: "Open model selector" },
				{ keys: expandTools, action: "Toggle tool output expansion" },
				{ keys: toggleThinking, action: "Toggle thinking block visibility" },
				{ keys: externalEditor, action: "Edit message in external editor" },
				{ keys: followUp, action: "Queue follow-up message" },
				{ keys: dequeue, action: "Restore queued messages" },
				{ keys: pasteImage, action: "Paste image from clipboard" },
				{ keys: "/", action: "Slash commands" },
				{ keys: "!", action: "Run bash command" },
				{ keys: "!!", action: "Run bash command (excluded from context)" },
			],
		},
	];

	// Add extension-registered shortcuts
	const shortcuts = host.extensionRunner.getShortcuts(host.keybindings.getEffectiveConfig());
	if (shortcuts.size > 0) {
		sections.push({
			title: "Extensions",
			rows: [...shortcuts].map(([key, shortcut]) => ({
				keys: formatKeyText(key, { capitalize: true }),
				action: shortcut.description ?? shortcut.extensionPath,
			})),
		});
	}

	host.showShortcuts(sections);
}

export function handleDebugCommand(host: DebugReportHost): void {
	const width = host.ui.terminal.columns;
	const height = host.ui.terminal.rows;
	const allLines = host.ui.render(width);

	const debugLogPath = getDebugLogPath();
	const debugData = [
		`Debug output at ${new Date().toISOString()}`,
		`Terminal: ${width}x${height}`,
		`Total lines: ${allLines.length}`,
		"",
		"=== All rendered lines with visible widths ===",
		...allLines.map((line, idx) => {
			const vw = visibleWidth(line);
			const escaped = JSON.stringify(line);
			return `[${idx}] (w=${vw}) ${escaped}`;
		}),
		"",
		"=== Agent messages (JSONL) ===",
		...host.session.messages.map((msg) => JSON.stringify(msg)),
		"",
	].join("\n");

	fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
	fs.writeFileSync(debugLogPath, debugData);

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(
		new Text(`${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
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
