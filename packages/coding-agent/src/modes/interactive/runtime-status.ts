import type { AssistantMessage } from "@caupulican/pi-ai";

export interface RuntimeStatusPresentation {
	hasHumanAudience: boolean;
	currentLabel: string | undefined;
	loadingAnimation: { setMessage(message: string): void } | undefined;
	activityLane: { update(id: string, label: string): void } | undefined;
	requestRender(): void;
}

export function applyRuntimeStatusLabel(presentation: RuntimeStatusPresentation, label: string): string | undefined {
	if (!presentation.hasHumanAudience || presentation.currentLabel === label) return presentation.currentLabel;
	if (presentation.loadingAnimation) presentation.loadingAnimation.setMessage(label);
	else presentation.activityLane?.update("runtime:turn", label);
	presentation.requestRender();
	return label;
}

export function resolveHiddenThinkingStatus(
	message: AssistantMessage,
	hideThinkingBlock: boolean,
	hiddenThinkingLabel: string,
	workingLabel: string,
): string {
	if (!hideThinkingBlock) return workingLabel;
	const hasThinking = message.content.some(
		(content) => content.type === "thinking" && content.thinking.trim().length > 0,
	);
	const hasVisibleWork = message.content.some(
		(content) => (content.type === "text" && content.text.trim().length > 0) || content.type === "toolCall",
	);
	return hasThinking && !hasVisibleWork ? hiddenThinkingLabel : workingLabel;
}
