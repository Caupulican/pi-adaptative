import { describe, expect, it, vi } from "vitest";
import {
	accountOutcome,
	checkCompletionAccount,
	diffForPath,
	patchPaths,
} from "../../src/core/system-one/completion-account.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";

const PATCH = [
	"diff --git a/src/a.ts b/src/a.ts",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@",
	"-old",
	"+new",
	"diff --git a/src/b.ts b/src/b.ts",
	"--- a/src/b.ts",
	"+++ b/src/b.ts",
	"@@",
	"-x",
	"+y",
	"",
].join("\n");

type Reading = "confirmed" | "refuted" | "unsettled";

/** What live System One reads for each claim, by claim index; every other stage passes. */
function adapter(reading: (index: number) => Reading = () => "confirmed") {
	const evaluate = vi.fn(async (input: { questions: Record<string, unknown>; state?: unknown }) => {
		const keys = Object.keys(input.questions);
		if (keys.some((key) => key.startsWith("shows_true_"))) {
			return {
				model: "jev-1.13.0",
				latency_ms: 1,
				answers: Object.fromEntries(
					keys.map((key) => {
						const verdict = reading(Number(key.split("_").at(-1)));
						const shown = verdict === "confirmed" ? 0.97 : verdict === "refuted" ? 0.03 : 0.5;
						const contradicted = verdict === "refuted" ? 0.96 : verdict === "confirmed" ? 0.02 : 0.5;
						return [key, { noul: key.startsWith("shows_true_") ? shown : contradicted }];
					}),
				),
			};
		}
		const challenge = Object.hasOwn(input.questions, "missing_requirement");
		return {
			model: "jev-1.13.0",
			latency_ms: 1,
			answers: challenge
				? { missing_requirement: { noul: 0.01 } }
				: {
						outcomes_achieved: { noul: 0.95 },
						required_behavior_unverified: { noul: 0.02 },
						material_claim_unsupported: { noul: 0.02 },
					},
		};
	});
	return { evaluate };
}

function fixture(
	options: { verification?: "passed" | "failed"; changed?: boolean; adapter?: ReturnType<typeof adapter> } = {},
) {
	const store = new ExecutionStore({
		run_id: "account",
		objective: {
			request: "Handle a null account",
			normalized_goal: "Handle a null account",
			acceptance_criteria: [{ id: "AC-1", text: "A null account is handled", required: true }],
		},
		repo: { root: "/repo", baseline_revision: "base" },
	});
	store.recordVerification({
		kind: "unit_test",
		status: options.verification ?? "passed",
		command: "vitest run account.test.ts",
		covers_acceptance_ids: ["AC-1"],
	});
	const judge = options.adapter ?? adapter();
	const controller = new SystemOneController({ store, adapter: judge });
	if (options.changed !== false)
		controller.setWorkDiffSource(() => ({ base: "base", patch: PATCH, omittedChars: 0, untracked: [] }));
	return { store, controller, judge };
}

const ACCOUNT = {
	changes: [
		{ path: "src/a.ts", reason: "It handles the null account.", serves: ["AC-1"] },
		{ path: "src/b.ts", reason: "It carries the same guard.", serves: ["src/a.ts"] },
	],
	assumptions: [],
	regressions: [],
};

