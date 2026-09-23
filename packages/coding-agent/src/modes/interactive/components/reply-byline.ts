import type { AssistantMessage } from "@caupulican/pi-ai";
import type { ForegroundRouteSnapshot } from "../../../core/model-router-controller.ts";
import { formatRouteValue } from "./operator-pov-bar.ts";
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
 * Who wrote a reply, in the same `actor · model` grammar as the Execution preview titles. A reply the
 * session's own model wrote reads `root · <model>`; a routed one adds who chose it, in the POV bar's ROUTE
 * words (`routed · <model> · cheap via model-router`).
 */
export function replyByline(modelRef: string, route: ForegroundRouteSnapshot | undefined): ReplyByline {
	const routed = route?.switched === true;
	const base = attributionText({ kind: "root", label: routed ? "routed" : "root", modelRef });
	return { text: routed && route ? `${base} · ${formatRouteValue(route)}` : base, routed };
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
