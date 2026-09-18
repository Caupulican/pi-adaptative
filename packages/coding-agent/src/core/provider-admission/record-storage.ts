import { readFileSync, rmSync } from "node:fs";
import { isMissingFileError } from "../util/atomic-file.ts";

/**
 * Read one admission record while its caller holds the path or ledger lock.
 * Missing files and malformed JSON have no usable record. Other read failures
 * must propagate: unavailable state cannot establish spare capacity or a cleared cooldown.
 * The caller owns shape, expiry and process-liveness validation.
 */
export function readProviderAdmissionRecord(path: string): unknown {
	let content: string;
	try {
		content = readFileSync(path, "utf-8");
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		throw error;
	}
	try {
		return JSON.parse(content) as unknown;
	} catch {
		rmSync(path, { force: true });
		return undefined;
	}
}
