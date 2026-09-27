// @isolated: fault-injects descriptor close and supplies a custom Bash backend
import { readdirSync } from "node:fs";
import { DEFAULT_MAX_BYTES } from "@caupulican/pi-agent-core/truncate";
import { describe, expect, it, vi } from "vitest";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { tempDir } from "./temp-dir.ts";

const closeSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		closeSync: (fd: number) => {
			actual.closeSync(fd);
			closeSyncMock(fd);
		},
	};
});

import { createBashTool } from "../src/core/tools/bash.ts";

describe("Bash output close publication", () => {
	it("invalidates the final artifact path when descriptor close reports failure", async () => {
		const root = tempDir("pi-bash-close-publication-");
		const outputDirectory = tempDir("pi-bash-close-publication-output-");
		closeSyncMock.mockImplementation(() => {
			throw Object.assign(new Error("simulated close failure"), { code: "EIO" });
		});
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.alloc(DEFAULT_MAX_BYTES + 1, 0x78));
				return { exitCode: 0 };
			},
		};
		const bash = createBashTool(root, { operations, outputDirectory });

		const result = await bash.execute("close-failure", { command: "chatty-command" });

		expect(result.details?.fullOutputPath).toBeUndefined();
		expect(result.details?.fullOutputError).toContain("simulated close failure");
		expect(readdirSync(outputDirectory)).toEqual([]);
	});
});
