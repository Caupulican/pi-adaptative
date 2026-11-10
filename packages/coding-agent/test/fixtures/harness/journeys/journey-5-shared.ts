import "../builtin-install.ts";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import type { ScriptedRequest, ScriptStep } from "../scripted-provider.ts";
import type { HarnessWorld } from "../session-fixture.ts";
import { currentRequestCarries, ICM_INTAKE_JUDGMENTS, latestBatchResults } from "./shared.ts";

const { capabilities_authorized: _capabilities, ...intake } = ICM_INTAKE_JUDGMENTS;

/** The intake judgments a plain owner prompt consumes here: a plan call without a profile asks no capability question. */
export const INTAKE_JUDGMENTS = intake;

/**
 * What the owner's request and the plan call's review read with System One on: the request's intake, that the plan covers
 * the request, and that each short step can be done from its own words.
 */
export const PLAN_CALL_JUDGMENTS = {
	...INTAKE_JUDGMENTS,
	misses_request_part: { kind: "noul", probability: 0.02 },
	brief_self_contained: { kind: "noul", probability: 0.97 },
} as const;

/** The script track of the root's own requests, shared by every phase of the journey. */
export const ROOT_TRACK = "j5-root";

/** The header every plan step's task starts with. A verifier's task quotes its subjects' headers after its own. */
const STEP_HEADER = /\[plan [^\]]* \| node (\S+) \| attempt 1\]/;

/** The plan step a request runs: the one the first header of its task names. The root's own requests name none. */
export function planStepOf(request: ScriptedRequest): string | undefined {
	return STEP_HEADER.exec(JSON.stringify(request.context.messages))?.[1];
}

function isRoot(request: ScriptedRequest): boolean {
	return planStepOf(request) === undefined;
}

/** One matcher per step id: a track keeps the matcher it was first given. */
const stepMatchers = new Map<string, (request: ScriptedRequest) => boolean>();

function stepMatcher(nodeId: string): (request: ScriptedRequest) => boolean {
	let matcher = stepMatchers.get(nodeId);
	if (!matcher) {
		matcher = (request) => planStepOf(request) === nodeId;
		stepMatchers.set(nodeId, matcher);
	}
	return matcher;
}

/** The track name of one plan step's worker. */
export function stepTrack(nodeId: string): string {
	return `j5-${nodeId}`;
}

/**
 * Scripts one plan step's worker. A step's worker runs on the root's model, so its requests are told apart by the step header
 * its task starts with; step ids are unique across the journey's plans.
 */
export function enqueueStepWorker(world: HarnessWorld, nodeId: string, ...steps: ScriptStep[]): void {
	world.provider.enqueueTrack(stepTrack(nodeId), "root", stepMatcher(nodeId), ...steps);
}

/** Scripts the root's own next requests. */
export function enqueueRoot(world: HarnessWorld, ...steps: ScriptStep[]): void {
	world.provider.enqueueTrack(ROOT_TRACK, "root", isRoot, ...steps);
}

/** The `<track>:<step>` key the provider records when the root reaches `name`. */
export function rootReached(name: string): string {
	return `${ROOT_TRACK}:${name}`;
}

/** The `<track>:<step>` key the provider records when the worker of `nodeId` reaches `name`. */
export function stepReached(nodeId: string, name: string): string {
	return `${stepTrack(nodeId)}:${name}`;
}

/** A worker's whole reply: one `submit_report` call, held at `gate` when one is given. */
export function reportStep(name: string, report: Record<string, unknown>, gate?: Promise<void>): ScriptStep {
	return {
		name,
		...(gate ? { gate } : {}),
		reply: {
			content: [{ type: "toolCall", id: `${name}-1`, name: "submit_report", arguments: report }],
			stopReason: "toolUse",
		},
	};
}

/**
 * The root's `plan` call and the request that follows it, which must carry the call's accepted result (`PLAN_STARTED` for a
 * start, `PLAN_UPDATE` for a revise or a cancel). `onAccepted` reads the result's text.
 */
