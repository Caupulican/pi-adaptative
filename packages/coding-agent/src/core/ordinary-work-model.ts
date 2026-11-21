/** Finite model of the ordinary-stop protocol. SQLite retains both the spent budget and the in-progress review marker across a crash. */
import { defineModel, type ModelAction, type ModelSpec } from "../kernel/machine-model.ts";
import {
	ORDINARY_WORK_MAX_CONTINUATIONS,
	ordinaryReportingChangedAtSettlement,
	ordinaryWorkReviewGate,
	settleOrdinaryReporting,
} from "./ordinary-work-policy.ts";

interface StopState {
	count: number;
	closed: boolean;
	reviewStarted: boolean;
	review:
		| "idle"
		| "actionable"
		| "approved"
		| "vetoed"
		| "reserved"
		| "answering"
		| "checkingAnswer"
		| "ruleConfirmed"
		| "reviewedAnswer"
		| "staleDuringReview"
		| "staleBeforeCommit";
	answerOnly: boolean;
	toolExecutedDuringAnswer: boolean;
	unauthorizedDispatch: boolean;
	superseded: boolean;
	staleDispatch: boolean;
	revoked: boolean;
	revokedDispatch: boolean;
	unsupportedCompletion: boolean;
	restrictedRevision: boolean;
	staleReportingCompletion: boolean;
}

type Step = ModelAction<StopState>;
type Spec = ModelSpec<StopState>;
const cap = ORDINARY_WORK_MAX_CONTINUATIONS;
const decide = (state: StopState) => !state.closed && !state.reviewStarted && state.review === "idle";
const review = (state: StopState) => !state.closed && state.review === "actionable";
const close = (s: StopState): StopState => ({ ...s, closed: true, reviewStarted: false, review: "idle" });
const reserve: Step = {
	name: "reserve",
	actor: "host",
	guard: (s) =>
		!s.closed &&
		!s.superseded &&
		s.review === "approved" &&
		ordinaryWorkReviewGate("actionable", s.count) === "review",
	apply: (s) => ({
		...s,
		count: s.count + 1,
		reviewStarted: false,
		review: "reserved",
		unauthorizedDispatch: s.review !== "approved",
	}),
};
const dispatch: Step = {
	name: "dispatch",
	actor: "host",
	guard: (s) => !s.closed && s.review === "reserved" && !s.superseded && !s.revoked,
	apply: (s) => ({
		...s,
		review: s.answerOnly ? "answering" : "idle",
		staleDispatch: s.superseded,
		revokedDispatch: s.revoked,
	}),
};
const presentationMet: Step = {
	name: "presentation-met-substance-unverified",
	actor: "host",
	guard: (s) => s.review === "answering",
	apply: (s) => ({
		...close(s),
		unsupportedCompletion: settleOrdinaryReporting("unverified", "fulfilled", s.count, undefined) === "fulfilled",
	}),
};
const presentationConflict: Step = {
	name: "reviewer-requests-restricted-revision",
	actor: "host",
	guard: (s) => review(s) && s.answerOnly,
	apply: (s) => ({
		...close(s),
		restrictedRevision:
			typeof settleOrdinaryReporting(
				"fulfilled",
				{ missing: "source", next: "add source", responseMode: "answer_only" },
				s.count,
				"hard_pass",
			) === "object",
	}),
};
const answerToolCall: Step = {
	name: "answer-requests-tool",
	actor: "host",
	guard: (s) => s.review === "answering",
	apply: close,
};
function settleCapturedAnswer(state: StopState, checkAtCommit: boolean): StopState {
	const stale = state.review === "staleDuringReview" || state.review === "staleBeforeCommit";
	const snapshot = {
		complete: true,
		requirements: [],
		isCurrent: () => (checkAtCommit ? !stale : state.review !== "staleDuringReview"),
	};
	const changed = ordinaryReportingChangedAtSettlement("fulfilled", snapshot);
	return { ...close(state), staleReportingCompletion: stale && !changed };
}
const settleAnswer: Step = {
	name: "settle-reviewed-answer",
	actor: "host",
	guard: (s) => s.review === "reviewedAnswer" || s.review === "staleDuringReview" || s.review === "staleBeforeCommit",
	apply: (s) => settleCapturedAnswer(s, true),
};
const actions: Step[] = [
	{
		name: "interrupted-review",
		actor: "host",
		guard: (s) => s.reviewStarted && s.review === "idle" && !s.closed,
		apply: close,
	},
	{ name: "stop", actor: "host", guard: decide, apply: close },
	{
		name: "begin-review-with-pending-reporting-rule",
		actor: "host",
		guard: decide,
		apply: (s) => ({ ...s, reviewStarted: true, review: "checkingAnswer" }),
	},
	{
		name: "confirm-reporting-rule-during-review",
		actor: "classifier",
		guard: (s) => s.review === "checkingAnswer",
		apply: (s) => ({ ...s, review: "ruleConfirmed" }),
	},
	{
		name: "reviewer-accepts-answer",
		actor: "reviewer",
		guard: (s) => s.review === "checkingAnswer" || s.review === "ruleConfirmed",
		apply: (s) => ({ ...s, review: s.review === "ruleConfirmed" ? "staleDuringReview" : "reviewedAnswer" }),
	},
	{
		name: "confirm-rule-before-checkpoint-transaction",
		actor: "classifier",
		guard: (s) => s.review === "reviewedAnswer",
		apply: (s) => ({ ...s, review: "staleBeforeCommit" }),
	},
	settleAnswer,
	{
		name: "outstanding",
		actor: "jev",
		guard: decide,
		apply: (s) => ({ ...s, answerOnly: false, reviewStarted: true, review: "actionable" }),
	},
	{
		name: "report-ready",
		actor: "jev",
		guard: decide,
		apply: (s) => ({ ...s, answerOnly: true, reviewStarted: true, review: "actionable" }),
	},
	{ name: "veto", actor: "reviewer", guard: review, apply: (s) => ({ ...s, review: "vetoed" }) },
	{ name: "approve", actor: "reviewer", guard: review, apply: (s) => ({ ...s, review: "approved" }) },
	{ name: "review-timeout", actor: "host", guard: review, apply: close },
	{
		name: "owner-revokes-reporting-rule",
		actor: "owner",
		guard: (s) => s.review === "reserved" && s.answerOnly && !s.revoked,
		apply: (s) => ({ ...s, revoked: true }),
	},
	{
		name: "owner-steers",
		actor: "owner",
		guard: (s) => !s.closed && (s.review === "approved" || s.review === "reserved") && !s.superseded,
		apply: (s) => ({ ...s, superseded: true }),
	},
	{
		name: "hold",
		actor: "host",
		guard: (s) =>
			!s.closed &&
			(s.review === "vetoed" ||
				(s.review === "approved" && (s.count >= cap || s.superseded)) ||
				(s.review === "reserved" && (s.superseded || s.revoked))),
		apply: close,
	},
	reserve,
	dispatch,
	{ name: "answer-delivered", actor: "host", guard: (s) => s.review === "answering", apply: close },
	presentationMet,
	presentationConflict,
	answerToolCall,
];
const replaceReserve = (spec: Spec, guard: Step["guard"]): Spec => ({
	...spec,
	actions: spec.actions.map((step) => (step.name === reserve.name ? { ...reserve, guard } : step)),
});

