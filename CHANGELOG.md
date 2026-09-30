# Changelog

All notable changes to Auto Accept Antigravity are documented here.

## [0.7.10] - 2026-09-30

### Fixed
- Stopped accepting every notification primary action. Unrelated prompts are left alone.
- Stopped turning off workspace trust.
- Blocked shell commands now close that terminal and pause terminal auto-accept. A single word matches the command name, not text inside another word.
- Restored overwritten settings after a crash, using a snapshot taken before the first write.
- Auto Accept stays off on a fresh install. The status-bar choice is remembered after that.
- Command polling no longer disables settings, events, and CDP.
- Cancelled pending timers on stop, and stopped fast-poll ticks from overlapping.
- CDP attaches only to VS Code webviews on `autoAcceptAgent.cdpPort`.

### Removed
- RevenueCat paywall, which did not gate anything and trusted the webview to mark the user as Pro.

### Changed
- Split the engine into `catalog`, `blocked`, `settingsGuard`, and `cdpFallback`.
- Moved manual checks under `test/manual/` and `docs/agent-test-suite.md`. Removed root scratch files.

## [0.7.8] - 2026-09-02

### Changed
- Cleaned up documentation and configuration references
- General maintenance and stability improvements for Open VSX release

## [0.7.7] - 2026-08-26

### Changed
- Refactored core code for readability and maintainability
- Simplified error handling with improved promise resolution patterns
- Streamlined command registration with reusable patterns
- Reduced unnecessary comments and verbose code

### Fixed
- Fixed race condition in WebSocket resolution (`multiplexCdpWebviews`)
- Fixed potential double-resolution in HTTP timeout handling
- Improved async cleanup during extension disposal

### Added
- Comprehensive documentation (configuration, how-it-works, FAQ)
- Configuration examples (basic, aggressive, security-hardened, relaxed)
- Contributing guidelines and code of conduct
- Pricing documentation with monetization details

## [0.7.6] - 2026-08-20

### Added
- Advanced diagnostics command
- Custom button text support for localized UIs
- Security hardening configuration examples

### Changed
- Improved polling efficiency
- Better error logging and diagnostics

### Fixed
- Fixed settings restoration on extension shutdown
- Improved resource cleanup on disposal

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
