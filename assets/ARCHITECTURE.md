# Architecture overview

## High-level design

Auto Accept uses four strategies for approval automation:

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

## Component breakdown

### AutoAcceptor (`src/autoAcceptor.ts`)

Orchestrator:
- **Public API:** `start()`, `stop()`, `toggle()`, `recover()`, `dispose()`
- **Helpers:** `src/catalog.ts`, `src/blocked.ts`, `src/settingsGuard.ts`, `src/cdpFallback.ts`
- **State:** `isRunning`, `isDisposed`, poll overlap guards, terminal pause deadline

### Extension Entry (`src/extension.ts`)

- **Activation:** Status bar starts off unless the user previously turned it on
- **Command Registration:** Toggle, start, stop, accept now, diagnostics
- **Disposal:** Restores settings on unload and keeps the on/off choice

## Strategy details

### Strategy 1: Settings Injection

```typescript
// On startup
applyAutoApproveSettings() {
  - Set chat.tools.autoApprove = true
  - Set chat.agent.autoApprove = true
  - Set terminal auto-approve settings
  - Remember original values in extension storage before writing
  - Does not disable workspace trust
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
  - Fast poll → agent and terminal accept commands
  - Full poll → chat accept and terminal chat run
  - Does not call notification.acceptPrimaryAction
  - Skips terminal run commands while CDP is enabled
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
  - onDidStartTerminalShellExecution → close terminal if the command is blocked
  - onDidChangeActiveTextEditor → fire agent accept commands
  - onDidChangeVisibleTextEditors → fire agent accept commands
  - Keyboard/mouse selection → pause polling briefly
}
```

### Strategy 4: CDP Fallback

```typescript
startCDPPolling() {
  - Connect to 127.0.0.1 on autoAcceptAgent.cdpPort (default 9222)
  - Attach only to vscode-webview targets
  - Click approval buttons after the shared blocklist check
  - Every 1500ms cycle
}

buildPermissionScript() {
  - Search for buttons with text: "Run", "Accept", "Allow", "Yes"
  - Check container text for blocked commands
  - Click if safe
  - Debounce with 5-second cooldown per target
}
```

## State machine

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

## Data flow

### Approval event

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

## Concurrency and safety

### Race condition prevention

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

## Performance (rough estimates)

The numbers below are rough observations from a standard active editing session on a modern multi-core workstation, not formal benchmark results:

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

## Error handling

All strategies include:
1. Try-catch blocks that log and continue
2. Guard checks that exit early on invalid state
3. Fallback behavior so a missing API does not crash
4. Logging to the output channel for debugging

```typescript
try {
  await vscode.commands.executeCommand(cmd);
} catch {
  // Command not available in this context
  // Just skip and continue
}
```

## Testing points

Key areas to test:
- [x] Blocklist matcher (`npm test`)
- [ ] Settings injection/restoration inside VS Code
- [ ] Command polling execution
- [ ] Event listener setup/cleanup
- [ ] Blocked command terminal close
- [ ] CDP webview filtering
- [ ] Concurrent approval scenarios
- [ ] Long-duration stability
- [ ] Memory leak detection

## Future improvements

- Configurable strategy ordering
- Per-command approval rules
- Approval analytics/history
- Custom strategy plugins
- Performance profiling tools


See [how-it-works.md](../docs/how-it-works.md) for user-facing technical details.
