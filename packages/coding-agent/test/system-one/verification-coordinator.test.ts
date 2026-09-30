import type { AgentTool } from "@caupulican/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { serializeEvaluation } from "../../src/core/review/typesafe-contract.ts";
import { wrapToolWithVerification } from "../../src/core/system-one/session-verification-host.ts";
import { VerificationCoordinator, type VerificationJudge } from "../../src/core/system-one/verification-coordinator.ts";
import type { SemanticVerificationSnapshot } from "../../src/core/system-one/verification-obligations.ts";

function fixture(judge: VerificationJudge) {
	let candidate = "candidate-v1";
	let branch = "session-a";
	const records = new Map<string, SemanticVerificationSnapshot>();
	const coordinator = new VerificationCoordinator(
		{
			storage: {
				getBranchKey: () => branch,
				readRecords: (key) => records.get(key),
				appendRecord: (key, record) => records.set(key, structuredClone(record)),
			},
			getReceiverId: () => "root-lane",
			getCandidate: () => ({ id: candidate, scope: "/repo", kind: "repository" }),
			captureFence: () => {
				const original = branch;
				return () => branch === original;
			},
		},
		judge,
	);
	coordinator.require("peer_review", ["Suspected input loss; check the original input against the saved output."]);
	return {
		coordinator,
		setCandidate: (id: string) => {
			candidate = id;
		},
		setBranch: (id: string) => {
			branch = id;
		},
		proof: () => {
			const callId = coordinator.beginCall("root-lane", "read");
			coordinator.finishCall({
				callId,
				tool: "read",
				args: { path: "saved.json" },
				output: "PASS: every input value survived",
				succeeded: true,
			});
			const status = coordinator.status();
			return {
				id: status.obligations[0].id,
				disposition: "rejected" as const,
				evidence: [{ receiptId: status.receipts[0].id, role: "reproduction" as const }],
			};
		},
	};
}

const accepted = {
	id: "jev-proof",
	answers: { verification_resolution_valid: { noul: 0.99 }, verification_operation_safe: { noul: 0.99 } },
};

