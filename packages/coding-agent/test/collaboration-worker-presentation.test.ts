import { describe, expect, it } from "vitest";
import { buildLaunchProfileFlags, deriveWorkerLaunchProfile } from "../src/core/collaboration/launch-profile.ts";

describe("collaboration worker presentation", () => {
	it("marks every managed Pi child as an unattended worker terminal", () => {
		const profile = deriveWorkerLaunchProfile({ identity: "presentation-test" });
		expect(buildLaunchProfileFlags(profile)).toContainEqual({
			flag: "--session-mode",
			value: "worker",
		});
	});
});
