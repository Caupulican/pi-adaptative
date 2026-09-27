import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import {
	acquirePersistentShellSession,
	buildBashOneShotWire,
	disposePersistentShellSession,
} from "../src/core/tools/shell-session.ts";

const IS_WINDOWS = process.platform === "win32";
const liveSessionKeys: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const key of liveSessionKeys) disposePersistentShellSession(key);
	liveSessionKeys.length = 0;
});

describe("Bash one-shot output relay selection", () => {
	it("does not install the EOF relay on Windows where detached descendants inherit its handle", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");

		expect(buildBashOneShotWire("printf child-exiting")).toBe("printf child-exiting");
	});

	it("keeps the relay on POSIX where it drains Node's Unix-socket stdout", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");

		expect(buildBashOneShotWire("printf child-exiting")).toContain("__pi_output_relay");
	});
});

describe.skipIf(IS_WINDOWS)("Bash inherited Node stdio", () => {
	const cwd = process.cwd();
	const command = `node -e "process.stdout.write('node-output\\n'); process.exit(3)"`;

	it("negative control captures a synchronous Node write through the one-shot backend", async () => {
		const chunks: Buffer[] = [];
		const result = await createLocalBashOperations().exec(
			`node -e "require('node:fs').writeSync(1, 'sync-output\\n')"`,
			cwd,
			{ onData: (data) => chunks.push(data) },
		);

		expect(result.exitCode).toBe(0);
		expect(Buffer.concat(chunks).toString("utf8")).toBe("sync-output\n");
	});

	it("drains asynchronous Node stdout before a one-shot shell reports its exit", async () => {
		const chunks: Buffer[] = [];
		const result = await createLocalBashOperations().exec(command, cwd, {
			onData: (data) => chunks.push(data),
		});

		expect(result.exitCode).toBe(3);
		expect(Buffer.concat(chunks).toString("utf8")).toBe("node-output\n");
	});

	it("drains asynchronous Node stdout before a persistent shell terminal frame", async () => {
		const key = `bash-node-stdio-${randomUUID()}`;
		liveSessionKeys.push(key);
		const chunks: Buffer[] = [];
		const result = await acquirePersistentShellSession(key, "bash").exec(command, cwd, {
			onData: (data) => chunks.push(data),
		});

		expect(result.exitCode).toBe(3);
		expect(Buffer.concat(chunks).toString("utf8")).toBe("node-output\n");
	});

	it("does not let a detached descendant holding stdout block later persistent commands", async () => {
		const key = `bash-node-descendant-${randomUUID()}`;
		liveSessionKeys.push(key);
		const session = acquirePersistentShellSession(key, "bash");
		const detached = await session.exec(
			`node -e "require('node:child_process').spawn('sleep',['30'],{stdio:'inherit'}).unref()"`,
			cwd,
			{ onData: () => {}, timeoutSeconds: 2 },
		);
		const chunks: Buffer[] = [];
		const followUp = await session.exec("printf still-responsive", cwd, {
			onData: (data) => chunks.push(data),
			timeoutSeconds: 2,
		});

		expect(detached.exitCode).toBe(0);
		expect(followUp.exitCode).toBe(0);
		expect(Buffer.concat(chunks).toString("utf8")).toBe("still-responsive");
	});
});
