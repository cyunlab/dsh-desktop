# Test on three desktop platforms

Status: accepted

The first milestone provides a manually triggered `test.yml` workflow with a non-fail-fast matrix over Windows, macOS, and Linux. Every operating system runs three layers:

- unit tests for lifecycle, path selection, navigation policy, and error mapping;
- integration tests that boot the real pinned Harness composition in a Host child with temporary `DSH_HOME` and Desktop default-working-directory directories, then verify OS-assigned port discovery, loopback HTTP/API readiness, and graceful disposal;
- Playwright Electron end-to-end tests that launch the unpacked Desktop application and verify startup-page transition, the loaded Web UI, single-instance focus behavior, and a startup-failure surface. Linux runs the GUI tests under Xvfb.

This workflow does not reproduce NSIS, DMG, or AppImage generation. Platform packaging and artifact-level smoke checks belong to `build.yml` so the distinction between application behavior and installer construction stays visible.
