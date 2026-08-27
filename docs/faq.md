# Frequently Asked Questions

## Installation & Activation

### Q: How do I install Auto Accept?
**A:** Search for "Auto Accept Antigravity" in VS Code Extensions, click Install. That's it.

### Q: Why does the extension activate automatically?
**A:** It loads at startup but doesn't run until you toggle ON. The status bar shows "OFF" by default.

### Q: How do I turn it on/off?
**A:** Click the status bar icon (bottom right) or press Cmd+Shift+Y (Mac) / Ctrl+Shift+Y (Windows/Linux).

---

## Safety & Security

### Q: Is this safe?
**A:** Yes. Blocked commands prevent dangerous operations. You can customize the blocked list.

Example blocked patterns: `rm -rf /`, `format`, `mkfs`, `del *`, `DROP TABLE`

### Q: Can I add my own blocked commands?
**A:** Yes. Open settings, search `autoAcceptAgent.blockedCommands`, add patterns.

### Q: What if a command I need is blocked?
**A:** Remove it from the blocked list in settings. Or approve it manually when prompted.

### Q: Does Auto Accept collect data about me?
**A:** No. We only know:
- If you use the extension (install count)
- VS Code version
- If you have Pro

We do NOT see your code, commands, or personal info.

### Q: Is my data encrypted?
**A:** Yes. RevenueCat (subscription provider) encrypts all data in transit and at rest.

---

## Performance

### Q: Will this slow down VS Code?
**A:** No. Polling runs at low priority (800ms default). CPU impact: <0.5%.

### Q: Can I make it faster?
**A:** Lower `pollIntervalMs` in settings (default 800ms):
- 400ms = very fast (higher CPU)
- 800ms = balanced (default)
- 1500ms = slow polling (lower CPU)

### Q: Should I enable CDP?
**A:** Only if command polling isn't reaching approval buttons. CDP adds ~0.2% CPU overhead.

### Q: What's the memory impact?
**A:** ~15-20 MB. Negligible on modern machines.

---

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
**A:** Open Settings, search `autoAcceptAgent`, click gear icon → "Reset Setting".

---

## Features & Compatibility

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

---

## Approvals & Commands

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

---

## Terminal Commands

### Q: Does this approve terminal commands?
**A:** Yes. When a terminal command needs approval, Auto Accept handles it.

### Q: Can I disable terminal approvals?
**A:** Not yet. Feature coming: per-command-type approval settings.

### Q: What about shell history?
**A:** Auto Accept doesn't access shell history. Only approves UI prompts.

---

## File Edits

### Q: Does this apply file edits automatically?
**A:** Yes. When an agent suggests file changes, Auto Accept approves them.

### Q: Can I undo approved edits?
**A:** Yes. Cmd+Z / Ctrl+Z as usual. Auto Accept doesn't bypass undo.

### Q: Does this handle merge conflicts?
**A:** No. You still need to resolve conflicts manually.

---

## Notifications

### Q: Does this dismiss notifications?
**A:** Only approval notifications (Run, Allow, Yes buttons).

Other notifications stay visible.

### Q: Can I disable notification interception?
**A:** Yes. Set `autoAcceptAgent.interceptNotifications = false` in settings.

---

## Settings Management

### Q: What settings does Auto Accept modify?
**A:** When toggled ON, it sets:
- `chat.tools.autoApprove`
- `chat.agent.autoApprove`
- `chat.tools.terminal.enableAutoApprove`
- `security.workspace.trust.enabled`
- `terminal.integrated.confirmOnKill`
- `terminal.integrated.confirmOnPaste`

When toggled OFF, settings are restored to their original values.

### Q: Will I lose my settings?
**A:** No. Original values are saved and restored perfectly.

### Q: What if I manually change a setting while Auto Accept is ON?
**A:** That setting will be restored to its original value when you toggle OFF.

To make permanent changes:
1. Toggle Auto Accept OFF
2. Make your changes
3. Toggle Auto Accept back ON (new values will be saved as "original")

---

## Diagnostics

### Q: What does "Run Diagnostics" do?
**A:** Shows:
- Available accept commands
- Current settings
- CDP port scan results (if enabled)

Helps troubleshoot why approvals might not be working.

### Q: How often should I run diagnostics?
**A:** Only if something seems broken. Check the output channel for real-time info.

---

## Updates & Versions

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

---

## Pro & Monetization

### Q: Is Pro worth it?
**A:** Only if you:
- Use Auto Accept 50+ times/day
- Need advanced CDP features
- Want priority support

Otherwise free tier is sufficient.

### Q: Can I try Pro before buying?
**A:** Yes. 30-day refund guarantee.

### Q: Do I get pro features during trial?
**A:** Coming soon. For now, 30-day money-back is our trial.

### Q: Is there a team license?
**A:** Yes. Contact enterprise@autoaccept.dev for bulk pricing.

---

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

---

## Advanced Usage

### Q: Can I use Auto Accept programmatically?
**A:** Yes. All commands are registered and callable via command palette or API.

### Q: Can I contribute to Auto Accept?
**A:** Yes! See [CONTRIBUTING.md](../CONTRIBUTING.md).

### Q: Can I fork and customize it?
**A:** Yes. MIT license allows this.

---

## Contact & Support

**Have a question not listed here?**

- File an issue: GitHub Issues
- Email: support@autoaccept.dev
- Twitter: @kaushik_js

We respond within 24 hours.

---

**Last updated:** 2026-08-26
