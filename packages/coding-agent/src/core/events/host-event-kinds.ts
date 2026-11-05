import type { HostEventEnvelope } from "./host-event-contract.ts";

/**
 * Who wrote an event's content. `owner-controlled` facts come from the owner's own systems (a verdict of the owner's
 * workflow); `third-party-authored` content was written by someone else and stays untrusted data in every turn it
 * reaches. It derives from the kind, never from a stored per-event field.
 */
export type HostEventAuthorship = "owner-controlled" | "third-party-authored";

/** One declared event kind. Every kind a source emits is declared here, with how a listener may scope it. */
export interface HostEventKindDeclaration {
	readonly source: string;
	/** What a listener names to receive the kind. */
	readonly scope: readonly string[];
	/** The event fields whose identity makes a replay idempotent. */
	readonly idempotency: string;
	/** `high`: unscoped listening can flood a session, so a listener must narrow it at save. */
	readonly volume: "low" | "high";
	/** `superseding`: a later occurrence for the same scope replaces the earlier one; `occurrence`: each stands alone. */
	readonly currency: "superseding" | "occurrence";
	readonly authorship: HostEventAuthorship;
}

export type HostEventKind = HostEventEnvelope["event"]["kind"];

/** The closed kind table. A kind without a delivery path is never declared. */
export const HOST_EVENT_KINDS: { readonly [K in HostEventKind]: HostEventKindDeclaration } = {
	"ci-attempt-terminal": {
		source: "ci",
		scope: ["revision", "workflow"],
		idempotency: "attempt identity (host, repository, workflow, run, attempt)",
		volume: "low",
		currency: "superseding",
		authorship: "owner-controlled",
	},
};

export function hostEventKindOf(envelope: HostEventEnvelope): HostEventKind {
	return envelope.event.kind;
}

export function hostEventAuthorship(envelope: HostEventEnvelope): HostEventAuthorship {
	return HOST_EVENT_KINDS[hostEventKindOf(envelope)].authorship;
}
