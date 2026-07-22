# apps/desktop/scripts/

## Responsibility

Build and release automation scripts for the OpenPets desktop application. Handles packaging cleanup and local release orchestration (macOS-focused).

## Design

- **Node.js Scripts**: CommonJS (`.cjs`) for sync fs operations, ESM (`.mjs`) for modern async flow
- **Safety-First**: Path validation before `rmSync`, git state verification, dry-run support
- **GitHub Integration**: Uses `gh` CLI for draft release creation and artifact upload
- **Target-Safe Builds**: Locks ordinary packaging to the host target and requires hash-bound native smoke evidence for every explicitly staged release target

## Flow

**Clean Package Output** (`clean-package-output.cjs`):
```
Resolve dist-electron path → Validate path components → rmSync recursive
```

**Current-host packaging** (`run-electron-builder-current.mjs`):
```
Reject target-injection arguments → derive host OS/architecture → run the matching
electron-builder target → optionally validate packaged output
```

**Local Release** (`release-local.mjs`):
```
Preflight checks (git clean, remote sync, version validity)
→ Build and test (unless --skip-checks)
→ Prepare/smoke macOS wake helpers and require hash-bound native smoke evidence
  for every target bundle
→ Stage only the matching attested bundle before each target-specific electron-builder run
→ Validate the actual target-specific resources emitted after each builder run
→ Clean output directory
→ Generate SHA256SUMS
→ (if --yes) Create GitHub draft release + upload artifacts
```

**Desktop Tests** (`run-tests.mjs`):
```
Check preload syntax → Compile tests to .test-dist → Run behavior tests (including Sherpa manifest/process lifecycle) → Run contract tests → Run remaining dist checks (including target-specific wake packaging validation)
```

## Integration Points

- **File System**: `apps/desktop/dist-electron/` (build output), `apps/desktop/dist/` (compiled JS)
- **Git**: Working tree status, remote sync verification, tag existence checks
- **GitHub**: `gh release create`, `gh release upload` to `alvinunreal/openpets`
- **Build Tools**: `pnpm`, `electron-builder`, `node --check`
- **Node APIs**: `crypto` (SHA256), `fs`, `path`, `child_process.spawnSync`

## Key Scripts

- `clean-package-output.cjs`: Removes `dist-electron` directory with path safety checks
- `run-electron-builder-current.mjs`: Current-host target lock and optional packaged-output validation
- `release-local.mjs`: Full release orchestration with preflight validation,
  per-target attested wake staging, post-builder target validation,
  multi-platform builds, and GitHub draft creation
- `run-tests.mjs`: Desktop test runner for preload syntax checks, `.test-dist` behavior/contract tests (including Sherpa manifest/helper lifecycle), and remaining runtime/package checks

## Build Plan (release-local.mjs)

Default targets:
- macOS DMG and ZIP (separate x64 and ARM64 packages)
- Windows NSIS installer (x64)
- Linux AppImage (x64)
- Linux DEB (x64)
- Linux RPM (x64)
- Linux tar.gz (x64)

Optional flags:
- `--include-experimental-arm`: Windows/Linux ARM64 builds
