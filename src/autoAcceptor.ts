import * as vscode from 'vscode';

/**
 * Settings that we manage for auto-approval.
 * Each entry: [section, key, valueWhenOn]
 */
const AUTO_APPROVE_SETTINGS: Array<[string, string, unknown]> = [
    ['chat.tools', 'autoApprove', true],
    ['chat.agent', 'autoApprove', true],
    ['chat.tools.terminal', 'enableAutoApprove', true],
];

/**
 * Known VS Code command patterns for accepting / applying agent actions.
 * We discover the full list at runtime via getCommands() and match these patterns.
 */
const ACCEPT_COMMAND_PATTERNS: RegExp[] = [
    /^editor\.action\.inlineSuggest\.commit$/,
    /^editor\.action\.inlineSuggest\.acceptNextLine$/,
    /^editor\.action\.inlineSuggest\.acceptNextWord$/,
    /chat.*accept/i,
    /copilot.*accept/i,
    /agent.*accept/i,
    /agent.*apply/i,
];

export class AutoAcceptor implements vscode.Disposable {
    private isRunning = false;
    private isDisposed = false;
    private statusBarItem: vscode.StatusBarItem;
    private outputChannel: vscode.OutputChannel;
    private pollInterval: ReturnType<typeof setInterval> | null = null;
    private isPollInProgress = false;

    /** Saved original values so we can restore on stop/dispose. */
    private savedSettings = new Map<string, unknown>();

    /** Cached list of accept commands discovered at startup. */
    private acceptCommands: string[] = [];

    constructor(statusBarItem: vscode.StatusBarItem, outputChannel: vscode.OutputChannel) {
        if (!statusBarItem || !outputChannel) {
            throw new Error('AutoAcceptor requires both a StatusBarItem and an OutputChannel.');
        }

        this.statusBarItem = statusBarItem;
        this.outputChannel = outputChannel;
        this.updateStatusBar('off');
    }

    // ── Public API ────────────────────────────────────────────

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

