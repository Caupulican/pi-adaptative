import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	catalogWorkerResourcePointers,
	selectWorkerResourcePointers,
	workerResourcePointerId,
} from "../src/core/delegation/worker-resource-catalog.ts";
import {
	materializeWorkerResourceBundle,
	WorkerResourceMaterializer,
} from "../src/core/delegation/worker-resource-materializer.ts";
import type { ResourcePointer } from "../src/core/orchestration/contracts.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const roots: string[] = [];

function profile(resources: {
	skills?: { allow?: string[]; block?: string[] };
	prompts?: { allow?: string[]; block?: string[] };
}) {
	return { resources };
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function tempRoot(): string {
	const root = join(tmpdir(), `pi-worker-resource-pointers-${process.pid}-${Date.now()}-${roots.length}`);
	roots.push(root);
	mkdirSync(root, { recursive: true });
	return root;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("worker resource pointer catalog", () => {
	it("does not discover resources when linked profiles admit no resource kind", () => {
		const root = tempRoot();
		const loader = {
			getDiscoverableSkillPaths: vi.fn(() => [join(root, "skills", "SKILL.md")]),
			getDiscoverablePromptPaths: vi.fn(() => [join(root, "prompts", "task.md")]),
		};

		const pointers = catalogWorkerResourcePointers({
			cwd: root,
			resourceLoader: loader,
			resourceProfiles: [profile({})],
		});

		expect(pointers).toEqual([]);
		expect(loader.getDiscoverableSkillPaths).not.toHaveBeenCalled();
		expect(loader.getDiscoverablePromptPaths).not.toHaveBeenCalled();
	});

	it("discovers only metadata paths and never invokes content loader APIs", () => {
		const root = tempRoot();
		const skill = join(root, "skills", "safe", "SKILL.md");
		const prompt = join(root, "prompts", "safe.md");
		mkdirSync(resolve(skill, ".."), { recursive: true });
		mkdirSync(resolve(prompt, ".."), { recursive: true });
		writeFileSync(skill, "skill body");
		writeFileSync(prompt, "prompt body");
		const loader = {
			getDiscoverableSkillPaths: vi.fn(() => [skill]),
			getDiscoverablePromptPaths: vi.fn(() => [prompt]),
			getSkills: vi.fn(() => {
				throw new Error("content loader must not run");
			}),
			getPrompts: vi.fn(() => {
				throw new Error("content loader must not run");
			}),
		};
		const readFileSpy = vi.mocked(fs.readFileSync);
		readFileSpy.mockClear();

		const pointers = catalogWorkerResourcePointers({
			cwd: root,
			resourceLoader: loader,
			resourceProfiles: [profile({ skills: { allow: ["*"] }, prompts: { allow: ["*"] } })],
		});

		expect(pointers.map((pointer) => pointer.kind)).toEqual(["prompt", "skill"]);
		expect(loader.getDiscoverableSkillPaths).toHaveBeenCalledOnce();
		expect(loader.getDiscoverablePromptPaths).toHaveBeenCalledOnce();
		expect(loader.getSkills).not.toHaveBeenCalled();
		expect(loader.getPrompts).not.toHaveBeenCalled();
		expect(readFileSpy).not.toHaveBeenCalled();
	});

	it("requires an explicit allow pattern and lets blocks win after deterministic profile merging", () => {
		const root = tempRoot();
		const allowed = join(root, "skills", "allowed", "SKILL.md");
		const blocked = join(root, "skills", "blocked", "SKILL.md");
		mkdirSync(resolve(allowed, ".."), { recursive: true });
		mkdirSync(resolve(blocked, ".."), { recursive: true });
		writeFileSync(allowed, "allowed");
		writeFileSync(blocked, "blocked");
		const loader = {
			getDiscoverableSkillPaths: () => [blocked, allowed],
			getDiscoverablePromptPaths: () => [],
		};

		expect(
			catalogWorkerResourcePointers({
				cwd: root,
				resourceLoader: loader,
				resourceProfiles: [profile({ skills: { block: ["*"] } })],
			}),
		).toEqual([]);
		expect(
			catalogWorkerResourcePointers({
				cwd: root,
				resourceLoader: loader,
				resourceProfiles: [profile({ skills: { allow: ["*"] } }), profile({ skills: { block: ["blocked"] } })],
			}),
		).toMatchObject([{ kind: "skill", metadata: { name: "SKILL.md" } }]);
	});

	it("uses deterministic IDs from canonical kind and path", () => {
		const root = tempRoot();
		const skill = join(root, "skills", "safe", "SKILL.md");
		mkdirSync(resolve(skill, ".."), { recursive: true });
		writeFileSync(skill, "safe");
		const pathWithTraversal = join(root, "skills", "safe", "..", "safe", "SKILL.md");
		const loader = { getDiscoverableSkillPaths: () => [pathWithTraversal], getDiscoverablePromptPaths: () => [] };

		const [pointer] = catalogWorkerResourcePointers({
			cwd: root,
			resourceLoader: loader,
			resourceProfiles: [profile({ skills: { allow: ["*"] } })],
		});

		expect(pointer?.id).toBe(workerResourcePointerId("skill", skill));
		expect(pointer?.readOnly).toBe(true);
		expect(pointer?.uri).toMatch(/^file:/);
	});

	it("selects admitted pointers in request order and distinguishes unknown and duplicate IDs", () => {
		const pointers: ResourcePointer[] = [
			{ id: "skill:a", kind: "skill", uri: "file:///tmp/a", readOnly: true },
			{ id: "prompt:b", kind: "prompt", uri: "file:///tmp/b", readOnly: true },
		];

		expect(selectWorkerResourcePointers(pointers, ["prompt:b", "skill:a"])).toEqual({
			ok: true,
			pointers: [pointers[1], pointers[0]],
		});
		expect(selectWorkerResourcePointers(pointers, ["missing"])).toEqual({
			ok: false,
			reason: "worker_resource_pointer_unknown",
			pointerId: "missing",
		});
		expect(selectWorkerResourcePointers(pointers, ["skill:a", "skill:a"])).toEqual({
			ok: false,
			reason: "worker_resource_pointer_duplicate",
			pointerId: "skill:a",
		});
	});
});

describe("WorkerResourceMaterializer", () => {
	it("renders admitted content as compact JSON without presentation-only XML", () => {
		const root = tempRoot();
		const file = join(root, "resource.md");
		writeFileSync(file, "use exact evidence");
		const pointers = catalogWorkerResourcePointers({
			cwd: root,
			resourceLoader: { getDiscoverableSkillPaths: () => [], getDiscoverablePromptPaths: () => [file] },
			resourceProfiles: [profile({ prompts: { allow: ["*"] } })],
		});

		const result = materializeWorkerResourceBundle(pointers);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("Expected resource bundle");
		expect(result.systemPrompt).toContain("use exact evidence");
		expect(result.systemPrompt).toContain("never expands tools");
		expect(result.systemPrompt).not.toContain("<worker_resources_json>");
	});

	it("reads only a selected admitted pointer and bounds materialized output", () => {
		const root = tempRoot();
		const selected = join(root, "selected.md");
		const unselected = join(root, "unselected.md");
		writeFileSync(selected, "selected");
		writeFileSync(unselected, "unselected");
		const pointers = catalogWorkerResourcePointers({
			cwd: root,
			resourceLoader: {
				getDiscoverableSkillPaths: () => [],
				getDiscoverablePromptPaths: () => [selected, unselected],
			},
			resourceProfiles: [profile({ prompts: { allow: ["*"] } })],
		});
		const selectedPointer = pointers.find((pointer) => pointer.metadata?.name === "selected.md");
		const unselectedPointer = pointers.find((pointer) => pointer.metadata?.name === "unselected.md");
		if (!selectedPointer || !unselectedPointer) throw new Error("test pointers missing");
		const materializer = new WorkerResourceMaterializer({
			resources: [selectedPointer],
			maxResourceBytes: 16,
			maxTotalBytes: 16,
		});
		const readFileSpy = vi.mocked(fs.readFileSync);
		readFileSpy.mockClear();

		expect(materializer.materialize(selectedPointer.id)).toMatchObject({ ok: true, content: "selected" });
		expect(readFileSpy).not.toHaveBeenCalled();
		expect(materializer.materialize(unselectedPointer.id)).toEqual({
			ok: false,
			code: "unknown_pointer",
			pointerId: unselectedPointer.id,
		});
	});

	it("fails closed for forged URIs, changed digests, and oversized files", () => {
		const root = tempRoot();
		const file = join(root, "resource.md");
		writeFileSync(file, "original");
		const [pointer] = catalogWorkerResourcePointers({
			cwd: root,
			resourceLoader: { getDiscoverableSkillPaths: () => [], getDiscoverablePromptPaths: () => [file] },
			resourceProfiles: [profile({ prompts: { allow: ["*"] } })],
		});
		if (!pointer) throw new Error("test pointer missing");
		const forged = { ...pointer, uri: `${pointer.uri}/../outside.md` };
		expect(new WorkerResourceMaterializer({ resources: [forged] }).materialize(forged.id)).toMatchObject({
			ok: false,
			code: "invalid_pointer",
		});

		const digestPointer = { ...pointer, digest: sha256("original") };
		writeFileSync(file, "changed");
		expect(
			new WorkerResourceMaterializer({ resources: [digestPointer] }).materialize(digestPointer.id),
		).toMatchObject({
			ok: false,
			code: "digest_mismatch",
		});
		expect(
			new WorkerResourceMaterializer({ resources: [pointer], maxResourceBytes: 3 }).materialize(pointer.id),
		).toMatchObject({
			ok: false,
			code: "resource_oversize",
		});
	});

	it("rejects non-files and never exceeds its aggregate content budget", () => {
		const root = tempRoot();
		const directory = join(root, "directory.md");
		const first = join(root, "first.md");
		const second = join(root, "second.md");
		mkdirSync(directory);
		writeFileSync(first, "four");
		writeFileSync(second, "fives");
		const pointers = catalogWorkerResourcePointers({
			cwd: root,
			resourceLoader: {
				getDiscoverableSkillPaths: () => [],
				getDiscoverablePromptPaths: () => [directory, first, second],
			},
			resourceProfiles: [profile({ prompts: { allow: ["*"] } })],
		});
		const directoryPointer = pointers.find((pointer) => pointer.metadata?.name === "directory.md");
		const firstPointer = pointers.find((pointer) => pointer.metadata?.name === "first.md");
		const secondPointer = pointers.find((pointer) => pointer.metadata?.name === "second.md");
		if (!directoryPointer || !firstPointer || !secondPointer) throw new Error("test pointers missing");

		expect(
			new WorkerResourceMaterializer({ resources: [directoryPointer] }).materialize(directoryPointer.id),
		).toEqual({
			ok: false,
			code: "not_regular_file",
			pointerId: directoryPointer.id,
		});
		const materializer = new WorkerResourceMaterializer({
			resources: [firstPointer, secondPointer],
			maxResourceBytes: 8,
			maxTotalBytes: 8,
		});
		expect(materializer.materialize(firstPointer.id)).toMatchObject({ ok: true, content: "four" });
		expect(materializer.materialize(secondPointer.id)).toEqual({
			ok: false,
			code: "aggregate_oversize",
			pointerId: secondPointer.id,
		});
	});
});
