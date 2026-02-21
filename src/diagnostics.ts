import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Diagnostic tool that discovers what commands and settings are available
 * in the current VS Code instance for auto-accepting agent actions.
 * 
 * Run via Command Palette: "Auto Accept: Run Diagnostics"
 */

// All known setting keys that might control auto-approval
const CANDIDATE_SETTINGS: Array<[string, string, unknown]> = [
    // VS Code built-in chat settings
    ['chat.tools', 'autoApprove', true],
    ['chat.tools.global', 'autoApprove', true],
    ['chat.tools.terminal', 'enableAutoApprove', true],
    ['chat.tools.terminal', 'autoApprove', true],
    ['chat.tools.edits', 'autoApprove', true],
    ['chat.agent', 'autoApprove', true],
    ['chat.agent', 'maxRequests', 100],
    // GitHub Copilot settings
    ['github.copilot.chat.agent', 'autoApprove', true],
    ['github.copilot.chat', 'autoApprove', true],
    ['copilot.agent', 'autoApproveCommands', true],
    // Gemini / Google settings
    ['geminai', 'autoApprove', true],
    ['google.gemini', 'autoApprove', true],
    ['gemini.agent', 'autoApprove', true],
];

// Command patterns to search for
const COMMAND_SEARCH_PATTERNS: RegExp[] = [
    /accept/i,
    /approve/i,
    /confirm/i,
    /run.*terminal/i,
    /terminal.*run/i,
    /chat.*run/i,
    /chat.*accept/i,
    /chat.*approve/i,
    /chat.*confirm/i,
    /chat.*apply/i,
    /copilot.*accept/i,
    /copilot.*approve/i,
    /copilot.*run/i,
    /copilot.*apply/i,
    /agent.*accept/i,
    /agent.*approve/i,
    /agent.*run/i,
    /agent.*apply/i,
    /agent.*confirm/i,
    /gemini.*accept/i,
    /gemini.*approve/i,
    /gemini.*run/i,
    /inline.*accept/i,
    /inline.*commit/i,
    /tool.*accept/i,
    /tool.*approve/i,
    /tool.*confirm/i,
    /tool.*run/i,
];

export async function runDiagnostics(outputChannel: vscode.OutputChannel): Promise<void> {
    outputChannel.show(true);
    outputChannel.appendLine('=== Starting Diagnostics ===');

    const lines: string[] = [];
    const log = (msg: string) => {
        lines.push(msg);
        outputChannel.appendLine(msg);
    };

    log('# AutoAccept-Antigravity Diagnostics Report');
    log(`**Date:** ${new Date().toISOString()}`);
    log(`**VS Code Version:** ${vscode.version}`);
    log('');

    // ── Section 1: Discover ALL commands matching our patterns ──
    log('## 1. Discovered Commands');
    log('');
    log('Commands matching accept/approve/run/confirm patterns:');
    log('');

    try {
        const allCommands = await vscode.commands.getCommands(true);
        const matchedCommands: string[] = [];

        for (const cmd of allCommands) {
            if (COMMAND_SEARCH_PATTERNS.some(p => p.test(cmd))) {
                matchedCommands.push(cmd);
            }
        }

        matchedCommands.sort();

        if (matchedCommands.length === 0) {
            log('> No matching commands found!');
        } else {
            log(`Found ${matchedCommands.length} matching commands:`);
            log('');
            for (const cmd of matchedCommands) {
                log(`- ${cmd}`);
            }
        }

        // Also dump ALL chat/copilot/agent/gemini commands
        log('');
        log('### All chat/copilot/agent/gemini/tool commands:');
        log('');
        const allRelated = allCommands.filter(cmd =>
            /^(chat|copilot|github\.copilot|agent|gemini|google|workbench\.action\.chat|inlineChat)/i.test(cmd)
        ).sort();

        if (allRelated.length === 0) {
            log('> No chat/copilot/agent/gemini commands found.');
        } else {
            for (const cmd of allRelated) {
                log(`- ${cmd}`);
            }
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`> Error discovering commands: ${msg}`);
    }

    log('');

    // ── Section 2: Test settings ──
    log('## 2. Settings Inspection');
    log('');

    for (const [section, key] of CANDIDATE_SETTINGS) {
        const fullKey = `${section}.${key}`;
        try {
            const config = vscode.workspace.getConfiguration(section);
            const inspect = config.inspect(key);

            if (inspect) {
                const current = config.get(key);
                const globalVal = inspect.globalValue;
                const defaultVal = inspect.defaultValue;
                log(`- YES ${fullKey}: global=${JSON.stringify(globalVal)}, effective=${JSON.stringify(current)}, default=${JSON.stringify(defaultVal)}`);
            } else {
                log(`- NO  ${fullKey}: does not exist`);
            }
        } catch {
            log(`- ERR ${fullKey}: error reading`);
        }
    }

    log('');

    // ── Section 3: List all installed extensions ──
    log('## 3. Installed AI Extensions');
    log('');

    const aiExtensions = vscode.extensions.all.filter(ext => {
        const name = (ext.id + ' ' + (ext.packageJSON?.displayName || '')).toLowerCase();
        return name.includes('copilot') || name.includes('gemini') || name.includes('agent')
            || name.includes('chat') || name.includes('ai') || name.includes('antigravity');
    });

    if (aiExtensions.length === 0) {
        log('> No AI-related extensions found.');
    } else {
        for (const ext of aiExtensions) {
            const displayName = ext.packageJSON?.displayName || 'N/A';
            const active = ext.isActive ? 'ACTIVE' : 'INACTIVE';
            log(`- [${active}] ${ext.id} — ${displayName}`);
        }
    }

    log('');
    log('---');
    log('Share this report to identify which commands/settings can be used.');

    // Write report to a temp file and open it
    try {
        const reportPath = path.join(os.tmpdir(), 'autoaccept-diagnostics.md');
        fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(reportPath));
        await vscode.window.showTextDocument(doc, { preview: false });
        outputChannel.appendLine(`Report saved to: ${reportPath}`);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`Could not open report file: ${msg}`);
        outputChannel.appendLine('Full report is printed above in this output channel.');
    }

    vscode.window.showInformationMessage('AutoAccept Diagnostics complete! Check Output Channel and report.');
}