describe("mandatory verification coordination", () => {
	it("omits an absent wrapper receiver from the TypeSafe classification payload", async () => {
		const judge = vi.fn<VerificationJudge>(async (state) => {
			serializeEvaluation(state);
			return accepted;
		});
		const { coordinator } = fixture(judge);
		const parameters = Type.Object({ command: Type.String() });
		const tool = wrapToolWithVerification(
			{
				name: "bash",
				label: "Bash",
				description: "Run a command",
				parameters,
				execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
			},
			() => coordinator,
			() => "/repo",
		);

		await expect(tool.execute("call", { command: "check" }, undefined)).resolves.toMatchObject({
			content: [{ type: "text", text: "done" }],
		});
		expect(judge).toHaveBeenCalledOnce();
		expect(judge.mock.calls[0][0]).toMatchObject({ operation: { tool: "bash", args: { command: "check" } } });
		expect((judge.mock.calls[0][0] as { operation: Record<string, unknown> }).operation).not.toHaveProperty(
			"receiverId",
		);
	});

	it("keeps the TypeSafe serializer strict for explicitly malformed evidence", () => {
		expect(() => serializeEvaluation({ operation: { receiverId: undefined } })).toThrow(
			"TypeSafe evidence must be finite, acyclic JSON",
		);
	});

	it("keeps findings during an outage, allows reads, and retries the same proof when the judge recovers", async () => {
		const judge = vi.fn<VerificationJudge>().mockRejectedValue(new Error("temporary transport outage"));
		const { coordinator, proof } = fixture(judge);
		const request = proof();
		await expect(
			coordinator.checkOperation({ tool: "read", args: { path: "saved.json" }, cwd: "/repo" }),
		).resolves.toBeUndefined();
		expect(judge).not.toHaveBeenCalled();
		await expect(
			coordinator.checkOperation({ tool: "bash", args: { command: "check saved.json" }, cwd: "/repo" }),
		).rejects.toThrow("temporary transport outage");
		expect(await coordinator.resolve(request)).toMatchObject({
			status: "unavailable",
			reason: "temporary transport outage",
		});
		expect(coordinator.status().obligations).toHaveLength(1);
		judge.mockResolvedValue(accepted);
		await expect(
			coordinator.checkOperation({ tool: "bash", args: { command: "check saved.json" }, cwd: "/repo" }),
		).resolves.toBeUndefined();
		expect(await coordinator.resolve(request)).toMatchObject({ status: "resolved" });
		expect(coordinator.status().obligations).toEqual([]);
	});

	it("forwards bounded proof remediation without sending receipt contents", async () => {
		const judge = vi.fn<VerificationJudge>().mockResolvedValue(accepted);
		const { coordinator, proof } = fixture(judge);
		const reproduction = proof();
		const callId = coordinator.beginCall("root-lane", "read");
		coordinator.finishCall({
			callId,
			tool: "read",
			args: { path: "focused-check.log" },
			output: "bounded check output",
			succeeded: true,
		});
		const recheck = coordinator.status().receipts[1]!;
		const result = await coordinator.resolve({
			...reproduction,
			evidence: [reproduction.evidence[0]!, { receiptId: recheck.id, role: "recheck" }],
		});

		expect(result).toMatchObject({
			status: "unresolved",
			reason: "unexpected_repair_receipts",
			remediation: {
				requiredEvidence: { reproduction: "exactly one", repair: "none", recheck: "none" },
				offendingReceipts: [{ receiptId: recheck.id, role: "recheck", truncated: false }],
				nextAction: expect.stringContaining("keep only the single reproduction receipt"),
			},
		});
		expect(JSON.stringify(result)).not.toContain("bounded check output");
		expect(judge).not.toHaveBeenCalled();
		expect(coordinator.status().obligations).toHaveLength(1);
	});

	it("refuses same-checkout push independently of a favorable operation judge", async () => {
		const judge = vi.fn<VerificationJudge>().mockResolvedValue(accepted);
		const { coordinator } = fixture(judge);
		await expect(
			coordinator.checkOperation({ tool: "bash", args: { command: "git push origin main" }, cwd: "/repo" }),
		).rejects.toThrow("same_lane_verification_required");
		expect(judge).not.toHaveBeenCalled();
		await expect(
			coordinator.checkOperation({
				tool: "bash",
				args: { command: "git -C /other push origin main" },
				cwd: "/repo",
			}),
		).resolves.toBeUndefined();
		expect(judge).toHaveBeenCalledOnce();
		expect(coordinator.status().obligations).toHaveLength(1);
	});

	it.each([0.1, 0.94, Number.NaN])(
		"holds affected progress on an invalid or nonpassing probability %s",
		async (noul) => {
			const { coordinator } = fixture(async () => ({
				id: "jev-doubt",
				answers: { verification_operation_safe: { noul } },
			}));
			await expect(
				coordinator.checkOperation({ tool: "bash", args: { command: "publish artifact" }, cwd: "/repo" }),
			).rejects.toThrow("same_lane_verification_required");
			expect(coordinator.status().obligations).toHaveLength(1);
		},
	);

	it.each(["candidate", "branch", "cancel"] as const)("rejects a late resolution after %s changes", async (kind) => {
		let release!: (value: typeof accepted) => void;
		const pending = new Promise<typeof accepted>((resolve) => {
			release = resolve;
		});
		const { coordinator, proof, setCandidate, setBranch } = fixture(() => pending);
		const request = proof();
		const abort = new AbortController();
		const resolution = coordinator.resolve(request, undefined, abort.signal);
		if (kind === "candidate") setCandidate("candidate-v2");
		if (kind === "branch") setBranch("session-b");
		if (kind === "cancel") abort.abort(new Error("cancelled verification"));
		release(accepted);
		if (kind === "cancel") await expect(resolution).rejects.toThrow("cancelled verification");
		else expect(await resolution).toMatchObject({ status: "unresolved" });
		if (kind === "branch") setBranch("session-a");
		expect(coordinator.status().obligations).toHaveLength(1);
	});

	it("executes the arguments it classified and records the actual failed tool terminal", async () => {
		let release!: (value: typeof accepted) => void;
		const pending = new Promise<typeof accepted>((resolve) => {
			release = resolve;
		});
		const judge = vi.fn<VerificationJudge>(() => pending);
		const { coordinator } = fixture(judge);
		const parameters = Type.Object({ command: Type.String() });
		const execute = vi.fn<AgentTool<typeof parameters>["execute"]>(async (_id, args) => ({
			content: [{ type: "text", text: args.command }],
			details: {},
			isError: true,
		}));
		const tool = wrapToolWithVerification(
			{ name: "bash", label: "Bash", description: "Run a command", parameters, execute },
			() => coordinator,
			() => "/repo",
		);
		const args = { command: "reproduce input" };
		const result = tool.execute("raw-terminal", args, undefined);
		args.command = "publish artifact";
		release(accepted);
		expect((await result).isError).toBe(true);
		expect(execute.mock.calls[0][1]).toEqual({ command: "reproduce input" });
		expect(coordinator.status().receipts).toMatchObject([{ succeeded: false, tool: "bash" }]);
	});

	it("fences peer findings when the reviewed candidate changes", () => {
		const { coordinator, setCandidate } = fixture(async () => accepted);
		const fence = coordinator.captureReviewFence();
		expect(fence).not.toThrow();
		setCandidate("candidate-v2");
		expect(fence).toThrow("review is stale");
	});

	it.each(["worker", "root"])(
		"separates overlapping root and worker provider call IDs when %s finishes first",
		async (first) => {
			const { coordinator } = fixture(async () => accepted);
			const parameters = Type.Object({ command: Type.String() });
			type Result = Awaited<ReturnType<AgentTool<typeof parameters>["execute"]>>;
			const finishers = new Map<string, (result: Result) => void>();
			const execute: AgentTool<typeof parameters>["execute"] = async (_id, args) =>
				new Promise<Result>((resolve) => {
					finishers.set(args.command, resolve);
				});
			const base = { name: "read", label: "Read", description: "Read evidence", parameters, execute };
			const worker = wrapToolWithVerification(
				base,
				() => coordinator,
				() => "/repo",
				"worker-lane",
			);
			const root = wrapToolWithVerification(
				base,
				() => coordinator,
				() => "/repo",
				"root-lane",
			);
			const workerRun = worker.execute("shared-provider-id", { command: "worker" }, undefined);
			const rootRun = root.execute("shared-provider-id", { command: "root" }, undefined);
			await Promise.resolve();
			const second = first === "worker" ? "root" : "worker";
			finishers.get(first)!({ content: [{ type: "text", text: `${first} evidence` }], details: {} });
			await (first === "worker" ? workerRun : rootRun);
			finishers.get(second)!({ content: [{ type: "text", text: `${second} evidence` }], details: {} });
			await (second === "worker" ? workerRun : rootRun);
			const receipts = coordinator.status().receipts;
			expect(receipts).toHaveLength(2);
			expect(receipts.find((item) => item.receiverId === "root-lane")?.output).toContain("root evidence");
			expect(receipts.find((item) => item.receiverId === "worker-lane")?.output).toContain("worker evidence");
		},
	);
});
