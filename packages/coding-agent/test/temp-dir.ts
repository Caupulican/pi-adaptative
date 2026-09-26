/**
 * Test scratch directories that remove themselves.
 *
 * `tempDir(prefix)` creates a fresh directory under the (long-path) temp root and removes it when the
 * current test finishes; called while tests are being collected, it is removed after the file's tests.
 * Raw `mkdtempSync` in tests leaked: one file alone left 30 git repositories (75 MB) per run, which
 * piled up on dev machines and filled a Windows CI runner's disk within a single job.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, onTestFinished } from "vitest";
import { removeTreeSync } from "../src/core/util/remove-tree.ts";

function remove(dir: string): void {
	try {
		removeTreeSync(dir);
	} catch (error) {
		// A scratch tree still locked after removeTreeSync's retries must not decide the test's result;
		// it is named so a real handle leak stays visible.
		console.warn(`[temp-dir] could not remove ${dir}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function tempDir(prefix: string): string {
	const dir = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), prefix)));
	try {
		onTestFinished(() => remove(dir));
	} catch {
		// Not inside a running test: this call is part of collecting the file's tests.
		afterAll(() => remove(dir));
	}
	return dir;
}
