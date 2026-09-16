import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { killTree, killTreeNow } from "../../src/reliability/process-tree.ts";

const detail = "Process ancestry snapshot failed: ETIMEDOUT (limit 5000ms)";
vi.mock("../../src/reliability/process-termination-protection.ts", () => ({
	readProcessTerminationProtection: (onDiagnostic?: (message: string) => void) => {
		onDiagnostic?.("Process ancestry snapshot failed: ETIMEDOUT (limit 5000ms)");
		return undefined;
	},
}));

afterEach(() => vi.restoreAllMocks());

describe("process termination refusal evidence", () => {
	it("reports the snapshot failure and never signals an unverified target", async () => {
		const signal = vi.spyOn(process, "kill").mockReturnValue(true);
		const diagnostics: string[] = [];
		const child = Object.assign(new EventEmitter(), {
			pid: 4242,
			exitCode: null,
			signalCode: null,
		}) as unknown as ChildProcess;
		expect(await killTree(child, { onDiagnostic: (message) => diagnostics.push(message) })).toBe("failed");
		expect(diagnostics.join("\n")).toContain(detail);
		expect(killTreeNow(4242)).toMatchObject({ success: false, error: expect.stringContaining(detail) });
		expect(signal).not.toHaveBeenCalled();
	});
});
