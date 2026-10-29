# Antigravity AutoAccept: repository review and interview preparation

Reviewed 29 October 2026. Default branch: master. Version: 0.7.10.
Pinned commit: [46cd4ae4467d7c992ce8445ce57b785b788f4f35](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/commit/46cd4ae4467d7c992ce8445ce57b785b788f4f35), released 30 September 2026.

**Verdict:** The extension provides approval automation with a best-effort text denylist. It does not reliably prevent destructive execution. It has no AST-based command analysis, recursive script/file scanning, import-graph analysis, or filesystem execution sandbox.

This is a review, not an implementation patch. No repository changes, comments, releases, or pull requests were made.

## Evidence and scope

- **A (user-observed work):** Your question identifies the right distinction between direct commands and indirect execution. You did not provide an interview attempt, so this report makes no judgment about your independent review ability or reasoning process.
- **B (verified evidence):** Source inspection at the pinned commit, official VS Code documentation, and isolated tests of the actual repository functions.
- **C (reconstructed analysis):** Suggested review approaches, interview questions, and architecture recommendations. These are not accounts of an expert's private reasoning or an actual frontier lab rubric.
- **D (hypothetical outcomes):** Real data loss, malicious use of configuration or UI spoofing, detached child-process survival, and production multi-window behavior were not exercised. Where a mechanism was reproduced with mocks, that is stated separately from its possible real-world consequence.

All 33 text files were retrieved: seven runtime modules, one release script, automated/manual tests, manifest/lockfile/compiler configuration, all documentation and presets, licensing/contribution files, and SVG source. The sole binary, icon.png, was inventoried but not decoded. Dependencies were inspected through the lockfile, not audited transitively. Git history, all branches, marketplace binaries, and external agent internals are outside this review.

The repository's four test cases pass through a Node 24 harness. Sixteen additional review checks also pass, because they assert the observed limitations and failure behavior. They are reproductions, not fixes or safety certification. VS Code APIs, DOM behavior, socket failures, and publishing side effects are mocked. No deletion command was executed. The standard `npm test` command was attempted and stopped at `tsc: not found`; a normal TypeScript build, packaging run, and live IDE end-to-end test were not completed.

## Direct answers

| Question | Current implementation |
| --- | --- |
| Does it recognize literal `rm -rf ./fixture`? | Yes, when that text reaches the matcher with the default patterns. |
| Does this guarantee deletion is prevented? | No. The ordinary terminal listener runs after the shell execution starts; interruption and closing the terminal are best effort. |
| Does it detect inline `bash -lc "rm -rf ./fixture"`? | This particular form is recognized. Other shell forms are missed. |
| Does it read `bash cleanup.sh` before approval? | No. It only sees the command text supplied to the matcher. |
| Does it follow cleanup.sh → nested.sh? | No. No file-loading or dependency traversal exists in the approval path. |
| Does it examine Python/Node imports or package lifecycle scripts? | No. `python main.py`, `node main.js`, and `npm run cleanup` do not expose their transitive effects to this checker. |
| Does it detect deletion through `shutil.rmtree` or `fs.rmSync`? | No semantic rule exists for these APIs. The example inline calls below return no match. |
| Is there an AST? | No. There is a custom quote/token splitter and exact token-sequence comparison. |
| Is there any recursion? | Yes, limited recursion for unwrapping some inline command strings, and DOM/shadow-root traversal. Neither is recursive script/import scanning. |
| Can CDP reject before a click? | Yes, when it finds matching text in the chosen nearby container. This is optional and incomplete, and other approval paths can bypass it. |

