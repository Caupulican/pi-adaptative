import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	credentialToolBlockReason,
	credentialToolBlockReasonAsync,
} from "../src/core/secrets/credential-exposure-guard.ts";
import { pythonCredentialPathCandidates } from "../src/core/secrets/python-credential-literals.ts";
import { createNativeTaskDirectoryBackend } from "../src/core/tasks/native-task-directory-backend.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Python credential literal screening", () => {
	it.each([
		`print(f"{open('private.json').read()}")`,
		`print(f'{open("private.json").read()}')`,
		`print(rf"{open('private.json').read()}")`,
		String.raw`print(rf"\{open('private.json').read()}")`,
		String.raw`print(f"\{open('private.json').read()}")`,
		String.raw`print(rf"\\{open('private.json').read()}")`,
		String.raw`print(f"\\{open('private.json').read()}")`,
		`print(F"""{open('private.json').read()}""")`,
		`print(f"{ {'key': open('private.json').read()} }")`,
		`print(f"{f'{open("private.json").read()}'}")`,
		`print(f"{value:{len(open('private.json').read())}}")`,
		`print(f"{value:'>10}{open('private.json').read()}")`,
		`label = "unterminated\nopen('private.json')`,
		`${'f"{'.repeat(10_000)}open('private.json')${'}"'.repeat(10_000)}`,
	])("screens expression and recovery literal case %#", async (code) => {
		const cwd = process.cwd();
		const boundary = {
			redactSensitiveText: (text: string) => text,
			protectedFiles: [join(cwd, "private.json")],
			getPathProbe: () => ({ canonicalPath: () => undefined, isFile: () => undefined }),
		};
		expect(credentialToolBlockReason("python", { code }, cwd, boundary)).toContain("blocked");
		await expect(credentialToolBlockReasonAsync("python", { code }, cwd, boundary)).resolves.toContain("blocked");
		const ordinary = { code: code.replaceAll("private.json", "ordinary.json") };
		expect(credentialToolBlockReason("python", ordinary, cwd, boundary)).toBeUndefined();
		await expect(credentialToolBlockReasonAsync("python", ordinary, cwd, boundary)).resolves.toBeUndefined();
	});

	it.each(["f\"[{entry.get('name')}]\"", "f'[{entry.get(\"name\")}]'"])(
		"does not probe intervening source after mixed quotes: %s",
		async (expression) => {
			const cwd = await mkdtemp(join(tmpdir(), "pi-python-literals-"));
			temporaryDirectories.push(cwd);
			const code = [
				"def summarize(path, entry):",
				`    parts = [${expression}]`,
				'    label = " ".join(parts)',
				...Array.from({ length: 30 }, (_, index) => `    count_${index} = 0`),
				'    with path.open(encoding="utf-8") as stream:',
				"        return stream.read(), label",
			].join("\n");
			await expect(
				credentialToolBlockReasonAsync(
					"python",
					{ code },
					cwd,
					undefined,
					undefined,
					createNativeTaskDirectoryBackend(),
				),
			).resolves.toBeUndefined();
		},
	);

	it.each([
		{ literal: '"owner\'s/private.json"', path: "owner's/private.json" },
		{ literal: "'owner\"s/private.json'", path: 'owner"s/private.json' },
		{ literal: String.raw`"owner\"s/private.json"`, path: 'owner"s/private.json' },
		{ literal: String.raw`'owner\'s/private.json'`, path: "owner's/private.json" },
		{ literal: `"""owner's/private.json"""`, path: "owner's/private.json" },
	])("retains protected literals containing quotes: $literal", async ({ literal, path }) => {
		const cwd = process.cwd();
		const boundary = {
			redactSensitiveText: (text: string) => text,
			protectedFiles: [join(cwd, path)],
			getPathProbe: () => ({ canonicalPath: () => undefined, isFile: () => undefined }),
		};
		const input = { code: `path = ${literal}\nopen(path).read()` };
		expect(credentialToolBlockReason("python", input, cwd, boundary)).toContain("blocked");
		await expect(credentialToolBlockReasonAsync("python", input, cwd, boundary)).resolves.toContain("blocked");
		const ordinary = { code: 'path = "ordinary.json"\nopen(path).read()' };
		expect(credentialToolBlockReason("python", ordinary, cwd, boundary)).toBeUndefined();
		await expect(credentialToolBlockReasonAsync("python", ordinary, cwd, boundary)).resolves.toBeUndefined();
	});

	it.each([
		{ code: `print(f"{{ordinary}}")`, expected: ["{ordinary}"] },
		{ code: `print(f"{{open('private.json')}}")`, expected: ["{open('private.json')}"] },
		{ code: `# owner's comment\nopen("ordinary.json")`, expected: ["ordinary.json"] },
		{ code: `print("unterminated${"x".repeat(190_000)}`, expected: [] },
		{ code: `print("""unterminated${"x".repeat(190_000)}`, expected: [] },
	])("bounds literal scanning and preserves non-expression text, case %#", ({ code, expected }) => {
		expect([...pythonCredentialPathCandidates(code)]).toEqual(expected);
	});
});
