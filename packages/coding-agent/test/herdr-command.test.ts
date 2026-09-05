import { describe, expect, it } from "vitest";
import { herdrCommand } from "../src/core/collaboration/herdr-command.ts";

describe("managed shell command rendering", () => {
	it("escapes bounded environment overrides in the exact shell dialect", () => {
		expect(herdrCommand("/source/node", ["a'b", "--collaboration-peer"], "linux", { PI_PACKAGE_DIR: "a'b" })).toBe(
			"PI_PACKAGE_DIR='a'\\''b' '/source/node' 'a'\\''b' '--collaboration-peer'",
		);
		expect(herdrCommand("C:\\Pi\\pi.cmd", ["a'b", "--collaboration-peer"], "win32", { PI_PACKAGE_DIR: "" })).toBe(
			"$env:PI_PACKAGE_DIR=''; & 'C:\\Pi\\pi.cmd' 'a''b' '--collaboration-peer'",
		);
		expect(() => herdrCommand("pi", [], "linux", { "BAD;NAME": "value" })).toThrow();
		expect(() => herdrCommand("pi", [], "linux", { KEY: "bad\0value" })).toThrow();
	});
});
