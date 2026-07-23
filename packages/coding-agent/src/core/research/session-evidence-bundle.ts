import type { SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import type { EvidenceBundle } from "../autonomy/contracts.ts";
import {
	appendSessionSnapshot,
	getLatestSessionSnapshot,
	getSessionSnapshots,
	type SessionSnapshotCodec,
	type SessionSnapshotPayload,
} from "../session-snapshot.ts";
import { cloneEvidenceBundleForStorage, isEvidenceBundle } from "./evidence-bundle.ts";

export const EVIDENCE_BUNDLE_CUSTOM_TYPE = "evidence_bundle";

export type EvidenceBundleSnapshotPayload = SessionSnapshotPayload<"bundle", EvidenceBundle>;

const EVIDENCE_BUNDLE_SNAPSHOT_CODEC: SessionSnapshotCodec<EvidenceBundle, "bundle"> = {
	customType: EVIDENCE_BUNDLE_CUSTOM_TYPE,
	valueKey: "bundle",
	isValue: isEvidenceBundle,
	clone: cloneEvidenceBundleForStorage,
};

export function appendEvidenceBundleSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	bundle: EvidenceBundle,
): string {
	return appendSessionSnapshot(sessionManager, EVIDENCE_BUNDLE_SNAPSHOT_CODEC, bundle);
}

export function getEvidenceBundleSnapshots(entries: readonly SessionEntry[]): EvidenceBundle[] {
	return getSessionSnapshots(entries, EVIDENCE_BUNDLE_SNAPSHOT_CODEC);
}

export function getLatestEvidenceBundleSnapshot(entries: readonly SessionEntry[]): EvidenceBundle | undefined {
	return getLatestSessionSnapshot(entries, EVIDENCE_BUNDLE_SNAPSHOT_CODEC);
}
