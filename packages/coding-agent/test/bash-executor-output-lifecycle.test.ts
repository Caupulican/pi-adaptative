// @isolated: mocks the legacy spill writer and Git filter and mutates the agent-dir environment
import { EventEmitter } from "node:events";
import { readdirSync, type WriteStream, writeFileSync } from "node:fs";
import { DEFAULT_MAX_BYTES } from "@caupulican/pi-agent-core/truncate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { tempDir } from "./temp-dir.ts";

const createSafeWriteStreamMock = vi.hoisted(() => vi.fn());
const endWriteStreamMock = vi.hoisted(() => vi.fn());
const executeFilteredGitMock = vi.hoisted(() => vi.fn());

vi.mock("../src/utils/safe-write-stream.ts", () => ({
	createSafeWriteStream: createSafeWriteStreamMock,
	endWriteStream: endWriteStreamMock,
}));

vi.mock("../src/core/tools/git-filter.ts", () => ({
	applyGitTailStage: (output: string) => output,
	classifyGitCommand: () => ({ eligible: true, subcommand: "show", globalOptions: [], subcommandArgs: [] }),
	executeFilteredGit: executeFilteredGitMock,
}));

import { executeBashWithOperations } from "../src/core/bash-executor.ts";

const AGENT_DIR_ENV = "PI_ADAPTATIVE_CODING_AGENT_DIR";

function spillStream(): WriteStream {
	const stream = new EventEmitter() as WriteStream;
	Object.defineProperties(stream, {
		closed: { value: false },
		destroyed: { value: false },
		errored: { value: null },
		writableEnded: { value: false },
		writableFinished: { value: false },
	});
	stream.write = vi.fn(() => false) as unknown as WriteStream["write"];
	stream.end = vi.fn(() => stream) as unknown as WriteStream["end"];
	return stream;
}

function emittingOperations(data: Buffer, error?: Error): BashOperations {
	return {
		exec: async (_command, _cwd, { onData }) => {
			onData(data);
			if (error) throw error;
			return { exitCode: 0 };
		},
	};
}

async function resolvesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timed-out"> {
	return Promise.race([
		promise,
		new Promise<"timed-out">((resolve) => {
			setTimeout(() => resolve("timed-out"), timeoutMs);
		}),
	]);
}

beforeEach(() => {
	process.env[AGENT_DIR_ENV] = tempDir("pi-bash-output-lifecycle-");
	createSafeWriteStreamMock.mockReset().mockImplementation((path: string) => {
		writeFileSync(path, "partial");
		return spillStream();
	});
	endWriteStreamMock.mockReset().mockResolvedValue(undefined);
	executeFilteredGitMock.mockReset();
});

afterEach(() => {
	delete process.env[AGENT_DIR_ENV];
});

describe("bash-executor output lifecycle", () => {
	it("does not wait on a push-only spill writer that never drains", async () => {
		let release: (() => void) | undefined;
		endWriteStreamMock.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const execution = executeBashWithOperations(
			"chatty-command",
			process.cwd(),
			emittingOperations(Buffer.alloc(DEFAULT_MAX_BYTES + 1, 0x78)),
		);

		try {
			const result = await resolvesWithin(execution, 100);
			expect(result).not.toBe("timed-out");
		} finally {
			release?.();
			await execution;
		}
	});

	it("removes an unpublished spill when the backend fails", async () => {
		const agentDir = process.env[AGENT_DIR_ENV] ?? "";
		await expect(
			executeBashWithOperations(
				"failing-command",
				process.cwd(),
				emittingOperations(Buffer.alloc(DEFAULT_MAX_BYTES + 1, 0x78), new Error("backend failed")),
			),
		).rejects.toThrow("backend failed");

		const logs = readdirSync(agentDir, { recursive: true }).filter((entry) => String(entry).endsWith(".log"));
		expect(logs).toEqual([]);
	});

	it("does not publish a retained Git head as complete output after overflow loss", async () => {
		executeFilteredGitMock.mockResolvedValue({
			output: "filtered",
			exitCode: 0,
			rawOut: "x".repeat(DEFAULT_MAX_BYTES + 1),
		});

		const result = await executeBashWithOperations(
			"git show HEAD",
			process.cwd(),
			emittingOperations(Buffer.alloc(0)),
			{
				enableGitFilter: true,
			},
		);

		expect(result.truncated).toBe(true);
		expect(result.fullOutputPath).toBeUndefined();
	});
});
