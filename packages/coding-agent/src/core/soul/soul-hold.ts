import { rmSync } from "node:fs";
import { soulHeldFile } from "../agent-paths.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";
import { readOptionalBoundedTextFileSync } from "../util/bounded-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";

const HOLD_VERSION = 1;
/** `soul.md` has no size limit by owner decision, so the marker that keeps its texts is bounded generously instead. */
const MAX_HOLD_BYTES = 16 * 1024 * 1024;

/**
 * An agent change of `soul.md` that no review settled, as a session left it: the revision on disk (`observedDigest`,
 * undefined when the file was deleted), the text the harness accounted for before it (`standing`) and the text a revert
 * writes back (`restoreTo`; for a gated write whose text another writer replaced it is the reviewed text). Held in memory
 * by `SoulController` and kept here too, so a session that ends without `close()` does not leave the change to be
 * accepted unreviewed by the next one.
 */
export interface SoulHold {
	readonly observedDigest: string | undefined;
	readonly standing: string | undefined;
	readonly restoreTo: string | undefined;
}

export type SoulHoldRead =
	| { readonly kind: "none" }
	| { readonly kind: "hold"; readonly hold: SoulHold }
	| { readonly kind: "unreadable"; readonly reason: string };

const isOptionalText = (value: unknown): value is string | null | undefined =>
	value === undefined || value === null || typeof value === "string";

/** Strict: any field out of shape makes the marker unreadable, never a partly trusted hold. */
function parseHold(text: string): SoulHold {
	const value: unknown = JSON.parse(text);
	if (!isPlainRecord(value) || value.version !== HOLD_VERSION) throw new Error("unknown soul hold version");
	const { observedDigest, standing, restoreTo } = value;
	if (!isOptionalText(observedDigest) || !isOptionalText(standing) || !isOptionalText(restoreTo))
		throw new Error("malformed soul hold");
	if (typeof observedDigest === "string" && !/^[0-9a-f]{64}$/.test(observedDigest))
		throw new Error("malformed soul hold digest");
	const standingText = standing ?? undefined;
	return {
		observedDigest: observedDigest ?? undefined,
		standing: standingText,
		// A restore text equal to the standing text is not stored twice.
		restoreTo: restoreTo === undefined ? standingText : (restoreTo ?? undefined),
	};
}

export function readSoulHold(agentDir: string): SoulHoldRead {
	try {
		const text = readOptionalBoundedTextFileSync(soulHeldFile(agentDir), MAX_HOLD_BYTES, "soul hold");
		return text === undefined ? { kind: "none" } : { kind: "hold", hold: parseHold(text) };
	} catch (error) {
		return { kind: "unreadable", reason: error instanceof Error ? error.message : String(error) };
	}
}

/** Atomically replaces the marker; throws when it cannot be kept (the caller says so in plain words). */
export function writeSoulHold(agentDir: string, hold: SoulHold): void {
	const text = `${JSON.stringify({
		version: HOLD_VERSION,
		observedDigest: hold.observedDigest ?? null,
		standing: hold.standing ?? null,
		...(hold.restoreTo === hold.standing ? {} : { restoreTo: hold.restoreTo ?? null }),
	})}\n`;
	if (Buffer.byteLength(text, "utf8") > MAX_HOLD_BYTES) throw new Error("the held change is too large to keep");
	writeFileAtomicSync(soulHeldFile(agentDir), text);
}

export function clearSoulHold(agentDir: string): void {
	rmSync(soulHeldFile(agentDir), { force: true });
}
