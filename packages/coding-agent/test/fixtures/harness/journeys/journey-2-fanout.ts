/**
 * Fan-out: the two ways one `delegate start` call starts several workers.
 *
 * A partition starts one fresh worker per declared slice under one group, and coverage is every slice having an accepted
 * result. A race starts candidates for the same task, and the first accepted result wins while the host cancels the rest.
 * A group has no store of its own: each member's task begins with a host-written header line, and the group is derived
 * from the members' first attempts.
 *
 * The legs pin what the product does today: the accepted result's text and details, each member's task text, the group
 * block `delegate status` appends, one terminal handoff per member with its own group line, and the durable group after
 * the work ends. Every member of one fan-out shares one model, so each member gets its own script track, told apart by
 * the header line of its task.
 */
import "../builtin-install.ts";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import type { FanoutGroupReport } from "../../../../src/core/delegation/worker-fanout.ts";
import { isRecordObject } from "../../../../src/core/util/value-guards.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import {
	type Barrier,
	calls,
	createBarrier,
	HARNESS_PROVIDER,
	type ScriptedReply,
	type ScriptedRequest,
	type ScriptStep,
	text,
} from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { dynamicCalls, expectOwnerWords, fencedToolOutput, ICM_INTAKE_JUDGMENTS } from "./shared.ts";

/** The model a fan-out start pins: the start copies it to every member, so the members share one scripted track set. */
const SLICES_MODEL = "worker-a";
const RACE_MODEL = "worker-b";

const SLICES_PROMPT = "Split the limit read into three slices: north, east and south.";
const SLICES_RETIRE_PROMPT = "Retire the three slice workers.";
const RACE_PROMPT = "Race three candidates on the limit value.";
const RACE_RETIRE_PROMPT = "Retire the three race candidates.";

/** The shared brief every slice's task carries ahead of its own instructions. */
const SHARED_BRIEF = "Read src/limits.ts and report what it holds. Leave every file as it is.";
/** The one task every race candidate attempts. */
const RACE_TASK = "Read src/limits.ts and report the value of MAX_RETRIES.";

/** The three slices, their own instructions, and the report each worker files once released. */
const SLICES = {
	north: {
		instructions: "Report the line that defines MAX_RETRIES.",
		report: "The north slice is done: MAX_RETRIES is 3.",
		reply: "The north slice reported.",
	},
	east: {
		instructions: "Report the keyword src/limits.ts exports MAX_RETRIES with.",
		report: "The east slice is done: MAX_RETRIES is an exported const.",
		reply: "The east slice reported.",
	},
	south: {
		instructions: "Report whether src/limits.ts declares another constant.",
		report: "The south slice is done: no other constant is declared.",
		reply: "All three slices reported.",
	},
} as const;

const SLICE_IDS = ["north", "east", "south"] as const;
const CANDIDATE_IDS = ["c1", "c2", "c3"] as const;

/** The sentence an accepted partition ends with, ahead of the queued state line. */
const COVERAGE_SENTENCE =
	"Coverage: delegate status lists the group and every terminal handoff carries its line; a slice with no accepted result is a finding, never a block on other work.";
/** The sentence an accepted race ends with. */
const RACE_SENTENCE =
	"Race: the first accepted result wins and the host cancels the other candidates; each terminal handoff carries the outcome.";

/** A group id is `fo-` and eight hex digits. */
const GROUP_ID_PATTERN = /^fo-[0-9a-f]{8}$/;

/** The members every fan-out of these legs declares, in declaration order. */
function declaredList(memberIds: readonly string[]): string {
	return memberIds.join(",");
}

function sliceHeader(groupId: string, memberId: string): string {
	return `[fan-out ${groupId} | partition | slice ${memberId} | declared: ${declaredList(SLICE_IDS)}]`;
}

/** The complete task text a partition member receives: header, shared brief, its own slice, then the peers it must not cover. */
function sliceTask(groupId: string, memberId: keyof typeof SLICES): string {
	const others = SLICE_IDS.filter((id) => id !== memberId).join(", ");
	return `${sliceHeader(groupId, memberId)}\n${SHARED_BRIEF}\n\nYour slice (${memberId}): ${SLICES[memberId].instructions}\n\nYou are one of 3 workers on this task. The other slices (${others}) belong to separate workers: cover only your slice and report on it.`;
}

type RequestMessage = ScriptedRequest["context"]["messages"][number];

/** The text of one message, whichever way its content is shaped. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) =>
			isRecordObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
		)
		.join("\n");
}

function messageText(message: RequestMessage | undefined): string {
	return contentText(message?.content);
}

/** The task text a worker request delivers: what the host frames between its `TASK` and `END TASK` lines. */
function dispatchText(request: ScriptedRequest): string {
	for (const message of request.context.messages) {
		const framed = /^TASK\n([\s\S]*?)\nEND TASK$/m.exec(messageText(message))?.[1];
		if (framed?.startsWith("[fan-out ")) return framed;
	}
	throw new Error("the worker request carries no fan-out task");
}

/** Whether a request delivers a task whose header names this member: how one script track is told from its siblings. */
function carriesHeader(request: ScriptedRequest, marker: string): boolean {
	return request.context.messages.some((message) => messageText(message).includes(marker));
}

