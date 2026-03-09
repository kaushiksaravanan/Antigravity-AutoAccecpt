import * as vscode from 'vscode';
import * as http from 'http';
import WebSocket = require('ws');

/**
 * AutoAcceptor v2 — Multi-Strategy Auto-Accept Engine
 *
 * Strategy 1: Settings Injection — Configures VS Code & Antigravity settings
 *             to auto-approve tools/commands without asking.
 * Strategy 2: Aggressive Command Polling — Fires all known accept/approve
 *             commands rapidly (every 800ms).
 * Strategy 3: Notification Interception — Watches for and auto-dismisses
 *             approval notifications/dialogs.
 * Strategy 4: Event-Driven Reactions — Reacts to terminal activity,
 *             document changes, and editor state changes.
 *
 * NO Chrome DevTools Protocol. NO --remote-debugging-port flag.
 */
export class AutoAcceptor implements vscode.Disposable {
    private isRunning = false;
    private isDisposed = false;
    private statusBarItem: vscode.StatusBarItem;
    private pollInterval: ReturnType<typeof setInterval> | null = null;
    private fastPollInterval: ReturnType<typeof setInterval> | null = null;
    private notificationPollInterval: ReturnType<typeof setInterval> | null = null;
    private outputChannel: vscode.OutputChannel;
    private isPollInProgress = false;
    private trackingDisposables: vscode.Disposable[] = [];

    // CDP Fallback State
    private cdpIntervalId: ReturnType<typeof setInterval> | null = null;
    private isCdpBusy = false;
    private activeCdpPort: number | null = null;
    private lastExpandTimes: Record<string, number> = {};
    private cdpCycleCount = 0;
    private readonly CDP_PORTS = [9222, 9229, ...Array.from({ length: 15 }, (_, i) => 9000 + i)];

    // Stats
    private executedCount = 0;
    private settingsApplied = false;
    private lastActivity = '';

    /**
     * ALL known accept/approve/run commands across Antigravity.
     * Grouped by priority (most important first).
     */
    private readonly criticalAcceptCommands: string[] = [
        // ── Antigravity Agent Steps (the "Run" / "Accept" button) ──
        'antigravity.agent.acceptAgentStep',
        'antigravity.agent.acceptAllAgentSteps',
        'antigravity.command.accept',
        'antigravity.terminalCommand.accept',
        'antigravity.terminalCommand.run',

        // ── Antigravity hunk-level acceptance ──
        'antigravity.prioritized.agentAcceptFocusedHunk',

        // ── Notification acceptance (catches "Allow", "Run", "Yes" buttons) ──
        'notification.acceptPrimaryAction',
        'notifications.acceptPrimaryAction',
    ];

    private readonly secondaryAcceptCommands: string[] = [
        // ── VS Code built-in chat / editing ──
        'workbench.action.chat.accept',
        'workbench.action.chat.submit',

        // ── Terminal suggestions ──
        'workbench.action.terminal.chat.runCommand',
        'workbench.action.terminal.chat.acceptCommand',
        'workbench.action.terminal.chat.insertCommand',

        // ── Notification handling ──
        'notifications.clearAll',
        'notification.clear',
    ];

    /**
     * Commands used to move focus to the agent panel before accepting.
     * antigravity.agent.acceptAgentStep requires !editorTextFocus,
     * so we must shift focus away from the editor first.
     */
    private readonly focusCommands: string[] = [
        'workbench.action.focusAuxiliaryBar',
        'workbench.action.focusSideBar',
        'workbench.action.focusPanel',
    ];

    /**
     * Settings to auto-configure so the IDE doesn't ask for permission.
     * [section, key, value]
     * These are applied at the GLOBAL level so they persist across sessions.
     */
    private readonly autoApproveSettings: Array<[string, string, unknown]> = [
        // VS Code built-in chat tool settings
        ['chat.tools', 'autoApprove', true],
        ['chat.tools.global', 'autoApprove', true],
        ['chat.tools.terminal', 'enableAutoApprove', true],
        ['chat.tools.terminal', 'autoApprove', true],
        ['chat.agent', 'autoApprove', true],
        ['chat.agent', 'maxRequests', 999],

        // Tool-specific auto-approves
        ['chat.tools.run_command', 'autoApprove', true],
        ['chat.tools.default_api:run_command', 'autoApprove', true],

        // Terminal confirmation bypass
        ['terminal.integrated', 'confirmOnKill', 'never'],
        ['terminal.integrated', 'confirmOnPaste', false],

        // Security / trust (auto-trust workspaces)
        ['security.workspace.trust', 'enabled', false],
    ];

