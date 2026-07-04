import type { SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import type { EvidenceBundle } from "../autonomy/contracts.ts";
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function getEvidenceBundleSnapshots(entries: readonly SessionEntry[]): EvidenceBundle[] {
	const bundles: EvidenceBundle[] = [];

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== EVIDENCE_BUNDLE_CUSTOM_TYPE) {
			continue;
		}

		const payload = entry.data;
		if (!isPlainRecord(payload)) continue;
		if (payload.version !== 1) continue;
		if (!("bundle" in payload)) continue;
		const bundle = payload.bundle;
		if (isEvidenceBundle(bundle)) {
			bundles.push(cloneEvidenceBundleForStorage(bundle));
		}
	}

	return bundles;
}

export function getLatestEvidenceBundleSnapshot(entries: readonly SessionEntry[]): EvidenceBundle | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === EVIDENCE_BUNDLE_CUSTOM_TYPE) {
			const payload = entry.data;
			if (!isPlainRecord(payload)) continue;
			if (payload.version !== 1) continue;
			if (!("bundle" in payload)) continue;
			const bundle = payload.bundle;
			if (isEvidenceBundle(bundle)) {
				return cloneEvidenceBundleForStorage(bundle);
			}
		}
	}
	return undefined;
}
