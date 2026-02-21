import * as vscode from 'vscode';
import { AutoAcceptor } from './autoAcceptor';
import { runDiagnostics } from './diagnostics';

let acceptor: AutoAcceptor | undefined;

export function activate(context: vscode.ExtensionContext): void {
    try {
        const outputChannel = vscode.window.createOutputChannel('Auto Accept Agent');
        if (!outputChannel) {
            vscode.window.showErrorMessage('AutoAccept-Antigravity: Failed to create output channel.');
            return;
        }
        outputChannel.appendLine('AutoAccept-Antigravity extension activated (native mode).');

        const statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        if (!statusBarItem) {
            outputChannel.appendLine('Failed to create status bar item.');
            vscode.window.showErrorMessage('AutoAccept-Antigravity: Failed to create status bar item.');
            return;
        }
        statusBarItem.command = 'autoAcceptAgent.toggle';

        acceptor = new AutoAcceptor(statusBarItem, outputChannel);

        const toggleCommand = vscode.commands.registerCommand('autoAcceptAgent.toggle', () => {
            try {
                acceptor?.toggle();
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                outputChannel.appendLine(`Toggle command error: ${msg}`);
                vscode.window.showErrorMessage(`AutoAccept-Antigravity toggle failed: ${msg}`);
            }
        });

        const diagCommand = vscode.commands.registerCommand('autoAcceptAgent.diagnostics', async () => {
            try {
                await runDiagnostics(outputChannel);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                outputChannel.appendLine(`Diagnostics error: ${msg}`);
                vscode.window.showErrorMessage(`AutoAccept diagnostics failed: ${msg}`);
            }
        });

        // Register everything for automatic disposal
        context.subscriptions.push(statusBarItem, outputChannel, toggleCommand, diagCommand, acceptor);

        // Start automatically on activation
        acceptor.start().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            outputChannel.appendLine(`Auto-start failed: ${msg}`);
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`AutoAccept-Antigravity activation failed: ${msg}`);
    }
}

export function deactivate(): void {
    try {
        if (acceptor) {
            acceptor.stop();
            acceptor = undefined;
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`AutoAccept-Antigravity deactivation error: ${msg}`);
    }
}
