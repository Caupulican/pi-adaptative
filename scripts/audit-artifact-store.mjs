import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_BYTES = 1024 * 1024;

function resolveGitCommonDirectory(repositoryRoot) {
	return execFileSync("git", ["rev-parse", "--git-common-dir"], {
		cwd: repositoryRoot,
		encoding: "utf8",
	}).trim();
}

/** Put ephemeral audit evidence beside git's other local state, never in the tracked docs tree. */
export function gitAuditDirectory(repositoryRoot, category, commonDirectory = resolveGitCommonDirectory) {
	if (!/^[a-z0-9-]+$/.test(category)) throw new Error(`Invalid audit category: ${category}`);
	const gitCommonDirectory = commonDirectory(repositoryRoot);
	if (!gitCommonDirectory) throw new Error("Git common directory is empty.");
	return join(resolve(repositoryRoot, gitCommonDirectory), "pi-audits", category);
}

/** Write one artifact and retain only the newest bounded set owned by the given suffix. */
export function writeBoundedAuditArtifact({
	directory,
	fileName,
	content,
	managedSuffix,
	maxFiles = DEFAULT_MAX_FILES,
	maxBytes = DEFAULT_MAX_BYTES,
	removeArtifact = unlinkSync,
}) {
	if (basename(fileName) !== fileName || !fileName.endsWith(managedSuffix)) {
		throw new Error(`Invalid managed audit artifact name: ${fileName}`);
	}
	if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new Error("maxFiles must be a positive integer.");
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer.");
	const contentBytes = Buffer.byteLength(content);
	if (contentBytes > maxBytes) {
		throw new Error(`Artifact exceeds maxBytes: ${contentBytes} > ${maxBytes}.`);
	}

	mkdirSync(directory, { recursive: true });
	const artifactPath = join(directory, fileName);
	const managed = readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(managedSuffix))
		.map((entry) => {
			const path = join(directory, entry.name);
			const stat = statSync(path);
			return { name: entry.name, path, bytes: stat.size, modifiedAt: stat.mtimeMs };
		})
		.sort((left, right) => right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name));

	const existingCurrent = managed.find((entry) => entry.name === fileName);
	let retainedFiles = 1;
	let retainedBytes = Math.max(contentBytes, existingCurrent?.bytes ?? 0);
	const removed = [];
	for (const entry of managed) {
		if (entry.name === fileName) continue;
		if (retainedFiles < maxFiles && retainedBytes + entry.bytes <= maxBytes) {
			retainedFiles += 1;
			retainedBytes += entry.bytes;
			continue;
		}
		removeArtifact(entry.path);
		removed.push(entry.path);
	}
	writeFileSync(artifactPath, content, "utf8");
	retainedBytes -= Math.max(contentBytes, existingCurrent?.bytes ?? 0) - contentBytes;
	return { artifactPath, retainedFiles, retainedBytes, removed };
}