    private context: vscode.ExtensionContext;

    constructor(statusBarItem: vscode.StatusBarItem, outputChannel: vscode.OutputChannel, context: vscode.ExtensionContext) {
        if (!statusBarItem || !outputChannel || !context) {
            throw new Error('AutoAcceptor requires StatusBarItem, OutputChannel, and ExtensionContext.');
        }

        this.statusBarItem = statusBarItem;
        this.outputChannel = outputChannel;
        this.context = context;
        this.updateStatusBar('off');
    }

    // ── Public API ─────────────────────────────────────────

    public toggle(): void {
        if (this.isDisposed) {
            this.log('Cannot toggle: AutoAcceptor has been disposed.');
            return;
        }

        try {
            if (this.isRunning) {
                this.stop();
            } else {
                this.start();
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`Toggle error: ${msg}`);
        }
    }

    public async start(): Promise<void> {
        if (this.isDisposed) {
            this.log('Cannot start: AutoAcceptor has been disposed.');
            return;
        }
        if (this.isRunning) { return; }

        if (!(await this.checkPaywallLimit())) {
            return;
        }

        const config = vscode.workspace.getConfiguration('autoAcceptAgent');
        const enablePolling = config.get<boolean>('enableCommandPolling', true);

        if (!enablePolling) {
            this.log('Command polling is disabled in settings.');
            vscode.window.showWarningMessage(
                'AutoAccept-Antigravity: Command polling is disabled in settings.'
            );
            return;
        }

        this.isRunning = true;

        // Strategy 1: Auto-configure settings to skip permission prompts
        await this.applyAutoApproveSettings();

        // Strategy 2: Start aggressive command polling
        this.startCommandPolling();

        // Strategy 3: Start notification interception
        this.startNotificationPolling();

        // Strategy 4: Setup event-driven reactions
        this.setupEventTracking();

        // Strategy 5: Setup CDP Webview Fallback (clicks physical DOM buttons)
        this.startCDPPolling();

        this.updateStatusBar('on');
        vscode.window.showInformationMessage(
            '🚀 AutoAccept-Antigravity: Running! Auto-approving all agent actions.'
        );
        this.log('AutoAccept v2 started — settings injected, polling active, event tracking on.');
    }

