import * as vscode from 'vscode';
import { findBlockedPattern } from './blocked';
import { inspectCommand } from './scriptInspector';
import {
    DEFAULT_BLOCKED_COMMANDS,
    ENABLED_STATE_KEY,
    TERMINAL_BLOCK_PAUSE_MS,
    acceptNowCommands,
    criticalAcceptCommands,
    editAutoApproveSettings,
    isRunAcceptCommand,
    runAcceptCommands,
    secondaryAcceptCommands,
    terminalAutoApproveSettings,
} from './catalog';
import { CdpFallback } from './cdpFallback';
import { SettingsGuard } from './settingsGuard';

export interface StartOptions {
    /** Skip the "Running" toast. Used when resuming a saved choice at startup. */
    quiet?: boolean;
}

export interface StopOptions {
    /** Show the "Stopped" toast. Defaults to true. */
    notify?: boolean;
    /** Remember off for the next launch. Defaults to true. Shutdown passes false. */
    persistOff?: boolean;
}

/**
 * Orchestrates settings, command polling, editor events, and the optional CDP fallback.
 */
export class AutoAcceptor implements vscode.Disposable {
    private isRunning = false;
    private isDisposed = false;
    private isStarting = false;
    private isFastPollInProgress = false;
    private isFullPollInProgress = false;
    private startGeneration = 0;
    private terminalAcceptPausedUntil = 0;
    private blindAcceptWarningLogged = false;
    private lastUserInteractionTime = 0;
    private pollInterval: ReturnType<typeof setInterval> | null = null;
    private fastPollInterval: ReturnType<typeof setInterval> | null = null;
    private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();
    private readonly trackingDisposables: vscode.Disposable[] = [];
    private readonly lifetimeDisposables: vscode.Disposable[] = [];
    private readonly settings: SettingsGuard;
    private readonly cdp: CdpFallback;

    private readonly userInteractionGraceMs = 1500;

    constructor(
        private readonly statusBarItem: vscode.StatusBarItem,
        private readonly outputChannel: vscode.OutputChannel,
        private readonly context: vscode.ExtensionContext,
    ) {
        this.settings = new SettingsGuard(context, (message) => this.log(message));
        this.cdp = new CdpFallback({
            isActive: () => this.isRunning && !this.isDisposed && !this.isTerminalPaused(),
            enabled: () => this.cdpEnabled(),
            port: () => this.cdpPort(),
            log: (message) => this.log(message),
            blockedCommands: () => this.blockedCommands(),
            customButtonTexts: () => this.customButtonTexts(),
            interceptLooseButtons: () => this.interceptLooseButtons(),
            workspaceRoots: () => this.workspaceFolders(),
            unknownScriptPolicy: () => vscode.workspace.getConfiguration('autoAcceptAgent').get<'warn' | 'block'>('unknownScriptPolicy', 'warn'),
        });

        this.lifetimeDisposables.push(vscode.workspace.onDidChangeConfiguration((event) => {
            if (this.isDisposed || !this.isRunning || !event.affectsConfiguration('autoAcceptAgent')) {
                return;
            }
            this.startCommandPolling();
            this.cdp.start();
        }));

        this.updateStatusBar('off');
    }

    async recover(): Promise<void> {
        await this.settings.recover();
    }

    async toggle(): Promise<void> {
        if (this.isDisposed) {
            return;
        }
        if (this.isRunning) {
            await this.stop();
        } else {
            await this.start();
        }
    }