/** The script track of one member: a task whose header names that member's slice (or candidate). */
function memberMatcher(kind: "partition" | "race", word: "slice" | "candidate", memberId: string) {
	return (request: ScriptedRequest): boolean => carriesHeader(request, `| ${kind} | ${word} ${memberId} |`);
}

/** A worker's whole reply: one report call that ends its lane. */
function reportReply(callId: string, report: Record<string, unknown>): ScriptedReply {
	return {
		content: [{ type: "toolCall", id: callId, name: "submit_report", arguments: report }],
		stopReason: "toolUse",
	};
}

interface DelegateReceipt {
	readonly text: string;
	readonly isError: boolean;
	readonly details: Record<string, unknown>;
}

/** Every `delegate` result in the session's transcript, oldest first, with the details the product attached. */
function delegateReceipts(session: AgentSession): DelegateReceipt[] {
	const receipts: DelegateReceipt[] = [];
	for (const message of session.messages) {
		if (message.role !== "toolResult" || message.toolName !== "delegate") continue;
		receipts.push({
			text: fencedToolOutput(contentText(message.content)),
			isError: message.isError === true,
			details: isRecordObject(message.details) ? message.details : {},
		});
	}
	return receipts;
}

interface FanoutMemberView {
	readonly memberId: string;
	readonly laneId: string | undefined;
	readonly agentId: string | undefined;
	readonly skipReason: string | undefined;
}

interface FanoutStartView {
	readonly started: boolean;
	readonly action: string;
	readonly agentIds: readonly string[];
	readonly h: readonly string[];
	readonly groupId: string;
	readonly kind: string;
	readonly members: readonly FanoutMemberView[];
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The group a fan-out start's result reports, read from its details rather than from its text. */
function fanoutStart(receipt: DelegateReceipt): FanoutStartView {
	const fanout = receipt.details.fanout;
	if (!isRecordObject(fanout) || !Array.isArray(fanout.members)) {
		throw new Error("the delegate start result carries no fan-out group");
	}
	return {
		started: receipt.details.started === true,
		action: typeof receipt.details.action === "string" ? receipt.details.action : "",
		agentIds: stringList(receipt.details.agentIds),
		h: stringList(receipt.details.h),
		groupId: typeof fanout.groupId === "string" ? fanout.groupId : "",
		kind: typeof fanout.kind === "string" ? fanout.kind : "",
		members: fanout.members.map((member): FanoutMemberView => {
			if (!isRecordObject(member) || typeof member.memberId !== "string") {
				throw new Error("a fan-out member of the start result carries no id");
			}
			return {
				memberId: member.memberId,
				laneId: typeof member.laneId === "string" ? member.laneId : undefined,
				agentId: typeof member.agentId === "string" ? member.agentId : undefined,
				skipReason: typeof member.skipReason === "string" ? member.skipReason : undefined,
			};
		}),
	};
}

/** The lane a member's start result reports. */
function memberLane(start: FanoutStartView, memberId: string): string {
	const member = start.members.find((candidate) => candidate.memberId === memberId);
	if (!member?.laneId) throw new Error(`the start result reports no lane for member ${memberId}`);
	return member.laneId;
}

/** The agent a member's start result reports. */
function memberAgent(start: FanoutStartView, memberId: string): string {
	const member = start.members.find((candidate) => candidate.memberId === memberId);
	if (!member?.agentId) throw new Error(`the start result reports no agent for member ${memberId}`);
	return member.agentId;
}

/** The groups the session's ledger derives. */
function fanoutGroups(session: AgentSession): readonly FanoutGroupReport[] {
	return session.backgroundLanes.getWorkerFanoutGroups();
}

function fanoutGroup(session: AgentSession, groupId: string): FanoutGroupReport {
	const group = fanoutGroups(session).find((candidate) => candidate.groupId === groupId);
	if (!group) throw new Error(`the session holds no fan-out group ${groupId}`);
	return group;
}

function memberOf(group: FanoutGroupReport, memberId: string) {
	const member = group.members.find((candidate) => candidate.memberId === memberId);
	if (!member) throw new Error(`the fan-out group ${group.groupId} declares no member ${memberId}`);
	return member;
}

/** The `member:state` pairs of a group, in declaration order. */
function memberStates(group: FanoutGroupReport): string[] {
	return group.members.map((member) => `${member.memberId}:${member.state}`);
}

/** The line of a terminal handoff that opens a lane's block. */
function handoffHeaderOf(text: string, laneId: string): string | undefined {
	return text.split("\n").find((line) => line.startsWith(`- ${laneId}: `));
}

/** The `Fan-out:` line of a terminal handoff that belongs to `laneId`. */
function fanoutLineOf(text: string): string | undefined {
	return text.split("\n").find((line) => line.startsWith("  Fan-out: "));
}

/**
 * A root turn a worker's own terminal handoff starts: the turn's input is that handoff and no other member's block is in
 * the same turn. The turn acknowledges the block in plain words.
 */
function handoffTurn(input: {
	name: string;
	laneId: string;
	header: string;
	fanout: string;
	siblings: readonly string[];
	arrived: Barrier;
	reply: string;
}): ScriptStep {
	return {
		name: input.name,
		check: (request) => {
			const tail = messageText(request.context.messages.at(-1));
			if (!tail.includes("Background worker terminal handoff:")) {
				throw new Error(
					`${input.laneId} did not reach the root in a turn of its own: the turn's input is not a handoff`,
				);
			}
			const together = input.siblings.filter((laneId) => tail.includes(`- ${laneId}: `));
			if (together.length > 0) {
				throw new Error(
					`${input.laneId} did not reach the root in a turn of its own: the same turn carries ${together.join(", ")}`,
				);
			}
			const header = handoffHeaderOf(tail, input.laneId);
			if (header !== input.header) {
				throw new Error(
					`the handoff block of ${input.laneId} reads ${JSON.stringify(header)}, not ${JSON.stringify(input.header)}`,
				);
			}
			const fanout = fanoutLineOf(tail);
			if (fanout !== `  Fan-out: ${input.fanout}`) {
				throw new Error(
					`the fan-out line of ${input.laneId} reads ${JSON.stringify(fanout)}, not ${JSON.stringify(`  Fan-out: ${input.fanout}`)}`,
				);
			}
			input.arrived.release();
		},
		reply: { content: [{ type: "text", text: input.reply }] },
	};
}

/** The delegate calls that retire the given agents, one call each. */
function retireCalls(
	agentIds: readonly string[],
	callIdPrefix: string,
): { id: string; name: string; arguments: Record<string, unknown> }[] {
	return agentIds.map((agentId, index) => ({
		id: `${callIdPrefix}-${index + 1}`,
		name: "delegate",
		arguments: { action: "retire", agentId },
	}));
}

/** The requests one fan-out's members sent to `modelId` after the leg began, in arrival order. */
function memberRequests(world: HarnessWorld, modelId: string, from: number): readonly ScriptedRequest[] {
	return world.provider.requests.slice(from).filter((request) => request.model.id === modelId);
}

/** The branch's worker terminal handoff posts that name `laneId`. */
function workerHandoffPosts(sessionManager: SessionManager, laneId: string): number {
	return sessionManager
		.getBranch()
		.filter(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "background-worker-completion" &&
				JSON.stringify(entry.content).includes(`- ${laneId}: `),
		).length;
}

/**
 * Leg A: a partition of three slices while the fleet lets two workers run.
 *
 * The first two slices are held at their first request and the third waits for room, so the leg pins the start's text and
 * details, each member's task text, the group block of `delegate status`, and then one handoff per slice as room frees.
 */
export async function runJourney2FanoutSlicesPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const nativeFleet = world.settingsManager.getGlobalSettings().fleet;
	const nativeRunning = world.settingsManager.getFleetSettings().ceiling.running;
	// The fleet lets two workers run: the two first slices run and the third is admitted queued for room.
	world.settingsManager.setFleetSettings({ ...nativeFleet, ceiling: { ...nativeFleet?.ceiling, running: 2 } });
	const sessionManager = world.createSessionManager();
	const { session } = await world.createRootSession("root", { sessionManager });
	const requestsBefore = world.provider.requests.length;
	const holds = { north: createBarrier(), east: createBarrier(), south: createBarrier() };
	const firstRequests = { north: createBarrier(), east: createBarrier(), south: createBarrier() };
	const handoffArrived = { north: createBarrier(), east: createBarrier(), south: createBarrier() };
	let groupId = "";
	let northStateWhenSouthStarted: string | undefined;

