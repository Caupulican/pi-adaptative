/**
 * Composed integration journeys for the adaptive harness.
 *
 * Each journey runs twice (System One enabled and System One disabled) through its real production owners
 * and shared state. Phase implementations live under `./fixtures/harness/journeys/` so this file remains
 * the sole Vitest entry point and phases cannot be executed in isolation.
 */

import "./fixtures/harness/builtin-install.ts";
import { describe, it } from "vitest";
import { JOURNEY_1_BUDGET_MS, runJourney1 } from "./fixtures/harness/journeys/journey-1.ts";
import { runJourney2 } from "./fixtures/harness/journeys/journey-2.ts";
import { runJourney3 } from "./fixtures/harness/journeys/journey-3.ts";
import { runJourney4 } from "./fixtures/harness/journeys/journey-4.ts";
import { runJourney5 } from "./fixtures/harness/journeys/journey-5.ts";
import { runJourney6 } from "./fixtures/harness/journeys/journey-6.ts";
import { runJourney7 } from "./fixtures/harness/journeys/journey-7.ts";

describe("Adaptive harness composed journeys", () => {
	it(
		"standalone root conversation: greeting, task with tools and memory, compaction, queued input, continuation",
		async () => {
			await runJourney1();
		},
		JOURNEY_1_BUDGET_MS + 15_000,
	);

	it("orchestration: goal, three delegated agents, blocked report, follow-up reply, goal completion", async () => {
		await runJourney2();
	}, 360_000);

	it("mixed: a root lane and a worker lane in separate worktrees, a real conflict, explicit resolution, integration, owner edits kept", async () => {
		await runJourney3();
	}, 360_000);

	it("orchestration gate: the root orchestrates, a refused edit and build are delegated, a worker does them and its handoff wakes the root", async () => {
		await runJourney4();
	}, 360_000);

	it("plans: a root plan runs parallel steps, joins their results, verifies, and holds on a rejected check", async () => {
		await runJourney5();
	}, 360_000);

	it("plan lanes: steps that change files work in their own worktree lanes and a merge join lands them on main in order", async () => {
		await runJourney6();
	}, 360_000);

	it("bots and leaders: a root creates and asks a bot, the owner writes to a bot and a group, a leader runs a subtree", async () => {
		await runJourney7();
	}, 360_000);
});