describe("completion account: checked by code", () => {
	it("reads the changed paths and one file's part of a patch from git's own headers", () => {
		expect(patchPaths(PATCH)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(diffForPath(PATCH, "src/b.ts")).toContain("+y");
		expect(diffForPath(PATCH, "src/b.ts")).not.toContain("+new");
		expect(diffForPath(PATCH, "./src/a.ts")).toContain("+new");
		expect(diffForPath(PATCH, "src/missing.ts")).toBeUndefined();
	});

	it("needs no account when the repository did not change", () => {
		const { controller } = fixture({ changed: false });
		expect(
			checkCompletionAccount(
				undefined,
				{ objective: "x", acceptance: [], changedPaths: [], patch: "", state: controller.store.snapshot() },
				{ repositoryOutcome: false, isBugFix: true },
			),
		).toEqual({ failures: [], claims: [] });
	});

	it("keeps an unsettled claim from refusing more than twice: a doubt, not a deadlock", () => {
		const claim = {
			topic: "assumption" as const,
			label: "assumption",
			statement: "s",
			evidence: "e",
			fingerprint: "f",
		};
		const passes = new Map<string, number>();
		const ask = () => accountOutcome({ refuted: [], unsettled: [claim] }, passes);
		expect(ask().failures).toHaveLength(1);
		expect(ask().failures).toHaveLength(1);
		const third = ask();
		expect(third.failures).toEqual([]);
		expect(third.advisories).toEqual([expect.objectContaining({ id: "account_doubt:assumption" })]);
		// A different claim, or the same claim over new evidence, starts its own count.
		expect(
			accountOutcome({ refuted: [], unsettled: [{ ...claim, fingerprint: "g" }] }, passes).failures,
		).toHaveLength(1);
	});
});

describe("completion account: the transaction", () => {
	it("completes when every changed file is explained and System One confirms each claim", async () => {
		const { controller } = fixture();
		controller.noteCompletionAccount({
			...ACCOUNT,
			assumptions: [{ claim: "Callers pass a string id.", evidenceIds: ["VR-1"] }],
		});
		expect(await controller.executeCompletionTransaction(false)).toMatchObject({
			verdict: "complete",
			failed_gates: [],
		});
	});

	it("asks the model once for its account, naming what is missing and what it can cite, without asking System One", async () => {
		const { controller, judge } = fixture();
		const result = await controller.executeCompletionTransaction(true);
		expect(result.verdict).toBe("verify_more");
		expect(result.failed_gates).toHaveLength(1);
		expect(result.failed_gates[0]).toMatchObject({ id: "account_missing" });
		expect(result.failed_gates[0]?.reason).toContain("defect's cause");
		expect(result.failed_gates[0]?.required_next_proof).toContain("VR-1");
		expect(judge.evaluate).not.toHaveBeenCalled();
		expect(controller.verification.status().obligations).toEqual([]);
	});

	it("names each changed file the account does not explain, and each evidence id that does not exist", async () => {
		const { controller, judge } = fixture();
		controller.noteCompletionAccount({
			changes: [{ path: "src/a.ts", reason: "Handles null.", serves: ["AC-1"] }],
			assumptions: [{ claim: "Ids are strings.", evidenceIds: ["VR-99"] }],
			regressions: [],
		});
		const result = await controller.executeCompletionTransaction(false);
		expect(result.failed_gates.map((gate) => gate.id)).toEqual([
			"account_change_unexplained:src/b.ts",
			"account_unknown_evidence:assumption",
		]);
		expect(judge.evaluate).not.toHaveBeenCalled();
	});

	it("refuses a change said to serve something that is neither a requirement nor another changed file", async () => {
		const { controller, judge } = fixture();
		controller.noteCompletionAccount({
			changes: [
				{ path: "src/a.ts", reason: "It handles the null account.", serves: ["AC-1"] },
				{ path: "src/b.ts", reason: "It carries the same guard.", serves: ["AC-9", "src/c.ts"] },
			],
			assumptions: [],
			regressions: [],
		});
		const result = await controller.executeCompletionTransaction(false);
		expect(result.failed_gates).toEqual([
			expect.objectContaining({
				id: "account_serves_unknown:src/b.ts",
				required_next_proof: expect.stringContaining("AC-1"),
			}),
		]);
		expect(judge.evaluate).not.toHaveBeenCalled();
	});

	it("reads evidence cited on a change beside its diff, and refuses an id that does not exist", async () => {
		const { controller, judge } = fixture();
		controller.noteCompletionAccount({
			changes: [
				{ path: "src/a.ts", reason: "It handles the null account.", serves: ["AC-1"], evidenceIds: ["VR-1"] },
				{ path: "src/b.ts", reason: "It carries the same guard.", serves: ["src/a.ts"] },
			],
			assumptions: [],
			regressions: [],
		});
		expect((await controller.executeCompletionTransaction(false)).verdict).toBe("complete");
		const sent = JSON.stringify(judge.evaluate.mock.calls.flatMap((call) => call[0].state ?? []));
		expect(sent).toContain("vitest run account.test.ts");
		controller.noteCompletionAccount({
			changes: [
				{ path: "src/a.ts", reason: "It handles the null account.", serves: ["AC-1"], evidenceIds: ["VR-77"] },
				{ path: "src/b.ts", reason: "It carries the same guard.", serves: ["src/a.ts"] },
			],
			assumptions: [],
			regressions: [],
		});
		expect((await controller.executeCompletionTransaction(false)).failed_gates.map((gate) => gate.id)).toEqual([
			"account_unknown_evidence:scope",
		]);
	});

	it("does not accept a claim that stands on unverified evidence alone", async () => {
		const { controller, store } = fixture();
		store.recordObservation({
			text: "I believe every caller passes a string id.",
			source: {
				kind: "log",
				locator: "notes",
				trust: "repository_untrusted_text",
				revision: "base",
				line_start: null,
				line_end: null,
			},
		});
		controller.noteCompletionAccount({
			...ACCOUNT,
			assumptions: [{ claim: "Ids are strings.", evidenceIds: ["OBS-1"] }],
		});
		const result = await controller.executeCompletionTransaction(false);
		expect(result.failed_gates.map((gate) => gate.id)).toEqual(["account_unverified_evidence:assumption"]);
		// The same claim citing a passing check is accepted.
		controller.noteCompletionAccount({
			...ACCOUNT,
			assumptions: [{ claim: "Ids are strings.", evidenceIds: ["OBS-1", "VR-1"] }],
		});
		expect((await controller.executeCompletionTransaction(false)).verdict).toBe("complete");
	});

	it("needs the defect's cause for a bug fix, not for other work", async () => {
		const { controller } = fixture();
		controller.noteCompletionAccount(ACCOUNT);
		const fix = await controller.executeCompletionTransaction(true);
		expect(fix.failed_gates.map((gate) => gate.id)).toEqual(["account_cause_missing"]);
		expect((await controller.executeCompletionTransaction(false)).verdict).toBe("complete");
	});

	it("refuses a claim the cited evidence contradicts, naming it, and a refused claim cannot be argued past", async () => {
		const { controller } = fixture({ adapter: adapter((index) => (index === 4 ? "refuted" : "confirmed")) });
		controller.noteCompletionAccount({
			...ACCOUNT,
			assumptions: [{ claim: "Ids are strings.", evidenceIds: ["VR-1"] }],
		});
		for (let attempt = 0; attempt < 4; attempt++) {
			const result = await controller.executeCompletionTransaction(false);
			expect(result.verdict).toBe("verify_more");
			expect(result.failed_gates).toEqual([expect.objectContaining({ id: "account_contradicted:assumption" })]);
		}
	});

	it("asks for better evidence twice for an unsettled claim, then lets it stand as a recorded doubt", async () => {
		const { controller } = fixture({ adapter: adapter((index) => (index === 4 ? "unsettled" : "confirmed")) });
		controller.noteCompletionAccount({
			...ACCOUNT,
			assumptions: [{ claim: "Ids are strings.", evidenceIds: ["VR-1"] }],
		});
		for (let attempt = 0; attempt < 2; attempt++)
			expect((await controller.executeCompletionTransaction(false)).failed_gates).toEqual([
				expect.objectContaining({ id: "account_unsettled:assumption" }),
			]);
		const third = await controller.executeCompletionTransaction(false);
		expect(third.verdict).toBe("complete");
		expect(third.advisories).toEqual([expect.objectContaining({ id: "account_doubt:assumption" })]);
	});

	it("continues the unsettled count from where a resumed session left it, and keeps it as it grows", async () => {
		const kept: Record<string, number> = {};
		const writes: Array<[string, number]> = [];
		const bind = (controller: SystemOneController) =>
			controller.setAccountPassStore({
				read: () => ({ ...kept }),
				write: (fingerprint, passes) => {
					kept[fingerprint] = passes;
					writes.push([fingerprint, passes]);
				},
			});
		const account = { ...ACCOUNT, assumptions: [{ claim: "Ids are strings.", evidenceIds: ["VR-1"] }] };
		const first = fixture({ adapter: adapter((index) => (index === 4 ? "unsettled" : "confirmed")) });
		bind(first.controller);
		first.controller.noteCompletionAccount(account);
		expect((await first.controller.executeCompletionTransaction(false)).failed_gates).toHaveLength(1);
		expect((await first.controller.executeCompletionTransaction(false)).failed_gates).toHaveLength(1);
		expect(writes.map(([, passes]) => passes)).toEqual([1, 2]);

		// A new process for the same session: the claim has already been asked about twice, so it stands as a doubt.
		const resumed = fixture({ adapter: adapter((index) => (index === 4 ? "unsettled" : "confirmed")) });
		bind(resumed.controller);
		resumed.controller.noteCompletionAccount(account);
		const result = await resumed.controller.executeCompletionTransaction(false);
		expect(result.verdict).toBe("complete");
		expect(result.advisories).toEqual([expect.objectContaining({ id: "account_doubt:assumption" })]);
	});

	it("says so, and counts for this session only, when the count cannot be kept", async () => {
		const { controller } = fixture({ adapter: adapter((index) => (index === 4 ? "unsettled" : "confirmed")) });
		controller.setAccountPassStore({
			read: () => {
				throw new Error("ledger locked");
			},
			write: () => {
				throw new Error("ledger locked");
			},
		});
		controller.noteCompletionAccount({
			...ACCOUNT,
			assumptions: [{ claim: "Ids are strings.", evidenceIds: ["VR-1"] }],
		});
		const first = await controller.executeCompletionTransaction(false);
		expect(first.failed_gates).toEqual([expect.objectContaining({ id: "account_unsettled:assumption" })]);
		expect(first.advisories).toEqual([expect.objectContaining({ id: "account_passes_not_kept" })]);
		await controller.executeCompletionTransaction(false);
		expect((await controller.executeCompletionTransaction(false)).verdict).toBe("complete");
	});

	it("still refuses a failed deterministic gate whatever the account says", async () => {
		const { controller, judge } = fixture({ verification: "failed" });
		controller.noteCompletionAccount(ACCOUNT);
		const result = await controller.executeCompletionTransaction(false);
		expect(result.verdict).toBe("rework");
		expect(judge.evaluate).not.toHaveBeenCalled();
	});

	it("treats System One being down as advice unavailable, as every other stage does", async () => {
		const down = { evaluate: vi.fn(async () => Promise.reject(new Error("503 outage"))) };
		const { controller } = fixture({ adapter: down as never });
		controller.noteCompletionAccount(ACCOUNT);
		const result = await controller.executeCompletionTransaction(false);
		expect(result.advisories).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "JEV-account-unavailable" })]),
		);
	});

	it("opens a verification obligation for a failure a check can verify, not for a claim in the account", async () => {
		const failing = adapter();
		const base = failing.evaluate;
		failing.evaluate = vi.fn(async (input: { questions: Record<string, unknown>; state?: unknown }) =>
			Object.hasOwn(input.questions, "missing_requirement")
				? { model: "jev-1.13.0", latency_ms: 1, answers: { missing_requirement: { noul: 0.9 } } }
				: base(input),
		);
		const { controller } = fixture({ adapter: failing });
		controller.noteCompletionAccount(ACCOUNT);
		const result = await controller.executeCompletionTransaction(false);
		expect(result.failed_gates.map((gate) => gate.id)).toEqual(["JEV-CHALLENGE-missing_requirement"]);
		expect(controller.peekControlDirective()).toMatchObject({
			reasonCodes: expect.arrayContaining(["same_lane_verification_required"]),
		});
	});
});
