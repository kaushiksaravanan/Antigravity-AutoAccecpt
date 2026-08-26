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
 * Includes optional Chrome DevTools Protocol fallback for webview clicks,
 * but does not require launch flags in normal usage.
 */
export class AutoAcceptor implements vscode.Disposable {
    private isRunning = false;
    private isDisposed = false;
    private statusBarItem: vscode.StatusBarItem;
    private pollInterval: ReturnType<typeof setInterval> | null = null;
    private fastPollInterval: ReturnType<typeof setInterval> | null = null;

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
    private readonly originalGlobalSettings = new Map<string, {
        section: string;
        key: string;
        hadValue: boolean;
        value: unknown;
    }>();

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

    public async toggle(): Promise<void> {
        if (this.isDisposed) return;
        try {
            this.isRunning ? await this.stop() : await this.start();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`toggle error: ${msg}`);
        }
    }

    public async start(): Promise<void> {
        if (this.isDisposed || this.isRunning) return;
        if (!(await this.checkPaywallLimit())) return;

        const config = vscode.workspace.getConfiguration('autoAcceptAgent');
        if (!config.get<boolean>('enableCommandPolling', true)) {
            this.log('polling disabled');
            vscode.window.showWarningMessage('AutoAccept-Antigravity: Command polling disabled');
            return;
        }

        this.isRunning = true;

        if (config.get<boolean>('autoConfigureSettings', true)) {
            try {
                await this.applyAutoApproveSettings();
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                this.isRunning = false;
                this.updateStatusBar('off');
                this.log(`settings failed: ${msg}`);
                vscode.window.showErrorMessage(`AutoAccept start failed: ${msg}`);
                return;
            }
        }

        this.startCommandPolling();
        this.setupEventTracking();
        this.startCDPPolling();

        this.updateStatusBar('on');
        vscode.window.showInformationMessage('AutoAccept-Antigravity: Running');
        this.log('started');
    }

    public async stop(notifyUser = true): Promise<void> {
        if (this.isDisposed) return;

        try {
            this.log('stopping');
            this.isRunning = false;
            this.stopAllPolling();
            this.disposeTracking();
            await this.restoreOriginalSettings();
            this.updateStatusBar('off');
            if (notifyUser) vscode.window.showInformationMessage('AutoAccept-Antigravity: Stopped');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`stop error: ${msg}`);
            this.isRunning = false;
            this.updateStatusBar('off');
        }
    }

    public dispose(): void {
        if (this.isDisposed) return;
        this.isDisposed = true;
        this.isRunning = false;

        try { this.stopAllPolling(); } catch { }
        try { this.disposeTracking(); } catch { }

        void this.restoreOriginalSettings()
            .catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                try { console.error(`[AutoAccept] settings restore failed: ${msg}`); } catch { }
            })
            .finally(() => {
                try { this.statusBarItem?.dispose(); } catch { }
                try { this.outputChannel?.dispose(); } catch { }
            });
    }

    // ── Strategy 1: Settings Injection ────────────────────

    private getSettingId(section: string, key: string): string {
        return `${section}.${key}`;
    }

    private async applyAutoApproveSettings(): Promise<void> {
        if (this.settingsApplied) { return; }

        this.log('Applying auto-approve settings...');
        let applied = 0;
        let skipped = 0;

        for (const [section, key, value] of this.autoApproveSettings) {
            const settingId = this.getSettingId(section, key);
            try {
                const config = vscode.workspace.getConfiguration(section);
                const inspect = config.inspect(key);

                if (!this.originalGlobalSettings.has(settingId)) {
                    const hadValue = inspect?.globalValue !== undefined;
                    this.originalGlobalSettings.set(settingId, {
                        section,
                        key,
                        hadValue,
                        value: inspect?.globalValue,
                    });
                }

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

    private async restoreOriginalSettings(): Promise<void> {
        if (!this.settingsApplied) {
            return;
        }

        if (this.originalGlobalSettings.size === 0) {
            this.settingsApplied = false;
            return;
        }

        this.log('Restoring original auto-approve settings...');
        let restored = 0;
        let unchanged = 0;
        let failed = 0;

        for (const [settingId, snapshot] of this.originalGlobalSettings.entries()) {
            try {
                const config = vscode.workspace.getConfiguration(snapshot.section);
                const inspect = config.inspect(snapshot.key);
                const currentGlobal = inspect?.globalValue;
                const targetValue = snapshot.hadValue ? snapshot.value : undefined;

                if (currentGlobal !== targetValue) {
                    await config.update(snapshot.key, targetValue, vscode.ConfigurationTarget.Global);
                    this.log(`  Restored ${settingId} to ${JSON.stringify(targetValue)}`);
                    restored++;
                } else {
                    unchanged++;
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                this.log(`  Failed restoring ${settingId}: ${msg}`);
                failed++;
            }
        }

        this.originalGlobalSettings.clear();
        this.settingsApplied = false;
        this.log(`Settings restore complete: ${restored} restored, ${unchanged} unchanged, ${failed} failed.`);
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

        if (this.fastPollInterval) {
            clearInterval(this.fastPollInterval);
            this.fastPollInterval = null;
        }
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }

        // Fast poll for critical commands (accept agent steps, notifications)
        this.fastPollInterval = setInterval(() => {
            void this.fastPoll().catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                this.log(`Fast poll interval error: ${msg}`);
            });
        }, Math.max(200, intervalMs / 2));

        // Standard poll for all commands (includes focus-aware accept)
        this.pollInterval = setInterval(() => {
            void this.fullPoll().catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                this.log(`Full poll interval error: ${msg}`);
            });
        }, intervalMs);

        this.log(`Command polling started: fast=${Math.max(200, intervalMs / 2)}ms, full=${intervalMs}ms`);
    }

    private shouldInterceptNotifications(): boolean {
        const config = vscode.workspace.getConfiguration('autoAcceptAgent');
        return config.get<boolean>('interceptNotifications', true);
    }


    /**
     * Fast poll — fires critical accept commands directly.
     * Runs at double speed to catch approval prompts immediately.
     */
    private async fastPoll(): Promise<void> {
        if (!this.isRunning || this.isDisposed) { return; }
        if (!(await this.checkPaywallLimit())) { return; }
        const interceptNotifications = this.shouldInterceptNotifications();

        for (const cmd of this.criticalAcceptCommands) {
            if (this.isDisposed || !this.isRunning) { break; }
            if (!interceptNotifications && cmd.toLowerCase().includes('notification')) { continue; }
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
            // Fire secondary commands (critical ones are already handled by fastPoll)
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

    // Notification acceptance is handled by fastPoll (via criticalAcceptCommands)
    // — no separate notification polling timer needed.

    // ── Strategy 4: Event-Driven Reactions ─────────────────

    private setupEventTracking(): void {
        // React to terminal activity — when a new terminal execution starts,
        // immediately try to accept any pending terminal command approvals
        if (vscode.window.onDidStartTerminalShellExecution) {
            this.trackingDisposables.push(
                vscode.window.onDidStartTerminalShellExecution(async (e) => {
                    if (!this.isRunning) { return; } // Only proceed if running

                    const commandLine = (e?.execution?.commandLine?.value || '').trim();
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
                    setTimeout(() => {
                        void (async () => {
                            if (!this.isRunning || this.isDisposed) { return; }
                            try {
                                await vscode.commands.executeCommand('antigravity.agent.acceptAgentStep');
                            } catch {
                                // Not applicable
                            }
                        })().catch((err: unknown) => {
                            const msg = err instanceof Error ? err.message : String(err);
                            this.log(`Active editor reaction error: ${msg}`);
                        });
                    }, 200);
                }
            })
        );

        // React to visible text editor changes (split views, diffs opening)
        this.trackingDisposables.push(
            vscode.window.onDidChangeVisibleTextEditors(async () => {
                if (this.isRunning && !this.isDisposed) {
                    setTimeout(() => {
                        void (async () => {
                            if (!this.isRunning || this.isDisposed) { return; }
                            try {
                                await vscode.commands.executeCommand('antigravity.agent.acceptAgentStep');
                            } catch {
                                // Not applicable
                            }
                        })().catch((err: unknown) => {
                            const msg = err instanceof Error ? err.message : String(err);
                            this.log(`Visible editor reaction error: ${msg}`);
                        });
                    }, 300);
                }
            })
        );

        // React to terminal changes (new terminal created for running a command)
        this.trackingDisposables.push(
            vscode.window.onDidOpenTerminal(async () => {
                if (this.isRunning && !this.isDisposed) {
                    this.log('New terminal opened — attempting acceptance...');
                    setTimeout(() => {
                        void (async () => {
                            if (!this.isRunning || this.isDisposed) { return; }
                            const interceptNotifications = this.shouldInterceptNotifications();
                            const cmds = [
                                'antigravity.terminalCommand.accept',
                                'antigravity.terminalCommand.run',
                                'workbench.action.terminal.chat.runCommand',
                                'notification.acceptPrimaryAction',
                            ];
                            for (const cmd of cmds) {
                                if (!interceptNotifications && cmd.toLowerCase().includes('notification')) { continue; }
                                try {
                                    await vscode.commands.executeCommand(cmd);
                                } catch {
                                    // Not applicable
                                }
                            }
                        })().catch((err: unknown) => {
                            const msg = err instanceof Error ? err.message : String(err);
                            this.log(`Open terminal reaction error: ${msg}`);
                        });
                    }, 300);
                }
            })
        );

        // Track text document saves (informational only — does not count as an auto-accept action)
        this.trackingDisposables.push(
            vscode.workspace.onDidSaveTextDocument((doc) => {
                if (this.isRunning) {
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

        if (this.cdpIntervalId) {
            clearInterval(this.cdpIntervalId);
            this.cdpIntervalId = null;
        }
    }

    // ── Strategy 5: CDP Fallback ──────────────────────────

    private startCDPPolling(): void {
        if (this.isDisposed) return;
        const config = vscode.workspace.getConfiguration('autoAcceptAgent');
        const enableCDP = config.get<boolean>('enableCDP', false); // opt-in fallback
        if (!enableCDP) {
            this.log('CDP Fallback polling is disabled in settings.');
            return;
        }

        if (this.cdpIntervalId) {
            clearInterval(this.cdpIntervalId);
            this.cdpIntervalId = null;
        }

        this.cdpIntervalId = setInterval(() => {
            void this.checkPermissionButtons().catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                this.log(`CDP poll error: ${msg}`);
            });
        }, 1500); // Check every 1.5s
        this.log('CDP Fallback polling started (1500ms cycle).');
    }

    private async checkPermissionButtons(): Promise<void> {
        if (!this.isRunning || this.isDisposed || this.isCdpBusy) return;
        if (!(await this.checkPaywallLimit())) return;

        // Prune stale entries from lastExpandTimes to prevent unbounded growth
        const now = Date.now();
        for (const key of Object.keys(this.lastExpandTimes)) {
            if (now - this.lastExpandTimes[key] > 60000) {
                delete this.lastExpandTimes[key];
            }
        }

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
            let done = false;
            const end = (err: Error | null, val: string | null = null) => {
                if (done) return;
                done = true;
                err ? reject(err) : resolve(val);
            };

            const req = http.get({ hostname: '127.0.0.1', port, path: '/json/version', timeout: 800 }, (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    return end(new Error(`HTTP ${res.statusCode}`));
                }
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('error', (e) => end(e));
                res.on('end', () => {
                    try {
                        const info = JSON.parse(data);
                        end(null, info.webSocketDebuggerUrl || null);
                    } catch (e) {
                        end(e instanceof Error ? e : new Error(String(e)));
                    }
                });
            });
            req.on('error', (e) => end(e));
            req.on('timeout', () => { req.destroy(); end(new Error('timeout')); });
        });
    }

    private async multiplexCdpWebviews(port: number, scriptGenerator: (canExpand: boolean) => string): Promise<boolean> {
        try {
            const browserWsUrl = await this.cdpGetBrowserWsUrl(port);
            if (!browserWsUrl) return false;

            return await new Promise<boolean>((resolve) => {
                const ws = new WebSocket(browserWsUrl);
                let done = false;
                const end = (ok: boolean) => { if (!done) { done = true; resolve(ok); } };

                const timeout = setTimeout(() => { ws.close(); end(false); }, 5000);

                let msgId = 1;
                const pending: Record<number, { res: (v: any) => void; rej: (err: any) => void }> = {};

                function send(method: string, params: any = {}, sessionId: string | null = null): Promise<any> {
                    return new Promise((res, rej) => {
                        if (ws.readyState !== WebSocket.OPEN) {
                            return rej(new Error('WebSocket not open'));
                        }
                        const id = msgId++;
                        const timer = setTimeout(() => { delete pending[id]; rej(new Error('timeout')); }, 2000);
                        pending[id] = { res: (v) => { clearTimeout(timer); res(v); }, rej };
                        const payload: any = { id, method, params };
                        if (sessionId) payload.sessionId = sessionId;
                        try {
                            ws.send(JSON.stringify(payload));
                        } catch (err) {
                            clearTimeout(timer);
                            delete pending[id];
                            rej(err);
                        }
                    });
                }

                ws.on('message', (raw) => {
                    try {
                        const msg = JSON.parse(raw.toString());
                        if (msg.id && pending[msg.id]) {
                            pending[msg.id].res(msg);
                            delete pending[msg.id];
                        }
                    } catch {
                        // Malformed message — ignore
                    }
                });

                ws.on('error', () => { clearTimeout(timeout); end(false); });

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
                        end(true);
                    } catch (e) {
                        clearTimeout(timeout); ws.close(); end(false);
                    }
                });
            });
        } catch (e) { return false; }
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
            if (typeof btn === 'string') { return btn; }
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
                if (typeof expBtn === 'string') { return expBtn; }
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
        try {
            const timestamp = new Date().toISOString();
            this.outputChannel?.appendLine(`[${timestamp}] ${message}`);
            console.log(`[AutoAccept] [${timestamp}] ${message}`);
        } catch {
            // Output channel may have been disposed
        }
    }
}