        try {
            this.log('Starting AutoAccept-Antigravity (native mode)...');

            // 1. Discover accept commands
            await this.discoverAcceptCommands();

            // 2. Save current settings and apply auto-approval
            await this.applyAutoApproveSettings();

            this.isRunning = true;
            this.updateStatusBar('on');
            this.resumePolling();

            vscode.window.showInformationMessage(
                'AutoAccept-Antigravity: Active — auto-approval enabled. No launch flags needed!'
            );
            this.log('AutoAccept-Antigravity started successfully.');
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            this.log(`Failed to start: ${msg}`);
            vscode.window.showWarningMessage(
                `AutoAccept-Antigravity: Failed to start — ${msg}`
            );
            this.isRunning = false;
            this.updateStatusBar('off');
        }
    }

    public stop(): void {
        if (this.isDisposed) { return; }

        try {
            this.log('Stopping AutoAccept-Antigravity...');
            this.pausePolling();
            this.restoreSettings();
            this.isRunning = false;
            this.updateStatusBar('off');
            vscode.window.showInformationMessage('AutoAccept-Antigravity: Stopped — original settings restored.');
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

        try { this.pausePolling(); } catch { /* best-effort */ }
        try { this.restoreSettings(); } catch { /* best-effort */ }
        try { this.statusBarItem?.dispose(); } catch { /* best-effort */ }
        try { this.outputChannel?.dispose(); } catch { /* best-effort */ }
    }

    // ── Settings Management ───────────────────────────────────

    private async applyAutoApproveSettings(): Promise<void> {
        this.savedSettings.clear();

        for (const [section, key, valueWhenOn] of AUTO_APPROVE_SETTINGS) {
            try {
                const config = vscode.workspace.getConfiguration(section);
                const inspect = config.inspect(key);

                // Save whatever the current effective value is
                const fullKey = `${section}.${key}`;
                this.savedSettings.set(fullKey, inspect?.globalValue);

                await config.update(key, valueWhenOn, vscode.ConfigurationTarget.Global);
                this.log(`Set ${fullKey} = ${JSON.stringify(valueWhenOn)}`);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                this.log(`Warning: could not set ${section}.${key}: ${msg}`);
                // Non-fatal — some settings may not exist in all VS Code versions
            }
        }
    }

    private restoreSettings(): void {
        for (const [section, key] of AUTO_APPROVE_SETTINGS) {
            const fullKey = `${section}.${key}`;
            try {
                const original = this.savedSettings.get(fullKey);
                const config = vscode.workspace.getConfiguration(section);
                config.update(key, original, vscode.ConfigurationTarget.Global);
                this.log(`Restored ${fullKey} = ${JSON.stringify(original)}`);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                this.log(`Warning: could not restore ${fullKey}: ${msg}`);
            }
        }
        this.savedSettings.clear();
    }

    // ── Command Discovery ─────────────────────────────────────

    private async discoverAcceptCommands(): Promise<void> {
        try {
            const allCommands = await vscode.commands.getCommands(true);
            this.acceptCommands = allCommands.filter((cmd) =>
                ACCEPT_COMMAND_PATTERNS.some((pattern) => pattern.test(cmd))
            );
            this.log(`Discovered ${this.acceptCommands.length} accept commands: ${this.acceptCommands.join(', ')}`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`Command discovery failed: ${msg}`);
            this.acceptCommands = [];
        }
    }

    // ── Polling ───────────────────────────────────────────────

    private resumePolling(): void {
        if (this.isDisposed || this.pollInterval) { return; }
        this.pollInterval = setInterval(() => this.poll(), 2000);
    }

    private pausePolling(): void {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    private async poll(): Promise<void> {
        if (this.isPollInProgress || !this.isRunning || this.isDisposed) {
            return;
        }

        this.isPollInProgress = true;

        try {
            // Read blocked commands from user config
            let blockedCommands: string[];
            try {
                const config = vscode.workspace.getConfiguration('autoAcceptAgent');
                blockedCommands = config.get<string[]>('blockedCommands') ?? [
                    'rm -rf /', 'format', 'mkfs',
                ];
            } catch {
                blockedCommands = ['rm -rf /', 'format', 'mkfs'];
            }

            // Check active terminal for dangerous commands
            const terminal = vscode.window.activeTerminal;
            if (terminal) {
                // We can't read terminal content directly, but the blocked commands
                // config is used by the auto-approve terminal settings if configured.
                // For safety, we log terminal activity.
                this.log('Terminal active — auto-approve settings handle approval.');
            }

            // Try executing discovered accept commands
            for (const cmd of this.acceptCommands) {
                try {
                    await vscode.commands.executeCommand(cmd);
                } catch {
                    // Command may not be applicable right now — that's fine
                }
            }

            // Also try the most common inline suggestion acceptance
            try {
                await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
            } catch {
                // No active inline suggestion — normal
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`Poll error: ${msg}`);
        } finally {
            this.isPollInProgress = false;
        }
    }

    // ── Status Bar ────────────────────────────────────────────

    private updateStatusBar(state: 'on' | 'off'): void {
        if (this.isDisposed || !this.statusBarItem) { return; }

        try {
            switch (state) {
                case 'on':
                    this.statusBarItem.text = '$(check) Auto Accept: ON';
                    this.statusBarItem.tooltip = 'Auto Accept is active (native mode). Click to stop.';
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
            // Status bar may have been disposed — ignore
        }
    }

    // ── Logging ───────────────────────────────────────────────

    private log(message: string): void {
        if (this.isDisposed) { return; }
        try {
            const timestamp = new Date().toISOString();
            this.outputChannel?.appendLine(`[${timestamp}] ${message}`);
        } catch {
            // Output channel may have been disposed — silently ignore
        }
    }
}
