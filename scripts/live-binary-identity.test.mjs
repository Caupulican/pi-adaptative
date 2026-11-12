import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertLiveBinaryUnchanged, pinLiveBinary } from "./lib/live-binary-identity.mjs";

const releaseCommit = "a".repeat(40);
const releaseTag = `v${process.versions.node}`;
const options = {
	binaryPath: process.execPath,
	releaseTag,
	releaseCommit,
	resolveTagCommit: () => releaseCommit,
};

test("pins one actual executable with resolved release identity and matching version", () => {
	const pinned = pinLiveBinary(options);
	assert.equal(pinned.path, realpathSync(process.execPath));
	assert.equal(pinned.releaseTag, releaseTag);
	assert.equal(pinned.releaseCommit, releaseCommit);
	assert.match(pinned.sha256, /^[0-9a-f]{64}$/);
	assert.ok(Object.isFrozen(pinned));
	assertLiveBinaryUnchanged(pinned);
});

test("rejects a relative command, a different tag target and a different executable version", () => {
	assert.throws(() => pinLiveBinary({ ...options, binaryPath: "pi" }), /absolute/);
	assert.throws(() => pinLiveBinary({ ...options, resolveTagCommit: () => "b".repeat(40) }), /resolved version tag/);
	assert.throws(() => pinLiveBinary({ ...options, releaseTag: "v0.0.0" }), /executable version/);
	assert.throws(() => pinLiveBinary({ ...options, releaseCommit: "main" }), /exact --release-commit/);
	assert.throws(() => pinLiveBinary({ ...options, binaryPath: tmpdir() }), /regular executable/);
	assert.throws(() => pinLiveBinary({ ...options, run: () => ({ status: 1, stdout: "" }) }), /executable version/);
});

test("keeps a path containing spaces and apostrophes and detects changes before or after pinning", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-live-binary-"));
	try {
		const file = join(directory, "standalone pi's executable");
		writeFileSync(file, "original artifact");
		const run = (path, args) => {
			assert.equal(path, realpathSync(file));
			assert.deepEqual(args, ["--version"]);
			return { status: 0, stdout: process.version };
		};
		const pinned = pinLiveBinary({ ...options, binaryPath: file, run });
		writeFileSync(file, "replaced artifact");
		assert.throws(() => assertLiveBinaryUnchanged(pinned), /changed during acceptance/);
		assert.throws(() => pinLiveBinary({
			...options, binaryPath: file,
			run: (path, args) => {
				writeFileSync(file, "changed during version probe");
				return run(path, args);
			},
		}), /changed during acceptance/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
