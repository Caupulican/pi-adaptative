import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeReleaseMutation } from "./release-recovery.mjs";

test("release failures retain current files and original errors at every mutation boundary", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-release-retained-"));
	const owned = join(directory, "release-metadata.json");
	const concurrent = join(directory, "concurrent-work.txt");
	const priorLogger = console.error;
	const diagnostics = [];
	console.error = (message) => diagnostics.push(message);
	try {
		for (const phase of ["prepare", "repair"]) {
			for (const boundary of ["version", "check", "commit", "push", "next-cycle"]) {
				const failure = new Error(`${phase}/${boundary}`);
				assert.throws(() => executeReleaseMutation({ phase, sha: "preflight" }, () => {
					writeFileSync(owned, boundary);
					writeFileSync(concurrent, `other session/${boundary}`);
					throw failure;
				}), (error) => error === failure);
				assert.equal(readFileSync(owned, "utf8"), boundary);
				assert.equal(readFileSync(concurrent, "utf8"), `other session/${boundary}`);
			}
		}
		assert.ok(diagnostics.some((line) => line.includes("unknown remote outcome")));
		assert.ok(diagnostics.some((line) => line.includes("preconditions")));
		assert.ok(diagnostics.some((line) => line.includes("does not prove artifact publication")));
	} finally {
		console.error = priorLogger;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("diagnostic failure cannot replace the release error", () => {
	const priorLogger = console.error;
	const failure = new Error("original mutation failure");
	console.error = () => { throw new Error("logger failed"); };
	try {
		assert.throws(() => executeReleaseMutation({ phase: "prepare", sha: "preflight" }, () => { throw failure; }), (error) => error === failure);
	} finally {
		console.error = priorLogger;
	}
});

test("successful mutation returns its value without failure diagnostics", () => {
	const priorLogger = console.error;
	console.error = () => { throw new Error("unexpected failure diagnostic"); };
	try {
		assert.equal(executeReleaseMutation({ phase: "prepare", sha: "preflight" }, () => "version"), "version");
	} finally {
		console.error = priorLogger;
	}
});

test("both mutation entry points use the retaining owner and have no destructive rollback", () => {
	const release = readFileSync(new URL("./release.mjs", import.meta.url), "utf8");
	assert.match(release, /executeReleaseMutation\(\{ phase: "prepare", sha: preflightSha \}/);
	assert.match(release, /executeReleaseMutation\(\{ phase: "repair", sha: preflightSha \}/);
	assert.doesNotMatch(release, /git (?:reset|checkout|restore|stash|clean)\b/);
});
