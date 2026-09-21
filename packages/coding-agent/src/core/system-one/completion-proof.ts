import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ExecutionState } from "./types.ts";

export interface CompletionProofGate {
	id: string;
	status: "passed" | "failed";
	required: boolean;
	details?: string;
}

export interface CompletionProof {
	gates: CompletionProofGate[];
	digest: string;
	failed_reasons: { id: string; required_next_proof?: string; detail?: string }[];
}

export function buildCompletionProof(execState: ExecutionState, _candidateRevision: string): CompletionProof {
	let digest = "";
	try {
		const diff = execSync("git diff HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		const untrackedStr = execSync("git ls-files --others --exclude-standard", {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const untracked = untrackedStr.trim().split("\n").filter(Boolean);
		let untrackedContent = "";
		for (const f of untracked) {
			untrackedContent += require("fs").readFileSync(f, "utf8");
		}
		digest = createHash("sha256")
			.update(diff + untrackedContent)
			.digest("hex");
	} catch (e) {
		throw new Error(`Failed to generate candidate digest: ${e instanceof Error ? e.message : String(e)}`);
	}

	if (!digest) {
		digest = "empty_diff"; // Just to have a digest if there's no diff
	}

	const failed_reasons: { id: string; required_next_proof?: string; detail?: string }[] = [];
	const gates: CompletionProofGate[] = [];

	// 1. Live/non-empty objective
	if (!execState.objective?.request) {
		failed_reasons.push({ id: "missing_objective", detail: "Objective request is empty" });
		gates.push({ id: "objective_exists", status: "failed", required: true });
	} else {
		gates.push({ id: "objective_exists", status: "passed", required: true });
	}

	// 2. Acceptance criteria satisfied or waived
	let criteriaFailed = false;
	for (const crit of execState.objective?.acceptance_criteria || []) {
		if (crit.required && crit.status !== "satisfied" && crit.status !== "waived") {
			criteriaFailed = true;
			failed_reasons.push({ id: "criterion_unmet", detail: `Criterion not met: ${crit.id}` });
		}
	}
	gates.push({ id: "criteria_met", status: criteriaFailed ? "failed" : "passed", required: true });

	// 3. Hard constraints verified
	let constraintsFailed = false;
	for (const c of execState.objective?.constraints || []) {
		if (c.severity === "hard" && !c.verified) {
			constraintsFailed = true;
			failed_reasons.push({ id: "hard_constraint_unverified", detail: `Constraint unverified: ${c.id}` });
		}
	}
	gates.push({ id: "constraints_verified", status: constraintsFailed ? "failed" : "passed", required: true });

	// 4. Open high/critical risks
	let riskFailed = false;
	for (const r of execState.risks || []) {
		if ((r.severity === "high" || r.severity === "critical") && r.status === "open") {
			riskFailed = true;
			failed_reasons.push({ id: "critical_risk_open", detail: `Risk open: ${r.id}` });
		}
	}
	gates.push({ id: "risks_mitigated", status: riskFailed ? "failed" : "passed", required: true });

	// 5. Open/failed required tasks
	let tasksFailed = false;
	for (const step of execState.plan?.steps || []) {
		if (step.status === "pending" || step.status === "active" || step.status === "failed") {
			tasksFailed = true;
			failed_reasons.push({ id: "required_task_unfinished", detail: `Step unfinished: ${step.id}` });
		}
	}
	gates.push({ id: "tasks_finished", status: tasksFailed ? "failed" : "passed", required: true });

	// Do NOT forge JEV-024, JEV-025, JEV-026 here. Those are semantic gates, not deterministic gates.
	// Semantic gates should be evaluated by the semantic engine and placed into execState.completion.gates.

	return {
		digest,
		failed_reasons,
		gates,
	};
}
