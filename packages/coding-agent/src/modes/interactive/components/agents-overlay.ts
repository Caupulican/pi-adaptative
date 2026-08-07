import { type Component, truncateToWidth } from "@caupulican/pi-tui";
import type { LaneRecord } from "../../../core/autonomy/lane-tracker.ts";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import {
	type OrchestrationPanelModel,
	type OrchestrationPanelRow,
	renderOrchestrationPanelLines,
} from "../../../core/tools/orchestration-panel.ts";
import { theme } from "../theme/theme.ts";
import type { ActivityLaneItem } from "./activity-lane.ts";
import { formatKeyText } from "./keybinding-hints.ts";

/**
 * On-demand detail view behind the statusline's aggregated concurrency counts:
 * the statusline shows "2 agent · 3 bash", this overlay names each worker and
 * background tool with status, elapsed time, and cost. Read-only; the same key
 * that opens it closes it, so it behaves as a peek.
 */

export interface AgentsOverlaySnapshot {
	laneRecords: readonly LaneRecord[];
	items: readonly ActivityLaneItem[];
}

export interface AgentsOverlayOptions {
	keybindings: KeybindingsManager;
	snapshot: () => AgentsOverlaySnapshot;
	onClose: () => void;
	/** Injectable clock for tests. */
	now?: () => number;
}

const MAX_ROWS = 12;
const MAX_FINISHED_WORKERS = 4;

export function formatElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function workerElapsed(record: LaneRecord, nowMs: number): string {
	if (!record.startedAt) return "";
	const started = Date.parse(record.startedAt);
	if (Number.isNaN(started)) return "";
	const end = record.completedAt ? Date.parse(record.completedAt) : nowMs;
	if (Number.isNaN(end)) return "";
	return formatElapsed(end - started);
}

function workerRow(record: LaneRecord, nowMs: number): OrchestrationPanelRow {
	const meta = [
		record.type === "tmux-worker" ? "tmux" : "agent",
		record.profileId,
		workerElapsed(record, nowMs),
		record.costUsd !== undefined ? `$${record.costUsd.toFixed(2)}` : undefined,
	].filter((value): value is string => value !== undefined && value !== "");
	return {
		status: record.status,
		label: record.label ?? record.laneId,
		section: "Workers",
		meta,
	};
}

function backgroundToolRow(item: ActivityLaneItem): OrchestrationPanelRow {
	return {
		status: item.status === "waiting" ? "queued" : "running",
		label: item.label,
		section: "Background tools",
		meta: item.tag ? [item.tag] : [],
	};
}

const ACTIVE_WORKER_STATUSES = new Set<LaneRecord["status"]>(["queued", "running"]);

export function buildAgentsPanelModel(snapshot: AgentsOverlaySnapshot, nowMs: number): OrchestrationPanelModel {
	const workers = snapshot.laneRecords.filter((record) => record.type === "worker" || record.type === "tmux-worker");
	const activeWorkers = workers.filter((record) => ACTIVE_WORKER_STATUSES.has(record.status));
	const finishedWorkers = workers
		.filter((record) => !ACTIVE_WORKER_STATUSES.has(record.status))
		.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
		.slice(0, MAX_FINISHED_WORKERS);
	const backgroundTools = snapshot.items.filter(
		(item) => item.kind === "tool" && (item.status === "active" || item.status === "waiting"),
	);

	const rows: OrchestrationPanelRow[] = [
		...activeWorkers.map((record) => workerRow(record, nowMs)),
		...finishedWorkers.map((record) => workerRow(record, nowMs)),
		...backgroundTools.map(backgroundToolRow),
	];
	const shown = rows.slice(0, MAX_ROWS);

	const running = activeWorkers.filter((record) => record.status === "running").length;
	const queued = activeWorkers.length - running;
	const summary = [
		running > 0 ? `${running} running` : undefined,
		queued > 0 ? `${queued} queued` : undefined,
		backgroundTools.length > 0
			? `${backgroundTools.length} background tool${backgroundTools.length === 1 ? "" : "s"}`
			: undefined,
	].filter((value): value is string => value !== undefined);

	return {
		label: "Agents",
		status: workers.some((record) => record.status === "failed") ? "error" : "info",
		summary,
		rows: shown,
		hiddenRowCount: rows.length - shown.length,
		emptyText: "No agents or background work right now",
	};
}

export class AgentsOverlay implements Component {
	private readonly options: AgentsOverlayOptions;

	constructor(options: AgentsOverlayOptions) {
		this.options = options;
	}

	handleInput(data: string): void {
		if (
			this.options.keybindings.matches(data, "app.agents.close") ||
			this.options.keybindings.matches(data, "app.agents.open")
		) {
			this.options.onClose();
		}
	}

	render(width: number): string[] {
		const nowMs = this.options.now?.() ?? Date.now();
		const model = buildAgentsPanelModel(this.options.snapshot(), nowMs);
		const surface = (text: string) => theme.bg("customMessageBg", truncateToWidth(text, width, "", true));
		const closeKey = formatKeyText(this.options.keybindings.getKeys("app.agents.close").join("/"), {
			capitalize: true,
		});
		const body = renderOrchestrationPanelLines(theme, model, Math.max(1, width - 2), true);
		return [
			surface(""),
			...body.map((line) => surface(` ${line}`)),
			surface(""),
			surface(theme.fg("muted", ` ${closeKey} close`)),
		];
	}

	invalidate(): void {}
}
