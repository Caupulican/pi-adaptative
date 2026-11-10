import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import { interfaceText } from "../../../core/language/interface-text.ts";
import type {
	AccountOverview,
	AccountUsageSnapshot,
	UsageOverview,
} from "../../../core/provider-admission/usage-overview.ts";
import { theme } from "../../../presentation/theme-model.ts";
import { cardPalette, scrollDelta, scrolledOffset } from "./card-frame.ts";

export const USAGE_STALE_AFTER_MS = 15 * 60_000;

export type UsageDashboardAction = "refresh" | "reset" | "close";
/** The owner's word for how an account authenticates, by the code the account data holds. */
function authLabels(): Readonly<Record<AccountOverview["auth"], string>> {
	const auth = interfaceText().reports.dashboard.auth;
	return {
		subscription: auth.subscription,
		oauth: auth.oauth,
		api_key: auth.apiKey,
		environment: auth.environment,
		models_json: auth.modelsJson,
		headers: auth.headers,
	};
}

/** A label followed by the spaces that bring it to `width` columns, counted as the terminal shows it. */
function padLabel(label: string, width: number): string {
	return `${label}${" ".repeat(Math.max(0, width - visibleWidth(label)))}`;
}

function clock(ms: number): string {
	return new Date(ms).toTimeString().slice(0, 8);
}

function span(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
	return `${Math.floor(hours / 24)}d`;
}

function tokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function dollars(value: number): string {
	return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function percentTone(percent: number): (text: string) => string {
	if (percent >= 100) return (text) => theme.fg("error", text);
	if (percent >= 75) return (text) => theme.fg("warning", text);
	return (text) => theme.fg("accent", text);
}

function filledBar(usedPercent: number, cells = 12): string {
	const clamped = Math.max(0, Math.min(100, usedPercent));
	const filled = Math.max(0, Math.min(cells, Math.round((clamped / 100) * cells)));
	const free = cells - filled;
	return "█".repeat(filled) + "░".repeat(free);
}

function quotaBar(usedPercent: number, cells = 12): string {
	return percentTone(usedPercent)(filledBar(usedPercent, cells));
}

function accountSnapshot(account: AccountOverview): AccountUsageSnapshot | undefined {
	switch (account.fetch.kind) {
		case "fetched":
			return account.fetch.snapshot;
		case "pending":
		case "failed":
			return account.fetch.last ?? account.passive;
		case "idle":
		case "unsupported":
			return account.passive;
	}
}

function accountSortRank(account: AccountOverview): number {
	if (account.active) return 1;
	const snapshot = accountSnapshot(account);
	const maxUsed = snapshot?.windows.length ? Math.max(...snapshot.windows.map((w) => w.usedPercent)) : 0;
	if (account.limit !== undefined || snapshot?.limitReached !== undefined || maxUsed >= 80) return 2;
	const inflight = account.inflight.foreground + account.inflight.worker + account.inflight.background;
	if (account.fetch.kind === "unsupported" && !account.passive && !account.limit && inflight === 0) return 4;
	return 3;
}

function formatKpiRows(overview: UsageOverview, width: number): [string, string] {
	const text = interfaceText().reports.dashboard;
	const session = overview.session;
	const rootCostUsd =
		session.rootCostUsd ?? Math.max(0, session.costUsd - session.subagentCostUsd - session.icmCostUsd);
	const breakdownParts = [
		text.rootPart(dollars(rootCostUsd)),
		text.subPart(dollars(session.subagentCostUsd)),
		...(session.icmCostUsd > 0 ? [text.icmPart(dollars(session.icmCostUsd))] : []),
	];
	const subagentText = ` (${breakdownParts.join(" · ")})`;
	const left1 = `${theme.fg("dim", text.session)}${theme.fg("text", `${session.costEstimate ? "~" : ""}${dollars(session.costUsd)}${subagentText}`)}${theme.fg("dim", text.today)}${theme.fg("text", `${overview.today.costEstimate ? "~" : ""}${dollars(overview.today.costUsd)}${overview.today.pending ? text.pending : ""}`)}`;

	const cacheTotal = session.tokens.input + session.tokens.cacheRead + session.tokens.cacheWrite;
	const cachePercent = cacheTotal > 0 ? Math.round((session.tokens.cacheRead / cacheTotal) * 100) : 0;
	const counts = text.counts(
		tokens(session.tokens.input),
		tokens(session.tokens.output),
		text.cacheSummary(cachePercent),
	);
	const right1 = `${theme.fg("dim", text.tokens)}${theme.fg("text", counts)}`;

	let contextGauge: string;
	if (!session.context) {
		contextGauge = theme.fg("dim", text.contextUnavailable);
	} else {
		const win = session.context.window;
		const cachedTokens = session.context.cachedTokens ?? null;
		const cachedSuffix = cachedTokens !== null && cachedTokens > 0 ? text.cachedSuffix(tokens(cachedTokens)) : "";
		if (session.context.tokens === null && session.context.percent === null) {
			contextGauge = `${theme.fg("dim", text.contextAwaiting(tokens(win)))}${theme.fg("muted", cachedSuffix)}`;
		} else {
			const pct =
				session.context.percent ??
				(session.context.tokens !== null && win > 0 ? (session.context.tokens / win) * 100 : 0);
			const used = session.context.tokens ?? 0;
			const clamped = Math.max(0, Math.min(100, pct));
			const filled = Math.max(0, Math.min(12, Math.round((clamped / 100) * 12)));
			const free = 12 - filled;
			const bar = "█".repeat(filled) + "░".repeat(free);
			const tone = pct >= 95 ? "error" : pct >= 75 ? "warning" : "accent";
			contextGauge = `${theme.fg(tone, bar)} ${text.contextGauge(Math.round(pct), tokens(used), tokens(win), cachedSuffix)}`;
		}
	}
	const left2 = `${theme.fg("dim", text.context)}${contextGauge}`;

	const machine = overview.machine;
	let loadSummary: string;
	const other = machine.otherAccountsInflight > 0 ? text.otherAccounts(machine.otherAccountsInflight) : "";
	if (machine.emergencyStop.engaged) {
		loadSummary = theme.fg("error", text.emergencyStop);
	} else if (machine.inflight > 0) {
		loadSummary = `${text.inFlight(machine.inflight)}${other}`;
	} else {
		loadSummary = `${text.idle}${other}`;
	}
	const right2 = `${theme.fg("dim", text.load)}${theme.fg("text", loadSummary)}`;

	if (width >= 76) {
		const maxLeft = Math.max(visibleWidth(left1), visibleWidth(left2));
		const rightW = Math.max(visibleWidth(right1), visibleWidth(right2));
		const colWidth = Math.max(maxLeft + 2, Math.min(width - rightW - 1, Math.floor(width * 0.52)));
		const r1 = `${left1}${" ".repeat(Math.max(1, colWidth - visibleWidth(left1)))}${right1}`;
		const r2 = `${left2}${" ".repeat(Math.max(1, colWidth - visibleWidth(left2)))}${right2}`;
		return [truncateToWidth(r1, width, "…"), truncateToWidth(r2, width, "…")];
	}
	const r1 = `${left1}${theme.fg("dim", " · ")}${right1}`;
	const r2 = `${left2}${theme.fg("dim", " · ")}${right2}`;
	return [truncateToWidth(r1, width, "…"), truncateToWidth(r2, width, "…")];
}

function formatProviderCardLines(overview: UsageOverview, width: number, now: number): string[] {
	const text = interfaceText().reports.dashboard;
	const authWords = authLabels();
	if (overview.accounts.length === 0) {
		return [theme.fg("dim", text.noCredentials)];
	}

	const sorted = [...overview.accounts].sort((a, b) => accountSortRank(a) - accountSortRank(b));
	const cards = sorted.filter((a) => accountSortRank(a) < 4);
	const quiet = sorted.filter((a) => accountSortRank(a) === 4);

	const cardBlocks: string[][] = [];

	for (const account of cards) {
		const lines: string[] = [];
		const snapshot = accountSnapshot(account);
		const maxUsed = snapshot?.windows.length ? Math.max(...snapshot.windows.map((w) => w.usedPercent)) : 0;
		const bullet = account.active
			? theme.fg("accent", "●")
			: account.limit || snapshot?.limitReached || maxUsed >= 80
				? theme.fg("warning", "▲")
				: theme.fg("dim", "○");
		const authLabel = authWords[account.auth] ?? account.auth;
		const planText = snapshot?.plan ? `${snapshot.plan} · ${authLabel}` : authLabel;
		const planOrAuth = theme.fg("dim", account.accountLabel ? `${account.accountLabel} · ${planText}` : planText);
		const leftHeader = `  ${bullet} ${theme.bold(account.displayName)} ${planOrAuth}`;

		const badges: string[] = [];
		const totalInflight = account.inflight.foreground + account.inflight.worker + account.inflight.background;
		if (totalInflight > 0) {
			badges.push(text.inFlight(totalInflight));
		}
		if (snapshot?.resetCredits !== undefined && snapshot.resetCredits > 0) {
			badges.push(text.resetsEarned(snapshot.resetCredits));
		}
		if (account.fetch.kind === "pending") {
			badges.push(theme.fg("dim", text.refreshing));
		} else if (account.fetch.kind === "failed") {
			badges.push(theme.fg("warning", text.fetchFailed));
		} else if (snapshot) {
			const age = now - snapshot.observedAt;
			badges.push(
				age > USAGE_STALE_AFTER_MS
					? theme.fg("warning", text.stale(span(age)))
					: theme.fg("dim", text.ago(span(age))),
			);
		}
		const rightHeader = badges.join(theme.fg("dim", " · "));

		const leftW = visibleWidth(leftHeader);
		const rightW = visibleWidth(rightHeader);
		if (rightW > 0 && leftW + rightW + 2 <= width) {
			const gap = " ".repeat(width - leftW - rightW);
			lines.push(`${leftHeader}${gap}${rightHeader}`);
		} else if (rightW > 0) {
			lines.push(truncateToWidth(`${leftHeader}  ${rightHeader}`, width, "…"));
		} else {
			lines.push(truncateToWidth(leftHeader, width, "…"));
		}

		if (snapshot && snapshot.windows.length > 0) {
			const labelWidth = Math.min(24, Math.max(0, ...snapshot.windows.map((w) => visibleWidth(w.label))));
			for (const w of snapshot.windows) {
				const label = theme.fg("text", padLabel(w.label, labelWidth));
				const bar = quotaBar(w.usedPercent, 12);
				const percentStr = percentTone(w.usedPercent)(`${Math.round(w.usedPercent)}%`.padEnd(4));
				const resetStr = w.resetsAt !== undefined ? theme.fg("dim", `  ↻ ${span(w.resetsAt - now)}`) : "";
				const detailStr = w.detail ? theme.fg("dim", `  ${w.detail}`) : "";
				lines.push(`    ${label}  ${bar} ${percentStr}${resetStr}${detailStr}`);
			}
		}

		if (account.limit) {
			lines.push(
				`    ${theme.fg("warning", text.limitedUntil(clock(account.limit.until), account.limit.reason.replace(/_/g, " "), span(account.limit.until - now)))}`,
			);
		}
		if (snapshot?.limitReached) {
			lines.push(`    ${theme.fg("warning", text.limitReached(snapshot.limitReached))}`);
		}
		if (snapshot?.balance) {
			lines.push(`    ${theme.fg("text", snapshot.balance)}`);
		}
		for (const detail of snapshot?.details ?? []) {
			lines.push(`    ${theme.fg("dim", detail)}`);
		}
		if (account.fetch.kind === "failed" && !snapshot) {
			lines.push(`    ${theme.fg("warning", text.usageUnavailable(account.fetch.error))}`);
		}

		cardBlocks.push(lines);
	}

	const result: string[] = [];
	for (let i = 0; i < cardBlocks.length; i++) {
		if (i > 0) result.push("");
		result.push(...cardBlocks[i]);
	}

	if (quiet.length > 0) {
		if (result.length > 0) result.push("");
		const list = quiet.map((a) => `${a.displayName} (${authWords[a.auth] ?? a.auth})`).join(" · ");
		result.push(`  ${theme.fg("dim", text.otherCredentials)}   ${theme.fg("dim", list)}`);
	}

	return result;
}

export function formatCostBreakdownLines(overview: UsageOverview, width: number): string[] {
	const text = interfaceText().reports.dashboard;
	const session = overview.session;
	const total = Math.max(0, session.costUsd);
	const rootCost = session.rootCostUsd ?? Math.max(0, session.costUsd - session.subagentCostUsd - session.icmCostUsd);
	const s1Cost = overview.taskMetrics?.systemOneCostUsd ?? 0;
	const brainDirectCost = Math.max(0, rootCost - s1Cost);
	const sharePct = (val: number) => (total > 0 ? Math.round((val / total) * 100) : 0);
	const sums = text.costBreakdownSums(
		dollars(total),
		dollars(overview.today.costUsd),
		dollars(overview.today.rootCostUsd ?? 0),
		dollars(overview.today.subagentCostUsd),
		dollars(overview.today.icmCostUsd),
	);
	const lines: string[] = [
		`  ${theme.fg("accent", "◆")} ${theme.bold(text.costBreakdownTitle)} ${theme.fg("dim", sums)}`,
	];
	if (session.reportedCostUsd !== undefined)
		lines.push(
			theme.fg(
				"dim",
				text.recorded(dollars(session.reportedCostUsd), `${session.costEstimate ? "~" : ""}${dollars(total)}`),
			),
		);
	if (session.costEstimate || overview.today.costEstimate) lines.push(theme.fg("dim", text.estimatesNote));
	else if (session.subscription) lines.push(theme.fg("dim", text.subscriptionNote));
	if (session.apiEquivalentPartial)
		lines.push(
			theme.fg("warning", text.partialTotal(session.modelUnknownTokens ?? 0, session.modelUnknownOperations ?? 0)),
		);
	if (overview.today.apiEquivalentPartial)
		lines.push(theme.fg("warning", text.todayPartial(overview.today.modelUnknownTokens ?? 0)));
	const buckets: Array<{ label: string; cost: number; detail?: string }> = [
		{
			label: text.bucketRoot,
			cost: brainDirectCost,
			...(overview.taskMetrics ? { detail: text.rounds(overview.taskMetrics.totalRounds) } : {}),
		},
		{ label: text.bucketSubagents, cost: session.subagentCostUsd },
		...(session.icmCostUsd > 0 ? [{ label: text.bucketIcm, cost: session.icmCostUsd }] : []),
		...(s1Cost > 0
			? [
					{
						label: text.bucketSystemOne,
						cost: s1Cost,
						detail: text.evals(overview.taskMetrics?.systemOneReports ?? 0),
					},
				]
			: []),
	];
	const labelW = Math.max(20, ...buckets.map((b) => visibleWidth(b.label)));
	for (const bucket of buckets) {
		const pct = sharePct(bucket.cost);
		const bar = theme.fg("muted", filledBar(pct, 12));
		const pctStr = `${pct}%`.padStart(4);
		const detail = bucket.detail ? theme.fg("dim", `  (${bucket.detail})`) : "";
		lines.push(
			`    ${theme.fg("text", padLabel(bucket.label, labelW))}  ${bar} ${theme.fg("muted", pctStr)}  ${theme.fg("text", dollars(bucket.cost))}${detail}`,
		);
	}
	const models = overview.taskMetrics?.models ?? [];
	if (models.length > 0) {
		const modelParts = models
			.slice(0, 5)
			.map((m) =>
				text.modelEntry(m.model, m.role, dollars(m.costUsd), m.calls, m.role === "subagent", tokens(m.tokens)),
			);
		lines.push(
			truncateToWidth(
				`    ${theme.fg("dim", text.models)} ${theme.fg("muted", modelParts.join(" · "))}`,
				width,
				"…",
			),
		);
	}
	return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
}

export function formatTaskMetricsLines(overview: UsageOverview, width: number): string[] {
	const text = interfaceText().reports.dashboard;
	const tm = overview.taskMetrics;
	if (!tm || (tm.tasks.length === 0 && tm.unassignedCostUsd === 0)) return [];
	const counts = text.taskCounts(tm.tasks.length, tm.totalRounds, tm.totalToolCalls);
	const lines: string[] = [`  ${theme.fg("accent", "◆")} ${theme.bold(text.taskTitle)} ${theme.fg("dim", counts)}`];
	const recent = [...tm.tasks].reverse().slice(0, 5);
	if (tm.unassignedCostUsd > 0) lines.push(theme.fg("dim", text.unassigned(dollars(tm.unassignedCostUsd))));
	lines.push(theme.fg("dim", text.activeNote));
	for (const task of recent) {
		const glyph =
			task.status === "completed"
				? theme.fg("success", "✓")
				: task.status === "active"
					? theme.fg("accent", "●")
					: task.status === "blocked"
						? theme.fg("warning", "▲")
						: theme.fg("dim", "○");
		const stepsStr =
			task.stepsTotal !== undefined && task.stepsCompleted !== undefined
				? text.taskSteps(task.stepsCompleted, task.stepsTotal)
				: "";
		const costStr = text.taskCost(
			dollars(task.totalCostUsd),
			dollars(task.rootCostUsd),
			dollars(task.subagentCostUsd),
			task.icmCostUsd > 0 ? dollars(task.icmCostUsd) : undefined,
		);
		const statsLine = `⏱ ${task.timingEstimated ? "~" : ""}${text.taskStats(span(task.activeMs), span(task.wallMs), task.rounds, task.toolCalls, stepsStr, tokens(task.tokens), costStr)}`;
		lines.push(
			truncateToWidth(`    ${glyph} ${theme.bold(task.title)} ${theme.fg("dim", `[${task.status}]`)}`, width, "…"),
		);
		lines.push(truncateToWidth(`      ${theme.fg("muted", statsLine)}`, width, "…"));
		const clocks = [
			task.goalActiveMs === undefined ? undefined : text.goalAccounted(span(task.goalActiveMs)),
			task.workerActiveMs === undefined ? undefined : text.workerActive(span(task.workerActiveMs)),
			task.unresolvedTimedOperations ? text.unresolvedIntervals(task.unresolvedTimedOperations) : undefined,
		].filter(Boolean);
		if (clocks.length) lines.push(truncateToWidth(`      ${theme.fg("dim", clocks.join(" · "))}`, width, "…"));
	}
	return lines;
}

export function formatUsageOverviewLines(overview: UsageOverview, width: number, now = overview.at): string[] {
	const [kpi1, kpi2] = formatKpiRows(overview, width);
	const costLines = formatCostBreakdownLines(overview, width);
	const taskLines = formatTaskMetricsLines(overview, width);
	const providerLines = formatProviderCardLines(overview, width, now);
	const sections = [costLines, ...(taskLines.length > 0 ? [taskLines] : []), providerLines];
	const body: string[] = [];
	for (let i = 0; i < sections.length; i++) {
		if (i > 0) body.push("");
		body.push(...sections[i]!);
	}
	return [kpi1, kpi2, "", ...body].map((line) => truncateToWidth(line, Math.max(1, width), "…"));
}

export const USAGE_OVERVIEW_HEADER_LINES = 3;

export interface UsageDashboardOptions {
	onDispose?(): void;
	overview: UsageOverview;
	canRedeemReset: boolean;
	now?: () => number;
	maxRows?: () => number;
	onAction(action: UsageDashboardAction): void;
	requestRender?: () => void;
}

export class UsageDashboardComponent implements Component {
	private overview: UsageOverview;
	private canRedeemReset: boolean;
	private readonly options: UsageDashboardOptions;
	private readonly now: () => number;
	private readonly maxRows: () => number;
	private offset = 0;
	private bodyRows = 1;
	private totalRows = 0;

	constructor(options: UsageDashboardOptions) {
		this.options = options;
		this.overview = options.overview;
		this.canRedeemReset = options.canRedeemReset;
		this.now = options.now ?? Date.now;
		this.maxRows = options.maxRows ?? (() => 40);
	}

	update(overview: UsageOverview, canRedeemReset?: boolean): void {
		this.overview = overview;
		if (canRedeemReset !== undefined) {
			this.canRedeemReset = canRedeemReset;
		}
	}

	dispose(): void {
		this.options.onDispose?.();
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const keys = getKeybindings();
		const delta = scrollDelta(data, this.bodyRows, true);
		if (delta !== undefined) {
			this.offset = scrolledOffset(this.offset, delta, this.totalRows, this.bodyRows);
			this.options.requestRender?.();
		} else if (data === "r" || data === "R") this.options.onAction("refresh");
		else if ((data === "x" || data === "X") && this.canRedeemReset) this.options.onAction("reset");
		else if (
			keys.matches(data, "tui.select.cancel") ||
			keys.matches(data, "tui.select.confirm") ||
			data === "q" ||
			data === "Q"
		)
			this.options.onAction("close");
	}

	render(width: number): string[] {
		const { surface, border } = cardPalette();
		const inner = Math.max(1, width - 4);
		const now = this.now();

		const total = this.maxRows();
		const budget = Math.max(6, Math.min(26, Math.floor(total * 0.68), total - 8));

		const text = interfaceText().reports.dashboard;
		const titleText = text.title;
		const title = surface(theme.bold(theme.fg("text", titleText)));
		const titleWidth = visibleWidth(titleText);
		const timeText = text.updated(clock(now));
		const timeStr = surface(theme.fg("dim", timeText));
		const timeWidth = visibleWidth(timeText);
		let top: string;
		if (width >= 2 + titleWidth + timeWidth + 2) {
			const dashes = width - 2 - titleWidth - timeWidth - 2;
			top = `${border("╭─")}${title}${border("─".repeat(dashes))}${timeStr}${border("─╮")}`;
		} else {
			const available = Math.max(0, width - 2 - titleWidth - 1);
			top = `${border("╭─")}${title}${border(`${"─".repeat(available)}╮`)}`;
			top = truncateToWidth(top, width, "…");
		}

		const padRow = (row: string) => {
			const truncated = truncateToWidth(row, inner, "…");
			const pad = " ".repeat(Math.max(0, inner - visibleWidth(truncated)));
			return `${border("│")}${surface(` ${truncated}${pad} `)}${border("│")}`;
		};

		const [kpi1, kpi2] = formatKpiRows(this.overview, inner);
		const kpiRow1 = padRow(kpi1);
		const kpiRow2 = padRow(kpi2);
		const divider = `${border(`├${"─".repeat(Math.max(0, width - 2))}┤`)}`;

		const costLines = formatCostBreakdownLines(this.overview, inner);
		const taskLines = formatTaskMetricsLines(this.overview, inner);
		const providerLines = formatProviderCardLines(this.overview, inner, now);
		const content = [...costLines, ...(taskLines.length > 0 ? ["", ...taskLines] : []), "", ...providerLines];
		this.totalRows = content.length;
		const bodyBudget = Math.max(1, budget - 5);
		this.bodyRows = Math.max(1, Math.min(content.length, bodyBudget));
		const maxOffset = Math.max(0, content.length - this.bodyRows);
		this.offset = Math.min(this.offset, maxOffset);
		const shown = content.slice(this.offset, this.offset + this.bodyRows);
		const body = shown.map((row) => padRow(row));

		const more = content.length > this.bodyRows;
		const position = more ? `${this.offset + 1}-${this.offset + shown.length}/${content.length} · ` : "";
		const hints = [
			text.scrollHint,
			text.refreshHint,
			...(this.canRedeemReset ? [text.redeemHint] : []),
			text.closeHint,
		].join(" · ");
		const footer = ` ${position}${hints} `;
		const footerWidth = visibleWidth(footer);
		let bottom: string;
		if (width >= footerWidth + 3) {
			const dashes = width - 3 - footerWidth;
			bottom = `${border(`╰${"─".repeat(dashes)}`)}${surface(theme.fg("dim", footer))}${border("─╯")}`;
		} else {
			const truncatedFooter = truncateToWidth(footer, Math.max(0, width - 4), "…");
			const dashes = Math.max(0, width - 3 - visibleWidth(truncatedFooter));
			bottom = `${border(`╰${"─".repeat(dashes)}`)}${surface(theme.fg("dim", truncatedFooter))}${border("─╯")}`;
		}

		return [top, kpiRow1, kpiRow2, divider, ...body, bottom];
	}
}
