import * as vscode from 'vscode';
import { AutoAcceptor } from './autoAcceptor';
import { runDiagnostics } from './diagnostics';

let acceptor: AutoAcceptor | undefined;

export function activate(context: vscode.ExtensionContext): void {
    try {
        const output = vscode.window.createOutputChannel('Auto Accept Agent');
        output.appendLine('activated');

        const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBar.command = 'autoAcceptAgent.toggle';

        acceptor = new AutoAcceptor(statusBar, output, context);

        const cmd = (id: string, fn: () => Promise<void>) =>
            vscode.commands.registerCommand(id, async () => {
                try { await fn(); } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    vscode.window.showErrorMessage(`AutoAccept: ${msg}`);
                }
            });

        context.subscriptions.push(
            cmd('autoAcceptAgent.toggle', () => acceptor!.toggle()),
            cmd('autoAcceptAgent.start', () => acceptor!.start()),
            cmd('autoAcceptAgent.stop', () => acceptor!.stop()),
            cmd('autoAcceptAgent.diagnostics', () => runDiagnostics(output)),
            cmd('autoAcceptAgent.showPaywall', async () => {
                const { showPaywall } = await import('./paywallWebview.js');
                showPaywall(context);
            }),
            cmd('autoAcceptAgent.acceptNow', async () => {
                const cmds = [
                    'antigravity.agent.acceptAgentStep',
                    'antigravity.command.accept',
                    'antigravity.terminalCommand.accept',
                    'antigravity.terminalCommand.run',
                    'notification.acceptPrimaryAction',
                    'workbench.action.chat.accept',
                    'workbench.action.terminal.chat.runCommand',
                ];
                for (const c of cmds) {
                    try { await vscode.commands.executeCommand(c); } catch { }
                }
            }),
            acceptor
        );

        acceptor.start().catch(() => { });

    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`AutoAccept activation failed: ${msg}`);
    }
}

export async function deactivate(): Promise<void> {
    // Cleanup is handled by context.subscriptions disposing AutoAcceptor.
    // We just clear the reference here to avoid stale usage.
    acceptor = undefined;
}
