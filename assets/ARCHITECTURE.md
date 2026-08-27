# Architecture Overview

## High-Level Design

Auto Accept uses a multi-strategy approach for robust approval automation:

```
┌─────────────────────────────────────────────────────────────┐
│                    VS Code Extension                         │
│                  (Auto Accept Antigravity)                   │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │  Settings        │  │  Command Polling │                 │
│  │  Injection       │  │                  │                 │
│  │  (Strategy 1)    │  │  (Strategy 2)    │                 │
│  └──────────────────┘  └──────────────────┘                 │
│                                                               │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │  Event Tracking  │  │  CDP Fallback    │                 │
│  │                  │  │  (Optional)      │                 │
│  │  (Strategy 3)    │  │  (Strategy 4)    │                 │
│  └──────────────────┘  └──────────────────┘                 │
│                                                               │
└──────────────────┬───────────────────────┬──────────────────┘
                   │                       │
          ┌────────▼────┐        ┌────────▼────┐
          │  VS Code    │        │   Chrome    │
          │  Settings   │        │   DevTools  │
          │   API       │        │  Protocol   │
          └─────────────┘        └─────────────┘
```

## Component Breakdown

### AutoAcceptor Class

Main engine (`src/autoAcceptor.ts`):
- **Public API:** `start()`, `stop()`, `toggle()`, `dispose()`
- **Strategies:** 4 independent approval mechanisms
- **State Management:** `isRunning`, `isDisposed`, `isPollInProgress`
- **Logging:** Real-time output to VS Code Output Channel

### Extension Entry (`src/extension.ts`)

- **Activation:** Runs when VS Code starts
- **Command Registration:** Creates VS Code commands
- **Status Bar:** Toggle UI element
- **Disposal:** Cleanup on extension unload

## Strategy Details

### Strategy 1: Settings Injection

```typescript
// On startup
applyAutoApproveSettings() {
  - Set chat.tools.autoApprove = true
  - Set chat.agent.autoApprove = true
  - Set terminal.enableAutoApprove = true
  - Disable security.workspace.trust
  - Remember original values
}

// On stop
restoreOriginalSettings() {
  - Restore all settings to original values
  - Clear tracking map
}
```

### Strategy 2: Command Polling

```typescript
startCommandPolling() {
  - Fast poll every 400ms → Fire critical commands
  - Full poll every 800ms → Fire all commands
  - Continue until stop() called
  - Error handling: Log and continue
}

fastPoll() {
  for (cmd of criticalAcceptCommands) {
    executeCommand(cmd)  // Fire and forget
  }
}
```

### Strategy 3: Event Tracking

```typescript
setupEventTracking() {
  - onDidStartTerminalShellExecution → Check blocked commands
  - onDidChangeActiveTextEditor → Fire accept commands
  - onDidChangeVisibleTextEditors → Fire accept commands
  - onDidSaveTextDocument → Log activity
  - onDidChangeTextDocument → Log activity
}
```

### Strategy 4: CDP Fallback

```typescript
startCDPPolling() {
  - Connect to Chrome DevTools Protocol (port 9222)
  - Scan all webviews and pages
  - Inject JavaScript to find approval buttons
  - Click matching buttons (with blocked command check)
  - Every 1500ms cycle
}

buildPermissionScript() {
  - Search for buttons with text: "Run", "Accept", "Allow", "Yes"
  - Check container text for blocked commands
  - Click if safe
  - Debounce with 5-second cooldown per target
}
```

## State Machine

```
┌─────┐
│ OFF │  (initial state)
└──┬──┘
   │ toggle() or start()
   │ ┌──────────────────────────┐
   ├─► Apply settings          │
   │ └────────────────────────┬─┘
   │                          │ success
   │                    ┌─────▼─────┐
   │                    │  RUNNING  │
   │                    └─────┬─────┘
   │                          │
   │    ┌─────────────────────┼─────────────────────┐
   │    │ Start polling       │ Setup events        │ Start CDP
   │    │ (every 800ms)       │ (real-time)         │ (every 1500ms)
   │    └─────────────────────┼─────────────────────┘
   │                          │
   │                    toggle() or stop()
   │                          │
   │    ┌─────────────────────▼─────────────────────┐
   │    │ Stop polling        │ Remove events       │ Stop CDP
   │    │ Remove disposables   │ Clear state        │ Close WS
   │    └─────────────────────┬─────────────────────┘
   │                          │
   │                 ┌────────▼────────┐
   │                 │ Restore settings │
   │                 └────────┬────────┘
   │                          │
   └──────────────────────────┘
        On exit: dispose()
```

## Data Flow

### Approval Event

```
Agent needs approval
        ↓
VS Code shows dialog/button
        ↓
        ├→ Strategy 1: Settings prevent dialog
        ├→ Strategy 2: Polling detects command + fires
        ├→ Strategy 3: Event triggers + fires
        └→ Strategy 4: CDP finds button + clicks
        ↓
Command/button action fires
        ↓
Approval happens
        ↓
Agent continues
```

## Concurrency & Safety

### Race Condition Prevention

1. **Double Resolution**
   ```typescript
   let done = false;
   const end = (ok: boolean) => {
     if (!done) { done = true; resolve(ok); }
   }
   ```

2. **Async State Checks**
   ```typescript
   if (!this.isRunning || this.isDisposed) return;
   // ... proceed only if state valid
   ```

3. **Event Listener Cleanup**
   ```typescript
   disposeTracking() {
     for (const d of trackingDisposables) {
       d.dispose();
     }
   }
   ```

## Performance Characteristics

### CPU Usage
- Idle polling: ~0.1%
- Active polling: ~0.3%
- CDP scanning: +0.2%

### Memory
- Base: ~15 MB
- Active: ~20-25 MB
- With CDP: +10-15 MB

### Latency
- Polling: 400-800ms typical
- Events: 0-50ms (immediate)
- CDP: 1500ms per cycle

## Error Handling

All strategies include:
1. **Try-catch blocks** → Log and continue
2. **Guard checks** → Early exit on invalid state
3. **Fallback behavior** → Don't crash on missing API
4. **Logging** → Output channel for debugging

```typescript
try {
  await vscode.commands.executeCommand(cmd);
} catch {
  // Command not available in this context
  // Just skip and continue
}
```

## Testing Points

Key areas to test:
- [x] Settings injection/restoration
- [x] Command polling execution
- [x] Event listener setup/cleanup
- [x] Blocked command detection
- [x] CDP WebSocket communication
- [ ] Concurrent approval scenarios
- [ ] Long-duration stability
- [ ] Memory leak detection

## Future Improvements

- Configurable strategy ordering
- Per-command approval rules
- Approval analytics/history
- Custom strategy plugins
- Performance profiling tools

---

See [how-it-works.md](../docs/how-it-works.md) for user-facing technical details.
