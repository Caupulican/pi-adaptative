import "../builtin-install.ts";
import { expect } from "vitest";
import { ORDINARY_WORK_CONTINUATION_TYPE } from "../../../../src/core/ordinary-work-policy.ts";
import { createBarrier, HARNESS_PROVIDER, phasedReply, text } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";

export async function runOrdinaryStopPhase(world: HarnessWorld): Promise<void> {
	const enabled = world.systemOne.enabled;
	const request = "Return exactly two lines: ALPHA then BETA.";
	const initial = "ALPHA";
	const final = "ALPHA\nBETA";
	const reviewReached = createBarrier();
	const releaseReview = createBarrier();
	const consultReached = createBarrier();
	const releaseConsult = createBarrier();
	const providerMark = world.provider.requests.length;
	const judgmentMark = world.systemOne.decoded.length;
	const fallbackMark = world.systemOne.unrelatedOrdinaryStops.length;
	const created = await world.createRootSession("root", {
		sessionManager: world.createSessionManager(),
		settings: {
			modelRouter: { selectionMode: "manual", expensiveModel: `${HARNESS_PROVIDER}/worker-c`, fitnessGate: false },
			autoLearn: { enabled: false },
		},
	});
	const { session, sessionManager } = created;
	const delivered: string[] = [];
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant")
			delivered.push(
				event.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
			);
	});
	const rows = () => session.getDecisionLedger()!.ordinaryWork.forSession(sessionManager.getSessionId());
	const assertNoOtherWork = () => {
		expect(Object.keys(session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {})).toEqual([]);
		expect(session.getGoalStateSnapshot()).toBeUndefined();
		expect(session.getResourceSnapshot().terminalHandoffs.pendingDeliveries).toBe(0);
		expect(session.getResourceSnapshot().backgroundToolTasks.physicalExecutions).toBe(0);
	};
	try {
		expect(session.thinkingLevel).toBe("off");
		world.systemOne.enterPhase(
			"ordinary-stop-incomplete",
			{
				disposition: { kind: "choice", choice: "actionable", confidence: 0.99 },
				delivered_in_answer: { kind: "noul", probability: 0.01 },
				evidence_sufficient: { kind: "noul", probability: 0.99 },
			},
			{
				gate: releaseReview.promise,
				onAdmit: () => reviewReached.release(),
				expect: (judgment) =>
					expect(judgment.state).toMatchObject({
						request,
						answer: initial,
						hostFacts: {
							interrupted: false,
							terminalStopReason: "stop",
							finalAnswerPresent: true,
							foregroundCallsSettled: true,
							pendingBackgroundWork: "not_checked",
						},
					}),
			},
		);
		world.provider.enqueue("root", {
			...text("ordinary-first-stop", initial),
			check: (transport) => {
				expect(transport.model.reasoning).toBe(false);
				expect(rows()).toHaveLength(1);
				expect(rows()[0]).toMatchObject({ status: "active", continuationCount: 0 });
			},
		});
		if (enabled) {
			world.provider.enqueue("worker-c", {
				name: "ordinary-independent-review",
				reply: phasedReply(
					'{"decision":"hold"}',
					JSON.stringify({
						decision: "continue",
						missing: "The second requested line BETA is absent.",
						next: "Deliver both requested lines ALPHA and BETA.",
					}),
				),
				gate: releaseConsult.promise,
				check: (transport) => {
					expect(transport.context.tools ?? []).toEqual([]);
					expect(transport.context.systemPrompt).toContain("Independently decide");
					const prompt = transport.context.messages[0];
					expect(prompt?.role).toBe("user");
					if (prompt?.role !== "user" || typeof prompt.content !== "string")
						throw new Error("Consult evidence is missing");
					expect(JSON.parse(prompt.content)).toMatchObject({ request, answer: initial, previousContinuations: 0 });
					world.systemOne.enterPhase(
						"ordinary-stop-delivered",
						{
							disposition: { kind: "choice", choice: "fulfilled", confidence: 0.99 },
							delivered_in_answer: { kind: "noul", probability: 0.99 },
							evidence_sufficient: { kind: "noul", probability: 0.99 },
						},
						{ expect: (judgment) => expect(judgment.state).toMatchObject({ request, answer: final }) },
					);
					consultReached.release();
				},
			});
			world.provider.enqueue("root", {
				...text("ordinary-final-stop", final),
				check: () => expect(rows()[0]).toMatchObject({ status: "active", continuationCount: 1 }),
			});
		}
		const turn = session.prompt(request);
		if (enabled) {
			await withDeadline(
				world.trace,
				"ordinary stop reaches Jev while the foreground remains owned",
				reviewReached.promise,
			);
			expect(session.getForegroundActivity().busy).toBe(true);
			expect(rows()[0]).toMatchObject({ reason: "stop_review_in_progress", continuationCount: 0 });
			assertNoOtherWork();
			releaseReview.release();
			await withDeadline(world.trace, "ordinary stop reaches its independent model", consultReached.promise);
			expect(session.getForegroundActivity().busy).toBe(true);
			expect(rows()[0]).toMatchObject({ continuationCount: 0 });
			assertNoOtherWork();
			releaseConsult.release();
		}
		await withDeadline(world.trace, "ordinary owner prompt and its continuation finish", turn);
		await withDeadline(world.trace, "ordinary stop releases foreground ownership", session.waitForForegroundIdle());
		expect(session.getForegroundActivity().busy).toBe(false);
		expect(session.isStreaming).toBe(false);
		assertNoOtherWork();
		expect(delivered).toEqual(enabled ? [initial, final] : [initial]);
		const requests = world.provider.requests.slice(providerMark);
		expect(requests.filter((entry) => entry.model.id === "root")).toHaveLength(enabled ? 2 : 1);
		expect(requests.filter((entry) => entry.model.id === "worker-c")).toHaveLength(enabled ? 1 : 0);
		expect(requests).toHaveLength(enabled ? 3 : 1);
		expect(rows()).toHaveLength(1);
		expect(rows()[0]).toMatchObject({
			status: enabled ? "fulfilled" : "unverified",
			continuationCount: enabled ? 1 : 0,
		});
		const beforeStatus = rows()[0];
		const status = await session.autonomyStatus();
		expect(status.ordinaryWork).toEqual({
			status: "available",
			value: {
				state: enabled ? "fulfilled" : "unverified",
				reason: enabled ? "fulfilled" : "judge_unavailable",
				continuationsUsed: enabled ? 1 : 0,
				continuationLimit: 3,
			},
		});
		expect(JSON.stringify(status.ordinaryWork)).not.toContain(request);
		expect(rows()[0]).toEqual(beforeStatus);
		const entries = sessionManager.getBranch();
		expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
		expect(
			entries.filter(
				(entry) => entry.type === "custom_message" && entry.customType === ORDINARY_WORK_CONTINUATION_TYPE,
			),
		).toHaveLength(enabled ? 1 : 0);
		expect(world.systemOne.decoded.slice(judgmentMark)).toHaveLength(enabled ? 2 : 0);
		expect(world.systemOne.unrelatedOrdinaryStops).toHaveLength(fallbackMark);
	} finally {
		releaseReview.release();
		releaseConsult.release();
		unsubscribe();
		expect(await world.disposeSessionInBody(session)).toBeUndefined();
	}
}