    async start(options?: StartOptions): Promise<void> {
        if (this.isDisposed || this.isRunning || this.isStarting) {
            return;
        }

        const generation = ++this.startGeneration;
        const quiet = options?.quiet === true;
        this.isStarting = true;

        try {
            if (this.autoConfigureSettings()) {
                const safeForTerminal = this.allowBlindTerminalAccept();
                const settingsToApply = safeForTerminal
                    ? [...editAutoApproveSettings, ...terminalAutoApproveSettings]
                    : [...editAutoApproveSettings];
                await this.settings.apply(settingsToApply);
                if (!safeForTerminal) {
                    this.log(
                        'Terminal auto-approve settings NOT applied (allowBlindTerminalAccept is off). ' +
                        'Terminal commands will be approved via CDP (with script inspection) or require manual approval.',
                    );
                }
            }
            if (this.isDisposed || generation !== this.startGeneration) {
                await this.settings.restore();
                return;
            }

            this.isRunning = true;
            await this.context.globalState.update(ENABLED_STATE_KEY, true);
            this.startCommandPolling();
            this.setupEventTracking();
            this.cdp.start();
            this.updateStatusBar('on');
            if (!quiet) {
                void vscode.window.showInformationMessage('AutoAccept-Antigravity: Running');
            }
            this.log(quiet ? 'resumed' : 'started');
        } catch (err: unknown) {
            this.isRunning = false;
            this.startGeneration++;
            this.stopCommandPolling();
            this.clearPendingTimers();
            this.cdp.stop();
            this.disposeTracking();
            await this.settings.restore().catch(() => undefined);
            this.updateStatusBar('off');
            const message = errorMessage(err);
            this.log(`start failed: ${message}`);
            if (!quiet) {
                void vscode.window.showErrorMessage(`AutoAccept-Antigravity: start failed: ${message}`);
            }
        } finally {
            this.isStarting = false;
        }
    }

    async stop(options?: StopOptions): Promise<void> {
        if (this.isDisposed) {
            return;
        }

        // Halt all activity immediately before persisting state or restoring settings,
        // so a persistence or restoration error cannot leave polling/CDP running.
        const wasRunning = this.isRunning;
        this.isRunning = false;
        this.startGeneration++;
        this.stopCommandPolling();
        this.clearPendingTimers();
        this.cdp.stop();
        this.disposeTracking();

        const notify = options?.notify !== false;
        const persistOff = options?.persistOff !== false;
        if (persistOff) {
            try {
                await this.context.globalState.update(ENABLED_STATE_KEY, false);
            } catch (err: unknown) {
                this.log(`Failed to persist stopped state: ${errorMessage(err)}`);
            }
        }

        if (!wasRunning) {
            this.updateStatusBar('off');
            return;
        }

        try {
            const res = await this.settings.restore();
            this.updateStatusBar('off');
            if (res.remaining > 0) {
                this.log(`Warning: ${res.remaining} setting(s) could not be restored automatically.`);
                if (notify) {
                    void vscode.window.showWarningMessage(`AutoAccept: Stopped, but ${res.remaining} setting(s) could not be restored.`);
                }
            } else {
                if (notify) {
                    void vscode.window.showInformationMessage('AutoAccept-Antigravity: Stopped');
                }
                this.log('stopped');
            }
        } catch (err: unknown) {
            this.updateStatusBar('off');
            this.log(`stop error: ${errorMessage(err)}`);
        }
    }

    dispose(): void {
        if (this.isDisposed) {
            return;
        }
        this.isDisposed = true;
        this.isRunning = false;
        this.startGeneration++;
        this.stopCommandPolling();
        this.clearPendingTimers();
        this.cdp.stop();
        this.disposeTracking();
        for (const disposable of this.lifetimeDisposables) {
            disposable.dispose();
        }
        this.lifetimeDisposables.length = 0;

        void this.settings.restore()
            .catch((err: unknown) => {
                this.log(`settings restore failed: ${errorMessage(err)}`);
            })
            .finally(() => {
                this.statusBarItem.dispose();
                this.outputChannel.dispose();
            });
    }

    private startCommandPolling(): void {
        this.stopCommandPolling();
        if (this.isDisposed || !this.isRunning) {
            return;
        }

        const config = vscode.workspace.getConfiguration('autoAcceptAgent');
        if (!config.get<boolean>('enableCommandPolling', true)) {
            this.log('Command polling is off. Events and CDP still follow their own settings.');
            return;
        }

        const intervalMs = clampInterval(config.get<number>('pollIntervalMs', 800));
        const fastMs = Math.max(200, Math.floor(intervalMs / 2));

        this.fastPollInterval = setInterval(() => {
            void this.fastPoll();
        }, fastMs);
        this.pollInterval = setInterval(() => {
            void this.fullPoll();
        }, intervalMs);
        this.log(`Command polling started: fast=${fastMs}ms, full=${intervalMs}ms`);
    }

