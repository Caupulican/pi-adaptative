import { describe, expect, it } from "vitest";
import { normalizePath, resolvePath } from "../src/utils/paths.ts";

describe("execution backend path semantics", () => {
	it("resolves Windows paths independently of the host machine", () => {
		expect(resolvePath("src/example.ts", "Q:\\fixture workspace", { flavor: "win32" })).toBe(
			"Q:\\fixture workspace\\src\\example.ts",
		);
		expect(resolvePath("../example.ts", "\\\\fixture-server\\share\\repo", { flavor: "win32" })).toBe(
			"\\\\fixture-server\\share\\example.ts",
		);
	});
	it("uses the supplied home for both the input and its base directory", () => {
		expect(resolvePath("child", "~/repo", { flavor: "posix", homeDir: "/fixture/home" })).toBe(
			"/fixture/home/repo/child",
		);
		expect(normalizePath("~\\repo", { flavor: "win32", homeDir: "R:\\fixture" })).toBe("R:\\fixture\\repo");
	});
	it("decodes file URLs with the backend dialect, including UNC hosts", () => {
		expect(resolvePath("file:///Q:/fixture%20repo/a.ts", "Q:\\", { flavor: "win32" })).toBe("Q:\\fixture repo\\a.ts");
		expect(normalizePath("file://fixture-server/share/a.ts", { flavor: "win32" })).toBe(
			"\\\\fixture-server\\share\\a.ts",
		);
	});
	it("preserves literal filename bytes under POSIX semantics", () => {
		expect(resolvePath("C:\\literal", "/fixture", { flavor: "posix" })).toBe("/fixture/C:\\literal");
		expect(resolvePath("e\u0301 \u00a0.txt", "/fixture", { flavor: "posix" })).toBe("/fixture/e\u0301 \u00a0.txt");
	});
	it("does not use ambient per-drive state for a drive-relative Windows path", () => {
		expect(() => resolvePath("R:other", "Q:\\fixture", { flavor: "win32" })).toThrow(/drive-relative/i);
	});
	it("does not borrow the host home for an explicit backend", () => {
		expect(() => normalizePath("~/file", { flavor: "win32" })).toThrow(/home/i);
	});
	it("binds a Windows root-relative input to the explicit current drive", () => {
		expect(resolvePath("/folder/file", "Q:\\fixture", { flavor: "win32" })).toBe("Q:\\folder\\file");
	});
});
