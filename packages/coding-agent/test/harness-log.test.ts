import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openHarnessLogFiles } from "../src/core/log/harness-log-files.ts";
import { harnessLog } from "../src/kernel/harness-log.ts";

const MIB = 1024 * 1024;
const DAY_MS = 86_400_000;

afterEach(() => {
	harnessLog.flush();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it("keeps oversized nested entries valid and bounds a burst without writing on the caller path", () => {
	vi.stubEnv("PI_LOG_LEVEL", undefined);
	vi.stubEnv("PI_LOG_CATEGORIES", undefined);
	const append = vi.fn<(batch: string, bytes: number) => void>();
	harnessLog.configure({ append });
	harnessLog.warn("test", "oversized details", { nested: Array(40).fill("界".repeat(1000)) });
	for (let index = 0; index < 500; index++) {
		harnessLog.warn("test", "burst", { details: "界".repeat(1000) });
	}
	expect(append).not.toHaveBeenCalled();
	harnessLog.flush();
	expect(append).toHaveBeenCalledTimes(1);
	const [batch, bytes] = append.mock.calls[0]!;
	expect(bytes).toBe(Buffer.byteLength(batch));
	expect(bytes).toBeLessThanOrEqual(128 * 1024);
	const lines = batch.trimEnd().split("\n");
	expect(JSON.parse(lines[0]!)).toMatchObject({ msg: "oversized details", truncated: true });
	for (const line of lines) {
		expect(Buffer.byteLength(line) + 1).toBeLessThanOrEqual(16 * 1024);
		expect(JSON.parse(line).cat).toBe("test");
	}
});

it("rotates before crossing the configured limit and prunes only managed segments", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-harness-log-test-"));
	const now = Date.now();
	const name = (daysAgo: number) => `harness-${new Date(now - daysAgo * DAY_MS).toISOString().slice(0, 10)}.jsonl`;
	const date = vi.spyOn(Date, "now").mockReturnValue(now);
	try {
		for (const daysAgo of [1, 2, 3, 4]) {
			const path = join(dir, name(daysAgo));
			writeFileSync(path, "");
			truncateSync(path, 8 * MIB);
		}
		writeFileSync(join(dir, "harness-user-notes.txt"), "preserve me");
		const writer = openHarnessLogFiles(dir, 1024 / MIB, 4);
		const input = `${"x".repeat(699)}\n`;
		writer.append(input, Buffer.byteLength(input));
		writer.append(input, Buffer.byteLength(input));
		expect(readFileSync(join(dir, name(0)), "utf8")).toBe(input);
		expect(readFileSync(join(dir, `${name(0)}.1`), "utf8")).toBe(input);
		const total = readdirSync(dir)
			.filter((file) => file.includes(".jsonl"))
			.reduce((sum, file) => sum + statSync(join(dir, file)).size, 0);
		expect(total).toBeLessThanOrEqual(32 * MIB);
		expect(readdirSync(dir)).not.toContain(name(4));
		expect(readdirSync(dir)).toContain("harness-user-notes.txt");

		date.mockReturnValue(now + 4 * DAY_MS);
		writer.append(input, Buffer.byteLength(input));
		expect(readdirSync(dir).sort()).toEqual([name(-4), "harness-user-notes.txt"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
