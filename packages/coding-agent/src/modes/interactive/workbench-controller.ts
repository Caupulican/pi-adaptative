import { type AgentMessage, type ToolInvocationObservation, ToolInvocationReport } from "@caupulican/pi-agent-core";
import { sanitizeBinaryOutput } from "@caupulican/pi-agent-core/shell-output";
import { type Component, isMouseSequence, parseMouseSequence, Text, wrapTextWithAnsi } from "@caupulican/pi-tui";
import { backgroundToolInvocationObservations } from "../../core/background-tool-task-controller.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { type OrchestrationPanelModel, renderOrchestrationPanelRows } from "../../core/tools/orchestration-panel.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import type { ActivityLaneItem } from "./components/activity-lane.ts";
import {
	type AgentsOverlaySnapshot,
	buildWorkPanelModel,
	compactWorkPanel,
	isActiveWorkerLane,
	projectSpecialistLanes,
} from "./components/agents-overlay.ts";
import type { DecisionGraphModel } from "./components/decision-graph-model.ts";
import { fullConversationText } from "./components/question-conversation.ts";
import {
	CHECKS_SECTION,
	DEFAULT_GRAPH_FRACTION,
	PLAN_SECTION,
	TEAM_SECTION,
	type WorkbenchComponent,
	type WorkbenchGeometry,
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
	/** Mouse ownership: absent when the host has no terminal mouse to hand over (tests, transcripts). */
	mouse?: { enabled: () => boolean; set: (enabled: boolean) => void };
	/** Persists the operator's work-area geometry after every change they make. */
	geometry?: { save: (geometry: WorkbenchGeometry) => void };
	/** Right click: the terminal's paste gesture, provided by the workbench while it owns the mouse. */
	paste?: () => Promise<void>;
	/** Previews retained per cycle (`workbench.previews`); the default keeps a long cycle readable. */
	previewLimit?: () => number;
	activeForegroundCount?: () => number;
	activeBackgroundCount?: () => number;
	/** Composes the Decision graph's model from live state; absent, the conversation zone is chat only. */
	graph?: () => DecisionGraphModel | undefined;
	/** The lane's one ticker: told whether the drawn graph carries a running clock. */
	clock?: (running: boolean) => void;
}

/** What the cycle produced so far, as the Decision graph counts it. */
export interface WorkbenchEvidenceCounts {
	readonly actions: number;
	readonly fileEffects: number;
	readonly failures: number;
}

/** UI-only cycle, input and copy coordinator. Task/worker state is never mutated here. */
export class WorkbenchController {
	readonly view: WorkbenchComponent;
	private readonly ports: WorkbenchPorts;
	private previews: Component[] = [];
	private readonly invocations = new ToolInvocationReport();
	private fileEffects = 0;
	/** Evidence of the previous cycle stays on screen until the new cycle produces its own. */
	private staleEvidence = false;
	private selecting = false;
	/** Left button went down inside the conversation; a drag from here selects, a plain click does not. */
	private pressPoint?: { row: number; column: number };
	/** Left button went down on a resize handle; a drag resizes, a still click on the divider toggles collapse. */
	private geometryDrag?: {
		kind: "rows" | "split" | "columns" | "graph";
		startRow: number;
		startColumn: number;
		moved: boolean;
		origin: WorkbenchGeometry;
	};
	private snapshot?: AgentsOverlaySnapshot;
	private workTitle?: string;
	private disposed = false;
	private readonly workspace: WorkspaceObservation;
	private lastObservationNote?: string;
	private observationReady?: Promise<void>;
	private observationTurn = 0;
	private submissionEpoch?: number;

	constructor(view: WorkbenchComponent, ports: WorkbenchPorts, workspace = new WorkspaceObservation()) {
		this.view = view;
		this.ports = ports;
		this.workspace = workspace;
		if (ports.graph) view.setDecisionGraph(ports.graph, ports.clock);
	}

