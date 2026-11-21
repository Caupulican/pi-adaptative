import { expect, it } from "vitest";
import { createCredentialBlockMask, mockCredentialFields } from "../src/core/secrets/credential-content-mock.ts";
import { assessCredentialExposureAsync } from "../src/core/secrets/credential-exposure-guard.ts";
import { createNativeTaskDirectoryBackend } from "../src/core/tasks/native-task-directory-backend.ts";
import { assessToolFailure } from "../src/kernel/tool-failure-memory.ts";

it("masks complete and partial quoted passwords in command output and saved output blocks", () => {
	const maskBlock = createCredentialBlockMask({ kind: "fields" });
	for (const label of ["password ", "passphrase is ", "passwd: "]) {
		const row = `legacy ${label}'sample \\'words\\' here'; record 42`;
		expect(mockCredentialFields(row)).toBe("legacy [REDACTED]; record 42");
		expect(maskBlock(`${row}\r\n`)).toBe("legacy [REDACTED]; record 42\r\n");
		expect(mockCredentialFields(`legacy ${label}"partial value\\`)).toBe("legacy [REDACTED]");
	}
	const publicText = "password policy: required\npassword is required\npasswordless authentication";
	expect(mockCredentialFields(publicText)).toBe(publicText);
});

it("checks actual paths alongside overlong Python literals and shell filters", async () => {
	const backend = createNativeTaskDirectoryBackend();
	const assess = (name: string, args: Record<string, string>) =>
		assessCredentialExposureAsync(name, args, process.cwd(), undefined, undefined, backend);
	const literal = "a".repeat(512);
	const code = `label = "${literal}"\nprint(open("package.json").read())`;
	expect((await assess("python", { code })).kind).toBe("none");
	expect((await assess("python", { code: `${code}\nprint(open(".env").read())` })).kind).toBe("content");
	expect(
		(await assess("bash", { command: `jq 'select(.label == "${literal}")' package.json` })).reason,
	).toBeUndefined();
});

it("propagates an unreadable candidate and retains a multiline errno's diagnostic", async () => {
	const denied = Object.assign(new Error("denied"), { code: "EACCES" });
	await expect(
		assessCredentialExposureAsync("python", { code: 'open("sample.txt")' }, process.cwd(), undefined, undefined, {
			canonicalPath() {
				throw denied;
			},
		}),
	).rejects.toBe(denied);
	const assessment = assessToolFailure("ENAMETOOLONG: name too long, lstat 'line one\nline two\n'", "failed", "Error");
	expect(assessment.diagnostic).toContain("ENAMETOOLONG: name too long");
});
