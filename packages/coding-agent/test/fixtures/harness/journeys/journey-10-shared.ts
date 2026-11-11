import "../builtin-install.ts";
import { join } from "node:path";
import { hostTransitionsFile } from "../../../../src/core/agent-paths.ts";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import type { LaneRecord } from "../../../../src/core/autonomy/lane-tracker.ts";
import type { FleetMachine } from "../../../../src/core/remote/fleet-machines.ts";
import type { RemoteJobs } from "../../../../src/core/remote/remote-jobs.ts";
import { withHostFileWrite } from "../../../../src/utils/host-write-transition.ts";
import type { ScriptedRequest, ScriptStep } from "../scripted-provider.ts";
import type { HarnessWorld } from "../session-fixture.ts";
import { currentRequestCarries, ICM_INTAKE_JUDGMENTS, latestBatchResults } from "./shared.ts";

const { capabilities_authorized: _capabilities, ...intake } = ICM_INTAKE_JUDGMENTS;

/** Intake judgments for a plain owner prompt on the Hub session (no profile capability prompt). */
export const INTAKE_JUDGMENTS = intake;

/** Judgments consumed by a `plan` `start` owner prompt when System One is enabled. */
export const PLAN_CALL_JUDGMENTS = {
	...INTAKE_JUDGMENTS,
	misses_request_part: { kind: "noul", probability: 0.02 },
	brief_self_contained: { kind: "noul", probability: 0.97 },
} as const;

export const HUB_MACHINE_NAME = "hub-box";
export const JOINER_MACHINE_NAME = "joiner-box";
export const ROGUE_MACHINE_NAME = "rogue-box";

export const JOINER_OWNER_SECRET_MEMORY = "JOINER_PRIVATE_MEMORY_TOKEN_9941: keep strictly local to joiner-box.";
export const LIMITS_REL_PATH = "src/limits.ts";
export const LIMITS_CONTENT = "export const MAX_RETRIES = 3;\nexport const RETRY_BACKOFF_MS = 250;\n";
export const SERVICE_DOC_REL_PATH = "docs/service.md";
export const SERVICE_DOC_CONTENT = "# Service Limits\n\nRetry ceiling is 3 attempts with 250ms backoff.\n";

export const HUB_ROOT_TRACK = "j10-hub-root";
export const JOINER_CHANNEL_TRACK = "j10-joiner-channel";

const STEP_HEADER = /\[plan [^\]]* \| node (\S+) \| attempt 1\]/;
const PLACED_JOB_HEADER = /A request placed on this machine by machine \S+ over the link \(job ([^)]+)\)\./;
const JOB_TAG_PATTERN = /\[j10-job:([a-z0-9-]+)\]/;

/** The plan step a `"root"` model request runs, or `undefined` for the Hub's own foreground turns. */
export function hubPlanStepOf(request: ScriptedRequest): string | undefined {
	return STEP_HEADER.exec(JSON.stringify(request.context.messages))?.[1];
}

function isHubRoot(request: ScriptedRequest): boolean {
	return hubPlanStepOf(request) === undefined;
}

const hubStepMatchers = new Map<string, (request: ScriptedRequest) => boolean>();

function hubStepMatcher(nodeId: string): (request: ScriptedRequest) => boolean {
	let matcher = hubStepMatchers.get(nodeId);
	if (!matcher) {
		matcher = (request) => hubPlanStepOf(request) === nodeId;
		hubStepMatchers.set(nodeId, matcher);
	}
	return matcher;
}

/** Whether a `"worker-b"` model request on Joiner is a `JobRunner` placed-job worker turn. */
export function isJoinerPlacedJob(request: ScriptedRequest): boolean {
	return PLACED_JOB_HEADER.test(JSON.stringify(request.context.messages));
}

