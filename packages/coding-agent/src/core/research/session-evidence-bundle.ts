import type { EvidenceBundle } from "../autonomy/contracts.ts";
import type { SessionEntry, SessionManager } from "../session-manager.ts";
import { cloneEvidenceBundleForStorage, isEvidenceBundle } from "./evidence-bundle.ts";

export const EVIDENCE_BUNDLE_CUSTOM_TYPE = "evidence_bundle";

export interface EvidenceBundleSnapshotPayload {
	version: 1;
	bundle: EvidenceBundle;
}

export function appendEvidenceBundleSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	bundle: EvidenceBundle,
): string {
	const payload: EvidenceBundleSnapshotPayload = {
		version: 1,
		bundle: cloneEvidenceBundleForStorage(bundle),
	};
	return sessionManager.appendCustomEntry(EVIDENCE_BUNDLE_CUSTOM_TYPE, payload);
}

export function getLatestEvidenceBundleSnapshot(entries: readonly SessionEntry[]): EvidenceBundle | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === EVIDENCE_BUNDLE_CUSTOM_TYPE) {
			const payload = entry.data;
			if (
				payload &&
				typeof payload === "object" &&
				"version" in payload &&
				(payload as Record<string, unknown>).version === 1 &&
				"bundle" in payload
			) {
				const bundle = (payload as Record<string, unknown>).bundle;
				if (isEvidenceBundle(bundle)) {
					return cloneEvidenceBundleForStorage(bundle);
				}
			}
		}
	}
	return undefined;
}