    public stop(): void {
        if (this.isDisposed) { return; }

        try {
            this.log('Stopping AutoAccept-Antigravity...');
            this.stopAllPolling();
            this.disposeTracking();
            this.isRunning = false;
            this.updateStatusBar('off');
            vscode.window.showInformationMessage('AutoAccept-Antigravity: Stopped.');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`Stop error: ${msg}`);
            this.isRunning = false;
            this.updateStatusBar('off');
        }
    }

    public dispose(): void {
        if (this.isDisposed) { return; }
        this.isDisposed = true;

        try { this.stopAllPolling(); } catch { /* best-effort */ }
        try { this.disposeTracking(); } catch { /* best-effort */ }
        try { this.statusBarItem?.dispose(); } catch { /* best-effort */ }
        try { this.outputChannel?.dispose(); } catch { /* best-effort */ }
    }

    // ── Strategy 1: Settings Injection ────────────────────

    private async applyAutoApproveSettings(): Promise<void> {
        if (this.settingsApplied) { return; }

        this.log('Applying auto-approve settings...');
        let applied = 0;
        let skipped = 0;

        for (const [section, key, value] of this.autoApproveSettings) {
            try {
                const config = vscode.workspace.getConfiguration(section);
                const inspect = config.inspect(key);

                if (inspect) {
                    // Setting exists — update it
                    const currentGlobal = inspect.globalValue;
                    if (currentGlobal !== value) {
                        await config.update(key, value, vscode.ConfigurationTarget.Global);
                        this.log(`  ✅ Set ${section}.${key} = ${JSON.stringify(value)} (was: ${JSON.stringify(currentGlobal)})`);
                        applied++;
                    } else {
                        skipped++;
                    }
                } else {
                    // Setting doesn't exist — try anyway (might be from an extension not yet loaded)
                    try {
                        await config.update(key, value, vscode.ConfigurationTarget.Global);
                        this.log(`  ✅ Set ${section}.${key} = ${JSON.stringify(value)} (new)`);
                        applied++;
                    } catch {
                        skipped++;
                    }
                }
            } catch (err: unknown) {
                // Setting doesn't exist or can't be set — skip silently
                skipped++;
            }
        }

        this.settingsApplied = true;
        this.log(`Settings injection complete: ${applied} applied, ${skipped} skipped/already set.`);
    }

    private async checkPaywallLimit(): Promise<boolean> {
        // Payment removed for this version
        return true;

        /*
        const isPro = this.context.globalState.get<boolean>('autoAcceptAgent.isPro', false);
        if (isPro) return true;

        const lifetimeExecutions = this.context.globalState.get<number>('autoAcceptAgent.lifetimeExecutions', 0);
        const totalExecutions = lifetimeExecutions + this.executedCount;

        if (totalExecutions >= 10) {
            if (this.isRunning) {
                this.stop();
            }
            vscode.window.showInformationMessage('You have used your 10 free Auto Accept runs. Upgrade to Pro to unlock unlimited usage!');
            vscode.commands.executeCommand('autoAcceptAgent.showPaywall');
            return false;
        }

        if (this.executedCount > 0) {
            await this.context.globalState.update('autoAcceptAgent.lifetimeExecutions', totalExecutions);
            this.executedCount = 0; // reset local tally after saving to global
        }
        
        return true;
        */
    }

    // ── Strategy 2: Aggressive Command Polling ────────────

    private startCommandPolling(): void {
        if (this.isDisposed) { return; }

        const config = vscode.workspace.getConfiguration('autoAcceptAgent');
        const intervalMs = config.get<number>('pollIntervalMs', 800);

        // Fast poll for critical commands (accept agent steps, notifications)
        this.fastPollInterval = setInterval(() => this.fastPoll(), Math.max(200, intervalMs / 2));

        // Standard poll for all commands (includes focus-aware accept)
        this.pollInterval = setInterval(() => this.fullPoll(), intervalMs);

        this.log(`Command polling started: fast=${Math.max(200, intervalMs / 2)}ms, full=${intervalMs}ms`);
    }

    /**
     * Focus-aware accept — shifts focus to agent panel, fires accept, restores.
     * This is the key fix: antigravity.agent.acceptAgentStep requires !editorTextFocus.
     */
    private async focusAndAccept(): Promise<void> {
        if (!this.isRunning || this.isDisposed) { return; }

        try {
            // Try each focus target to move focus away from editor
            for (const focusCmd of this.focusCommands) {
                if (this.isDisposed || !this.isRunning) { break; }
                try {
                    await vscode.commands.executeCommand(focusCmd);
                    // Brief delay to let focus settle
                    await new Promise(r => setTimeout(r, 50));

                    // Now fire the accept command while focus is on the panel
                    await vscode.commands.executeCommand('antigravity.agent.acceptAgentStep');
                    await vscode.commands.executeCommand('antigravity.agent.acceptAllAgentSteps');
                } catch {
                    // Focus command may not apply — try next
                }
            }
        } catch {
            // Silent — best effort
        }
    }

    /**
     * Fast poll — fires critical accept commands directly.
     * Runs at double speed to catch approval prompts immediately.
     */
    private async fastPoll(): Promise<void> {
        if (!this.isRunning || this.isDisposed) { return; }
        if (!(await this.checkPaywallLimit())) { return; }

        for (const cmd of this.criticalAcceptCommands) {
            if (this.isDisposed || !this.isRunning) { break; }
            try {
                await vscode.commands.executeCommand(cmd);
            } catch {
                // Not applicable — ignore
            }
        }
    }

    /**
     * Full poll — fires all accept commands including focus-aware accept
     * and secondary commands.
     */
    private async fullPoll(): Promise<void> {
        if (this.isPollInProgress || !this.isRunning || this.isDisposed) {
            return;
        }

        if (!(await this.checkPaywallLimit())) { return; }

        this.isPollInProgress = true;

        try {
            // First: focus-aware accept (the key strategy)
            await this.focusAndAccept();

            // Then: fire critical commands directly (some may work without focus)
            for (const cmd of this.criticalAcceptCommands) {
                if (this.isDisposed || !this.isRunning) { break; }
                try {
                    await vscode.commands.executeCommand(cmd);
                } catch {
                    // Not applicable
                }
            }

            // Then secondary commands
            for (const cmd of this.secondaryAcceptCommands) {
                if (this.isDisposed || !this.isRunning) { break; }
                try {
                    await vscode.commands.executeCommand(cmd);
                } catch {
                    // Not applicable
                }
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`Poll error: ${msg}`);
        } finally {
            this.isPollInProgress = false;
        }
    }

    // ── Strategy 3: Notification Interception ─────────────

    private startNotificationPolling(): void {
        if (this.isDisposed) { return; }

        // Aggressively try to accept notification primary actions
        // This catches "Run", "Allow", "Yes", "Accept" buttons on notifications
        this.notificationPollInterval = setInterval(async () => {
            if (!this.isRunning || this.isDisposed) { return; }
            if (!(await this.checkPaywallLimit())) { return; }

            try {
                // Try accepting the primary action on any visible notification
                await vscode.commands.executeCommand('notification.acceptPrimaryAction');
            } catch {
                // No notification to accept
            }

            try {
                // Also try the notifications (plural) variant
                await vscode.commands.executeCommand('notifications.acceptPrimaryAction');
            } catch {
                // No notification
            }
        }, 400); // Very fast — catch notifications before user has to click

        this.log('Notification interception started (400ms interval).');
    }

    // ── Strategy 4: Event-Driven Reactions ─────────────────

    private setupEventTracking(): void {
        // React to terminal activity — when a new terminal execution starts,
        // immediately try to accept any pending terminal command approvals
        if (vscode.window.onDidStartTerminalShellExecution) {
            this.trackingDisposables.push(
                vscode.window.onDidStartTerminalShellExecution(async (e) => {
                    if (!this.isRunning) { return; } // Only proceed if running

                    const commandLine = (e.execution.commandLine.value || '').trim();
                    if (!commandLine) return;

                    // Check block list with word boundaries
                    const config = vscode.workspace.getConfiguration('autoAcceptAgent');
                    const blockedCommands = config.get<string[]>('blockedCommands', []);

                    for (const blocked of blockedCommands) {
                        if (!blocked) continue;
                        try {
                            // Match the blocked term as a whole word
                            const escapedBlocked = blocked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            const regex = new RegExp(`(^|\\s|['"])${escapedBlocked}($|\\s|['"])`, 'i');
                            if (regex.test(commandLine)) {
                                this.log(`🚨 BLOCKED dangerous command: "${commandLine}" (matched item in block list: "${blocked}")`);
                                vscode.window.showWarningMessage(`AutoAccept-Antigravity: Blocked dangerous command "${blocked}"`);
                                return;
                            }
                        } catch (err) {
                            // Fallback to simple include if regex fails
                            if (commandLine.toLowerCase().includes(blocked.toLowerCase())) {
                                this.log(`🚨 BLOCKED dangerous command (Fallback): "${commandLine}"`);
                                return;
                            }
                        }
                    }

                    this.executedCount++;
                    this.lastActivity = commandLine;
                    this.log(`✅ Terminal command approved: ${commandLine}`);
                    // Immediately fire accept commands
                    await this.fastPoll();
                })
            );
        }

        // React to active editor changes — when focus moves (e.g., to a diff view),
        // immediately accept any pending edits
        this.trackingDisposables.push(
            vscode.window.onDidChangeActiveTextEditor(async () => {
                if (this.isRunning && !this.isDisposed) {
                    // Small delay to let the UI update, then accept
                    setTimeout(async () => {
                        try {
                            await vscode.commands.executeCommand('antigravity.agent.acceptAgentStep');
                        } catch {
                            // Not applicable
                        }
                    }, 200);
                }
            })
        );

        // React to visible text editor changes (split views, diffs opening)
        this.trackingDisposables.push(
            vscode.window.onDidChangeVisibleTextEditors(async () => {
                if (this.isRunning && !this.isDisposed) {
                    setTimeout(async () => {
                        try {
                            await vscode.commands.executeCommand('antigravity.agent.acceptAgentStep');
                        } catch {
                            // Not applicable
                        }
                    }, 300);
                }
            })
        );

        // React to terminal changes (new terminal created for running a command)
        this.trackingDisposables.push(
            vscode.window.onDidOpenTerminal(async () => {
                if (this.isRunning && !this.isDisposed) {
                    this.log('New terminal opened — attempting acceptance...');
                    setTimeout(async () => {
                        try {
                            await vscode.commands.executeCommand('antigravity.terminalCommand.accept');
                            await vscode.commands.executeCommand('antigravity.terminalCommand.run');
                            await vscode.commands.executeCommand('workbench.action.terminal.chat.runCommand');
                            await vscode.commands.executeCommand('notification.acceptPrimaryAction');
                        } catch {
                            // Not applicable
                        }
                    }, 300);
                }
            })
        );

        // Track text document saves (can indicate an apply/accept cycle completing)
        this.trackingDisposables.push(
            vscode.workspace.onDidSaveTextDocument((doc) => {
                if (this.isRunning) {
                    this.executedCount++;
                    this.lastActivity = `Saved ${doc.fileName.split(/[\\/]/).pop()}`;
                }
            })
        );

        // Track text document edits
        this.trackingDisposables.push(
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (this.isRunning && e.contentChanges.length > 0) {
                    // Do not increment executedCount here as it triggers on every keystroke
                    this.lastActivity = `Edited ${e.document.fileName.split(/[\\/]/).pop()}`;
                }
            })
        );

        this.log('Event-driven tracking started (terminal, editor, notifications).');
    }

    // ── Polling Control ───────────────────────────────────

    private stopAllPolling(): void {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        if (this.fastPollInterval) {
            clearInterval(this.fastPollInterval);
            this.fastPollInterval = null;
        }
        if (this.notificationPollInterval) {
            clearInterval(this.notificationPollInterval);
            this.notificationPollInterval = null;
        }
        if (this.cdpIntervalId) {
            clearInterval(this.cdpIntervalId);
            this.cdpIntervalId = null;
        }
    }

    // ── Strategy 5: CDP Fallback ──────────────────────────

    private startCDPPolling(): void {
        const config = vscode.workspace.getConfiguration('autoAcceptAgent');
        const enableCDP = config.get<boolean>('enableCDP', true); // enabled by default as fallback
        if (!enableCDP) {
            this.log('CDP Fallback polling is disabled in settings.');
            return;
        }

        this.cdpIntervalId = setInterval(() => {
            this.checkPermissionButtons();
        }, 1500); // Check every 1.5s
        this.log('CDP Fallback polling started (1500ms cycle).');
    }

    private async checkPermissionButtons(): Promise<void> {
        if (!this.isRunning || this.isDisposed || this.isCdpBusy) return;
        if (!(await this.checkPaywallLimit())) return;

        this.isCdpBusy = true;

        const config = vscode.workspace.getConfiguration('autoAcceptAgent');
        const customTexts = config.get<string[]>('customButtonTexts', []);

        const scriptGenerator = (canExpand: boolean) => {
            const blockedCommands = config.get<string[]>('blockedCommands', []);
            return `var CAN_EXPAND = ${canExpand};\nvar BLOCKED_CMDS = ${JSON.stringify(blockedCommands)};\n` + this.buildPermissionScript(customTexts);
        };

        try {
            const portsToScan = this.activeCdpPort ? [this.activeCdpPort, ...this.CDP_PORTS.filter(p => p !== this.activeCdpPort)] : this.CDP_PORTS;

            for (const port of portsToScan) {
                const connected = await this.multiplexCdpWebviews(port, scriptGenerator);

                if (connected) {
                    this.activeCdpPort = port;
                    this.isCdpBusy = false;
                    return;
                } else if (port === this.activeCdpPort) {
                    this.activeCdpPort = null;
                }
            }
        } catch (e) { /* silent */ }
        finally {
            this.isCdpBusy = false;
        }
    }

    private cdpGetBrowserWsUrl(port: number): Promise<string | null> {
        return new Promise((resolve, reject) => {
            const req = http.get({ hostname: '127.0.0.1', port, path: '/json/version', timeout: 800 }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const info = JSON.parse(data);
                        resolve(info.webSocketDebuggerUrl || null);
                    } catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
    }

    private multiplexCdpWebviews(port: number, scriptGenerator: (canExpand: boolean) => string): Promise<boolean> {
        return new Promise(async (resolve) => {
            try {
                const browserWsUrl = await this.cdpGetBrowserWsUrl(port);
                if (!browserWsUrl) return resolve(false);

                const ws = new WebSocket(browserWsUrl);
                const timeout = setTimeout(() => { ws.close(); resolve(false); }, 5000);

                let msgId = 1;
                const pending: Record<number, { res: (v: any) => void; rej: (err: any) => void }> = {};

                function send(method: string, params: any = {}, sessionId: string | null = null): Promise<any> {
                    return new Promise((res, rej) => {
                        const id = msgId++;
                        const timer = setTimeout(() => { delete pending[id]; rej(new Error('timeout')); }, 2000);
                        pending[id] = { res: (v) => { clearTimeout(timer); res(v); }, rej };
                        const payload: any = { id, method, params };
                        if (sessionId) payload.sessionId = sessionId;
                        ws.send(JSON.stringify(payload));
                    });
                }

                ws.on('message', (raw) => {
                    const msg = JSON.parse(raw.toString());
                    if (msg.id && pending[msg.id]) {
                        pending[msg.id].res(msg);
                        delete pending[msg.id];
                    }
                });

                ws.on('error', () => { clearTimeout(timeout); resolve(false); });

                ws.on('open', async () => {
                    try {
                        await send('Target.setDiscoverTargets', { discover: true });
                        const targetsMsg = await send('Target.getTargets');
                        const allTargets = targetsMsg.result?.targetInfos || [];

                        this.cdpCycleCount++;
                        const isStatusCycle = (this.cdpCycleCount % 20 === 0);

                        const webviews = allTargets.filter((t: any) =>
                            t.url && (
                                t.url.includes('vscode-webview://') ||
                                t.url.includes('webview') ||
                                t.type === 'iframe'
                            )
                        );
                        const pageTargets = allTargets.filter((t: any) => t.type === 'page');

                        if (isStatusCycle) this.log(`[CDP] Status: ${allTargets.length} targets, ${pageTargets.length} pages, ${webviews.length} webviews (port ${port})`);

                        const allEvalTargets = [
                            ...webviews.map((t: any) => ({ ...t, kind: 'Webview' })),
                            ...pageTargets.map((t: any) => ({ ...t, kind: 'Page' }))
                        ];

                        const evalPromises = allEvalTargets.map(async (target: any) => {
                            try {
                                const targetId = target.targetId;
                                const shortId = targetId.substring(0, 6);
                                const kind = target.kind;

                                const attachMsg = await send('Target.attachToTarget', { targetId, flatten: true });
                                const sessionId = attachMsg.result?.sessionId;
                                if (!sessionId) return;

                                if (kind === 'Page') {
                                    const domCheck = await send('Runtime.evaluate', {
                                        expression: 'typeof document !== "undefined" ? document.title || "has-dom" : "no-dom"'
                                    }, sessionId);
                                    const domResult = domCheck.result?.result?.value;
                                    if (!domResult || domResult === 'no-dom') {
                                        await send('Target.detachFromTarget', { sessionId }).catch(() => { });
                                        return;
                                    }
                                }

                                const now = Date.now();
                                const canExpand = !this.lastExpandTimes[targetId] || (now - this.lastExpandTimes[targetId] >= 8000);
                                const dynamicScript = scriptGenerator(canExpand);

                                const evalMsg = await send('Runtime.evaluate', { expression: dynamicScript }, sessionId);
                                const result = evalMsg.result?.result?.value;

                                if (result && typeof result === 'string' && result.startsWith('clicked:')) {
                                    if (result.includes('expand') || result.includes('requires input')) {
                                        this.lastExpandTimes[targetId] = Date.now();
                                    }
                                    this.log(`[CDP] \u2713 Thread [${shortId}] -> ${result}`);
                                } else if (isStatusCycle) {
                                    // limit logging noise
                                    if (result && result !== 'not-agent-panel' && result !== 'no-permission-button') {
                                        this.log(`[CDP] ${kind} [${shortId}] -> ${result} (url: ${(target.url || '').substring(0, 60)})`);
                                    }
                                }

                                await send('Target.detachFromTarget', { sessionId }).catch(() => { });
                            } catch (e) { /* silent */ }
                        });

                        await Promise.allSettled(evalPromises);

                        clearTimeout(timeout);
                        ws.close();
                        resolve(true);
                    } catch (e) {
                        clearTimeout(timeout); ws.close(); resolve(false);
                    }
                });
            } catch (e) { resolve(false); }
        });
    }

    private buildPermissionScript(customTexts: string[]): string {
        const allTexts = [
            'run', 'accept',
            'always allow', 'allow this conversation', 'allow',
            ...customTexts
        ];
        return `
(function() {
    var BUTTON_TEXTS = ${JSON.stringify(allTexts)};
    var BLOCKED_COMMANDS = typeof BLOCKED_CMDS !== 'undefined' ? BLOCKED_CMDS : [];

    if (!document.querySelector('.react-app-container') && 
        !document.querySelector('[class*="agent"]') &&
        !document.querySelector('[data-vscode-context]')) {
        return 'not-agent-panel';
    }
    
    function closestClickable(node) {
        var el = node;
        while (el && el !== document.body) {
            var tag = (el.tagName || '').toLowerCase();
            if (tag === 'button' || tag.includes('button') || tag.includes('btn') ||
                el.getAttribute('role') === 'button' || el.classList.contains('cursor-pointer') ||
                el.onclick || el.getAttribute('tabindex') === '0') {
                return el;
            }
            el = el.parentElement;
        }
        return node;
    }
    
    function findButton(root, text) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        var node;
        while ((node = walker.nextNode())) {
            if (node.shadowRoot) {
                var result = findButton(node.shadowRoot, text);
                if (result) return result;
            }
            var testId = (node.getAttribute('data-testid') || node.getAttribute('data-action') || '').toLowerCase();
            if (testId.includes('alwaysallow') || testId.includes('always-allow') || testId.includes('allow')) {
                var tag1 = (node.tagName || '').toLowerCase();
                if (tag1 === 'button' || tag1.includes('button') || node.getAttribute('role') === 'button' || tag1.includes('btn')) {
                    return node;
                }
            }
            var nodeText = (node.textContent || '').trim().toLowerCase();
            if (nodeText.length > 50) continue;
            var isMatch = nodeText === text || 
                (text.length >= 5 && nodeText.startsWith(text) && nodeText.length <= text.length * 3);
            if (isMatch) {
                var clickable = closestClickable(node);
                var tag2 = (clickable.tagName || '').toLowerCase();
                if (tag2 === 'button' || tag2.includes('button') || clickable.getAttribute('role') === 'button' || 
                    tag2.includes('btn') || clickable.classList.contains('cursor-pointer') ||
                    clickable.onclick || clickable.getAttribute('tabindex') === '0' ||
                    text === 'expand' || text === 'requires input') {
                    if (clickable.disabled || clickable.getAttribute('aria-disabled') === 'true' ||
                        clickable.classList.contains('loading') || clickable.querySelector('.codicon-loading')) {
                        return null;
                    }

                    // SAFETY CHECK: When clicking "Run" or "Accept", check for blocked commands nearby in the UI text
                    if (text === 'run' || text === 'accept') {
                        // Look for the code block or command text near the button (container-aware)
                        var container = clickable.parentElement;
                        // Try to find a reasonably small container that might have the command
                        for (var depth = 0; depth < 4; depth++) {
                            if (!container || container === document.body) break;
                            var cClass = (container.className || '');
                            if (typeof cClass === 'string' && (cClass.includes('step') || cClass.includes('chat') || cClass.includes('response'))) break;
                            container = container.parentElement;
                        }
                        
                        var containerText = (container || document.body).innerText || '';
                        for (var i = 0; i < BLOCKED_COMMANDS.length; i++) {
                            var bCmd = BLOCKED_COMMANDS[i];
                            if (!bCmd) continue;
                            
                            // Use a simpler string check within the container context to avoid complex regex issues in CDP
                            // We check for the word with boundaries manually
                            var lowerText = containerText.toLowerCase();
                            var lowerCmd = bCmd.toLowerCase();
                            var idx = lowerText.indexOf(lowerCmd);
                            
                            if (idx !== -1) {
                                // Basic word boundary check
                                var charBefore = idx > 0 ? lowerText[idx - 1] : ' ';
                                var charAfter = (idx + lowerCmd.length) < lowerText.length ? lowerText[idx + lowerCmd.length] : ' ';
                                
                                var isWordBefore = /[a-z0-9]/.test(charBefore);
                                var isWordAfter = /[a-z0-9]/.test(charAfter);
                                
                                if (!isWordBefore && !isWordAfter) {
                                    return 'blocked:' + bCmd;
                                }
                            }
                        }
                    }

                    var lastClickTime = parseInt(clickable.getAttribute('data-aa-t') || '0', 10);
                    if (lastClickTime && (Date.now() - lastClickTime < 5000)) {
                        return null;
                    }
                    return clickable;
                }
            }
        }
        return null;
    }
    
    for (var t = 0; t < BUTTON_TEXTS.length; t++) {
        var btn = findButton(document.body, BUTTON_TEXTS[t]);
        if (btn) {
            btn.setAttribute('data-aa-t', '' + Date.now());
            btn.click();
            return 'clicked:' + BUTTON_TEXTS[t];
        }
    }
    
    if (typeof CAN_EXPAND === 'undefined' || CAN_EXPAND) {
        var expandTexts = ['expand', 'requires input'];
        for (var e = 0; e < expandTexts.length; e++) {
            var expBtn = findButton(document.body, expandTexts[e]);
            if (expBtn) {
                expBtn.setAttribute('data-aa-t', '' + Date.now());
                expBtn.click();
                return 'clicked:' + expandTexts[e];
            }
        }
    }
    return 'no-permission-button';
})()
`;
    }

    // ── Status Bar ─────────────────────────────────────────

    private updateStatusBar(state: 'on' | 'off'): void {
        if (this.isDisposed || !this.statusBarItem) { return; }

        try {
            switch (state) {
                case 'on':
                    this.statusBarItem.text = '$(zap) Auto Accept: ON';
                    this.statusBarItem.tooltip =
                        `Auto Accept is ACTIVE\n` +
                        `• Settings auto-configured\n` +
                        `• Command polling: fast + full\n` +
                        `• Notification interception: ON\n` +
                        `• Event tracking: ON\n` +
                        `Click to stop.`;
                    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
                    break;
                case 'off':
                    this.statusBarItem.text = '$(x) Auto Accept: OFF';
                    this.statusBarItem.tooltip = 'Auto Accept is stopped. Click to start.';
                    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                    break;
                default:
                    this.statusBarItem.text = '$(x) Auto Accept: OFF';
                    this.statusBarItem.tooltip = 'Auto Accept is in an unknown state.';
                    break;
            }
            this.statusBarItem.show();
        } catch {
            // Status bar may have been disposed
        }
    }

    // ── Cleanup ────────────────────────────────────────────

    private disposeTracking(): void {
        for (const d of this.trackingDisposables) {
            try { d.dispose(); } catch { /* best-effort */ }
        }
        this.trackingDisposables = [];
    }

    // ── Logging ────────────────────────────────────────────

    private log(message: string): void {
        if (this.isDisposed) { return; }
        try {
            const timestamp = new Date().toISOString();
            this.outputChannel?.appendLine(`[${timestamp}] ${message}`);
            console.log(`[AutoAccept] [${timestamp}] ${message}`);
        } catch {
            // Output channel may have been disposed
        }
    }
}
