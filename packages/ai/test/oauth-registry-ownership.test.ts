import { afterEach, expect, it } from "vitest";
import {
	getOAuthProvider,
	registerOAuthProvider,
	resetOAuthProviders,
	unregisterOAuthProviders,
} from "../src/utils/oauth/index.ts";

afterEach(resetOAuthProviders);

it("removes only a retired OAuth source, including hidden overridden generations", () => {
	const builtIn = getOAuthProvider("openai-codex")!;
	registerOAuthProvider({ ...builtIn, name: "first" }, "first");
	registerOAuthProvider({ ...builtIn, name: "second" }, "second");
	const survivor = getOAuthProvider("openai-codex");
	unregisterOAuthProviders("first");
	expect(getOAuthProvider("openai-codex")).toBe(survivor);
	unregisterOAuthProviders("second");
	expect(getOAuthProvider("openai-codex")).toBe(builtIn);
});