/** Extracts `[j10-job:<tag>]` from a Joiner placed-job worker request, or `undefined` for non-job requests. */
export function joinerJobTagOf(request: ScriptedRequest): string | undefined {
	const serialized = JSON.stringify(request.context.messages);
	if (!PLACED_JOB_HEADER.test(serialized)) return undefined;
	return JOB_TAG_PATTERN.exec(serialized)?.[1];
}

function isJoinerChannel(request: ScriptedRequest): boolean {
	return !isJoinerPlacedJob(request);
}

const joinerJobMatchers = new Map<string, (request: ScriptedRequest) => boolean>();

function joinerJobMatcher(tag: string): (request: ScriptedRequest) => boolean {
	let matcher = joinerJobMatchers.get(tag);
	if (!matcher) {
		matcher = (request) => joinerJobTagOf(request) === tag;
		joinerJobMatchers.set(tag, matcher);
	}
	return matcher;
}

export function joinerJobTrack(tag: string): string {
	return `j10-joiner-job-${tag}`;
}

export function joinerJobReached(tag: string, stepName: string): string {
	return `${joinerJobTrack(tag)}:${stepName}`;
}

export function hubStepTrack(nodeId: string): string {
	return `j10-hub-${nodeId}`;
}

/** Enqueues foreground steps for Hub's root session (and any root-model non-step wakeup). */
export function enqueueHubRoot(world: HarnessWorld, ...steps: ScriptStep[]): void {
	world.provider.enqueueTrack(HUB_ROOT_TRACK, "root", isHubRoot, ...steps);
}

/** Enqueues local plan-step worker steps on Hub (`"root"` model, matched by plan node header). */
export function enqueueHubStepWorker(world: HarnessWorld, nodeId: string, ...steps: ScriptStep[]): void {
	world.provider.enqueueTrack(hubStepTrack(nodeId), "root", hubStepMatcher(nodeId), ...steps);
}

/** Enqueues placed-job worker steps on Joiner (`"worker-b"` model, matched by `[j10-job:<tag>]`). */
export function enqueueJoinerJob(world: HarnessWorld, tag: string, ...steps: ScriptStep[]): void {
	world.provider.enqueueTrack(joinerJobTrack(tag), "worker-b", joinerJobMatcher(tag), ...steps);
}

/** Enqueues `link` channel turns on Joiner (`"worker-b"` model, non-placed-job foreground turns). */
export function enqueueJoinerChannel(world: HarnessWorld, ...steps: ScriptStep[]): void {
	world.provider.enqueueTrack(JOINER_CHANNEL_TRACK, "worker-b", isJoinerChannel, ...steps);
}

/** Single-turn `submit_report` worker step, optionally held at `gate`. */
export function reportStep(
	name: string,
	report: Record<string, unknown>,
	gate?: Promise<void>,
	check?: (request: ScriptedRequest) => void,
): ScriptStep {
	return {
		name,
		...(gate ? { gate } : {}),
		...(check ? { check } : {}),
		reply: {
			content: [{ type: "toolCall", id: `${name}-1`, name: "submit_report", arguments: report }],
			stopReason: "toolUse",
		},
	};
}

/** Hub `plan` tool call + accepted receipt (`PLAN_STARTED` or `PLAN_UPDATE`). */
export function planCallSteps(
	name: string,
	args: Record<string, unknown>,
	code: "PLAN_STARTED" | "PLAN_UPDATE",
	onAccepted: (text: string) => void,
): ScriptStep[] {
	return [
		{
			name: `${name}-call`,
			check: (request) => {
				const offered = (request.context.tools ?? []).map((tool) => tool.name);
				if (!offered.includes("plan")) throw new Error(`Hub root is not offered plan: ${offered.join(", ")}`);
			},
			reply: {
				content: [{ type: "toolCall", id: `${name}-call-1`, name: "plan", arguments: args }],
				stopReason: "toolUse",
			},
		},
		{
			name: `${name}-result`,
			check: (request) => {
				const result = latestBatchResults(request).find((entry) => entry.toolName === "plan");
				if (result?.isError || !result?.text.includes(code)) {
					throw new Error(`Plan call was not accepted: ${result?.text ?? "no result"}`);
				}
				onAccepted(result.text);
			},
			reply: { content: [{ type: "text", text: "The plan is running." }] },
		},
	];
}

