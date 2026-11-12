/** Pins the exact standalone executable and release identity used by live harness acceptance. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

function executableDigest(path) {
	const hash = createHash("sha256");
	const file = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(64 * 1024);
		for (;;) {
			const count = readSync(file, buffer, 0, buffer.length, null);
			if (count === 0) return hash.digest("hex");
			hash.update(buffer.subarray(0, count));
		}
	} finally {
		closeSync(file);
	}
}

/** The caller verifies the downloaded archive against its published checksum before pinning its executable. */
export function pinLiveBinary({ binaryPath, releaseTag, releaseCommit, resolveTagCommit, run = spawnSync }) {
	if (!isAbsolute(binaryPath)) throw new Error("Live --binary must be an absolute standalone executable path.");
	if (!/^v\d+\.\d+\.\d+$/.test(releaseTag ?? "") || !/^[a-f0-9]{40}$/i.test(releaseCommit ?? ""))
		throw new Error("Live --binary requires --release-tag vX.Y.Z and its exact --release-commit SHA.");
	const resolvedCommit = resolveTagCommit(releaseTag).trim().toLowerCase();
	if (resolvedCommit !== releaseCommit.toLowerCase())
		throw new Error("Live release commit does not match the resolved version tag.");
	const path = realpathSync(binaryPath);
	if (!statSync(path).isFile()) throw new Error("Live --binary must name a regular executable file.");
	const sha256 = executableDigest(path);
	const probe = run(path, ["--version"], { encoding: "utf8", timeout: 30_000 });
	const version = (probe.stdout ?? "").split("\n")[0].trim();
	if (probe.status !== 0 || version.replace(/^v/, "") !== releaseTag.slice(1))
		throw new Error("Live executable version does not match the selected release tag.");
	const identity = Object.freeze({ path, sha256, version, releaseTag, releaseCommit: resolvedCommit });
	assertLiveBinaryUnchanged(identity);
	return identity;
}

export function assertLiveBinaryUnchanged(identity) {
	if (executableDigest(identity.path) !== identity.sha256)
		throw new Error("The pinned live executable changed during acceptance.");
}
