import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { orchestrationSessionDeletionFile, workerProjectSpecializationFile } from "../agent-paths.ts";
import { isAgentIdentity } from "../orchestration/agent-resume.ts";
import type {
	SpecialistContextOwner,
	SpecialistContextOwnership,
} from "../orchestration/specialist-context-ownership.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedTextFileSync } from "../util/bounded-file.ts";
import { requireBoundedTrimmedText } from "../util/bounded-value.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type {
	WorkerConversation,
	WorkerConversationStore,
	WorkerProjectContextReference,
} from "./worker-conversation-store.ts";

const MAX_DIRECTORY_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 128;

export interface WorkerProjectAllocation {
	specializationKey: string;
	allocationId: string;
	owner: SpecialistContextOwner;
}

interface DirectoryEntry {
	allocationId: string;
	/** Only an allocation receipt, never a mirror of the transcript's current execution owner. */
	allocatedBy: SpecialistContextOwner;
	phase: "allocating" | "published";
	reference?: WorkerProjectContextReference;
}

export type WorkerProjectAdmission =
	| { kind: "allocated"; allocation: WorkerProjectAllocation }
	| { kind: "claimed"; reference: WorkerProjectContextReference; conversation: WorkerConversation }
	| { kind: "unavailable"; reason: string };

/**
 * Discovery and allocation only. Lock order: specialization, birth bundle, transcript. The
 * transcript store owns claim transfer; this index never caches busy/idle state or expires owners.
 */
export class WorkerProjectDirectory {
	private readonly agentDir: string;
	private readonly conversations: WorkerConversationStore;

	constructor(agentDir: string, conversations: WorkerConversationStore) {
		this.agentDir = agentDir;
		this.conversations = conversations;
	}

	admit(input: {
		specializationKey: string;
		owner: SpecialistContextOwner;
		independent: boolean;
		isCompatible(reference: WorkerProjectContextReference, ownership: SpecialistContextOwnership): boolean;
	}): WorkerProjectAdmission {
		const file = workerProjectSpecializationFile(this.agentDir, input.specializationKey);
		return withFileLockSync(file, () => {
			const entries = this.read(file);
			if (!input.independent) {
				const idle: WorkerProjectContextReference[] = [];
				let busy = false;
				for (const entry of entries) {
					if (entry.phase === "allocating") {
						busy = true;
						continue;
					}
					const reference = entry.reference!;
					if (existsSync(orchestrationSessionDeletionFile(this.agentDir, reference.parentSessionId))) continue;
					try {
						const ownership = this.conversations.inspectProjectContext(
							this.agentDir,
							reference,
							input.specializationKey,
						);
						if (!input.isCompatible(reference, ownership) || ownership.state === "retired") continue;
						if (ownership.state === "idle") idle.push(reference);
						else busy = true;
					} catch {
						return { kind: "unavailable", reason: "worker_specialist_context_unavailable" };
					}
				}
				if (idle.length > 1) return { kind: "unavailable", reason: "worker_specialist_choice_required" };
				if (idle.length === 1) {
					const reference = idle[0]!;
					try {
						const conversation = this.conversations.claimProjectContext({
							agentDir: this.agentDir,
							resumeContext: reference.resumeContext,
							expectedLogicalAgentId: reference.logicalAgentId,
							owner: input.owner,
							specializationKey: input.specializationKey,
						});
						return { kind: "claimed", reference: structuredClone(reference), conversation };
					} catch {
						return { kind: "unavailable", reason: "worker_specialist_context_unavailable" };
					}
				}
				if (busy) return { kind: "unavailable", reason: "worker_specialist_busy" };
			}
			if (entries.length >= MAX_DIRECTORY_ENTRIES)
				return { kind: "unavailable", reason: "worker_project_directory_full" };
			const owner = this.normalizeOwner(input.owner);
			const allocationId = randomUUID();
			this.write(file, [...entries, { allocationId, allocatedBy: owner, phase: "allocating" }]);
			return { kind: "allocated", allocation: { specializationKey: input.specializationKey, allocationId, owner } };
		});
	}

	/** Persist the planned birth identity before the caller creates its transcript or task binding. */
	bindAllocation(allocation: WorkerProjectAllocation, reference: WorkerProjectContextReference): void {
		this.updateAllocation(allocation, (entry) => {
			if (entry.reference && !isDeepStrictEqual(entry.reference, reference))
				throw new Error("Worker allocation identity changed.");
			return { ...entry, reference: this.normalizeReference(reference) };
		});
	}

	/** Publication proves enrollment; later readers obtain availability only from that transcript. */
	publish(allocation: WorkerProjectAllocation): void {
		this.updateAllocation(allocation, (entry) => {
			if (!entry.reference) throw new Error("Worker allocation has no birth identity.");
			const ownership = this.conversations.inspectProjectContext(
				this.agentDir,
				entry.reference,
				allocation.specializationKey,
			);
			if (
				ownership.state !== "busy" ||
				ownership.claim.parentSessionId !== allocation.owner.parentSessionId ||
				ownership.claim.incarnation !== allocation.owner.incarnation
			)
				throw new Error("Worker allocation is not owned.");
			return { ...entry, phase: "published" };
		});
	}

