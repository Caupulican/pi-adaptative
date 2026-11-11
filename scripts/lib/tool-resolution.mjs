/**
 * Resolves installed developer tools and bare package specifiers across both the primary checkout and
 * linked git worktrees whose `node_modules` lives only in the owning checkout.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire, isBuiltin, registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromScript = createRequire(import.meta.url);
let cachedMainCheckoutRoot;
let requireFromMainCheckout;
let cachedMainParentURL;
let fallbackHooksRegistered = false;

/**
 * Returns the owning main checkout directory when `cwd` is a linked git worktree, or `undefined` when
 * `cwd` is already the main checkout (or outside git).
 */
export function resolveMainCheckoutRoot(cwd = repoRoot) {
	try {
		const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (!commonDir) return undefined;
		const mainCheckout = resolve(cwd, commonDir, "..");
		return mainCheckout === resolve(cwd) ? undefined : mainCheckout;
	} catch {
		return undefined;
	}
}

function getMainCheckoutRoot() {
	if (cachedMainCheckoutRoot === undefined) {
		cachedMainCheckoutRoot = resolveMainCheckoutRoot(repoRoot) ?? null;
	}
	return cachedMainCheckoutRoot ?? undefined;
}

function defaultFallbackParentURL() {
	if (cachedMainParentURL === undefined) {
		const mainCheckout = getMainCheckoutRoot();
		const manifestPath = mainCheckout ? join(mainCheckout, "package.json") : undefined;
		cachedMainParentURL = manifestPath && existsSync(manifestPath) ? pathToFileURL(manifestPath).href : null;
	}
	return cachedMainParentURL ?? undefined;
}

/** True only for bare package specifiers (`pkg`, `@scope/pkg`, `pkg/subpath`), never URLs, paths, `#imports`, or builtins. */
export function isBarePackageSpecifier(specifier) {
	if (typeof specifier !== "string" || specifier.length === 0) return false;
	if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) return false;
	if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) return false;
	return !isBuiltin(specifier);
}

/**
 * Builds a synchronous `module.registerHooks` `resolve` hook that falls back to the owning main checkout's
 * `package.json` when a bare package specifier throws `ERR_MODULE_NOT_FOUND` inside a `node_modules`-less worktree.
 */
export function createWorktreeResolveHook({ getFallbackParentURL = defaultFallbackParentURL } = {}) {
	return function resolveWorktreeBareSpecifier(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (error) {
			if (error?.code !== "ERR_MODULE_NOT_FOUND" || !isBarePackageSpecifier(specifier)) {
				throw error;
			}
			const fallbackParentURL = getFallbackParentURL();
			if (!fallbackParentURL || context?.parentURL === fallbackParentURL) {
				throw error;
			}
			const withSourceCondition = () => {
				const conditions = context?.conditions?.includes("pi-source")
					? context.conditions
					: ["pi-source", ...(context?.conditions ?? ["node", "import"])];
				return nextResolve(specifier, { ...context, parentURL: fallbackParentURL, conditions });
			};
			try {
				const resolved = nextResolve(specifier, { ...context, parentURL: fallbackParentURL });
				if (resolved.url.startsWith("file:") && !existsSync(fileURLToPath(resolved.url))) {
					return withSourceCondition();
				}
				return resolved;
			} catch (retryError) {
				if (retryError?.code === "ERR_MODULE_NOT_FOUND" && !context?.conditions?.includes("pi-source")) {
					return withSourceCondition();
				}
				throw retryError;
			}
		}
	};
}

/** Installs the linked-worktree bare-specifier fallback once per process. */
export function registerWorktreeModuleFallback() {
	if (fallbackHooksRegistered) return;
	fallbackHooksRegistered = true;
	registerHooks({ resolve: createWorktreeResolveHook() });
}

/**
 * The directory of an installed package, found the way Node resolves any dependency: from the caller's own location,
 * walking up. A path built from a checkout's root only exists where `npm install` ran; a linked worktree has the
 * tracked scripts and no `node_modules`, so a tool is looked for next in the checkout that owns the worktree (the parent
 * of git's common directory). Undefined when neither has it: the caller reports that, it never skips its step.
 */
export function resolvePackageDirectory(specifier, from = requireFromScript) {
	const manifest = `${specifier}/package.json`;
	try {
		return dirname(from.resolve(manifest));
	} catch {
		// A linked worktree can have no install of its own.
	}
	try {
		if (!requireFromMainCheckout) {
			const mainCheckout = getMainCheckoutRoot();
			if (!mainCheckout) return undefined;
			requireFromMainCheckout = createRequire(join(mainCheckout, "package.json"));
		}
		return dirname(requireFromMainCheckout.resolve(manifest));
	} catch {
		return undefined;
	}
}
