import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import { afterEach, describe, expect, it } from "vitest";
import { PathAliasRuntime } from "../src/core/context/path-alias-session.ts";

function toolResult(text: string, timestamp: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `t-${timestamp}`,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

describe("PathAliasRuntime", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("resumes frozen aliases from sqlite without rescanning older messages", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-path-alias-runtime-"));
		tempDirs.push(dir);
		const databasePath = join(dir, "runtime.sqlite");
		const first = new PathAliasRuntime(
			() => "/repo",
			() => databasePath,
			() => 1,
		);
		const firstSync = first.sync([
			toolResult("packages/coding-agent/src/foo.ts", 10),
			toolResult("packages/coding-agent/test/foo.ts", 11),
		]);
		expect(firstSync.legend).toContain("p/src/foo.ts=packages/coding-agent/src/foo.ts");
		expect(firstSync.legend).toContain("p/test/foo.ts=packages/coding-agent/test/foo.ts");
		first.close();

		const second = new PathAliasRuntime(
			() => "/repo",
			() => databasePath,
			() => 2,
		);
		const resumed = second.sync([toolResult("packages/coding-agent/src/foo.ts", 11)]);
		expect(resumed.legend).toContain("p/src/foo.ts=packages/coding-agent/src/foo.ts");
		expect(resumed.legend).toContain("p/test/foo.ts=packages/coding-agent/test/foo.ts");
		expect(second.peekTable().entries.find((entry) => entry.path.endsWith("/src/foo.ts"))?.id).toBe("p/src/foo.ts");
		second.close();
	});
});
