import { expect } from "vitest";
import { displayNameFor } from "../../../../src/core/delegation/bot-naming.ts";
import { WorkerDelegationController } from "../../../../src/core/delegation/worker-delegation-controller.ts";
import type { WorkerDelegationRequest } from "../../../../src/core/delegation/worker-delegation-request.ts";
import {
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
} from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import { createBarrier, HARNESS_PROVIDER } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { deliveredLines } from "./journey-5-shared.ts";
import {
	acceptedJson,
	enqueueBot,
	enqueueRoot,
	loadBotToolStep,
	MODEL_ID,
	modelOf,
	PHASE_JUDGMENTS,
} from "./journey-7-shared.ts";
import { latestBatchResults } from "./shared.ts";

const LEADER = "tree-budget-chief";
const LEADER_SOUL = "Lead the tree budget admission witness.";
const CHILD = "tree-budget-held";
const CHILD_SOUL = "Answer the held tree budget task.";
const HELD_TASK = "H9 held child task";
const PEER_TASK = "H9 admitted sibling task";
const PEER_REPLY = "The admitted sibling finished.";
const LEADER_REPLY = "The start decision arrived.";

/** Two actual children compete for the final attempt in a live leader's tree. */
export async function runJourney7TreeAttemptAdmission(world: HarnessWorld): Promise<void> {
	await runTreeAttemptCase(world, 2);
	await runTreeAttemptCase(world, 3);
}

