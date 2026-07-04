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
import type { AppKeybinding, KeybindingsManager } from "../../core/keybindings.ts";
import type { AutoLearnSettings } from "../../core/settings-manager.ts";
import { getChangelogPath, parseChangelog } from "../../utils/changelog.ts";
import { getProcessMemoryMb } from "../../utils/process-memory.ts";
import { ArminComponent } from "./components/armin.ts";
import { DaxnutsComponent } from "./components/daxnuts.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import { EarendilAnnouncementComponent } from "./components/earendil-announcement.ts";
import { formatKeyText } from "./components/keybinding-hints.ts";
import { theme } from "./theme/theme.ts";

export interface ReportRenderHost {
	readonly chatContainer: Container;
	readonly ui: TUI;
}

export interface UsageReportHost extends ReportRenderHost {
	readonly session: AgentSession;
	getCurrentAutoLearnSettings(): Required<AutoLearnSettings>;
}

export interface ChangelogReportHost extends ReportRenderHost {
	getMarkdownThemeWithSettings(): MarkdownTheme;
}

export interface HotkeysReportHost extends ReportRenderHost {
	readonly session: AgentSession;
	readonly keybindings: KeybindingsManager;
	getMarkdownThemeWithSettings(): MarkdownTheme;
	getAppKeyDisplay(action: AppKeybinding): string;
	getEditorKeyDisplay(action: Keybinding): string;
}

export interface DebugReportHost extends ReportRenderHost {
	readonly session: AgentSession;
}

export function handleUsageCommand(host: UsageReportHost): void {
	const stats = host.session.getSessionStats();
	const spawned = host.session.getSpawnedUsage();
	const daily = host.session.getDailyUsageTotals();
	const context = host.session.getContextUsage();
	const autoLearn = host.getCurrentAutoLearnSettings();
	const costGuard = host.session.getLastCostGuardDecision();

	let info = `${theme.bold("Usage & Optimization")}\n\n`;
	info += `${theme.bold("Session tokens")}\n`;
	info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
	info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
	info += `${theme.fg("dim", "Cache read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
	info += `${theme.fg("dim", "Cache write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
	info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n\n`;

	info += `${theme.bold("Cost")}\n`;
	info += `${theme.fg("dim", "Session:")} $${stats.cost.toFixed(4)}\n`;
	info += `${theme.fg("dim", "Spawned/background:")} $${spawned.cost.toFixed(4)} (${spawned.reports} reports)\n`;
	info += `${theme.fg("dim", "Today:")} $${daily.totalCost.toFixed(4)}\n`;
	info += `${theme.fg("dim", "Today own:")} $${daily.ownCost.toFixed(4)}\n`;
	info += `${theme.fg("dim", "Today spawned/background:")} $${daily.spawnedCost.toFixed(4)}\n`;
	info += `${theme.fg("dim", "Today tokens:")} ${daily.totalTokens.toLocaleString()}\n\n`;

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
	if (costGuard) {
		const status = costGuard.over ? "over" : "ok";
		info += `${theme.fg("dim", "Cost guard:")} ${status} $${costGuard.estUsd.toFixed(4)}/$${costGuard.thresholdUsd.toFixed(4)} (${costGuard.action})\n`;
	} else {
		info += `${theme.fg("dim", "Cost guard:")} disabled\n`;
	}
	info += `${theme.fg("dim", "Auto Learn:")} ${autoLearn.enabled ? "enabled" : "disabled"}\n`;
	info += `${theme.fg("dim", "Scavenger model:")} ${autoLearn.model || "active"}\n`;
	info += `${theme.fg("dim", "Reflection review:")} ${autoLearn.reflectionReview ? "enabled" : "disabled"} (${autoLearn.reflectionMinToolCalls} tool-call trigger)\n`;
	info += `${theme.fg("dim", "Auto Learn concurrency:")} ${autoLearn.maxConcurrentLearners} learner(s), ${autoLearn.cooldownMinutes}m cooldown\n\n`;

	info += `${theme.bold("Model Router")}\n`;
	info += `${host.session.getModelRouterStatus((label) => theme.fg("dim", label))}\n\n`;

	info += `${theme.bold("Manual controls")}\n`;
	info += `${theme.fg("dim", "/compact")}: compact the active context now\n`;
	info += `${theme.fg("dim", "/settings")}: adjust Auto Learn, cost guard, compaction, and model-router config\n`;
	info += `${theme.fg("dim", "/auto-learn status|run")}: inspect or launch background learning\n`;
	info += `${theme.fg("dim", "context_audit")}: ask the agent to inspect provider-visible context contributors\n`;

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

	let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history (Up when empty) |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleThinkingLevel}\` | Cycle thinking level |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`${pasteImage}\` | Paste image from clipboard |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

	// Add extension-registered shortcuts
	const extensionRunner = host.session.extensionRunner;
	const shortcuts = extensionRunner.getShortcuts(host.keybindings.getEffectiveConfig());
	if (shortcuts.size > 0) {
		hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
		for (const [key, shortcut] of shortcuts) {
			const description = shortcut.description ?? shortcut.extensionPath;
			const keyDisplay = formatKeyText(key, { capitalize: true });
			hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
		}
	}

	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new DynamicBorder());
	host.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0));
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, host.getMarkdownThemeWithSettings()));
	host.chatContainer.addChild(new DynamicBorder());
	host.ui.requestRender();
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
