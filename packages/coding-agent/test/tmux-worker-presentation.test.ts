import { describe, expect, it } from "vitest";
import {
	buildLaunchProfileFlags,
	ONE_SHOT_LAUNCH_PROFILE_SOURCE,
} from "../src/bundled-resources/extensions/tmux-agent-manager/dispatch-grant.ts";

describe("tmux worker presentation", () => {
	it("marks every managed Pi child as an unattended worker terminal", () => {
		expect(buildLaunchProfileFlags(ONE_SHOT_LAUNCH_PROFILE_SOURCE)).toContainEqual({
			flag: "--session-mode",
			value: "worker",
		});
	});
});