async function runTreeAttemptCase(world: HarnessWorld, maxAttempts: 2 | 3): Promise<void> {
	const agentDir = `${world.agentDir}-tree-attempt-${maxAttempts}`;
	const track = `j7-tree-leader-${maxAttempts}`;
	const peerTrack = `j7-tree-peer-${maxAttempts}`;
	const requestMark = world.provider.requests.length;
	const profile: OrchestrationProfile = {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: `journey-tree-attempts-${maxAttempts}`,
		description: "Leader with a bounded attempt tree.",
		role: "explorer",
		modelPolicy: {
			mode: "fixed",
			candidates: [{ provider: HARNESS_PROVIDER, modelId: "worker-a", thinkingLevel: "off" }],
		},
		capabilityCeiling: ["filesystem.read", "workflow.message"],
		readOnly: true,
		toolNames: ["read", "bot_message"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: { maxAttempts },
		maxConcurrent: 4,
		leaseTtlMs: 60_000,
		requireIndependentVerification: false,
		createdAt: "2026-10-08T00:00:00.000Z",
		updatedAt: "2026-10-08T00:00:00.000Z",
	};
	const profiles = new OrchestrationProfileStore({ agentDir, cwd: HARNESS_PROJECT_CWD, projectTrusted: false });
	profiles.save(profile, "global");
	profiles.save(
		{
			...profile,
			profileId: `${profile.profileId}-child`,
			modelPolicy: {
				mode: "fixed",
				candidates: [{ provider: HARNESS_PROVIDER, modelId: "worker-b", thinkingLevel: "off" }],
			},
		},
		"global",
	);
	const { session } = await world.createRootSession(MODEL_ID.root, {
		agentDir,
		sessionManager: world.createSessionManager(agentDir),
	});
	const prepared = createBarrier();
	const releaseHeld = createBarrier();
	const peerAtProvider = createBarrier();
	const releasePeer = createBarrier();
	const releaseLeader = createBarrier();
	const rootDone = createBarrier();
	const peerDone = createBarrier();
	let lineage: { parentAgentId: string; delegationObjectiveId?: string } | undefined;
	let refusal = "";
	let afterRefusal: string[] = [];
	const prototype = WorkerDelegationController.prototype;
	const original = Reflect.get(prototype, "admitWorkerStart") as (
		request: WorkerDelegationRequest,
		signal?: AbortSignal,
	) => Promise<{ kind: string }>;
	Reflect.set(
		prototype,
		"admitWorkerStart",
		async function (this: WorkerDelegationController, request: WorkerDelegationRequest, signal?: AbortSignal) {
			const admission = await original.call(this, request, signal);
			if (request.instructions.includes(HELD_TASK)) {
				if (admission.kind !== "fresh" || !request.parentAgentId)
					throw new Error("H9 held child was not freshly prepared under a real parent.");
				lineage = {
					parentAgentId: request.parentAgentId,
					...(request.delegationObjectiveId ? { delegationObjectiveId: request.delegationObjectiveId } : {}),
				};
				prepared.release();
				await releaseHeld.promise;
			}
			return admission;
		},
	);
	try {
		session.upsertPersistentBot({
			agentId: LEADER,
			displayName: displayNameFor(LEADER),
			provider: HARNESS_PROVIDER,
			modelId: MODEL_ID.leader,
			soul: LEADER_SOUL,
			profileId: profile.profileId,
			createdBy: "owner",
		});
		session.upsertPersistentBot({ agentId: LEADER, leader: true });
		enqueueBot(
			world,
			track,
			MODEL_ID.leader,
			LEADER_SOUL,
			{
				name: "tree-create-child",
				reply: {
					content: [
						{
							type: "toolCall",
							id: "tree-create",
							name: "bot_message",
							arguments: {
								action: "create",
								agentId: CHILD,
								description: "Held tree budget worker",
								soul: CHILD_SOUL,
								model: modelOf(MODEL_ID.helper),
							},
						},
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "tree-send-held",
				check: (request) => {
					expect(acceptedJson(request, "bot_message").agentId).toBe(CHILD);
					session.upsertPersistentBot({ agentId: CHILD, profileId: `${profile.profileId}-child` });
				},
				reply: {
					content: [
						{
							type: "toolCall",
							id: "tree-send",
							name: "bot_message",
							arguments: { action: "send", agentId: CHILD, message: HELD_TASK },
						},
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "tree-observe-refusal",
				gate: releaseLeader.promise,
				check: (request) => {
					refusal = latestBatchResults(request).find((result) => result.toolName === "bot_message")?.text ?? "";
					afterRefusal = Object.keys(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).sort();
				},
				reply: { content: [{ type: "text", text: LEADER_REPLY }] },
			},
			{
				name: "tree-leader-followup",
				optional: true,
				reply: { content: [{ type: "text", text: LEADER_REPLY }] },
			},
		);
		world.provider.enqueueTrack(
			peerTrack,
			"worker-a",
			(request) => JSON.stringify(request.context.messages).includes(PEER_TASK),
			{
				name: "tree-peer-held",
				gate: releasePeer.promise,
				check: () => peerAtProvider.release(),
				onTerminal: (_request, message) => {
					expect(message.stopReason).toBe("stop");
					peerDone.release();
				},
				reply: { content: [{ type: "text", text: PEER_REPLY }] },
			},
		);
		if (maxAttempts === 3)
			enqueueBot(world, `j7-tree-held-${maxAttempts}`, MODEL_ID.helper, CHILD_SOUL, {
				name: "tree-held-control",
				reply: { content: [{ type: "text", text: "The held child ran." }] },
			});
		enqueueRoot(
			world,
			loadBotToolStep("tree-root-load"),
			{
				name: "tree-root-lead",
				reply: {
					content: [
						{
							type: "toolCall",
							id: "tree-root-lead-call",
							name: "bot",
							arguments: { action: "lead", goal: "Observe the tree attempt limit.", agentId: LEADER },
						},
					],
					stopReason: "toolUse",
				},
			},
			{ name: "tree-root-started", reply: { content: [{ type: "text", text: "The leader is working." }] } },
			{
				name: "tree-root-finished",
				maxRequests: 8,
				until: (request) => {
					const lines = deliveredLines(request);
					const done = lines.some((line) => line.startsWith("Leader ")) && lines.includes(LEADER_REPLY);
					if (done) rootDone.release();
					return done;
				},
				reply: { content: [{ type: "text", text: "Noted." }] },
			},
		);
		if (world.systemOne.enabled) world.systemOne.enterPhase("j7-tree-attempt", PHASE_JUDGMENTS);
		await withDeadline(world.trace, "tree budget leader starts", session.prompt("Observe the tree attempt limit."));
		await withDeadline(world.trace, "tree budget first child prepared", prepared.promise);
		if (!lineage) throw new Error("H9 did not capture the real parent lineage.");
		const peer = await withDeadline(
			world.trace,
			"tree budget sibling admission",
			session.backgroundLanes.startWorkerDelegation({
				instructions: PEER_TASK,
				parentAgentId: lineage.parentAgentId,
				...(lineage.delegationObjectiveId ? { delegationObjectiveId: lineage.delegationObjectiveId } : {}),
				profileId: profile.profileId,
			}),
		);
		expect(peer.started, "the competing real child consumes the last tree attempt").toBe(true);
		if (!peer.started || !peer.record.agentId) throw new Error("H9 sibling has no worker identity.");
		await withDeadline(world.trace, "tree budget sibling physical request", peerAtProvider.promise);
		const snapshotBefore = session.backgroundLanes.getTaskRuntimeSnapshot();
		const sibling = Object.values(snapshotBefore?.attempts ?? {}).find((attempt) =>
			attempt.dispatch.instructions.includes(PEER_TASK),
		);
		expect(sibling?.dispatch.parentAgentId, "the competing attempt is under A's actual parent").toBe(
			lineage.parentAgentId,
		);
		const beforeRefusal = Object.keys(snapshotBefore?.attempts ?? {}).sort();
		expect(beforeRefusal).toHaveLength(2);
		releaseHeld.release();
		await withDeadline(
			world.trace,
			"tree budget refusal reaches leader",
			world.provider.whenReached(`${track}:tree-observe-refusal`),
		);
		if (maxAttempts === 2) {
			expect(refusal).toContain("worker_tree_attempt_budget_exhausted");
			expect(afterRefusal, "refused materialization creates no attempt").toEqual(beforeRefusal);
			expect(
				world.provider.requests
					.slice(requestMark)
					.filter((request) => (request.context.systemPrompt ?? "").includes(CHILD_SOUL)),
			).toHaveLength(0);
		} else {
			expect(refusal).toContain("started");
			expect(afterRefusal).toHaveLength(3);
			expect(beforeRefusal.every((id) => afterRefusal.includes(id))).toBe(true);
			await withDeadline(
				world.trace,
				"larger tree admits held child",
				world.provider.whenReached(`j7-tree-held-${maxAttempts}:tree-held-control`),
			);
		}
		releasePeer.release();
		await withDeadline(world.trace, "tree budget sibling terminal", peerDone.promise);
		const peerSettled = await withDeadline(
			world.trace,
			"tree budget sibling settles",
			session.backgroundLanes.waitForWorkerAgent(peer.record.agentId, 60_000),
		);
		expect(peerSettled.timedOut).toBe(false);
		expect(session.backgroundLanes.readWorkerAgentLastText(peer.record.agentId, peer.record.laneId)).toContain(
			PEER_REPLY,
		);
		releaseLeader.release();
		await withDeadline(world.trace, "tree budget goal outcome", rootDone.promise, 60_000);
		await withDeadline(world.trace, "tree budget root idle", session.waitForForegroundIdle());
	} finally {
		releaseHeld.release();
		releasePeer.release();
		releaseLeader.release();
		Reflect.set(prototype, "admitWorkerStart", original);
		expect(await world.disposeSessionInBody(session)).toBeUndefined();
	}
	world.provider.retireOptional(track);
	world.trace.mark("root", `j7.tree-attempt-admission-${maxAttempts}`);
}
