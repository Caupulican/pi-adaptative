# Development

See [AGENTS.md](https://github.com/earendil-works/pi-mono/blob/main/AGENTS.md) for additional guidelines.

## Setup

Development and CI use Node.js 24.20.0 or newer, pinned in the repository's `.nvmrc` to the current LTS patch. Standalone binaries use the stable Bun version pinned in `.bun-version`. Direct npm dependencies use exact versions and the repository's two-day minimum release age.

The clone scanner is pinned to jscpd 5.0.15, the newest version that passes the repository's scanner controls. Versions 5.0.16 through 5.1.2 report unrelated exported interfaces as clones. `check:clone-config` preserves that regression alongside controls that require real clones to remain detectable. Update this pin only when those controls pass; do not suppress the affected files or relax the release threshold.

```bash
git clone https://github.com/earendil-works/pi-mono
cd pi-mono
npm install --ignore-scripts
npm run build
```

Run from source:

```bash
/path/to/pi-mono/pi-test.sh
```

The script can be run from any directory. Pi keeps the caller's current working directory.

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "piConfig": {
    "name": "pi",
    "configDir": ".pi"
  }
}
```

Change `name`, `configDir`, and `bin` field for your fork. Affects CLI banner, config paths, and environment variable names.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.pi/agent/pi-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

```bash
./test.sh packages/coding-agent/test/specific.test.ts
npm run check
```

Run focused tests during development. The full non-e2e suite belongs to GitHub Actions; do not run the full suite locally as part of release preparation.

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
