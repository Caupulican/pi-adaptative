import type { AssistantMessage } from "@caupulican/pi-ai";
import { type Container, Loader, type LoaderIndicatorOptions, type TUI } from "@caupulican/pi-tui";
import type { ActivityLaneComponent } from "./components/activity-lane.ts";
import { keyText } from "./components/keybinding-hints.ts";
import { applyRuntimeStatusLabel, resolveHiddenThinkingStatus } from "./runtime-status.ts";
import { theme } from "./theme/theme.ts";

export interface RuntimeStatusControllerHost {
	readonly ui: TUI;
	readonly statusContainer: Container;
	readonly activityLane: ActivityLaneComponent | undefined;
	readonly hasHumanAudience: boolean;
	isStreaming(): boolean;
	isThinkingHidden(): boolean;
}

/** Owns the human-facing turn indicator and its loader/activity-lane lifecycle. */
export class RuntimeStatusController {
	private readonly host: RuntimeStatusControllerHost;
	private activeLoader: Loader | undefined;
	private workingMessage: string | undefined;
	private workingVisible: boolean;
	private workingIndicatorOptions: LoaderIndicatorOptions | undefined;
	private readonly defaultWorkingMessage = "Working...";
	private readonly defaultHiddenThinkingLabel = "Thinking...";
	private hiddenThinkingLabel = this.defaultHiddenThinkingLabel;
	private runtimeStatusLabel: string | undefined;

	constructor(host: RuntimeStatusControllerHost) {
		this.host = host;
		this.workingVisible = host.hasHumanAudience;
	}

	get loadingAnimation(): Loader | undefined {
		return this.activeLoader;
	}

	set loadingAnimation(value: Loader | undefined) {
		this.activeLoader = value;
	}

	get isWorkingVisible(): boolean {
		return this.workingVisible;
	}

	set isWorkingVisible(value: boolean) {
		this.workingVisible = value;
	}

	get indicatorOptions(): LoaderIndicatorOptions | undefined {
		return this.workingIndicatorOptions;
	}

	set indicatorOptions(value: LoaderIndicatorOptions | undefined) {
		this.workingIndicatorOptions = value;
	}

	getWorkingLoaderMessage(): string {
		return this.workingMessage ?? this.defaultWorkingMessage;
	}

	createWorkingLoader(): Loader {
		return new Loader(
			this.host.ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			this.runtimeStatusLabel ?? this.getWorkingLoaderMessage(),
			this.workingIndicatorOptions,
		);
	}

	stopWorkingLoader(): void {
		if (this.activeLoader) {
			this.activeLoader.stop();
			this.activeLoader = undefined;
		}
		this.host.statusContainer.clear();
		this.runtimeStatusLabel = undefined;
		this.host.activityLane?.remove("runtime:routing");
		this.host.activityLane?.remove("runtime:turn");
	}

	setWorkingVisible(visible: boolean): void {
		if (!this.host.hasHumanAudience) {
			this.workingVisible = false;
			this.stopWorkingLoader();
			return;
		}
		this.workingVisible = visible;
		if (!visible) {
			const currentRuntimeStatus = this.runtimeStatusLabel;
			this.stopWorkingLoader();
			if (this.host.isStreaming()) this.runtimeStatusLabel = currentRuntimeStatus;
			this.host.ui.requestRender();
			return;
		}
		if (this.host.isStreaming() && !this.activeLoader) {
			if (this.workingIndicatorOptions) {
				this.host.statusContainer.clear();
				this.activeLoader = this.createWorkingLoader();
				this.host.statusContainer.addChild(this.activeLoader);
			} else {
				this.host.activityLane?.start({
					id: "runtime:turn",
					kind: "runtime",
					label: this.runtimeStatusLabel ?? this.getWorkingLoaderMessage(),
				});
			}
		}
		this.host.ui.requestRender();
	}

	setWorkingIndicator(options?: LoaderIndicatorOptions): void {
		this.workingIndicatorOptions = options;
		if (!this.host.hasHumanAudience) {
			this.stopWorkingLoader();
			return;
		}
		if (options) {
			this.host.activityLane?.remove("runtime:turn");
			if (this.host.isStreaming() && this.workingVisible) {
				const currentRuntimeStatus = this.runtimeStatusLabel;
				this.stopWorkingLoader();
				this.runtimeStatusLabel = currentRuntimeStatus;
				this.activeLoader = this.createWorkingLoader();
				this.host.statusContainer.addChild(this.activeLoader);
			}
		} else {
			this.activeLoader?.stop();
			this.activeLoader = undefined;
			this.host.statusContainer.clear();
			if (this.host.isStreaming() && this.workingVisible) {
				this.host.activityLane?.start({
					id: "runtime:turn",
					kind: "runtime",
					label: this.runtimeStatusLabel ?? this.getWorkingLoaderMessage(),
				});
			}
		}
		this.host.ui.requestRender();
	}

	setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
	}

	updateRuntimeStatus(message?: AssistantMessage): void {
		if (!this.host.hasHumanAudience) return;
		const label = message
			? resolveHiddenThinkingStatus(
					message,
					this.host.isThinkingHidden(),
					this.hiddenThinkingLabel,
					this.getWorkingLoaderMessage(),
				)
			: this.getWorkingLoaderMessage();
		this.runtimeStatusLabel = applyRuntimeStatusLabel(
			{
				hasHumanAudience: this.host.hasHumanAudience,
				currentLabel: this.runtimeStatusLabel,
				loadingAnimation: this.activeLoader,
				activityLane: this.host.activityLane,
				requestRender: () => this.host.ui.requestRender(),
			},
			label,
		);
	}

	setWorkingMessage(message: string | undefined, messageInFlight: AssistantMessage | undefined): void {
		this.workingMessage = message;
		if (messageInFlight) {
			this.updateRuntimeStatus(messageInFlight);
			return;
		}
		if (this.activeLoader) {
			this.activeLoader.setMessage(message ?? this.defaultWorkingMessage);
		}
		this.host.activityLane?.update("runtime:turn", message ?? this.defaultWorkingMessage);
	}

	resetWorkingIndicators(): void {
		this.workingMessage = undefined;
		this.workingVisible = this.host.hasHumanAudience;
		this.setWorkingIndicator();
		if (this.activeLoader) {
			this.activeLoader.setMessage(`${this.defaultWorkingMessage} (${keyText("app.interrupt")} to interrupt)`);
		}
		this.setHiddenThinkingLabel();
	}
}