    private async fastPoll(): Promise<void> {
        if (this.isFastPollInProgress || !this.isRunning || this.isDisposed || this.isUserInteracting()) {
            return;
        }
        this.isFastPollInProgress = true;
        try {
            await this.fireCommands(criticalAcceptCommands);
        } catch (err: unknown) {
            this.log(`Fast poll error: ${errorMessage(err)}`);
        } finally {
            this.isFastPollInProgress = false;
        }
    }

    private async fullPoll(): Promise<void> {
        if (this.isFullPollInProgress || !this.isRunning || this.isDisposed || this.isUserInteracting()) {
            return;
        }
        this.isFullPollInProgress = true;
        try {
            await this.fireCommands(secondaryAcceptCommands);
        } catch (err: unknown) {
            this.log(`Full poll error: ${errorMessage(err)}`);
        } finally {
            this.isFullPollInProgress = false;
        }
    }

    private async fireCommands(commands: readonly string[]): Promise<void> {
        for (const command of commands) {
            if (!this.isRunning || this.isDisposed || this.isUserInteracting()) {
                return;
            }
            if (isRunAcceptCommand(command) && !this.shouldFireRunAccept()) {
                continue;
            }
            try {
                await vscode.commands.executeCommand(command);
            } catch {
                // The command is not registered, or nothing is waiting for it.
            }
        }
    }

    /**
     * Whether run-accept commands (terminal / tool execution) should fire from polling.
     *
     * Returns false when:
     *  - Terminal acceptance is paused (a blocked command was just caught)
     *  - CDP is enabled and connected (CDP handles acceptance with its own blocklist check)
     *  - We have no visibility into the command text (CDP off + blind accept off)
     */
    private shouldFireRunAccept(): boolean {
        if (this.isTerminalPaused()) {
            return false;
        }
        // When CDP is enabled and connected, CDP handles terminal acceptance
        // with its own blocklist check via the page script.
        if (this.cdpEnabled() && this.cdp.isConnected()) {
            return false;
        }
        // When CDP is off or disconnected, we have no visibility into the
        // command text being approved. Only allow if explicitly opted in.
        if (!this.allowBlindTerminalAccept()) {
            if (!this.blindAcceptWarningLogged) {
                this.blindAcceptWarningLogged = true;
                this.log(
                    'Terminal auto-accept is disabled: CDP is off and allowBlindTerminalAccept is false. ' +
                    'Enable CDP (recommended) or set autoAcceptAgent.allowBlindTerminalAccept for terminal auto-accept.',
                );
            }
            return false;
        }
        return true;
    }

