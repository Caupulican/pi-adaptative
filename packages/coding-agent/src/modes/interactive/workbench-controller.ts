import type { AgentMessage } from "@caupulican/pi-agent-core";
import { sanitizeBinaryOutput } from "@caupulican/pi-agent-core/shell-output";
import { type Component, isMouseSequence, parseMouseSequence, Text } from "@caupulican/pi-tui";
import type { LaneRecord } from "../../core/autonomy/lane-tracker.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { type OrchestrationPanelModel, renderOrchestrationPanelRows } from "../../core/tools/orchestration-panel.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import type { ActivityLaneItem } from "./components/activity-lane.ts";
import { type AgentsOverlaySnapshot, buildWorkPanelModel, compactWorkPanel } from "./components/agents-overlay.ts";
import { fullConversationText } from "./components/question-conversation.ts";
import {
	PLAN_SECTION,
	TEAM_SECTION,
	type WorkbenchComponent,
	type WorkbenchRunState,
	type WorkbenchSection,
} from "./components/workbench.ts";
import { theme } from "./theme/theme.ts";
import { WorkspaceObservation } from "./workbench-workspace.ts";

interface WorkbenchPorts {
	keybindings: KeybindingsManager;
	isInteractive: () => boolean;
	requestRender: () => void;
	messages: () => Iterable<AgentMessage>;
	copy: (text: string) => Promise<void>;
	notice: (text: string, error?: boolean) => void;
}

/** UI-only cycle, input and copy coordinator. Task/worker state is never mutated here. */
export class WorkbenchController {
	readonly view: WorkbenchComponent;
	private readonly ports: WorkbenchPorts;
	private previews: Component[] = [];
	private failed = 0;
	private actionCount = 0;
	private fileEffects = 0;
	/** Evidence of the previous cycle stays on screen until the new cycle produces its own. */
	private staleEvidence = false;
	private selecting = false;
	/** Left button went down inside the conversation; a drag from here selects, a plain click does not. */
	private pressPoint?: { row: number; column: number };
	private snapshot?: AgentsOverlaySnapshot;
	private runState: WorkbenchRunState = "idle";
	private workTitle?: string;
	private disposed = false;
	private readonly workspace: WorkspaceObservation;
	private lastObservationNote?: string;
	private observationReady?: Promise<void>;
	private observationTurn = 0;

	constructor(view: WorkbenchComponent, ports: WorkbenchPorts, workspace = new WorkspaceObservation()) {
		this.view = view;
		this.ports = ports;
		this.workspace = workspace;
	}

	reset(): void {
		this.workspace.dispose();
		this.observationReady = undefined;
		this.observationTurn++;
		this.previews = [];
		this.failed = 0;
		this.actionCount = 0;
		this.fileEffects = 0;
		this.staleEvidence = false;
		this.lastObservationNote = undefined;
		this.snapshot = undefined;
		this.runState = "idle";
		this.workTitle = undefined;
		this.view.conversation.reset();
		this.view.setExecution(undefined);
		this.view.setInspector([]);
		this.publishHeadline();
	}

	dispose(): void {
		this.disposed = true;
		this.reset();
	}

	beginCycle(cwd?: string): void {
		this.view.dismissUserShell();
		this.workspace.dispose();
		this.observationReady = undefined;
		this.observationTurn++;
		if (cwd) this.observationReady = this.workspace.begin(cwd);
		this.staleEvidence = true;
		this.lastObservationNote = undefined;
		this.runState = "working";
		this.publishHeadline();
		// A prior failed action remains a receipt; a new task is not evidence of recovery.
		this.updateExecution();
	}

	complete(): void {
		this.runState = "idle";
		this.publishHeadline();
		this.updateExecution();
	}

	/** The first evidence of a cycle replaces the previous cycle's previews and counters. */
	private beginEvidence(): void {
		if (!this.staleEvidence) return;
		this.staleEvidence = false;
		this.previews = [];
		this.actionCount = 0;
		this.fileEffects = 0;
	}

	private publishHeadline(): void {
		this.view.setHeadline({ title: this.workTitle, state: this.runState });
	}

	beforeTool(name: string, cwd: string): void {
		if (name !== "python" && name !== "bash") return;
		this.observationReady ??= this.workspace.begin(cwd);
		this.workspace.noteExecution();
	}

