# Frequently Asked Questions

## Installation and activation

### Q: How do I install Auto Accept?
**A:** Search for "Auto Accept Antigravity" in VS Code Extensions, click Install. That's it.

### Q: Why does the extension activate automatically?
**A:** It loads at startup but doesn't run until you toggle ON. The status bar shows "OFF" by default.

### Q: How do I turn it on/off?
**A:** Click the status bar icon (bottom right). `Cmd+Shift+Y` / `Ctrl+Shift+Y` runs Accept All Now, not the toggle.


## Safety and security

### Q: Is this safe?
**A:** Auto Accept Antigravity operates with a fail-closed pre-execution boundary:
1. **Pre-Execution Gating:** When CDP inspection is disabled or disconnected, terminal command approvals are withheld by default. Blind approvals require explicit opt-in via `autoAcceptAgent.allowBlindTerminalAccept`.
2. **Flag Canonicalization:** Flag reordering, concatenated flags (e.g., `rm -fr`, `rm -r -f`), executable paths (`/bin/rm`), and git option flags (`git push origin --force`, `git -C ./dir reset --hard`) are canonicalized before matching.
3. **Script Inspection:** Referenced local scripts (`bash`, `sh`, `python`, `node`, `npm run`) are resolved from the workspace and inspected for destructive patterns prior to approval.
4. **Shell Integration Safeguard:** If an uninspected destructive command starts, shell integration detection immediately sends an interrupt signal (`Ctrl+C`), disposes the terminal, and pauses terminal auto-accept for 60 seconds.
5. **Operating System Boundary:** This extension is a pre-execution approval gate and pattern inspector, not a virtualized OS sandbox. Untrusted code involving dynamic execution, remote downloads, or compiled binaries should be run inside isolated dev containers or sandboxes.

### Q: Can I add my own blocked commands?
**A:** Yes. Open settings, search `autoAcceptAgent.blockedCommands`, add patterns.

### Q: What if a command I need is blocked?
**A:** Remove it from the blocked list in settings. Or approve it manually when prompted.

### Q: Does Auto Accept collect data about me?
**A:** No. This extension does not collect, transmit, or store any data. There is no telemetry, no analytics, no crash reporting, and no network calls of any kind. Everything runs entirely on your local machine. The extension has zero outbound connections — your code, commands, blocked patterns, and usage behavior never leave your editor.


## Performance
 
### Q: Will this slow down VS Code?
**A:** In typical local testing, polling overhead is minimal. Polling runs via `setInterval` with overlap guards at configurable intervals (800ms default), with estimated CPU impact <0.5%.

### Q: Can I make it faster?
**A:** Adjust `pollIntervalMs` in settings (default 800ms):
- 400ms = faster response (higher CPU activity)
- 800ms = balanced (default)
- 1500ms = slower polling (lowest CPU impact)

### Q: Should I enable CDP?
**A:** Only if command polling isn't reaching approval buttons or if you require pre-execution inspection of button action contexts. CDP adds ~0.2% estimated CPU activity.

### Q: What's the memory impact?
**A:** Typically ~15-25 MB memory footprint.


## Configuration

### Q: Do I need to configure anything?
**A:** No. It works out of the box with sensible defaults.

Optional: Tweak `pollIntervalMs` or `blockedCommands` in settings.

### Q: Can I have different configs per workspace?
**A:** Yes. VS Code settings support workspace-level overrides.

1. Open `.vscode/settings.json` in your workspace
2. Add `autoAcceptAgent` settings
3. These override global settings for that workspace only

### Q: How do I restore default settings?
**A:** Open Settings, search `autoAcceptAgent`, click the gear icon, then "Reset Setting".


## Features and compatibility

### Q: Works with Antigravity?
**A:** Yes. Designed specifically for Antigravity (Cursor, Claude Code, etc).

### Q: Works with other agents?
**A:** Partially. If they use VS Code's standard approval mechanisms, yes.

### Q: Can I use it with GitHub Copilot?
**A:** If Copilot uses VS Code approval dialogs, yes. CDP fallback helps with webviews.

### Q: Works on Mac/Windows/Linux?
**A:** Yes, all platforms. Same features everywhere.

### Q: Which VS Code versions are supported?
**A:** VS Code 1.90.0+. Older versions may have limited features.


## Approvals and commands

### Q: Why didn't my command get approved?
**A:** Possible reasons:
1. Auto Accept is toggled OFF
2. The command is in blockedCommands list
3. VS Code approval dialog didn't appear
4. Custom agent uses non-standard approval mechanism

