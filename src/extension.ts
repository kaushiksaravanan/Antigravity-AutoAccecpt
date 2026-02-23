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
        outputChannel.appendLine('AutoAccept-Antigravity v2 extension activated.');

        vscode.commands.getCommands(true).then(cmds => {
            const relevant = cmds.filter(c => c.toLowerCase().includes('antigravity') || c.toLowerCase().includes('chat'));
            outputChannel.appendLine(`Found interesting commands: \n${relevant.join('\n')}`);
        });
        console.log('AutoAccept-Antigravity v2 extension activated.');

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

        // ── Commands ──

        const toggleCommand = vscode.commands.registerCommand('autoAcceptAgent.toggle', () => {
            try {
                acceptor?.toggle();
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                outputChannel.appendLine(`Toggle command error: ${msg}`);
                vscode.window.showErrorMessage(`AutoAccept-Antigravity toggle failed: ${msg}`);
            }
        });

        const startCommand = vscode.commands.registerCommand('autoAcceptAgent.start', () => {
            try {
                acceptor?.start();
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`AutoAccept start failed: ${msg}`);
            }
        });

        const stopCommand = vscode.commands.registerCommand('autoAcceptAgent.stop', () => {
            try {
                acceptor?.stop();
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`AutoAccept stop failed: ${msg}`);
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

        const paywallCommand = vscode.commands.registerCommand('autoAcceptAgent.showPaywall', async () => {
            const { showPaywall } = await import('./paywallWebview.js');
            showPaywall(context);
        });

        const acceptNowCommand = vscode.commands.registerCommand('autoAcceptAgent.acceptNow', async () => {
            outputChannel.appendLine('Manual accept-all triggered...');
            // Fire all known accept commands immediately
            const allAcceptCommands = [
                'antigravity.agent.acceptAgentStep',
                'antigravity.command.accept',
                'antigravity.terminalCommand.accept',
                'antigravity.terminalCommand.run',
                'notification.acceptPrimaryAction',
                'chatEditing.acceptAllFiles',
                'inlineChat.acceptChanges',
                'antigravity.prioritized.agentAcceptAllInFile',
                'antigravity.prioritized.agentAcceptFocusedHunk',
                'antigravity.prioritized.supercompleteAccept',
                'workbench.action.chat.accept',
                'workbench.action.terminal.chat.runCommand',
            ];
            for (const cmd of allAcceptCommands) {
                try { await vscode.commands.executeCommand(cmd); } catch { /* ignore */ }
            }
            vscode.window.showInformationMessage('AutoAccept: Fired all accept commands.');
        });

        // Register everything for automatic disposal
        context.subscriptions.push(
            statusBarItem, outputChannel,
            toggleCommand, startCommand, stopCommand,
            diagCommand, paywallCommand, acceptNowCommand,
            acceptor
        );

        // ── Auto-start on activation ──
        acceptor.start().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            outputChannel.appendLine(`Auto-start failed: ${msg}`);
            console.log(`Auto-start failed: ${msg}`);
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
