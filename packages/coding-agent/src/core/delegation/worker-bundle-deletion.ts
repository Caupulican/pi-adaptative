/**
 * Worker transcripts' side of a session bundle's deletion: a bundle is reserved for deletion only
 * when none of the worker conversations it holds still carries a live, busy or enrolled specialist
 * context (bounded, fail-closed inspection).
 */
import { existsSync, opendirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadEntriesFromFile, SessionManager } from "../../kernel/session/session-manager.ts";
import { readWorkerConversationMetadata } from "../../kernel/session/worker-conversation-metadata.ts";
import {
	projectEnrollmentKey,
	WORKER_PROJECT_ENROLLMENT_CUSTOM_TYPE,
} from "../../kernel/session/worker-project-enrollment.ts";
import { workerConversationMetadataFile } from "../../kernel/session/worker-storage-identity.ts";
import { type OrchestrationHome, workerConversationSessionsDir } from "../agent-paths.ts";
import {
	reserveSessionBundleDeletion,
	type SessionBundleDeletionPolicy,
	type SessionBundleDeletionReservation,
	withPermanentSessionBundleDeletion,
} from "../orchestration/session-bundle-lifecycle.ts";
import { withFileLockSync } from "../util/atomic-file.ts";
import { scanWorkerSessionFile } from "./worker-conversation-revision.ts";
import { EXISTING_WORKER_FILE_LOCK_OPTIONS } from "./worker-conversation-store.ts";

/** Bounded, fail-closed claim inspection before removing a birth parent's artifact bundle. */
export function reserveWorkerBundleDeletion(
	agentDir: string,
	orchestrationHome: OrchestrationHome,
	parentSessionId: string,
	policy: SessionBundleDeletionPolicy,
	requireExistingRetention = false,
): SessionBundleDeletionReservation | undefined {
	return reserveSessionBundleDeletion(
		orchestrationHome,
		parentSessionId,
		policy,
		() => canDeleteWorkerBundleArtifacts(agentDir, orchestrationHome, parentSessionId),
		requireExistingRetention,
	);
}

/** Explicit deletion can remove foreground history while retaining busy worker artifacts. */
export function canDeleteReservedWorkerBundle(
	agentDir: string,
	orchestrationHome: OrchestrationHome,
	reservation: SessionBundleDeletionReservation,
): boolean {
	return withPermanentSessionBundleDeletion(orchestrationHome, reservation, () =>
		canDeleteWorkerBundleArtifacts(agentDir, orchestrationHome, reservation.parentSessionId),
	);
}

function canDeleteWorkerBundleArtifacts(
	agentDir: string,
	orchestrationHome: OrchestrationHome,
	parentSessionId: string,
): boolean {
	const directory = workerConversationSessionsDir(orchestrationHome, parentSessionId);
	if (!existsSync(directory)) return true;
	try {
		const entries = opendirSync(directory);
		let inspectedBytes = 0;
		try {
			for (let count = 0; count < 4096; count++) {
				const entry = entries.readSync();
				if (!entry) return true;
				if (entry.name.endsWith(".jsonl")) {
					if (!entry.isFile()) return false;
					const sessionFile = join(directory, entry.name);
					if (!existsSync(workerConversationMetadataFile(sessionFile))) {
						inspectedBytes += statSync(sessionFile).size;
						if (inspectedBytes > 32 * 1024 * 1024) return false;
						// Read-only parsing: opening a SessionManager may repair a partial tail.
						const enrolled = withFileLockSync(
							sessionFile,
							() =>
								loadEntriesFromFile(sessionFile).some(
									(record) =>
										record.type === "custom" && record.customType === WORKER_PROJECT_ENROLLMENT_CUSTOM_TYPE,
								),
							EXISTING_WORKER_FILE_LOCK_OPTIONS,
						);
						if (enrolled) return false;
					}
				}
				if (!entry.name.endsWith(".worker.json")) continue;
				if (!entry.isFile()) return false;
				const metadataFile = join(directory, entry.name);
				const sessionFile = metadataFile.slice(0, -".worker.json".length);
				const deletable = withFileLockSync(
					sessionFile,
					() => {
						const { metadata } = readWorkerConversationMetadata(metadataFile);
						if (metadata.parentSessionId !== parentSessionId) return false;
						if (
							metadata.projectContext?.ownership.state === "busy" ||
							metadata.projectContext?.ownership.state === "handoff"
						)
							return false;
						if (!existsSync(sessionFile)) return !metadata.projectContext;
						inspectedBytes += statSync(sessionFile).size;
						if (inspectedBytes > 32 * 1024 * 1024) return false;
						scanWorkerSessionFile(sessionFile, metadata.resumeContext.sessionId, metadata.resumeContext.cwd);
						return (
							projectEnrollmentKey(SessionManager.openReadOnly(sessionFile, agentDir)) ===
							metadata.projectContext?.specializationKey
						);
					},
					EXISTING_WORKER_FILE_LOCK_OPTIONS,
				);
				if (!deletable) return false;
			}
			return false;
		} finally {
			entries.closeSync();
		}
	} catch {
		return false;
	}
}
