import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component } from "@caupulican/pi-tui";
import { Container } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { handleConfigRestoreCommand } from "../src/modes/interactive/config-backup.ts";
import { EditorOverlayHost } from "../src/modes/interactive/editor-overlay-host.ts";
import { handleInstallResourcesCommand } from "../src/modes/interactive/resource-shell-commands.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function component(label: string): Component {
	return {
		render: () => [label],
		invalidate: () => {},
	};
}

function overlayHarness() {
	const container = new Container();
	let focus: Component | null = null;
	const overlayHost = new EditorOverlayHost(container, {
		setFocus: (component) => {
			focus = component;
		},
		restoreFocus: (component) => {
			focus = component;
		},
		requestRender: () => {},
	});
	return { container, overlayHost, getFocus: () => focus };
}

type SelectorMount = {
	component: Component;
	focus: Component;
	onSuperseded?: () => void;
};

type SelectorOverlayHost = EditorOverlayHost & {
	showSelector(getRestore: () => Component, create: (done: () => void) => SelectorMount): void;
};

describe("selector supersession liveness", () => {
	beforeAll(() => initTheme("dark"));

	it("notifies an overlay before replacing it", () => {
		const { overlayHost } = overlayHarness();
		const first = component("first");
		let unmounted = 0;
		overlayHost.swap(first, { onUnmount: () => unmounted++ });
		overlayHost.swap(component("second"));
		expect(unmounted).toBe(1);
	});

	it("settles a selector even when displaced component cleanup throws", () => {
		const { container, overlayHost } = overlayHarness();
		const editor = component("editor");
		const selectorHost = overlayHost as SelectorOverlayHost;
		const defective: Component & { dispose(): void } = {
			...component("defective"),
			dispose: () => {
				throw new Error("cleanup failed");
			},
		};
		let superseded = 0;
		selectorHost.showSelector(
			() => editor,
			() => ({
				component: defective,
				focus: defective,
				onSuperseded: () => superseded++,
			}),
		);
		const replacement = component("replacement");

		expect(() =>
			selectorHost.showSelector(
				() => editor,
				() => ({ component: replacement, focus: replacement }),
			),
		).not.toThrow();
		expect(superseded).toBe(1);
		expect(container.children).toEqual([replacement]);
	});

	it("settles a reentrant overlay generation before mounting the outer replacement", () => {
		const { container, overlayHost } = overlayHarness();
		const nested = component("nested");
		const replacement = component("replacement");
		let nestedUnmounted = 0;
		overlayHost.swap(component("first"), {
			onUnmount: () => {
				overlayHost.swap(nested, { onUnmount: () => nestedUnmounted++ });
			},
		});

		overlayHost.swap(replacement);

		expect(nestedUnmounted).toBe(1);
		expect(container.children).toEqual([replacement]);
	});

	it("settles a superseded selector and ignores its late completion", () => {
		const { container, overlayHost } = overlayHarness();
		const editor = component("editor");
		let disposed = 0;
		const first: Component & { dispose(): void } = {
			...component("first"),
			dispose: () => disposed++,
		};
		const second = component("second");
		const selectorHost = overlayHost as SelectorOverlayHost;
		let firstDone: (() => void) | undefined;
		let superseded = 0;

		selectorHost.showSelector(
			() => editor,
			(done) => {
				firstDone = done;
				return { component: first, focus: first, onSuperseded: () => superseded++ };
			},
		);
		selectorHost.showSelector(
			() => editor,
			() => ({ component: second, focus: second }),
		);

		expect(superseded).toBe(1);
		expect(disposed).toBe(1);
		expect(container.children).toEqual([second]);
		firstDone?.();
		expect(container.children).toEqual([second]);
	});

	it("settles a restore confirmation when another overlay supersedes it", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-config-restore-supersession-"));
		try {
			const backupFile = join(root, "backup.json");
			writeFileSync(
				backupFile,
				JSON.stringify({
					profiles: {},
					settings: { resourceProfiles: {}, activeResourceProfiles: [], externalResourceRoots: [] },
				}),
			);
			const statuses: string[] = [];
			const errors: string[] = [];
			let reloads = 0;
			const command = handleConfigRestoreCommand(
				{
					settingsManager: { canonicalizePath: () => backupFile } as never,
					showError: (message) => errors.push(message),
					showStatus: (message) => statuses.push(message),
					showSelector: (create) => {
						const mounted = create(() => {});
						mounted.onSuperseded?.();
					},
					handleReloadCommand: async () => {
						reloads++;
						return true;
					},
				},
				backupFile,
			);

			const outcome = await Promise.race([
				command.then(() => "settled"),
				new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
			]);
			expect(outcome).toBe("settled");
			expect(statuses).toEqual(["Restore aborted."]);
			expect(errors).toEqual([]);
			expect(reloads).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("settles the install-resources trust prompt when another overlay supersedes it", async () => {
		const statuses: string[] = [];
		const command = handleInstallResourcesCommand(
			{
				settingsManager: {
					canonicalizePath: () => process.cwd(),
					getTrustedResourceRoots: () => [],
					addTrustedResourceRoot: () => {},
				},
				showError: (message) => {
					throw new Error(message);
				},
				showStatus: (message) => statuses.push(message),
				showSelector: (create) => {
					const mounted = create(() => {}) as SelectorMount;
					mounted.onSuperseded?.();
				},
				handleReloadCommand: async () => {},
				copyResourcesRecursively: () => {},
			},
			process.cwd(),
		);
		const outcome = await Promise.race([
			command.then(() => "settled"),
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
		]);
		expect(outcome).toBe("settled");
		expect(statuses).toEqual(["Installation aborted. Source directory was not trusted."]);
	});
});
