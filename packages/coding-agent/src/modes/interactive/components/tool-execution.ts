import {
	compactRetainedDetails,
	MAX_TUI_RETAINED_DETAILS_BYTES,
	type ToolCallRepairInfo,
} from "@caupulican/pi-agent-core";
import { truncateHead } from "@caupulican/pi-agent-core/node";
import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@caupulican/pi-tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { type ThemeBg, theme } from "../theme/theme.ts";
import { renderTitleBadge, titleBadge } from "./tool-title.ts";

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	repair?: ToolCallRepairInfo;
	/** Avoid reading retained history result payloads until the user expands tool output. */
	deferResultUntilExpanded?: boolean;
}

interface ToolExecutionResult {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	isError: boolean;
	details?: unknown;
}

type MonotonicClock = () => number;

function monotonicNow(): number {
	return performance.now();
}

function formatToolDuration(durationMs: number): string {
	if (durationMs < 1) return "<1ms";
	if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
	if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(2)}s`;
	if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
	const totalSeconds = Math.round(durationMs / 1_000);
	if (totalSeconds < 3_600) return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
	return `${Math.floor(totalSeconds / 3_600)}h ${Math.floor((totalSeconds % 3_600) / 60)}m`;
}

/** One allocation per tool panel; render reads the monotonic clock without scheduling per-tool timers. */
class ToolTimingComponent implements Component {
	private readonly clock: MonotonicClock;
	private startedAt: number | undefined;
	private endedAt: number | undefined;

	constructor(clock: MonotonicClock) {
		this.clock = clock;
	}

	start(): void {
		if (this.startedAt !== undefined) return;
		const now = this.clock();
		if (!Number.isFinite(now)) return;
		this.startedAt = now;
		this.endedAt = undefined;
	}

	finish(): void {
		if (this.startedAt === undefined || this.endedAt !== undefined) return;
		const now = this.clock();
		if (!Number.isFinite(now)) return;
		this.endedAt = Math.max(this.startedAt, now);
	}

	reset(): void {
		this.startedAt = undefined;
		this.endedAt = undefined;
	}

	hasStarted(): boolean {
		return this.startedAt !== undefined;
	}

	getText(): string | undefined {
		if (this.startedAt === undefined) return undefined;
		const current = this.endedAt ?? this.clock();
		if (!Number.isFinite(current)) return undefined;
		const label = this.endedAt === undefined ? "Elapsed" : "Took";
		return `${label} ${formatToolDuration(Math.max(0, current - this.startedAt))}`;
	}

	render(width: number): string[] {
		const text = this.getText();
		return text ? [truncateToWidth(theme.fg("muted", text), Math.max(0, width), "...")] : [];
	}

	invalidate(): void {}
}

// Components only use built-in definitions for display (renderers, grouping), so one
// toolset per cwd is shared instead of allocating a full toolset per scrollback component.
const MAX_BUILT_IN_DEFINITION_CWDS = 32;
const builtInDefinitionsByCwd = new Map<string, ReturnType<typeof createAllToolDefinitions>>();

function getBuiltInToolDefinitions(cwd: string): ReturnType<typeof createAllToolDefinitions> {
	let definitions = builtInDefinitionsByCwd.get(cwd);
	if (definitions) {
		builtInDefinitionsByCwd.delete(cwd);
		builtInDefinitionsByCwd.set(cwd, definitions);
		return definitions;
	}
	definitions = createAllToolDefinitions(cwd);
	builtInDefinitionsByCwd.set(cwd, definitions);
	while (builtInDefinitionsByCwd.size > MAX_BUILT_IN_DEFINITION_CWDS) {
		const oldest = builtInDefinitionsByCwd.keys().next().value;
		if (oldest === undefined) break;
		builtInDefinitionsByCwd.delete(oldest);
	}
	return definitions;
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private repair: ToolCallRepairInfo | undefined;
	private deferResultUntilExpanded: boolean;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	toolGroup: string | undefined;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: ToolExecutionResult;
	private materializedResult?: ToolExecutionResult;
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;
	private readonly timing = new ToolTimingComponent(monotonicNow);

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.repair = options.repair;
		this.deferResultUntilExpanded = options.deferResultUntilExpanded ?? false;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = getBuiltInToolDefinitions(cwd)[toolName as ToolName];
		this.toolGroup = this.resolveToolGroup();
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private resolveToolGroup(): string | undefined {
		const configuredGroup = this.toolDefinition?.toolGroup ?? this.builtInToolDefinition?.toolGroup;
		if (configuredGroup !== undefined) {
			const trimmed = configuredGroup.trim();
			return trimmed || undefined;
		}
		const defaultGroup = this.toolName.trim();
		return defaultGroup || undefined;
	}

	private getRenderContext(lastComponent: Component | undefined, toolGroupSummary = false): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
			repair: this.repair,
			toolGroupSummary,
		};
	}

	private humanizeToolName(name: string): string {
		const words = name
			.replace(/[_-]+/g, " ")
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.trim()
			.split(/\s+/)
			.filter(Boolean);
		if (words.length === 0) return name;
		return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
	}

	private getDisplayLabel(): string {
		const label = (this.toolDefinition?.label ?? this.builtInToolDefinition?.label)?.trim();
		if (this.builtInToolDefinition) return label || this.toolName;
		if (!label || label === this.toolName) return this.humanizeToolName(this.toolName);
		return label;
	}

	resetInvocation(
		toolName: string,
		toolCallId: string,
		args: any,
		toolDefinition: ToolDefinition<any, any> | undefined,
		repair?: ToolCallRepairInfo,
		deferResultUntilExpanded = false,
	): void {
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.repair = repair;
		this.deferResultUntilExpanded = deferResultUntilExpanded;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = getBuiltInToolDefinitions(this.cwd)[toolName as ToolName];
		this.toolGroup = this.resolveToolGroup();
		this.executionStarted = false;
		this.argsComplete = false;
		this.isPartial = true;
		this.result = undefined;
		this.materializedResult = undefined;
		this.callRendererComponent = undefined;
		this.resultRendererComponent = undefined;
		this.rendererState = {};
		this.convertedImages.clear();
		this.timing.reset();
		this.updateDisplay();
	}

	private titleBadgeStatus(): "pending" | "running" | "success" | "error" {
		if (this.result?.isError) return "error";
		if (this.isPartial) return this.executionStarted ? "running" : "pending";
		return "success";
	}

	private createCallFallback(): Component {
		return titleBadge(theme, {
			label: this.getDisplayLabel(),
			status: this.titleBadgeStatus(),
		});
	}

	private createRepairMarker(): Component | undefined {
		return this.repair?.repaired ? new Text(theme.fg("dim", "[repaired arguments]"), 0, 0) : undefined;
	}

	private createResultFallback(result: ToolExecutionResult): Component | undefined {
		const output = this.getTextOutput(result);
		if (!output) {
			return undefined;
		}
		// The fallback also serves results whose custom renderer threw; without a
		// display bound, a renderer bug degrades into dumping the full payload.
		const truncation = truncateHead(output);
		if (!truncation.truncated) {
			return new Text(theme.fg("toolOutput", output), 0, 0);
		}
		const note = theme.fg(
			"dim",
			`[output truncated for display: showing ${truncation.outputLines} lines; the full result is retained in the conversation]`,
		);
		return new Text(`${theme.fg("toolOutput", truncation.content)}\n${note}`, 0, 0);
	}

	updateArgs(args: any, repair?: ToolCallRepairInfo): void {
		this.args = args;
		this.repair = repair;
		this.updateDisplay();
	}

	markExecutionStarted(repair?: ToolCallRepairInfo): void {
		this.repair = repair;
		this.timing.start();
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(result: ToolExecutionResult, isPartial = false): void {
		// Final results live in the chat scrollback for the rest of the process.
		// Oversized details would pin large payloads per tool call, so retain the
		// same compacted form a resumed session would see.
		if (!isPartial) {
			this.timing.finish();
			compactRetainedDetails(result, MAX_TUI_RETAINED_DETAILS_BYTES);
		}
		this.result = result;
		this.materializedResult = undefined;
		this.isPartial = isPartial;
		this.updateDisplay();
		if (this.shouldMaterializeResult()) this.maybeConvertImagesForKitty();
	}

	private shouldMaterializeResult(): boolean {
		return (
			this.result !== undefined &&
			(!this.deferResultUntilExpanded || this.expanded || this.isPartial || this.result.isError)
		);
	}

	private getMaterializedResult(): ToolExecutionResult | undefined {
		if (!this.shouldMaterializeResult() || !this.result) return undefined;
		if (!this.deferResultUntilExpanded) return this.result;
		this.materializedResult ??= {
			content: this.result.content,
			isError: this.result.isError,
			details: this.result.details,
		};
		return this.materializedResult;
	}

	private maybeConvertImagesForKitty(): void {
		const result = this.getMaterializedResult();
		if (!result) return;
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;

		const imageBlocks = result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted && this.getMaterializedResult() === result) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		if (!expanded && this.deferResultUntilExpanded) {
			this.resultRendererComponent = undefined;
			this.materializedResult = undefined;
			this.convertedImages.clear();
		}
		this.updateDisplay();
		if (expanded) this.maybeConvertImagesForKitty();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	getBackgroundColor(): ThemeBg {
		if (this.isPartial) return "toolPendingBg";
		if (this.result?.isError) return "toolErrorBg";
		return "toolSuccessBg";
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	renderCallSummary(width: number): string[] {
		const callRenderer = this.getCallRenderer();
		let component: Component;
		if (!callRenderer) {
			component = this.createCallFallback();
		} else {
			try {
				component = callRenderer(this.args, theme, this.getRenderContext(undefined, true));
			} catch {
				component = this.createCallFallback();
			}
		}
		const lines = [...component.render(width)];
		const timing = this.timing.getText();
		if (!timing) return lines;
		const prefix = theme.fg("dim", `${timing} · `);
		const firstContentLine = lines.findIndex((line) => line.trim().length > 0);
		if (firstContentLine === -1) return this.timing.render(width);
		lines[firstContentLine] = truncateToWidth(`${prefix}${lines[firstContentLine]}`, Math.max(0, width), "...");
		return lines;
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}
		const lines = super.render(width);
		return lines.every((line) => line.trim().length === 0) ? [] : lines;
	}

	private updateDisplay(): void {
		const bgFn = (text: string) => theme.bg(this.getBackgroundColor(), text);
		const materializedResult = this.getMaterializedResult();

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
			}
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createCallFallback());
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(component);
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createCallFallback());
					hasContent = true;
				}
			}

			const repairMarker = this.createRepairMarker();
			if (repairMarker) {
				renderContainer.addChild(repairMarker);
				hasContent = true;
			}

			if (materializedResult) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback(materializedResult);
					if (component) {
						renderContainer.addChild(component);
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: materializedResult.content as any, details: materializedResult.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(component);
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback(materializedResult);
						if (component) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					}
				}
			}
			if (this.timing.hasStarted()) {
				renderContainer.addChild(this.timing);
				hasContent = true;
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution(materializedResult));
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (materializedResult) {
			const imageBlocks = materializedResult.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(result: ToolExecutionResult): string {
		return getRenderedTextOutput(result, this.showImages);
	}

	private formatToolExecution(result: ToolExecutionResult | undefined): string {
		let text = renderTitleBadge(theme, {
			label: this.getDisplayLabel(),
			status: this.titleBadgeStatus(),
		});
		if (this.repair?.repaired) {
			text += `\n${theme.fg("dim", "[repaired arguments]")}`;
		}
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = result ? this.getTextOutput(result) : "";
		if (output) {
			// Same display bound as createResultFallback: unknown tools must not
			// dump arbitrarily large payloads into the scrollback.
			const truncation = truncateHead(output);
			if (truncation.truncated) {
				text += `\n${truncation.content}\n${theme.fg("dim", `[output truncated for display: showing ${truncation.outputLines} lines; the full result is retained in the conversation]`)}`;
			} else {
				text += `\n${output}`;
			}
		}
		const timing = this.timing.getText();
		if (timing) text += `\n${theme.fg("muted", timing)}`;
		return text;
	}
}
