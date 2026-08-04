import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent, fetch, interceptors } from "undici";
import { describe, expect, it } from "vitest";

describe("Undici cache advisory regression", () => {
	it("accepts mixed private cache directives without the pre-8.9 parser crash", async () => {
		const server = createServer((_request, response) => {
			response.writeHead(200, {
				"cache-control": 'public, max-age=60, private, private="hdr"',
				"content-type": "text/plain",
			});
			response.end("ok");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as AddressInfo;
		const dispatcher = new Agent().compose(interceptors.cache());

		try {
			const response = await fetch(`http://127.0.0.1:${address.port}/`, { dispatcher });
			expect(await response.text()).toBe("ok");
		} finally {
			await dispatcher.close();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});
});
