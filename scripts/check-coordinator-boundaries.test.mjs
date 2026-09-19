import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	checkCoordinatorBoundaries,
	COORDINATOR_MAX_LINES,
} from "./check-coordinator-boundaries.mjs";

test("coordinator ceiling is 8000 and boundary enforcement catches line count & forbidden markers", () => {
	assert.equal(COORDINATOR_MAX_LINES, 8_000);

	const root = mkdtempSync(join(tmpdir(), "pi-boundary-test-"));
	try {
		mkdirSync(join(root, "pkg"), { recursive: true });
		const file = join(root, "pkg/coordinator.ts");

		// 1. Fixture with exactly 8,000 lines and required marker -> PASS
		const lines8000 = [
			'// required: from "./agent-session-contracts.ts"',
			...Array.from({ length: 7999 }, (_, i) => `const x${i} = ${i};`),
		].join("\n");
		writeFileSync(file, lines8000, "utf8");

		const boundaries = [
			{
				path: "pkg/coordinator.ts",
				required: ['from "./agent-session-contracts.ts"'],
				forbidden: ["new GoalLoopController("],
			},
		];

		const passResult = checkCoordinatorBoundaries({
			root,
			boundaries,
			maxLines: 8_000,
			skipGoalStatusScan: true,
		});
		assert.equal(passResult.failures.length, 0, `Expected 8000 lines to pass, got: ${passResult.failures.join(", ")}`);

		// 2. Fixture with 8,001 lines -> FAIL
		const lines8001 = lines8000 + "\nconst overflow = 8001;";
		writeFileSync(file, lines8001, "utf8");

		const fail8001Result = checkCoordinatorBoundaries({
			root,
			boundaries,
			maxLines: 8_000,
			skipGoalStatusScan: true,
		});
		assert.equal(fail8001Result.failures.length, 1);
		assert.match(fail8001Result.failures[0], /8001 lines exceeds coordinator ceiling 8000/);

		// 3. Fixture with forbidden marker regardless of line count (e.g. 10 lines) -> FAIL
		const forbiddenLines = [
			'// required: from "./agent-session-contracts.ts"',
			"const x = new GoalLoopController();",
		].join("\n");
		writeFileSync(file, forbiddenLines, "utf8");

		const forbiddenResult = checkCoordinatorBoundaries({
			root,
			boundaries,
			maxLines: 8_000,
			skipGoalStatusScan: true,
		});
		assert.equal(forbiddenResult.failures.length, 1);
		assert.match(forbiddenResult.failures[0], /reclaimed extracted responsibility "new GoalLoopController\("/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
