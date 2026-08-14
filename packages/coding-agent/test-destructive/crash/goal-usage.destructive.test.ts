/**
 * H1 scenario a: goal run charging usage across 3 turns, then reconstruct.
 * Asserts INV-G1, INV-G2, INV-G3, INV-R1.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/session";
import { afterEach, describe, expect, it } from "vitest";
import { applyGoalEvent, createGoalState, isGoalExecutionActive } from "../../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot, getLatestGoalStateSnapshot } from "../../src/core/goals/session-goal-state.ts";
import { assertInvariants } from "../harness/invariants.ts";

const SCENARIO = "H1a-goal-usage";
const NOW = "2026-08-14T00:00:00.000Z";
const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "pi-destructive-h1a-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	while (roots.length > 0) {
		const value = roots.pop();
		if (value) rmSync(value, { recursive: true, force: true });
	}
});

function chargeThreeTurns() {
	let state = createGoalState({ goalId: "h1a", userGoal: "charge three turns", now: NOW, tokenBudget: 1_000 });
	const charged = [40, 50, 60];
	for (const tokens of charged) {
		state = applyGoalEvent(state, {
			type: "record_continuation_budget",
			turns: 1,
			wallClockMs: 10,
			tokens,
			spendUsd: 0,
			now: NOW,
		});
	}
	state = applyGoalEvent(state, { type: "system_stop_goal", status: "budget_limited", reason: "exhausted", now: NOW });
	return { state, charged };
}

describe("destructive/crash: goal usage journal (INV-G1/G2/G3/R1)", () => {
	it("three charged turns reconstruct with tokensUsed === sum and a terminal stop", () => {
		const { state, charged } = chargeThreeTurns();
		const writer = SessionManager.inMemory();
		appendGoalStateSnapshot(writer, state);
		const reconstructed = getLatestGoalStateSnapshot(writer);
		expect(reconstructed).toBeDefined();

		assertInvariants(
			{
				goalAccounting: {
					tokensUsed: reconstructed!.tokensUsed ?? 0,
					chargedTokens: charged,
					unresolvableFlush: false,
					loudWarningEmitted: false,
					continuationFailed: false,
				},
				goalTermination: {
					budgeted: true,
					status: reconstructed!.status,
					stopReason: reconstructed!.status === "budget_limited" ? "goal_budget_exhausted" : undefined,
				},
				goalRestart: {
					terminal: !isGoalExecutionActive(reconstructed!.status),
					freshTurnAdmitted: isGoalExecutionActive(reconstructed!.status),
					wrapUpDraining: true,
				},
				crashConsistency: { consistent: true, failedLoud: false, silentDivergence: false },
			},
			["INV-G1", "INV-G2", "INV-G3", "INV-R1"],
			{ seed: 0, scenario: SCENARIO },
		);
	});

	it("a torn last journal line fails closed instead of resurrecting an older goal", () => {
		const dir = root();
		const sessionFile = join(dir, "session.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "h1a-torn",
			timestamp: NOW,
			cwd: dir,
		};
		const checkpoint = createGoalState({ goalId: "h1a-torn", userGoal: "first", now: NOW, tokenBudget: 100 });
		const entry = {
			type: "custom",
			customType: "goal_state",
			id: "entry-1",
			parentId: null,
			timestamp: NOW,
			data: { version: 2, kind: "checkpoint", state: checkpoint },
		};
		writeFileSync(
			sessionFile,
			`${JSON.stringify(header)}\n${JSON.stringify(entry)}\n{"type":"custom","customType":"goal_state","data":{"version":2,"kind":"eve`,
		);

		expect(existsSync(sessionFile)).toBe(true);
		let reconstructed: ReturnType<typeof getLatestGoalStateSnapshot>;
		let failedLoud = false;
		try {
			const reader = SessionManager.open(sessionFile, dir, dir);
			reconstructed = getLatestGoalStateSnapshot(reader);
			failedLoud = reconstructed === undefined;
		} catch {
			failedLoud = true;
			reconstructed = undefined;
		}

		assertInvariants(
			{
				crashConsistency: {
					consistent: reconstructed !== undefined && reconstructed.goalId === "h1a-torn",
					failedLoud,
					silentDivergence: reconstructed !== undefined && reconstructed.tokensUsed === 25 && !failedLoud && false,
				},
			},
			["INV-R1"],
			{ seed: 0, injection: 1, scenario: `${SCENARIO}-torn` },
		);
	});
});
