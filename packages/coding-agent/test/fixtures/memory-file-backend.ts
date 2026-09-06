import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import type { FileMutationIntentOperations, FilePathInspection } from "../../src/core/tools/file-mutation-intent.ts";

/** Public-safe filesystem port: every byte and identity lives in this fixture, never on disk. */
export function memoryFileBackend(flavor: "posix" | "win32") {
	const paths = flavor === "win32" ? win32 : posix;
	const files = new Map<string, string>();
	const directories = new Set<string>();
	const versions = new Map<string, number>();
	const probes: string[] = [];
	const aliases = new Map<string, string>();
	let nextPayload = 0;
	const key = (path: string) => aliases.get(path) ?? path;
	const error = (code: string) => Object.assign(new Error(`Synthetic filesystem ${code}`), { code });
	const mkdir = (path: string): void => {
		for (let current = path; !directories.has(current); current = paths.dirname(current)) {
			directories.add(current);
		}
	};
	const put = (path: string, content: string): void => {
		files.set(key(path), content);
		versions.set(key(path), (versions.get(key(path)) ?? 0) + 1);
	};
	const read = (path: string): string => {
		const content = files.get(key(path));
		if (content === undefined) throw error("ENOENT");
		return content;
	};
	const create = async (path: string, content: string): Promise<void> => {
		if (files.has(key(path)) || directories.has(key(path))) throw error("EEXIST");
		if (!directories.has(paths.dirname(key(path)))) throw error("ENOENT");
		put(path, content);
	};
	const mutationQueue = {
		resolveKey: async (path: string) => {
			probes.push(path);
			return key(path);
		},
	};
	const operations: FileMutationIntentOperations = {
		mutationQueue,
		async inspect(path): Promise<FilePathInspection | undefined> {
			probes.push(path);
			const kind = files.has(key(path)) ? "file" : directories.has(key(path)) ? "directory" : undefined;
			if (!kind) return undefined;
			return {
				kind,
				identity: {
					dev: "fixture",
					ino: key(path),
					mode: "fixture",
					size: String(files.get(key(path))?.length ?? 0),
					mtimeMs: String(versions.get(key(path)) ?? 0),
					ctimeMs: "0",
				},
			};
		},
		async access(path) {
			if (!files.has(key(path)) && !directories.has(key(path))) throw error("ENOENT");
		},
		copyFileExclusive: async (source, target) => create(target, read(source)),
		hashFile: async (path) => createHash("sha256").update(read(path)).digest("hex"),
		readPayload: async (path) => read(path),
		async removeFile(path) {
			if (!files.delete(key(path))) throw error("ENOENT");
		},
		async stagePayload(content) {
			const path = paths.join(
				flavor === "win32" ? "Z:\\fixture-payloads" : "/fixture-payloads",
				String(nextPayload++),
			);
			mkdir(paths.dirname(path));
			await create(path, content);
			return path;
		},
	};
	return {
		files,
		directories,
		probes,
		aliases,
		operations,
		mkdir,
		seed(path: string, content: string) {
			mkdir(paths.dirname(path));
			put(path, content);
		},
		read: {
			readFile: async (path: string) => Buffer.from(read(path)),
			access: (path: string) => operations.access(path, 4),
		},
		write: { createFile: create, mkdir: async (path: string) => mkdir(path) },
		edit: {
			readFile: async (path: string) => Buffer.from(read(path)),
			writeFile: async (path: string, content: string) => {
				read(path);
				put(path, content);
			},
		},
	};
}