/** Consumes a `PLAN_UPDATE,<code>` foreground wakeup on Hub. */
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

/** Reads the durable plan projection matching `title` on `session`. */
export function planTitled(session: AgentSession, title: string) {
	const plans = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.plans ?? {});
	const found = plans.filter((plan) => "title" in plan.record && plan.record.title === title);
	if (found.length !== 1) throw new Error(`Expected one plan titled "${title}", found ${found.length}`);
	return found[0]!;
}

/** Latest orchestration attempt for `taskId` on `session`. */
export function latestAttemptOf(session: AgentSession, taskId: string | undefined) {
	const snapshot = session.backgroundLanes.getTaskRuntimeSnapshot();
	const attemptId = taskId === undefined ? undefined : snapshot?.tasks[taskId]?.attemptIds.at(-1);
	return attemptId === undefined ? undefined : snapshot?.attempts[attemptId];
}

/** Event-driven wait on `RemoteJobs.machines` until a peer matching `predicate` appears. */
export function whenMachine(jobs: RemoteJobs, predicate: (machine: FleetMachine) => boolean): Promise<FleetMachine> {
	return new Promise((resolve) => {
		const check = (): FleetMachine | undefined => jobs.machines.list().find(predicate);
		const initial = check();
		if (initial) {
			resolve(initial);
			return;
		}
		const unsubscribe = jobs.machines.subscribe(() => {
			const matched = check();
			if (!matched) return;
			unsubscribe();
			resolve(matched);
		});
	});
}

/** Latest batch `toolResult` matching `toolCallId`, or `undefined` if absent. */
export function batchResultById(
	request: ScriptedRequest,
	toolCallId: string,
): { isError: boolean; text: string } | undefined {
	const messages = request.context.messages;
	let start = messages.length;
	while (start > 0 && messages[start - 1]?.role !== "assistant") start--;
	for (const message of messages.slice(start)) {
		if (message.role !== "toolResult" || message.toolCallId !== toolCallId) continue;
		const text = message.content.map((block) => (block.type === "text" ? block.text : block.type)).join("\n");
		return { isError: message.isError, text };
	}
	return undefined;
}

/** Event-driven wait on `session.onLaneRecordsChanged` until `predicate(records)` holds. */
export function whenLaneRecords(
	session: AgentSession,
	predicate: (records: readonly LaneRecord[]) => boolean,
): Promise<readonly LaneRecord[]> {
	return new Promise((resolve) => {
		const initial = session.getLaneRecords();
		if (predicate(initial)) {
			resolve(initial);
			return;
		}
		const unsubscribe = session.onLaneRecordsChanged((records) => {
			if (!predicate(records)) return;
			unsubscribe();
			resolve(records);
		});
	});
}

/** Writes `<agentDir>/remote/settings.json` through the host-write journal so protected-path watches recognize it. */
export function writeRemoteSettings(
	world: HarnessWorld,
	agentDir: string,
	settings: {
		readonly requireSealed?: boolean;
		readonly repos?: readonly { readonly path: string; readonly ready?: boolean }[];
		readonly peers?: Readonly<
			Record<string, { readonly acceptsJobs?: boolean; readonly trust?: string; readonly hold?: boolean }>
		>;
		readonly offlineHoldMs?: number;
		readonly jobRoom?: number;
	},
): void {
	const remoteDir = join(agentDir, "remote");
	world.io.mkdirSync(remoteDir, { recursive: true });
	const settingsPath = join(remoteDir, "settings.json");
	const content = `${JSON.stringify(settings, null, 1)}\n`;
	withHostFileWrite(
		settingsPath,
		content,
		() => world.io.writeFileSync(settingsPath, content),
		hostTransitionsFile(agentDir),
	);
}
