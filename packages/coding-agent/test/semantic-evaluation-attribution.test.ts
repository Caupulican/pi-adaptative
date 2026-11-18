import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmptyUsage } from "@caupulican/pi-ai";
import { expect, it, vi } from "vitest";
import { SystemOneObserverError, type SystemOneReceipt } from "../src/core/review/system-one-review-port.ts";
import { SessionSemanticPlaneController } from "../src/core/session-semantic-plane-controller.ts";
import { SystemOneSteeringPlane } from "../src/core/steering/system-one-steering-plane.ts";
import { type JevAdapter, SystemOneJevAdapter, type SystemOneReviewerLike } from "../src/core/system-one/adapter.ts";

function receipt(attempt: number): SystemOneReceipt {
	const reportId = `paid-response-${attempt}`;
	return {
		status: "recorded",
		reportId,
		attempt,
		payload: {
			receiptId: reportId,
			provider: "observed-provider",
			model: "billed-model",
			attempt,
			usage: createEmptyUsage(),
			costStatus: "unpriced",
		},
	};
}

function withLedger(
	adapter: JevAdapter,
	run: (plane: SystemOneSteeringPlane, session: SessionSemanticPlaneController) => Promise<void>,
) {
	const dir = mkdtempSync(join(tmpdir(), "pi-semantic-attribution-"));
	const plane = new SystemOneSteeringPlane({ adapter });
	const session = new SessionSemanticPlaneController({
		agentDirForLedger: dir,
		steeringPlane: plane,
		isDisposed: () => false,
		getSystemOneSettings: () => ({ enabled: true }),
		getSessionManager: () => ({ getSessionId: () => "attribution", getCwd: () => dir }),
	});
	return run(plane, session).finally(() => {
		session.closeDecisionLedger();
		rmSync(dir, { recursive: true, force: true });
	});
}

it("joins batched supervision certificates to the same paid attempts and reuses the cached certificates", async () => {
	const evaluate = vi.fn<JevAdapter["evaluate"]>(async ({ questions }) => ({
		model: "returned-version",
		provider: "observed-provider",
		answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul", noul: 0.99 }])),
		latency_ms: 1,
		receipts: [receipt(1), receipt(1), receipt(2)],
	}));
	await withLedger({ evaluate }, async (plane, session) => {
		const requests = ["JEV-WORKER-SUPERVISION", "JEV-002"].map((checkpointId) => ({
			checkpointId,
			state: {},
			objectiveId: "objective",
			taskId: "worker",
		}));
		const results = await plane.evaluateTogether(requests);
		const cached = await plane.evaluateTogether(requests);
		expect(cached).toEqual(results);
		expect(evaluate).toHaveBeenCalledTimes(1);
		session.closeDecisionLedger();
		const rows = session.getDecisionLedger()?.semanticEvaluations("attribution");
		expect(rows).toHaveLength(2);
		for (const result of results) {
			if (result.status === "rejected") throw result.reason;
			const cert = result.value.certificate;
			expect(rows?.find((r) => r.evaluationId === cert.evaluation_id)).toMatchObject({
				certificateId: cert.certificate_id,
				outcome: "ok",
				model: "returned-version",
				provider: "observed-provider",
				usageRefs: [1, 2].map((attempt) => ({
					reportId: `paid-response-${attempt}`,
					attempt,
					provider: "observed-provider",
					model: "billed-model",
				})),
			});
		}
	});
});

it.each(["failed", "cancelled"])("retains a paid response on a %s steering evaluation", async (outcome) => {
	const ctrl = new AbortController();
	const paidError = new SystemOneObserverError("response observer stopped", undefined, [receipt(1)]);
	await withLedger(
		{
			evaluate: async () => {
				if (outcome === "cancelled") ctrl.abort();
				throw paidError;
			},
		},
		async (plane, session) => {
			await expect(plane.evaluate("JEV-WORKER-SUPERVISION", {}, { signal: ctrl.signal })).rejects.toThrow();
			expect(session.getDecisionLedger()?.semanticEvaluations("attribution")).toMatchObject([
				{
					outcome,
					model: "billed-model",
					provider: "observed-provider",
					usageRefs: [{ reportId: "paid-response-1", attempt: 1 }],
				},
			]);
		},
	);
});

it("keeps the paid response from an earlier adapter attempt when a retry answers", async () => {
	const model = "jev-1.13.0";
	const evaluate = vi
		.fn<SystemOneReviewerLike["evaluate"]>()
		.mockRejectedValueOnce(new SystemOneObserverError("network error", undefined, [receipt(1)]))
		.mockResolvedValueOnce({
			request: { model },
			response: { model, answers: {} },
			elapsedMs: 1,
			receipts: [receipt(2)],
		});
	const adapter = new SystemOneJevAdapter({ evaluate }, undefined, {
		getApiKey: () => "fixture-key",
		sleep: async () => {},
	});
	const answer = await adapter.evaluate({ state: {}, questions: {} });
	expect(answer.receipts).toEqual([receipt(1), receipt(2)]);
});
