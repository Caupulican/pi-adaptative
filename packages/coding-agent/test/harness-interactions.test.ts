/**
 * Composed integration journeys for the adaptive harness.
 *
 * Each journey runs twice (System One enabled and System One disabled) through its real production owners
 * and shared state. Phase implementations live under `./fixtures/harness/journeys/` so this file remains
 * the sole Vitest entry point and phases cannot be executed in isolation.
 */

import "./fixtures/harness/builtin-install.ts";
import { describe, it } from "vitest";
import { runJourney1 } from "./fixtures/harness/journeys/journey-1.ts";
import { runJourney2 } from "./fixtures/harness/journeys/journey-2.ts";
import { runJourney3 } from "./fixtures/harness/journeys/journey-3.ts";

describe("Adaptive harness composed journeys", () => {
	it("standalone root conversation: greeting, task with tools and memory, compaction, queued input, continuation", async () => {
		await runJourney1();
	}, 300_000);

	it("orchestration: goal, three delegated agents, blocked report, follow-up reply, goal completion", async () => {
		await runJourney2();
	}, 360_000);

	it("mixed: a root lane and a worker lane in separate worktrees, a real conflict, explicit resolution, integration, owner edits kept", async () => {
		await runJourney3();
	}, 360_000);
});
