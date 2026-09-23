import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// The session builder registers the host's modules, exactly as every session does.
import "../src/core/sdk.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtension } from "../src/core/extensions/loader.ts";
import { getHostExtensionModules } from "../src/core/extensions/virtual-modules.ts";
import * as host from "../src/index.ts";

declare global {
	var __piExtensionHostProbe: unknown;
}

describe("extensions inside a session", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
		globalThis.__piExtensionHostProbe = undefined;
	});

	it("bind to the running program's own modules instead of a private copy", async () => {
		expect(getHostExtensionModules()?.["@caupulican/pi-adaptative"]).toBe(host);
		dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "pi-ext-host-"));
		const file = path.join(dir, "probe.ts");
		fs.writeFileSync(
			file,
			`import { createAgentSession } from "@caupulican/pi-adaptative";
export default function () {
	globalThis.__piExtensionHostProbe = createAgentSession;
}
`,
		);
		const { error } = await loadExtension(file, dir, createEventBus(), createExtensionRuntime());
		expect(error).toBeNull();
		expect(globalThis.__piExtensionHostProbe).toBe(host.createAgentSession);
	});
});
