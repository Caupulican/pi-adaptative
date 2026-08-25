import { afterEach, describe, expect, test } from "vitest";
import {
	detectInstallMethod,
	getSelfUpdateUnavailableInstruction,
	getStandaloneInstallerCommand,
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
		expect(getStandaloneInstallerCommand("darwin")).toBeUndefined();
	});

	test("builds the Windows installer runner from the release asset URL", () => {
		const installer = getStandaloneInstallerCommand("win32");

		expect(installer).toMatchObject({
			command: "powershell.exe",
			url: "https://github.com/Caupulican/pi-adaptative/releases/latest/download/install.ps1",
		});
		expect(installer?.args).toContain("-NoProfile");
		expect(installer?.args.at(-1)).toBe(
			"irm https://github.com/Caupulican/pi-adaptative/releases/latest/download/install.ps1 | iex",
		);
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
		expect(getUpdateInstruction("@caupulican/pi-adaptative")).toBe(getStandaloneInstallInstruction());
		expect(getUpdateInstruction("@caupulican/pi-adaptative")).not.toContain("npm install");
	});
});
