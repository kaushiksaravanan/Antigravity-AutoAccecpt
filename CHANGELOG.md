# Changelog

All notable changes to the "AutoAccept-Antigravity" extension will be documented in this file.

## [0.7.7] - 2026-03-24
### Changed
- Bumped the extension version to 0.7.7.
- Made CDP fallback opt-in by default so the extension works cleanly without debugging ports.
- Cleaned the packaged VSIX to exclude test and debug artifacts.

### Fixed
- Restored original settings reliably on stop/deactivate.
- Hardened polling, notification, terminal, and CDP flows against async race conditions and unhandled errors.
- Added missing contributed settings for `interceptNotifications`, `enableCDP`, and `customButtonTexts` behavior alignment.

## [0.7.2] - 2026-02-23
### Changed
- Reverted `displayName` back to "Antigravity-AutoAccept" for better discoverability.

## [0.7.1] - 2026-02-23
### Changed
- Updated internal package configurations.
- Temporarily experimented with extension display names.

## [0.7.0] - 2026-02-21
### Added
- Removed CDP dependency for a more robust, zero-configuration setup.
- Native VS Code settings integration for managing auto-approval.
