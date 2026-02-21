import * as vscode from 'vscode';
import { CDPClient } from './cdpClient';

export class AutoAcceptor implements vscode.Disposable {
    private cdp: CDPClient;
    private isRunning = false;
    private isDisposed = false;
    private statusBarItem: vscode.StatusBarItem;
    private pollInterval: ReturnType<typeof setInterval> | null = null;
    private outputChannel: vscode.OutputChannel;
    private isPollInProgress = false;

    constructor(statusBarItem: vscode.StatusBarItem, outputChannel: vscode.OutputChannel) {
        if (!statusBarItem || !outputChannel) {
            throw new Error('AutoAcceptor requires both a StatusBarItem and an OutputChannel.');
        }

        this.statusBarItem = statusBarItem;
        this.outputChannel = outputChannel;
        this.cdp = new CDPClient();

        // Wire up CDP event callbacks
        this.cdp.onLog((msg) => this.log(msg));

        this.cdp.onDisconnect(() => {
            if (this.isDisposed) { return; }
            this.log('Disconnected from CDP. Pausing polling...');
            this.pausePolling();
            this.updateStatusBar('reconnecting');
        });

        this.cdp.onReconnect(() => {
            if (this.isDisposed) { return; }
            this.log('Reconnected to CDP. Resuming polling.');
            vscode.window.showInformationMessage('AutoAccept-Antigravity: Reconnected to IDE UI.');
            this.resumePolling();
            this.updateStatusBar('on');
        });

        this.cdp.onReconnectFailed(() => {
            if (this.isDisposed) { return; }
            this.log('All reconnect attempts exhausted. Stopping.');
            vscode.window.showErrorMessage(
                'AutoAccept-Antigravity: Could not reconnect to IDE UI after multiple attempts. Please restart.'
            );
            this.isRunning = false;
            this.updateStatusBar('off');
        });

        this.updateStatusBar('off');
    }

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
            this.log('Connecting to CDP on port 9222...');
            await this.cdp.connect(9222);
            this.isRunning = true;
            this.updateStatusBar('on');
            this.resumePolling();
            vscode.window.showInformationMessage('AutoAccept-Antigravity: Connected to IDE UI.');
            this.log('AutoAccept-Antigravity started.');
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            this.log(`Failed to connect: ${msg}`);
            vscode.window.showWarningMessage(
                'AutoAccept-Antigravity: Failed to connect. Is VS Code launched with --remote-debugging-port=9222?'
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
            this.cdp.disconnect();
            this.isRunning = false;
            this.updateStatusBar('off');
            vscode.window.showInformationMessage('AutoAccept-Antigravity: Stopped.');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`Stop error: ${msg}`);
            // Force state to off even if cleanup had errors
            this.isRunning = false;
            this.updateStatusBar('off');
        }
    }

    public dispose(): void {
        if (this.isDisposed) { return; }
        this.isDisposed = true;

        try {
            this.pausePolling();
        } catch { /* best-effort */ }

        try {
            this.cdp.disconnect();
        } catch { /* best-effort */ }

        try {
            this.statusBarItem?.dispose();
        } catch { /* best-effort */ }

        try {
            this.outputChannel?.dispose();
        } catch { /* best-effort */ }
    }

    // ── Status Bar ─────────────────────────────────────────

    private updateStatusBar(state: 'on' | 'off' | 'reconnecting'): void {
        if (this.isDisposed || !this.statusBarItem) { return; }

        try {
            switch (state) {
                case 'on':
                    this.statusBarItem.text = '$(check) Auto Accept: ON';
                    this.statusBarItem.tooltip = 'Auto Accept is running. Click to stop.';
                    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
                    break;
                case 'off':
                    this.statusBarItem.text = '$(x) Auto Accept: OFF';
                    this.statusBarItem.tooltip = 'Auto Accept is stopped. Click to start.';
                    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                    break;
                case 'reconnecting':
                    this.statusBarItem.text = '$(sync~spin) Auto Accept: Reconnecting…';
                    this.statusBarItem.tooltip = 'Auto Accept lost connection. Attempting to reconnect…';
                    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                    break;
                default:
                    // Defensive: unknown state — fallback to off
                    this.statusBarItem.text = '$(x) Auto Accept: OFF';
                    this.statusBarItem.tooltip = 'Auto Accept is in an unknown state.';
                    break;
            }
            this.statusBarItem.show();
        } catch (err: unknown) {
            // Status bar may have been disposed — ignore
        }
    }

    // ── Polling ────────────────────────────────────────────

    private resumePolling(): void {
        if (this.isDisposed || this.pollInterval) { return; }
        this.pollInterval = setInterval(() => this.poll(), 1000);
    }

    private pausePolling(): void {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    private async poll(): Promise<void> {
        // Guard against overlapping polls, disposed state, or missing CDP
        if (this.isPollInProgress || !this.isRunning || this.isDisposed) {
            return;
        }
        if (!this.cdp || !this.cdp.isConnected) {
            return;
        }

        this.isPollInProgress = true;

        let blockedCommands: string[];
        try {
            const config = vscode.workspace.getConfiguration('autoAcceptAgent');
            blockedCommands = config.get<string[]>('blockedCommands') ?? [
                'rm -rf /', 'format', 'mkfs',
            ];
        } catch {
            blockedCommands = ['rm -rf /', 'format', 'mkfs'];
        }

        const script = `
            (function() {
                const blockedCmds = ${JSON.stringify(blockedCommands)};

                function findAllButtons(root) {
                    let buttons = [];
                    if (!root) { return buttons; }
                    try {
                        const items = Array.from(root.querySelectorAll('*'));
                        for (const el of items) {
                            if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.classList.contains('cursor-pointer')) {
                                buttons.push(el);
                            }
                            if (el.shadowRoot) {
                                buttons = buttons.concat(findAllButtons(el.shadowRoot));
                            }
                        }
                    } catch(e) { /* defensive: ignore DOM query errors */ }
                    return buttons;
                }

                try {
                    if (!document || !document.body) { return 'none'; }
                    const buttons = findAllButtons(document.body);
                    const targetTexts = ['accept', 'run', 'retry', 'apply'];

                    for (const b of buttons) {
                        if (!b) { continue; }
                        const text = (b.textContent || b.innerText || '').trim().toLowerCase();
                        if (targetTexts.includes(text)) {
                            const rect = b.getBoundingClientRect();
                            if (rect && rect.width > 0 && rect.height > 0) {
                                if (text === 'run') {
                                    const pageText = document.body.innerText || '';
                                    for (const blocked of blockedCmds) {
                                        if (pageText.includes(blocked)) {
                                            return 'blocked: ' + blocked;
                                        }
                                    }
                                }
                                b.click();
                                return 'clicked_' + text;
                            }
                        }
                    }
                    return 'none';
                } catch(e) {
                    return 'error: ' + (e && e.message ? e.message : String(e));
                }
            })();
        `;

        try {
            const result = await this.cdp.send('Runtime.evaluate', {
                expression: script,
                returnByValue: true,
            });

            const val: string = result?.result?.value ?? '';
            if (typeof val === 'string' && val.length > 0) {
                if (val.startsWith('clicked_')) {
                    this.log(`Accepted action: ${val}`);
                } else if (val.startsWith('blocked: ')) {
                    const cmd = val.substring('blocked: '.length);
                    this.log(`BLOCKED dangerous command: ${cmd}`);
                    vscode.window.showWarningMessage(`AutoAccept-Antigravity: Blocked dangerous command "${cmd}"`);
                } else if (val.startsWith('error: ')) {
                    this.log(`Script error: ${val}`);
                }
                // 'none' is normal — nothing to do
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            // Only log, don't spam — reconnect logic in CDPClient handles recovery
            this.log(`Poll error: ${msg}`);
        } finally {
            this.isPollInProgress = false;
        }
    }

    // ── Logging ────────────────────────────────────────────

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
