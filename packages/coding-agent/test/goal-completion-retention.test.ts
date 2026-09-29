import { compactRetainedDetails } from "@caupulican/pi-agent-core/message-retention";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { applyGoalEvent, createGoalState, isGoalEvent } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot, getLatestGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { TypeSafeEvidenceStore } from "../src/core/review/typesafe-evidence-store.ts";
import { createGoalLifecycleToolDefinitions, createGoalToolDefinition } from "../src/core/tools/goal.ts";
import { tempDir } from "./temp-dir.ts";

describe("completion refusal retention recovery", () => {
	it("rejects malformed retention metadata without accepting forged pointers", () => {
		const valid = {
			type: "completion_rejected",
			fingerprint: "fixture",
			reasons: ["Check failed"],
			findings: [{ id: "check", reason: "Check failed", required_next_proof: "Rerun" }],
			findingsOmitted: 0,
			evidence: { id: "a".repeat(24), sha256: "b".repeat(64), bytes: 20 },
			now: "T0",
		};
		expect(isGoalEvent(valid)).toBe(true);
		for (const patch of [
			{ findingsOmitted: -1 },
			{ findingsOmitted: 0.5 },
			{ evidence: { ...valid.evidence, id: "forged" } },
			{ evidence: { ...valid.evidence, bytes: -1 } },
			{ findings: [{ id: "check", reason: "failed", required_next_proof: "x".repeat(1001) }] },
			{ evidenceUnavailable: "x".repeat(501) },
		])
			expect(isGoalEvent({ ...valid, ...patch })).toBe(false);
	});
	it.each(["small", "large", "outage"])("keeps rejection recoverable after reopen with retention=%s", async (mode) => {
		const oversized = mode === "large";
		const cwd = tempDir("pi-completion-retention-");
		const sessionManager = SessionManager.create(cwd, cwd);
		// SessionManager commits its deferred initial entries after the first assistant turn.
		sessionManager.appendMessage(fauxAssistantMessage("Work started."));
		let initial = createGoalState({ goalId: "goal", userGoal: "Fix the regression", now: "T0" });
		if (oversized) {
			for (let index = 0; index < 20; index++)
				initial = applyGoalEvent(initial, {
					type: "add_evidence",
					id: `e-${index}`,
					kind: "finding",
					summary: "bounded source context ".repeat(100),
					now: "T0",
				});
		}
		appendGoalStateSnapshot(sessionManager, initial);
		const reason = "src/parser.ts accepts stale revisions; reproduce old completion after a new request.";
		const nextProof = "Run parser.test.ts stale-completion regression and current-revision control.";
		const archive = TypeSafeEvidenceStore.file(cwd, "judgment");
		const gates = oversized
			? Array.from({ length: 20 }, (_, index) => ({
					id: `JEV-${index}-${"identity".repeat(30)}`,
					reason,
					required_next_proof: `${nextProof}${"precise additional instruction ".repeat(100)}`,
				}))
			: [{ id: "JEV-hidden_assumption", reason, required_next_proof: nextProof }];
		const tool = createGoalToolDefinition({
			retainCompletionEvidence: (id, decision) => {
				if (mode === "outage") throw new Error("fixture disk unavailable");
				return archive.save(id, { completionDecision: decision });
			},
			getGoalState: () => getLatestGoalStateSnapshot(sessionManager),
			saveGoalState: (state) =>
				appendGoalStateSnapshot(sessionManager, state, getLatestGoalStateSnapshot(sessionManager)),
			requireVerifiedEvidenceForCompletion: () => false,
			getSystemOneController: () => ({
				completionView: () => ({ view: { candidate: "current" }, repositoryOutcome: true }),
				executeCompletionTransaction: async () => ({
					verdict: "verify_more",
					failed_gates: gates,
					warnings: [],
				}),
			}),
		});
		const refusal = await tool.execute(
			"complete",
			{ action: "complete" },
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		);
		expect(refusal).toMatchObject({ isError: true, errorKind: "operation_outcome" });
		const visible = JSON.stringify(refusal.content);
		expect(visible).toContain(reason);
		expect(visible).toContain(nextProof);
		const holder: { details: unknown } = { details: refusal.details };
		compactRetainedDetails(holder);
		if (oversized) expect(holder.details).toMatchObject({ piToolResultDetailsTruncated: true });
		else expect(holder.details).toMatchObject({ state: { status: "active" } });
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session");
		const restored = getLatestGoalStateSnapshot(SessionManager.open(sessionFile, cwd));
		expect(restored).toMatchObject({ status: "active", lastCompletionRejection: { count: 1 } });
		expect(restored?.lastCompletionRejection?.reasons).toContain(reason);
		expect(restored?.lastCompletionRejection?.fingerprint).toMatch(/^[a-f0-9]{16}$/);
		const resumed = createGoalToolDefinition({
			getGoalState: () => restored,
			saveGoalState: () => {
				throw new Error("Read only fixture");
			},
		});
		const getGoal = createGoalLifecycleToolDefinitions(resumed)[1];
		const status = await getGoal.execute(
			"get-restored",
			{},
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		);
		expect(JSON.stringify(status.content)).toContain(oversized ? "JEV-0-" : "JEV-hidden_assumption");
		expect(JSON.stringify(status.content)).toContain(nextProof);
		if (mode === "outage") {
			expect(JSON.stringify(status.content)).toContain("fixture disk unavailable");
			expect(restored?.lastCompletionRejection?.evidence).toBeUndefined();
		} else {
			const ref = restored?.lastCompletionRejection?.evidence;
			if (!ref) throw new Error("Missing retained original judgment");
			const reopened = TypeSafeEvidenceStore.file(cwd, "judgment");
			let offset = 0;
			let original = "";
			for (;;) {
				const page = reopened.read(ref.id, offset);
				original += page.text;
				if (page.nextOffset === undefined) break;
				offset = page.nextOffset;
			}
			expect(JSON.parse(original).record.completionDecision.failed_gates).toEqual(gates);
			if (oversized) {
				expect(restored?.lastCompletionRejection?.findingsOmitted).toBe(8);
				expect(restored?.lastCompletionRejection?.findings?.[0].truncated).toBe(true);
				expect(JSON.stringify(status.content)).toContain("8 additional findings omitted");
			}
		}
	});
});