	/** Only an unbound allocation can be withdrawn without transcript/ledger recovery evidence. */
	cancelUnboundAllocation(allocation: WorkerProjectAllocation): void {
		this.updateAllocation(allocation, (entry) => {
			if (entry.reference || entry.phase !== "allocating")
				throw new Error("Bound worker allocation requires reconciliation.");
			return undefined;
		});
	}

	/** Caller proves the prepared task is cancelled and has no agent binding or executor. */
	settleCancelledAllocation(
		allocation: WorkerProjectAllocation,
		withQuiescence: (operation: () => void) => boolean,
	): string | undefined {
		let sessionId: string | undefined;
		this.withAllocation(allocation, (entry, save) => {
			if (!entry.reference) {
				if (entry.phase !== "allocating") throw new Error("Published worker allocation has no context.");
				save(undefined);
				return;
			}
			sessionId = entry.reference.resumeContext.sessionId;
			this.conversations.settleCancelledProjectSetup(
				{ agentDir: this.agentDir, reference: entry.reference, ...allocation, withQuiescence },
				(enrolled) => {
					if (!enrolled && entry.phase === "published") throw new Error("Published worker enrollment is missing.");
					save(enrolled ? { ...entry, phase: "published" } : undefined);
				},
			);
		});
		return sessionId;
	}

	private updateAllocation(
		allocation: WorkerProjectAllocation,
		update: (entry: DirectoryEntry) => DirectoryEntry | undefined,
	): void {
		this.withAllocation(allocation, (entry, save) => save(update(entry)));
	}

	private withAllocation(
		allocation: WorkerProjectAllocation,
		operation: (entry: DirectoryEntry, save: (next: DirectoryEntry | undefined) => void) => void,
	): void {
		const file = workerProjectSpecializationFile(this.agentDir, allocation.specializationKey);
		withFileLockSync(file, () => {
			const entries = this.read(file);
			const index = entries.findIndex((entry) => entry.allocationId === allocation.allocationId);
			const entry = entries[index];
			if (!entry || !isDeepStrictEqual(entry.allocatedBy, allocation.owner))
				throw new Error("Worker allocation receipt is stale.");
			operation(entry, (next) => {
				if (next) entries[index] = next;
				else entries.splice(index, 1);
				this.write(file, entries);
			});
		});
	}

	private normalizeOwner(value: unknown): SpecialistContextOwner {
		if (!isPlainRecord(value) || typeof value.parentSessionId !== "string" || typeof value.incarnation !== "string")
			throw new Error("Worker allocation owner is invalid.");
		return {
			parentSessionId: requireBoundedTrimmedText(value.parentSessionId, 512, "Worker parent"),
			incarnation: requireBoundedTrimmedText(value.incarnation, 512, "Worker incarnation"),
		};
	}

	private normalizeReference(value: unknown): WorkerProjectContextReference {
		if (
			!isPlainRecord(value) ||
			typeof value.parentSessionId !== "string" ||
			typeof value.logicalAgentId !== "string" ||
			!isAgentIdentity({ agentId: value.logicalAgentId, resumeContext: value.resumeContext })
		)
			throw new Error("Worker project reference is invalid.");
		return {
			parentSessionId: requireBoundedTrimmedText(value.parentSessionId, 512, "Worker birth parent"),
			logicalAgentId: requireBoundedTrimmedText(value.logicalAgentId, 512, "Worker birth agent"),
			resumeContext: structuredClone(value.resumeContext) as WorkerProjectContextReference["resumeContext"],
		};
	}

	private read(file: string): DirectoryEntry[] {
		if (!existsSync(file)) return [];
		const value: unknown = JSON.parse(readBoundedTextFileSync(file, MAX_DIRECTORY_BYTES, "Worker project directory"));
		if (
			!isPlainRecord(value) ||
			value.schemaVersion !== 1 ||
			!Array.isArray(value.entries) ||
			value.entries.length > MAX_DIRECTORY_ENTRIES
		)
			throw new Error("Worker project directory is invalid.");
		const ids = new Set<string>();
		return value.entries.map((item: unknown) => {
			if (
				!isPlainRecord(item) ||
				typeof item.allocationId !== "string" ||
				(item.phase !== "allocating" && item.phase !== "published")
			)
				throw new Error("Worker allocation is invalid.");
			const allocationId = requireBoundedTrimmedText(item.allocationId, 128, "Worker allocation");
			if (ids.has(allocationId)) throw new Error("Worker allocation is duplicated.");
			ids.add(allocationId);
			const reference = item.reference === undefined ? undefined : this.normalizeReference(item.reference);
			if (item.phase === "published" && !reference) throw new Error("Published worker has no reference.");
			return {
				allocationId,
				allocatedBy: this.normalizeOwner(item.allocatedBy),
				phase: item.phase,
				...(reference ? { reference } : {}),
			};
		});
	}

	private write(file: string, entries: readonly DirectoryEntry[]): void {
		const content = JSON.stringify({ schemaVersion: 1, entries });
		if (Buffer.byteLength(content) > MAX_DIRECTORY_BYTES)
			throw new Error("Worker project directory exceeds its byte limit.");
		writeFileAtomicSync(file, content, { mode: 0o600 });
	}
}