	// One track per slice: all three share the start's model, and the header line of each task tells them apart.
	world.provider.enqueueTrack("j2f-slices-north", SLICES_MODEL, memberMatcher("partition", "slice", "north"), {
		name: "j2f-slices-north-report",
		gate: holds.north.promise,
		check: () => firstRequests.north.release(),
		reply: reportReply("j2f-slices-north-report-1", { status: "completed", summary: SLICES.north.report }),
	});
	world.provider.enqueueTrack("j2f-slices-east", SLICES_MODEL, memberMatcher("partition", "slice", "east"), {
		name: "j2f-slices-east-report",
		gate: holds.east.promise,
		check: () => firstRequests.east.release(),
		reply: reportReply("j2f-slices-east-report-1", { status: "completed", summary: SLICES.east.report }),
	});
	world.provider.enqueueTrack("j2f-slices-south", SLICES_MODEL, memberMatcher("partition", "slice", "south"), {
		name: "j2f-slices-south-report",
		gate: holds.south.promise,
		check: () => {
			// The queued slice is admitted only once a slot frees: at its first request the slice before it has ended.
			northStateWhenSouthStarted = memberOf(fanoutGroup(session, groupId), "north").state;
			firstRequests.south.release();
		},
		reply: reportReply("j2f-slices-south-report-1", { status: "completed", summary: SLICES.south.report }),
	});
	world.provider.enqueue(
		"root",
		calls("j2f-slices-start", [
			{
				id: "j2f-slices-start-1",
				name: "delegate",
				arguments: {
					action: "start",
					instructions: SHARED_BRIEF,
					slices: SLICE_IDS.map((id) => ({ id, instructions: SLICES[id].instructions })),
					model: { provider: HARNESS_PROVIDER, modelId: SLICES_MODEL },
					readOnly: true,
				},
			},
		]),
		calls("j2f-slices-status", [{ id: "j2f-slices-status-1", name: "delegate", arguments: { action: "status" } }]),
		text("j2f-slices-running", "The three slices are running."),
	);
	// A plain owner request that leads to a delegate start, then the owner request that retires the workers: the same
	// owner-policy judgments, and no answer makes a delivery claim.
	world.systemOne.enterPhase("j2f-fanout-slices", ICM_INTAKE_JUDGMENTS, {
		expect: expectOwnerWords({
			sessionManager: () => sessionManager,
			userRequests: [SLICES_PROMPT, SLICES_RETIRE_PROMPT],
			optionalToolNames: ["secret_store"],
		}),
	});

