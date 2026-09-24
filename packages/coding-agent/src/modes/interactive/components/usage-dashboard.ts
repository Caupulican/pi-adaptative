import {
	type Component,
	Container,
	getKeybindings,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	truncateToWidth,
} from "@caupulican/pi-tui";
import type {
	AccountOverview,
	AccountUsageSnapshot,
	UsageOverview,
	UsageWindow,
} from "../../../core/provider-admission/usage-overview.ts";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { SelectorNavigationFooter } from "./selector-list.ts";

export const USAGE_STALE_AFTER_MS = 15 * 60_000;

export type UsageDashboardAction = "refresh" | "reset" | "close";

const ACTION_LAYOUT: SelectListLayoutOptions = { minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 28 };
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
	if (percent >= 80) return (text) => theme.fg("warning", text);
	return (text) => text;
}

function observed(snapshot: AccountUsageSnapshot, now: number): string {
	const verb = snapshot.source === "account_api" ? "fetched" : "seen in responses";
	const age = now - snapshot.observedAt;
	const text = `${verb} ${clock(snapshot.observedAt)} (${span(age)} ago)`;
	return age > USAGE_STALE_AFTER_MS ? theme.fg("warning", `${text} · stale`) : theme.fg("dim", text);
}

function windowLine(window: UsageWindow, now: number, labelWidth: number): string {
	const percent = `${Math.round(window.usedPercent)}%`.padStart(4);
	const reset =
		window.resetsAt === undefined
			? ""
			: theme.fg("dim", `  resets ${clock(window.resetsAt)} (in ${span(window.resetsAt - now)})`);
	const detail = window.detail ? theme.fg("dim", `  ${window.detail}`) : "";
	return `    ${window.label.padEnd(labelWidth)} ${percentTone(window.usedPercent)(percent)}${reset}${detail}`;
}

function fetchLine(account: AccountOverview): { line?: string; snapshot?: AccountUsageSnapshot } {
	const fetch = account.fetch;
	switch (fetch.kind) {
		case "fetched":
			return { snapshot: fetch.snapshot };
		case "pending":
			return { line: theme.fg("dim", "refreshing account usage…"), snapshot: fetch.last ?? account.passive };
		case "failed":
			return {
				line: theme.fg("warning", `account usage unavailable: ${fetch.error} (${clock(fetch.at)})`),
				snapshot: fetch.last ?? account.passive,
			};
		case "idle":
			return { line: account.passive ? undefined : theme.fg("dim", "not fetched yet"), snapshot: account.passive };
		case "unsupported":
			return {
				line: theme.fg("dim", "account usage is not available in Pi for this provider"),
				snapshot: account.passive,
			};
	}
}

function accountLines(account: AccountOverview, now: number): string[] {
	const lines: string[] = [];
	const { line, snapshot } = fetchLine(account);
	const inflight = account.inflight.foreground + account.inflight.worker + account.inflight.background;
	const meta = [
		account.accountLabel,
		AUTH_LABELS[account.auth],
		snapshot?.plan,
		inflight > 0
			? `${inflight} in flight (${account.inflight.foreground} fg, ${account.inflight.worker} worker, ${account.inflight.background} bg)`
			: undefined,
	]
		.filter(Boolean)
		.join(" · ");
	lines.push(`  ${theme.bold(account.displayName)}${meta ? theme.fg("dim", ` ${meta}`) : ""}`);
	if (account.limit) {
		lines.push(
			`    ${theme.fg("warning", `limited until ${clock(account.limit.until)} (${account.limit.reason.replace("_", " ")}, in ${span(account.limit.until - now)})`)}`,
		);
	}
	if (line) lines.push(`    ${line}`);
	if (snapshot) {
		const labelWidth = Math.min(22, Math.max(0, ...snapshot.windows.map((window) => window.label.length)));
		for (const window of snapshot.windows) lines.push(windowLine(window, now, labelWidth));
		if (snapshot.balance) lines.push(`    ${snapshot.balance}`);
		for (const detail of snapshot.details ?? []) lines.push(`    ${theme.fg("dim", detail)}`);
		if (snapshot.limitReached) lines.push(`    ${theme.fg("warning", `limit reached: ${snapshot.limitReached}`)}`);
		if (snapshot.resetCredits !== undefined && snapshot.resetCredits > 0) {
			lines.push(
				`    ${snapshot.resetCredits} earned ${snapshot.resetCredits === 1 ? "reset" : "resets"} available`,
			);
		}
		lines.push(`    ${observed(snapshot, now)}`);
	}
	const fetch = account.fetch;
	if ((fetch.kind === "fetched" || fetch.kind === "failed") && fetch.nextRefreshAt !== undefined) {
		lines.push(
			`    ${theme.fg("dim", `next refresh from ${clock(fetch.nextRefreshAt)} (in ${span(fetch.nextRefreshAt - now)})`)}`,
		);
	}
	return lines;
}

