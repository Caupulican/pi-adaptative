import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleShareCommand } from "../src/modes/interactive/session-io-commands.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("session share process liveness", () => {
	let tempDir: string;
	let ghPidFile: string;
	let previousPath: string | undefined;

	beforeEach(() => {
		initTheme("dark");
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-share-liveness-"));
		ghPidFile = path.join(tempDir, "gh.pid");
		previousPath = process.env.PATH;
		const gh = path.join(tempDir, "gh");
		fs.writeFileSync(
			gh,
			`#!/bin/sh
if [ "\${1:-}" = "auth" ]; then exit 0; fi
printf '%s' "$$" > "$GH_PID_FILE"
trap '' TERM
while :; do sleep 30 & wait $!; done
`,
			{ mode: 0o700 },
		);
		process.env.PATH = `${tempDir}:${previousPath ?? ""}`;
		process.env.GH_PID_FILE = ghPidFile;
	});

	afterEach(() => {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		delete process.env.GH_PID_FILE;
		try {
			const pid = Number(fs.readFileSync(ghPidFile, "utf8"));
			if (Number.isInteger(pid) && pid > 0) process.kill(-pid, "SIGKILL");
		} catch {
			// Process already terminated or never launched.
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it.skipIf(process.platform === "win32")(
		"restores the editor after aborting a SIGTERM-trapping gh process",
		async () => {
			const statuses: string[] = [];
			const errors: string[] = [];
			const editor = { id: "editor" };
			let restored = false;
			let abortScheduled = false;
			let abortTriggered = false;
			let swapCount = 0;
			const host = {
				session: {
					async exportToHtml(filePath: string) {
						fs.writeFileSync(filePath, "<html></html>");
					},
				},
				ui: { requestRender() {} },
				editor,
				overlayHost: {
					swap(component: { handleInput?(data: string): void; id?: string }) {
						swapCount++;
						if (component === editor) {
							restored = true;
							return;
						}
						if (!abortScheduled) {
							abortScheduled = true;
							queueMicrotask(() => {
								(component as unknown as { cancel?: () => void }).cancel?.();
								abortTriggered = true;
							});
						}
					},
				},
				showStatus(message: string) {
					statuses.push(message);
				},
				showError(message: string) {
					errors.push(message);
				},
			};

			const run = handleShareCommand(host as never);
			const guard = new Promise<never>((_resolve, reject) => {
				setTimeout(
					() =>
						reject(
							new Error(
								`share did not settle: swaps=${swapCount} abort=${abortTriggered} statuses=${JSON.stringify(statuses)} errors=${JSON.stringify(errors)} pid=${fs.existsSync(ghPidFile)}`,
							),
						),
					3_000,
				).unref();
			});
			await Promise.race([run, guard]);

			expect(statuses).toContain("Share cancelled");
			expect(errors).toEqual([]);
			expect(restored).toBe(true);
		},
	);

	it.skipIf(process.platform === "win32")(
		"aborts the share without restoring over a superseding overlay",
		async () => {
			const statuses: string[] = [];
			const errors: string[] = [];
			const editor = { id: "editor" };
			const replacement = { id: "replacement" };
			let mounted: { id?: string } = editor;
			let mountedOnUnmount: (() => void) | undefined;
			let supersedeScheduled = false;
			const overlayHost = {
				swap(component: { id?: string }, options?: { onUnmount?: () => void }) {
					const previousOnUnmount = mountedOnUnmount;
					mountedOnUnmount = undefined;
					previousOnUnmount?.();
					mounted = component;
					mountedOnUnmount = options?.onUnmount;
					if (component !== editor && component !== replacement && !supersedeScheduled) {
						supersedeScheduled = true;
						queueMicrotask(() => overlayHost.swap(replacement));
					}
				},
			};
			const host = {
				session: {
					async exportToHtml(filePath: string) {
						fs.writeFileSync(filePath, "<html></html>");
					},
				},
				ui: { requestRender() {} },
				editor,
				overlayHost,
				showStatus(message: string) {
					statuses.push(message);
				},
				showError(message: string) {
					errors.push(message);
				},
			};

			const run = handleShareCommand(host as never);
			const guard = new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error("superseded share did not settle")), 3_000).unref();
			});
			await Promise.race([run, guard]);

			expect(statuses).toEqual([]);
			expect(errors).toEqual([]);
			expect(mounted).toBe(replacement);
		},
	);
});
