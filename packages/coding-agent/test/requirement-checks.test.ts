import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applyGoalEvent, createGoalState, type GoalState } from "../src/core/goals/goal-state.ts";
import { describeRequirementCheckRefusal, proveRequirementChecks } from "../src/core/goals/prove-requirement-checks.ts";
import {
	judgeRequirementCheck,
	requirementCheckViolation,
	runRequirementCheck,
} from "../src/core/goals/requirement-checks.ts";
import { projectCanonicalTruth } from "../src/core/system-one/canonical-truth.ts";

const cwd = mkdtempSync(join(tmpdir(), "pi-requirement-checks-"));
mkdirSync(join(cwd, "present"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

function goalWith(requirements: Array<{ id: string; text: string; command?: string; satisfied?: boolean }>): GoalState {
	const now = "2026-09-25T10:00:00.000Z";
	let goal = createGoalState({ goalId: "goal-checks", userGoal: "Remove the local model server.", now });
	for (const requirement of requirements) {
		goal = applyGoalEvent(goal, {
			type: "add_requirement",
			id: requirement.id,
			text: requirement.text,
			...(requirement.command ? { check: { command: requirement.command } } : {}),
			now,
		});
		if (requirement.satisfied) {
			goal = applyGoalEvent(goal, {
				type: "add_evidence",
				id: `ev-${requirement.id}`,
				kind: "tool",
				summary: "the agent says it is done",
				verified: true,
				now,
			});
			goal = applyGoalEvent(goal, {
				type: "satisfy_requirement",
				id: requirement.id,
				evidenceIds: [`ev-${requirement.id}`],
				now,
			});
		}
	}
	return goal;
}

describe("requirement checks", () => {
	it("admits only observational commands", () => {
		expect(requirementCheckViolation({ command: "test ! -e ~/.ollama" }, cwd)).toBeUndefined();
		expect(requirementCheckViolation({ command: "ss -ltn | grep -c 11434" }, cwd)).toBeUndefined();
		expect(requirementCheckViolation({ command: "rm -rf ~/.ollama" }, cwd)).toMatch(/may only observe/u);
		expect(requirementCheckViolation({ command: "   " }, cwd)).toBe("A check needs a command.");
	});

	it("judges exit code and output expectations in one sentence", () => {
		expect(judgeRequirementCheck({ command: "x" }, 0, "")).toEqual({
			passed: true,
			reason: "`x` exited 0 as expected.",
		});
		expect(judgeRequirementCheck({ command: "x", expectExitCode: 1 }, 0, "").passed).toBe(false);
		expect(judgeRequirementCheck({ command: "x", outputContains: "ok" }, 0, "not it").reason).toBe(
			'`x` output does not contain "ok".',
		);
		expect(judgeRequirementCheck({ command: "x", outputExcludes: "11434" }, 0, "LISTEN 11434").reason).toBe(
			'`x` output still contains "11434".',
		);
	});

	it("runs a real check in its directory, and a check that cannot finish is a failure, never a pass", async () => {
		await expect(runRequirementCheck({ command: "test -d present" }, { cwd })).resolves.toMatchObject({
			passed: true,
			exitCode: 0,
		});
		await expect(runRequirementCheck({ command: "test -d absent" }, { cwd })).resolves.toMatchObject({
			passed: false,
			exitCode: 1,
		});
		const slow = await runRequirementCheck({ command: "tail -f /dev/null" }, { cwd, timeoutMs: 200 });
		expect(slow).toMatchObject({ passed: false, exitCode: null });
		expect(slow.reason).toMatch(/did not finish within 200 ms/u);
		// A command that would change something never runs.
		await expect(runRequirementCheck({ command: "rm -rf present" }, { cwd })).resolves.toMatchObject({
			passed: false,
			exitCode: null,
		});
	});

	it("records every result as host-verified check evidence, satisfying or reopening the requirement", async () => {
		const goal = goalWith([
			{ id: "r-server", text: "Server binary is gone", command: "test ! -e present" },
			{ id: "r-models", text: "Models are deleted", command: "test ! -e absent", satisfied: false },
			{ id: "r-note", text: "Tell the owner what was removed" },
		]);
		const saved: GoalState[] = [];
		const proof = await proveRequirementChecks({
			state: applyGoalEvent(goal, {
				type: "satisfy_requirement",
				id: "r-server",
				evidenceIds: [],
				now: "2026-09-25T10:00:01.000Z",
			}),
			runCheck: (check) => runRequirementCheck(check, { cwd }),
			now: () => "2026-09-25T10:05:00.000Z",
			save: (state) => saved.push(state),
			requireVerifiedEvidenceForCompletion: true,
		});
		expect(saved).toHaveLength(1);
		expect(proof.checked).toBe(2);
		// `present` exists, so the server check fails and reopens the requirement the agent marked done.
		expect(proof.failures.map((failure) => failure.requirementId)).toEqual(["r-server"]);
		const requirement = (id: string) => proof.state.requirements.find((entry) => entry.id === id);
		expect(requirement("r-server")?.status).toBe("open");
		expect(requirement("r-models")?.status).toBe("satisfied");
		expect(requirement("r-note")?.status).toBe("open");
		const checks = proof.state.evidence.filter((evidence) => evidence.kind === "check");
		expect(checks.map((evidence) => [evidence.uri, evidence.outcome, evidence.verified])).toEqual([
			["r-server", "failed", true],
			["r-models", "succeeded", true],
		]);
		expect(describeRequirementCheckRefusal(proof)).toBe(
			[
				"Completion refused: 1 of 2 requirement check(s) failed.",
				"- r-server (Server binary is gone): `test ! -e present` exited 1, expected 0.",
				"Fix the outcome, then complete again; the harness reruns every check.",
			].join("\n"),
		);
		// The verification matrix System One sees is the truth: each check covers its criterion.
		const truth = projectCanonicalTruth({ goal: proof.state, currentRevision: "rev" });
		expect(truth.verification.filter((run) => run.id.startsWith("VR-check-"))).toEqual([
			expect.objectContaining({ id: "VR-check-r-server", status: "failed", covers_acceptance_ids: ["r-server"] }),
			expect.objectContaining({ id: "VR-check-r-models", status: "passed", covers_acceptance_ids: ["r-models"] }),
		]);
	});

	it("refuses to prove checks it cannot run, instead of skipping them", async () => {
		const proof = await proveRequirementChecks({
			state: goalWith([{ id: "r1", text: "Port closed", command: "ss -ltn" }]),
			runCheck: undefined,
			now: () => "2026-09-25T10:05:00.000Z",
			save: () => {
				throw new Error("nothing is recorded when nothing ran");
			},
			requireVerifiedEvidenceForCompletion: true,
		});
		expect(describeRequirementCheckRefusal(proof)).toBe(
			"Completion refused: requirement check(s) for r1 cannot run in this session, so they cannot be proven.",
		);
	});
});
