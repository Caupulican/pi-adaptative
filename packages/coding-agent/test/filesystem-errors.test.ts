import { describe, expect, it } from "vitest";
import { isMissingFileError } from "../src/core/util/atomic-file.ts";
import { isMissingPathError } from "../src/core/util/filesystem-errors.ts";

describe("missing resource classification", () => {
	it.each(["ENOENT", "ENOTDIR"])("permits alternate lookup for %s", (code) => {
		expect(isMissingPathError(Object.assign(new Error("synthetic missing resource"), { code }))).toBe(true);
	});
	it.each([null, undefined, "ENOENT", {}, { code: 2 }, { code: "EACCES" }, { code: "EIO" }, { code: "ELOOP" }])(
		"does not classify %j as a missing path",
		(error) => {
			expect(isMissingPathError(error)).toBe(false);
		},
	);
	it("keeps atomic-file absence narrower than alternate-path lookup", () => {
		const error = { code: "ENOTDIR" };
		expect(isMissingPathError(error)).toBe(true);
		expect(isMissingFileError(error)).toBe(false);
		expect(isMissingFileError({ code: "ENOENT" })).toBe(true);
	});
});
