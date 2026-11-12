/**
 * The managed-install publication owner. It stages bounded files or trees off watched paths, serializes cooperating
 * publishers, preserves prior generations for failed replacements, and records one exact transition batch only after
 * validating the expected bytes, paths and directory child sets.
 */

import { createHash } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	fstatSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readlinkSync,
	readSync,
	renameSync,
	rmdirSync,
	rmSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import path from "node:path";
import { withFileLockSync } from "../kernel/storage/atomic-file.ts";
import { sameFileVersion } from "../kernel/storage/bounded-file.ts";
import { hostWatchedPathIdentity, recordHostPathTransitionBatch } from "./host-write-transition.ts";

const MAX_TREE_ENTRIES = 2_048;
/** Relative to the published package root; bin itself is watched to depth eight. */
const MAX_TREE_DEPTH = 7;
const MAX_TREE_BYTES = 256 * 1024 * 1024;

type EntryKind = "directory" | "file" | "symlink";

interface TreeEntry {
	readonly relativePath: string;
	readonly kind: EntryKind;
	readonly identity: string;
	readonly digest?: string;
	readonly linkTarget?: string;
	readonly linkType?: "dir" | "file";
	readonly size?: number;
}

interface TreeSnapshot {
	readonly root: string;
	readonly entries: ReadonlyMap<string, TreeEntry>;
}

export type HostTreePublication =
	| { readonly status: "published"; readonly attributed: boolean }
	| { readonly status: "failed"; readonly reason: string };

interface TreeBackup {
	target: string;
	backup: string;
	movedIdentity: string;
	backupIdentity?: string;
	installedIdentity?: string;
	installedMovedIdentity?: string;
	expectedInstalled?: TreeEntry;
}

/** Publish one managed file with parent child-set evidence and an optional preserved prior generation. */
export function publishHostFile(
	sourcePath: string,
	targetPathValue: string,
	stagingRoot: string,
	journal?: string,
	options: { readonly replaceExisting?: boolean } = {},
): HostTreePublication {
	try {
		mkdirSync(stagingRoot, { recursive: true });
		return withFileLockSync(path.join(stagingRoot, "managed-publication.lock"), () =>
			publishHostFileUnlocked(sourcePath, targetPathValue, stagingRoot, journal, options),
		);
	} catch (error) {
		return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
	}
}