	await withDeadline(trace, "the slices start turn", session.prompt(SLICES_PROMPT));

	// 1. The accepted start: its text and details.
	const receipts = delegateReceipts(session);
	expect(receipts, "the start turn made the fan-out start and one status call").toHaveLength(2);
	const [startReceipt, statusReceipt] = receipts as [DelegateReceipt, DelegateReceipt];
	expect(startReceipt.isError, "the fan-out start was accepted").toBe(false);
	const start = fanoutStart(startReceipt);
	groupId = start.groupId;
	const lanes = {
		north: memberLane(start, "north"),
		east: memberLane(start, "east"),
		south: memberLane(start, "south"),
	};
	const agents = {
		north: memberAgent(start, "north"),
		east: memberAgent(start, "east"),
		south: memberAgent(start, "south"),
	};
	expect(groupId, "the group id is fo- and eight hex digits").toMatch(GROUP_ID_PATTERN);
	expect(start.kind, "the declared slices make a partition group").toBe("partition");
	expect(
		startReceipt.text,
		"the start result reports the group, one line per member, coverage, and the queued state",
	).toBe(
		[
			`fan-out ${groupId} (partition, 3 slices): 3 started`,
			`- north: lane ${lanes.north} agent ${agents.north} (running)`,
			`- east: lane ${lanes.east} agent ${agents.east} (running)`,
			`- south: lane ${lanes.south} agent ${agents.south} (queued)`,
			COVERAGE_SENTENCE,
			"h QUEUED",
		].join("\n"),
	);
	expect(start.started, "the result reports the start as started").toBe(true);
	expect(start.action, "the result reports the start action").toBe("start");
	expect(start.agentIds, "the result lists the three agents it started").toEqual([
		agents.north,
		agents.east,
		agents.south,
	]);
	expect(start.h, "the result carries QUEUED because one member waits for room").toEqual(["QUEUED"]);
	expect(
		start.members.map((member) => member.memberId),
		"the details list the three declared members in slot order",
	).toEqual(["north", "east", "south"]);
	for (const member of start.members) {
		expect(member.laneId, `the details report the lane of ${member.memberId}`).toBeDefined();
		expect(member.agentId, `the details report the agent of ${member.memberId}`).toBeDefined();
		expect(member.skipReason, `no member of ${groupId} was skipped`).toBeUndefined();
	}

	// The two admitted slices are held at their first request; the queued slice sends none.
	await withDeadline(
		trace,
		"north and east are held at their first request",
		Promise.all([firstRequests.north.promise, firstRequests.east.promise]),
	);
	const requestsOf = (): readonly ScriptedRequest[] => memberRequests(world, SLICES_MODEL, requestsBefore);

	// 2. Each member's task text starts with its header line and carries the shared brief and its own slice.
	for (const memberId of ["north", "east"] as const) {
		const request = requestsOf().find((candidate) => carriesHeader(candidate, `| partition | slice ${memberId} |`));
		if (!request) throw new Error(`${memberId} sent no request to the scripted provider`);
		expect(
			dispatchText(request),
			`the task of ${memberId} is its header line, the shared brief and its own slice`,
		).toBe(sliceTask(groupId, memberId));
	}
	const attempts = Object.values(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {});
	for (const memberId of SLICE_IDS) {
		const durable = attempts.filter((attempt) =>
			attempt.dispatch.instructions.includes(`| partition | slice ${memberId} |`),
		);
		expect(durable, `the ledger holds one dispatch for ${memberId}`).toHaveLength(1);
		const instructions = durable[0]?.dispatch.instructions ?? "";
		expect(instructions, `the dispatch of ${memberId} starts with its declaration header`).toContain(
			`${sliceHeader(groupId, memberId)}\n`,
		);
		expect(
			instructions.startsWith(`${sliceHeader(groupId, memberId)}\n`),
			`the dispatch of ${memberId} starts with its header`,
		).toBe(true);
		expect(instructions, `the dispatch of ${memberId} carries the shared brief`).toContain(SHARED_BRIEF);
		expect(instructions, `the dispatch of ${memberId} carries its own slice instructions`).toContain(
			`Your slice (${memberId}): ${SLICES[memberId].instructions}`,
		);
	}

