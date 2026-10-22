import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { writeFileAtomicSync } from "../storage/atomic-file.ts";
import { readBoundedTextFileSync } from "../storage/bounded-file.ts";
import { isPlainRecord } from "../utils/value-guards.ts";
import { type AgentResumeContext, cloneResumeContext, sameAgentResumeIdentity } from "./agent-identity.ts";
import {
	normalizeSpecialistContextOwnership,
	type SpecialistContextOwnership,
} from "./specialist-context-ownership.ts";
import {
	normalizeWorkerContextForkReference,
	type WorkerContextForkReference,
} from "./worker-context-fork-reference.ts";

export const MAX_WORKER_CONVERSATION_METADATA_BYTES = 256 * 1024;

export interface WorkerProjectContext {
	specializationKey: string;
	ownership: SpecialistContextOwnership;
}

export interface WorkerConversationMetadata {
	logicalAgentId: string;
	/** Present on current metadata; omitted only by conversations created before context forks. */
	parentSessionId?: string;
	resumeContext: AgentResumeContext;
	birthContextForkReference?: WorkerContextForkReference;
	/** Version 1 makes a missing current-attempt boundary authoritative zero usage. */
	usageAccountingVersion?: 1;
	projectContext?: WorkerProjectContext;
}

export interface WorkerConversationMetadataRead {
	metadata: WorkerConversationMetadata;
	content: string;
}

export function readWorkerConversationMetadata(metadataFile: string): WorkerConversationMetadataRead {
	let content: string;
	let metadata: unknown;
	try {
		content = readBoundedTextFileSync(
			metadataFile,
			MAX_WORKER_CONVERSATION_METADATA_BYTES,
			"Worker conversation metadata durable size bound",
		);
		metadata = JSON.parse(content);
	} catch {
		throw new Error(
			existsSync(metadataFile)
				? "Worker conversation metadata is invalid or exceeds its durable size bound."
				: "Worker conversation metadata is missing or invalid.",
		);
	}
	if (!isPlainRecord(metadata)) {
		throw new Error("Worker conversation metadata is invalid.");
	}
	let projectContext: WorkerProjectContext | undefined;
	if ("format" in metadata) {
		if (
			metadata.format !== "worker-project-context-v1" ||
			Object.keys(metadata).length !== 3 ||
			!isPlainRecord(metadata.metadata) ||
			!isPlainRecord(metadata.projectContext) ||
			Object.keys(metadata.projectContext).length !== 2 ||
			typeof metadata.projectContext.specializationKey !== "string" ||
			!/^[a-f0-9]{64}$/.test(metadata.projectContext.specializationKey)
		)
			throw new Error("Worker project context metadata is invalid.");
		projectContext = {
			specializationKey: metadata.projectContext.specializationKey,
			ownership: normalizeSpecialistContextOwnership(metadata.projectContext.ownership),
		};
		metadata = metadata.metadata;
	}
	const logicalAgentId = (metadata as { logicalAgentId?: unknown }).logicalAgentId;
	const parentSessionId = (metadata as { parentSessionId?: unknown }).parentSessionId;
	const resumeContext = (metadata as { resumeContext?: unknown }).resumeContext;
	const birthContextForkReference = (metadata as { birthContextForkReference?: unknown }).birthContextForkReference;
	const usageAccountingVersion = (metadata as { usageAccountingVersion?: unknown }).usageAccountingVersion;
	if (
		typeof logicalAgentId !== "string" ||
		!logicalAgentId.trim() ||
		(parentSessionId !== undefined &&
			(typeof parentSessionId !== "string" || !parentSessionId.trim() || parentSessionId.length > 512)) ||
		!resumeContext ||
		(birthContextForkReference !== undefined && parentSessionId === undefined) ||
		(usageAccountingVersion !== undefined && usageAccountingVersion !== 1)
	) {
		throw new Error("Worker conversation metadata is invalid.");
	}
	let normalizedBirthContextForkReference: WorkerContextForkReference | undefined;
	try {
		normalizedBirthContextForkReference =
			birthContextForkReference === undefined
				? undefined
				: normalizeWorkerContextForkReference(birthContextForkReference);
	} catch {
		throw new Error("Worker conversation metadata is invalid.");
	}
	return {
		content,
		metadata: {
			logicalAgentId,
			...(typeof parentSessionId === "string" ? { parentSessionId } : {}),
			resumeContext: cloneResumeContext(resumeContext as AgentResumeContext),
			...(normalizedBirthContextForkReference
				? { birthContextForkReference: normalizedBirthContextForkReference }
				: {}),
			...(usageAccountingVersion === 1 ? { usageAccountingVersion } : {}),
			...(projectContext ? { projectContext } : {}),
		},
	};
}

export function assertExactConversationMetadataValue(
	metadata: WorkerConversationMetadata,
	expected: AgentResumeContext,
	logicalAgentId?: string,
	parentSessionId?: string,
	birthContextForkReference?: WorkerContextForkReference,
): WorkerConversationMetadata {
	if (logicalAgentId && metadata.logicalAgentId !== logicalAgentId) {
		throw new Error("Worker conversation logical agent identity conflicts with the persisted transcript.");
	}
	if (!sameAgentResumeIdentity(metadata.resumeContext, expected)) {
		throw new Error("Worker conversation resume context conflicts with the persisted transcript.");
	}
	if (parentSessionId && metadata.parentSessionId && metadata.parentSessionId !== parentSessionId) {
		throw new Error("Worker conversation parent session identity conflicts with the persisted transcript.");
	}
	if (birthContextForkReference && !isDeepStrictEqual(metadata.birthContextForkReference, birthContextForkReference)) {
		throw new Error("Worker conversation birth context reference conflicts with the persisted transcript.");
	}
	return metadata;
}

export function assertExactConversationMetadata(
	metadataFile: string,
	expected: AgentResumeContext,
	logicalAgentId?: string,
	parentSessionId?: string,
	birthContextForkReference?: WorkerContextForkReference,
): WorkerConversationMetadata {
	return assertExactConversationMetadataValue(
		readWorkerConversationMetadata(metadataFile).metadata,
		expected,
		logicalAgentId,
		parentSessionId,
		birthContextForkReference,
	);
}

export function writeWorkerConversationMetadata(metadataFile: string, metadata: WorkerConversationMetadata): void {
	const { projectContext, ...identity } = metadata;
	const encoded = projectContext
		? { format: "worker-project-context-v1", metadata: identity, projectContext }
		: identity;
	writeFileAtomicSync(metadataFile, `${JSON.stringify(encoded)}\n`, { mode: 0o600 });
}
