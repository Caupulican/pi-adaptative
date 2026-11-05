import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sameFileVersion } from "../../kernel/storage/bounded-file.ts";
import {
	LOCAL_READ_CHUNK_BYTES,
	type ReadOperation,
	type ReadWorkKind,
	ReadWorkLimitError,
	type ReadWorkTotals,
	readDigest,
} from "./read-operation-context.ts";

export interface LocalReadEntry {
	name: string;
	kind: "dir" | "file" | "link" | "other";
	size: number;
	mode: number;
}

type ReadStep = { path: string; kind: "readFile" | "list" | "stat"; maximumBytes?: number; before: ReadWorkTotals };

/** A bounded observation transaction. Bodies live only for the duration of a tool call. */
export class LocalReadSession {
	readonly operation: ReadOperation;
	partial = false;
	private readonly witnesses = new Map<string, string>();
	private readonly steps: ReadStep[] = [];

	constructor(operation: ReadOperation) {
		this.operation = operation;
	}

	private witness(key: string, digest: string): void {
		const previous = this.witnesses.get(key);
		if (previous !== undefined && previous !== digest) throw new Error("Source changed during the read observation");
		this.witnesses.set(key, digest);
	}

	async stat(path: string) {
		this.steps.push({ path, kind: "stat", before: this.operation.work });
		return this.inspect(path);
	}

	private async inspect(path: string) {
		const absolute = resolve(path);
		await this.operation.authorizePath(absolute, "metadata");
		this.operation.charge("metadata", 1);
		try {
			const value = await lstat(absolute, { bigint: true });
			this.operation.assertCurrent();
			this.witness(`metadata:${absolute}`, this.statDigest(value));
			return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.operation.assertCurrent();
			this.witness(`metadata:${absolute}`, "absent");
			return undefined;
		}
	}

	private statDigest(value: Awaited<ReturnType<typeof lstat>>): string {
		return `${value.dev}:${value.ino}:${value.mode}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
	}

	private async admit(path: string, kind: "file" | "directory") {
		await this.operation.authorizePath(resolve(path), kind);
		this.operation.charge("metadata", 1);
		const canonical = await realpath(path);
		this.operation.assertCurrent();
		await this.operation.authorizePath(canonical, kind);
		this.witness(`resolution:${resolve(path)}`, canonical);
		return canonical;
	}

	async readFile(path: string, maximumBytes?: number): Promise<Buffer> {
		if (maximumBytes !== undefined && (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0))
			throw new Error("Invalid bounded file prefix length");
		this.steps.push({ path, kind: "readFile", maximumBytes, before: this.operation.work });
		const absolute = await this.admit(path, "file");
		const before = await this.inspect(absolute);
		if (!before?.isFile()) throw new Error("Bounded reads require a regular file");
		const size = maximumBytes === undefined ? before.size : BigInt(Math.min(Number(before.size), maximumBytes));
		if (size > BigInt(this.operation.remaining("sourceBytes"))) throw new ReadWorkLimitError("sourceBytes");
		this.operation.charge("files", 1);
		this.operation.charge("metadata", 1);
		const handle = await open(
			absolute,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		);
		try {
			this.operation.charge("metadata", 1);
			const pinned = await handle.stat({ bigint: true });
			if (!sameFileVersion(pinned, before) || pinned.mode !== before.mode)
				throw new Error("File changed before read");
			const result = Buffer.alloc(Number(size));
			let position = 0;
			while (position < result.length) {
				const length = Math.min(LOCAL_READ_CHUNK_BYTES, result.length - position);
				this.operation.charge("sourceBytes", length);
				const { bytesRead } = await handle.read(result, position, length, position);
				this.operation.assertCurrent();
				if (bytesRead !== length) throw new Error("File changed during read");
				position += bytesRead;
			}
			this.operation.charge("metadata", 1);
			const after = await handle.stat({ bigint: true });
			const pathAfter = await this.inspect(absolute);
			if (
				!pathAfter ||
				!sameFileVersion(after, before) ||
				after.mode !== before.mode ||
				!sameFileVersion(pathAfter, before) ||
				pathAfter.mode !== before.mode
			)
				throw new Error("File changed during read");
			this.witness(`file:${absolute}:${maximumBytes ?? "all"}`, readDigest(result));
			return result;
		} finally {
			await handle.close();
		}
	}

	async list(path: string): Promise<LocalReadEntry[]> {
		this.steps.push({ path, kind: "list", before: this.operation.work });
		const absolute = await this.admit(path, "directory");
		const before = await this.inspect(absolute);
		if (!before?.isDirectory()) throw new Error("Not a directory");
		const entries: LocalReadEntry[] = [];
		const observed: string[] = [];
		this.operation.charge("metadata", 1);
		const directory = await opendir(absolute, { bufferSize: 1 });
		try {
			for (;;) {
				if (this.operation.remaining("entries") === 0) {
					this.partial = true;
					break;
				}
				this.operation.charge("entries", 1);
				const entry = await directory.read();
				this.operation.assertCurrent();
				if (!entry) break;
				observed.push(entry.name);
				const child = join(absolute, entry.name);
				// A denied member is never disclosed or traversed, including its type and size.
				try {
					await this.operation.authorizePath(child, "metadata");
				} catch (error) {
					this.operation.assertCurrent();
					if (error instanceof ReadWorkLimitError) throw error;
					continue;
				}
				const stat = await this.inspect(child);
				if (!stat) throw new Error("Directory member changed during enumeration");
				entries.push({
					name: entry.name,
					size: Number(stat.size),
					mode: Number(stat.mode),
					kind: stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other",
				});
			}
		} finally {
			await directory.close();
		}
		const after = await this.inspect(absolute);
		if (!after || !sameFileVersion(before, after) || before.mode !== after.mode)
			throw new Error("Directory changed during enumeration");
		this.witness(`directory:${absolute}`, readDigest(JSON.stringify(observed.sort())));
		return entries;
	}

	publish(sourceRef: string, query: string, result: string, coverage?: "complete" | "window" | "partial"): void {
		const witnesses = new Map(this.witnesses);
		const steps = [...this.steps];
		this.operation.observe({
			sourceRef,
			query,
			result,
			coverage: this.partial ? "partial" : coverage,
			async revalidate(operation) {
				const current = new LocalReadSession(operation);
				for (const step of steps) {
					// Reserve the same headroom used by codec/matcher prerequisites between source reads.
					// This preserves the exact stopping point of partial observations without rerunning a matcher.
					for (const kind of Object.keys(step.before) as ReadWorkKind[]) {
						const reserved = step.before[kind] - operation.work[kind];
						if (reserved > 0) operation.charge(kind, reserved);
					}
					try {
						if (step.kind === "readFile") await current.readFile(step.path, step.maximumBytes);
						else await current[step.kind](step.path);
					} catch (error) {
						if (!(error instanceof ReadWorkLimitError)) throw error;
					}
				}
				operation.assertCurrent();
				return (
					current.witnesses.size === witnesses.size &&
					[...witnesses].every(([key, digest]) => current.witnesses.get(key) === digest)
				);
			},
		});
	}
}
