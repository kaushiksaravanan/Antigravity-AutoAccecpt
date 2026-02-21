# AutoAccept-Antigravity

Automatically accept AI agent actions (file edits, terminal commands) in VS Code.
No babysitting required! This extension uses VS Code's native settings API to auto-approve agent actions — **no launch flags needed**.

## Features
* **Zero Config**: Just install and toggle — no `--remote-debugging-port` or special launch flags.
* **Background Auto-Accept**: Keeps conversations moving without manual clicks.
* **Settings Management**: Automatically enables/disables VS Code's built-in auto-approval settings.
* **Command Blocking**: Prevents dangerous commands (like `rm -rf /`) from auto-running.
* **Clean Toggle**: Restores your original settings when stopped.

## Installation / Quick Start
1. Install this extension from the VS Code Marketplace.
2. The extension starts automatically — check the bottom right status bar for: `Auto Accept: ON`.
3. Click the status bar item to toggle on/off.

## How It Works
When active, the extension enables VS Code's built-in auto-approval settings:
- `chat.tools.autoApprove` — auto-approves tool calls (file edits, searches)
- `chat.agent.autoApprove` — auto-approves agent actions
- `chat.tools.terminal.enableAutoApprove` — auto-approves terminal commands

When stopped, all settings are **restored to their original values**.

## Configuration
- `autoAcceptAgent.blockedCommands`: List of dangerous command patterns to block (default: `rm -rf /`, `format`, `mkfs`)

## License
MIT
