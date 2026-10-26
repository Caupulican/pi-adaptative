import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import type {
	AccountOverview,
	AccountUsageSnapshot,
	UsageOverview,
} from "../../../core/provider-admission/usage-overview.ts";
import { theme } from "../../../presentation/theme-model.ts";

export const USAGE_STALE_AFTER_MS = 15 * 60_000;

export type UsageDashboardAction = "refresh" | "reset" | "close";
const AUTH_LABELS: Readonly<Record<AccountOverview["auth"], string>> = {
	subscription: "subscription",
	oauth: "oauth",
	api_key: "api key",
	environment: "env key",
	models_json: "models.json key",
	headers: "auth headers",
};

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

function quotaBar(usedPercent: number, cells = 12): string {
	const clamped = Math.max(0, Math.min(100, usedPercent));
	const filled = Math.max(0, Math.min(cells, Math.round((clamped / 100) * cells)));
	const free = cells - filled;
	const bar = "█".repeat(filled) + "░".repeat(free);
	return percentTone(usedPercent)(bar);
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
	const session = overview.session;
	const subText = session.subscription ? " (sub)" : "";
	const subagentText = session.subagentCostUsd > 0 ? ` ($${session.subagentCostUsd.toFixed(2)} subagents)` : "";
	const left1 = `${theme.fg("dim", "SESSION  ")}${theme.fg("text", `${dollars(session.costUsd)}${subText}${subagentText}`)}${theme.fg("dim", " · Today ")}${theme.fg("text", dollars(overview.today.costUsd))}`;

	const cacheTotal = session.tokens.input + session.tokens.cacheRead + session.tokens.cacheWrite;
	const cacheSummary =
		cacheTotal > 0 ? `${Math.round((session.tokens.cacheRead / cacheTotal) * 100)}% cached` : "0% cached";
	const right1 = `${theme.fg("dim", "TOKENS  ")}${theme.fg("text", `${tokens(session.tokens.input)} in · ${tokens(session.tokens.output)} out · ${cacheSummary}`)}`;

	let contextGauge: string;
	if (!session.context) {
		contextGauge = theme.fg("dim", "unavailable");
	} else {
		const win = session.context.window;
		const pct =
			session.context.percent ??
			(session.context.tokens !== null && win > 0 ? (session.context.tokens / win) * 100 : 0);
		const used = session.context.tokens ?? 0;
		const clamped = Math.max(0, Math.min(100, pct));
		const filled = Math.max(0, Math.min(12, Math.round((clamped / 100) * 12)));
		const free = 12 - filled;
		const bar = "█".repeat(filled) + "░".repeat(free);
		const tone = pct >= 95 ? "error" : pct >= 75 ? "warning" : "accent";
		contextGauge = `${theme.fg(tone, bar)} ${Math.round(pct)}% (${tokens(used)} / ${tokens(win)})`;
	}
	const left2 = `${theme.fg("dim", "CONTEXT  ")}${contextGauge}`;

	const machine = overview.machine;
	let loadSummary: string;
	if (machine.emergencyStop.engaged) {
		loadSummary = theme.fg("error", "ESTOP ENGAGED");
	} else if (machine.inflight > 0) {
		const other = machine.otherAccountsInflight > 0 ? ` · ${machine.otherAccountsInflight} other` : "";
		loadSummary = `${machine.inflight} in flight${other}`;
	} else {
		const other = machine.otherAccountsInflight > 0 ? ` · ${machine.otherAccountsInflight} other` : "";
		loadSummary = `idle${other}`;
	}
	const right2 = `${theme.fg("dim", "LOAD  ")}${theme.fg("text", loadSummary)}`;

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
	if (overview.accounts.length === 0) {
		return [theme.fg("dim", "  No provider has credentials in this session.")];
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
		const authLabel = AUTH_LABELS[account.auth] ?? account.auth;
		const planText = snapshot?.plan ? `${snapshot.plan} · ${authLabel}` : authLabel;
		const planOrAuth = theme.fg("dim", account.accountLabel ? `${account.accountLabel} · ${planText}` : planText);
		const leftHeader = `  ${bullet} ${theme.bold(account.displayName)} ${planOrAuth}`;

		const badges: string[] = [];
		const totalInflight = account.inflight.foreground + account.inflight.worker + account.inflight.background;
		if (totalInflight > 0) {
			badges.push(`${totalInflight} in flight`);
		}
		if (snapshot?.resetCredits !== undefined && snapshot.resetCredits > 0) {
			badges.push(`${snapshot.resetCredits} reset${snapshot.resetCredits === 1 ? "" : "s"} earned`);
		}
		if (account.fetch.kind === "pending") {
			badges.push(theme.fg("dim", "refreshing…"));
		} else if (account.fetch.kind === "failed") {
			badges.push(theme.fg("warning", "fetch failed"));
		} else if (snapshot) {
			const age = now - snapshot.observedAt;
			badges.push(
				age > USAGE_STALE_AFTER_MS
					? theme.fg("warning", `stale · ${span(age)}`)
					: theme.fg("dim", `${span(age)} ago`),
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
			const labelWidth = Math.min(24, Math.max(0, ...snapshot.windows.map((w) => w.label.length)));
			for (const w of snapshot.windows) {
				const label = theme.fg("text", w.label.padEnd(labelWidth));
				const bar = quotaBar(w.usedPercent, 12);
				const percentStr = percentTone(w.usedPercent)(`${Math.round(w.usedPercent)}%`.padEnd(4));
				const resetStr = w.resetsAt !== undefined ? theme.fg("dim", `  ↻ ${span(w.resetsAt - now)}`) : "";
				const detailStr = w.detail ? theme.fg("dim", `  ${w.detail}`) : "";
				lines.push(`    ${label}  ${bar} ${percentStr}${resetStr}${detailStr}`);
			}
		}

		if (account.limit) {
			lines.push(
				`    ${theme.fg("warning", `limited until ${clock(account.limit.until)} (${account.limit.reason.replace(/_/g, " ")}, in ${span(account.limit.until - now)})`)}`,
			);
		}
		if (snapshot?.limitReached) {
			lines.push(`    ${theme.fg("warning", `limit reached: ${snapshot.limitReached}`)}`);
		}
		if (snapshot?.balance) {
			lines.push(`    ${theme.fg("text", snapshot.balance)}`);
		}
		for (const detail of snapshot?.details ?? []) {
			lines.push(`    ${theme.fg("dim", detail)}`);
		}
		if (account.fetch.kind === "failed" && !snapshot) {
			lines.push(`    ${theme.fg("warning", `account usage unavailable: ${account.fetch.error}`)}`);
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
		const list = quiet.map((a) => `${a.displayName} (${AUTH_LABELS[a.auth] ?? a.auth})`).join(" · ");
		result.push(`  ${theme.fg("dim", "○ Other credentials")}   ${theme.fg("dim", list)}`);
	}

	return result;
}

export function formatUsageOverviewLines(overview: UsageOverview, width: number, now = overview.at): string[] {
	const [kpi1, kpi2] = formatKpiRows(overview, width);
	const providerLines = formatProviderCardLines(overview, width, now);
	return [kpi1, kpi2, "", ...providerLines].map((line) => truncateToWidth(line, Math.max(1, width), "…"));
}

export const USAGE_OVERVIEW_HEADER_LINES = 3;

export interface UsageDashboardOptions {
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

	invalidate(): void {}

	handleInput(data: string): void {
		const keys = getKeybindings();
		const maxOffset = Math.max(0, this.totalRows - this.bodyRows);
		const scroll = (delta: number) => {
			this.offset = Math.max(0, Math.min(maxOffset, this.offset + delta));
			this.options.requestRender?.();
		};
		if (keys.matches(data, "tui.select.up") || data === "k") scroll(-1);
		else if (keys.matches(data, "tui.select.down") || data === "j") scroll(1);
		else if (keys.matches(data, "tui.select.pageUp")) scroll(-this.bodyRows);
		else if (keys.matches(data, "tui.select.pageDown")) scroll(this.bodyRows);
		else if (data === "r" || data === "R") this.options.onAction("refresh");
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
		const surface = (text: string) => theme.bg("customMessageBg", text);
		const border = (text: string) => surface(theme.fg("borderMuted", text));
		const inner = Math.max(1, width - 4);
		const now = this.now();

		const total = this.maxRows();
		const budget = Math.max(6, Math.min(26, Math.floor(total * 0.68), total - 8));

		const titleText = " Usage & Quotas ";
		const title = surface(theme.bold(theme.fg("text", titleText)));
		const titleWidth = visibleWidth(titleText);
		const timeText = ` updated ${clock(now)} `;
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

		const content = formatProviderCardLines(this.overview, inner, now);
		this.totalRows = content.length;
		const bodyBudget = Math.max(1, budget - 5);
		this.bodyRows = Math.max(1, Math.min(content.length, bodyBudget));
		const maxOffset = Math.max(0, content.length - this.bodyRows);
		this.offset = Math.min(this.offset, maxOffset);
		const shown = content.slice(this.offset, this.offset + this.bodyRows);
		const body = shown.map((row) => padRow(row));

		const more = content.length > this.bodyRows;
		const position = more ? `${this.offset + 1}-${this.offset + shown.length}/${content.length} · ` : "";
		const hints = ["↑↓ scroll", "r refresh", ...(this.canRedeemReset ? ["x redeem reset"] : []), "Esc close"].join(
			" · ",
		);
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
