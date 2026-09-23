import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants, lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PiSelfLaunchTarget } from "../core/process-matrix/resume-launcher.ts";
import { normalizeSelfLaunchTarget } from "../core/process-matrix/self-launch-target.ts";
import { readBoundedDirectoryNamesSync } from "../core/util/bounded-file.ts";

export interface RuntimeOrigin {
	root: string;
	entries: readonly string[];
	target: PiSelfLaunchTarget;
}

export const MAX_RUNTIME_ARTIFACT_ENTRIES = 100_000;

/** A file whose version keeps changing while it is copied is retried this many times before capture fails. */
export const RUNTIME_FILE_CAPTURE_ATTEMPTS = 3;

/** A pool entry younger than this is never pruned: a concurrent capture may be about to link it. */
const POOL_PRUNE_GRACE_MS = 10 * 60_000;

/** The version of a source file a pool entry was copied from: same inode, size, times and mode. */
function versionKey(stat: BigIntStats): string {
	return createHash("sha256")
		.update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`)
		.digest("hex");
}

function sameVersion(left: BigIntStats, right: BigIntStats): boolean {
	return versionKey(left) === versionKey(right);
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Copies code and dependencies into immutable rollback generations; never hard-links a mutable source
 * file into one.
 *
 * With a content pool, each version of a source file is copied once, into the pool, and every
 * generation that needs that version hard-links the pool's copy. Pool files are written only by this
 * store and made read-only, so a link shares an immutable copy, never the source. A launch whose code
 * has not changed then pays a directory walk and links instead of copying the whole runtime again. A
 * pool entry no live generation links (link count 1) is an old version and is pruned after a capture.
 */
export class RuntimeArtifactStore {
	private readonly origin: RuntimeOrigin | (() => Promise<RuntimeOrigin>);
	private readonly directory: string;
	private readonly pool: string | undefined;
	private readonly owned = new Map<string, PiSelfLaunchTarget>();
	private captures = 0;
	private pruning: Promise<void> = Promise.resolve();
	private pruneError: unknown;

	constructor(origin: RuntimeOrigin | (() => Promise<RuntimeOrigin>), directory: string, pool?: string) {
		this.origin = origin;
		this.directory = directory;
		this.pool = pool;
	}

	/**
	 * Waits for background pool pruning and reports its first failure. Pruning never delays a launch;
	 * the supervisor settles it when it ends.
	 */
	async settle(): Promise<void> {
		await this.pruning;
		if (this.pruneError !== undefined) throw this.pruneError;
	}

	async capture(): Promise<string> {
		if (this.owned.size + this.captures >= 3) throw new Error("Runtime artifact retention limit reached.");
		this.captures++;
		try {
			const artifact = await this.captureGeneration();
			const pool = this.pool;
			if (pool)
				this.pruning = this.pruning.then(() =>
					this.prunePool(pool).catch((error: unknown) => {
						this.pruneError ??= error;
					}),
				);
			return artifact;
		} finally {
			this.captures--;
		}
	}

	private async captureGeneration(): Promise<string> {
		const origin = typeof this.origin === "function" ? await this.origin() : this.origin;
		const root = await realpath(origin.root);
		const isWithinOrigin = (path: string): boolean => {
			const child = relative(origin.root, path);
			return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
		};
		const args = normalizeSelfLaunchTarget(origin.target, origin.root).argsPrefix;
		const artifact = await mkdtemp(join(this.directory, "generation-"));
		const remap = (argument: string): string => {
			if (argument.startsWith("file:")) return pathToFileURL(remap(fileURLToPath(argument))).href;
			const inline = /^(--(?:import|require|loader|experimental-loader))=(.*)$/.exec(argument);
			if (inline) return `${inline[1]}=${remap(inline[2])}`;
			return isAbsolute(argument) && isWithinOrigin(argument)
				? join(artifact, relative(origin.root, argument))
				: argument;
		};
		this.owned.set(artifact, {
			executable: isWithinOrigin(origin.target.executable)
				? remap(origin.target.executable)
				: join(artifact, ".host", basename(origin.target.executable)),
			argsPrefix: args.map(remap),
		});
		let entries = 0;
		let bytes = 0;
		const copies: Array<{ source: string; target: string }> = [];
		const links: string[] = [];
		const inside = (path: string): string => {
			const child = relative(root, path);
			if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
				throw new Error(`Runtime dependency points outside the captured root: ${path}`);
			return child;
		};
		const visit = (source: string, destination: string, depth: number): void => {
			if (basename(dirname(source)) === "node_modules" && [".cache", ".vite"].includes(basename(source))) return;
			if (++entries > MAX_RUNTIME_ARTIFACT_ENTRIES || depth > 64)
				throw new Error("Runtime snapshot entry/depth limit exceeded.");
			const stat = lstatSync(source);
			if (stat.isSymbolicLink()) {
				// Match fs/promises.realpath's native spelling (Windows 8.3 aliases differ otherwise).
				const resolved = realpathSync.native(source);
				const target = join(artifact, inside(resolved));
				const type = lstatSync(resolved).isDirectory() ? "junction" : "file";
				symlinkSync(
					process.platform === "win32" ? target : relative(dirname(destination), target),
					destination,
					type,
				);
				links.push(destination);
			} else if (stat.isDirectory()) {
				mkdirSync(destination, { recursive: true, mode: stat.mode });
				for (const child of readBoundedDirectoryNamesSync(
					source,
					Math.max(1, MAX_RUNTIME_ARTIFACT_ENTRIES - entries),
					"Runtime directory",
				))
					visit(join(source, child), join(destination, child), depth + 1);
			} else if (stat.isFile()) {
				bytes += stat.size;
				if (bytes > 1024 * 1024 * 1024) throw new Error("Runtime snapshot exceeds 1 GiB.");
				copies.push({ source, target: destination });
			} else throw new Error(`Unsupported runtime file type: ${source}`);
		};
		try {
			for (const entry of origin.entries) {
				const source = resolve(root, entry);
				const child = inside(source);
				await mkdir(dirname(join(artifact, child)), { recursive: true });
				visit(source, join(artifact, child), 0);
			}
			if (!isWithinOrigin(origin.target.executable)) {
				await mkdir(join(artifact, ".host"));
				visit(
					await realpath(origin.target.executable),
					join(artifact, ".host", basename(origin.target.executable)),
					0,
				);
			}
			// Fixed-width I/O: no unbounded Promise.all over a dependency tree.
			let index = 0;
			const shards = new Set<string>();
			const pool = await this.linkablePool(artifact);
			const results = await Promise.allSettled(
				Array.from({ length: 8 }, async () => {
					for (;;) {
						const item = copies[index++];
						if (!item) break;
						await this.materialize(item.source, item.target, pool, shards);
					}
				}),
			);
			for (const result of results) if (result.status === "rejected") throw result.reason;
			for (const link of links) await realpath(link);
			return artifact;
		} catch (error) {
			await this.retire(artifact);
			throw error;
		}
	}

	/**
	 * Places one consistent version of `source` at `target`. A file that changes while it is copied is
	 * copied again: the snapshot needs one version of each file, and an editor saving during a launch is
	 * not a reason to abort it. It fails, naming the file, only when the file never holds still.
	 */
	private async materialize(
		source: string,
		target: string,
		pool: string | undefined,
		shards: Set<string>,
	): Promise<void> {
		for (let attempt = 1; attempt <= RUNTIME_FILE_CAPTURE_ATTEMPTS; attempt++) {
			const before = await lstat(source, { bigint: true });
			if (pool) {
				const key = versionKey(before);
				const shard = join(pool, key.slice(0, 2));
				const pooled = join(shard, key);
				// This exact version is already pooled: the pooled copy was verified against it.
				if (await this.linkPooled(pooled, target)) return;
				if (!shards.has(shard)) {
					await mkdir(shard, { recursive: true });
					shards.add(shard);
				}
				const temporary = `${pooled}.${randomUUID()}.tmp`;
				await copyFile(source, temporary, constants.COPYFILE_FICLONE);
				if (!sameVersion(before, await lstat(source, { bigint: true }))) {
					await rm(temporary, { force: true });
					continue;
				}
				// Read-only: a generation links this copy, and nothing may write through the link.
				await chmod(temporary, Number(before.mode) & 0o555);
				await rename(temporary, pooled);
				if (await this.linkPooled(pooled, target)) return;
				// A concurrent prune removed it between rename and link; copy this version again.
				continue;
			}
			await copyFile(source, target, constants.COPYFILE_FICLONE);
			if (sameVersion(before, await lstat(source, { bigint: true }))) return;
			await rm(target, { force: true });
		}
		throw new Error(
			`Runtime file kept changing during capture (${RUNTIME_FILE_CAPTURE_ATTEMPTS} attempts): ${source}`,
		);
	}

	/**
	 * The pool, when a generation at `artifact` can hard-link its files: links never cross a device, so a
	 * pool on another filesystem than the generations cannot serve them and the capture copies instead.
	 */
	private async linkablePool(artifact: string): Promise<string | undefined> {
		if (!this.pool) return undefined;
		await mkdir(this.pool, { recursive: true });
		const [pool, generation] = await Promise.all([lstat(this.pool), lstat(artifact)]);
		return pool.dev === generation.dev ? this.pool : undefined;
	}

	/** Links a pooled copy into a generation; false when the pool does not hold it. */
	private async linkPooled(pooled: string, target: string): Promise<boolean> {
		try {
			await link(pooled, target);
			return true;
		} catch (error) {
			if (errorCode(error) === "ENOENT") return false;
			throw error;
		}
	}

	/** Removes pool entries no live generation links, older than the grace window. */
	private async prunePool(pool: string): Promise<void> {
		const cutoff = Date.now() - POOL_PRUNE_GRACE_MS;
		await mkdir(pool, { recursive: true });
		for (const shard of await readdir(pool)) {
			const shardPath = join(pool, shard);
			for (const name of await readdir(shardPath)) {
				const entry = join(shardPath, name);
				const stat = await lstat(entry);
				if (stat.nlink <= 1 && stat.mtimeMs < cutoff) await rm(entry, { force: true });
			}
		}
	}

	/** Remap loader paths as well as the CLI; a copied CLI with a live tsx loader is not a snapshot. */
	target(artifact: string): PiSelfLaunchTarget {
		const target = this.owned.get(artifact);
		if (!target) throw new Error("Runtime artifact is not owned by this supervisor.");
		return { executable: target.executable, argsPrefix: [...target.argsPrefix] };
	}

	async retire(artifact: string): Promise<void> {
		if (!this.owned.has(artifact)) throw new Error("Runtime artifact is not owned by this supervisor.");
		await rm(artifact, { recursive: true, force: true });
		this.owned.delete(artifact);
	}
}
