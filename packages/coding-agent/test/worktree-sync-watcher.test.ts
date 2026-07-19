import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorktreeSyncEpoch } from "../src/core/worktree-sync/codes.ts";
import { syncStorePaths, writeEpoch } from "../src/core/worktree-sync/store.ts";
import { formatEpochNotice, startEpochWatcher } from "../src/core/worktree-sync/watcher.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function epoch(overrides: Partial<WorktreeSyncEpoch>): WorktreeSyncEpoch {
	return {
		epoch: 1,
		mainSha: "abc",
		changedPaths: [],
		changedPathsTruncated: false,
		...overrides,
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("epoch watcher", () => {
	it("formatEpochNotice is deterministic and names the epoch, lander, files, and recovery action", () => {
		const text = formatEpochNotice(
			epoch({ epoch: 7, landedLaneKey: "g1-2", changedPaths: ["src/a.ts", "src/b.ts"] }),
			"g1-1",
		);
		expect(text).toContain("epoch 7");
		expect(text).toContain("landed by lane 'g1-2'");
		expect(text).toContain("src/a.ts, src/b.ts");
		expect(text).toContain(`worktree_sync {"action":"sync"}`);
		expect(text).toContain("lane 'g1-1'");
	});

	it("notifies on an epoch advance by ANOTHER lane, never for the baseline or its own lands", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-wt-sync-watch-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const paths = syncStorePaths(dir);
		mkdirSync(paths.root, { recursive: true });
		await writeEpoch(paths, epoch({ epoch: 1, landedLaneKey: "other" }));

		const notices: string[] = [];
		const watcher = startEpochWatcher({
			epochFile: paths.epochFile,
			laneKey: "mine",
			notify: (text) => notices.push(text),
			debounceMs: 10,
		});
		cleanups.push(() => watcher.stop());

		// Baseline settles without a notice.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(notices).toHaveLength(0);

		// Another lane lands -> exactly one notice.
		await writeEpoch(paths, epoch({ epoch: 2, landedLaneKey: "other", changedPaths: ["x.ts"] }));
		await waitUntil(() => notices.length === 1);
		expect(notices[0]).toContain("epoch 2");
		expect(notices[0]).toContain("x.ts");

		// Our own land advances the epoch -> no self-notice.
		await writeEpoch(paths, epoch({ epoch: 3, landedLaneKey: "mine" }));
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(notices).toHaveLength(1);

		// A later foreign land notifies again.
		await writeEpoch(paths, epoch({ epoch: 4, landedLaneKey: "other" }));
		await waitUntil(() => notices.length === 2);
		expect(notices[1]).toContain("epoch 4");
	}, 20_000);
});