export const ordinaryWorkStopModel = defineModel<StopState>({
	name: "ordinary owner work stop",
	vars: {
		durable: [
			"count",
			"closed",
			"reviewStarted",
			"unauthorizedDispatch",
			"superseded",
			"staleDispatch",
			"revokedDispatch",
			"unsupportedCompletion",
			"restrictedRevision",
			"staleReportingCompletion",
			"toolExecutedDuringAnswer",
		],
		volatile: { review: "idle", answerOnly: false, revoked: false },
	},
	init: [
		{
			count: 0,
			closed: false,
			reviewStarted: false,
			review: "idle",
			answerOnly: false,
			toolExecutedDuringAnswer: false,
			unauthorizedDispatch: false,
			superseded: false,
			staleDispatch: false,
			revoked: false,
			revokedDispatch: false,
			unsupportedCompletion: false,
			restrictedRevision: false,
			staleReportingCompletion: false,
		},
	],
	actions,
	crashes: [{ actor: "host", volatile: { review: "idle", answerOnly: false, revoked: false } }],
	invariants: [
		{
			name: "a newly confirmed reporting rule invalidates a pending completion",
			holds: (s) => !s.staleReportingCompletion,
			brokenVariant: "checkReportingBeforeWrite",
		},
		{
			name: "a decisive current reporting restriction blocks a proposed revision",
			holds: (s) => !s.restrictedRevision,
			brokenVariant: "ignorePresentationRestriction",
		},
		{
			name: "presentation alone cannot certify substantive work",
			holds: (s) => !s.unsupportedCompletion,
			brokenVariant: "closeOnPresentation",
		},
		{
			name: "a report-only reply cannot execute a tool",
			holds: (s) => !s.toolExecutedDuringAnswer,
			brokenVariant: "executeDuringAnswer",
		},
		{
			name: "revoked reporting instructions cannot be sent",
			holds: (s) => !s.revokedDispatch,
			brokenVariant: "ignoreRevocation",
		},
		{
			name: "superseded reviews cannot start a turn",
			holds: (s) => !s.staleDispatch,
			brokenVariant: "ignoreSteering",
		},
		{ name: "lifetime continuation limit", holds: (s) => s.count <= cap, brokenVariant: "bypassLimit" },
		{
			name: "independent assent for each dispatch",
			holds: (s) => !s.unauthorizedDispatch,
			brokenVariant: "bypassVeto",
		},
	],
	liveness: [
		{
			name: "no endless revision under a responsive host",
			goal: (s) => s.closed,
			fair: [
				"stop",
				"review-timeout",
				"reserve",
				"dispatch",
				"hold",
				"interrupted-review",
				"answer-delivered",
				"answer-requests-tool",
				"reviewer-accepts-answer",
				"settle-reviewed-answer",
			],
			brokenVariant: "spinOnVeto",
		},
	],
	terminal: (s) => s.closed,
	bounds: { maxStates: 1000, maxCrashes: 2, maxDrops: 0 },
	covers: [
		{
			path: "core/ordinary-work-policy.ts",
			symbols: [
				"ordinaryWorkReviewGate",
				"ORDINARY_WORK_MAX_CONTINUATIONS",
				"assertOrdinaryDispatch",
				"settleOrdinaryReporting",
				"ordinaryReportingChangedAtSettlement",
			],
		},
		{
			path: "core/ordinary-work-store.ts",
			symbols: ["claim", "continuation_count", "ordinaryReportingChangedAtSettlement"],
		},
		{ path: "core/ordinary-work-controller.ts", symbols: ["reserveContinuation", "isCurrent", "reportingRevision"] },
		{ path: "core/provider-request-runtime-controller.ts", symbols: ["isDispatchCurrent", "revisionCurrent"] },
		{ path: "core/ordinary-work-settlement.ts", symbols: ["withinPlanRequestBound"] },
		{ path: "core/system-one/settlement-judges.ts", symbols: ["decideOrdinaryWorkStop"] },
		{ path: "kernel/tool-protocol-residue.ts", symbols: ["rejectToolCallsFromToolFreeResponse"] },
	],
	variants: {
		checkReportingBeforeWrite: (spec) => ({
			...spec,
			actions: spec.actions.map((step) =>
				step.name === settleAnswer.name ? { ...step, apply: (s) => settleCapturedAnswer(s, false) } : step,
			),
		}),
		ignorePresentationRestriction: (spec) => ({
			...spec,
			actions: spec.actions.map((step) =>
				step.name === presentationConflict.name
					? { ...step, apply: (s) => ({ ...close(s), restrictedRevision: true }) }
					: step,
			),
		}),
		closeOnPresentation: (spec) => ({
			...spec,
			actions: spec.actions.map((step) =>
				step.name === presentationMet.name
					? { ...step, apply: (s) => ({ ...close(s), unsupportedCompletion: true }) }
					: step,
			),
		}),
		executeDuringAnswer: (spec) => ({
			...spec,
			actions: spec.actions.map((step) =>
				step.name === answerToolCall.name
					? { ...step, apply: (s) => ({ ...close(s), toolExecutedDuringAnswer: true }) }
					: step,
			),
		}),
		spinOnVeto: (spec) => ({
			...spec,
			actions: spec.actions.map((step) =>
				step.name === "hold" ? { ...step, apply: (s) => (s.review === "vetoed" ? s : close(s)) } : step,
			),
		}),
		ignoreRevocation: (spec) => ({
			...spec,
			actions: spec.actions.map((step) =>
				step.name === dispatch.name
					? { ...dispatch, guard: (s) => !s.closed && s.review === "reserved" && !s.superseded }
					: step,
			),
		}),
		ignoreSteering: (spec) => ({
			...spec,
			actions: spec.actions.map((step) =>
				step.name === dispatch.name
					? { ...dispatch, guard: (s) => !s.closed && s.review === "reserved" && !s.revoked }
					: step,
			),
		}),
		bypassLimit: (spec) =>
			replaceReserve(spec, (s) => !s.closed && !s.superseded && s.review === "approved" && s.count <= cap),
		bypassVeto: (spec) =>
			replaceReserve(
				spec,
				(s) => !s.closed && !s.superseded && (s.review === "vetoed" || s.review === "approved") && s.count < cap,
			),
	},
	machine: { states: (s) => JSON.stringify(s), events: actions.map((step) => step.name) },
});
