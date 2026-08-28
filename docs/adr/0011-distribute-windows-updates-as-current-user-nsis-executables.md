# Distribute Windows updates as current-user NSIS executables

Windows releases and automatic updates use only the Tauri NSIS `setup.exe` installed for the current user; Desktop does not produce MSI or support a per-machine enterprise installation mode. Stable Windows updates may initially omit Authenticode while retaining mandatory Tauri updater signatures. This keeps the first update path free of elevation and enterprise packaging work, with the accepted consequence that SmartScreen, Smart App Control, or organizational application-control policy may warn about or block an unsigned release.
