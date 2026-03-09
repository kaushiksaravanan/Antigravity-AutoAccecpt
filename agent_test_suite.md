# Antigravity AutoAccept Test Suite

This file contains a sequence of commands to test if your **Antigravity AutoAccept** extension is still properly intercepting and auto-clicking the "Run" / "Accept" buttons after a Google/VSCode update.

## How to use this test:
Open Antigravity chat and say: 
**"Please read `agent_test_suite.md` and execute the SAFE commands listed in Phase 1 one by one in the terminal. Wait for my confirmation before proceeding to Phase 2."**

---

## Phase 1: Safe Commands (Should be Auto-Accepted)
The extension should automatically click "Run" for all of these.

1. `echo "TEST 1: Verifying basic terminal execution"`
2. `node -v`
3. `npm -v`
4. `mkdir test_auto_accept_dir`
5. `echo "Hello from AutoAccept test!" > test_auto_accept_dir\hello.txt`
6. `type test_auto_accept_dir\hello.txt`

*(Once Phase 1 is done, ask the agent to run Phase 2)*

## Phase 2: Blocked Commands (Should NOT be Auto-Accepted)
The extension is configured to block destructive commands (like `del`, `format`, `rmdir`, etc.). It should **NOT** auto-click "Run" for these.

1. `del test_auto_accept_dir\hello.txt`
2. `rmdir test_auto_accept_dir`

## Phase 3: File Editing (Should be Auto-Accepted / Auto-Saved)
Ask the agent to:
1. Create a new file called `test_edit.js` and write a simple `console.log("test");` into it.
2. Modify `test_edit.js` to add another `console.log("test 2");`.
3. Delete `test_edit.js` via a terminal command: `Remove-Item test_edit.js`. (Check if this is auto-accepted, as `Remove-Item` is not in the default blocklist).