function publishHostFileUnlocked(
	sourcePath: string,
	targetPathValue: string,
	stagingRoot: string,
	journal?: string,
	options: { readonly replaceExisting?: boolean } = {},
): HostTreePublication {
	const source = path.resolve(sourcePath);
	const target = path.resolve(targetPathValue);
	const parent = path.dirname(target);
	let temporary: string | undefined;
	let backup: string | undefined;
	let publishedMovedIdentity: string | undefined;
	let previousMovedIdentity: string | undefined;
	let previousDigest: string | undefined;
	let previousSize: number | undefined;
	let backupIdentity: string | undefined;
	let sourceSize = 0;
	let sourceDigest = "";
	let createdParent = false;
	let retainBackup = false;
	let committed = false;
	try {
		const key = publicationKey(target);
		const retained = readdirSync(stagingRoot).find((entry) => entry.startsWith(`host-file-previous-${key}-`));
		if (retained)
			throw new Error(`Previous managed file generation requires recovery at ${path.join(stagingRoot, retained)}.`);
		const sourceStat = lstatSync(source, { bigint: true });
		if (!sourceStat.isFile() || sourceStat.size > BigInt(MAX_TREE_BYTES))
			throw new Error("Native binding source is not a bounded regular file.");
		sourceSize = Number(sourceStat.size);
		sourceDigest = contentDigest(source, sourceSize);
		const targetBefore = hostWatchedPathIdentity(target);
		if (!targetBefore) throw new Error("Native binding destination is unreadable.");
		if (targetBefore !== "absent") {
			previousMovedIdentity = movedObjectIdentity(target);
			previousSize = Number(lstatSync(target, { bigint: true }).size);
			if (previousSize > MAX_TREE_BYTES)
				throw new Error("Managed file destination exceeds the publication size bound.");
			previousDigest = contentDigest(target, previousSize);
		}
		if (targetBefore !== "absent" && (!options.replaceExisting || !targetBefore.startsWith("file:")))
			return { status: "failed", reason: "Managed file destination already exists." };
		const parentBefore = hostWatchedPathIdentity(parent);
		if (!parentBefore) throw new Error("Managed file parent is unreadable.");
		if (parentBefore === "absent") {
			if (!hostWatchedPathIdentity(path.dirname(parent))?.startsWith("dir:"))
				throw new Error("Managed file parent cannot be created safely.");
			mkdirSync(parent);
			createdParent = true;
		}
		if (parentBefore !== "absent" && !parentBefore.startsWith("dir:"))
			throw new Error("Managed file parent is not a directory.");
		const siblingsBefore = parentBefore === "absent" ? new Map<string, string>() : childrenOf(parent);
		mkdirSync(stagingRoot, { recursive: true });
		temporary = mkdtempSync(path.join(stagingRoot, `host-file-previous-${key}-`));
		const stagedFile = path.join(temporary, path.basename(target));
		copyFileSync(source, stagedFile);
		if (contentDigest(stagedFile, sourceSize) !== sourceDigest)
			throw new Error("Native binding changed during staging.");
		if (hostWatchedPathIdentity(target) !== targetBefore)
			return { status: "failed", reason: "Managed file destination changed during staging." };
		if (targetBefore === "absent") {
			// An exclusive hard link prevents a concurrent same-path write from being overwritten by rename.
			linkSync(stagedFile, target);
			publishedMovedIdentity = movedObjectIdentity(target);
			unlinkSync(stagedFile);
		} else {
			backup = path.join(temporary, `${path.basename(target)}.previous`);
			renameSync(target, backup);
			if (
				!previousMovedIdentity ||
				movedObjectIdentity(backup) !== previousMovedIdentity ||
				contentDigest(backup, previousSize!) !== previousDigest
			)
				throw new Error("Managed file destination changed while preserving its previous generation.");
			backupIdentity = hostWatchedPathIdentity(backup);
			if (hostWatchedPathIdentity(target) !== "absent")
				throw new Error("Managed file destination was replaced during publication.");
			linkSync(stagedFile, target);
			publishedMovedIdentity = movedObjectIdentity(target);
			unlinkSync(stagedFile);
		}
		const after = hostWatchedPathIdentity(target);
		if (!after?.startsWith("file:") || contentDigest(target, sourceSize) !== sourceDigest)
			throw new Error("Published managed file differs from its staged bytes.");
		const currentChildren = childrenOf(parent);
		if (
			currentChildren.size !== siblingsBefore.size + (targetBefore === "absent" ? 1 : 0) ||
			currentChildren.get(path.basename(target)) !== after
		)
			throw new Error("Managed file parent entries changed during publication.");
		for (const [name, identity] of siblingsBefore) {
			if (name !== path.basename(target) && currentChildren.get(name) !== identity)
				throw new Error(`Managed file sibling changed during publication: ${name}`);
		}
		const parentAfter = hostWatchedPathIdentity(parent);
		if (!parentAfter) throw new Error("Managed file parent became unreadable.");
		const transitions = [{ path: target, before: targetBefore, after }];
		if (parentBefore !== parentAfter) transitions.push({ path: parent, before: parentBefore, after: parentAfter });
		if (!recordHostPathTransitionBatch(transitions, journal))
			throw new Error("Managed file publication could not be recorded as one complete host transition.");
		committed = true;
		return { status: "published", attributed: true };
	} catch (error) {
		if (!committed && temporary) {
			try {
				if (
					publishedMovedIdentity !== undefined &&
					movedObjectIdentity(target) === publishedMovedIdentity &&
					contentDigest(target, sourceSize) === sourceDigest
				)
					unlinkSync(target);
				if (
					backup &&
					hostWatchedPathIdentity(target) === "absent" &&
					backupIdentity !== undefined &&
					hostWatchedPathIdentity(backup) === backupIdentity
				)
					renameSync(backup, target);
			} catch {
				// Keep the backup in host-owned staging when restoring the old generation fails.
			}
		}
		if (createdParent) {
			try {
				rmdirSync(parent);
			} catch {
				// Concurrent or partial contents remain visible for protected-path review.
			}
		}
		retainBackup = Boolean(backup && hostWatchedPathIdentity(backup) !== "absent");
		const reason = error instanceof Error ? error.message : String(error);
		return {
			status: "failed",
			reason: retainBackup ? `${reason} Previous generation retained at ${backup}.` : reason,
		};
	} finally {
		if (temporary && (committed || !retainBackup)) {
			try {
				rmSync(temporary, { recursive: true, force: true });
			} catch {
				// Leftovers remain confined to the host-owned npm staging directory.
			}
		}
	}
}

