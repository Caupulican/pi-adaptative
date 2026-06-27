import { describe, expect, it } from "vitest";
import { supersedeNearDuplicateLine } from "../src/core/memory/providers/file-store.ts";

/**
 * R5 first-class confrontation: a memory `add` of a near-duplicate fact supersedes the existing line
 * in place instead of appending a redundant copy (anti append-rot).
 */
describe("supersedeNearDuplicateLine (R5 confront-before-write)", () => {
	it("supersedes an existing near-duplicate (reworded) line in place", () => {
		const existing = "- The user prefers using tabs for indentation in all source files\n- Deploy via release script";
		const content = "- The user prefers tabs for indentation in source files";
		const result = supersedeNearDuplicateLine(existing, content);
		expect(result).not.toBeNull();
		expect(result).toContain("prefers tabs for indentation in source files");
		// The reworded near-duplicate replaced the original line (no append-rot)...
		expect(result).not.toContain("using tabs for indentation in all source files");
		// ...and the unrelated line is untouched.
		expect(result).toContain("Deploy via release script");
	});

	it("returns null when the fact is genuinely new (no near-duplicate)", () => {
		const existing = "- The deploy command is npm run release:patch\n- User prefers tabs";
		const content = "- The CI provider is GitHub Actions running on tag push";
		expect(supersedeNearDuplicateLine(existing, content)).toBeNull();
	});

	it("returns null for an empty file (nothing to supersede)", () => {
		expect(supersedeNearDuplicateLine("", "- a brand new fact about something")).toBeNull();
	});

	it("does not supersede a merely topically-related line", () => {
		const existing = "- The kubernetes deployment uses helm charts in the infra directory";
		const content = "- The database backups run nightly via a cron job";
		expect(supersedeNearDuplicateLine(existing, content)).toBeNull();
	});
});