    private setupEventTracking(): void {
        this.disposeTracking();

        if (vscode.window.onDidStartTerminalShellExecution) {
            this.trackingDisposables.push(vscode.window.onDidStartTerminalShellExecution((event) => {
                if (!this.isRunning) {
                    return;
                }
                const commandLine = event.execution.commandLine?.value?.trim() ?? '';
                if (!commandLine) {
                    return;
                }

                // Phase 1: Direct blocklist check on the command text
                let blocked = findBlockedPattern(commandLine, this.blockedCommands());

                // Phase 3: Check if it invokes a script containing blocked patterns
                if (!blocked) {
                    try {
                        const policy = vscode.workspace.getConfiguration('autoAcceptAgent').get<'warn' | 'block'>('unknownScriptPolicy', 'warn');
                        const termCwd = (event.terminal as unknown as { shellIntegration?: { cwd?: { fsPath?: string } } })?.shellIntegration?.cwd?.fsPath;
                        blocked = inspectCommand(
                            commandLine,
                            this.workspaceFolders(),
                            this.blockedCommands(),
                            (msg) => this.log(msg),
                            { unknownScriptPolicy: policy },
                            termCwd,
                        );
                    } catch (err: unknown) {
                        this.log(`Script inspection error: ${errorMessage(err)}`);
                    }
                }

                if (!blocked) {
                    this.log(`Terminal command started: ${sanitizeCommandLine(commandLine)}`);
                    return;
                }

                this.pauseTerminalAccept(blocked);
                try {
                    event.terminal.sendText('\u0003', false);
                } catch {
                    // The shell can already be gone.
                }
                try {
                    event.terminal.dispose();
                } catch {
                    // Closing the terminal is best-effort.
                }
            }));
        }

        this.trackingDisposables.push(vscode.window.onDidChangeTextEditorSelection((event) => {
            if (event.kind === vscode.TextEditorSelectionChangeKind.Keyboard
                || event.kind === vscode.TextEditorSelectionChangeKind.Mouse) {
                this.lastUserInteractionTime = Date.now();
            }
        }));

        this.trackingDisposables.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (!this.isRunning || this.isDisposed) {
                return;
            }
            if (editor?.document.uri.scheme === 'file') {
                this.lastUserInteractionTime = Date.now();
                return;
            }
            this.delay(400, async () => {
                if (!this.isRunning || this.isDisposed || this.isUserInteracting()) {
                    return;
                }
                try {
                    await vscode.commands.executeCommand('antigravity.agent.acceptAgentStep');
                } catch {
                    // Nothing is waiting for this command.
                }
            });
        }));

        this.trackingDisposables.push(vscode.window.onDidChangeVisibleTextEditors(() => {
            if (!this.isRunning || this.isDisposed || this.isUserInteracting()) {
                return;
            }
            this.delay(500, async () => {
                if (!this.isRunning || this.isDisposed || this.isUserInteracting()) {
                    return;
                }
                try {
                    await vscode.commands.executeCommand('antigravity.agent.acceptAgentStep');
                } catch {
                    // Nothing is waiting for this command.
                }
            });
        }));

        this.trackingDisposables.push(vscode.window.onDidOpenTerminal(() => {
            if (!this.isRunning || this.isDisposed || this.isUserInteracting() || !this.shouldFireRunAccept()) {
                return;
            }
            this.delay(300, async () => {
                if (!this.isRunning || this.isDisposed || this.isUserInteracting()) {
                    return;
                }
                this.log('New terminal opened. Attempting acceptance.');
                await this.fireCommands(runAcceptCommands);
            });
        }));

        this.log('Event tracking started.');
    }

    private pauseTerminalAccept(pattern: string): void {
        this.terminalAcceptPausedUntil = Date.now() + TERMINAL_BLOCK_PAUSE_MS;
        const message = `AutoAccept-Antigravity: Attempted interruption of blocked command "${pattern}" and closed that terminal. Terminal auto-accept is paused for 60 seconds.`;
        this.log(message);
        void vscode.window.showWarningMessage(message);
    }

    private isTerminalPaused(): boolean {
        return Date.now() < this.terminalAcceptPausedUntil;
    }

    private isUserInteracting(): boolean {
        return (Date.now() - this.lastUserInteractionTime) < this.userInteractionGraceMs;
    }

    private delay(ms: number, work: () => Promise<void>): void {
        const timer = setTimeout(() => {
            this.pendingTimers.delete(timer);
            void work().catch((err: unknown) => {
                this.log(`Delayed task failed: ${errorMessage(err)}`);
            });
        }, ms);
        this.pendingTimers.add(timer);
    }

    private stopCommandPolling(): void {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        if (this.fastPollInterval) {
            clearInterval(this.fastPollInterval);
            this.fastPollInterval = null;
        }
    }

    private clearPendingTimers(): void {
        for (const timer of this.pendingTimers) {
            clearTimeout(timer);
        }
        this.pendingTimers.clear();
    }

    private disposeTracking(): void {
        for (const disposable of this.trackingDisposables) {
            disposable.dispose();
        }
        this.trackingDisposables.length = 0;
    }

    private blockedCommands(): readonly string[] {
        return vscode.workspace.getConfiguration('autoAcceptAgent').get<string[]>('blockedCommands', [...DEFAULT_BLOCKED_COMMANDS]);
    }

    private customButtonTexts(): readonly string[] {
        return vscode.workspace.getConfiguration('autoAcceptAgent').get<string[]>('customButtonTexts', []);
    }

    private interceptLooseButtons(): boolean {
        return vscode.workspace.getConfiguration('autoAcceptAgent').get<boolean>('interceptNotifications', true);
    }

    private autoConfigureSettings(): boolean {
        return vscode.workspace.getConfiguration('autoAcceptAgent').get<boolean>('autoConfigureSettings', true);
    }

    private cdpEnabled(): boolean {
        return vscode.workspace.getConfiguration('autoAcceptAgent').get<boolean>('enableCDP', false);
    }

    private cdpPort(): number {
        const value = vscode.workspace.getConfiguration('autoAcceptAgent').get<number>('cdpPort', 9222);
        if (!Number.isFinite(value) || value < 1 || value > 65535) {
            return 9222;
        }
        return Math.floor(value);
    }

    private allowBlindTerminalAccept(): boolean {
        return vscode.workspace.getConfiguration('autoAcceptAgent').get<boolean>('allowBlindTerminalAccept', false);
    }

    private workspaceFolders(): string[] {
        return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    }

    /**
     * Fires all accept commands once, respecting the same safety gates
     * as the polling loop. Run-accept commands are skipped when terminal
     * auto-accept is unsafe.
     */
    async acceptNow(): Promise<void> {
        if (this.isDisposed) {
            return;
        }
        for (const command of acceptNowCommands) {
            if (this.isDisposed) {
                return;
            }
            if (isRunAcceptCommand(command) && !this.shouldFireRunAccept()) {
                continue;
            }
            try {
                await vscode.commands.executeCommand(command);
            } catch {
                // The command is not registered, or nothing is waiting for it.
            }
        }
    }

    private updateStatusBar(state: 'on' | 'off'): void {
        if (this.isDisposed) {
            return;
        }
        try {
            if (state === 'on') {
                this.statusBarItem.text = '$(zap) Auto Accept: ON';
                this.statusBarItem.tooltip = 'Auto Accept is on. Click to stop.';
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
            } else {
                const hasPending = this.settings.hasPendingRestorations();
                if (hasPending) {
                    this.statusBarItem.text = '$(warning) Auto Accept: OFF (Settings warning)';
                    this.statusBarItem.tooltip = 'Auto Accept is off, but some settings could not be restored automatically. Check output.';
                } else {
                    this.statusBarItem.text = '$(x) Auto Accept: OFF';
                    this.statusBarItem.tooltip = 'Auto Accept is off. Click to start.';
                }
                this.statusBarItem.backgroundColor = undefined;
            }
            this.statusBarItem.show();
        } catch {
            // The status bar item can already be disposed during shutdown.
        }
    }

    private log(message: string): void {
        try {
            const line = `[${new Date().toISOString()}] ${message}`;
            this.outputChannel.appendLine(line);
            console.log(`[AutoAccept] ${line}`);
        } catch {
            // The output channel is closed during shutdown.
        }
    }
}

function clampInterval(value: number): number {
    if (!Number.isFinite(value)) {
        return 800;
    }
    return Math.min(10_000, Math.max(200, Math.floor(value)));
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function sanitizeCommandLine(cmd: string): string {
    return cmd
        .replace(/(Bearer\s+)[A-Za-z0-9_.\-]+/gi, '$1***')
        .replace(/(gh[pousr]_[A-Za-z0-9_]+)/gi, 'gh*_***')
        .replace(/(token|api[_-]?key|password|secret)[=:\s]+(["']?[^\s"']+["']?)/gi, '$1=***')
        .replace(/(https?:\/\/[^:]+:)[^@]+(@)/gi, '$1***$2');
}
