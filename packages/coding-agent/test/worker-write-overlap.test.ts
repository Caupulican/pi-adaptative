import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerClaim, WorkerRequest } from "../src/core/autonomy/contracts.ts";
import { hostFindingBlockerLine } from "../src/core/autonomy/host-findings.ts";
import { validateWorkerClaim } from "../src/core/delegation/worker-claim.ts";
import { interruptedWorkerMutationFields } from "../src/core/delegation/worker-mutation-evidence.ts";
import { WorkerWriteOverlapTracker } from "../src/core/delegation/worker-write-overlap.ts";
import { createWorkerResultContract } from "../src/core/orchestration/worker-result-adapter.ts";

describe("concurrent worker write claims", () => {
	let tracker: WorkerWriteOverlapTracker;
	let checkout: string;

	beforeEach(() => {
		tracker = new WorkerWriteOverlapTracker();
		checkout = mkdtempSync(path.join(tmpdir(), "pi-overlap-"));
		mkdirSync(path.join(checkout, ".git"));
	});
	afterEach(() => rmSync(checkout, { force: true, recursive: true }));

	function begin(laneId: string, files: string[] = [], cwd = checkout, attemptId = laneId) {
		const evidence = { uncertain: false };
		tracker.begin({
			attemptId,
			laneId,
			agentId: `agent-${laneId}`,
			cwd,
			changedFiles: () => files,
			hasUncertainMutation: () => evidence.uncertain,
		});
		return evidence;
	}

	it.each(["writer", "shell"])("carries the tracked path on both claims when %s finishes first", (first) => {
		begin("writer", ["shared.txt"]);
		const shell = begin("shell", [], path.join(checkout, "src"));
		expect(tracker.findingsFor("writer")).toEqual([]);
		shell.uncertain = true;
		const findings = tracker.findingsFor(first);
		expect(findings).toEqual([{ code: "mutation_uncertain", text: expect.stringContaining("shared.txt") }]);
		for (const id of ["agent-writer", "agent-shell"]) expect(findings[0]!.text).toContain(id);
		tracker.end(first);
		const last = first === "writer" ? "shell" : "writer";
		expect(tracker.findingsFor(last)).toEqual(findings);
		const cancellation = interruptedWorkerMutationFields(last === "writer" ? ["shared.txt"] : [], findings);
		expect(cancellation.parentReviewRequired).toBe(true);
		expect(cancellation.hostFindings).toEqual(findings);
		expect(cancellation.changedFiles).toEqual(last === "writer" ? ["shared.txt"] : []);
	});

	it("sends an otherwise accepted edit to the parent as partial with trusted peer uncertainty", () => {
		begin("writer", ["shared.txt"]);
		const shell = begin("shell");
		const at = "2026-11-18T00:00:00.000Z";
		const request: WorkerRequest = {
			id: "edit",
			instructions: "Edit shared.txt",
			route: { tier: "medium", risk: "scoped-write", confidence: 1, reasonCode: "fixture", reasons: [] },
			envelope: { id: "grant", capabilities: ["filesystem.write"], allowedPaths: [checkout] },
		};
		const claim: WorkerClaim = {
			requestId: request.id,
			status: "completed",
			summary: "Edited shared.txt",
			usageReportId: "usage",
			createdAt: at,
			changedFiles: ["shared.txt"],
			hostVerdict: {
				verdict: "accepted",
				judgedBy: "code",
				at,
				coveredRequirementIds: [],
				missing: [],
				reasonCodes: [],
			},
		};
		expect(validateWorkerClaim({ claim, request, cwd: checkout }).outcome).toBe("allow");
		shell.uncertain = true;
		tracker.end("shell");
		claim.hostFindings = tracker.findingsFor("writer");
		claim.blockers = claim.hostFindings.map(hostFindingBlockerLine);
		const gate = validateWorkerClaim({ claim, request, cwd: checkout });
		const result = createWorkerResultContract({
			handle: {
				objectiveId: "objective",
				taskId: request.id,
				attemptId: "writer",
				leaseId: "lease",
				fencingToken: 1,
				expiresAt: at,
			},
			claim,
			cwd: checkout,
			accepted: gate.outcome === "allow",
			wallClockMs: 10,
			toolCalls: 1,
			createdAt: at,
		});
		expect(result.status).toBe("partial");
		expect(result.nextAction).toBe("parent_review");
		expect(result.evidence).toContainEqual(
			expect.objectContaining({
				trusted: true,
				metadata: { observation: "worker_mutation_uncertain" },
				summary: expect.stringContaining("shared.txt"),
			}),
		);
	});

	it("names an earlier writer on the shell handoff if its operation started after the writer reported", () => {
		begin("writer", ["shared.txt"]);
		const shell = begin("shell");
		expect(tracker.findingsFor("writer")).toEqual([]);
		tracker.end("writer");
		shell.uncertain = true;
		expect(tracker.findingsFor("shell")[0]?.text).toContain("agent-writer");
	});

	it("distinguishes sibling worktrees sharing a Git common directory", () => {
		const lane = path.join(checkout, "lane");
		mkdirSync(lane);
		const admin = path.join(checkout, ".git", "worktrees", "lane");
		mkdirSync(admin, { recursive: true });
		writeFileSync(path.join(lane, ".git"), `gitdir: ${admin}\n`);
		writeFileSync(path.join(admin, "commondir"), "../..\n");
		begin("writer", ["shared.txt"]);
		begin("shell", [], lane).uncertain = true;
		expect(tracker.findingsFor("shell")).toEqual([]);
		tracker.end("shell");
		expect(tracker.findingsFor("writer")).toEqual([]);
	});

	it("recognizes an aliased checkout when the native write ledger names its canonical path", () => {
		const alias = path.join(checkout, "alias");
		symlinkSync(checkout, alias, "junction");
		const target = path.join(checkout, "shared.txt");
		begin("writer", [path.relative(alias, target)], alias);
		begin("shell").uncertain = true;
		expect(tracker.findingsFor("shell")[0]?.text).toContain(target);
	});

	it("keeps successor evidence live when a previous attempt of the same lane releases its processes", () => {
		begin("shell", [], checkout, "prior");
		const current = begin("shell", [], checkout, "successor");
		tracker.end("prior");
		begin("writer", ["shared.txt"]);
		current.uncertain = true;
		expect(tracker.findingsFor("writer")[0]?.code).toBe("mutation_uncertain");
	});

	it("bounds concurrent findings while keeping the number omitted visible", () => {
		begin("writer", ["shared.txt"]);
		for (let index = 0; index < 15; index++) begin(`shell-${index}`).uncertain = true;
		const findings = tracker.findingsFor("writer");
		expect(findings.filter((finding) => finding.code === "mutation_uncertain")).toHaveLength(12);
		expect(findings.at(-1)).toEqual({ code: "omitted", text: expect.stringContaining("3 further") });
	});

	it("retains exact attribution without inferring shell paths or including sequential workers", () => {
		begin("left", ["shared.txt"]);
		begin("right", ["shared.txt"]).uncertain = true;
		expect(tracker.findingsFor("left").map((finding) => finding.code)).toEqual(["overlap"]);
		begin("bridge");
		tracker.end("left");
		tracker.end("right");
		begin("later", ["shared.txt"]);
		expect(tracker.findingsFor("later")).toEqual([]);
		expect(tracker.findingsFor("bridge")).toEqual([]);
	});

	it("requires review when retained peer history cannot cover a long-running writer", () => {
		begin("writer", ["shared.txt"]);
		for (let index = 0; index < 129; index++) {
			const id = `peer-${index}`;
			begin(id, [`other-${index}.txt`]);
			tracker.end(id);
		}
		expect(tracker.findingsFor("writer").map((finding) => finding.code)).toEqual(["omitted"]);
	});
});
