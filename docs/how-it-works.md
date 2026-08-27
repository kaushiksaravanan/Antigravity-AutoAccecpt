# How Auto Accept Works

Auto Accept uses four independent strategies that work together to approve agent actions:

## Strategy 1: Settings Injection

When you toggle Auto Accept **ON**, it modifies VS Code's built-in auto-approval settings:

```
chat.tools.autoApprove = true
chat.agent.autoApprove = true
chat.tools.terminal.enableAutoApprove = true
security.workspace.trust.enabled = false
terminal.integrated.confirmOnKill = never
terminal.integrated.confirmOnPaste = false
```

**When you toggle OFF**, all settings are restored to their original values.

**Why:** This tells VS Code and Antigravity to skip showing approval dialogs in the first place.

**Caveat:** Some approval dialogs still appear if they're triggered by other mechanisms (webviews, custom agents).

---

## Strategy 2: Aggressive Command Polling

Auto Accept fires known accept/approve commands repeatedly:

**Fast Poll** (every 400-800ms):
- `antigravity.agent.acceptAgentStep`
- `antigravity.command.accept`
- `antigravity.terminalCommand.accept`
- `antigravity.terminalCommand.run`
- `notification.acceptPrimaryAction`

**Full Poll** (every 800-1500ms):
- All critical commands above, plus:
- `workbench.action.chat.accept`
- `workbench.action.chat.submit`
- `workbench.action.terminal.chat.runCommand`

**How it works:**
1. When an approval dialog appears, one of these commands becomes available
2. Auto Accept fires the command
3. The dialog closes (approval happens)
4. On next poll cycle, the command is unavailable (no-op)

**Timing:** If polling interval is 800ms and an approval appears, you wait max 800ms for approval.

---

## Strategy 3: Event-Driven Reactions

Auto Accept listens to VS Code events and reacts immediately:

### Terminal Launch
When a new terminal opens:
```
onDidOpenTerminal → immediately fire terminal accept commands
```

### Editor Focus Change
When you click a different file (e.g., viewing a diff):
```
onDidChangeActiveTextEditor → immediately fire agent accept commands
```

### Visible Editors Change
When editor split happens (diffs, side-by-side):
```
onDidChangeVisibleTextEditors → immediately fire agent accept commands
```

### Document Activity
Tracked but not used for approval:
- Document saves (logged for diagnostics)
- Text edits (logged for diagnostics)

**Advantage:** Reacts in real-time instead of waiting for next polling cycle.

---

## Strategy 4: Chrome DevTools Protocol (Optional)

If command polling can't find approval buttons (e.g., in custom webviews), Auto Accept can connect directly to Chrome via CDP:

```
1. Scan CDP ports (9222, 9229, etc.)
2. Attach to all webview targets
3. Inject JavaScript to search for approval buttons
4. Click buttons matching: "Run", "Accept", "Allow", "Yes"
5. Check against blocked command list
6. Click if safe
```

**Example JavaScript injected:**
```javascript
// Find button with text "Run"
const button = Array.from(document.querySelectorAll('button'))
  .find(btn => btn.textContent.includes('Run'));

// Check for blocked commands nearby
if (!isBlocked(button)) {
  button.click();
}
```

**When to use:**
- ✓ Command polling isn't reaching approval buttons
- ✓ Using custom webview-based agents
- ✓ Want maximum approval coverage

**When NOT to use:**
- ✗ Default agents work fine without it
- ✗ CDP adds network overhead
- ✗ Browser must be launched with `--remote-debugging-port=9222`

**Enable:** Set `autoAcceptAgent.enableCDP = true` in settings.

---

## Safety: Blocked Commands

Auto Accept prevents dangerous operations:

```json
{
  "blockedCommands": [
    "rm -rf /",
    "format",
    "mkfs",
    "del",
    "del *",
    "rmdir",
    "rd",
    "erase"
  ]
}
```

**How it works:**
1. When an approval button appears, check nearby text in the UI
2. If any blocked command is found (case-insensitive):
   ```
   containerText.includes("rm -rf") → BLOCKED
   ```
3. Skip approval, you must click manually

**Word boundary check:**
- `rm` in `"from"` = NOT blocked (different word)
- `rm -rf /` = BLOCKED (exact match)
- `format string` = BLOCKED (word boundary works)

---

## Lifecycle

### Activation
```
VS Code starts
  → Extension activates
  → Status bar shows "OFF"
  → Nothing happens yet
```

### Toggle ON
```
User clicks status bar or runs command
  → isRunning = true
  → Apply auto-approve settings
  → Start command polling (fast + full)
  → Start event tracking
  → Start CDP polling (if enabled)
  → Status bar shows "ON" (green)
```

### Approvals Happen
```
Agent tries to do something
  → VS Code shows approval dialog/button
  → One of 4 strategies detects it
  → Command fires or button clicks
  → Approval happens
  → Agent continues
```

### Toggle OFF
```
User clicks status bar or runs command
  → isRunning = false
  → Stop all polling intervals
  → Remove event listeners
  → Restore original settings
  → Status bar shows "OFF" (red)
```

### Disposal (Extension unload)
```
VS Code shutdown or extension disabled
  → dispose() called
  → Stop polling immediately
  → Remove event listeners
  → Async: restore original settings
  → Dispose status bar
  → Dispose output channel
```

---

## Performance

### CPU Impact
- **Idle (no approvals):** ~0.1% CPU (just polling loop)
- **Active (approvals):** ~0.3-0.5% CPU (polling + command execution)
- **With CDP enabled:** +0.2% (webview scanning)

### Memory Impact
- **Baseline:** ~15 MB (extension process)
- **Active:** ~20-25 MB (tracking state, pending requests)
- **With CDP:** +10-15 MB (WebSocket connections)

### Timing
- **Fast poll latency:** 200-400ms (half of polling interval)
- **Event reaction latency:** 0-50ms (immediate)
- **CDP scan cycle:** 1500ms per port scan

---

## Debugging

### Check what's running
Open VS Code's output channel:
- View → Output
- Select "Auto Accept Agent" from dropdown
- See real-time logs

### Enable diagnostics
Run command: `Auto Accept: Run Diagnostics`
Shows:
- Available accept commands
- Current settings
- Port scan results (if CDP enabled)

### Adjust logging
- Current: Essential info only
- Future: Verbose mode option coming

---

## Limitations

1. **Webview-only approvals** — CDP scan may miss some custom agent UIs
2. **Network delays** — If agent response is slow, polling might trigger before dialog appears
3. **Concurrent approvals** — If multiple approvals happen simultaneously, polling handles them sequentially
4. **Settings restore** — Some settings may not restore perfectly if manually changed during active session

---

## How It Differs From Similar Tools

| Feature | Auto Accept | VSCode Native | Manual Approval |
|---------|-------------|---------------|-----------------|
| Zero config | ✓ | ✗ | N/A |
| Command polling | ✓ | ✗ | N/A |
| Event tracking | ✓ | ✗ | N/A |
| CDP fallback | ✓ | ✗ | N/A |
| Blocked commands | ✓ | Limited | ✓ |
| Settings restore | ✓ | ✗ | N/A |

---

For questions or technical details, see [FAQ](faq.md) or file an issue on GitHub.