	// 3. While the members run: one group, unsettled and uncovered, every member pending in slot order, and the status
	// block `delegate status` appends carries that group's line.
	const running = fanoutGroup(session, groupId);
	expect(running.kind, "the running group is a partition").toBe("partition");
	expect(running.declared, "the group declares the three slices in order").toEqual(["north", "east", "south"]);
	expect(memberStates(running), "every slice is pending while the workers are held").toEqual([
		"north:pending",
		"east:pending",
		"south:pending",
	]);
	expect(running.settled, "the group is not settled while two slices run").toBe(false);
	expect(running.covered, "the group is not covered before any slice is accepted").toBe(false);
	expect(running.winner, "a partition has no winner").toBeUndefined();
	const pendingLine = `fan-out ${groupId} partition: 0/3 slices accepted; north pending lane ${lanes.north}; east pending lane ${lanes.east}; south pending lane ${lanes.south} (still running)`;
	expect(statusReceipt.isError, "the status call was accepted").toBe(false);
	expect(
		statusReceipt.text.endsWith(`Fan-out groups:\n- ${pendingLine}`),
		`the status result ends with the running group's line: ${JSON.stringify(statusReceipt.text.slice(-400))}`,
	).toBe(true);
	expect(
		fanoutGroups(session).map((group) => group.groupId),
		"the session's ledger holds this one fan-out group",
	).toEqual([groupId]);

	expect(
		requestsOf().filter((request) => carriesHeader(request, "| partition | slice south |")),
		"the queued slice sent no request while no slot is free",
	).toHaveLength(0);

	// 4. The first slice ends: its handoff reaches the root in a turn of its own, and the queued slice starts for the room.
	world.provider.enqueue(
		"root",
		handoffTurn({
			name: "j2f-slices-north-handoff",
			laneId: lanes.north,
			header: `- ${lanes.north}: succeeded reason=worker_completed`,
			fanout: `fan-out ${groupId} partition: 1/3 slices accepted; east pending lane ${lanes.east}; south pending lane ${lanes.south} (still running)`,
			siblings: [lanes.east, lanes.south],
			arrived: handoffArrived.north,
			reply: SLICES.north.reply,
		}),
	);
	holds.north.release();
	await withDeadline(trace, "the north handoff reaches the root", handoffArrived.north.promise);
	await withDeadline(trace, "the north handoff turn settles", session.waitForForegroundIdle());
	await withDeadline(trace, "the queued slice starts for the room north freed", firstRequests.south.promise);
	expect(northStateWhenSouthStarted, "the queued slice started only after the slice ahead of it was accepted").toBe(
		"accepted",
	);

	// 5. The other two slices end one after the other, each handoff in a turn of its own; the last one covers the group.
	world.provider.enqueue(
		"root",
		handoffTurn({
			name: "j2f-slices-east-handoff",
			laneId: lanes.east,
			header: `- ${lanes.east}: succeeded reason=worker_completed`,
			fanout: `fan-out ${groupId} partition: 2/3 slices accepted; south pending lane ${lanes.south} (still running)`,
			siblings: [lanes.north, lanes.south],
			arrived: handoffArrived.east,
			reply: SLICES.east.reply,
		}),
	);
	holds.east.release();
	await withDeadline(trace, "the east handoff reaches the root", handoffArrived.east.promise);
	await withDeadline(trace, "the east handoff turn settles", session.waitForForegroundIdle());
	world.provider.enqueue(
		"root",
		handoffTurn({
			name: "j2f-slices-south-handoff",
			laneId: lanes.south,
			header: `- ${lanes.south}: succeeded reason=worker_completed`,
			fanout: `fan-out ${groupId} partition: 3/3 slices accepted`,
			siblings: [lanes.north, lanes.east],
			arrived: handoffArrived.south,
			reply: SLICES.south.reply,
		}),
	);
	holds.south.release();
	await withDeadline(trace, "the south handoff reaches the root", handoffArrived.south.promise);
	await withDeadline(trace, "the south handoff turn settles", session.waitForForegroundIdle());

	// 6. The end: the group is settled and covered, every member accepted, and each member reported once.
	const settled = fanoutGroup(session, groupId);
	expect(memberStates(settled), "every slice of the group was accepted").toEqual([
		"north:accepted",
		"east:accepted",
		"south:accepted",
	]);
	expect(settled.settled, "the group is settled once every slice ended").toBe(true);
	expect(settled.covered, "the group is covered once every slice has an accepted result").toBe(true);
	expect(settled.winner, "a partition has no winner").toBeUndefined();
	expect(settled.cancelFailures, "the group reports no cancellation it could not carry out").toBeUndefined();
	for (const memberId of SLICE_IDS) {
		expect(
			workerHandoffPosts(sessionManager, lanes[memberId]),
			`the root was given exactly one handoff for the lane of ${memberId}`,
		).toBe(1);
	}
	for (const memberId of SLICE_IDS) {
		expect(
			requestsOf().filter((request) => carriesHeader(request, `| partition | slice ${memberId} |`)),
			`the model of ${memberId} was asked exactly once`,
		).toHaveLength(1);
	}

	// The owner retires the three workers: each retire call is accepted and leaves the agent retired.
	const receiptsBeforeRetire = delegateReceipts(session).length;
	world.provider.enqueue(
		"root",
		dynamicCalls("j2f-slices-retire", () =>
			retireCalls([agents.north, agents.east, agents.south], "j2f-slices-retire"),
		),
		text("j2f-slices-retired", "The slice workers are retired."),
	);
	await withDeadline(trace, "the retire turn", session.prompt(SLICES_RETIRE_PROMPT));
	const retireReceipts = delegateReceipts(session).slice(receiptsBeforeRetire);
	expect(retireReceipts, "the retire turn made one call per slice worker").toHaveLength(3);
	for (const receipt of retireReceipts) {
		expect(receipt.isError, `every retire call was accepted: ${JSON.stringify(receipt.text.slice(0, 200))}`).toBe(
			false,
		);
	}
	const liveAgents = new Map(
		session.backgroundLanes.listWorkerAgents().map((agent) => [agent.agentId, agent.status] as const),
	);
	for (const memberId of SLICE_IDS) {
		expect(liveAgents.get(agents[memberId]), `the worker of ${memberId} is retired`).toBe("retired");
	}
	world.settingsManager.setFleetSettings({
		...nativeFleet,
		ceiling: { ...nativeFleet?.ceiling, running: nativeRunning },
	});
	expect(
		world.settingsManager.getFleetSettings().ceiling.running,
		"the phase left the fleet's running ceiling at the value it found",
	).toBe(nativeRunning);
	expect(await world.disposeSessionInBody(session), "the slices root disposes cleanly").toBeUndefined();
}

