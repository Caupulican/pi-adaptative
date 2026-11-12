import { expect } from "vitest";
import { displayNameFor } from "../../../../src/core/delegation/bot-naming.ts";
import { WorkerProviderTurnProtocol } from "../../../../src/core/delegation/worker-provider-turn-protocol.ts";
import { CapabilityGateway } from "../../../../src/core/orchestration/capability-gateway.ts";
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
	carries,
	enqueueBot,
	enqueueRoot,
	loadBotToolStep,
	MODEL_ID,
	modelOf,
	PHASE_JUDGMENTS,
} from "./journey-7-shared.ts";

const LEADER = "headroom-chief";
const LEADER_SOUL = "Lead the shared headroom journey and collect the child answer.";
const CHILD_SOUL = "Read the shared headroom question and answer it briefly.";
const CHILD = "headroom-reader";
const ANSWER = "The headroom answer is seven.";
const SIBLING = "headroom-sibling";
const SIBLING_SOUL = "Read the second shared headroom question and answer briefly.";
const SIBLING_ANSWER = "The second answer is two.";

/** Two children of one leader share the real tree budget while each has a provider request in progress. */
export async function runJourney7WorkerHeadroomPhase(world: HarnessWorld): Promise<void> {
	const profile: OrchestrationProfile = {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "journey-headroom",
		description: "Read-only worker with measured shared tree headroom.",
		role: "explorer",
		modelPolicy: {
			mode: "fixed",
			candidates: [{ provider: HARNESS_PROVIDER, modelId: "worker-a", thinkingLevel: "off" }],
		},
		capabilityCeiling: ["filesystem.read", "memory.query", "workflow.message"],
		readOnly: true,
		toolNames: ["read", "zoom", "date", "bot_message"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: { maxTokens: 40_000 },
		maxConcurrent: 4,
		leaseTtlMs: 60_000,
		requireIndependentVerification: false,
		createdAt: "2026-10-08T00:00:00.000Z",
		updatedAt: "2026-10-08T00:00:00.000Z",
	};
	const profiles = new OrchestrationProfileStore({
		agentDir: world.agentDir,
		cwd: HARNESS_PROJECT_CWD,
		projectTrusted: false,
	});
	profiles.save(profile, "global");
	profiles.save(
		{
			...profile,
			profileId: "journey-headroom-child",
			modelPolicy: {
				mode: "fixed",
				candidates: [{ provider: HARNESS_PROVIDER, modelId: "worker-b", thinkingLevel: "off" }],
			},
		},
		"global",
	);
	profiles.save(
		{
			...profile,
			profileId: "journey-headroom-sibling",
			modelPolicy: {
				mode: "fixed",
				candidates: [{ provider: HARNESS_PROVIDER, modelId: "worker-c", thinkingLevel: "off" }],
			},
		},
		"global",
	);
	const { session } = await world.createRootSession(MODEL_ID.root, { sessionManager: world.createSessionManager() });
	const childReserved = createBarrier();
	const releaseChild = createBarrier();
	const siblingReserved = createBarrier();
	const releaseSibling = createBarrier();
	const childReached = createBarrier();
	const rootDone = createBarrier();
	const originalPreflight = WorkerProviderTurnProtocol.prototype.requestPreflight;
	const originalReserve = CapabilityGateway.prototype.reserveProviderBudget;
	let childGateway: CapabilityGateway | undefined;
	let firstOwn: { normal?: number; context?: number } | undefined;
	let beforeOwn: number | undefined;
	let childPreflights = 0;
	let firstDiscard: (() => void) | undefined;
	let staleDiscardPreserved = false;
	let childTransportAfterPreflights = 0;
	let siblingReservationTokens = 0;
	let siblingBefore: number | undefined;
	let siblingAfter: number | undefined;
	CapabilityGateway.prototype.reserveProviderBudget = async function (tokens, subject, signal, request) {
		const system = request?.context.systemPrompt ?? "";
		if (system.includes(CHILD_SOUL) && !firstOwn) beforeOwn = this.remainingContextTokenBudget();
		if (system.includes(SIBLING_SOUL)) {
			if (!childGateway) throw new Error("Sibling reached reservation before child A.");
			expect(childPreflights).toBe(1);
			expect(childTransportAfterPreflights).toBe(0);
			siblingBefore = childGateway.remainingContextTokenBudget();
		}
		const reservation = await originalReserve.call(this, tokens, subject, signal, request);
		if (system.includes(CHILD_SOUL)) {
			childGateway = this;
			firstOwn ??= { normal: this.remainingTokenBudget(), context: this.remainingContextTokenBudget() };
		} else if (system.includes(SIBLING_SOUL)) {
			siblingReservationTokens = reservation.maxTokens;
			siblingAfter = childGateway?.remainingContextTokenBudget();
		}
		return reservation;
	};
	WorkerProviderTurnProtocol.prototype.requestPreflight = async function (request) {
		if ((request?.context.systemPrompt ?? "").includes(LEADER_SOUL)) {
			const context = JSON.stringify(request?.context.messages);
			if (context.includes("headroom-send-sibling-call")) await siblingReserved.promise;
			else if (context.includes("headroom-send-call") && !context.includes("headroom-create-sibling-call"))
				await childReserved.promise;
		}
		const result = await originalPreflight.call(this, request);
		if ((request?.context.systemPrompt ?? "").includes(CHILD_SOUL)) {
			childPreflights++;
			if (childPreflights === 1) {
				firstDiscard = result.discardUndispatched;
				childReserved.release();
				await releaseChild.promise;
			} else if (childPreflights === 2) {
				if (!firstDiscard) throw new Error("The first reservation supplied no discard authority.");
				firstDiscard();
				staleDiscardPreserved =
					(childGateway?.remainingContextTokenBudget() ?? 0) > (childGateway?.remainingTokenBudget() ?? 0);
			}
		}
		return result;
	};
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
			"j7-headroom-leader",
			MODEL_ID.leader,
			LEADER_SOUL,
			{
				name: "headroom-create",
				reply: {
					content: [
						{
							type: "toolCall",
							id: "headroom-create-call",
							name: "bot_message",
							arguments: {
								action: "create",
								agentId: CHILD,
								description: "Reads the headroom question",
								soul: CHILD_SOUL,
								model: modelOf(MODEL_ID.helper),
							},
						},
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "headroom-send",
				check: (request) => {
					const created = acceptedJson(request, "bot_message");
					expect(created.agentId).toBe(CHILD);
					session.upsertPersistentBot({ agentId: CHILD, profileId: "journey-headroom-child" });
				},
				reply: {
					content: [
						{
							type: "toolCall",
							id: "headroom-send-call",
							name: "bot_message",
							arguments: { action: "send", agentId: CHILD, message: "How many days are in a week?" },
						},
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "headroom-create-sibling",
				gate: childReserved.promise,
				reply: {
					content: [
						{
							type: "toolCall",
							id: "headroom-create-sibling-call",
							name: "bot_message",
							arguments: {
								action: "create",
								agentId: SIBLING,
								description: "Reads the second headroom question",
								soul: SIBLING_SOUL,
								model: modelOf(MODEL_ID.teamTwo),
							},
						},
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "headroom-send-sibling",
				check: (request) => {
					const created = acceptedJson(request, "bot_message");
					expect(created.agentId).toBe(SIBLING);
					session.upsertPersistentBot({ agentId: SIBLING, profileId: "journey-headroom-sibling" });
				},
				reply: {
					content: [
						{
							type: "toolCall",
							id: "headroom-send-sibling-call",
							name: "bot_message",
							arguments: { action: "send", agentId: SIBLING, message: "How many eyes does a person have?" },
						},
					],
					stopReason: "toolUse",
				},
			},
			{
				name: "headroom-parent-answer",
				maxRequests: 8,
				until: (request) => carries(request, ANSWER) && carries(request, SIBLING_ANSWER),
				reply: (request) => ({
					content: [
						{
							type: "text",
							text:
								carries(request, ANSWER) && carries(request, SIBLING_ANSWER)
									? `${ANSWER} ${SIBLING_ANSWER}`
									: "Waiting.",
						},
					],
				}),
			},
		);
		enqueueBot(world, "j7-headroom-child", MODEL_ID.helper, CHILD_SOUL, {
			name: "headroom-child-answer",
			check: () => {
				childTransportAfterPreflights = childPreflights;
				childReached.release();
			},
			reply: { content: [{ type: "text", text: ANSWER }] },
		});
		enqueueBot(world, "j7-headroom-sibling", MODEL_ID.teamTwo, SIBLING_SOUL, {
			name: "headroom-sibling-held",
			gate: releaseSibling.promise,
			check: () => siblingReserved.release(),
			reply: { content: [{ type: "text", text: SIBLING_ANSWER }] },
		});
		enqueueRoot(
			world,
			loadBotToolStep("headroom-root-load"),
			{
				name: "headroom-root-lead",
				reply: {
					content: [
						{
							type: "toolCall",
							id: "headroom-root-lead-call",
							name: "bot",
							arguments: { action: "lead", goal: "Answer the headroom question.", agentId: LEADER },
						},
					],
					stopReason: "toolUse",
				},
			},
			{ name: "headroom-root-started", reply: { content: [{ type: "text", text: "The leader is working." }] } },
			{
				name: "headroom-root-finished",
				maxRequests: 8,
				until: (request) => {
					const done = deliveredLines(request).some((line) => line.startsWith("Leader "));
					if (done) rootDone.release();
					return done;
				},
				reply: { content: [{ type: "text", text: "Noted." }] },
			},
		);
		if (world.systemOne.enabled) world.systemOne.enterPhase("j7-headroom", PHASE_JUDGMENTS);
		await withDeadline(world.trace, "headroom leader starts", session.prompt("Answer the headroom question."));
		await withDeadline(world.trace, "child reservation held", childReserved.promise);
		await withDeadline(world.trace, "sibling reservation held", siblingReserved.promise);
		expect(firstOwn?.context).toBeGreaterThan(firstOwn?.normal ?? Number.POSITIVE_INFINITY);
		expect(firstOwn?.context).toBe(beforeOwn);
		expect(siblingReservationTokens).toBeGreaterThan(0);
		expect(siblingBefore).toBeDefined();
		expect(siblingAfter).toBeDefined();
		expect(siblingBefore! - siblingAfter!).toBe(siblingReservationTokens);
		expect(childGateway?.remainingContextTokenBudget()).toBeLessThan(firstOwn?.context ?? 0);
		releaseChild.release();
		await withDeadline(world.trace, "child re-plans before transport", childReached.promise);
		expect(childTransportAfterPreflights).toBeGreaterThan(1);
		expect(staleDiscardPreserved, "discarding an old epoch cannot release the new reservation").toBe(true);
		releaseSibling.release();
		await withDeadline(world.trace, "headroom result returns", rootDone.promise, 60_000);
		await withDeadline(world.trace, "headroom root idle", session.waitForForegroundIdle());
	} finally {
		childReserved.release();
		siblingReserved.release();
		releaseChild.release();
		releaseSibling.release();
		WorkerProviderTurnProtocol.prototype.requestPreflight = originalPreflight;
		CapabilityGateway.prototype.reserveProviderBudget = originalReserve;
		expect(await world.disposeSessionInBody(session)).toBeUndefined();
	}
	world.trace.mark("root", "j7.worker-headroom");
}
