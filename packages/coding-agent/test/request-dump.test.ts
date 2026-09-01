import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { dumpProviderRequest } from "../src/core/request-dump.ts";

const originalDumpDir = process.env.PI_REQUEST_DUMP_DIR;
const tempDirs: string[] = [];

afterEach(() => {
	if (originalDumpDir === undefined) delete process.env.PI_REQUEST_DUMP_DIR;
	else process.env.PI_REQUEST_DUMP_DIR = originalDumpDir;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readDumpedPayload(dir: string): any {
	const [name] = readdirSync(dir);
	if (!name) throw new Error("Expected a dumped request file");
	return JSON.parse(readFileSync(join(dir, name), "utf-8"));
}

describe("dumpProviderRequest", () => {
	it("records the full projected tool payload, including the parameters schema, not just name/description", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-request-dump-"));
		tempDirs.push(dir);
		process.env.PI_REQUEST_DUMP_DIR = dir;

		const parameters = Type.Object({
			path: Type.String({ description: "File to read" }),
			offset: Type.Optional(Type.Number()),
		});
		const context: Context = {
			systemPrompt: "You are a coding agent.",
			messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }],
			tools: [{ name: "read", description: "Read a file", parameters }],
		};

		dumpProviderRequest("req-0", context);

		const payload = readDumpedPayload(dir);
		expect(payload.tools).toHaveLength(1);
		expect(payload.tools[0].name).toBe("read");
		expect(payload.tools[0].description).toBe("Read a file");
		// The exact defect this fixes: a schema-only change (e.g. a new/removed parameter) was
		// previously invisible to the dump diff used to debug provider prefix problems.
		expect(payload.tools[0].parameters).toEqual(parameters);
	});

	it("does nothing when PI_REQUEST_DUMP_DIR is unset (opt-in only)", () => {
		delete process.env.PI_REQUEST_DUMP_DIR;
		const dir = mkdtempSync(join(tmpdir(), "pi-request-dump-unset-"));
		tempDirs.push(dir);
		// Never referenced by the call below, so nothing should be written to it or anywhere else --
		// this just proves the call is a no-op, not a crash, absent the env var.
		expect(() =>
			dumpProviderRequest("req-0", {
				messages: [],
				tools: [{ name: "read", description: "Read a file", parameters: Type.Object({}) }],
			}),
		).not.toThrow();
		expect(readdirSync(dir)).toHaveLength(0);
	});

	it("never throws into the request it observes, even when the dump directory cannot be created", () => {
		// A file where a directory is expected: mkdirSync(..., {recursive:true}) fails underneath it.
		const dir = mkdtempSync(join(tmpdir(), "pi-request-dump-blocked-"));
		tempDirs.push(dir);
		const blockedPath = join(dir, "not-a-directory");
		writeFileSync(blockedPath, "occupied");
		process.env.PI_REQUEST_DUMP_DIR = join(blockedPath, "nested");

		expect(() =>
			dumpProviderRequest("req-0", {
				messages: [],
				tools: [{ name: "read", description: "Read a file", parameters: Type.Object({}) }],
			}),
		).not.toThrow();
		expect(existsSync(blockedPath)).toBe(true);
	});
});
