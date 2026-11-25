/** Hot/cold ownership for persisted message payloads and the monotonic settled-history scan. */

import type { SessionMessageEntry } from "./session-entries.ts";
import { COMPACTED_PAYLOAD_RELEASE_MIN_CHARS, retainedStringChars } from "./session-file-reading.ts";

export type SessionMessagePayloadProperty = "content" | "output";

export function releasableSessionMessageProperties(
	entry: SessionMessageEntry,
	minimumRetainedChars = COMPACTED_PAYLOAD_RELEASE_MIN_CHARS,
): SessionMessagePayloadProperty[] {
	const message = entry.message as unknown as Record<string, unknown>;
	const properties: SessionMessagePayloadProperty[] = [];
	for (const property of ["content", "output"] as const) {
		const descriptor = Object.getOwnPropertyDescriptor(message, property);
		if (
			descriptor &&
			!descriptor.get &&
			"value" in descriptor &&
			retainedStringChars(descriptor.value, minimumRetainedChars) >= minimumRetainedChars
		) {
			properties.push(property);
		}
	}
	return properties;
}

export function releaseSessionMessageProperty(
	entry: SessionMessageEntry,
	property: SessionMessagePayloadProperty,
	read: (entryId: string, property: SessionMessagePayloadProperty) => unknown,
	markCold: (entryId: string) => void,
	minimumRetainedChars = COMPACTED_PAYLOAD_RELEASE_MIN_CHARS,
): void {
	const message = entry.message as unknown as Record<string, unknown>;
	const descriptor = Object.getOwnPropertyDescriptor(message, property);
	if (
		!descriptor ||
		descriptor.get ||
		!("value" in descriptor) ||
		retainedStringChars(descriptor.value, minimumRetainedChars) < minimumRetainedChars
	)
		return;
	const entryId = entry.id;
	const enumerable = descriptor.enumerable;
	// The accessor closure must not retain the original payload through the captured descriptor.
	descriptor.value = undefined;
	Object.defineProperty(message, property, {
		configurable: true,
		enumerable,
		get: () => read(entryId, property),
		set: (value: unknown) => {
			Object.defineProperty(message, property, {
				configurable: true,
				enumerable,
				writable: true,
				value,
			});
		},
	});
	markCold(entryId);
}

export interface SettledSessionPayloadPort {
	entryCount(): number;
	isDurable(): boolean;
	persistenceStateUncertain(): boolean;
	messageEntryIdAt(index: number): string | undefined;
	release(entryId: string): void;
}

/** Visits each settled entry at most once until navigation installs another transcript. */
export class SettledSessionPayloadReleaser {
	private nextIndex = 0;
	private readonly port: SettledSessionPayloadPort;

	constructor(port: SettledSessionPayloadPort) {
		this.port = port;
	}

	reset(): void {
		this.nextIndex = 0;
	}

	release(endExclusive = this.port.entryCount()): number {
		if (!Number.isSafeInteger(endExclusive) || endExclusive < 0 || endExclusive > this.port.entryCount()) {
			throw new TypeError("Settled session payload boundary is invalid.");
		}
		if (!this.port.isDurable()) return 0;
		if (this.port.persistenceStateUncertain()) {
			throw new Error(
				"Session persistence state is uncertain after a failed write; reopen the session file before releasing payloads.",
			);
		}
		let released = 0;
		while (this.nextIndex < endExclusive) {
			const entryId = this.port.messageEntryIdAt(this.nextIndex);
			if (entryId) {
				this.port.release(entryId);
				released++;
			}
			this.nextIndex++;
		}
		return released;
	}
}
