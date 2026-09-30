# Configuration Guide

All settings are optional. Auto Accept works out of the box with sensible defaults.

## VS Code Settings

Open **Settings** (Cmd+, / Ctrl+,) and search for `autoAcceptAgent`.

### `enableCommandPolling`
- **Type:** `boolean`
- **Default:** `true`
- **Description:** Enable automatic polling of accept/approve commands.

Turn this off to disable the main auto-accept mechanism while keeping other features.

### `pollIntervalMs`
- **Type:** `number`
- **Default:** `800`
- **Min:** `200`
- **Max:** `10000`
- **Description:** Interval in milliseconds between polling cycles.

Lower values = faster approvals but more CPU. Recommended range: 400-1200ms.

**Examples:**
- 200ms — Very aggressive (highest CPU impact)
- 400ms — Fast response (low CPU)
- 800ms — Balanced (default, recommended)
- 1500ms — Relaxed polling

### `autoConfigureSettings`
- **Type:** `boolean`
- **Default:** `true`
- **Description:** Auto-configure VS Code settings to skip approval prompts.

When enabled, these settings are modified and restored on toggle:
- `chat.tools.autoApprove`
- `chat.agent.autoApprove`
- `chat.tools.terminal.enableAutoApprove`
- `terminal.integrated.confirmOnKill`
- `terminal.integrated.confirmOnPaste`

Workspace trust is not modified. Original values are stored before the first write and restored if the editor crashes.

### `interceptNotifications`
- **Type:** `boolean`
- **Default:** `true`
- **Description:** When CDP is enabled, also click Allow buttons in the agent UI. This does not accept unrelated VS Code notifications.

### `enableCDP`
- **Type:** `boolean`
- **Default:** `false`
- **Description:** Enable Chrome DevTools Protocol fallback.

This connects to `autoAcceptAgent.cdpPort` (default 9222) and clicks approval buttons in VS Code webviews. Launch the editor with `--remote-debugging-port` set to that port.

When CDP is on, terminal Run buttons are clicked only after the blocklist check. The fallback does not attach to other local browser pages.

**When to enable:**
- Command polling isn't reaching approval buttons
- Using custom webview-based agents
- Want maximum compatibility

**Warning:** Enabling CDP adds network overhead. Keep disabled unless needed.

### `blockedCommands`
- **Type:** `string[]`
- **Default:**
  ```json
  [
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
  ]
  ```
- **Description:** Command lines that must not be auto-approved.

A single word matches the command name only (`del` matches `del file`, not `delta`). Several words match that sequence (`rm -rf`, `git push --force`). `git format-patch` is not blocked by `format`.

If a blocked command starts, that terminal is closed and terminal auto-accept pauses for 60 seconds. Shell integration has to be on for that event. With CDP enabled, the click is refused when the nearby text matches.

**Custom blocks:**
Add your own dangerous patterns:
```json
{
  "autoAcceptAgent.blockedCommands": [
    "rm -rf /",
    "format",
    "mkfs",
    "DROP TABLE",
    "DELETE FROM users",
    "git push --force"
  ]
}
```

### `customButtonTexts`
- **Type:** `string[]`
- **Default:** `[]`
- **Description:** Additional button labels to auto-click.

Useful for localized UIs or custom agent buttons.

**Example:**
```json
{
  "autoAcceptAgent.customButtonTexts": [
    "Ejecutar",
    "Aceptar",
    "Démarrer"
  ]
}
```

Auto Accept will click buttons with these labels in addition to the default ones.

## Settings.json Example

Full minimal config. A short `blockedCommands` list replaces the default, it does not add to it. See [examples/basic.json](../examples/basic.json) for the default list.
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
    "mkfs"
  ],
  "autoAcceptAgent.customButtonTexts": []
}
```

## Presets

See [examples/](../examples/) for common configuration presets:
- `basic.json` — Default config
- `aggressive.json` — Fast polling and CDP
- `relaxed.json` — Slow polling
- `security-hardened.json` — Extra blocked commands

## Troubleshooting

### Approvals are too slow
Lower `pollIntervalMs` to 400-600ms.

### VS Code is slow
Increase `pollIntervalMs` to 1000-1500ms, or disable `enableCDP`.

### Specific commands not being approved
Check if they're in `blockedCommands`, or add their text to `customButtonTexts`.

### CDP port conflicts
Set `autoAcceptAgent.cdpPort` to a free port and launch the editor with the same `--remote-debugging-port`. Or leave CDP disabled.

## Restoring Defaults

Clear all Auto Accept settings to restore defaults:
```bash
# Remove all autoAcceptAgent settings
# Reopen VS Code to load defaults
```

Or reset individual settings:
1. Open Settings (Cmd+, / Ctrl+,)
2. Search for `autoAcceptAgent`
3. Click the gear icon → "Reset Setting"

## Environment Variables

No environment variables needed. All config is in VS Code settings.

---

**Questions?** See [FAQ](faq.md) or file an issue on [GitHub](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/issues).
