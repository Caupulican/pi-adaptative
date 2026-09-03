import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectMemoryDir, projectMemoryRoot } from "../src/core/agent-paths.ts";
import { getPrivateLaneDeniedPaths } from "../src/core/autonomy/lane-private-paths.ts";

describe("private lane denied paths", () => {
	it("keeps every project's hot memory private to the main lane", () => {
		const agentDir = join("/tmp", "agent");
		const denied = getPrivateLaneDeniedPaths("/work", agentDir);
		expect(denied).toContain(projectMemoryRoot(agentDir));
		expect(projectMemoryDir(agentDir, "0123456789abcdef")).toBe(
			join(agentDir, "memory", "projects", "0123456789abcdef"),
		);
		expect(() => projectMemoryDir(agentDir, "nope")).toThrow(/16-character/);
	});
});
