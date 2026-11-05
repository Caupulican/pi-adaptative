/**
 * A worker's read-only skill access: the parent's skill vault, filtered to the skills a worker may hold. An
 * in-process worker holds no effect grant, so skills that declare an effect are neither listed nor readable.
 * Built over any vault that serves reads, so a parent opened away composes it the same way the foreground does.
 */

import { createHash } from "node:crypto";
import type { SkillVaultController } from "../skill-vault.ts";
import { workerEligibleSkills } from "../skills.ts";
import type { ParentExecutionPolicy } from "./parent-execution-context.ts";

/** The vault reads a worker's skill access needs. */
export type WorkerSkillSource = Pick<SkillVaultController, "search" | "read" | "getSkillsSnapshot">;

/** Names of the skills that declare an effect: an in-process worker is never offered them. */
function effectfulSkillNames(source: WorkerSkillSource): Set<string> {
	const snapshot = source.getSkillsSnapshot();
	const eligible = new Set(workerEligibleSkills(snapshot).map((skill) => skill.name));
	return new Set(snapshot.map((skill) => skill.name).filter((name) => !eligible.has(name)));
}

export function createWorkerSkillAccess(
	source: WorkerSkillSource,
): Required<Pick<ParentExecutionPolicy, "getSkillReadBroker" | "getSkillAuditSource">> {
	return {
		getSkillReadBroker: () => ({
			search: (query) => {
				const result = source.search(query);
				const withheld = effectfulSkillNames(source);
				return { ...result, candidates: result.candidates.filter((candidate) => !withheld.has(candidate.name)) };
			},
			read: (name) =>
				effectfulSkillNames(source).has(name)
					? { ok: false, reason: "not_found", message: `No eligible skill named ${JSON.stringify(name)}.` }
					: source.read(name),
		}),
		getSkillAuditSource: () => ({
			getSkills: () => workerEligibleSkills(source.getSkillsSnapshot()),
			redactPath: (path: string) => `skill:${createHash("sha256").update(path).digest("hex").slice(0, 12)}`,
		}),
	};
}
