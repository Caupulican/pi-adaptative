import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openRemoteEditFile } from "../examples/extensions/ssh.ts";
import { tempDir } from "./temp-dir.ts";

describe("SSH open edit resource protocol", () => {
	it.skipIf(process.platform === "win32")(
		"keeps one binary-safe remote descriptor across a pathname replacement",
		async () => {
			const dir = tempDir("pi-ssh-edit-resource-");
			const path = join(dir, "target ' name.txt");
			const displacedPath = join(dir, "displaced.txt");
			const before = Buffer.from([0x62, 0x65, 0x66, 0x6f, 0x72, 0x65, 0x00, 0x0a]);
			const after = Buffer.from([0x61, 0x66, 0x74, 0x65, 0x72, 0x00, 0xff, 0x0a]);
			await writeFile(path, before);

			const resource = await openRemoteEditFile("local-fixture", path, (_remote, resourcePath, server) =>
				spawn("bash", ["-c", server, "bash", resourcePath], { stdio: ["pipe", "pipe", "pipe"] }),
			);
			try {
				const openedBefore = await resource.inspect();
				expect(openedBefore.linkCount).toBe("1");
				expect(await resource.readFile()).toEqual(before);

				await rename(path, displacedPath);
				await writeFile(path, "foreign replacement\n", "utf8");
				await resource.writeFile(after);

				const openedAfter = await resource.inspect();
				expect(openedAfter.identity.dev).toBe(openedBefore.identity.dev);
				expect(openedAfter.identity.ino).toBe(openedBefore.identity.ino);
				expect(await resource.readFile()).toEqual(after);
			} finally {
				await resource.close();
			}

			expect(await readFile(path, "utf8")).toBe("foreign replacement\n");
			expect(await readFile(displacedPath)).toEqual(after);
		},
	);
});
