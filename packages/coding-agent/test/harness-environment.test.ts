import { describe, expect, it } from "vitest";
import { RUNTIME_SUPERVISOR_ENV } from "../src/cli/runtime-channel.ts";
import {
	HARNESS_LAUNCH_ENV_KEYS,
	isSupervisedLaunch,
	withoutHarnessLaunchEnv,
} from "../src/core/harness-environment.ts";

describe("harness launch environment", () => {
	it("strips the supervisor's launch variables from a supervised process, case-insensitively", () => {
		const env = {
			PATH: "/usr/bin",
			PI_PACKAGE_DIR: "/generations/run-1/packages/coding-agent",
			tsx_tsconfig_path: "/generations/run-1/tsconfig.json",
			[RUNTIME_SUPERVISOR_ENV]: JSON.stringify({ parentPid: 1 }),
			PI_AGENT_DIR: "/home/op/.pi/agent",
		};
		expect(isSupervisedLaunch(env)).toBe(true);
		expect(withoutHarnessLaunchEnv(env)).toEqual({ PATH: "/usr/bin", PI_AGENT_DIR: "/home/op/.pi/agent" });
		expect(HARNESS_LAUNCH_ENV_KEYS).toContain(RUNTIME_SUPERVISOR_ENV);
	});

	it("keeps an operator's own PI_PACKAGE_DIR when nothing supervised the launch", () => {
		const env = { PATH: "/usr/bin", PI_PACKAGE_DIR: "/nix/store/abc-pi" };
		expect(isSupervisedLaunch(env)).toBe(false);
		expect(withoutHarnessLaunchEnv(env)).toBe(env);
	});
});
