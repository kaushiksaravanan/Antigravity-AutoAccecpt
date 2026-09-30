# Antigravity AutoAccept Test Suite

Use this with the agent after a VS Code or Antigravity update.

Open chat and say:

**"Please read `docs/agent-test-suite.md` and run the Phase 1 commands one by one in the terminal. Wait for my confirmation before Phase 2."**

Auto Accept has to be on (status bar). Shell integration has to be enabled for the blocklist to see commands that already started.

## Phase 1: Safe commands

These should be approved.

1. `echo "TEST 1: Verifying basic terminal execution"`
2. `node -v`
3. `npm -v`
4. `mkdir test_auto_accept_dir`
5. `echo "Hello from AutoAccept test!" > test_auto_accept_dir\hello.txt`
6. `type test_auto_accept_dir\hello.txt`

## Phase 2: Blocked commands

The default blocklist matches these command names. The extension should close that terminal and pause terminal auto-accept for 60 seconds. It should not leave `del` or `rmdir` running.

1. `del test_auto_accept_dir\hello.txt`
2. `rmdir test_auto_accept_dir`

`git format-patch` and `npx prettier --write` should still be approved. `format` matches the command name, not the word inside another command.

## Phase 3: File editing

1. Create `test_edit.js` with `console.log("test");`
2. Add another `console.log("test 2");`
3. Do not use `Remove-Item` as the "safe delete" check. `Remove-Item` is on the default blocklist. Delete the file from the editor, or remove `Remove-Item` from `autoAcceptAgent.blockedCommands` before asking the agent to run it.