The matcher lives in [blocked.ts](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/blocked.ts#L8). Its recursive helpers are at [lines 102–145](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/blocked.ts#L102). It receives text and patterns; it does not receive a filesystem, working directory, module resolver, or execution request.

## Approval paths and their different guarantees

| Path | Inspects the actual pending action? | Safety boundary |
| --- | --- | --- |
| Global settings injection | No | Enables native tool/terminal auto-approval wherever supported. |
| Fast/full command polling | No | Fires known accept command IDs. The blocklist is not consulted here. |
| Editor/terminal events | Mostly no | Editor changes trigger generic acceptance; terminal-start events inspect already-started command text. |
| CDP | Partial nearby UI text | Can withhold its own click, but has no authoritative request or complete command representation. |
| Accept All Now | No | Fires every catalogued accept command directly. |
| Terminal-start listener | Already-started command only | Tries Ctrl+C and terminal disposal after a match. |

This is the central interview finding: **a shared matcher is not a shared authorization boundary.**

## Prioritized findings

Priority is a review judgment for an extension presented as protecting against dangerous approvals. P1 means fix before making a prevention guarantee; P2 means a material reliability, testing, or operational gap. These are not CVSS scores.

### F1 (P1): the main protection runs after execution begins

**Evidence B:** [autoAcceptor.ts:283–307](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/autoAcceptor.ts#L283) subscribes to `onDidStartTerminalShellExecution`, reads the command line, then sends Ctrl+C and disposes the terminal. The VS Code API defines this as an execution-started event and says it fires only when shell integration is active. Its command text can become more accurate after execution ends. [Official API](https://code.visualstudio.com/api/references/vscode-api#window.onDidStartTerminalShellExecution).

**Failure D:** A fast deletion can complete before the listener reacts. Closing a terminal cannot undo completed effects and is not a guarantee that every descendant or detached process is stopped. An absent API, inactive integration, or empty command text produces no protection.

**Additional verified defect:** The warning says the command was stopped before either interruption attempt, and both attempts swallow errors. The UI does not establish that termination succeeded.

**Fix:** Enforce policy before the actual execution handoff. If the integration cannot inspect and gate a pending action, preserve manual approval or run it within a separately enforced restricted environment. Keep the post-start listener as detection/containment only. Report "interruption attempted," not successful prevention.

**Interview question C:** What concrete event ordering proves that no filesystem write occurs before the checker returns?

### F2 (P1): unchecked paths bypass the policy, including native global approvals

**Evidence B:** [catalog.ts:55–65](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/catalog.ts#L55) attempts to set `chat.tools.global.autoApprove = true` and other approval settings. [fireCommands](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/autoAcceptor.ts#L252) never obtains the pending command. [acceptNow](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/extension.ts#L55) ignores running state, pause, CDP, and the matcher. These settings are written at Global scope by [settingsGuard.ts:61–74](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/settingsGuard.ts#L61).

VS Code documents overall tool auto-approval as bypassing user approval checks. Which keys are accepted depends on the host/version; source presence does not prove every setting takes effect on every supported editor. [Official security documentation](https://code.visualstudio.com/docs/agents/run/security).

**Reproduction B:** Calling Accept All Now in an otherwise stopped mock environment still issues terminal run approvals. This may be an intended explicit manual override, but it has no blocklist guarantee and must be described as such.

**Failure D:** Even a perfect CDP parser cannot veto a native approval or another accept command that already bypasses it. The advertised 60-second pause also leaves the injected global settings enabled. Generic agent-step commands remain outside the run-accept set; their exact tool semantics require a live supported-agent test, rather than assuming they are harmless.

**Fix:** Introduce one request-aware decision point used by every approval path. Avoid global bypass settings in a safety-enforcing mode. Make any deliberate override explicit and narrowly scoped to a known action.

### F3 (P1): ordinary equivalent commands evade the matcher

**Evidence B:** [blocked.ts:95–169](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/blocked.ts#L95) normalizes the executable basename only for one-token patterns. Multi-token rules compare the original tokens exactly. Flags are not parsed by meaning, and argument order is fixed.

These are actual matcher results from the default list:

| Inert input string | Result |
| --- | --- |
| `rm -rf ./fixture` | `rm -rf` match |
| `bash -lc "rm -rf ./fixture"` | `rm -rf` match |
| `rm -fr ./fixture` | No match |
| `rm -r -f ./fixture` | No match |
| `rm --recursive --force ./fixture` | No match |
| `/bin/rm -rf ./fixture` | No match |
| `git push origin --force` | No match |
| `git -C ./fixture reset --hard` | No match |
| `bash cleanup.sh` | No match |
| `python main.py` | No match |
| `python -c "import shutil; shutil.rmtree('./fixture')"` | No match |
| `node -e "require('fs').rmSync('./fixture', {recursive: true, force: true})"` | No match |
| `echo ok & del fixture.txt` | No match; the single `&` separator is relevant to cmd.exe |
| `bash -c "echo ok; del fixture.txt"` | No match in the matcher; this models a nested single-word pattern, not a claim that Unix ships a `del` executable |
| `echo rm -rf ./fixture` | Matches despite merely printing arguments |

**First divergence:** For `/bin/rm -rf`, the code computes head `rm`, but the multi-token comparison still uses `/bin/rm`. For `rm -fr`, the single flag token is unequal to `-rf`. For nested single-word commands, recursive matching does not rerun the top-level command-segment split.

**Fix:** Use a real parser for each supported shell and command-specific option normalization. Treat unsupported syntax, unresolved expansion, aliases, and wrappers as unknown. A larger denylist alone cannot justify arbitrary-code safety.

### F4 (P1 capability gap): scripts, nested scripts, modules, and non-shell effects are opaque

**Evidence B:** All matcher call sites pass command text or DOM text. There is no script reader, import resolver, AST library, call graph, or execution sandbox in the runtime modules.

**Hypothetical chain D:**

`bash cleanup.sh` → `source helpers.sh` → destructive operation.

Or:

`python main.py` → `import cleanup` → import-time filesystem deletion.

The outer strings return no match in the tested matcher. The nested files were not executed. Similarly, npm lifecycle scripts, Make targets, native executables, remote downloads, and editor tools can have destructive effects without a literal `rm -rf` visible to this matcher.

**Fix:** Bounded static analysis can inspect known local scripts and imports, but the final control must restrict runtime effects. State the supported subset and return "unknown" outside it. File editing is also a separate effect channel; approving an edit to an executable/configuration can influence later runs.

**Interview question C:** If the same `python main.py` string can refer to safe code today and destructive code tomorrow, what extra evidence does your decision require?

### F5 (P1): enabling CDP can silently fall back to blind approvals

**Evidence B:** [shouldFireRunAccept](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/autoAcceptor.ts#L269) returns true unless CDP is both enabled and connected, or a pause is active. The first CDP scan is scheduled 1.5 seconds after start. Missing/closed debugging ports produce `connected = false`.

**Reproduction B:** With CDP enabled and disconnected, `shouldFireRunAccept()` returns true.

**Consequence:** Requesting inspection does not ensure it happens. The fallback favors continued automation when inspection is unavailable.

**Fix:** Distinguish "unchecked automation" from "inspect before approval." The latter must retain the prompt when inspection is unavailable, with an accurate degraded-state indicator. Do not automatically broaden privileges because an inspector failed.

### F6 (P1): CDP treats missing/truncated UI evidence as permission to click

**Evidence B:** [cdpFallback.ts:331–403](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/cdpFallback.ts#L331) recognizes generic UI selectors, finds buttons by text, guesses an ancestor using class substrings, and checks only `innerText.slice(0, 4000)`. Missing text becomes the empty string, which matches no blocklist entry.

**Mock reproductions B:** A Run button is clicked when the selected container has no text. It is also clicked when a blocked command follows 4,001 filler characters. The same mock refuses a nearby literal `rm -rf`, confirming the test distinguishes the branches.

**Other limits:** No stable approval/request ID ties the scanned text to the executed action. "Always allow" and "Allow this conversation" are default loose-button targets, potentially granting permission beyond the current request. No visibility check proves the matched element is the visible intended approval.

**Fix:** Read a structured action from a trusted integration. Missing, oversized, ambiguous, or changed content must retain the prompt. Bind a decision to a specific request/action, and avoid persistent "always allow" actions.

### F7 (P1): CDP origin/agent identification is only a substring heuristic

**Evidence B:** [isExtensionWebview](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/cdpFallback.ts#L304) checks only whether a URL contains `vscode-webview`. It does not validate scheme, origin, target type, active window, or extension identity. Generic `data-vscode-context` is sufficient for the page script's agent-panel gate.

**Reproduction B:** `https://example.invalid/?q=vscode-webview` passes the target predicate.

**Bounded consequence D:** An unrelated or adversarial target must actually appear in the connected debugger's target list, and it must supply matching DOM, before this becomes an unwanted click. The unit test does not demonstrate compromise of a real editor.

The initial HTTP call uses localhost, but [browserWsUrl](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/cdpFallback.ts#L264) trusts the returned WebSocket URL without checking it remains local or bound to the same editor. A malicious local endpoint is an additional assumption, not an observed deployment.

**Fix:** Parse/validate debugger endpoints, verify the expected target and extension, bind to the intended window/session, and reject ambiguous identities. Keep a debugging port narrowly exposed.

### F8 (P1): Stop is not a reliable cancellation boundary

**Evidence B:** [CdpFallback.stop](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/cdpFallback.ts#L69) clears an interval and increments generation but does not close the active socket. Generation is checked after HTTP discovery; [evaluateTargets](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/cdpFallback.ts#L212) performs later awaits without rechecking active state or generation before Runtime.evaluate.

**Reproduction B:** Stop during target discovery is followed by attach and Runtime.evaluate.

Separately, [AutoAcceptor.stop](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/autoAcceptor.ts#L138) awaits persisting the disabled choice before setting `isRunning = false` or clearing timers. A rejected persistence write leaves the engine running in the isolated test.

**Fix:** Stop local activity synchronously first. Invalidate a shared generation/token, close owned sockets, cancel timers, and check the token immediately before each new side effect. Persist the preference afterward and surface failures. Already-issued external actions cannot necessarily be recalled; document that precise limit.

### F9 (P1): a pause is cached for an entire asynchronous polling batch

**Evidence B:** [autoAcceptor.ts:252–265](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/autoAcceptor.ts#L252) computes `allowRun` once before a loop containing awaits.

**Reproduction B:** The first command's mock triggers a blocked-command pause. Later commands in that same batch still include `antigravity.terminalCommand.run`.

**Fix:** Re-evaluate pause and generation immediately before each command, not once per batch. Use one scheduler across event, fast-poll, full-poll, and manual paths when approvals need ordering. Separate per-loop busy flags do not serialize all paths.

**Transfer:** An authorization decision can become stale across an await even on a single JavaScript thread.

### F10 (P1 under an untrusted-agent threat model): workspace content can replace the policy

**Evidence B:** [package.json configuration](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/package.json#L65) does not restrict policy settings to user-only scope. [blockedCommands](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/autoAcceptor.ts#L420) reads effective configuration, so a workspace list replaces the defaults; an empty list is accepted. VS Code's default setting scope is window, which permits workspace configuration. [Official contribution-point reference](https://code.visualstudio.com/api/references/contribution-points#contributes.configuration).

**Threat D:** Once a workspace is trusted, agent-controlled repository changes to its settings can weaken the policy that reviews later agent actions. This is not a claim that the extension disables Workspace Trust; it does not.

**Fix:** Keep security policy in a trusted control plane. Workspace changes may tighten policy, but should not silently relax user constraints. Require explicit user action for policy reductions and log policy-version changes.

### F11 (P1): OFF can coexist with native auto-approval still enabled

**Evidence B:** [settingsGuard.ts:91–112](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/settingsGuard.ts#L91) catches per-setting restore failures and preserves pending entries, but returns success to its caller. [stop](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/autoAcceptor.ts#L161) consequently shows OFF and may show "Stopped."

**Reproduction B:** Injecting a restore failure for `chat.tools.global.autoApprove` leaves it true while the status bar reports OFF.

**Fix:** Return a structured restoration result. Distinguish "extension loops stopped" from "native settings restored." Show an actionable pending-restoration state, retry explicitly, and preserve recovery data. Preserving the snapshot is good, but silent incomplete restoration is not a complete shutdown guarantee.

### F12 (P2): start/stop and settings restoration lack coherent ownership

**Evidence B:** [start](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/autoAcceptor.ts#L104) checks its generation before an awaited enabled-state write, but does not check again afterward. A stop during that wait produces `isRunning = false` with an ON label and reinstated listeners in the isolated test.

[SettingsGuard.recover](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/settingsGuard.ts#L24) interprets any snapshot as leftover crash state; it has no active-owner/session identity. Two guards sharing global state reproduce one instance restoring settings while the first still considers them applied. Real multi-window timing and storage synchronization require a live IDE test.

**Fix:** Serialize lifecycle transitions and model starting/running/stopping/degraded states explicitly. Give settings changes an owner and crash-recovery lease, or avoid shared global mutations. Restore only settings still owned by the extension; handle deliberate user changes as a defined conflict.

The FAQ explicitly says user edits made while ON are overwritten on Stop. That is a documented product choice, not an undisclosed bug; discuss whether it is a good choice.

### F13 (P2): configuration changes and CDP health can misrepresent active behavior

**Evidence B:** The configuration listener [autoAcceptor.ts:65–71](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/autoAcceptor.ts#L65) restarts polling/CDP but never applies or restores SettingsGuard. Turning `autoConfigureSettings` off while running leaves injected settings active until a later stop; reproduced.

[cdpFallback.ts:112](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/cdpFallback.ts#L112) marks connected before a WebSocket is usable. Error/close handlers do not clear that flag. A failed socket leaves `isConnected()` true in the test; zero eligible targets or failed evaluations likewise do not establish an operational inspector.

**Fix:** Reconcile config transitions explicitly. Track discovery, connection, verified target, and successful inspection separately. A URL response is not proof the inspector is working.

### F14 (P2): manual terminals are affected and raw commands are logged

**Evidence B:** The shell listener does not distinguish user-typed commands from agent-launched commands. A mocked manual `rm -rf ./fixture` closes its terminal. This conflicts with the expectation that a human can approve an intentional action while retaining automation.

Allowed command lines are written to both the output channel and console at [autoAcceptor.ts:294](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/autoAcceptor.ts#L294). A command carrying a token in an argument would therefore put it in local logs.

**Fix:** Correlate terminal executions with agent requests when supported; otherwise clearly describe the global terminal behavior. Redact sensitive arguments and make detailed logging explicit. This is a local log exposure risk; no remote telemetry exfiltration was found in the runtime modules.

Diagnostics also writes a fixed `autoaccept-diagnostics.md` in the shared temp location at [diagnostics.ts:164](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/src/diagnostics.ts#L164), causing collisions across instances. Prefer an untitled editor or a uniquely created temporary file. A platform-dependent symlink attack is not established here.

### F15 (P2): alternative presets silently discard protections

**Evidence B:** [aggressive.json](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/examples/aggressive.json) and [relaxed.json](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/examples/relaxed.json) contain only `rm -rf /`, `format`, and `mkfs`. They replace the full default list. Under either preset, `rm -rf ./fixture` returns no match; reproduced.

The "security-hardened" preset adds patterns but still enables global setting injection and disables CDP, so it has no stronger pre-execution boundary.

**Fix:** Preserve base deny rules in all examples, separate additive rules from deliberate overrides, and describe exactly which guarantee a preset offers. Slower polling is not a security guarantee.

### F16 (P2): test and release validation do not cover the safety claims

**Evidence B:** [blocked.test.ts](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/test/blocked.test.ts) has four test cases covering only the matcher. The automated test compilation includes the matcher/catalog/test files, not lifecycle/CDP integration. No GitHub Actions workflows are present in the reviewed tree.

There are no automated checks for actual approval-before-execution ordering, missing shell integration, stop races, wrong webviews, nested scripts, changed scripts after inspection, restore failures, multiple windows, or native approval settings. Manual checks mostly ask whether a terminal closes, not whether a sentinel file survived unchanged.

The manifest advertises VS Code ^1.90.0 while the lockfile resolves @types/vscode 1.109.0. This is not proof of a crash; the shell API is feature-detected. It does mean current-type compilation is insufficient evidence for the oldest supported host and its safety behavior.

**Fix:** Add integration tests around the complete action boundary, a supported-editor/version/OS matrix, real disposable filesystem sentinel checks inside a dedicated sandbox, lifecycle fault injection, DOM fixtures, and parser differential/fuzz tests. Require tests and compilation before packaging.

### F17 (P2): publishing can fail while the release script reports success

**Evidence B:** [release.js:227–255](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/scripts/release.js#L227) catches both registry publication failures, logs them, then prints a successful-completion message without a failure exit code. Reproduced with child-process/network mocks and no publication.

Additional source-level issues:
- The prerelease-only option builds a `-prerelease.vsix`, while publishing always selects the stable filename.
- Versions/docs are mutated before compilation; a failed build can leave release metadata advanced.
- Every package operation queries Open VSX, even without the documented sync option, and the HTTP request has no explicit deadline.
- CLI token arguments are interpolated into shell command strings. Use argument arrays and avoid exposing secrets in command-line/log paths.
- `npx -y ovsx` fetches an unpinned publishing CLI.
- Tests are not a release gate; only compilation runs.
- Generated changelog entries claim fixes and performance changes without deriving them from the release contents.

**Fix:** Validate arguments and artifacts first, run tests/build before mutation, stage metadata changes, use process APIs without shell interpolation, pin publishing tooling, publish the selected artifact(s), and fail the command when a requested publication fails.

### F18 (P2): documentation overstates measured guarantees

**Evidence B:** [README.md:15](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/README.md#L15) says the blocklist prevents dangerous operations; the implementation cannot support that categorical claim. The later FAQ caveat helps but does not repair the headline.

[faq.md](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/docs/faq.md#L35) and [ARCHITECTURE.md](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/assets/ARCHITECTURE.md#L199) give specific CPU/memory/latency numbers without a benchmark harness or results in this tree. These figures are unverified in this review, not proven false. Ordinary `setInterval` does not establish a special low-priority scheduler.

[CONTRIBUTING.md](https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt/blob/46cd4ae4467d7c992ce8445ce57b785b788f4f35/CONTRIBUTING.md#L143) describes automatic GitHub Actions publishing from main, but the reviewed branch is master and contains no workflows.

**Fix:** Replace prevention claims with observed best-effort behavior until an enforceable boundary exists. Publish benchmark methodology and raw results before numerical claims. Align docs, presets, manifest, and release instructions with tested behavior.

## What is already useful

The current release is materially better than the removed earlier patterns described in its changelog: fresh installs stay off; it no longer writes the Workspace Trust setting; unrelated notification-primary-action commands are absent; settings are snapshotted before mutation; pending timers are tracked; each polling loop has an overlap guard; and the matcher is shared across host and CDP.

Do not spend an interview criticizing already-removed RevenueCat code or claiming the current release still disables Workspace Trust. The current problems are incomplete mediation, insufficient action evidence, and lifecycle guarantees.

Also, `new Function` here compiles a fixed source string; user patterns are passed as data. Its presence alone does not prove arbitrary-code injection. CDP configuration arrays are JSON-serialized. The real issue is weaker checking and typing inside the embedded matcher, not an established eval-injection exploit.

## A defensible improvement path

**C (suggested architecture, not implemented).**

1. Define the protected effects: deletion outside designated scratch output, overwrite of source/configuration, credential access, network side effects, and nonterminal tool actions. Separate accidental command mistakes from malicious repository content or a compromised agent.
2. Obtain a structured pending request: request ID, tool, executable/arguments or shell dialect, working directory, relevant environment, file dependencies, and trusted policy version.
3. Route every approval through one decision function returning allow, deny, or needs-human-review. No parser result, no text, unsupported syntax, changed files, or timeout should silently become allow.
4. Use shell ASTs for syntax and command-specific semantics for options. Analyze literal inline interpreter code with the relevant language parser where justified.
5. Resolve known local script/import edges with a visited set and explicit resource budgets. Record unknown edges. Do not execute code during analysis. Pin the inspected bytes and execution context to avoid checking one version and executing another.
6. Enforce filesystem/process/network capabilities during execution. Restrict all descendants, minimize credentials, and use immutable/read-only inputs where appropriate. A writable disposable worktree limits damage but is not itself a complete security boundary.
7. Use one cancellation generation and an ordered scheduler; check state after awaits and before side effects. Separate stopping the extension from restoring native settings.
8. Keep a redacted decision log with request ID, evidence, policy version, outcome, and failure reason. Prove negative guarantees with sentinel resources, not merely "a handler ran."

AST parsing identifies syntax; it does not establish every runtime effect. File contents, variables, environment lookup, imports, dynamic loading, native modules, and input from the network can change behavior. A conservative analyzer can refuse uncertain cases; a complete, permissive safety oracle for arbitrary programs is not a credible project goal.

For a statically known dependency graph, visiting each vertex/edge once costs O(V + E), plus the cost of parsing the files. That bound does not solve dynamic dependency discovery. Cache decisions by immutable content and relevant context; an unchanged filename is not an unchanged program.

The existing token matcher repeatedly scans segments and patterns. For T input tokens, P patterns, and at most M tokens per pattern, naive sequence matching contributes roughly O(P*T*M), plus repeated tokenization and bounded wrapper recursion. Precompiling patterns can improve speed; it does not repair missing semantics or enforcement.

## Interview preparation

These are **C (plausible review prompts)**, not predictions of a particular company's questions.

| Question | What a defensible answer must demonstrate |
| --- | --- |
| Where is the authorization boundary? | Enumerate every path that can approve or execute, then show the policy dominates those paths. |
| Why is `onDidStart...` insufficient? | Distinguish observing a started operation from preventing its first side effect. |
| Will adding AST parsing make this safe? | Separate syntax, resolution, effects, dynamic uncertainty, and runtime capability enforcement. |
| What if CDP disconnects? | Describe a deliberate fail-closed or manual-review policy with accurate health state. |
| What does Stop guarantee? | No new approvals after invalidation; cancellation of owned resources; explicit limits for already-issued actions; restoration result reported separately. |
| Can an agent change its own rules? | Protect policy/configuration from content controlled by the actor being governed. |
| How do you prove a blocked deletion did not occur? | Sentinel files and content hashes within an isolated environment, correlated with the action request and timing. |
| What happens across two windows or a crash? | Owner-aware settings mutations, recovery, contention, and consistent observable state. |
| Can an LLM classify commands instead? | Use a model for explanations or triage, not as a deterministic guarantee about arbitrary execution. Measure false approvals and preserve a hard boundary. |
| Which changes come first? | Fix unchecked approvals and stop behavior before expanding parser coverage or tuning polling. |

**Suggested position:** "This release is an approval-automation prototype with best-effort pattern checks. Its main check is after execution starts, several approval paths bypass the checker, and it cannot inspect scripts or imports. I would add a common pre-execution policy boundary, conservative handling of unknown actions, and runtime restrictions before claiming destructive-action prevention."

Do not present that as already implemented or claim a review found no remaining vulnerabilities.

## Reconstructed review routes and failure/recovery records

These short routes are **C**, grounded in **B** findings. They are not attributed to your thinking.

| Route | Plausible starting choice | Earliest discriminating check | Outcome and recovery |
| --- | --- | --- | --- |
| Literal-pattern review | See `rm -rf` in defaults and assume coverage | Test `rm -fr` and `/bin/rm -rf` | Both miss; separate spelling matches from command semantics. |
| Enforcement-first review | Start at execute/accept side effects | Ask what information every caller checks before the effect | Finds blind paths even before parser weaknesses; centralize the decision boundary. |
| AST-only redesign | Parse shell commands and recursively open scripts | Change a dependency after analysis, or introduce an unresolved dynamic import | Static evidence is incomplete or stale; pin artifacts, retain unknown outcomes, restrict runtime capabilities. |
| Runtime-first alternative | Execute only with constrained filesystem/network permissions | Try direct API deletion in a child module | Protection can apply regardless of syntax; cost is compatibility/configuration, and permitted writable paths still remain at risk. |

Failure/recovery graph, written as explicit edges:

| Trigger | Assumption → decision → consequence | Detection | Prevention / recovery | Related pattern |
| --- | --- | --- | --- | --- |
| Literal `rm -rf` is in a list | "Dangerous deletion is covered" → accept unmatched forms → equivalent operations evade | Reordered/split flag tests | Parse supported syntax; unknown requires review; restrict effects | Representation mismatch |
| Shell-start event arrives | "I can still prevent the operation" → send Ctrl+C → some effects may already exist | Sentinel survival and event ordering in a sandbox | Gate before execution; label interruption accurately | Postcondition vs precondition |
| CDP unavailable | "Automation should continue" → blind fallback → inspection guarantee disappears | Inject disconnected state | Preserve the prompt and show degraded state | Fail-open fallback |
| Await inside approval batch | "The earlier pause decision is current" → reuse cached allow → approve after pause | Trigger pause from first awaited command | Recheck generation/policy before each side effect | Stale authorization |
| User presses Stop | "Clearing timers cancels async work" → leave scan promises alive → later evaluation proceeds | Stop during target discovery | Cancel owned work, close sockets, recheck state | Cancellation is cooperative |
| Restore fails | "Caught error means graceful stop" → display OFF → native settings remain permissive | Fail one configuration update | Report partial restoration and retain retry state | Partial transaction |
| Agent edits workspace config | "Workspace settings are trusted policy" → replace denylist → actor controls its reviewer | Set an empty effective list | Protect policy separately; allow only tightening by workspace | Trust-boundary inversion |
| Registry publication fails | "Logging the error is sufficient" → finish normally → automation records success | Mock publisher failure and inspect exit code | Propagate failure with per-target status | Error swallowing |

## Reproduce and extend

Unzip this review bundle into a new directory. Fetch the pinned public source, then run with Node 24:

```bash
git clone https://github.com/kaushiksaravanan/Antigravity-AutoAccecpt.git review-source
git -C review-source checkout --detach 46cd4ae4467d7c992ce8445ce57b785b788f4f35
node --disable-warning=ExperimentalWarning --test review-tests.cjs
```

The harness uses Node's TypeScript transformation, then loads the actual source functions with mocked host effects. It runs the four original tests unchanged and sixteen targeted review tests. The extra tests intentionally assert current failure behavior; when fixes are implemented, replace them with the desired safety assertions.

Files:
- `REVIEW.md`: this report.
- `review-tests.cjs`: complete harness.
- `review-tests.tap`: captured test output from this review.
- `review-results.json`: representative command and state traces.
- `source-manifest.json`: commit, file coverage, hashes, and exclusions.
The original repository source is not duplicated in the bundle. The commands above retrieve the exact reviewed commit. All 33 text-file blob hashes matched GitHub during this review. No dependencies, build outputs, binary icons, or credentials are included.

Useful next integration experiments, **D until run**:
1. A disposable sandbox with sentinel files outside the allowed scratch directory; test direct, script, imported-module, and native filesystem deletion.
2. Shell integration absent and command text of low confidence.
3. CDP disconnect, wrong target, empty text, truncated text, persistent "always allow," and stop during each await.
4. Configuration write failure, crash mid-apply/restore, two real editor windows, and manual settings changes.
5. A script or import changed between review and execution.
6. Every claimed supported editor/OS/version, including its exact accept-command semantics.

No production deletion, real IDE click, actual publishing, or benchmark was performed. Source-level and mocked evidence supports the findings above; it does not establish the frequency of real-world harm.