	/** Receipts of the current cycle: completed actions, observed file effects, negative outcomes. */
	evidenceCounts(): WorkbenchEvidenceCounts {
		const { current } = this.invocations.snapshot();
		return {
			actions: current.succeeded + current.negative + current.unknown + current.unclassified,
			fileEffects: this.fileEffects,
			failures: current.negative + current.postprocessing + current.conflicts,
		};
	}

	reset(): void {
		this.workspace.dispose();
		this.observationReady = undefined;
		this.observationTurn++;
		this.submissionEpoch = undefined;
		this.previews = [];
		this.invocations.reset();
		this.fileEffects = 0;
		this.staleEvidence = false;
		this.lastObservationNote = undefined;
		this.snapshot = undefined;
		this.workTitle = undefined;
		this.view.conversation.reset();
		this.view.setExecution(undefined);
		this.view.setInspector([]);
		this.geometryDrag = undefined;
		this.publishHeadline();
	}

	dispose(): void {
		this.disposed = true;
		this.reset();
	}

	beginCycle(cwd?: string, epoch?: number): void {
		this.view.dismissUserShell();
		if (epoch !== undefined && epoch === this.submissionEpoch) {
			this.refreshExecution();
			return;
		}
		if (epoch !== undefined) this.submissionEpoch = epoch;
		this.workspace.dispose();
		this.observationReady = undefined;
		this.observationTurn++;
		if (cwd) this.observationReady = this.workspace.begin(cwd);
		this.staleEvidence = true;
		this.lastObservationNote = undefined;
		this.invocations.beginCycle();
		this.refreshExecution();
	}

	complete(): void {
		this.refreshExecution();
	}

	private previewLimit(): number {
		const limit = this.ports.previewLimit?.();
		return limit !== undefined && Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : DEFAULT_PREVIEW_LIMIT;
	}

	/** The first evidence of a cycle replaces the previous cycle's previews and counters. */
	private beginEvidence(): void {
		if (!this.staleEvidence) return;
		this.staleEvidence = false;
		this.previews = [];
		this.fileEffects = 0;
	}

	private publishHeadline(): void {
		this.view.setHeadline({ title: this.workTitle });
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
					theme.fg("toolTitle", `Observed ${count} workspace changes`) +
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
		if (this.previews.length > this.previewLimit()) this.previews.shift();
		this.refreshExecution();
	}

	record(preview: Component | undefined, observation: ToolInvocationObservation): void {
		this.view.dismissUserShell();
		this.beginEvidence();
		this.invocations.record(observation);
		if (preview) {
			this.previews.push(preview);
			if (this.previews.length > this.previewLimit()) this.previews.shift();
		}
		this.refreshExecution();
	}

	recordBackground(message: AgentMessage): void {
		if (message.role !== "custom") return;
		const observations = backgroundToolInvocationObservations(message);
		for (const observation of observations) this.invocations.record(observation, "background");
		if (observations.length) this.refreshExecution();
	}

	refreshExecution(): void {
		if (this.disposed) return;
		const { current, retained, partial } = this.invocations.snapshot();
		const inFlight = this.ports.activeForegroundCount?.() ?? 0;
		const background = this.ports.activeBackgroundCount?.() ?? 0;
		if (!this.previews.length && !retained.calls && !partial && !inFlight && !background) {
			this.view.setExecution(undefined);
			this.ports.requestRender();
			return;
		}
		// The cycle's evidence stays in order, newest last; the pane follows it until the operator scrolls.
		const details = [
			...(current.notStarted ? [`${current.notStarted} not started`] : []),
			...(current.running ? [`${current.running} running`] : []),
			...(current.negative ? [`${current.negative} negative outcomes`] : []),
			...(current.unknown ? [`${current.unknown} unknown effects`] : []),
			...(current.unclassified ? [`${current.unclassified} unclassified`] : []),
			...(current.postprocessing ? [`${current.postprocessing} postprocessing faults`] : []),
			...(current.conflicts ? [`${current.conflicts} conflicting receipts`] : []),
			...(this.fileEffects ? [`${this.fileEffects} file effects`] : []),
			...(retained.errorResults ? [`retained: ${retained.errorResults} error results`] : []),
		].join(" · ");
		const summary = details
			? theme.fg(retained.errorResults || current.postprocessing || current.conflicts ? "warning" : "muted", details)
			: "";
		const completed = current.succeeded + current.negative;
		const accounting = [
			...(partial ? ["Partial"] : []),
			...(inFlight ? [`In flight: ${inFlight}`] : []),
			`Completed: ${completed}`,
			...(current.notStarted ? [`Not started: ${current.notStarted}`] : []),
			...(background ? [`Background: ${background}`] : []),
			...(current.unknown ? [`Unknown: ${current.unknown}`] : []),
			...(current.unclassified ? [`Unclassified: ${current.unclassified}`] : []),
		].join(" · ");
		this.view.setExecution(
			{
				render: (width) => [
					...(this.staleEvidence && this.previews.length ? [theme.fg("dim", "Previous turn")] : []),
					...this.previews.flatMap((preview, index) => [...(index ? [""] : []), ...preview.render(width)]),
					...(summary ? [...(this.previews.length ? [""] : []), ...wrapTextWithAnsi(summary, width)] : []),
				],
				invalidate: () => {
					for (const preview of this.previews) preview.invalidate();
				},
			},
			false,
			this.previews.at(-1),
			theme.fg("muted", accounting),
		);
		this.ports.requestRender();
	}

