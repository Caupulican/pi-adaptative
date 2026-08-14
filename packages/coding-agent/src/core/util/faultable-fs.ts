/**
 * Injection seam for the narrow set of synchronous mutating filesystem operations that durable
 * stores actually issue on their write path (`mkdirSync`, `writeFileSync`, `renameSync`,
 * `unlinkSync`). Production code always uses {@link nodeFs}, the real `node:fs` bindings, via each
 * store's `fs` constructor option defaulting to it — so wiring this seam changes nothing for any
 * existing caller that does not pass `fs` explicitly.
 *
 * The destructive-testing harness (`test-destructive/harness/faultable-fs.ts`) implements this same
 * interface with a fault-injecting variant (`failAtOp`, `tornWriteAtOp`, `enospcAfterBytes`) to drive
 * crash-consistency sweeps without touching real disks or real timers. Read ops are intentionally
 * excluded: a "crash" in this model is always a `node:fs`-mutating operation not completing; restart
 * recovery always reads the real, unfaulted surviving files.
 */

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export type FaultableFsWriteFileOptions = { encoding?: "utf-8"; flag?: string; mode?: number } | "utf-8";

/** The mutating fs primitives a durable store's write path issues, kept 1:1 with actual call sites. */
export interface FaultableFs {
	mkdirSync(path: string, options: { recursive: true }): void;
	writeFileSync(path: string, data: string, options?: FaultableFsWriteFileOptions): void;
	renameSync(oldPath: string, newPath: string): void;
	unlinkSync(path: string): void;
}

/** The real `node:fs` bindings, wrapped to satisfy {@link FaultableFs}. Zero behavior change vs. calling `node:fs` directly. */
export const nodeFs: FaultableFs = {
	mkdirSync: (path, options) => {
		mkdirSync(path, options);
	},
	writeFileSync: (path, data, options) => {
		writeFileSync(path, data, options);
	},
	renameSync: (oldPath, newPath) => {
		renameSync(oldPath, newPath);
	},
	unlinkSync: (path) => {
		unlinkSync(path);
	},
};