	async afterTool(name: string): Promise<void> {
		if (!this.observationReady || (name !== "python" && name !== "bash")) return;
		const turn = this.observationTurn;
		await this.observationReady;
		if (turn !== this.observationTurn || this.disposed) return;
		const result = await this.workspace.observe();
		if (!result || turn !== this.observationTurn || this.disposed) return;
		if (result.note && result.note !== this.lastObservationNote) this.ports.notice(result.note, true);
		this.lastObservationNote = result.note;
		if (!result.paths.length) return;
		this.beginEvidence();
		const paths = result.paths
			.slice(0, 12)
			.map((path) => sanitizeBinaryOutput(stripAnsi(path)))
			.join("\n");
		const patch = sanitizeBinaryOutput(stripAnsi(result.patch.slice(0, 16_384))).split("\n", 60);
		const count = result.paths.length;
		this.fileEffects += count;
		// This is current workspace evidence, not an attribution claim or an agent-only diff.
		let preview: Text | undefined;
		this.previews.push({
			render: (width) => {
				preview ??= new Text(
					theme.fg("accent", `Observed ${count} workspace changes`) +
						`\n${paths}\n` +
						theme.fg("dim", "Current diff; may include prior or concurrent edits") +
						`\n${patch.map((line) => theme.fg(line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext", line)).join("\n")}`,
					0,
					0,
				);
				return preview.render(width);
			},
			invalidate: () => {
				preview = undefined;
			},
		});
		if (this.previews.length > MAX_PREVIEWS) this.previews.shift();
		this.updateExecution();
	}

	record(preview: Component | undefined, failed: boolean): void {
		this.view.dismissUserShell();
		this.beginEvidence();
		this.actionCount++;
		if (failed) this.failed++;
		if (preview) {
			this.previews.push(preview);
			if (this.previews.length > MAX_PREVIEWS) this.previews.shift();
		}
		this.updateExecution();
	}

	private updateExecution(): void {
		if (!this.previews.length && !this.failed) {
			this.view.setExecution(undefined);
			return;
		}
		// The cycle's evidence stays in order, newest last; the pane follows it until the operator scrolls.
		const summary = theme.fg(
			this.failed ? "warning" : "muted",
			`${this.actionCount} actions${this.fileEffects ? ` · ${this.fileEffects} file effects` : ""}${this.failed ? ` · ${this.failed} failure receipts` : ""}`,
		);
		this.view.setExecution(
			{
				render: (width) =>
					this.previews.flatMap((preview, index) => [...(index ? [""] : []), ...preview.render(width)]),
				invalidate: () => {
					for (const preview of this.previews) preview.invalidate();
				},
			},
			!this.previews.length,
			this.previews.at(-1),
			summary,
		);
		this.ports.requestRender();
	}

	refresh(snapshot: AgentsOverlaySnapshot): void {
		this.snapshot = snapshot;
		this.view.setInspector(buildWorkbenchSections(snapshot, Date.now()));
		this.workTitle = workTitle(snapshot.items);
		if (snapshot.items.some((item) => item.kind === "runtime" && item.status === "waiting"))
			this.runState = "waiting";
		else if (this.runState === "waiting") this.runState = "working";
		this.publishHeadline();
	}

	invalidate(): void {
		if (this.snapshot) this.refresh(this.snapshot);
	}

	handleInput(data: string): { consume: true } | undefined {
		if (this.disposed || !this.ports.isInteractive()) {
			this.selecting = false;
			this.pressPoint = undefined;
			return undefined;
		}
		const keys = this.ports.keybindings;
		const conversation = this.view.conversation;
		if (this.view.conversationHeight === 0) {
			this.selecting = false;
			return isMouseSequence(data) ? { consume: true } : undefined;
		}
		if (keys.matches(data, "app.conversation.pageUp"))
			conversation.scroll(-Math.max(1, this.view.conversationHeight - 1));
		else if (keys.matches(data, "app.conversation.pageDown"))
			conversation.scroll(Math.max(1, this.view.conversationHeight - 1));
		else if (keys.matches(data, "app.conversation.latest")) conversation.latest();
		else if (keys.matches(data, "app.conversation.copy")) void this.copy(true);
		else if (keys.matches(data, "app.execution.toggle")) this.view.toggleUpper();
		else if (keys.matches(data, "app.workbench.grow")) this.view.growUpper();
		else if (keys.matches(data, "app.workbench.shrink")) this.view.shrinkUpper();
		else {
			const mouse = parseMouseSequence(data);
			if (!mouse) return undefined;
			const { button, action, column, row } = mouse;
			const hit = this.view.hitTest(column, row);
			if (action === "scroll") {
				const delta = button === "wheelUp" ? -3 : 3;
				if (hit === "conversation") conversation.scroll(delta);
				else this.view.scrollUpper(column, row, delta);
			} else if (action === "down" && button === "left" && hit === "conversationHeader") {
				const headerAction = this.view.headerAction(column);
				if (headerAction === "latest") conversation.latest();
				else if (headerAction) void this.copy(headerAction === "copyAll");
			} else if (action === "down" && button === "left" && hit === "divider") {
				this.view.toggleUpper();
			} else if (action === "down" && button === "left" && hit === "conversation") {
				// A click only focuses the pane; the selection (and its frozen view) starts on drag.
				this.pressPoint = { row: row - this.view.conversationTop, column: column - this.view.conversationLeft };
				this.selecting = false;
			} else if (this.pressPoint && (action === "drag" || action === "up")) {
				const point = this.view.toConversationPoint(column, row);
				const moved = point.row !== this.pressPoint.row || point.column !== this.pressPoint.column;
				if (!this.selecting && action === "drag" && moved) {
					conversation.select(this.pressPoint, true);
					this.selecting = true;
				}
				if (this.selecting) conversation.select(point, false);
				if (action === "up") {
					this.selecting = false;
					this.pressPoint = undefined;
				}
			}
			// Consume terminal mouse reports even outside the pane; never insert protocol bytes into input.
		}
		this.ports.requestRender();
		return { consume: true };
	}

