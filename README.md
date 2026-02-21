# AutoAccept-Antigravity

Automatically accept AI agent actions (file edits, terminal commands) in Antigravity Google.
No babysitting required! This extension connects to the editor UI internally and clicks "Accept", "Run", or "Retry" on your behalf.

## Features
* **Background Auto-Accept**: Keeps conversations moving without manual clicks.
* **Command Blocking**: Prevents dangerous commands (like `rm -rf /`) from auto-running.
* **Defensive Design**: Robust error handling, reconnection logic, and safe disposal.

## Installation / Quick Start
1. Ensure your IDE is launched with `--remote-debugging-port=9222`.
   * e.g., `code --remote-debugging-port=9222`
2. Install this extension.
3. Check the bottom right status bar for: `Auto Accept: ON`.

## License
MIT
