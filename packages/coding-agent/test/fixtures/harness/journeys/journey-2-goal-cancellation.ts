import { expect } from "vitest";
import { cancelPersistedGoal } from "../../../../src/core/goals/goal-lifecycle.ts";
import { createGoalState } from "../../../../src/core/goals/goal-state.ts";
import { applyGoalAction } from "../../../../src/core/goals/goal-tool-core.ts";
import { text } from "../scripted-provider.ts";
import { type HarnessWorld, type ScriptedJudgment, withDeadline } from "../session-fixture.ts";

/** Cancellation must dominate an earlier requirement's recovery advice in a fresh idle pass. */
export async function verifyGoalCancellation(
	world: HarnessWorld,
	judgments: {
		active: Readonly<Record<string, ScriptedJudgment>>;
		replacement: Readonly<Record<string, ScriptedJudgment>>;
	},
): Promise<void> {
	const label = "goal-cancellation-after-requirement-recovery";
	const agentDir = `${world.agentDir}-${label}`;
	const manager = world.createSessionManager(agentDir);
	const { session } = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		settings: { memorySystem: "okf", autoLearn: { enabled: false } },
	});
	const extensionErrors: string[] = [];
	const failures: unknown[] = [];
	try {
		await session.bindExtensions({
			uiContext: world.humanInput.ui,
			onError: (error) => extensionErrors.push(error.error),
		});
		const now = new Date().toISOString();
		session.saveGoalStateSnapshot(
			createGoalState({ goalId: `${label}-a`, userGoal: "Inspect the first source boundary.", now }),
		);
		const added = applyGoalAction(
			session.getGoalStateSnapshot(),
			{
				action: "add_requirement",
				requirementId: `${label}-requirement`,
				text: "Inspect the source boundary before selecting the next approach.",
			},
			now,
		);
		if (!added.ok) throw new Error(added.error);
		session.saveGoalStateSnapshot(added.state);
		for (let index = 0; index < 3; index++) {
			if (index > 0) {
				const reopened = applyGoalAction(
					session.getGoalStateSnapshot(),
					{
						action: "reopen_requirement",
						requirementId: `${label}-requirement`,
					},
					now,
				);
				if (!reopened.ok) throw new Error(reopened.error);
				session.saveGoalStateSnapshot(reopened.state);
			}
			const blocked = applyGoalAction(
				session.getGoalStateSnapshot(),
				{
					action: "block_requirement",
					requirementId: `${label}-requirement`,
					reason: "The source premise needs another approach.",
				},
				now,
			);
			if (!blocked.ok) throw new Error(blocked.error);
			session.saveGoalStateSnapshot(blocked.state);
		}
		const activeSnapshot = session.getGoalRuntimeSnapshot({ maxStallTurns: 3 });
		world.systemOne.enterPhase(`${label}-active-control`, judgments.active);
		const activeRequests = world.provider.requests.length;
		world.provider.enqueue("root", text(`${label}-active-control`, "The first boundary remains under inspection."));
		const active = await withDeadline(
			world.trace,
			`${label}: active recovery`,
			session.continueGoalOnce({ maxStallTurns: 3 }),
		);
		await withDeadline(world.trace, `${label}: active recovery releases foreground`, session.waitForForegroundIdle());
		const activeAfter = session.getGoalStateSnapshot();
		const activeProviderCount = world.provider.requests.length - activeRequests;
		const cancelled = cancelPersistedGoal(session, now);
		if (!cancelled.ok) throw new Error(cancelled.error);
		const cancelledBefore = session.getGoalStateSnapshot();
		const cancelledSnapshot = session.getGoalRuntimeSnapshot({ maxStallTurns: 3 });
		const beforeRequests = world.provider.requests.length;
		const beforeEntries = manager.getBranch().length;
		// The provider's normal response includes usage. If cancellation refuses this response,
		// B consumes that same FIFO entry; forbidden execution cannot hide as missing I/O.
		const answer = "The current source boundary remains under inspection.";
		world.provider.enqueue("root", text(`${label}-potential-response`, answer));
		world.systemOne.enterPhase(`${label}-cancelled-attempt`, {});
		let attempt: Awaited<ReturnType<typeof session.continueGoalOnce>> | undefined;
		let attemptError: string | undefined;
		try {
			attempt = await withDeadline(
				world.trace,
				`${label}: fresh cancelled continuation`,
				session.continueGoalOnce({ maxStallTurns: 3 }),
			);
		} catch (error) {
			attemptError = String(error);
		}
		await withDeadline(world.trace, `${label}: cancelled attempt settles`, session.waitForForegroundIdle());
		const cancelledAfter = session.getGoalStateSnapshot();
		const cancelledRequests = world.provider.requests.slice(beforeRequests);
		const cancelledMessages = manager
			.getBranch()
			.slice(beforeEntries)
			.filter((entry) => entry.type === "message");
		const started = applyGoalAction(
			cancelledAfter,
			{
				action: "start",
				goalId: `${label}-b`,
				userGoal: "Inspect the second source boundary.",
			},
			now,
		);
		if (!started.ok) throw new Error(started.error);
		session.saveGoalStateSnapshot(started.state);
		world.systemOne.enterPhase(`${label}-b-control`, judgments.replacement);
		if (cancelledRequests.length > 0) world.provider.enqueue("root", text(`${label}-b-response`, answer));
		const bRequests = world.provider.requests.length;
		const bEntries = manager.getBranch().length;
		const b = await withDeadline(
			world.trace,
			`${label}: normal B continuation`,
			session.continueGoalOnce({ maxStallTurns: 3 }),
		);
		await withDeadline(world.trace, `${label}: B foreground released`, session.waitForForegroundIdle());
		const observations = JSON.stringify({
			systemOneEnabled: world.systemOne.enabled,
			executionLoopMode: session.executionLoopMode,
			activeSnapshot,
			active,
			activeAfter,
			activeProviderCount,
			cancelledBefore,
			cancelledSnapshot,
			attempt,
			attemptError,
			cancelledAfter,
			cancelledProviderRequests: cancelledRequests.length,
			cancelledMessages,
			b,
			bAfter: session.getGoalStateSnapshot(),
			bProviderRequests: world.provider.requests.length - bRequests,
		});
		expect(activeSnapshot.continuation, observations).toMatchObject({
			action: "continue",
			reasonCode: "stall_limit_reached",
		});
		expect(active.submitted, observations).toBe(true);
		expect(activeProviderCount, observations).toBe(1);
		expect(activeAfter?.status, observations).toBe("active");
		expect(
			cancelledBefore?.requirements.find((requirement) => requirement.id === `${label}-requirement`)?.status,
			observations,
		).toBe("blocked");
		expect(
			cancelledBefore?.events.filter(
				(event) => event.type === "block_requirement" && event.id === `${label}-requirement`,
			),
			observations,
		).toHaveLength(3);
		expect(cancelledSnapshot.continuation, observations).toMatchObject({
			action: "stop",
			reasonCode: "goal_cancelled",
		});
		expect(attempt?.submitted, observations).toBe(false);
		expect(attemptError, observations).toBeUndefined();
		expect(cancelledRequests, observations).toEqual([]);
		expect(cancelledMessages, observations).toEqual([]);
		expect(cancelledAfter, observations).toEqual(cancelledBefore);
		expect(b.submitted, observations).toBe(true);
		expect(extensionErrors, observations).toEqual([]);
		expect(world.provider.requests.length - bRequests, observations).toBe(1);
		expect(session.getGoalStateSnapshot(), observations).toMatchObject({ goalId: `${label}-b`, status: "active" });
		expect(
			manager
				.getBranch()
				.slice(bEntries)
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.content.some((part) => part.type === "text" && part.text === answer),
				),
			observations,
		).toHaveLength(1);
	} catch (error) {
		failures.push(error);
	} finally {
		try {
			expect(await world.disposeSessionInBody(session), `${label}: no retained work`).toBeUndefined();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, `${label}: invariant and cleanup failures`);
	world.trace.mark("root", label);
}