	refresh(snapshot: AgentsOverlaySnapshot): void {
		this.snapshot = snapshot;
		this.view.setInspector(buildWorkbenchSections(snapshot, Date.now()));
		this.workTitle = workTitle(snapshot.items);
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
		// Mouse ownership is a session choice, not a pane action: it works before the first frame too.
		if (keys.matches(data, "app.mouse.toggle")) {
			this.toggleMouse();
			this.ports.requestRender();
			return { consume: true };
		}
		if (this.view.conversationHeight === 0) {
			this.selecting = false;
			this.pressPoint = undefined;
			this.geometryDrag = undefined;
			return isMouseSequence(data) ? { consume: true } : undefined;
		}
		if (keys.matches(data, "app.conversation.pageUp"))
			conversation.scroll(-Math.max(1, this.view.conversationHeight - 1));
		else if (keys.matches(data, "app.conversation.pageDown"))
			conversation.scroll(Math.max(1, this.view.conversationHeight - 1));
		else if (keys.matches(data, "app.conversation.latest")) conversation.latest();
		else if (keys.matches(data, "app.conversation.copy")) void this.copy(true);
		else if (keys.matches(data, "app.execution.toggle")) this.changeGeometry(() => this.view.toggleUpper());
		else if (keys.matches(data, "app.workbench.grow")) this.changeGeometry(() => this.view.growUpper());
		else if (keys.matches(data, "app.workbench.shrink")) this.changeGeometry(() => this.view.shrinkUpper());
		else if (keys.matches(data, "app.execution.pageUp")) this.view.pageExecution(-1);
		else if (keys.matches(data, "app.execution.pageDown")) this.view.pageExecution(1);
		else if (keys.matches(data, "app.inspector.toggle")) this.changeGeometry(() => this.view.toggleInspector());
		else if (keys.matches(data, "app.workbench.layout")) this.changeGeometry(() => this.view.toggleLayout());
		else if (keys.matches(data, "app.graph.toggle")) this.changeGeometry(() => this.view.toggleGraph());
		else if (keys.matches(data, "app.graph.view")) this.changeGeometry(() => this.view.cycleGraphView());
		else if (keys.matches(data, "app.execution.maximize"))
			this.changeGeometry(() => this.view.toggleExecutionMaximized());
		else {
			const mouse = parseMouseSequence(data);
			if (!mouse) return undefined;
			const { button, action, column, row } = mouse;
			const hit = this.view.hitTest(column, row);
			if (action === "scroll") {
				const delta = button === "wheelUp" ? -3 : 3;
				if (hit === "conversation") conversation.scroll(delta);
				else if (hit === "graph") this.view.scrollGraph(column, row, delta);
				else this.view.scrollUpper(column, row, delta);
			} else if (this.geometryDrag && (action === "drag" || action === "up") && button === "left") {
				const axisMoved =
					this.geometryDrag.kind === "rows"
						? row !== this.geometryDrag.startRow
						: column !== this.geometryDrag.startColumn;
				if (axisMoved) this.geometryDrag.moved = true;
				if (this.geometryDrag.moved) {
					const origin = this.geometryDrag.origin;
					if (this.geometryDrag.kind === "rows") {
						if (row === this.geometryDrag.startRow) {
							this.view.applyGeometry({
								...this.view.geometry(),
								rows: origin.rows,
								collapsed: origin.collapsed,
								executionMaximized: origin.executionMaximized,
							});
						} else this.view.resizeUpperFromPointer(row);
					} else if (this.geometryDrag.kind === "columns") {
						if (column === this.geometryDrag.startColumn) {
							this.view.resizeConversation(origin.conversationFraction ?? 0.5);
						} else this.view.resizeConversationFromPointer(column);
					} else if (this.geometryDrag.kind === "graph") {
						if (column === this.geometryDrag.startColumn) {
							this.view.resizeGraph(origin.graphFraction ?? DEFAULT_GRAPH_FRACTION);
						} else this.view.resizeGraphFromPointer(column);
					} else if (column === this.geometryDrag.startColumn) {
						this.view.resizeInspector(origin.inspectorFraction ?? 0.3);
					} else this.view.resizeInspectorFromPointer(column);
				}
				if (action === "up") {
					if (!this.geometryDrag.moved && this.geometryDrag.kind === "rows") {
						this.changeGeometry(() => this.view.toggleUpper());
					} else if (this.geometryDrag.moved) {
						this.ports.geometry?.save(this.view.geometry());
					}
					this.geometryDrag = undefined;
				}
			} else if (action === "down" && button === "left" && hit === "conversationHeader") {
				const headerAction = this.view.headerAction(column);
				if (headerAction === "latest") conversation.latest();
				else if (headerAction === "copyAll") void this.copy(true);
				else if (headerAction === "layout") this.changeGeometry(() => this.view.toggleLayout());
			} else if (action === "down" && button === "left" && hit === "divider") {
				this.geometryDrag = {
					kind: "rows",
					startRow: row,
					startColumn: column,
					moved: false,
					origin: this.view.geometry(),
				};
			} else if (action === "down" && button === "left" && hit === "split") {
				this.geometryDrag = {
					kind: "split",
					startRow: row,
					startColumn: column,
					moved: false,
					origin: this.view.geometry(),
				};
			} else if (action === "down" && button === "left" && hit === "columnSplit") {
				this.geometryDrag = {
					kind: "columns",
					startRow: row,
					startColumn: column,
					moved: false,
					origin: this.view.geometry(),
				};
			} else if (action === "down" && button === "left" && hit === "graphSplit") {
				this.geometryDrag = {
					kind: "graph",
					startRow: row,
					startColumn: column,
					moved: false,
					origin: this.view.geometry(),
				};
			} else if (action === "down" && button === "left" && hit === "graphTitle") {
				const titleAction = this.view.paneTitleAction(column, row);
				if (titleAction === "graphList") this.changeGeometry(() => this.view.setGraphView("list"));
				else if (titleAction === "graphDiagram") this.changeGeometry(() => this.view.setGraphView("diagram"));
				else if (titleAction === "hideGraph") this.changeGeometry(() => this.view.toggleGraph());
			} else if (action === "down" && button === "left" && hit === "graph") {
				// A stage row opens its detail; the detail lives in the List view, so the view may switch.
				const stage = this.view.graphStageAt(column, row);
				if (stage) this.changeGeometry(() => this.view.toggleGraphStage(stage));
			} else if (action === "down" && button === "left" && (hit === "inspectorTitle" || hit === "executionTitle")) {
				const titleAction = this.view.paneTitleAction(column, row);
				if (titleAction === "hideInspector" || titleAction === "showInspector") {
					this.changeGeometry(() => this.view.toggleInspector());
				} else if (titleAction === "maximize") {
					this.changeGeometry(() => this.view.toggleExecutionMaximized());
				} else if (titleAction === "layout") {
					this.changeGeometry(() => this.view.toggleLayout());
				} else if (titleAction === undefined) {
					if (hit === "inspectorTitle" && !this.view.inspectorHasTitleActions()) {
						this.changeGeometry(() => this.view.toggleInspector());
					} else if (hit === "executionTitle" && !this.view.executionHasTitleActions()) {
						this.changeGeometry(() => this.view.toggleExecutionMaximized());
					}
				}
			} else if (action === "down" && button === "right") {
				// The terminal cannot paste while the workbench owns the mouse, so the workbench does.
				void this.ports.paste?.();
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
					// Copy on release, as the terminal would have: the selection is the operator's intent.
					if (this.selecting) void this.copy(false);
					this.selecting = false;
					this.pressPoint = undefined;
				}
			}
			// Consume terminal mouse reports even outside the pane; never insert protocol bytes into input.
		}
		this.ports.requestRender();
		return { consume: true };
	}

	/** Every operator change to the work area is applied to the view and persisted in one step. */
	private changeGeometry(mutate: () => void): void {
		mutate();
		this.ports.geometry?.save(this.view.geometry());
	}

	/** Hand the mouse to the workbench or back to the terminal; the view's hint row shows the owner. */
	toggleMouse(): void {
		const mouse = this.ports.mouse;
		if (!mouse) {
			this.ports.notice("This terminal has no mouse to hand over", true);
			return;
		}
		const enabled = !mouse.enabled();
		mouse.set(enabled);
		this.view.setMouseMode(enabled);
		this.ports.notice(
			enabled
				? "Workbench owns the mouse: wheel scrolls, drag copies on release, drag edges to resize, click titles to hide or maximize, right click pastes"
				: "Terminal owns the mouse: native selection and paste; no wheel scrolling",
		);
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

const DEFAULT_PREVIEW_LIMIT = 24;
const TEAM_SECTIONS = new Set(["Workers", "Background tools"]);

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
					`  ${theme.fg("success", "✓")} ${theme.fg("text", planRows.length ? `Work complete · ${planRows.length} steps` : "No open steps")}`,
				];
		sections.push({ title: PLAN_SECTION, meta, body });
	}
	// Failed verifications are the operator's to see and to resolve; they never hide inside an error.
	const checks = snapshot.verification ?? [];
	if (checks.length) {
		const rows = checks.slice(0, 3).map((check) => {
			const what = check.command ?? check.id;
			return `  ${theme.fg("error", "✗")} ${theme.fg("text", what)}`;
		});
		if (checks.length > 3) rows.push(`  ${theme.fg("dim", `+${checks.length - 3} more`)}`);
		rows.push(`  ${theme.fg("dim", "rerun the same check, or /verify dismiss")}`);
		sections.push({ title: CHECKS_SECTION, meta: `${checks.length} failing`, body: rows });
	}
	// Edge grants stay armed in the host; they are not a workbench inspector section.
	// The team is its specialists, not its task history: a specialist with three finished tasks and
	// nothing running is one idle agent, and it keeps its section even though it contributes no row.
	const specialists = projectSpecialistLanes(snapshot.laneRecords);
	if (teamRows.length || specialists.length) {
		const team = compactWorkPanel({ ...model, rows: teamRows }, 4);
		const shown = team.rows ?? [];
		const workers = specialists.flatMap((specialist) => (specialist.current ? [specialist.current] : []));
		const active = workers.filter(isActiveWorkerLane).length;
		const meta = active
			? `${active} active`
			: `${specialists.length} ${specialists.length === 1 ? "agent" : "agents"}`;
		const body: Component | string[] = shown.length
			? rowsComponent({ ...team, rows: shown.map((row) => ({ ...row, section: undefined })) })
			: [
					`  ${theme.fg("success", "✓")} ${theme.fg("text", `Team idle · ${specialists.length} ${specialists.length === 1 ? "session" : "sessions"} retained`)}`,
				];
		sections.push({ title: TEAM_SECTION, meta, body });
	}
	return sections;
}
