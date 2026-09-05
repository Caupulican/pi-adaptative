import { constants, lstatSync, mkdirSync, realpathSync, type Stats, symlinkSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PiSelfLaunchTarget } from "../core/process-matrix/resume-launcher.ts";
import { normalizeSelfLaunchTarget } from "../core/process-matrix/self-launch-target.ts";
import { readBoundedDirectoryNamesSync, sameFileVersion } from "../core/util/bounded-file.ts";

export interface RuntimeOrigin {
	root: string;
	entries: readonly string[];
	target: PiSelfLaunchTarget;
}

export const MAX_RUNTIME_ARTIFACT_ENTRIES = 100_000;

/** Copies code and dependencies, never hard-links mutable files into a rollback generation. */
export class RuntimeArtifactStore {
	private readonly origin: RuntimeOrigin | (() => Promise<RuntimeOrigin>);
	private readonly directory: string;
	private readonly owned = new Map<string, PiSelfLaunchTarget>();
	private captures = 0;

	constructor(origin: RuntimeOrigin | (() => Promise<RuntimeOrigin>), directory: string) {
		this.origin = origin;
		this.directory = directory;
	}

	async capture(): Promise<string> {
		if (this.owned.size + this.captures >= 3) throw new Error("Runtime artifact retention limit reached.");
		this.captures++;
		try {
			return await this.captureGeneration();
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
		const copies: Array<{ source: string; target: string; stat: Stats }> = [];
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
				copies.push({ source, target: destination, stat });
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
			const results = await Promise.allSettled(
				Array.from({ length: 8 }, async () => {
					for (;;) {
						const item = copies[index++];
						if (!item) break;
						const before = item.stat;
						await copyFile(item.source, item.target, constants.COPYFILE_FICLONE);
						const after = await lstat(item.source);
						if (!sameFileVersion(before, after))
							throw new Error(`Runtime file changed during capture: ${item.source}`);
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
