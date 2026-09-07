import { describe, expect, it } from "vitest";
import { mockCredentialContent, mockProtectedSearchLines } from "../src/core/secrets/credential-content-mock.ts";

describe("credential content mock stream", () => {
	it("keeps dotenv keys and structure while mocking every value", () => {
		const content = [
			"# comment",
			"export OPENAI_API_KEY=sk-proj-abcdefghijklmnop",
			"DB_URL='postgres://user:pw@host/db'",
			"EMPTY=",
			"12: TOKEN=abc123",
			"plain line without assignment",
		].join("\n");
		expect(mockCredentialContent(content)).toBe(
			[
				"# comment",
				"export OPENAI_API_KEY=<mocked:OPENAI_API_KEY>",
				"DB_URL=<mocked:DB_URL>",
				"EMPTY=",
				"12: TOKEN=<mocked:TOKEN>",
				"plain line without assignment",
			].join("\n"),
		);
	});

	it("mocks JSON and YAML secrets by key and collapses key material", () => {
		const content = [
			"{",
			'  "name": "profile",',
			'  "api_key": "sk-live-0123456789abcdef",',
			'  "refreshToken": "eyJabcdefghij.eyJabcdefghij.abcdefghijk",',
			"}",
			"password: hunter2",
			"-----BEGIN PRIVATE KEY-----",
			"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC",
			"-----END PRIVATE KEY-----",
		].join("\n");
		const mocked = mockCredentialContent(content);
		expect(mocked).toContain('"name": "profile"');
		expect(mocked).toContain('"api_key": "<mocked:api_key>"');
		expect(mocked).toContain('"refreshToken": "<mocked:refreshToken>"');
		expect(mocked).toContain("password: <mocked:password>");
		expect(mocked).toContain("password: <mocked:password>\n<mocked:PEM PRIVATE KEY>");
		expect(mocked).not.toContain("BEGIN PRIVATE KEY");
		expect(mocked).not.toContain("hunter2");
		expect(mocked).not.toContain("MIIEvQ");
	});

	it("mocks only search lines attributed to protected files", () => {
		const output = [
			"src/app.ts:3:const token = readToken();",
			".env:1:TOKEN=abc123",
			".env-2-SECRET=zzz",
			"config/.env.local:OTHER=1",
			"D:\\work\\.env:4:PASSWORD=pw",
			"notes.md:1:sk-proj-abcdefghijklmnop leaked",
		].join("\n");
		const mocked = mockProtectedSearchLines(output, (path) => path.includes(".env"));
		expect(mocked).toBe(
			[
				"src/app.ts:3:const token = readToken();",
				".env:1:TOKEN=<mocked:TOKEN>",
				".env-2-SECRET=<mocked:SECRET>",
				"config/.env.local:OTHER=<mocked:OTHER>",
				"D:\\work\\.env:4:PASSWORD=<mocked:PASSWORD>",
				"notes.md:1:[REDACTED] leaked",
			].join("\n"),
		);
	});
});
