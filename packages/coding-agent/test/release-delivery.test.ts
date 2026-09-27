import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { npmExec } from "../src/core/objective-execution/npm-exec.ts";
import {
	createRepoReleaseDelivery,
	TrustedDeployAdapterRegistry,
} from "../src/core/objective-execution/release-delivery.ts";
import { tempDir } from "./temp-dir.ts";

vi.mock("../src/core/objective-execution/npm-exec.ts", () => ({ npmExec: vi.fn() }));

const packageIntent = { packageName: "example", version: "1.0.0", registry: "https://registry.example.test" };

describe("release delivery without npm in a standalone runtime", () => {
	beforeEach(() => {
		vi.mocked(npmExec)
			.mockReset()
			.mockImplementation(() => {
				throw new Error("npm_cli_unavailable: standalone/node_modules/npm/bin/npm-cli.js");
			});
	});

	it("constructs the empty live deployment registry used at session startup", async () => {
		const delivery = createRepoReleaseDelivery(tempDir("pi-release-startup-"), {
			packageIntent: false,
			adapters: new TrustedDeployAdapterRegistry(),
		});
		expect(delivery?.publish).toBeUndefined();
		await expect(delivery?.deploy?.("missing")).rejects.toThrow("deploy_adapter_unavailable");
		await expect(delivery?.proveDeploy?.("missing")).rejects.toThrow("deploy_proof_unavailable");
		expect(npmExec).not.toHaveBeenCalled();
	});

	it.each(["static", "live"] as const)("deploys and observes through a %s adapter without npm", async (kind) => {
		const adapter = {
			id: "preview",
			targets: ["preview"],
			deploy: vi.fn(async () => ({ id: "deployment-1" })),
			observe: vi.fn(async () => ({ deploymentId: "deployment-1", deployedRevision: "revision-1" })),
		};
		const registry = new TrustedDeployAdapterRegistry();
		const delivery = createRepoReleaseDelivery(tempDir("pi-release-deploy-"), {
			adapters: kind === "live" ? registry : [adapter],
			packageIntent,
		});
		// Live adapters may arrive after session construction.
		registry.register(adapter);
		await expect(delivery?.deploy?.("preview")).resolves.toEqual({ id: "deployment-1" });
		await expect(delivery?.proveDeploy?.("preview")).resolves.toEqual({
			target: "preview",
			deploymentId: "deployment-1",
			deployedRevision: "revision-1",
		});
		expect(adapter.deploy).toHaveBeenCalledOnce();
		expect(adapter.observe).toHaveBeenCalledOnce();
		expect(npmExec).not.toHaveBeenCalled();
	});

	it.each(["preparePublish", "publish"] as const)(
		"reports missing npm only when %s is requested",
		async (operation) => {
			const root = tempDir("pi-release-publish-");
			writeFileSync(join(root, "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
			const delivery = createRepoReleaseDelivery(root, { packageIntent });
			expect(npmExec).not.toHaveBeenCalled();
			await expect(delivery?.[operation]?.()).rejects.toThrow("npm_cli_unavailable");
			expect(npmExec).toHaveBeenCalledOnce();
		},
	);

	it("rejects invalid package identity and missing proof before requiring npm", async () => {
		const delivery = createRepoReleaseDelivery(tempDir("pi-release-invalid-"), { packageIntent });
		await expect(delivery?.preparePublish?.()).rejects.toThrow("package_identity_mismatch");
		await expect(delivery?.provePublish?.("example@1.0.0")).rejects.toThrow("publish_proof_unavailable");
		expect(npmExec).not.toHaveBeenCalled();
	});
});
