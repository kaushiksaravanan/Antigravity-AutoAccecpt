# Auto Accept Antigravity

> Automatically approve AI agent actions in VS Code. Zero config. No launch flags.

[![Version](https://img.shields.io/badge/version-0.7.13-blue)](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/releases)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.90%2B-blue)](https://code.visualstudio.com/)

## Features

🚀 **Instant Auto-Accept** — Approve agent steps, terminal commands, and file edits automatically

⚡ **Zero Configuration** — Works out of the box. No launch flags, no setup required

🛡️ **Pre-Execution Gating & Script Inspection** — Multi-layer blocklist and script inspector intercept destructive commands and script contents before execution. Fail-closed architecture halts unverified terminal runs.

🎛️ **Full Control** — Settings-based configuration for polling speed, button interception, custom commands

🔌 **Chrome DevTools Protocol Fallback** — Optional CDP support for webview button clicks

📊 **Diagnostics** — Built-in diagnostics to check VS Code command availability

## Quick Start

1. Install from VS Code Marketplace: [Auto Accept Antigravity](https://marketplace.visualstudio.com/items?itemName=kaushiksaravanan.auto-accept-antigravity)
2. Click the status bar icon (bottom right) to toggle on
3. Start using Antigravity—approvals happen automatically

## Usage

### Commands

- `Auto Accept: Toggle` — Turn on or off from the status bar or Command Palette
- `Auto Accept: Start` — Activate auto-accept
- `Auto Accept: Stop` — Deactivate auto-accept
- `Auto Accept: Accept All Now` — Fire pending approvals (`Cmd+Shift+Y` / `Ctrl+Shift+Y`)
- `Auto Accept: Run Diagnostics` — Check available commands

### Configuration

Open VS Code Settings and search for `autoAcceptAgent`:

```json
{
  "autoAcceptAgent.enableCommandPolling": true,
  "autoAcceptAgent.pollIntervalMs": 800,
  "autoAcceptAgent.autoConfigureSettings": true,
  "autoAcceptAgent.interceptNotifications": true,
  "autoAcceptAgent.enableCDP": false,
  "autoAcceptAgent.cdpPort": 9222,
  "autoAcceptAgent.blockedCommands": [
    "rm -rf /",
    "rm -rf",
    "format",
    "mkfs",
    "del",
    "del *",
    "rmdir",
    "rd",
    "erase",
    "Remove-Item",
    "git push --force",
    "git reset --hard",
    "git clean -fd"
  ],
  "autoAcceptAgent.customButtonTexts": []
}
```

See [docs/configuration.md](docs/configuration.md) for all options.

## How It Works

Four strategies work together:

1. **Settings Injection** — Writes chat auto-approve settings, then restores them when stopped. Does not turn off workspace trust.
2. **Command Polling** — Fires agent accept commands on a timer. It does not accept unrelated notification popups.
3. **Event Tracking** — Closes a terminal that starts a blocked command, and reacts to editor changes.
4. **CDP Fallback** — Optional. Clicks approval buttons in VS Code webviews after the blocklist check.

[Read the full technical overview](docs/how-it-works.md)

## Examples

Check [examples/](examples/) for configuration templates:
- Basic setup
- Security-hardened mode
- Aggressive and relaxed polling

## FAQ

**Q: Is this safe?**
A: It is safer than clicking every approval, and it is not a sandbox. Blocked shell commands are interrupted when shell integration reports them, and the optional CDP path refuses the click when it can see the text. Customize the list in settings. Workspace trust is left alone.

**Q: Does it slow down VS Code?**
A: No. Polling runs at low priority (800ms default, adjustable).

**Q: Works with terminal commands?**
A: Yes. Approves terminal execution, file modifications, and agent steps.

**Q: Custom button labels?**
A: Yes. Add to `autoAcceptAgent.customButtonTexts` in settings.

[See full FAQ](docs/faq.md)

## Development

### Build

```bash
npm test             # Blocklist matcher tests
npm run compile      # TypeScript → JavaScript
npm run watch        # Watch mode
npm run package      # Create .vsix
```

### Project Structure

```
src/
├── extension.ts         # VS Code entry
├── autoAcceptor.ts      # Start, stop, polling, events, and fail-closed gates
├── catalog.ts           # Command IDs and default blocked command lists
├── blocked.ts           # Token normalizer and pattern matcher
├── scriptInspector.ts   # Local script & package.json dependency inspector
├── settingsGuard.ts     # Snapshot and restore global settings
├── cdpFallback.ts       # Webview DOM inspection and safe button clicks
└── diagnostics.ts       # Diagnostics

## Security Architecture & Boundaries

Auto Accept Antigravity employs a defense-in-depth model:
- **Pre-Execution Gating**: Terminal auto-approval commands fail closed unless verified by CDP or explicitly opted into via `allowBlindTerminalAccept`.
- **Flag Canonicalization**: Command strings are normalized (e.g., `rm -fr`, `/bin/rm -rf`, `git push origin --force`) to prevent evasion via flag splitting or path variations.
- **Script Inspection**: Commands invoking shell scripts (`bash`, `sh`), Python, Node, or `npm run` tasks are inspected for nested destructive patterns prior to approval.
- **Application-Scoped Settings**: Critical security controls are enforced at Application scope to prevent malicious workspace repositories from overriding blocklists.
- **Not a Hardware Sandbox**: Dynamic runtime behavior (network downloads, obfuscated code, or precompiled binaries) cannot be statically verified; such workloads should be executed in disposable containers or sandbox environments.

test/                    # Matcher tests and manual scripts
docs/                    # Documentation
examples/                # Config examples
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.

## License

MIT — [LICENSE](LICENSE)

## Author

[Kaushik Saravanan](https://github.com/kaushiksaravanan)

---

**Status:** Actively maintained. Issues and PRs welcome.