	async copy(all: boolean): Promise<void> {
		try {
			const text = all ? fullConversationText(this.ports.messages()) : this.view.conversation.selectionText();
			if (!text) {
				this.ports.notice(all ? "No conversation to copy yet" : "Select conversation text first");
				return;
			}
			await this.ports.copy(text);
			if (!this.disposed) this.ports.notice(all ? "Copied full conversation" : "Copied selection");
		} catch (error) {
			if (!this.disposed) this.ports.notice(error instanceof Error ? error.message : String(error), true);
		}
	}
}

const MAX_PREVIEWS = 12;
const TEAM_SECTIONS = new Set(["Workers", "Background tools"]);
const ACTIVE_WORKER = new Set<LaneRecord["status"]>(["queued", "running"]);

function rowsComponent(model: OrchestrationPanelModel): Component {
	return { render: (width) => renderOrchestrationPanelRows(theme, model, width), invalidate() {} };
}

/** Plan or goal label the activity lane would show; commentary and tools never name the work. */
export function workTitle(items: readonly ActivityLaneItem[]): string | undefined {
	const live = (kind: ActivityLaneItem["kind"]) =>
		items.find((item) => item.kind === kind && item.status !== "success" && item.status !== "failure")?.label;
	return live("task") ?? live("goal");
}

/**
 * Work plan and Team blocks for the inspector. Long plans show a bounded, prioritized slice; a
 * finished plan or an idle team folds to one summary row without deleting anything.
 */
export function buildWorkbenchSections(snapshot: AgentsOverlaySnapshot, nowMs: number): WorkbenchSection[] {
	const model = buildWorkPanelModel(snapshot, nowMs);
	const rows = model.rows ?? [];
	const planRows = rows.filter((row) => !TEAM_SECTIONS.has(row.section ?? ""));
	const teamRows = rows.filter((row) => TEAM_SECTIONS.has(row.section ?? ""));
	const sections: WorkbenchSection[] = [];
	const task = snapshot.taskState;
	const goal = snapshot.goalState;
	if (task || goal || planRows.length) {
		const plan = compactWorkPanel({ ...model, rows: planRows }, 6);
		const shown = plan.rows ?? [];
		const totalSteps = task ? task.steps.length + task.archive.completed + task.archive.cancelled : 0;
		const doneSteps = task
			? task.archive.completed + task.steps.filter((step) => step.status === "completed").length
			: 0;
		const satisfied = goal?.requirements.filter((requirement) => requirement.status === "satisfied").length ?? 0;
		const meta = task
			? `${doneSteps} / ${totalSteps}`
			: goal
				? `${satisfied} / ${goal.requirements.length} requirements`
				: "";
		const singleSection = new Set(shown.map((row) => row.section)).size <= 1;
		const body: Component | string[] = shown.length
			? rowsComponent({
					...plan,
					rows: singleSection ? shown.map((row) => ({ ...row, section: undefined })) : shown,
				})
			: [
					`  ${theme.fg("success", "✓")} ${theme.fg("muted", planRows.length ? `Work complete · ${planRows.length} steps` : "No open steps")}`,
				];
		sections.push({ title: PLAN_SECTION, meta, body });
	}
	if (teamRows.length) {
		const team = compactWorkPanel({ ...model, rows: teamRows }, 4);
		const shown = team.rows ?? [];
		const workers = snapshot.laneRecords.filter(
			(record) => record.type === "worker" || record.type === "tmux-worker",
		);
		const active = workers.filter((record) => ACTIVE_WORKER.has(record.status)).length;
		const meta = active ? `${active} active` : `${workers.length} ${workers.length === 1 ? "agent" : "agents"}`;
		const body: Component | string[] = shown.length
			? rowsComponent({ ...team, rows: shown.map((row) => ({ ...row, section: undefined })) })
			: [
					`  ${theme.fg("success", "✓")} ${theme.fg("muted", `Team idle · ${workers.length} ${workers.length === 1 ? "session" : "sessions"} retained`)}`,
				];
		sections.push({ title: TEAM_SECTION, meta, body });
	}
	return sections;
}
