import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { StreamIdleOptions } from "@caupulican/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { constrainStreamIdleToHttpTimeout, DEFAULT_HTTP_IDLE_TIMEOUT_MS } from "../src/core/http-dispatcher.ts";
import { tempDir } from "./temp-dir.ts";

describe("HTTP-bound stream-idle policy", () => {
	it("keeps every watchdog phase and adaptive expansion below a nonzero HTTP timeout", () => {
		const onStall = vi.fn();
		const options: StreamIdleOptions = {
			connectMs: 500_000,
			firstProgressMs: 600_000,
			activeIdleMs: 700_000,
			quietIdleMs: 900_000,
			onStall,
		};

		expect(constrainStreamIdleToHttpTimeout(options, 300_000)).toEqual({
			options: {
				connectMs: 270_000,
				firstProgressMs: 270_000,
				activeIdleMs: 270_000,
				quietIdleMs: 270_000,
				onStall,
			},
			adaptiveCeilingMs: 270_000,
		});
	});

	it("preserves the stock 60-second margin at the default HTTP timeout", () => {
		const options: StreamIdleOptions = {
			connectMs: 120_000,
			firstProgressMs: 120_000,
			activeIdleMs: 180_000,
			quietIdleMs: 600_000,
		};

		expect(constrainStreamIdleToHttpTimeout(options, DEFAULT_HTTP_IDLE_TIMEOUT_MS)).toEqual({
			options,
			adaptiveCeilingMs: 600_000,
		});
	});

	it("leaves watchdog bounds and adaptive expansion unconstrained when HTTP idle is disabled", () => {
		const options: StreamIdleOptions = {
			connectMs: 120_000,
			firstProgressMs: 120_000,
			activeIdleMs: 180_000,
			quietIdleMs: 1_800_000,
		};

		expect(constrainStreamIdleToHttpTimeout(options, 0)).toEqual({ options });
	});

	it("restores defaults for unset bounds carried through a partial settings spread", () => {
		const options = {
			connectMs: undefined,
			firstProgressMs: undefined,
			activeIdleMs: undefined,
			quietIdleMs: undefined,
		} as unknown as StreamIdleOptions;

		expect(constrainStreamIdleToHttpTimeout(options, 60_000)).toEqual({
			options: {
				connectMs: 54_000,
				firstProgressMs: 54_000,
				activeIdleMs: 54_000,
				quietIdleMs: 54_000,
			},
			adaptiveCeilingMs: 54_000,
		});
	});

	it("contains malformed WebSocket protocol headers after installing the configured undici dispatcher", () => {
		const directory = tempDir("pi-http-dispatcher-websocket-");
		const scriptPath = join(directory, "websocket-probe.mjs");
		const dispatcherUrl = pathToFileURL(resolve(import.meta.dirname, "../src/core/http-dispatcher.ts")).href;
		writeFileSync(
			scriptPath,
			`import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { configureHttpDispatcher } from ${JSON.stringify(dispatcherUrl)};

configureHttpDispatcher(5_000);
const malformed = process.argv[2] === "malformed";
const server = createServer();
let upgradedSocket;
server.on("upgrade", (request, socket) => {
  upgradedSocket = socket;
  const key = request.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Accept: " + accept,
    ...(malformed ? ["Sec-WebSocket-Protocol: unsolicited"] : []),
    "",
    "",
  ].join("\\r\\n"));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("loopback server did not bind");
const socket = new WebSocket("ws://127.0.0.1:" + address.port + "/probe");
let settled = false;
const timeout = setTimeout(() => finish("timeout"), 2_000);
function finish(event) {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  process.stdout.write(event + "\\n");
  upgradedSocket?.destroy();
  server.close();
}
socket.addEventListener("open", () => finish("open"));
socket.addEventListener("error", () => finish("error"));
socket.addEventListener("close", () => finish("close"));
`,
		);
		const probe = (mode: "valid" | "malformed") =>
			spawnSync(process.execPath, [scriptPath, mode], {
				cwd: resolve(import.meta.dirname, ".."),
				encoding: "utf8",
				timeout: 5_000,
				env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
			});

		const healthy = probe("valid");
		expect(healthy.status, healthy.stderr).toBe(0);
		expect(healthy.stdout.trim()).toBe("open");

		const malformed = probe("malformed");
		expect(malformed.status, malformed.stderr).toBe(0);
		expect(["error", "close"]).toContain(malformed.stdout.trim());
		expect(malformed.stderr).not.toContain("TypeError");
	});
});
