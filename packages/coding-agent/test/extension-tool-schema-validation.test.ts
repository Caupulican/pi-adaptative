import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";

describe("extension tool parameter schemas", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-schema-"));
		fs.mkdirSync(path.join(tempDir, "extensions"), { recursive: true });
	});
	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function writeExtension(name: string, parameters: string): void {
		fs.writeFileSync(
			path.join(tempDir, "extensions", `${name}.ts`),
			`export default function(pi) {
  pi.registerTool({
    name: ${JSON.stringify(name)},
    label: ${JSON.stringify(name)},
    description: "schema fixture",
    parameters: ${parameters},
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  });
}
`,
		);
	}

	it("rejects a tool whose parameter schema is not an object at registration, naming the tool and extension", async () => {
		writeExtension("bad_schema", '"not a schema"');
		writeExtension("array_schema", "[]");
		writeExtension("good_schema", '{ type: "object", properties: {}, additionalProperties: false }');

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		const errors = result.errors.map((entry) => entry.error).join("\n");
		expect(errors).toContain('Tool "bad_schema"');
		expect(errors).toContain('Tool "array_schema"');
		expect(errors).toContain("must define an object parameter schema");
		const registered = result.extensions.flatMap((extension) => [...extension.tools.keys()]);
		expect(registered).toEqual(["good_schema"]);
	});
});
