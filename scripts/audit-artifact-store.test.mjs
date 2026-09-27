import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	gitAuditDirectory,
	writeBoundedAuditArtifact,
} from "./audit-artifact-store.mjs";

test("audit artifacts live under git metadata instead of docs", () => {
	assert.equal(
		gitAuditDirectory("/repo", "architecture", () => ".git"),
		join("/repo", ".git", "pi-audits", "architecture"),
	);
});

test("audit retention bounds managed files by count and bytes without deleting foreign files", (context) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-audit-artifacts-"));
	context.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(join(directory, "foreign.txt"), "keep", "utf8");

	for (const prefix of ["a", "b", "c", "d", "e"]) {
		writeBoundedAuditArtifact({
			directory,
			fileName: `${prefix.repeat(40)}-architecture-audit.json`,
			content: "1234567890",
			managedSuffix: "-architecture-audit.json",
			maxFiles: 3,
			maxBytes: 100,
		});
	}
	assert.deepEqual(readdirSync(directory).sort(), [
		`${"c".repeat(40)}-architecture-audit.json`,
		`${"d".repeat(40)}-architecture-audit.json`,
		`${"e".repeat(40)}-architecture-audit.json`,
		"foreign.txt",
	]);

	writeBoundedAuditArtifact({
		directory,
		fileName: `${"f".repeat(40)}-architecture-audit.json`,
		content: "x".repeat(80),
		managedSuffix: "-architecture-audit.json",
		maxFiles: 3,
		maxBytes: 85,
	});
	assert.deepEqual(readdirSync(directory).sort(), [
		`${"f".repeat(40)}-architecture-audit.json`,
		"foreign.txt",
	]);
});

test("an oversized current artifact is rejected before it can exceed the store bound", (context) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-audit-artifacts-"));
	context.after(() => rmSync(directory, { recursive: true, force: true }));

	assert.throws(
		() =>
			writeBoundedAuditArtifact({
				directory,
				fileName: `${"a".repeat(40)}-architecture-audit.json`,
				content: "123456",
				managedSuffix: "-architecture-audit.json",
				maxBytes: 5,
			}),
		/Artifact exceeds maxBytes/,
	);
	assert.deepEqual(readdirSync(directory), []);
});

test("a failed prune cannot publish the new artifact beyond the existing bound", (context) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-audit-artifacts-"));
	context.after(() => rmSync(directory, { recursive: true, force: true }));
	const oldName = `${"a".repeat(40)}-architecture-audit.json`;
	const newName = `${"b".repeat(40)}-architecture-audit.json`;
	writeFileSync(join(directory, oldName), "old", "utf8");

	assert.throws(
		() =>
			writeBoundedAuditArtifact({
				directory,
				fileName: newName,
				content: "new",
				managedSuffix: "-architecture-audit.json",
				maxFiles: 1,
				removeArtifact: () => {
					throw new Error("prune failed");
				},
			}),
		/prune failed/,
	);
	assert.equal(existsSync(join(directory, newName)), false);
	assert.deepEqual(readdirSync(directory), [oldName]);
});
