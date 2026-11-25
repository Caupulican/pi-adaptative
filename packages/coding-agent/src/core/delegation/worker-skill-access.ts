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
export type WorkerSkillSource = Pick<SkillVaultController, "createWorkerDiscovery" | "read" | "getSkillsSnapshot">;

export function createWorkerSkillAccess(
	source: WorkerSkillSource,
): Required<Pick<ParentExecutionPolicy, "getSkillReadBroker" | "getSkillAuditSource">> {
	return {
		getSkillReadBroker: (agentId) => {
			const discovery = source.createWorkerDiscovery();
			return {
				search: (query, signal) =>
					discovery.search(query, {
						signal,
						...(agentId ? { evaluationScope: { kind: "worker-task", id: agentId } } : {}),
					}),
				headers: discovery,
				read: (name) => source.read(name, "model", true),
			};
		},
		getSkillAuditSource: () => ({
			getSkills: () => workerEligibleSkills(source.getSkillsSnapshot()),
			redactPath: (path: string) => `skill:${createHash("sha256").update(path).digest("hex").slice(0, 12)}`,
		}),
	};
}
