/**
 * The tools each recent run was offered, and why the others were not offered or a call to one was refused. Each reason
 * is reported by the rule that decided it, where it decided (the runtime's access policy, the model capability filter,
 * a worker's lane surface, the third-party gate); nothing here decides or re-derives a policy. Kept in memory only, for
 * the last {@link MAX_TOOL_MANIFEST_RUNS} runs: the session's history records no per-run entry for it.
 */

import type { TurnAuthority, TurnOriginKind, TurnOriginRecord } from "../turn-origin.ts";
import { isRemoteOwnerOrigin, isThirdPartyOrigin } from "../turn-origin.ts";

export const MAX_TOOL_MANIFEST_RUNS = 16;
const MAX_OFFERED_NAMES = 64;
const MAX_DECISIONS = 32;
const MAX_DETAIL_CHARS = 200;

/** One code per deciding rule. */
export type ToolDecisionCode =
	/** A role or model ceiling: the worker process ceiling, a worker grant's capabilities, the model capability class. */
	| "capability-ceiling"
	/** The session's chosen tool surface: allowed or excluded tool names, or the tool profile's allow and block lists. */
	| "tool-selection"
	/** A setting that switches the tool's capability off. */
	| "settings-disabled"
	/** A profile grant that binds to no registered tool: the extension that would register it is not loaded. */
	| "extension-not-loaded"
	/** A read-only lane keeps only tools that edit nothing. */
	| "read-only-lane"
	/** A run carrying a third party's words reads none of the owner's memory. */
	| "memory-withheld-third-party"
	/** The third-party gate's table of owner-only tools and actions (`ownerOnlyToolCallReason`). */
	| "third-party-owner-only"
	/** The third-party gate kept the outward operation as a draft for the owner. */
	| "third-party-prepared"
	/** A worker carrying a third party's words: an outward operation no standing grant covers is not run. */
	| "third-party-not-run"
	/** A run opened from an owner channel whose channel no longer holds the owner's authority: every guarded call is refused. */
	| "remote-owner-ended"
	/** The remote-owner gate's typed-only table and settings authority (`remoteOwnerTypedOnlyReason`): refused, never held. */
	| "remote-owner-typed-only"
	/** The hardline or an `edge.deny` pattern refused a call of a run opened from an owner channel, in every mode. */
	| "remote-owner-hardline"
	/** The remote-owner gate kept the call as a draft for the owner's approval of exactly that call. */
	| "remote-owner-held";

export interface ToolDecision {
	readonly tool: string;
	readonly code: ToolDecisionCode;
	/** The rule that decided, named by its owner. */
	readonly owner: string;
	readonly detail?: string;
}

export interface RunToolManifest {
	readonly runId: string;
	readonly kind: "root" | "worker";
	readonly startedAt: number;
	readonly endedAt?: number;
	/** The decisive origin's kind (the owner's words or a third party's), when the run has one. */
	readonly origin?: TurnOriginKind;
	/** The authority the run ended with (or holds while it runs). */
	readonly authority: TurnAuthority;
	/** True when a later message changed the run's authority after it started. */
	readonly authorityChanged?: true;
	/** Offered tool names: the latest provider request's for a root run, the lane surface's for a worker attempt. */
	readonly offered: readonly string[];
	readonly offeredOmitted?: number;
	readonly omitted: readonly ToolDecision[];
	readonly refused: readonly ToolDecision[];
	readonly refusedOmitted?: number;
	/** A worker lane's network: granted, or its shell runs offline. */
	readonly network?: "granted" | "offline";
}

interface MutableRun {
	runId: string;
	kind: "root" | "worker";
	startedAt: number;
	endedAt?: number;
	origin?: TurnOriginKind;
	authority: TurnAuthority;
	authorityChanged?: true;
	offered: string[];
	offeredOmitted?: number;
	omitted: ToolDecision[];
	refused: ToolDecision[];
	refusedOmitted?: number;
	network?: "granted" | "offline";
}

/** The rows a worker attempt reports into while it runs. */
export interface WorkerToolManifest {
	/** The attempt carries a third party's words from now on (a steer or event tainted it after it started). */
	noteThirdParty(): void;
	refuse(decision: ToolDecision): void;
	end(nowMs: number): void;
}

function boundedDecision(decision: ToolDecision): ToolDecision {
	return decision.detail !== undefined && decision.detail.length > MAX_DETAIL_CHARS
		? { ...decision, detail: `${decision.detail.slice(0, MAX_DETAIL_CHARS - 1)}…` }
		: decision;
}

function boundedDecisions(decisions: readonly ToolDecision[]): ToolDecision[] {
	const seen = new Set<string>();
	const kept: ToolDecision[] = [];
	for (const decision of decisions) {
		if (seen.has(decision.tool)) continue;
		seen.add(decision.tool);
		if (kept.length < MAX_DECISIONS) kept.push(boundedDecision(decision));
	}
	return kept;
}

