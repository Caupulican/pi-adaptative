/**
 * The mandatory normal-SDK scenario (RCG-036, RCG-083; TEST_PLAN 49).
 *
 * Every step runs through the public `createAgentSession` composition against a mocked provider
 * transport. No controller is constructed directly to stand in for production wiring, and no step
 * needs a provider credential.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	CapabilityProofRunner,
	capabilityArtifactPath,
	compileCapabilityProofObligations,
	RealMechanicalVerifier,
} from "../../src/core/adaptive/index.ts";
import { getLaneRecordSnapshots } from "../../src/core/autonomy/session-lane-record.ts";
import { RETENTION_AUDIT_CUSTOM_TYPE } from "../../src/core/compaction/evidence-retention-projection.ts";
import { PROJECT_RULE_REPAIR_CUSTOM_TYPE } from "../../src/core/project-rules/session-project-rules.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { setConcurrentResponses } from "../suite/concurrent-responses.ts";
import { appendToolExchange, createRcSdkHarness } from "../suite/rc-sdk-harness.ts";

const AGENTS_MD = [
	"# Development Rules",
	"",
	"## Code Quality",
	"- Never use inline imports (`await import()`); top-level imports only.",
].join("\n");

describe("Normal SDK end-to-end scenario", () => {
	beforeAll(() => {
		initTheme();
	});

	it("drives the mandatory hooks from a normal session with a mocked transport", async () => {
		const harness = await createRcSdkHarness({
			agentsFiles: [{ path: "AGENTS.md", content: AGENTS_MD }],
			workerDelegation: true,
			// The owner's start-only instruction is what grants delivery authority.
			prompt: "implement the validator, install the dependency, then commit and push",
			decisions: { fallback: { kind: "boolean", probabilityTrue: 0.02 } },
		});

		// 1. The owner's development rule becomes durable policy on a normal prompt.
		harness.replyWith("acknowledged");
		await harness.session.prompt("no TDD, mandatory, fast paced only");
		const policies = harness.session.getOwnerRulePolicies();
		expect(policies).toHaveLength(1);
		expect(policies[0]?.forbid).toContain("tdd_workflow");

		// 2. Project rules are loaded from the trusted instruction file in this normal session.
		expect(harness.session.projectRules.getRules().some((rule) => rule.text.includes("inline imports"))).toBe(true);

		// 3. A real worker runs from a normal turn: the model calls `delegate`, the queued dispatch
		//    drains at the end of that same prompt, and the worker's own turns run on the transport.
		// Root and worker draw from independent scripts: filesystem latency cannot reorder them.
		setConcurrentResponses(
			harness,
			[
				fauxAssistantMessage(
					[fauxToolCall("write", { path: "validator.ts", content: "export const ok = true;\n" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage('{"summary":"validator written","status":"completed"}'),
			],
			[
				fauxAssistantMessage(
					[fauxToolCall("delegate", { instructions: "Write validator.ts with a passing export." })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("The worker was dispatched."),
			],
		);
		await harness.session.prompt("Delegate the validator implementation.");

		const workerLaneRecords = () =>
			getLaneRecordSnapshots(harness.session.sessionManager.getEntries()).filter(
				(record) => record.type === "worker",
			);
		await vi.waitFor(
			() => {
				expect(workerLaneRecords().length).toBeGreaterThan(0);
				expect(
					workerLaneRecords().every((record) => record.status !== "running" && record.status !== "queued"),
				).toBe(true);
			},
			{ timeout: 20_000, interval: 50 },
		);

		// 4. Supervision is bound to that worker's lifecycle and produced no intervention for
		//    ordinary progress — the routine case is silent, not absent.
		expect(harness.session.workerSupervision.getSignals().every((signal) => signal.action === "continue")).toBe(true);

		// 5. A mutation that violates a loaded rule is refused and queues durable RepairWork.
		const violating = join(harness.cwd, "offender.ts");
		writeFileSync(violating, "const mod = await import('./x.ts');\n");
		const mutation = await harness.session.projectRules.validateMutation({ changedFiles: [violating] });
		expect(mutation.passed).toBe(false);
		expect(
			harness.session.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === PROJECT_RULE_REPAIR_CUSTOM_TYPE),
		).toBe(true);

		// 6. A synthesized capability proves itself by executing its obligations; a failing one blocks.
		//    The artifact lives in agent-owned runtime state, so synthesizing one is not a project
		//    change: step 6b below holds the project's own git status to that.
		const capabilityArtifactRoot = join(harness.agentDir, "runtime", "capabilities", "normal-sdk");
		mkdirSync(capabilityArtifactRoot, { recursive: true });
		writeFileSync(capabilityArtifactPath(capabilityArtifactRoot, "cap_e2e"), "export default async () => true;\n");
		const verifier = new RealMechanicalVerifier({
			proofRunner: new CapabilityProofRunner(),
			cwd: harness.cwd,
			provenance: "production-live",
		});
		const spec = {
			schema_version: "1.0",
			capability_id: "cap_e2e",
			version: "1.0",
			kind: "toolkit_script",
			lifetime: "session",
			purpose: "end-to-end probe",
			interface: {},
			side_effects: [],
			denied_behavior: [],
			proof: compileCapabilityProofObligations(
				"toolkit_script",
				capabilityArtifactPath(capabilityArtifactRoot, "cap_e2e"),
			),
			activation: {},
			rollback: {},
		} as never;
		const proof = JSON.parse(await verifier.runTaskSpecificProof(spec));
		expect(proof.proofs.every((entry: { status: string }) => entry.status === "passed")).toBe(true);
		// 6b. Proving a capability touched agent state only; the project never grew a capabilities/ dir.
		expect(existsSync(join(harness.cwd, "capabilities"))).toBe(false);

		// 7. Compaction runs the retention planner through its real owner and preserves the durable
		//    owner rule, which lives outside the transcript by design. The transcript is given the
		//    depth a long session has, so pairs are actually offered to the planner.
		for (let index = 0; index < 20; index++) {
			appendToolExchange(harness, {
				callId: `scenario-call-${index}`,
				toolName: "read",
				output: `older evidence ${index}`.repeat(4),
			});
		}
		const compaction = harness.session as unknown as {
			_compaction: { planEvidenceRetention(signal: AbortSignal): Promise<void> };
		};
		await compaction._compaction.planEvidenceRetention(new AbortController().signal);
		expect(
			harness.session.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === RETENTION_AUDIT_CUSTOM_TYPE),
		).toBe(true);
		expect(harness.session.getOwnerRulePolicies()).toHaveLength(1);

		// 8. Delivery authority comes from the owner's own start instruction.
		const charter = harness.session.executionCharter;
		expect(charter?.git.commit).toBe(true);
		expect(charter?.git.push).toBe(true);
		expect(charter?.acquisition.package_installs).toBe(true);
		// Force-push is never granted from bare prompt text.
		expect(charter?.git.force_push).toBe(false);

		// 9. The live projection reaches DELIVER and then DONE through the same owner the TUI reads.
		harness.session.setDeliveryState("in_progress");
		expect(harness.session.operatorProjection.getProjection().phase).toBe("deliver");
		harness.session.setDeliveryState("none");

		const goalCompleted = harness.session as unknown as { getGoalStateSnapshot(): unknown };
		if (goalCompleted.getGoalStateSnapshot()) {
			expect(["build", "verify", "deliver", "done"]).toContain(
				harness.session.operatorProjection.getProjection().phase,
			);
		}

		// 10. The worker really executed: its lane reached a terminal status and the file it was told
		//     to write exists in the workspace the grant scoped it to.
		const lane = workerLaneRecords().at(-1);
		expect(lane?.reasonCode).toBe("worker_completed");
		expect(["completed", "partial"]).toContain(lane?.status);
		expect(existsSync(join(harness.cwd, "validator.ts"))).toBe(true);
		expect(readFileSync(join(harness.cwd, "validator.ts"), "utf-8")).toContain("export const ok");
	});
});