/**
 * Leg B: a race of three candidates.
 *
 * The first candidate ends without an accepted result, which cancels nobody. The second ends with an accepted result: it
 * wins, and the host cancels the third with a reason that names the winner's lane. The third's held reply arrives after
 * its lane was cancelled and changes nothing.
 */
export async function runJourney2FanoutRacePhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	const nativeFleet = world.settingsManager.getGlobalSettings().fleet;
	const nativeRunning = world.settingsManager.getFleetSettings().ceiling.running;
	// The fleet lets three workers run: every candidate starts at once, so the race is decided by who answers first.
	world.settingsManager.setFleetSettings({ ...nativeFleet, ceiling: { ...nativeFleet?.ceiling, running: 3 } });
	const sessionManager = world.createSessionManager();
	const { session } = await world.createRootSession("root", { sessionManager });
	const requestsBefore = world.provider.requests.length;
	const holds = { c1: createBarrier(), c2: createBarrier(), c3: createBarrier() };
	const firstRequests = { c1: createBarrier(), c2: createBarrier(), c3: createBarrier() };
	const win = createBarrier();
	const firstHandoff = createBarrier();
	const c3Terminals: string[] = [];
	let groupId = "";

	world.provider.enqueueTrack("j2f-race-c1", RACE_MODEL, memberMatcher("race", "candidate", "c1"), {
		name: "j2f-race-c1-report",
		gate: holds.c1.promise,
		check: () => firstRequests.c1.release(),
		reply: reportReply("j2f-race-c1-report-1", {
			status: "blocked",
			summary: "The retry value cannot be read without the owner.",
			blockers: ["The owner must say which file holds the retry value."],
		}),
	});
	world.provider.enqueueTrack("j2f-race-c2", RACE_MODEL, memberMatcher("race", "candidate", "c2"), {
		name: "j2f-race-c2-report",
		gate: holds.c2.promise,
		check: () => firstRequests.c2.release(),
		reply: reportReply("j2f-race-c2-report-1", { status: "completed", summary: "MAX_RETRIES is 3." }),
	});
	world.provider.enqueueTrack("j2f-race-c3", RACE_MODEL, memberMatcher("race", "candidate", "c3"), {
		name: "j2f-race-c3-report",
		gate: holds.c3.promise,
		check: () => firstRequests.c3.release(),
		onTerminal: (_request, message) => c3Terminals.push(message.stopReason),
		reply: reportReply("j2f-race-c3-report-1", { status: "completed", summary: "MAX_RETRIES is 3 as well." }),
	});
	world.provider.enqueue(
		"root",
		calls("j2f-race-start", [
			{
				id: "j2f-race-start-1",
				name: "delegate",
				arguments: {
					action: "start",
					instructions: RACE_TASK,
					race: 3,
					model: { provider: HARNESS_PROVIDER, modelId: RACE_MODEL },
					readOnly: true,
				},
			},
		]),
		text("j2f-race-running", "The three candidates are running."),
	);
	world.systemOne.enterPhase("j2f-fanout-race", ICM_INTAKE_JUDGMENTS, {
		expect: expectOwnerWords({
			sessionManager: () => sessionManager,
			userRequests: [RACE_PROMPT, RACE_RETIRE_PROMPT],
			optionalToolNames: ["secret_store"],
		}),
	});

	await withDeadline(trace, "the race start turn", session.prompt(RACE_PROMPT));

	// 1. The accepted start: three candidates, all running, and the race sentence.
	const startReceipt = delegateReceipts(session)[0];
	if (!startReceipt) throw new Error("the race start turn made no delegate call");
	expect(startReceipt.isError, "the race start was accepted").toBe(false);
	const start = fanoutStart(startReceipt);
	groupId = start.groupId;
	const lanes = {
		c1: memberLane(start, "c1"),
		c2: memberLane(start, "c2"),
		c3: memberLane(start, "c3"),
	};
	const agents = {
		c1: memberAgent(start, "c1"),
		c2: memberAgent(start, "c2"),
		c3: memberAgent(start, "c3"),
	};
	expect(groupId, "the group id is fo- and eight hex digits").toMatch(GROUP_ID_PATTERN);
	expect(start.kind, "the candidate count makes a race group").toBe("race");
	expect(startReceipt.text, "the start result reports the race, one line per candidate, and the race sentence").toBe(
		[
			`fan-out ${groupId} (race, 3 candidates): 3 started`,
			`- c1: lane ${lanes.c1} agent ${agents.c1} (running)`,
			`- c2: lane ${lanes.c2} agent ${agents.c2} (running)`,
			`- c3: lane ${lanes.c3} agent ${agents.c3} (running)`,
			RACE_SENTENCE,
		].join("\n"),
	);
	expect(start.h, "no candidate waits for room").toEqual([]);
	expect(start.agentIds, "the result lists the three agents it started").toEqual([agents.c1, agents.c2, agents.c3]);
	await withDeadline(
		trace,
		"the three candidates are held at their first request",
		Promise.all([firstRequests.c1.promise, firstRequests.c2.promise, firstRequests.c3.promise]),
	);

	// 2. The first candidate ends without an accepted result: nobody is cancelled.
	world.provider.enqueue("root", {
		name: "j2f-race-c1-handoff",
		check: (request) => {
			const tail = messageText(request.context.messages.at(-1));
			if (!tail.includes("Background worker terminal handoff:")) {
				throw new Error(
					"the first candidate did not reach the root in a turn of its own: the input is not a handoff",
				);
			}
			if (!(handoffHeaderOf(tail, lanes.c1) ?? "").startsWith(`- ${lanes.c1}: blocked`)) {
				throw new Error(
					`the handoff of the first candidate reads ${JSON.stringify(handoffHeaderOf(tail, lanes.c1))}, not a blocked lane`,
				);
			}
			const fanout = fanoutLineOf(tail) ?? "";
			if (!fanout.startsWith(`  Fan-out: fan-out ${groupId} race: no candidate accepted yet`)) {
				throw new Error(`the fan-out line of the first candidate reads ${JSON.stringify(fanout)}`);
			}
			if (!fanout.includes(`c2 pending lane ${lanes.c2}`) || !fanout.includes(`c3 pending lane ${lanes.c3}`)) {
				throw new Error(
					`the fan-out line of the first candidate says the other candidates are not pending: ${fanout}`,
				);
			}
			if (fanout.includes(" won ")) {
				throw new Error(`the fan-out line of the first candidate reports a winner: ${fanout}`);
			}
			const group = fanoutGroup(session, groupId);
			if (group.winner !== undefined) throw new Error("a candidate won although none was accepted");
			for (const memberId of ["c2", "c3"] as const) {
				if (memberOf(group, memberId).state !== "pending") {
					throw new Error(`candidate ${memberId} was cancelled before any candidate was accepted`);
				}
			}
			firstHandoff.release();
		},
		reply: { content: [{ type: "text", text: "One candidate reported without a result." }] },
	});
	holds.c1.release();
	await withDeadline(trace, "the first candidate's handoff reaches the root", firstHandoff.promise);
	await withDeadline(trace, "the first candidate's handoff turn settles", session.waitForForegroundIdle());
	const afterFirst = fanoutGroup(session, groupId);
	expect(memberStates(afterFirst), "the first candidate is reported and the other two still run").toEqual([
		"c1:reported",
		"c2:pending",
		"c3:pending",
	]);
	expect(afterFirst.winner, "no candidate is accepted yet").toBeUndefined();

	// 3. The second candidate is accepted: it wins, and the third is cancelled with the winner's lane in the reason.
	world.provider.enqueue("root", {
		name: "j2f-race-win",
		maxRequests: 4,
		until: (request) => {
			const winnerBlock = handoffTextFor(request, `- ${lanes.c2}: `);
			const loserBlock = handoffTextFor(request, `- ${lanes.c3}: `);
			if (!winnerBlock || !loserBlock) return false;
			const winnerHeader = handoffHeaderOf(winnerBlock, lanes.c2);
			if (winnerHeader !== `- ${lanes.c2}: succeeded reason=worker_completed`) {
				throw new Error(`the handoff of the winning candidate reads ${JSON.stringify(winnerHeader)}`);
			}
			const winnerFanout = fanoutLineOf(winnerBlock) ?? "";
			if (!winnerFanout.startsWith(`  Fan-out: fan-out ${groupId} race: c2 won (lane ${lanes.c2})`)) {
				throw new Error(`the fan-out line of the winning candidate reads ${JSON.stringify(winnerFanout)}`);
			}
			const loserHeader = handoffHeaderOf(loserBlock, lanes.c3);
			if (loserHeader !== `- ${lanes.c3}: canceled reason=fanout_race_lost:${lanes.c2}`) {
				throw new Error(`the handoff of the cancelled candidate reads ${JSON.stringify(loserHeader)}`);
			}
			const loserFanout = fanoutLineOf(loserBlock) ?? "";
			if (!loserFanout.startsWith(`  Fan-out: fan-out ${groupId} race: c2 won (lane ${lanes.c2})`)) {
				throw new Error(`the fan-out line of the cancelled candidate reads ${JSON.stringify(loserFanout)}`);
			}
			win.release();
			return true;
		},
		reply: { content: [{ type: "text", text: "The race is settled by the candidate with a result." }] },
	});
	holds.c2.release();
	await withDeadline(trace, "the winning candidate's handoff reaches the root", win.promise);
	await withDeadline(trace, "the race win turn settles", session.waitForForegroundIdle());
	const won = fanoutGroup(session, groupId);
	expect(won.winner?.memberId, "the winner is the second candidate").toBe("c2");
	expect(won.winner?.laneId, "the winner's lane is the lane the result reports").toBe(lanes.c2);
	expect(memberStates(won), "the second candidate is accepted and the third was cancelled").toEqual([
		"c1:reported",
		"c2:accepted",
		"c3:canceled",
	]);
	expect(memberOf(won, "c3").reasonCode, "the cancelled candidate's group entry carries the winner's lane").toBe(
		`fanout_race_lost:${lanes.c2}`,
	);
	const laneRecord = session.getLaneRecords().find((record) => record.laneId === lanes.c3);
	expect(laneRecord?.status, "the lane record of the third candidate ended cancelled").toBe("canceled");
	expect(laneRecord?.reasonCode, "the lane record of the third candidate names the winner's lane").toBe(
		`fanout_race_lost:${lanes.c2}`,
	);
	expect(c3Terminals, "the held request of the cancelled candidate ended with an aborted terminal").toEqual([
		"aborted",
	]);

	// 4. The cancelled loser's late reply changes nothing.
	const c3PostsAtCancellation = workerHandoffPosts(sessionManager, lanes.c3);
	holds.c3.release();
	world.provider.enqueue(
		"root",
		dynamicCalls(
			"j2f-race-retire",
			() => retireCalls([agents.c1, agents.c2, agents.c3], "j2f-race-retire"),
			() => {
				assertCancelledLoserUnchanged(session, groupId, lanes.c2, lanes.c3, c3PostsAtCancellation, sessionManager);
			},
		),
		{
			name: "j2f-race-retired",
			check: () => {
				assertCancelledLoserUnchanged(session, groupId, lanes.c2, lanes.c3, c3PostsAtCancellation, sessionManager);
			},
			reply: { content: [{ type: "text", text: "The candidates are retired." }] },
		},
	);
	await withDeadline(trace, "the race retire turn", session.prompt(RACE_RETIRE_PROMPT));

	// 5. The end: the group is settled and covered, and each candidate was asked exactly once.
	const ended = fanoutGroup(session, groupId);
	expect(ended.settled, "the race group is settled").toBe(true);
	expect(ended.covered, "the race group is covered by its accepted candidate").toBe(true);
	expect(
		ended.members.filter((member) => member.state === "accepted").map((member) => member.memberId),
		"exactly one candidate was accepted",
	).toEqual(["c2"]);
	expect(ended.winner?.memberId, "the winner is still the second candidate").toBe("c2");
	const asked = memberRequests(world, RACE_MODEL, requestsBefore);
	for (const memberId of CANDIDATE_IDS) {
		expect(
			asked.filter((request) => carriesHeader(request, `| race | candidate ${memberId} |`)),
			`the model of ${memberId} was asked exactly once`,
		).toHaveLength(1);
	}
	const liveAgents = new Map(
		session.backgroundLanes.listWorkerAgents().map((agent) => [agent.agentId, agent.status] as const),
	);
	for (const memberId of CANDIDATE_IDS) {
		expect(liveAgents.get(agents[memberId]), `the candidate ${memberId} is retired`).toBe("retired");
	}
	world.settingsManager.setFleetSettings({
		...nativeFleet,
		ceiling: { ...nativeFleet?.ceiling, running: nativeRunning },
	});
	expect(
		world.settingsManager.getFleetSettings().ceiling.running,
		"the phase left the fleet's running ceiling at the value it found",
	).toBe(nativeRunning);
	expect(await world.disposeSessionInBody(session), "the race root disposes cleanly").toBeUndefined();
}