export function planCallSteps(
	name: string,
	args: Record<string, unknown> | ((request: ScriptedRequest) => Record<string, unknown>),
	code: "PLAN_STARTED" | "PLAN_UPDATE",
	onAccepted: (text: string) => void,
): ScriptStep[] {
	return [
		{
			name: `${name}-call`,
			check: (request) => {
				const offered = (request.context.tools ?? []).map((tool) => tool.name);
				if (!offered.includes("plan")) throw new Error(`the root is not offered plan: ${offered.join(", ")}`);
			},
			reply: (request) => ({
				content: [
					{
						type: "toolCall",
						id: `${name}-call-1`,
						name: "plan",
						arguments: typeof args === "function" ? args(request) : args,
					},
				],
				stopReason: "toolUse",
			}),
		},
		{
			name: `${name}-result`,
			check: (request) => {
				const result = latestBatchResults(request).find((entry) => entry.toolName === "plan");
				if (result?.isError || !result?.text.includes(code)) {
					throw new Error(`the plan call was not accepted: ${result?.text ?? "no result"}`);
				}
				onAccepted(result.text);
			},
			reply: { content: [{ type: "text", text: "The plan is running." }] },
		},
	];
}

type RequestMessage = ScriptedRequest["context"]["messages"][number];

function textOf(message: RequestMessage): string {
	return typeof message.content === "string"
		? message.content
		: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** The text lines the current request delivers: the messages after the root's latest reply. */
export function deliveredLines(request: ScriptedRequest): string[] {
	const messages = request.context.messages;
	let start = messages.length;
	while (start > 0 && messages[start - 1]?.role !== "assistant") start--;
	return messages.slice(start).flatMap((message) => textOf(message).split("\n"));
}

/** The requirement ids a step's task says it proves, as the worker reads them. */
export function stepRequirementIds(request: ScriptedRequest): string[] {
	const prefix = "Requirements this step proves: ";
	const line = stepTaskLines(request).find((candidate) => candidate.startsWith(prefix));
	return line === undefined ? [] : line.slice(prefix.length).split(", ");
}

/** The lines of the task a step's worker was given: the message that carries the step's header. */
export function stepTaskLines(request: ScriptedRequest): string[] {
	const task = request.context.messages.map(textOf).find((text) => STEP_HEADER.test(text));
	if (task === undefined) throw new Error("the request carries no plan step task");
	return task.split("\n");
}

/** How many plan updates the current request delivers. */
export function planUpdatesIn(request: ScriptedRequest): number {
	return deliveredLines(request).filter((line) => line.includes("h PLAN_UPDATE,")).length;
}

/** The one delivered line that starts with `prefix`, without the prefix; fails when the request delivers none or several. */
export function deliveredLine(request: ScriptedRequest, prefix: string): string {
	const lines = deliveredLines(request).filter((line) => line.startsWith(prefix));
	if (lines.length !== 1) throw new Error(`expected one delivered line starting "${prefix}", found ${lines.length}`);
	return lines[0]!.slice(prefix.length);
}

/**
 * The root's turn that a plan update starts. The step answers in plain words and is consumed by the request that delivers the
 * update with `code` (`JOIN_DONE`, `PLAN_DONE`, `REPLAN`, `OWNER_NEEDED`); `onUpdate` reads that request.
 */
export function planUpdateStep(name: string, code: string, onUpdate: (request: ScriptedRequest) => void): ScriptStep {
	return {
		name,
		maxRequests: 8,
		until: (request) => {
			if (!currentRequestCarries(request, `PLAN_UPDATE,${code}`)) return false;
			onUpdate(request);
			return true;
		},
		reply: { content: [{ type: "text", text: "Noted." }] },
	};
}

/** The session's plan with this title: each phase gives its plan its own title. */
export function planTitled(session: AgentSession, title: string) {
	const plans = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.plans ?? {});
	const found = plans.filter((plan) => "title" in plan.record && plan.record.title === title);
	if (found.length !== 1) throw new Error(`expected one plan titled "${title}", found ${found.length}`);
	return found[0]!;
}

/** The newest attempt of a task, as the durable projection holds it. */
export function latestAttemptOf(session: AgentSession, taskId: string | undefined) {
	const snapshot = session.backgroundLanes.getTaskRuntimeSnapshot();
	const attemptId = taskId === undefined ? undefined : snapshot?.tasks[taskId]?.attemptIds.at(-1);
	return attemptId === undefined ? undefined : snapshot?.attempts[attemptId];
}

/** What a step's worker may change, as the contract it was admitted with records it. */
export function stepWriteAuthority(session: AgentSession, taskId: string | undefined) {
	const worker = latestAttemptOf(session, taskId)?.dispatch.executionContract?.worker;
	return (
		worker && {
			readOnly: worker.profile.readOnly === true,
			writePaths: worker.authority.writePaths,
			editTools: worker.authority.toolNames.filter((name) => name === "edit" || name === "write"),
		}
	);
}
