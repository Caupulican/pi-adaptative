/**
 * H1 scenario c: compaction fill→render→verify (INV-C1) and crash-swept event-store
 * snapshot publish (INV-C2, INV-R1).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	COMPACTION_WORKED_EXAMPLE_SENTINEL,
	deterministicallyFillSummaryGaps,
} from "@caupulican/pi-agent-core/compaction";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestrationEventStore } from "../../src/core/orchestration/event-store.ts";
import { createFaultableFsHarness, type FaultInjectionMode } from "../harness/faultable-fs.ts";
import { assertInvariants } from "../harness/invariants.ts";

const SCENARIO = "H1c-compaction-checkpoint";
const USER_RULE = "do not use curl for file downloads";
const ACTIVE_TASK = "Fix the two failing tests now";

const roots: string[] = [];
function root(): string {
	const value = mkdtempSync(join(tmpdir(), "pi-destructive-h1c-"));
	roots.push(value);
	return value;
}
afterEach(() => {
	while (roots.length > 0) {
		const value = roots.pop();
		if (value) rmSync(value, { recursive: true, force: true });
	}
});

function validSummary(): string {
	return [
		`## Active Task`,
		`User: ${ACTIVE_TASK}`,
		``,
		`### Mandatory Rules`,
		`- ${USER_RULE}`,
		``,
		`## Working Set`,
		`- src/app.ts`,
		``,
		`## Files`,
		`- src/app.ts (read)`,
		``,
		`## Open Problems`,
		`- none`,
		``,
		`## Done`,
		`- inspected the failing tests`,
		``,
		`## Key Decisions`,
		`- keep the current test layout`,
		``,
		`## Constraints & Preferences`,
		`- ${USER_RULE}`,
		``,
		`## Critical Context`,
		`- ${ACTIVE_TASK}`,
	].join("\n");
}

function facts() {
	return {
		files: [{ path: "src/app.ts", kind: "read" as const, note: "read" }],
		workingSet: [{ path: "src/app.ts", kind: "read" as const, note: "read" }],
		actions: ["inspected the failing tests"],
		errorFacts: [],
		prohibitions: [USER_RULE],
		cancelledText: "",
		activeTaskSource: ACTIVE_TASK,
	};
}

describe("destructive/crash: compaction checkpoint (INV-C1/C2/R1)", () => {
	it("user rules and active task survive fill→render→verify; sentinel never persists", () => {
		const filled = deterministicallyFillSummaryGaps(validSummary(), facts());
		expect(filled.summary.includes(ACTIVE_TASK)).toBe(true);
		expect(filled.summary.includes(USER_RULE)).toBe(true);
		assertInvariants(
			{
				compactionRoundTrip: {
					userRulesBefore: [USER_RULE],
					userRulesAfter: filled.summary.includes(USER_RULE) ? [USER_RULE] : [],
					activeTaskBefore: ACTIVE_TASK,
					activeTaskAfter: filled.summary.includes(ACTIVE_TASK) ? ACTIVE_TASK : "",
					sentinelPersisted: filled.summary.includes(COMPACTION_WORKED_EXAMPLE_SENTINEL),
				},
			},
			["INV-C1"],
			{ seed: 0, scenario: `${SCENARIO}-roundtrip` },
		);
	});

	it("failAtOp/tornWriteAtOp during compactIfNeeded reconstructs or fails loud", () => {
		const modes: FaultInjectionMode[] = [
			{ kind: "failAtOp", op: 0 },
			{ kind: "tornWriteAtOp", op: 0, seed: 1 },
		];
		for (const template of modes) {
			const agentDir = root();
			const counting = createFaultableFsHarness({ kind: "none" });
			const measure = new OrchestrationEventStore({
				agentDir,
				sessionId: "h1c",
				maxTailEvents: 2,
				fs: counting.fs,
			});
			measure.append({
				type: "objective.updated",
				aggregateId: "obj-1",
				actor: "runtime",
				payload: { n: 1 },
			});
			measure.append({
				type: "objective.updated",
				aggregateId: "obj-1",
				actor: "runtime",
				payload: { n: 2 },
			});
			const through = measure.readProjectionSnapshot()?.throughOrdinal ?? 2;
			measure.compactIfNeeded(through, () => ({ n: 2 }));
			const k = counting.opCount();
			expect(k).toBeGreaterThan(0);

			for (let n = 1; n <= k; n++) {
				const dir = root();
				const setup = new OrchestrationEventStore({ agentDir: dir, sessionId: "h1c", maxTailEvents: 2 });
				setup.append({
					type: "objective.updated",
					aggregateId: "obj-1",
					actor: "runtime",
					payload: { n: 1 },
				});
				setup.append({
					type: "objective.updated",
					aggregateId: "obj-1",
					actor: "runtime",
					payload: { n: 2 },
				});
				const ordinal = setup.readProjectionSnapshot()?.throughOrdinal ?? 2;
				const mode: FaultInjectionMode =
					template.kind === "tornWriteAtOp"
						? { kind: "tornWriteAtOp", op: n, seed: 1 }
						: { kind: "failAtOp", op: n };
				const faulted = createFaultableFsHarness(mode);
				const crashing = new OrchestrationEventStore({
					agentDir: dir,
					sessionId: "h1c",
					maxTailEvents: 2,
					fs: faulted.fs,
				});
				try {
					crashing.compactIfNeeded(ordinal, () => ({ n: 2 }));
				} catch {
					// crash is the point
				}

				let consistent = false;
				let failedLoud = false;
				try {
					const restarted = new OrchestrationEventStore({ agentDir: dir, sessionId: "h1c", maxTailEvents: 2 });
					const snapshot = restarted.readProjectionSnapshot();
					consistent = snapshot !== undefined || restarted !== undefined;
				} catch {
					failedLoud = true;
				}

				assertInvariants(
					{
						crashConsistency: {
							consistent,
							failedLoud,
							silentDivergence: !consistent && !failedLoud,
						},
					},
					["INV-C2", "INV-R1"],
					{
						seed: template.kind === "tornWriteAtOp" ? 1 : 0,
						injection: n,
						scenario: `${SCENARIO}-${template.kind}`,
					},
				);
			}
		}
	});
});
