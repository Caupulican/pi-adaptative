import { describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, ENV_SESSION_DIR, toEnvVarName } from "../src/config.ts";

// A portable POSIX env-var name: a letter or underscore, then letters/digits/underscores.
// A hyphen is NOT allowed — `export PI-ADAPTATIVE_...=x` is a shell parse error, which is the
// exact bug this guards against.
const POSIX_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

describe("toEnvVarName", () => {
	it("passes an already-valid single-word name through unchanged (just uppercased)", () => {
		expect(toEnvVarName("pi", "CODING_AGENT_DIR")).toBe("PI_CODING_AGENT_DIR");
	});

	it("collapses the hyphen in pi-adaptative so the name is shell-exportable", () => {
		expect(toEnvVarName("pi-adaptative", "CODING_AGENT_DIR")).toBe("PI_ADAPTATIVE_CODING_AGENT_DIR");
	});

	it("collapses every character invalid in a POSIX name to underscore", () => {
		expect(toEnvVarName("my.weird app!", "X")).toBe("MY_WEIRD_APP__X");
	});

	it("prefixes an underscore when the sanitized name would start with a digit", () => {
		expect(toEnvVarName("2fast", "DIR")).toBe("_2FAST_DIR");
	});

	it("produces shell-valid, hyphen-free names for the exported constants", () => {
		expect(ENV_AGENT_DIR).toMatch(POSIX_ENV_NAME);
		expect(ENV_SESSION_DIR).toMatch(POSIX_ENV_NAME);
		expect(ENV_AGENT_DIR).not.toContain("-");
		expect(ENV_SESSION_DIR).not.toContain("-");
	});
});
