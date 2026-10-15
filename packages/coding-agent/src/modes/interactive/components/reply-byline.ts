import type { AssistantMessage } from "@caupulican/pi-ai";
import type { ForegroundRouteSnapshot } from "../../../core/model-router-controller.ts";
import { formatRouteValue } from "../../../core/route-text.ts";
import { attributionText } from "./workbench-tool-preview.ts";

export interface ReplyByline {
	readonly text: string;
	/** A model other than the session's own wrote this reply. */
	readonly routed: boolean;
}

/** The model that actually answered: the provider's resolved model when it differs from the one requested. */
export function replyModelRef(message: Pick<AssistantMessage, "provider" | "model" | "responseModel">): string {
	return `${message.provider}/${message.responseModel ?? message.model}`;
}

/**
 * Who wrote a reply, only when it was not the session's own model (that one is on the status line): a routed
 * reply reads `routed · <model name> · <who chose it>`, in the POV bar's ROUTE words.
 */
export function replyByline(
	modelRef: string,
	route: ForegroundRouteSnapshot | undefined,
	modelName?: string,
): ReplyByline | undefined {
	// The session's own model is on the status line; a reply says who wrote it only when a routed model did.
	if (route?.switched !== true) return undefined;
	const base = attributionText({ kind: "root", label: "routed", modelRef, ...(modelName ? { modelName } : {}) });
	return { text: `${base} · ${formatRouteValue(route)}`, routed: true };
}

/**
 * Decides which replies carry a byline: the first reply after each owner message, and any reply whose
 * model differs from the previous byline's, so a tool-heavy turn does not repeat it on every round trip.
 */
export class ReplyBylineTracker {
	private awaitingReply = true;
	private lastModelRef: string | undefined;

	ownerMessage(): void {
		this.awaitingReply = true;
	}

	shouldShow(modelRef: string): boolean {
		const show = this.awaitingReply || modelRef !== this.lastModelRef;
		this.awaitingReply = false;
		this.lastModelRef = modelRef;
		return show;
	}

	reset(): void {
		this.awaitingReply = true;
		this.lastModelRef = undefined;
	}
}
