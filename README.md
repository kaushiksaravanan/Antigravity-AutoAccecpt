# Auto Accept Antigravity

> Automatically approve AI agent actions in VS Code. Zero config. No launch flags.

[![Version](https://img.shields.io/badge/version-0.7.8-blue)](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/releases)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.90%2B-blue)](https://code.visualstudio.com/)

## Features

🚀 **Instant Auto-Accept** — Approve agent steps, terminal commands, and file edits automatically

⚡ **Zero Configuration** — Works out of the box. No launch flags, no setup required

🛡️ **Safe by Default** — Blocked command list prevents dangerous operations (rm -rf, format, etc)

🎛️ **Full Control** — Settings-based configuration for polling speed, button interception, custom commands

🔌 **Chrome DevTools Protocol Fallback** — Optional CDP support for webview button clicks

📊 **Diagnostics** — Built-in diagnostics to check VS Code command availability

## Quick Start

1. Install from VS Code Marketplace: [Auto Accept Antigravity](https://marketplace.visualstudio.com/items?itemName=kaushiksaravanan.auto-accept-antigravity)
2. Click the status bar icon (bottom right) to toggle on
3. Start using Antigravity—approvals happen automatically

## Usage

### Commands

- `Auto Accept: Toggle` — Turn on/off (`Cmd+Shift+Y` / `Ctrl+Shift+Y`)
- `Auto Accept: Start` — Activate auto-accept
- `Auto Accept: Stop` — Deactivate auto-accept
- `Auto Accept: Accept All Now` — Fire all pending approvals immediately
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
  "autoAcceptAgent.blockedCommands": [
    "rm -rf /",
    "format",
    "mkfs",
    "del",
    "del *",
    "rmdir",
    "rd",
    "erase"
  ],
  "autoAcceptAgent.customButtonTexts": []
}
```

See [docs/configuration.md](docs/configuration.md) for all options.

## How It Works

Four strategies work together to approve actions:

1. **Settings Injection** — Auto-configures VS Code settings, then restores them when stopped
2. **Command Polling** — Fires accept commands every 400-800ms
3. **Event Tracking** — Reacts to terminal launches, editor changes, document saves
4. **CDP Fallback** — Optionally clicks approval buttons directly in webviews

[Read the full technical overview](docs/how-it-works.md)

## Examples

Check [examples/](examples/) for configuration templates:
- Basic setup
- Security-hardened mode
- Terminal-focused config
- Custom button labels

## FAQ

**Q: Is this safe?**
A: Yes. Blocked commands prevent dangerous operations. Customize via settings.

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
npm run compile      # TypeScript → JavaScript
npm run watch        # Watch mode
npm run package      # Create .vsix
npm run publish      # Publish to Marketplace
```

### Project Structure

```
src/
├── autoAcceptor.ts      # Auto-accept engine
├── extension.ts         # VS Code entry
└── diagnostics.ts       # Diagnostics

docs/                    # Documentation
examples/                # Config examples
assets/                  # Screenshots, icons
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute.

## License

MIT — [LICENSE](LICENSE)

## Author

[Kaushik Saravanan](https://github.com/kaushiksaravanan)

---

**Status:** Actively maintained. Issues and PRs welcome.
