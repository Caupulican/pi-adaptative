import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext } from "node:tls";
import { promisify } from "node:util";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import {
	MAX_WEB_RESPONSE_BYTES,
	nativeOperations,
	PublicWebClient,
	type PublicWebOperations,
} from "../../src/core/web/public-web-client.ts";
import { CA_CERTIFICATE, SERVER_CERTIFICATE, SERVER_KEY, UNTRUSTED_CERTIFICATE } from "./webfetch-native-tls.ts";

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address !== "string");
	return address.port;
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
		server.closeAllConnections();
	});
}

async function runContract(): Promise<void> {
	const trace = (stage: string) => {
		if (process.env.PI_WEBFETCH_NATIVE_TRACE === "1") process.stderr.write(`${stage}\n`);
	};
	// Negative control: the inherited proxy really is active for an ordinary runtime fetch.
	trace("proxy control");
	const proxyControl = await fetch("http://proxy-control.invalid/", { signal: AbortSignal.timeout(3000) });
	assert.equal(proxyControl.status, 502);
	assert.equal(await proxyControl.text(), "proxy negative control");
	const received: { host: string; path: string }[] = [];
	const servernames: string[] = [];
	const headersSeen = Promise.withResolvers<void>();
	const decodedText = "bounded decoded response";
	const encodedBodies = new Map<string, { encoding: string; body: Buffer }>([
		["/gzip-small", { encoding: "gzip", body: gzipSync(decodedText) }],
		["/deflate-small", { encoding: "deflate", body: deflateSync(decodedText) }],
		["/br-small", { encoding: "br", body: brotliCompressSync(decodedText) }],
		["/encoding-chain", { encoding: "gzip, br", body: brotliCompressSync(gzipSync(decodedText)) }],
		["/identity", { encoding: "identity", body: Buffer.from(decodedText) }],
		["/gzip-large", { encoding: "gzip", body: gzipSync(Buffer.alloc(MAX_WEB_RESPONSE_BYTES + 1, 97)) }],
		["/encoding-unsupported", { encoding: "unsupported", body: Buffer.from(decodedText) }],
		...["gzip", "deflate", "br"].map((encoding): [string, { encoding: string; body: Buffer }] => [
			`/${encoding}-malformed`,
			{ encoding, body: Buffer.from("malformed compressed payload") },
		]),
	]);
	let httpPort = 0;
	const handler: RequestListener = (request, response) => {
		received.push({
			host: request.headers.host ?? "",
			path: request.url ?? "",
		});
		response.setHeader("content-type", "text/plain");
		const encoded = encodedBodies.get(request.url ?? "");
		if (encoded) {
			assert(encoded.body.length < MAX_WEB_RESPONSE_BYTES);
			response.writeHead(200, { "Content-Encoding": encoded.encoding, "Content-Length": encoded.body.length });
			response.end(encoded.body);
			return;
		}
		switch (request.url) {
			case "/reset":
				request.socket.destroy();
				return;
			case "/headers-stall":
				headersSeen.resolve();
				return;
			case "/body-stall":
				response.writeHead(200);
				response.flushHeaders();
				response.write("first chunk");
				return;
			case "/redirect":
			case "/downgrade":
				response.writeHead(302, { Location: `http://redirect-test.invalid:${httpPort}/ok` });
				response.end();
				return;
			case "/redirect-private":
				response.writeHead(302, { Location: `http://127.0.0.1:${httpPort}/private-target` });
				response.end();
				return;
			case "/redirect-rebind":
				response.writeHead(302, { Location: "/rebound" });
				response.end();
				return;
			default:
				response.end("pinned response");
		}
	};
	const server = createServer(handler);
	const secureContext = createSecureContext({ key: SERVER_KEY, cert: SERVER_CERTIFICATE });
	const secureServer = createSecureServer(
		{
			key: SERVER_KEY,
			cert: SERVER_CERTIFICATE,
			SNICallback: (servername, callback) => {
				servernames.push(servername);
				callback(null, secureContext);
			},
		},
		handler,
	);
	const untrustedServer = createSecureServer({ key: SERVER_KEY, cert: UNTRUSTED_CERTIFICATE }, handler);
	try {
		httpPort = await listen(server);
		const securePort = await listen(secureServer);
		const untrustedPort = await listen(untrustedServer);
		const base = `http://pinning-test.invalid:${httpPort}`;
		const secureBase = `https://pinning-test.invalid:${securePort}`;
		const request = {
			url: new URL(`${base}/ok`),
			address: { address: "127.0.0.1", family: 4 },
			headers: { Accept: "text/plain" },
			signal: AbortSignal.timeout(3000),
		};
		trace("native pinning");
		const result = await nativeOperations.request(request);
		assert.equal(await new Response(result.response.body).text(), "pinned response");
		await result.close();
		await result.close();
		// The invariant is a real, admitted native HTTP connection. Bun's global fetch cannot
		// bypass inherited proxies, so the Effect NodeHttpClient owns I/O on both runtimes.
		assert.deepEqual(received, [{ host: request.url.host, path: "/ok" }]);
		const manual = await nativeOperations.request({ ...request, url: new URL(`${base}/redirect`) });
		assert.equal(manual.response.status, 302, "native transport must not follow a redirect before admission");
		await manual.close();
		assert.equal(received.length, 2);
		await assert.rejects(
			nativeOperations.request({ ...request, url: new URL(`${base}/reset`) }),
			(error: unknown) => {
				assert(error instanceof Error);
				assert(!/destroy is not a function/.test(error.message), "cleanup masked the transport error");
				return true;
			},
		);
		const lookups: string[] = [];
		let closes = 0;
		const operations: PublicWebOperations = {
			lookup: async (hostname) => {
				lookups.push(hostname);
				return [{ address: "8.8.8.8", family: 4 }];
			},
			request: async (input) => {
				assert.equal(input.address.address, "8.8.8.8", "the production client must first admit a public address");
				// Test-only socket mapping: production admission sees a public peer; real I/O stays on localhost.
				const admitted = await nativeOperations.request({ ...input, address: { address: "127.0.0.1", family: 4 } });
				return {
					response: admitted.response,
					close: async () => {
						await admitted.close();
						closes++;
					},
				};
			},
		};
		const client = new PublicWebClient(operations);
		trace("redirect admission");
		const redirected = await client.get(`${base}/redirect`, "text/plain", 3);
		assert.equal(redirected.text, "pinned response");
		assert.equal(redirected.url, `http://redirect-test.invalid:${httpPort}/ok`);
		assert.deepEqual(lookups, ["pinning-test.invalid", "redirect-test.invalid"]);
		assert.equal(closes, 2, "each admitted redirect hop must release its transport");
		assert.equal(received.at(-1)?.host, `redirect-test.invalid:${httpPort}`);
		await assert.rejects(client.get(`${base}/redirect-private`, "text/plain", 3), /public Internet addresses only/);
		assert(!received.some(({ path }) => path === "/private-target"));
		let rebindLookups = 0;
		const reboundClient = new PublicWebClient({
			...operations,
			lookup: async () => [{ address: ++rebindLookups === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }],
		});
		await assert.rejects(
			reboundClient.get(`${base}/redirect-rebind`, "text/plain", 3),
			/public Internet addresses only/,
		);
		assert.equal(rebindLookups, 2, "a same-host redirect must revalidate DNS");
		assert(!received.some(({ path }) => path === "/rebound"));
		trace("compression");
		for (const path of ["/gzip-small", "/deflate-small", "/br-small", "/encoding-chain", "/identity"]) {
			const decoded = await client.get(`${base}${path}`, "text/plain", 3);
			assert.equal(decoded.text, decodedText, path);
			assert.equal(decoded.bytes, Buffer.byteLength(decodedText), path);
		}
		await assert.rejects(client.get(`${base}/gzip-large`, "text/plain", 3), /Response too large/);
		await assert.rejects(client.get(`${base}/encoding-unsupported`, "text/plain", 3), /Unsupported content encoding/);
		for (const encoding of ["gzip", "deflate", "br"]) {
			await assert.rejects(client.get(`${base}/${encoding}-malformed`, "text/plain", 3));
		}
		trace("cancellation");
		const headerController = new AbortController();
		const waitingHeaders = nativeOperations.request({
			...request,
			url: new URL(`${base}/headers-stall`),
			signal: headerController.signal,
		});
		await headersSeen.promise;
		headerController.abort(new Error("cancel while awaiting headers"));
		await assert.rejects(waitingHeaders);
		const bodyController = new AbortController();
		const waitingBody = await nativeOperations.request({
			...request,
			url: new URL(`${base}/body-stall`),
			signal: bodyController.signal,
		});
		const reader = waitingBody.response.body?.getReader();
		assert(reader);
		assert.equal(new TextDecoder().decode((await reader.read()).value), "first chunk");
		bodyController.abort(new Error("cancel while reading body"));
		await assert.rejects(reader.read());
		reader.releaseLock();
		await waitingBody.close();
		await waitingBody.close();
		await assert.rejects(client.get(`${base}/headers-stall`, "text/plain", 0.05), /timed out/);
		trace("TLS identity and trust");
		const secure = await client.get(`${secureBase}/ok`, "text/plain", 3);
		assert.equal(secure.text, "pinned response");
		assert.equal(received.at(-1)?.host, `pinning-test.invalid:${securePort}`);
		// Bun's Node HTTPS server facade does not expose SNI callbacks. Both runtimes still prove
		// hostname verification below; Node additionally observes the handshake's SNI field.
		if (!process.versions.bun) assert.equal(servernames.at(-1), "pinning-test.invalid");
		await assert.rejects(client.get(`${secureBase}/downgrade`, "text/plain", 3), /HTTPS downgrade redirect denied/);
		const requestsBeforeTlsDenials = received.length;
		await assert.rejects(client.get(`https://wrong-host.invalid:${securePort}/ok`, "text/plain", 3));
		await assert.rejects(client.get(`https://pinning-test.invalid:${untrustedPort}/ok`, "text/plain", 3));
		assert.equal(received.length, requestsBeforeTlsDenials, "TLS denials must happen before sending an HTTP request");
		console.log("webfetch native contract passed: pinning, redirects, cancellation, compression, TLS, proxy bypass");
	} finally {
		await Promise.all([closeServer(server), closeServer(secureServer), closeServer(untrustedServer)]);
	}
}

