import { afterEach, describe, expect, it, vi } from "vitest";
import { runCredentialCliCommand } from "../src/core/secrets/credential-cli-command.ts";
import { spawnProcess } from "../src/utils/child-process.ts";

vi.mock("../src/utils/child-process.ts", () => ({
	spawnProcess: vi.fn(() => ({ stdin: { end: vi.fn() }, stdout: null, stderr: null })),
	waitForChildProcessWithTermination: vi.fn(async () => ({ code: 0, reason: "exited" })),
}));

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

describe("credential CLI environment ownership", () => {
	it.each(["win32", "linux"])("applies omissions using native %s environment semantics", async (platform) => {
		vi.stubEnv("pi_fixture_owner", "synthetic-owner-only");
		const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
		try {
			// Only the process boundary is exercised; all child I/O is mocked, with no host path probes.
			Object.defineProperty(process, "platform", { ...descriptor, value: platform });
			const result = await runCredentialCliCommand({
				executable: "synthetic-cli",
				args: ["status"],
				authEnvironment: { name: "BW_SESSION", value: "synthetic-session" },
				omitEnvironmentVariables: ["PI_FIXTURE_OWNER"],
			});
			expect(result.exitCode).toBe(0);
		} finally {
			Object.defineProperty(process, "platform", descriptor);
		}
		const sent = vi.mocked(spawnProcess).mock.calls[0][2]?.env;
		expect(sent?.pi_fixture_owner).toBe(platform === "win32" ? undefined : "synthetic-owner-only");
		expect(sent?.BW_SESSION).toBe("synthetic-session");
		expect(sent?.NO_COLOR).toBe("1");
	});
});
