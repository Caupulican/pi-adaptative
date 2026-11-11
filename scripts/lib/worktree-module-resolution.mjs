/**
 * Preload module that registers the linked-worktree bare-specifier resolution hook before dynamic
 * imports load TypeScript workspace modules whose package dependencies live in the main checkout.
 */
import { registerWorktreeModuleFallback } from "./tool-resolution.mjs";

registerWorktreeModuleFallback();