function authorityOf(origin: TurnOriginRecord | undefined): TurnAuthority {
	if (isThirdPartyOrigin(origin)) return "third-party";
	return isRemoteOwnerOrigin(origin) ? "remote-owner" : "owner";
}

export class RunToolManifests {
	private readonly runs: MutableRun[] = [];
	private root: MutableRun | undefined;
	private sequence = 0;

	private push(run: MutableRun): void {
		this.runs.push(run);
		if (this.runs.length > MAX_TOOL_MANIFEST_RUNS) this.runs.splice(0, this.runs.length - MAX_TOOL_MANIFEST_RUNS);
	}

	/** A root run starts (one foreground execution), answering `origin`. `epoch` is its submission's. */
	beginRoot(epoch: number | undefined, origin: TurnOriginRecord | undefined, nowMs: number): void {
		this.sequence++;
		this.root = {
			runId: `root-${epoch ?? "unleased"}-${this.sequence}`,
			kind: "root",
			startedAt: nowMs,
			...(origin ? { origin: origin.k } : {}),
			authority: authorityOf(origin),
			offered: [],
			omitted: [],
			refused: [],
		};
		this.push(this.root);
	}

	/** The run's decisive origin after a message it took in; a change of authority is marked. */
	noteRootOrigin(origin: TurnOriginRecord | undefined): void {
		const run = this.root;
		if (!run) return;
		const authority = authorityOf(origin);
		if (authority !== run.authority) run.authorityChanged = true;
		run.authority = authority;
		if (origin) run.origin = origin.k;
	}

	/**
	 * A provider request of the root run: the tools it offered, and why the runtime's other tools were not offered as
	 * the runtime's rules decided them (`RuntimeBuilder.getToolOmissions`). Read only while a root run is in progress.
	 */
	offerRoot(
		tools: readonly { readonly name: string }[] | undefined,
		runtime: { getToolOmissions(): readonly ToolDecision[] },
	): void {
		const run = this.root;
		if (!run) return;
		const omitted = runtime.getToolOmissions();
		const offered = (tools ?? []).map((tool) => tool.name);
		run.offered = offered.slice(0, MAX_OFFERED_NAMES);
		if (offered.length > MAX_OFFERED_NAMES) run.offeredOmitted = offered.length - MAX_OFFERED_NAMES;
		else delete run.offeredOmitted;
		const offeredNames = new Set(offered);
		run.omitted = boundedDecisions(omitted.filter((decision) => !offeredNames.has(decision.tool)));
	}

	/** A call of the root run that a gate refused. */
	refuseRoot(decision: ToolDecision): void {
		if (this.root) refuse(this.root, decision);
	}

	endRoot(nowMs: number): void {
		if (this.root) this.root.endedAt = nowMs;
		this.root = undefined;
	}

	/** A worker attempt starts with the lane surface it was materialized with. */
	beginWorker(input: {
		readonly attemptId: string;
		readonly origin: TurnOriginRecord | undefined;
		/** Whether the attempt starts carrying a third party's words (its own record, not only its dispatch origin). */
		readonly thirdParty: boolean;
		readonly offered: readonly string[];
		readonly omitted: readonly ToolDecision[];
		/** Absent when the lane neither holds `network.http` nor runs its shell offline. */
		readonly network?: "granted" | "offline";
		readonly nowMs: number;
	}): WorkerToolManifest {
		const run: MutableRun = {
			runId: `worker-${input.attemptId}`,
			kind: "worker",
			startedAt: input.nowMs,
			...(input.origin ? { origin: input.origin.k } : {}),
			authority: input.thirdParty ? "third-party" : "owner",
			offered: input.offered.slice(0, MAX_OFFERED_NAMES),
			...(input.offered.length > MAX_OFFERED_NAMES
				? { offeredOmitted: input.offered.length - MAX_OFFERED_NAMES }
				: {}),
			omitted: boundedDecisions(input.omitted),
			refused: [],
			...(input.network ? { network: input.network } : {}),
		};
		this.push(run);
		return {
			noteThirdParty: () => {
				if (run.authority !== "third-party") run.authorityChanged = true;
				run.authority = "third-party";
			},
			refuse: (decision) => refuse(run, decision),
			end: (nowMs) => {
				run.endedAt ??= nowMs;
			},
		};
	}

	/** The recent runs, newest first. */
	list(): readonly RunToolManifest[] {
		return this.runs
			.slice()
			.reverse()
			.map((run) => structuredClone(run));
	}
}

function refuse(run: MutableRun, decision: ToolDecision): void {
	if (run.refused.length < MAX_DECISIONS / 2) run.refused.push(boundedDecision(decision));
	else run.refusedOmitted = (run.refusedOmitted ?? 0) + 1;
}
