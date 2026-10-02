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
	it.each(["status", "evidence", "uncertainties", "resolve_uncertainty"])(
		"allows advisory management and evidence inspection during an outage: %s",
		async (action) => {
			const judge = vi.fn<VerificationJudge>().mockRejectedValue(new Error("temporary transport outage"));
			const { coordinator } = fixture(judge);
			const before = coordinator.status();
			await expect(
				coordinator.checkOperation({ tool: "systemone", args: { action }, cwd: "/repo" }),
			).resolves.toBeUndefined();
			expect(judge).not.toHaveBeenCalled();
			expect(coordinator.status()).toEqual(before);
			expect(() => coordinator.assertResolved()).toThrow("same_lane_verification_required");
			expect(coordinator.beginCall("root-lane", "systemone")).toBeUndefined();
		},
	);

	it.each(["evaluate", "review", "resolve", undefined])(
		"keeps fresh judgments and unknown actions subject to pending verification: %s",
		async (action) => {
			const judge = vi.fn<VerificationJudge>().mockRejectedValue(new Error("temporary transport outage"));
			const { coordinator } = fixture(judge);
			await expect(
				coordinator.checkOperation({ tool: "systemone", args: { action }, cwd: "/repo" }),
			).rejects.toThrow("temporary transport outage");
			expect(judge).toHaveBeenCalledOnce();
			expect(coordinator.status().obligations).toHaveLength(1);
		},
	);

	it.each(["ask_question", "self_compact", "typesafe_review"])(
		"does not hold a tool that neither changes the candidate nor advances the work, even in an outage: %s",
		async (tool) => {
			const judge = vi.fn<VerificationJudge>().mockRejectedValue(new Error("temporary transport outage"));
			const { coordinator } = fixture(judge);
			await expect(coordinator.checkOperation({ tool, args: {}, cwd: "/repo" })).resolves.toBeUndefined();
			expect(judge).not.toHaveBeenCalled();
			// Negative control: the same outage still holds work that can advance the candidate.
			for (const advancing of ["edit", "write", "bash", "delegate"])
				await expect(coordinator.checkOperation({ tool: advancing, args: {}, cwd: "/repo" })).rejects.toThrow(
					"temporary transport outage",
				);
			expect(() => coordinator.assertResolved()).toThrow("same_lane_verification_required");
		},
	);

	it("omits an absent wrapper receiver from the System One classification payload", async () => {
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

	it("keeps the System One serializer strict for explicitly malformed evidence", () => {
		expect(() => serializeEvaluation({ operation: { receiverId: undefined } })).toThrow(
			"System One evidence must be finite, acyclic JSON",
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

	it("admits read-only recovery effects and workspace registration without admitting arbitrary shell or lifecycle effects", async () => {
		const judge = vi.fn<VerificationJudge>().mockResolvedValue({
			id: "jev-uncertain",
			answers: { verification_operation_safe: { noul: 0.2 } },
		});
		const { coordinator } = fixture(judge);
		await expect(
			coordinator.checkOperation({
				tool: "bash",
				args: { command: "jq '.messages | length' transcript.json" },
				cwd: "/repo",
			}),
		).resolves.toBeUndefined();
		await expect(
			coordinator.checkOperation({
				tool: "task_directory",
				args: { action: "register", workspaceId: "grimdex", path: "/work/GrimDex" },
				cwd: "/repo",
			}),
		).resolves.toBeUndefined();
		await expect(
			coordinator.checkOperation({ tool: "peer", args: { action: "obligations" }, cwd: "/repo" }),
		).resolves.toBeUndefined();
		await expect(
			coordinator.checkOperation({ tool: "skill", args: { action: "search", query: "GrimDex" }, cwd: "/repo" }),
		).resolves.toBeUndefined();
		expect(judge).not.toHaveBeenCalled();

		await expect(
			coordinator.checkOperation({ tool: "bash", args: { command: "touch output.txt" }, cwd: "/repo" }),
		).rejects.toThrow("judgment_confidence_below_threshold");
		await expect(
			coordinator.checkOperation({ tool: "task_directory", args: { action: "forget", taskId: "1" }, cwd: "/repo" }),
		).rejects.toThrow("judgment_confidence_below_threshold");
		await expect(
			coordinator.checkOperation({ tool: "peer", args: { action: "review" }, cwd: "/repo" }),
		).rejects.toThrow("judgment_confidence_below_threshold");
		expect(judge).toHaveBeenCalledTimes(3);
	});

	it.each([
		"git diff --output=artifact.patch",
		"git diff --output artifact.patch",
		"git diff -o artifact.patch",
		"awk 'BEGIN {system(\"echo changed>artifact.txt\")}'",
		"sed '1e echo changed>artifact.txt' input.txt",
		"LC_ALL=C awk 'BEGIN {system(\"echo changed>artifact.txt\")} '",
		"sort -oartifact.txt input.txt",
		"uniq input.txt artifact.txt",
		"rg --pre ./rewrite-cache pattern .",
		"tsc --noEmit --incremental",
		"file -C",
		"git grep --open-files-in-pager=./rewrite-cache pattern",
		"fd --exec ./rewrite-cache .",
		"tree -oartifact.txt .",
		"sort --compress-program=./rewrite-cache input.txt",
		"date -s20000101",
		"hostname new-name",
	])(
		"requires semantic recovery judgment for shell effects the parser cannot prove observational: %s",
		async (command) => {
			const judge = vi.fn<VerificationJudge>().mockResolvedValue({
				id: "jev-uncertain",
				answers: { verification_operation_safe: { noul: 0.2 } },
			});
			const { coordinator } = fixture(judge);
			await expect(coordinator.checkOperation({ tool: "bash", args: { command }, cwd: "/repo" })).rejects.toThrow(
				"judgment_confidence_below_threshold",
			);
			expect(judge).toHaveBeenCalledOnce();
			expect(coordinator.status().obligations).toHaveLength(1);
		},
	);

	it("keeps simple observational shell commands available and holds mutation", async () => {
		const judge = vi.fn<VerificationJudge>().mockResolvedValue({
			id: "jev-uncertain",
			answers: { verification_operation_safe: { noul: 0.2 } },
		});
		const { coordinator } = fixture(judge);
		for (const command of [
			"git diff --stat",
			"sort input.txt",
			"uniq input.txt",
			"rg pattern .",
			"file input.txt",
			"git grep pattern",
			"fd pattern .",
			"tree .",
			"date",
			"hostname",
		]) {
			await expect(
				coordinator.checkOperation({ tool: "bash", args: { command }, cwd: "/repo" }),
			).resolves.toBeUndefined();
		}
		await expect(
			coordinator.checkOperation({ tool: "bash", args: { command: "touch artifact.txt" }, cwd: "/repo" }),
		).rejects.toThrow("judgment_confidence_below_threshold");
		expect(judge).toHaveBeenCalledOnce();
		expect(coordinator.status().obligations).toHaveLength(1);
	});

	it.each(["get", "add_evidence", "satisfy_requirement", "reopen_requirement"])(
		"keeps canonical goal evidence and requirement recovery available during a judge outage: %s",
		async (action) => {
			const judge = vi.fn<VerificationJudge>().mockRejectedValue(new Error("temporary transport outage"));
			const { coordinator } = fixture(judge);
			await expect(
				coordinator.checkOperation({ tool: "goal", args: { action }, cwd: "/repo" }),
			).resolves.toBeUndefined();
			expect(judge).not.toHaveBeenCalled();
			expect(coordinator.status().obligations).toHaveLength(1);
		},
	);

	it("keeps the native goal getter available without an optional read-only declaration", async () => {
		const judge = vi.fn<VerificationJudge>().mockRejectedValue(new Error("temporary transport outage"));
		const { coordinator } = fixture(judge);
		await expect(coordinator.checkOperation({ tool: "get_goal", args: {}, cwd: "/repo" })).resolves.toBeUndefined();
		expect(judge).not.toHaveBeenCalled();
		expect(coordinator.status().obligations).toHaveLength(1);
		await expect(
			coordinator.checkOperation({ tool: "create_goal", args: { objective: "Other work" }, cwd: "/repo" }),
		).rejects.toThrow("temporary transport outage");
		expect(judge).toHaveBeenCalledOnce();
	});

	it("keeps unrelated goal progress behind the semantic recovery judgment", async () => {
		const judge = vi.fn<VerificationJudge>().mockResolvedValue({
			id: "jev-uncertain",
			answers: { verification_operation_safe: { noul: 0.2 } },
		});
		const { coordinator } = fixture(judge);
		await expect(
			coordinator.checkOperation({ tool: "goal", args: { action: "add_requirement" }, cwd: "/repo" }),
		).rejects.toThrow("judgment_confidence_below_threshold");
		expect(judge).toHaveBeenCalledOnce();
		expect(coordinator.status().obligations).toHaveLength(1);
	});

	it("honors wrapped tool effect metadata and records only an admitted read-only receipt", async () => {
		const judge = vi.fn<VerificationJudge>().mockRejectedValue(new Error("temporary transport outage"));
		const { coordinator } = fixture(judge);
		const parameters = Type.Object({ value: Type.String() });
		const readOnlyExecute = vi.fn<AgentTool<typeof parameters>["execute"]>(async () => ({
			content: [{ type: "text", text: "observed" }],
			details: {},
		}));
		const readOnlyTool = wrapToolWithVerification(
			{
				name: "custom_observer",
				label: "Custom observer",
				description: "Observe state",
				parameters,
				readOnly: true,
				execute: readOnlyExecute,
			},
			() => coordinator,
			() => "/repo",
		);
		await expect(readOnlyTool.execute("read-call", { value: "x" }, undefined)).resolves.toMatchObject({
			content: [{ type: "text", text: "observed" }],
		});
		expect(judge).not.toHaveBeenCalled();
		expect(readOnlyExecute).toHaveBeenCalledOnce();
		expect(coordinator.status().receipts).toMatchObject([{ tool: "custom_observer", succeeded: true }]);

		const mutatingExecute = vi.fn<AgentTool<typeof parameters>["execute"]>(async () => ({
			content: [{ type: "text", text: "mutated" }],
			details: {},
		}));
		const mutatingTool = wrapToolWithVerification(
			{
				name: "custom_mutator",
				label: "Custom mutator",
				description: "Change state",
				parameters,
				readOnly: false,
				execute: mutatingExecute,
			},
			() => coordinator,
			() => "/repo",
		);
		await expect(mutatingTool.execute("write-call", { value: "x" }, undefined)).rejects.toThrow(
			"temporary transport outage",
		);
		expect(mutatingExecute).not.toHaveBeenCalled();
		expect(judge).toHaveBeenCalledOnce();
		expect(coordinator.status().receipts).toHaveLength(1);
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

	it.each([
		{ noul: 0.1, reason: "judgment_confidence_below_threshold (0.10 < 0.95)" },
		{ noul: 0.94, reason: "judgment_confidence_below_threshold (0.94 < 0.95)" },
		{ noul: Number.NaN, reason: "judgment_probability_missing_or_invalid" },
	])("holds affected progress and explains the operation judgment cause: $reason", async ({ noul, reason }) => {
		const { coordinator } = fixture(async () => ({
			id: "jev-doubt",
			answers: { verification_operation_safe: { noul } },
		}));
		await expect(
			coordinator.checkOperation({ tool: "bash", args: { command: "publish artifact" }, cwd: "/repo" }),
		).rejects.toThrow(reason);
		expect(coordinator.status().obligations).toHaveLength(1);
	});

	it("identifies candidate drift separately from a low or missing judgment", async () => {
		const { coordinator, setCandidate } = fixture(async () => {
			setCandidate("candidate-v2");
			return accepted;
		});
		await expect(
			coordinator.checkOperation({ tool: "bash", args: { command: "publish artifact" }, cwd: "/repo" }),
		).rejects.toThrow("verification_candidate_changed_during_classification");
	});

	it("keeps a rejected finding held and gives finding-specific remediation until fresh evidence resolves it", async () => {
		const judge = vi
			.fn<VerificationJudge>()
			.mockResolvedValueOnce({
				id: "jev-inconclusive",
				answers: {
					verification_resolution_valid: { noul: 0.83 },
					reproduction_addresses_finding: { choice: "addresses", confidence: 0.99 },
					reproduction_refutes_finding: { choice: "does_not_refute", confidence: 0.99 },
				},
			})
			.mockResolvedValueOnce({
				...accepted,
				answers: {
					...accepted.answers,
					reproduction_addresses_finding: { choice: "addresses", confidence: 0.99 },
					reproduction_refutes_finding: { choice: "refutes", confidence: 0.99 },
				},
			});
		const { coordinator, proof } = fixture(judge);
		const request = proof();
		const result = await coordinator.resolve(request);
		expect(result).toMatchObject({
			status: "unresolved",
			reason: "judgment_confidence_below_threshold",
			confidence: 0.83,
			remediation: {
				finding: {
					reason: "Suspected input loss; check the original input against the saved output.",
					scope: "/repo",
				},
				currentCandidate: { id: "candidate-v1", scope: "/repo", kind: "repository" },
				disposition: "rejected",
				proofNeeded: "direct counter-evidence for this finding on the current candidate",
				requiredEvidence: { reproduction: "exactly one current-candidate reproduction" },
				missingProof: [
					expect.objectContaining({
						condition: "reproduction_refutes_finding",
						receiptId: request.evidence[0]!.receiptId,
						tool: "read",
						finding: "Suspected input loss; check the original input against the saved output.",
						judgment: "does_not_refute",
					}),
				],
				nextAction: expect.stringContaining("directly refutes this finding on the current candidate"),
			},
		});
		expect(() => coordinator.assertResolved()).toThrow("same_lane_verification_required");

		const callId = coordinator.beginCall("root-lane", "read");
		coordinator.finishCall({
			callId,
			tool: "read",
			args: { path: "saved.json" },
			output: "Fresh comparison: every original input value is present in the saved output.",
			succeeded: true,
		});
		const freshReceipt = coordinator.status().receipts.at(-1)!;
		expect(
			await coordinator.resolve({
				...request,
				evidence: [{ receiptId: freshReceipt.id, role: "reproduction" }],
			}),
		).toMatchObject({ status: "resolved" });
		expect(() => coordinator.assertResolved()).not.toThrow();
	});

	it("does not make optional proof diagnostics an additional acceptance gate", async () => {
		const { coordinator, proof } = fixture(async () => accepted);
		const result = await coordinator.resolve(proof());
		expect(result).toMatchObject({ status: "resolved" });
		expect(coordinator.status().obligations).toEqual([]);
	});

	it("gives repaired findings a repair-chain and final-recheck remediation", async () => {
		const judge = vi.fn<VerificationJudge>().mockResolvedValue({
			id: "jev-inconclusive",
			answers: {
				verification_resolution_valid: { noul: 0.83 },
				reproduction_addresses_finding: { choice: "addresses", confidence: 0.99 },
				repair_addresses_cause: { choice: "does_not_address_cause", confidence: 0.99 },
				recheck_covers_required_behavior: { choice: "does_not_cover_required_behavior", confidence: 0.99 },
			},
		});
		const { coordinator, setCandidate } = fixture(judge);
		const record = (tool: string, output: string, candidateAfter?: string) => {
			const callId = coordinator.beginCall("root-lane", tool);
			if (candidateAfter) setCandidate(candidateAfter);
			coordinator.finishCall({
				callId,
				tool,
				args: { path: "saved.json" },
				output,
				succeeded: true,
			});
			return coordinator.status().receipts.at(-1)!;
		};
		const reproduction = record("read", "Original input is missing the final field in saved output.");
		const repair = record("write", "Restored the missing field in saved output.", "candidate-v2");
		const recheck = record("read", "Fresh comparison confirms the final field is present.");
		const result = await coordinator.resolve({
			id: coordinator.status().obligations[0]!.id,
			disposition: "repaired",
			evidence: [
				{ receiptId: reproduction.id, role: "reproduction" },
				{ receiptId: repair.id, role: "repair" },
				{ receiptId: recheck.id, role: "recheck" },
			],
		});
		expect(result).toMatchObject({
			status: "unresolved",
			reason: "judgment_confidence_below_threshold",
			remediation: {
				proofNeeded: "reproduction, causal repair, and a successful current-candidate recheck",
				disposition: "repaired",
				currentCandidate: { id: "candidate-v2", scope: "/repo", kind: "repository" },
				requiredEvidence: {
					reproduction: "exactly one current-candidate reproduction",
					repair: "one or more causal repairs in order",
					recheck: "exactly one successful recheck after the final repair",
				},
				missingProof: [
					expect.objectContaining({
						condition: "repair_addresses_cause",
						receiptId: repair.id,
						tool: "write",
						finding: "Suspected input loss; check the original input against the saved output.",
						judgment: "does_not_address_cause",
					}),
					expect.objectContaining({
						condition: "recheck_covers_required_behavior",
						receiptId: recheck.id,
						tool: "read",
						finding: "Suspected input loss; check the original input against the saved output.",
						judgment: "does_not_cover_required_behavior",
					}),
				],
				nextAction: expect.stringContaining("repairs its cause on the candidate"),
			},
		});
		expect(JSON.stringify(result)).not.toContain("Original input is missing");
		expect(coordinator.status().obligations).toHaveLength(1);
	});

	it.each([undefined, Number.NaN])(
		"preserves a missing or invalid resolution judgment cause and retries the same proof: %s",
		async (noul) => {
			const judge = vi
				.fn<VerificationJudge>()
				.mockResolvedValueOnce({
					id: "jev-invalid-resolution",
					answers: noul === undefined ? {} : { verification_resolution_valid: { noul } },
				})
				.mockResolvedValueOnce(accepted);
			const { coordinator, proof } = fixture(judge);
			const request = proof();
			const result = await coordinator.resolve(request);
			expect(result).toMatchObject({
				status: "unresolved",
				reason: "judgment_probability_missing_or_invalid",
				nextAction: expect.stringContaining("Keep the finding pending"),
			});
			expect(result).not.toHaveProperty("confidence");
			expect(coordinator.status().obligations).toHaveLength(1);
			expect(await coordinator.resolve(request)).toMatchObject({ status: "resolved" });
			expect(judge).toHaveBeenCalledTimes(2);
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
