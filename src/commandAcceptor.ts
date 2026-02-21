import * as vscode from 'vscode';

export class CommandAcceptor {
    private intervalId: NodeJS.Timeout | undefined;
    private isRunning = false;
    private outputChannel: vscode.OutputChannel;

    public onCommandAccepted?: (cmdId: string, usageCount: number) => void;
    private executedCount = 0;
    private lastExecutedCmd = 'none';
    private trackingDisposables: vscode.Disposable[] = [];

    private readonly acceptCommands = [
        'antigravity.agent.acceptAgentStep',
        'antigravity.command.accept',
        'antigravity.prioritized.agentAcceptAllInFile',
        'antigravity.prioritized.agentAcceptFocusedHunk',
        'antigravity.prioritized.supercompleteAccept',
        'antigravity.terminalCommand.accept',
        'antigravity.terminalCommand.run',
        'chatEditing.acceptAllFiles',
        'chatEditing.acceptFile',
        'inlineChat.acceptChanges',
        'notification.acceptPrimaryAction',
        'workbench.action.chat.accept',
        'workbench.action.chat.submit',
        'workbench.action.terminal.chat.runCommand',
        'workbench.action.terminal.acceptSelectedSuggestion',
        'workbench.action.terminal.acceptSelectedSuggestionEnter'
    ];

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    public start(): void {
        if (this.isRunning) return;

        const config = vscode.workspace.getConfiguration('autoAcceptAgent');
        const enablePolling = config.get<boolean>('enableCommandPolling', true);
        const pollIntervalMs = config.get<number>('pollIntervalMs', 1500);

        if (!enablePolling) {
            this.log('Command polling is disabled in settings.');
            return;
        }

        this.isRunning = true;
        this.log(`Starting command polling (interval: ${pollIntervalMs}ms)`);

        this.intervalId = setInterval(() => {
            this.pollCommands();
        }, pollIntervalMs);

        // Reset or initialize tracking
        this.setupTracking();
    }

    public stop(): void {
        if (!this.isRunning) return;

        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
        this.isRunning = false;
        this.log('Stopped command polling.');
    }

    public dispose(): void {
        this.stop();
        this.trackingDisposables.forEach(d => d.dispose());
    }

    private setupTracking(): void {
        // Track Terminal Commands
        if (vscode.window.onDidStartTerminalShellExecution) {
            this.trackingDisposables.push(
                vscode.window.onDidStartTerminalShellExecution((e) => {
                    if (this.isRunning) {
                        this.executedCount++;
                        this.lastExecutedCmd = e.execution.commandLine.value || 'terminal command';
                        if (this.onCommandAccepted) {
                            this.onCommandAccepted(this.lastExecutedCmd, this.executedCount);
                        }
                    }
                })
            );
        }

        // Track Text Document Edits (as a proxy for inline chat accepts)
        this.trackingDisposables.push(
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (this.isRunning && e.contentChanges.length > 0) {
                    // Only count significant automated changes happening very quickly 
                    // or just count all changes while running as a proxy.
                    this.executedCount++;
                    this.lastExecutedCmd = `Edited \${e.document.fileName.split(/[\\\\/]/).pop()}`;
                    if (this.onCommandAccepted) {
                        this.onCommandAccepted(this.lastExecutedCmd, this.executedCount);
                    }
                }
            })
        );
    }

    private async pollCommands(): Promise<void> {
        for (const cmd of this.acceptCommands) {
            try {
                // Execute the command silently.
                // If it's not applicable (e.g., no terminal command pending), 
                // VS Code will just ignore it or throw an error which we catch and swallow.
                // We use setTimeout so that commands run decoupled and don't block each other.
                setTimeout(() => {
                    vscode.commands.executeCommand(cmd).then(undefined, () => {
                        // Ignore execution errors
                    });
                }, 0);
            } catch (err) {
                // Ignore synchronous errors
            }
        }
    }

    private log(message: string): void {
        try {
            const timestamp = new Date().toISOString();
            this.outputChannel.appendLine(`[${timestamp}] [CommandAcceptor] ${message}`);
        } catch {
            // Ignore if channel is closed
        }
    }
}