function contentDigest(filePath: string, size: number): string {
	let fd: number | undefined;
	try {
		fd = openSync(filePath, "r");
		const before = fstatSync(fd, { bigint: true });
		if (!before.isFile() || before.size !== BigInt(size))
			throw new Error("Staged file changed during publication scan.");
		const hash = createHash("sha256");
		const buffer = Buffer.alloc(64 * 1024);
		let offset = 0;
		while (offset < size) {
			const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
			if (count === 0) throw new Error("Staged file ended during publication scan.");
			hash.update(buffer.subarray(0, count));
			offset += count;
		}
		const after = fstatSync(fd, { bigint: true });
		if (!sameFileVersion(before, after)) throw new Error("Staged file changed during publication scan.");
		return hash.digest("hex");
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function movedObjectIdentity(target: string): string | undefined {
	try {
		const stat = lstatSync(target, { bigint: true });
		const kind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
		const link = stat.isSymbolicLink() ? `:${Buffer.from(readlinkSync(target)).toString("base64")}` : "";
		return `${kind}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}${link}`;
	} catch {
		return undefined;
	}
}

function matchesPublishedEntry(target: string, expected: TreeEntry, movedIdentity: string): boolean {
	if (movedObjectIdentity(target) !== movedIdentity) return false;
	if (expected.kind === "file") return contentDigest(target, expected.size ?? -1) === expected.digest;
	if (expected.kind !== "symlink" || readlinkSync(target) !== expected.linkTarget) return false;
	return true;
}

function scanTree(root: string): TreeSnapshot {
	const normalizedRoot = path.resolve(root);
	const entries = new Map<string, TreeEntry>();
	let totalBytes = 0;
	const visit = (relativePath: string, depth: number): void => {
		if (entries.size >= MAX_TREE_ENTRIES) throw new Error(`Managed tree exceeds ${MAX_TREE_ENTRIES} entries.`);
		if (depth > MAX_TREE_DEPTH) throw new Error(`Managed tree exceeds depth ${MAX_TREE_DEPTH}.`);
		const target = relativePath ? path.join(normalizedRoot, relativePath) : normalizedRoot;
		const identity = hostWatchedPathIdentity(target);
		if (!identity || identity === "absent")
			throw new Error(`Managed tree entry is unreadable: ${relativePath || "."}`);
		if (identity.startsWith("dir:")) {
			entries.set(relativePath, { relativePath, kind: "directory", identity });
			const children = readdirSync(target).sort();
			if (hostWatchedPathIdentity(target) !== identity)
				throw new Error(`Managed directory changed during publication scan: ${relativePath || "."}`);
			if (depth === MAX_TREE_DEPTH && children.length > 0)
				throw new Error(`Managed tree exceeds depth ${MAX_TREE_DEPTH}.`);
			for (const child of children) visit(relativePath ? path.join(relativePath, child) : child, depth + 1);
			return;
		}
		if (identity.startsWith("file:")) {
			const stat = lstatSync(target, { bigint: true });
			if (stat.size > BigInt(MAX_TREE_BYTES) || totalBytes + Number(stat.size) > MAX_TREE_BYTES)
				throw new Error(`Managed tree exceeds ${MAX_TREE_BYTES} bytes.`);
			const size = Number(stat.size);
			totalBytes += size;
			const digest = contentDigest(target, size);
			if (hostWatchedPathIdentity(target) !== identity)
				throw new Error(`Managed file changed during publication scan: ${relativePath}`);
			entries.set(relativePath, { relativePath, kind: "file", identity, digest, size });
			return;
		}
		if (identity.startsWith("link:")) {
			const linkTarget = readlinkSync(target);
			if (hostWatchedPathIdentity(target) !== identity)
				throw new Error(`Managed link changed during publication scan: ${relativePath}`);
			if (path.isAbsolute(linkTarget) || !inside(normalizedRoot, path.resolve(path.dirname(target), linkTarget)))
				throw new Error(`Managed tree contains an escaping link: ${relativePath}`);
			const linkType = resolveContainedLinkType(normalizedRoot, target, linkTarget);
			entries.set(relativePath, { relativePath, kind: "symlink", identity, linkTarget, linkType });
			return;
		}
		throw new Error(`Managed tree contains an unsupported entry: ${relativePath || "."}`);
	};
	visit("", 0);
	return { root: normalizedRoot, entries };
}

function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveContainedLinkType(root: string, linkPath: string, linkTarget: string): "dir" | "file" | undefined {
	let target = path.resolve(path.dirname(linkPath), linkTarget);
	for (let depth = 0; depth <= MAX_TREE_DEPTH; depth++) {
		if (!inside(root, target)) return undefined;
		try {
			const stat = lstatSync(target);
			if (!stat.isSymbolicLink()) return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : undefined;
			const next = readlinkSync(target);
			if (path.isAbsolute(next)) return undefined;
			target = path.resolve(path.dirname(target), next);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function publicationKey(target: string): string {
	return createHash("sha256").update(path.resolve(target)).digest("hex").slice(0, 24);
}

function childrenOf(directory: string): Map<string, string> {
	const children = new Map<string, string>();
	for (const name of readdirSync(directory).sort()) {
		const identity = hostWatchedPathIdentity(path.join(directory, name));
		if (!identity) throw new Error(`Managed tool sibling is unreadable: ${path.join(directory, name)}`);
		children.set(name, identity);
	}
	return children;
}

function expectedChildren(snapshot: TreeSnapshot, directory: string): Set<string> {
	const prefix = directory ? `${directory}${path.sep}` : "";
	const children = new Set<string>();
	for (const entryPath of snapshot.entries.keys()) {
		if (entryPath === directory || !entryPath.startsWith(prefix)) continue;
		const remainder = entryPath.slice(prefix.length);
		if (remainder && !remainder.includes(path.sep)) children.add(remainder);
	}
	return children;
}

function targetPath(root: string, relativePath: string): string {
	const target = path.resolve(root, relativePath);
	if (!inside(path.resolve(root), target)) throw new Error(`Managed tree path escapes its root: ${relativePath}`);
	return target;
}

function assertExpectedTree(before: TreeSnapshot, staged: TreeSnapshot, after: TreeSnapshot): void {
	const expectedPaths = new Set([...before.entries.keys(), ...staged.entries.keys()]);
	if (after.entries.size !== expectedPaths.size)
		throw new Error("Published managed tree entry set changed concurrently.");
	for (const relativePath of expectedPaths) {
		if (!after.entries.has(relativePath))
			throw new Error(`Published managed tree entry disappeared: ${relativePath}`);
		const newEntry = staged.entries.get(relativePath);
		const oldEntry = before.entries.get(relativePath);
		const actual = after.entries.get(relativePath)!;
		if (newEntry?.kind === "file") {
			if (actual.kind !== "file" || actual.digest !== newEntry.digest)
				throw new Error(`Published managed file differs from its staged bytes: ${relativePath}`);
		} else if (newEntry?.kind === "symlink") {
			if (
				actual.kind !== "symlink" ||
				actual.linkTarget !== newEntry.linkTarget ||
				actual.linkType !== newEntry.linkType
			)
				throw new Error(`Published managed link differs from its staged target: ${relativePath}`);
		} else if (newEntry?.kind === "directory") {
			if (actual.kind !== "directory") throw new Error(`Published managed directory changed type: ${relativePath}`);
		} else if (!oldEntry || actual.identity !== oldEntry.identity) {
			throw new Error(`Unstaged managed entry changed during publication: ${relativePath}`);
		}
	}
	for (const entry of staged.entries.values()) {
		if (entry.kind !== "directory") continue;
		const expected = new Set([
			...expectedChildren(before, entry.relativePath),
			...expectedChildren(staged, entry.relativePath),
		]);
		const actual = expectedChildren(after, entry.relativePath);
		if (actual.size !== expected.size || [...expected].some((name) => !actual.has(name)))
			throw new Error(`Published directory child set changed concurrently: ${entry.relativePath || "."}`);
	}
}

/** Merge one fully staged package into the managed target and attribute only validated entry transitions. */
export function publishHostTree(
	sourceRoot: string,
	targetRoot: string,
	journal: string,
	publicationRoot: string = path.dirname(sourceRoot),
): HostTreePublication {
	try {
		mkdirSync(publicationRoot, { recursive: true });
		return withFileLockSync(path.join(publicationRoot, "managed-publication.lock"), () =>
			publishHostTreeUnlocked(sourceRoot, targetRoot, journal, publicationRoot),
		);
	} catch (error) {
		return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
	}
}

function publishHostTreeUnlocked(
	sourceRoot: string,
	targetRoot: string,
	journal: string,
	publicationRoot: string,
): HostTreePublication {
	const source = path.resolve(sourceRoot);
	const target = path.resolve(targetRoot);
	const parent = path.dirname(target);
	let sourceTree: TreeSnapshot;
	let beforeTree: TreeSnapshot;
	let parentBefore: string;
	let backupRoot: string | undefined;
	let siblingBefore = new Map<string, string>();
	try {
		const key = publicationKey(target);
		const retained = readdirSync(publicationRoot).find((entry) => entry.startsWith(`fff-publish-backup-${key}-`));
		if (retained)
			throw new Error(
				`Previous managed tree generation requires recovery at ${path.join(publicationRoot, retained)}.`,
			);
		sourceTree = scanTree(source);
		const parentIdentity = hostWatchedPathIdentity(parent);
		if (!parentIdentity) throw new Error("Managed tools directory is unreadable.");
		parentBefore = parentIdentity;
		if (parentIdentity === "absent") mkdirSync(parent, { recursive: true });
		else if (!parentIdentity.startsWith("dir:")) throw new Error("Managed tools path is not a directory.");
		if (parentIdentity !== "absent") siblingBefore = childrenOf(parent);
		const targetIdentity = hostWatchedPathIdentity(target);
		if (!targetIdentity) throw new Error("Existing managed FFF directory is unreadable.");
		if (targetIdentity === "absent") beforeTree = { root: target, entries: new Map() };
		else {
			if (!targetIdentity.startsWith("dir:")) throw new Error("Existing managed FFF path is not a directory.");
			beforeTree = scanTree(target);
		}
		for (const [relativePath, staged] of sourceTree.entries) {
			const existing = beforeTree.entries.get(relativePath);
			if (existing && existing.kind !== staged.kind)
				throw new Error(`Managed FFF entry has an incompatible existing type: ${relativePath || "."}`);
		}
		if (new Set([...beforeTree.entries.keys(), ...sourceTree.entries.keys()]).size > MAX_TREE_ENTRIES)
			throw new Error(`Published managed tree exceeds ${MAX_TREE_ENTRIES} entries.`);
	} catch (error) {
		return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
	}

	const changes = new Map<string, { before: string; after: string }>();
	const directoryBefore = new Map<string, string>();
	const backups: TreeBackup[] = [];
	const addedFiles: Array<{ target: string; installedIdentity: string; movedIdentity: string; expected: TreeEntry }> =
		[];
	const addedDirectories: string[] = [];
	try {
		backupRoot = mkdtempSync(path.join(publicationRoot, `fff-publish-backup-${publicationKey(target)}-`));
		for (const entry of sourceTree.entries.values()) {
			if (entry.kind !== "directory") continue;
			const destination = targetPath(target, entry.relativePath);
			const before = hostWatchedPathIdentity(destination);
			if (!before) throw new Error(`Managed destination is unreadable: ${entry.relativePath || "."}`);
			directoryBefore.set(destination, before);
			if (before === "absent") {
				mkdirSync(destination);
				addedDirectories.push(destination);
			} else if (!before.startsWith("dir:"))
				throw new Error(`Managed destination is not a directory: ${entry.relativePath}`);
		}
		for (const entry of sourceTree.entries.values()) {
			if (entry.kind === "directory" || entry.relativePath === "") continue;
			const from = targetPath(source, entry.relativePath);
			const destination = targetPath(target, entry.relativePath);
			const before = hostWatchedPathIdentity(destination);
			const existing = beforeTree.entries.get(entry.relativePath);
			if (!before) throw new Error(`Managed destination is unreadable: ${entry.relativePath}`);
			if (before !== "absent") {
				if (entry.kind === "file" && existing?.kind === "file" && existing.digest === entry.digest) continue;
				if (entry.kind === "symlink" && existing?.kind === "symlink" && existing.linkTarget === entry.linkTarget)
					continue;
			}
			let backup: string | undefined;
			let movedIdentity: string | undefined;
			if (before !== "absent") {
				if (hostWatchedPathIdentity(destination) !== before)
					throw new Error(
						`Managed destination changed before preserving its current entry: ${entry.relativePath}`,
					);
				backup = targetPath(backupRoot, entry.relativePath);
				mkdirSync(path.dirname(backup), { recursive: true });
				movedIdentity = movedObjectIdentity(destination);
				if (!movedIdentity) throw new Error(`Managed destination identity is unreadable: ${entry.relativePath}`);
				if (entry.kind === "symlink") {
					// Preserve a displaced link as an opaque sibling for rollback.
					renameSync(destination, backup);
					const backupEntry: TreeBackup = { target: destination, backup, movedIdentity };
					backups.push(backupEntry);
					if (movedObjectIdentity(backup) !== movedIdentity || readlinkSync(backup) !== existing?.linkTarget)
						throw new Error(`Managed link changed during backup: ${entry.relativePath}`);
					backupEntry.backupIdentity = hostWatchedPathIdentity(backup);
				} else {
					renameSync(destination, backup);
					const backupEntry: TreeBackup = { target: destination, backup, movedIdentity };
					backups.push(backupEntry);
					if (
						movedObjectIdentity(backup) !== movedIdentity ||
						contentDigest(backup, existing?.size ?? -1) !== existing?.digest
					)
						throw new Error(`Managed file changed during backup: ${entry.relativePath}`);
					backupEntry.backupIdentity = hostWatchedPathIdentity(backup);
				}
			}
			try {
				if (entry.kind === "file") {
					linkSync(from, destination);
				} else {
					if (process.platform === "win32" && !entry.linkType)
						throw new Error(`Managed link target kind is unresolved on Windows: ${entry.relativePath}`);
					symlinkSync(entry.linkTarget!, destination, entry.linkType);
				}
				const linkedIdentity = hostWatchedPathIdentity(destination);
				if (!linkedIdentity) throw new Error(`Published managed entry is unreadable: ${entry.relativePath}`);
				const linkedMovedIdentity = movedObjectIdentity(destination);
				if (!linkedMovedIdentity)
					throw new Error(`Published managed identity is unreadable: ${entry.relativePath}`);
				if (before === "absent")
					addedFiles.push({
						target: destination,
						installedIdentity: linkedIdentity,
						movedIdentity: linkedMovedIdentity,
						expected: entry,
					});
				else {
					const backupEntry = backups.at(-1);
					if (backupEntry?.target === destination) {
						backupEntry.installedIdentity = linkedIdentity;
						backupEntry.installedMovedIdentity = linkedMovedIdentity;
						backupEntry.expectedInstalled = entry;
					}
				}
				unlinkSync(from);
			} catch (error) {
				if (
					backup &&
					hostWatchedPathIdentity(destination) === "absent" &&
					backups.at(-1)?.backup === backup &&
					backups.at(-1)?.backupIdentity !== undefined &&
					hostWatchedPathIdentity(backup) === backups.at(-1)?.backupIdentity
				) {
					renameSync(backup, destination);
					backups.pop();
				}
				throw error;
			}
			const after = hostWatchedPathIdentity(destination);
			if (!after) throw new Error(`Published managed entry is unreadable: ${entry.relativePath}`);
			if (before === "absent") {
				const added = addedFiles.at(-1);
				if (added?.target === destination) added.installedIdentity = after;
			} else {
				const backupEntry = backups.at(-1);
				if (backupEntry?.target === destination) backupEntry.installedIdentity = after;
			}
			if (entry.kind === "file" && !after.startsWith("file:"))
				throw new Error(`Published managed file changed type: ${entry.relativePath}`);
			if (entry.kind === "symlink") {
				if (!after.startsWith("link:") || readlinkSync(destination) !== entry.linkTarget)
					throw new Error(`Published managed link changed target: ${entry.relativePath}`);
			}
			if (entry.kind === "file" && contentDigest(destination, entry.size!) !== entry.digest)
				throw new Error(`Published managed file differs from staged bytes: ${entry.relativePath}`);
			changes.set(destination, { before, after });
		}
		const afterTree = scanTree(target);
		assertExpectedTree(beforeTree, sourceTree, afterTree);
		for (const [name, identity] of siblingBefore) {
			if (name === path.basename(target)) continue;
			if (hostWatchedPathIdentity(path.join(parent, name)) !== identity)
				throw new Error(`Managed tool sibling changed during FFF publication: ${name}`);
		}
		const actualSiblingNames = readdirSync(parent).sort();
		const expectedSiblingNames = [...new Set([...siblingBefore.keys(), path.basename(target)])].sort();
		if (actualSiblingNames.join("\0") !== expectedSiblingNames.join("\0"))
			throw new Error("Managed tools directory entries changed during FFF publication.");

		for (const [directory, before] of directoryBefore) {
			const after = hostWatchedPathIdentity(directory);
			if (!after) throw new Error(`Managed directory is unreadable after publication: ${directory}`);
			if (before !== after) changes.set(directory, { before, after });
		}
		const parentAfter = hostWatchedPathIdentity(parent);
		if (!parentAfter) throw new Error("Managed tools directory is unreadable after publication.");
		if (parentBefore !== parentAfter) changes.set(parent, { before: parentBefore, after: parentAfter });
		for (const entry of sourceTree.entries.values()) {
			if (entry.kind !== "directory") continue;
			const directory = targetPath(target, entry.relativePath);
			const before = beforeTree.entries.get(entry.relativePath)?.identity ?? "absent";
			const after = afterTree.entries.get(entry.relativePath)?.identity;
			if (!after) throw new Error(`Published directory is missing: ${entry.relativePath || "."}`);
			if (before !== after) changes.set(directory, { before, after });
		}
		const attributed =
			changes.size === 0 ||
			recordHostPathTransitionBatch(
				[...changes].map(([entryPath, transition]) => ({ path: entryPath, ...transition })),
				journal,
			);
		if (!attributed)
			throw new Error("Managed tree publication could not be recorded as one complete host transition.");
		try {
			rmSync(source, { recursive: true, force: true });
			rmSync(backupRoot, { recursive: true, force: true });
		} catch {
			// Published bytes and their transition batch are final; leftovers remain in host-owned storage.
		}
		return { status: "published", attributed };
	} catch (error) {
		for (const added of addedFiles.reverse()) {
			try {
				if (matchesPublishedEntry(added.target, added.expected, added.movedIdentity))
					rmSync(added.target, { force: true });
			} catch {
				// A failed rollback remains observable to the protected-path watch.
			}
		}
		let retainedBackup = false;
		for (const {
			target: destination,
			backup,
			backupIdentity,
			installedIdentity,
			installedMovedIdentity,
			expectedInstalled,
		} of backups.reverse()) {
			try {
				const current = hostWatchedPathIdentity(destination);
				const previous = hostWatchedPathIdentity(backup);
				if (backupIdentity === undefined || previous !== backupIdentity) {
					retainedBackup = true;
					continue;
				}
				if (
					current !== "absent" &&
					(installedIdentity === undefined ||
						(current !== installedIdentity &&
							(!installedMovedIdentity ||
								!expectedInstalled ||
								!matchesPublishedEntry(destination, expectedInstalled, installedMovedIdentity))))
				) {
					retainedBackup = true;
					continue;
				}
				if (current !== "absent") rmSync(destination, { force: true });
				if (hostWatchedPathIdentity(backup) !== "absent") renameSync(backup, destination);
			} catch {
				// Preserve the only old generation if restoring it failed.
				retainedBackup = true;
			}
		}
		for (const directory of addedDirectories.reverse()) {
			try {
				rmdirSync(directory);
			} catch {
				// Non-empty directories are retained; any partial publication remains visible.
			}
		}
		if (backupRoot && !retainedBackup) {
			try {
				rmSync(backupRoot, { recursive: true, force: true });
			} catch {
				// Staging and backup storage are host-owned, unwatched storage.
			}
		}
		const reason = error instanceof Error ? error.message : String(error);
		return {
			status: "failed",
			reason: retainedBackup ? `${reason} Previous generation retained at ${backupRoot}.` : reason,
		};
	}
}
