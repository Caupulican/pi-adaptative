import { afterEach, describe, expect, test } from "vitest";
import {
	detectInstallMethod,
	getSelfUpdateUnavailableInstruction,
	getStandaloneInstallInstruction,
	getUpdateInstruction,
} from "../src/config.ts";

const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
const originalPiPackageDir = process.env.PI_PACKAGE_DIR;

function setExecPath(value: string): void {
	Object.defineProperty(process, "execPath", { value, configurable: true });
}

afterEach(() => {
	if (execPathDescriptor) {
		Object.defineProperty(process, "execPath", execPathDescriptor);
	}
	if (originalPiPackageDir === undefined) {
		delete process.env.PI_PACKAGE_DIR;
	} else {
		process.env.PI_PACKAGE_DIR = originalPiPackageDir;
	}
});

describe("install method and self-update instructions", () => {
	test("never recommends the Linux installer on unsupported host platforms", () => {
		expect(getStandaloneInstallInstruction("darwin")).toContain("support Linux and Windows");
		expect(getStandaloneInstallInstruction("darwin")).not.toContain("install.sh");
	});

	test("detects pnpm from Windows .pnpm install paths", () => {
		setExecPath(
			"C:\\Users\\Admin\\Documents\\pnpm-repository\\global\\5\\.pnpm\\@caupulican+pi-adaptative@0.97.0\\node_modules\\@caupulican\\pi-adaptative\\dist\\cli.js",
		);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(getUpdateInstruction("@caupulican/pi-adaptative")).toBe(getStandaloneInstallInstruction());
	});

	test("does not self-update unknown wrapper installs", () => {
		setExecPath("/usr/local/bin/node");

		expect(detectInstallMethod()).toBe("unknown");
		expect(getSelfUpdateUnavailableInstruction("@caupulican/pi-adaptative")).toBe(
			"Update @caupulican/pi-adaptative using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});

	test("legacy npm installs receive the standalone migration instruction", () => {
		setExecPath("/opt/npm/lib/node_modules/@caupulican/pi-adaptative/dist/cli.js");

		expect(detectInstallMethod()).toBe("npm");
		expect(getUpdateInstruction("@caupulican/pi-adaptative")).toContain(
			"https://github.com/Caupulican/pi-adaptative/releases/latest/download/install.sh",
		);
		expect(getUpdateInstruction("@caupulican/pi-adaptative")).not.toContain("npm install");
	});
});
