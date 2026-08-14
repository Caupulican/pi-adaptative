/**
 * Fault-injecting implementation of the production `FaultableFs` seam
 * (`src/core/util/faultable-fs.ts`). Wraps real `node:fs` sync calls, counts every mutating
 * operation a durable store issues (`mkdirSync`/`writeFileSync`/`renameSync`/`unlinkSync`) against
 * one global counter, and can be configured to fault at a specific, seeded, and fully deterministic
 * point — never on wall-clock or `Math.random()` timing (design rule §0.1).
 *
 * Three fault modes (blueprint §2):
 *  - `failAtOp(n)`      — throw EIO on the Nth mutating op; the op never happens (no partial write).
 *  - `tornWriteAtOp(n)` — on the Nth mutating op, if it is a `writeFileSync`, actually persist only a
 *                         seeded-length prefix of the content to disk, THEN throw. This is the one
 *                         mode that can leave a corrupt file behind (a real torn write does exactly
 *                         this: the OS commits some prefix of the buffer before the crash). Op kinds
 *                         other than `writeFileSync` have no "prefix" to tear, so they fail closed
 *                         the same way `failAtOp` does — the op does not happen.
 *  - `enospcAfterBytes(b)` — once cumulative bytes written across all `writeFileSync` calls exceeds
 *                         `b`, every subsequent mutating op throws ENOSPC (disk full never self-heals
 *                         mid-scenario, matching real ENOSPC until something frees space).
 *
 * Reads are never faulted (see the production module's header comment): a "crash" in this model is
 * always a mutation not completing; restart recovery always reads the real, unfaulted surviving
 * files, which is what the crash-sweep pilots exercise.
 */

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { FaultableFs, FaultableFsWriteFileOptions } from "../../src/core/util/faultable-fs.ts";
import { SeededRandom } from "./seeded-random.ts";

export type FaultableFsOpKind = "mkdir" | "writeFile" | "rename" | "unlink";

export type FaultInjectionMode =
	| { kind: "none" }
	| { kind: "failAtOp"; op: number }
	| { kind: "tornWriteAtOp"; op: number; seed: number }
	| { kind: "enospcAfterBytes"; bytes: number };

export interface FaultableFsOpLogEntry {
	index: number;
	kind: FaultableFsOpKind;
	path: string;
	faulted: boolean;
	torn?: { requestedBytes: number; writtenBytes: number };
}

export interface FaultableFsHarness {
	/** Pass this to a production store's `fs` constructor option. */
	fs: FaultableFs;
	/** Total mutating ops issued so far (1-based next index == opCount() + 1). */
	opCount(): number;
	/** Full log of every mutating op issued, in order, for debugging a sweep failure. */
	log(): readonly FaultableFsOpLogEntry[];
	/** The op index (1-based) that actually faulted, if any. */
	faultedAtOp(): number | undefined;
}

function fsError(code: string, message: string): NodeJS.ErrnoException {
	const error = new Error(message) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

/**
 * Build a fault-injecting `FaultableFs`. `mode: {kind:"none"}` (the default) is a pure op-counting
 * pass-through over real `node:fs` — this is how a scenario measures its clean-run op count `K`
 * before sweeping `failAtOp(1..K)`.
 */
export function createFaultableFsHarness(mode: FaultInjectionMode = { kind: "none" }): FaultableFsHarness {
	let opIndex = 0;
	let bytesWritten = 0;
	let faultedAtOp: number | undefined;
	const entries: FaultableFsOpLogEntry[] = [];

	function shouldFaultAt(index: number): boolean {
		if (mode.kind === "failAtOp" || mode.kind === "tornWriteAtOp") return index === mode.op;
		if (mode.kind === "enospcAfterBytes") return bytesWritten > mode.bytes;
		return false;
	}

	// Handles mkdir/rename/unlink — writeFileSync is routed through writeFileWithTornSupport
	// instead, since it is the only op kind with content that can be torn.
	function recordAndMaybeFault(
		kind: Exclude<FaultableFsOpKind, "writeFile">,
		path: string,
		perform: () => void,
	): void {
		opIndex += 1;
		const index = opIndex;
		if (shouldFaultAt(index)) {
			faultedAtOp = index;
			entries.push({ index, kind, path, faulted: true });
			if (mode.kind === "enospcAfterBytes") {
				throw fsError("ENOSPC", `Simulated ENOSPC: cumulative writes exceeded ${mode.bytes} bytes at op ${index}.`);
			}
			throw fsError("EIO", `Simulated EIO: destructive-fs fault at op ${index} (${kind} ${path}).`);
		}
		entries.push({ index, kind, path, faulted: false });
		perform();
	}

	function writeFileWithTornSupport(path: string, data: string, options?: FaultableFsWriteFileOptions): void {
		opIndex += 1;
		const index = opIndex;
		const dataBytes = Buffer.byteLength(data, "utf-8");
		if (mode.kind === "enospcAfterBytes" && bytesWritten > mode.bytes) {
			faultedAtOp = index;
			entries.push({ index, kind: "writeFile", path, faulted: true });
			throw fsError("ENOSPC", `Simulated ENOSPC: cumulative writes exceeded ${mode.bytes} bytes at op ${index}.`);
		}
		if (mode.kind === "tornWriteAtOp" && index === mode.op) {
			faultedAtOp = index;
			// Seeded prefix length: deterministic given (mode.seed, path, dataBytes) so the exact same
			// torn content is produced every time this sweep point is replayed.
			const random = new SeededRandom(mode.seed);
			const prefixBytes = dataBytes === 0 ? 0 : random.nextInt(0, dataBytes - 1);
			const truncated = Buffer.from(data, "utf-8").subarray(0, prefixBytes);
			writeFileSync(path, truncated, options === "utf-8" ? undefined : { flag: options?.flag, mode: options?.mode });
			entries.push({
				index,
				kind: "writeFile",
				path,
				faulted: true,
				torn: { requestedBytes: dataBytes, writtenBytes: prefixBytes },
			});
			throw fsError(
				"EIO",
				`Simulated torn write: op ${index} persisted ${prefixBytes}/${dataBytes} bytes of ${path}.`,
			);
		}
		if (mode.kind === "failAtOp" && index === mode.op) {
			faultedAtOp = index;
			entries.push({ index, kind: "writeFile", path, faulted: true });
			throw fsError("EIO", `Simulated EIO: destructive-fs fault at op ${index} (writeFile ${path}).`);
		}
		entries.push({ index, kind: "writeFile", path, faulted: false });
		writeFileSync(path, data, options);
		bytesWritten += dataBytes;
	}

	const fs: FaultableFs = {
		mkdirSync(path, options) {
			recordAndMaybeFault("mkdir", path, () => mkdirSync(path, options));
		},
		writeFileSync(path, data, options) {
			writeFileWithTornSupport(path, data, options);
		},
		renameSync(oldPath, newPath) {
			recordAndMaybeFault("rename", `${oldPath} -> ${newPath}`, () => renameSync(oldPath, newPath));
		},
		unlinkSync(path) {
			recordAndMaybeFault("unlink", path, () => unlinkSync(path));
		},
	};

	return {
		fs,
		opCount: () => opIndex,
		log: () => entries,
		faultedAtOp: () => faultedAtOp,
	};
}
