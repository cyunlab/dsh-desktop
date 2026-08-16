# Issue #3 release-candidate acceptance

Accepted 2026-08-16 UTC for commit `ef6ab1bdd847fbc259b1937d4cb5cbac74a1650e` on `issue/3-final-acceptance`. This commit is based on requested `main` commit `452b0b1ba34f00fbd3aa3ff4e64e22a1b088c818`.

## Authoritative workflow evidence

- [Desktop behavior tests run 31976140155](https://github.com/XLCYun/dsh-desktop/actions/runs/31976140155): success.
  - [macOS job 95235838718](https://github.com/XLCYun/dsh-desktop/actions/runs/31976140155/job/95235838718): 22 unit test files, the real-Host integration test, and 5 packaged Electron E2E tests passed. Runtime closure contained 525 packages.
  - [Linux job 95235838794](https://github.com/XLCYun/dsh-desktop/actions/runs/31976140155/job/95235838794): 22 unit test files, the real-Host integration test, and 5 packaged Electron E2E tests under Xvfb passed. Runtime closure contained 526 packages.
  - [Windows job 95235838819](https://github.com/XLCYun/dsh-desktop/actions/runs/31976140155/job/95235838819): 22 unit test files, the real-Host integration test, and 5 packaged Electron E2E tests passed. Runtime closure contained 524 packages.
  - Every real-Host test logged an assigned `127.0.0.1` URL. Every job reported `HARNESS_GUARD_OUTCOME: success`.
- [Unsigned native build run 31976143639](https://github.com/XLCYun/dsh-desktop/actions/runs/31976143639): success.
  - [macOS arm64 job 95235866237](https://github.com/XLCYun/dsh-desktop/actions/runs/31976143639/job/95235866237): closure, native packaged-Host probe, arm64 DMG, and artifact upload succeeded.
  - [macOS x64 job 95235866244](https://github.com/XLCYun/dsh-desktop/actions/runs/31976143639/job/95235866244): closure, native packaged-Host probe, x64 DMG, and artifact upload succeeded.
  - [Linux x64 job 95235866249](https://github.com/XLCYun/dsh-desktop/actions/runs/31976143639/job/95235866249): closure, native packaged-Host probe, x64 AppImage, and artifact upload succeeded.
  - [Windows x64 job 95235866327](https://github.com/XLCYun/dsh-desktop/actions/runs/31976143639/job/95235866327): closure, native packaged-Host probe, x64 NSIS installer, and artifact upload succeeded.

Each native build ran electron-builder's `afterPack` hook on its matching native runner. The hook verifies the staged runtime closure, launches the unpacked executable without relying on system Node or Harness, waits for the `packaged-host-ready` readiness result, and fails the build otherwise. The four successful jobs therefore cover both the closure and executable Host probe gates.

## Downloaded artifacts

The files below were downloaded from run 31976143639, checked as nonempty native file types, and hashed locally with SHA-256. API size is the compressed Actions artifact archive size; file size is the extracted installer/image size.

| Actions artifact (ID) | Extracted file | File size (bytes) | API size (bytes) | SHA-256 |
| --- | --- | ---: | ---: | --- |
| `unsigned-dev-windows-x64` (9271161959) | `deepseek-harness-desktop-0.1.0-unsigned-dev-windows-x64.exe` | 141086116 | 139402843 | `884f28061992917c98616490d70a503354ef07045b3b51403605761c1844e13b` |
| `unsigned-dev-macos-arm64` (9271126055) | `deepseek-harness-desktop-0.1.0-unsigned-dev-macos-arm64.dmg` | 159720082 | 159253510 | `cc5c84978871e77ab3ca92d8d4724c485eed762031b36fbac97da953b6f4b9fd` |
| `unsigned-dev-macos-x64` (9271150503) | `deepseek-harness-desktop-0.1.0-unsigned-dev-macos-x64.dmg` | 162653738 | 162203428 | `a997df7e5cde4a33f89c7e8b6a4cb5e52d322c5c722d5b1b9072d054e8cf8156` |
| `unsigned-dev-linux-x64` (9271121315) | `deepseek-harness-desktop-0.1.0-unsigned-dev-linux-x86_64.AppImage` | 171126018 | 170271215 | `9bda8232399c0a43512058b1a10bc66685c49cae6148ba26859d3749bd720a08` |

The Windows file identifies as a PE32 GUI Nullsoft installer and the AppImage as an x86-64 ELF executable; both DMGs identify as compressed disk images.

## Manual-build and repository guards

- The build was a `workflow_dispatch`, not a tag build. Draft-release job 95236486644 was skipped, and the GitHub Releases API returned zero releases after the run.
- No tag or Release was created.
- `deepseek-harness` remained clean at `47f943859bef60e4160492346772ded9b24f765a`.
- Local Node 24.18.0 verification passed frozen install, typecheck, 90 unit tests, the real-Host integration test, and 5 packaged macOS E2E tests.

## Failures found and resolved during acceptance

Initial main runs [31975570588](https://github.com/XLCYun/dsh-desktop/actions/runs/31975570588) and [31975573280](https://github.com/XLCYun/dsh-desktop/actions/runs/31975573280) exposed Linux unpacked-Electron sandbox startup, Windows CRLF/8.3-path and second-launch test assumptions, implicit electron-builder CI publishing, and additive cross-architecture macOS targets. Commits `a8f190ed758b8116ae70183534269069cb369c47` and `ef6ab1bdd847fbc259b1937d4cb5cbac74a1650e` contain the focused fixes. Intermediate runs 31975929973 and 31975933326 isolated the remaining Xvfb minimize assumption and electron-builder target configuration before the final green runs above.
