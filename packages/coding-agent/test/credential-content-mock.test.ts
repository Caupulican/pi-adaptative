import { describe, expect, it } from "vitest";
import {
	mockCredentialContent,
	mockCredentialFields,
	mockProtectedSearchLines,
} from "../src/core/secrets/credential-content-mock.ts";

describe("credential content mock stream", () => {
	it("masks Trello query credentials in consumer diagnostics while retaining request context", () => {
		const secret = "opaque-private-value";
		for (let end = 1; end <= secret.length; end++) {
			const output = mockCredentialFields(
				`GET https://api.trello.com/1/members/me?fields=id&key=${secret.slice(0, end)}`,
			);
			expect(output).toBe("GET https://api.trello.com/1/members/me?fields=id[REDACTED]");
		}
		expect(
			mockCredentialFields(`request failed: https://api.trello.com/1/members/me?key=${secret}&token=${secret}`),
		).not.toContain(secret);
	});

	it("masks compact JSON credentials and opaque session/key file contents", () => {
		const secret = "opaque-trello-secret-value";
		const content = JSON.stringify({ name: "trello", credentials: { TRELLO_API_KEY: secret, TRELLO_TOKEN: secret } });
		const mocked = mockCredentialContent(content);
		expect(mocked).not.toContain(secret);
		expect(JSON.parse(mocked)).toMatchObject({ name: "trello", credentials: { TRELLO_API_KEY: expect.any(String) } });
		expect(mockCredentialContent(`${secret}\n`)).not.toContain(secret);
		expect(mockCredentialContent(`1: ${secret}\n`)).not.toContain(secret);
		const rawSession = `${"a".repeat(86)}==`;
		expect(mockCredentialContent(rawSession)).not.toContain("a".repeat(16));
	});

	it("masks incomplete JSON and each cumulative credential update before a value is complete", () => {
		const secret = "opaque-trello-secret-value";
		for (let end = 1; end <= secret.length; end++) {
			const fragment = secret.slice(0, end);
			for (const content of [`TRELLO_TOKEN=${fragment}`, `{"TRELLO_TOKEN":"${fragment}`, fragment]) {
				const mocked = mockCredentialContent(content);
				expect(mocked).not.toBe(content);
				expect(mocked).not.toContain(`=${fragment}`);
				expect(mocked).not.toContain(`:"${fragment}`);
			}
		}
	});

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