export function formatUsageOverviewLines(overview: UsageOverview, width: number, now = overview.at): string[] {
	const session = overview.session;
	const context = session.context
		? session.context.percent === null
			? `context ?/${tokens(session.context.window)}`
			: `context ${Math.round(session.context.percent)}% of ${tokens(session.context.window)}`
		: undefined;
	const sessionParts = [
		`${dollars(session.costUsd)}${session.subscription ? " (sub)" : ""}${session.subagentCostUsd > 0 ? theme.fg("dim", ` incl. subagents ${dollars(session.subagentCostUsd)}`) : ""}`,
		`in ${tokens(session.tokens.input)} out ${tokens(session.tokens.output)} cache ${tokens(session.tokens.cacheRead)}/${tokens(session.tokens.cacheWrite)}`,
		context,
	].filter(Boolean);
	const machine = overview.machine;
	const machineParts = [
		`${machine.inflight} in flight`,
		machine.otherAccountsInflight > 0 ? `${machine.otherAccountsInflight} on other accounts` : undefined,
		machine.otherAccountLimits > 0 ? `${machine.otherAccountLimits} limits on other accounts` : undefined,
		machine.emergencyStop.engaged
			? theme.fg("error", `estop ENGAGED${machine.emergencyStop.reason ? ` (${machine.emergencyStop.reason})` : ""}`)
			: "estop off",
	].filter(Boolean);
	const label = (text: string) => theme.fg("dim", text.padEnd(9));
	const lines = [
		`${theme.bold("Usage & limits")}${theme.fg("dim", `  as of ${clock(now)}`)}`,
		`${label("Session")}${sessionParts.join(" · ")}`,
		`${label("Today")}${dollars(overview.today.costUsd)}${overview.today.subagentCostUsd > 0 ? theme.fg("dim", ` incl. subagents ${dollars(overview.today.subagentCostUsd)}`) : ""}`,
		`${label("Machine")}${machineParts.join(" · ")}`,
		"",
	];
	if (overview.accounts.length === 0) lines.push(theme.fg("dim", "  No provider has credentials in this session."));
	for (const [index, account] of overview.accounts.entries()) {
		if (index > 0) lines.push("");
		lines.push(...accountLines(account, now));
	}
	return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
}

export const USAGE_OVERVIEW_HEADER_LINES = 5;

class UsageOverviewBody implements Component {
	overview: UsageOverview;
	offset = 0;
	private readonly now: () => number;
	private readonly maxRows: () => number;

	constructor(overview: UsageOverview, now: () => number, maxRows: () => number) {
		this.overview = overview;
		this.now = now;
		this.maxRows = maxRows;
	}

	scroll(direction: 1 | -1): void {
		this.offset = Math.max(0, this.offset + direction * Math.max(1, this.accountRows() - 1));
	}

	private accountRows(): number {
		return Math.max(3, this.maxRows() - USAGE_OVERVIEW_HEADER_LINES - 1);
	}

	render(width: number): string[] {
		const lines = formatUsageOverviewLines(this.overview, Math.max(1, width - 2), this.now());
		const header = lines.slice(0, USAGE_OVERVIEW_HEADER_LINES);
		const accounts = lines.slice(USAGE_OVERVIEW_HEADER_LINES);
		const rows = this.accountRows();
		if (accounts.length <= rows) {
			this.offset = 0;
			return lines.map((line) => ` ${line}`);
		}
		const visible = rows - 1;
		this.offset = Math.min(this.offset, accounts.length - visible);
		const shown = accounts.slice(this.offset, this.offset + visible);
		const keys = getKeybindings();
		const position = theme.fg(
			"dim",
			truncateToWidth(
				`lines ${this.offset + 1}–${this.offset + shown.length} of ${accounts.length} · ${keys.getKeys("tui.select.pageUp").join("/")} ${keys.getKeys("tui.select.pageDown").join("/")} to scroll`,
				Math.max(1, width - 2),
				"…",
			),
		);
		return [...header, ...shown, position].map((line) => ` ${line}`);
	}

	invalidate(): void {}
}

export interface UsageDashboardOptions {
	overview: UsageOverview;
	canRedeemReset: boolean;
	now?: () => number;
	maxRows?: () => number;
	onAction(action: UsageDashboardAction): void;
}

export class UsageDashboardComponent extends Container {
	private readonly body: UsageOverviewBody;
	private readonly actions: SelectList;
	private readonly maxRows: () => number;
	private bodyRows = 40;

	constructor(options: UsageDashboardOptions) {
		super();
		this.maxRows = options.maxRows ?? (() => 40);
		this.body = new UsageOverviewBody(options.overview, options.now ?? Date.now, () => this.bodyRows);
		const items = [
			{ value: "refresh", label: "Refresh", description: "Fetch account usage now" },
			...(options.canRedeemReset
				? [{ value: "reset", label: "Redeem earned reset", description: "OpenAI Codex · asks before using one" }]
				: []),
			{ value: "close", label: "Close", description: "Back to the conversation" },
		];
		this.actions = new SelectList(items, items.length, getSelectListTheme(), ACTION_LAYOUT);
		this.actions.onSelect = (item) => options.onAction(item.value as UsageDashboardAction);
		this.actions.onCancel = () => options.onAction("close");
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(this.body);
		this.addChild(new Spacer(1));
		this.addChild(this.actions);
		this.addChild(new SelectorNavigationFooter("select"));
	}

	update(overview: UsageOverview): void {
		this.body.overview = overview;
	}

	override render(width: number): string[] {
		const chrome = this.children
			.filter((child) => child !== this.body)
			.reduce((rows, child) => rows + child.render(width).length, 0);
		this.bodyRows = this.maxRows() - chrome;
		return super.render(width);
	}

	handleInput(data: string): void {
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.pageUp")) this.body.scroll(-1);
		else if (keys.matches(data, "tui.select.pageDown")) this.body.scroll(1);
		else this.actions.handleInput(data);
	}
}