Check status bar (should say "ON") and run diagnostics: `Auto Accept: Run Diagnostics`

### Q: Can I approve manually when I need to?
**A:** Yes. Just click the button/dialog. Auto Accept doesn't prevent manual approvals.

### Q: How many commands can I block?
**A:** Unlimited. Add as many patterns as you want to `blockedCommands`.

### Q: Do blocked commands apply globally?
**A:** Yes. Blocked list applies workspace-wide.

### Q: Can I unblock a command temporarily?
**A:** Yes. Edit `blockedCommands` in settings, then toggle Auto Accept off/on.


## Terminal commands

### Q: Does this approve terminal commands?
**A:** Yes. When a terminal command needs approval, Auto Accept handles it.

### Q: Can I disable terminal approvals?
**A:** Not yet. Feature coming: per-command-type approval settings.

### Q: What about shell history?
**A:** Auto Accept doesn't access shell history. Only approves UI prompts.


## File edits

### Q: Does this apply file edits automatically?
**A:** Yes. When an agent suggests file changes, Auto Accept approves them.

### Q: Can I undo approved edits?
**A:** Yes. Cmd+Z / Ctrl+Z as usual. Auto Accept doesn't bypass undo.

### Q: Does this handle merge conflicts?
**A:** No. You still need to resolve conflicts manually.


## Notifications

### Q: Does this dismiss notifications?
**A:** No. Auto Accept does not press the primary action on VS Code notifications.

`autoAcceptAgent.interceptNotifications` only lets the optional CDP fallback click Allow buttons inside the agent UI.


## Settings management

### Q: What settings does Auto Accept modify?
**A:** When toggled on, it sets chat auto-approve settings, terminal auto-approve, `chat.agent.maxRequests`, `terminal.integrated.confirmOnKill`, and `terminal.integrated.confirmOnPaste`.

It does not set `security.workspace.trust.enabled`.

Original values are saved before the first write and restored when you toggle off. If the editor crashes while they are overwritten, the next launch restores the snapshot.

### Q: Will I lose my settings?
**A:** No. Original values are saved and restored perfectly.

### Q: What if I manually change a setting while Auto Accept is ON?
**A:** That setting will be restored to its original value when you toggle OFF.

To make permanent changes:
1. Toggle Auto Accept OFF
2. Make your changes
3. Toggle Auto Accept back ON (new values will be saved as "original")


## Diagnostics

### Q: What does "Run Diagnostics" do?
**A:** Shows:
- Available accept commands
- Current settings
- CDP port scan results (if enabled)

Helps troubleshoot why approvals might not be working.

### Q: How often should I run diagnostics?
**A:** Only if something seems broken. Check the output channel for real-time info.


## Updates and versions

### Q: How often is this updated?
**A:** Monthly updates with bug fixes and features.

Check GitHub releases for changelog.

### Q: Do updates require reconfiguration?
**A:** No. Settings are preserved through updates.

### Q: How do I report a bug?
**A:** File an issue on GitHub with:
- VS Code version
- Auto Accept version
- Steps to reproduce
- Expected vs actual behavior


## Troubleshooting

### Q: Auto Accept stopped working. What do I do?
**A:**
1. Reload VS Code (Cmd+Shift+P → "Reload Window")
2. Run diagnostics to check status
3. Check output channel for errors
4. File an issue if problem persists

### Q: Polling seems stuck. How do I restart it?
**A:**
1. Toggle OFF (status bar)
2. Wait 2 seconds
3. Toggle ON
4. Should be fresh

### Q: I'm getting too many notifications about errors. How do I silence them?
**A:** Check the output channel instead. Errors are logged there without popups.

### Q: VS Code crashes when I toggle Auto Accept. Why?
**A:** This is a bug. File an issue on GitHub with:
- VS Code version
- Full error from output channel
- Workspace config if possible

### Q: Can I uninstall and reinstall to fix issues?
**A:** Yes, it's safe. All settings are preserved.


## Advanced usage

### Q: Can I use Auto Accept programmatically?
**A:** Yes. All commands are registered and callable via command palette or API.

### Q: Can I contribute to Auto Accept?
**A:** Yes! See [CONTRIBUTING.md](../CONTRIBUTING.md).

### Q: Can I fork and customize it?
**A:** Yes. MIT license allows this.


## Contact and support

**Have a question not listed here?**

- File an issue: GitHub Issues
- Email: support@autoaccept.dev
- Twitter: @kaushik_js

We respond within 24 hours.


**Last updated:** 2026-10-29