if (process.env.PI_WEBFETCH_NATIVE_CONTRACT_CHILD === "1") {
	await runContract();
} else {
	// Runtime trust and proxy configuration are startup settings. Re-exec also works when this file
	// is a standalone Bun executable; the PEM material stays embedded inside that executable.
	const directory = await mkdtemp(join(tmpdir(), "pi-webfetch-native-"));
	const caPath = join(directory, "fixture-ca.pem");
	let proxyRequests = 0;
	const proxy = createServer((_request, response) => {
		proxyRequests++;
		response.writeHead(502, { "Content-Type": "text/plain" });
		response.end("proxy negative control");
	});
	proxy.on("connect", (_request, socket) => {
		proxyRequests++;
		socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		socket.once("data", () => {
			socket.end(
				"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 22\r\nConnection: close\r\n\r\nproxy negative control",
			);
		});
	});
	try {
		const proxyPort = await listen(proxy);
		await writeFile(caPath, CA_CERTIFICATE);
		const proxyUrl = `http://127.0.0.1:${proxyPort}`;
		const result = await promisify(execFile)(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
			timeout: 20000,
			env: {
				...process.env,
				PI_WEBFETCH_NATIVE_CONTRACT_CHILD: "1",
				NODE_EXTRA_CA_CERTS: caPath,
				NODE_USE_ENV_PROXY: "1",
				HTTP_PROXY: proxyUrl,
				HTTPS_PROXY: proxyUrl,
				ALL_PROXY: proxyUrl,
				http_proxy: proxyUrl,
				https_proxy: proxyUrl,
				all_proxy: proxyUrl,
				NO_PROXY: "",
				no_proxy: "",
			},
		});
		assert.equal(proxyRequests, 1, "only the ordinary-fetch negative control may contact the environment proxy");
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
	} finally {
		await closeServer(proxy);
		await rm(directory, { recursive: true, force: true });
	}
}
