import * as vscode from 'vscode';
import { CommandAcceptor } from './commandAcceptor';

/**
 * Settings that we manage for auto-approval.
 * Each entry: [section, key, valueWhenOn]
 *
 * These are the VS Code built-in settings that control whether the AI agent
 * (Copilot, Gemini, etc.) can run tools, terminal commands, and file edits
 * without showing a confirmation dialog ("Run" button).
 */
const AUTO_APPROVE_SETTINGS: Array<[string, string, unknown]> = [
    // Master switch: auto-approve all tool invocations
    ['chat.tools', 'autoApprove', true],
    // Global auto-approve (all workspaces, all tools, all terminal commands)
    ['chat.tools.global', 'autoApprove', true],
    // Terminal command auto-approval
    ['chat.tools.terminal', 'enableAutoApprove', true],
    ['chat.tools.terminal', 'autoApprove', true],
    // File edit auto-approval
    ['chat.tools.edits', 'autoApprove', true],
    // Increase max agent requests to reduce "Continue?" prompts
    ['chat.agent', 'maxRequests', 100],
];


export class AutoAcceptor implements vscode.Disposable {
    private isRunning = false;
    private isDisposed = false;
    private statusBarItem: vscode.StatusBarItem;
    private outputChannel: vscode.OutputChannel;
    private commandAcceptor: CommandAcceptor;

    /** Saved original values so we can restore on stop/dispose. */
    private savedSettings = new Map<string, unknown>();

    constructor(statusBarItem: vscode.StatusBarItem, outputChannel: vscode.OutputChannel) {
        if (!statusBarItem || !outputChannel) {
            throw new Error('AutoAcceptor requires both a StatusBarItem and an OutputChannel.');
        }

        this.statusBarItem = statusBarItem;
        this.outputChannel = outputChannel;
        this.commandAcceptor = new CommandAcceptor(outputChannel);
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

            // Save current settings and apply auto-approval
            await this.applyAutoApproveSettings();

            this.isRunning = true;
            this.updateStatusBar('on');
            this.commandAcceptor.start();

            vscode.window.showInformationMessage(
                'AutoAccept-Antigravity: Active — all agent actions will be auto-approved. No launch flags needed!'
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
            this.commandAcceptor.stop();
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

        try { this.commandAcceptor.dispose(); } catch { /* best-effort */ }
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
