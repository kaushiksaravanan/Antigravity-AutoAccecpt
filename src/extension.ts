import * as vscode from 'vscode';
import { AutoAcceptor } from './autoAcceptor';
import { ENABLED_STATE_KEY } from './catalog';
import { runDiagnostics } from './diagnostics';

let acceptor: AutoAcceptor | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    try {
        const output = vscode.window.createOutputChannel('Auto Accept Agent');
        output.appendLine('activated');

        const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBar.command = 'autoAcceptAgent.toggle';

        acceptor = new AutoAcceptor(statusBar, output, context);

        const cmd = (id: string, fn: () => Promise<void>) =>
            vscode.commands.registerCommand(id, async () => {
                try {
                    await fn();
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    void vscode.window.showErrorMessage(`AutoAccept: ${message}`);
                }
            });

        context.subscriptions.push(
            cmd('autoAcceptAgent.toggle', () => acceptor!.toggle()),
            cmd('autoAcceptAgent.start', () => acceptor!.start()),
            cmd('autoAcceptAgent.stop', () => acceptor!.stop()),
            cmd('autoAcceptAgent.diagnostics', () => runDiagnostics(output)),
            cmd('autoAcceptAgent.acceptNow', () => acceptor ? acceptor.acceptNow() : Promise.resolve()),
            acceptor,
        );

        await acceptor.recover();
        if (context.globalState.get<boolean>(ENABLED_STATE_KEY, false)) {
            await acceptor.start({ quiet: true });
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`AutoAccept activation failed: ${message}`);
    }
}

export async function deactivate(): Promise<void> {
    if (!acceptor) {
        return;
    }
    await acceptor.stop({ notify: false, persistOff: false });
    acceptor = undefined;
}