/** The text of the newest handoff block in the request that opens the lane whose header starts with `lanePrefix`. */
function handoffTextFor(request: ScriptedRequest, lanePrefix: string): string | undefined {
	for (let index = request.context.messages.length - 1; index >= 0; index--) {
		const text = messageText(request.context.messages[index]);
		if (text.includes("Background worker terminal handoff:") && text.includes(lanePrefix)) return text;
	}
	return undefined;
}

/** The cancelled loser keeps its state, its reason and its one handoff whatever its held reply does afterwards. */
function assertCancelledLoserUnchanged(
	session: AgentSession,
	groupId: string,
	winnerLaneId: string,
	loserLaneId: string,
	postsAtCancellation: number,
	sessionManager: SessionManager,
): void {
	const group = fanoutGroup(session, groupId);
	const accepted = group.members.filter((member) => member.state === "accepted");
	if (accepted.length !== 1 || accepted[0]?.memberId !== "c2") {
		throw new Error(`the group accepts ${JSON.stringify(accepted.map((member) => member.memberId))}, not only c2`);
	}
	if (group.winner?.laneId !== winnerLaneId) {
		throw new Error(`the winner reads ${JSON.stringify(group.winner?.laneId)}, not ${winnerLaneId}`);
	}
	const loser = memberOf(group, "c3");
	if (loser.state !== "canceled" || loser.reasonCode !== `fanout_race_lost:${winnerLaneId}`) {
		throw new Error(`the cancelled candidate reads ${loser.state} ${JSON.stringify(loser.reasonCode)}`);
	}
	if (loser.laneId !== loserLaneId)
		throw new Error(`the cancelled candidate's lane reads ${JSON.stringify(loser.laneId)}`);
	if (workerHandoffPosts(sessionManager, loserLaneId) !== postsAtCancellation) {
		throw new Error("the cancelled candidate's late reply posted another handoff");
	}
}
