import type { AgentMessage } from "@caupulican/pi-agent-core";
import { sanitizeBinaryOutput } from "@caupulican/pi-agent-core/shell-output";
import { type Component, Text } from "@caupulican/pi-tui";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { OrchestrationPanelComponent } from "../../core/tools/orchestration-panel.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { type AgentsOverlaySnapshot, buildWorkPanelModel, compactWorkPanel } from "./components/agents-overlay.ts";
import { keyText } from "./components/keybinding-hints.ts";
import { fullConversationText } from "./components/question-conversation.ts";
import type { WorkbenchComponent } from "./components/workbench.ts";
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
	private expanded = true;
	private selecting = false;
	private snapshot?: AgentsOverlaySnapshot;
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
		this.lastObservationNote = undefined;
		this.snapshot = undefined;
		this.view.conversation.reset();
		this.view.setExecution(undefined);
		this.view.setInspector([]);
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
		this.previews = [];
		this.actionCount = 0;
		this.fileEffects = 0;
		this.lastObservationNote = undefined;
		this.expanded = true;
		// A prior failed action remains a receipt; a new task is not evidence of recovery.
		this.updateExecution();
	}

	complete(): void {
		this.expanded = this.failed > 0;
		this.updateExecution();
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
		if (this.previews.length > 3) this.previews.shift();
		this.updateExecution();
	}

	record(preview: Component | undefined, failed: boolean): void {
		this.view.dismissUserShell();
		this.actionCount++;
		if (failed) this.failed++;
		if (preview) {
			this.previews.push(preview);
			if (this.previews.length > 3) this.previews.shift();
		}
		this.updateExecution();
	}

	private updateExecution(): void {
		if (!this.previews.length && !this.failed) {
			this.view.setExecution(undefined);
			return;
		}
		const summary = () =>
			theme.fg(
				this.failed ? "warning" : "muted",
				`Execution · ${this.actionCount} actions${this.fileEffects ? ` · ${this.fileEffects} file effects` : ""}${this.failed ? ` · ${this.failed} failure receipts` : ""} · ${keyText("app.execution.toggle")} fold/expand`,
			);
		this.view.setExecution({
			render: (width) => [
				summary(),
				...(this.expanded ? this.previews.slice(-1).flatMap((preview) => preview.render(width)) : []),
			],
			invalidate: () => {
				for (const preview of this.previews) preview.invalidate();
			},
		});
		this.ports.requestRender();
	}

	refresh(snapshot: AgentsOverlaySnapshot): void {
		this.snapshot = snapshot;
		const model = compactWorkPanel(buildWorkPanelModel(snapshot, Date.now()));
		if (!(model.rows?.length || model.summary?.length || model.notices?.length)) this.view.setInspector([]);
		else this.view.setInspector(new OrchestrationPanelComponent(theme, model));
	}

	invalidate(): void {
		if (this.snapshot) this.refresh(this.snapshot);
	}

	handleInput(data: string): { consume: true } | undefined {
		if (this.disposed || !this.ports.isInteractive()) {
			this.selecting = false;
			return undefined;
		}
		const keys = this.ports.keybindings;
		const conversation = this.view.conversation;
		if (this.view.conversationHeight === 0) {
			this.selecting = false;
			return data.startsWith("\x1b[<") ? { consume: true } : undefined;
		}
		if (keys.matches(data, "app.conversation.pageUp"))
			conversation.scroll(-Math.max(1, this.view.conversationHeight - 1));
		else if (keys.matches(data, "app.conversation.pageDown"))
			conversation.scroll(Math.max(1, this.view.conversationHeight - 1));
		else if (keys.matches(data, "app.conversation.latest")) conversation.latest();
		else if (keys.matches(data, "app.conversation.copy")) void this.copy(true);
		else if (keys.matches(data, "app.execution.toggle")) {
			this.expanded = !this.expanded;
			this.updateExecution();
		} else {
			const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
			if (!mouse) return undefined;
			const button = Number(mouse[1]);
			const column = Number(mouse[2]) - 1;
			const row = Number(mouse[3]) - 1;
			const inside =
				row >= this.view.conversationTop && row < this.view.conversationTop + this.view.conversationHeight;
			if ((button === 64 || button === 65) && inside) conversation.scroll(button === 64 ? -3 : 3);
			else if (button === 0 && mouse[4] === "M" && row === this.view.conversationTop - 1) {
				const action = this.view.headerAction(column);
				if (action === "latest") conversation.latest();
				else if (action) void this.copy(action === "copyAll");
			} else if (button === 0 && mouse[4] === "M" && inside) {
				this.selecting = true;
				conversation.select({ row: row - this.view.conversationTop, column }, true);
			} else if (this.selecting && (button === 32 || mouse[4] === "m")) {
				conversation.select(
					{
						row: Math.max(0, Math.min(this.view.conversationHeight - 1, row - this.view.conversationTop)),
						column: Math.max(0, column),
					},
					false,
				);
				if (mouse[4] === "m") this.selecting = false;
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
