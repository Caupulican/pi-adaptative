import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	collectResourceFilesRecursively,
	isResourcePathWithin,
	type ResourceDirectoryRecord,
	type ResourceStatRecord,
	type ResourceTraversalPort,
	readResourceDirectory,
} from "../src/core/resource-traversal.ts";

function record(name: string, kind: "file" | "directory" | "symbolic-link" | "other"): ResourceDirectoryRecord {
	return {
		name,
		isDirectory: () => kind === "directory",
		isFile: () => kind === "file",
		isSymbolicLink: () => kind === "symbolic-link",
	};
}

function stats(kind: "file" | "directory"): ResourceStatRecord {
	return {
		isDirectory: () => kind === "directory",
		isFile: () => kind === "file",
	};
}

describe("resource traversal", () => {
	it("classifies each entry once and walks only admitted directory trees", () => {
		const root = join("root", "resources");
		const nested = join(root, "nested");
		const linked = join(root, "linked");
		const reads: string[] = [];
		const statCalls: string[] = [];
		const tree = new Map<string, ResourceDirectoryRecord[]>([
			[
				root,
				[
					record("root.md", "file"),
					record("root.json", "file"),
					record("nested", "directory"),
					record("linked", "symbolic-link"),
					record("broken", "symbolic-link"),
					record(".hidden", "directory"),
					record("node_modules", "directory"),
				],
			],
			[nested, [record("nested.md", "file"), record("nested.txt", "file")]],
			[linked, [record("linked.md", "file")]],
		]);
		const port: ResourceTraversalPort = {
			pathExists: (path) => tree.has(path),
			readDirectory: (path) => {
				reads.push(path);
				return tree.get(path) ?? [];
			},
			stat: (path) => {
				statCalls.push(path);
				if (path === linked) return stats("directory");
				throw new Error("broken symbolic link");
			},
		};

		expect(
			collectResourceFilesRecursively(root, (entry) => entry.name.endsWith(".md"), {
				port,
				skipHidden: true,
				skipNodeModules: true,
			}),
		).toEqual([join(root, "root.md"), join(nested, "nested.md"), join(linked, "linked.md")]);
		expect(reads).toEqual([root, nested, linked]);
		expect(statCalls).toEqual([linked, join(root, "broken")]);
	});

	it("does not inspect symbolic-link targets when link following is disabled", () => {
		const root = join("root", "resources");
		let statCalls = 0;
		const port: ResourceTraversalPort = {
			pathExists: () => true,
			readDirectory: () => [record("linked.md", "symbolic-link")],
			stat: () => {
				statCalls += 1;
				return stats("file");
			},
		};

		expect(
			collectResourceFilesRecursively(root, () => true, {
				followSymbolicLinks: false,
				port,
			}),
		).toEqual([]);
		expect(statCalls).toBe(0);
	});

	it("classifies descendants without admitting sibling paths that share a prefix", () => {
		const root = join("root", "resources");
		expect(isResourcePathWithin(root, root)).toBe(true);
		expect(isResourcePathWithin(join(root, "nested", "skill.md"), root)).toBe(true);
		expect(isResourcePathWithin(join("root", "resources-backup", "skill.md"), root)).toBe(false);
	});

	it("reports one directory read failure without exposing a partial entry set", () => {
		const root = join("root", "resources");
		const failures: Array<{ path: string; error: unknown }> = [];
		const readFailure = new Error("permission denied");
		const port: ResourceTraversalPort = {
			pathExists: () => true,
			readDirectory: () => {
				throw readFailure;
			},
			stat: () => stats("file"),
		};

		expect(
			readResourceDirectory(root, {
				onDirectoryReadError: (path, error) => failures.push({ path, error }),
				port,
			}),
		).toEqual([]);
		expect(failures).toEqual([{ path: root, error: readFailure }]);
	});
});
