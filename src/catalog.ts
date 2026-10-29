/** Remembered status-bar choice. Absent means off. */
export const ENABLED_STATE_KEY = 'autoAcceptAgent.enabled';

/** Original global settings captured before this extension overwrites them. */
export const SETTINGS_SNAPSHOT_KEY = 'autoAcceptAgent.settingsSnapshot';

/** How long terminal auto-accept stays paused after a blocked command starts. */
export const TERMINAL_BLOCK_PAUSE_MS = 60_000;

/**
 * Agent-step commands fired on the fast poll.
 * Notification commands are intentionally absent: they accept whatever
 * primary action is open, including updates and trust prompts.
 */
export const criticalAcceptCommands: readonly string[] = [
    'antigravity.agent.acceptAgentStep',
    'antigravity.agent.acceptAllAgentSteps',
    'antigravity.command.accept',
    'antigravity.terminalCommand.accept',
    'antigravity.terminalCommand.run',
];

export const secondaryAcceptCommands: readonly string[] = [
    'workbench.action.chat.accept',
    'workbench.action.terminal.chat.runCommand',
];

/**
 * Commands that approve a tool or terminal run.
 * Skipped while terminal auto-accept is paused, and while CDP is connected
 * (CDP can read the command text before it clicks).
 */
export const runAcceptCommands: readonly string[] = [
    'antigravity.command.accept',
    'antigravity.terminalCommand.accept',
    'antigravity.terminalCommand.run',
    'workbench.action.terminal.chat.runCommand',
];

export const acceptNowCommands: readonly string[] = [
    ...criticalAcceptCommands,
    ...secondaryAcceptCommands,
];

const runAcceptSet = new Set<string>(runAcceptCommands);

export function isRunAcceptCommand(command: string): boolean {
    return runAcceptSet.has(command);
}

/**
 * Settings that auto-approve file edits and agent steps.
 * These are always safe to apply — they do not execute arbitrary commands.
 */
export const editAutoApproveSettings: ReadonlyArray<readonly [string, string, unknown]> = [
    ['chat.tools', 'autoApprove', true],
    ['chat.tools.global', 'autoApprove', true],
    ['chat.agent', 'autoApprove', true],
    ['chat.agent', 'maxRequests', 999],
];

/**
 * Settings that auto-approve terminal and command execution.
 * Only safe when CDP can inspect the command text, or when the user
 * explicitly accepts the risk of blind terminal acceptance.
 */
export const terminalAutoApproveSettings: ReadonlyArray<readonly [string, string, unknown]> = [
    ['chat.tools.terminal', 'enableAutoApprove', true],
    ['chat.tools.terminal', 'autoApprove', true],
    ['chat.tools.run_command', 'autoApprove', true],
    ['chat.tools.default_api:run_command', 'autoApprove', true],
    ['terminal.integrated', 'confirmOnKill', 'never'],
    ['terminal.integrated', 'confirmOnPaste', false],
];

/**
 * Combined list. Used for settings inspection, snapshot, and restore.
 * Workspace trust is not in this list. Turning trust off is not an approval preference.
 */
export const autoApproveSettings: ReadonlyArray<readonly [string, string, unknown]> = [
    ...editAutoApproveSettings,
    ...terminalAutoApproveSettings,
];

/** Settings diagnostics should report, including keys this extension does not write. */
export const settingsToInspect: ReadonlyArray<readonly [string, string]> = [
    ...autoApproveSettings.map(([section, key]) => [section, key] as const),
    ['security.workspace.trust', 'enabled'],
    ['chat.tools.edits', 'autoApprove'],
    ['github.copilot.chat.agent', 'autoApprove'],
    ['github.copilot.chat', 'autoApprove'],
    ['copilot.agent', 'autoApproveCommands'],
    ['geminai', 'autoApprove'],
    ['google.gemini', 'autoApprove'],
    ['gemini.agent', 'autoApprove'],
];

export const DEFAULT_BLOCKED_COMMANDS: readonly string[] = [
    'rm -rf /',
    'rm -rf',
    'rm -r',
    'format',
    'mkfs',
    'del',
    'del *',
    'rmdir',
    'rd',
    'erase',
    'Remove-Item',
    'git push --force',
    'git reset --hard',
    'git clean -fd',
    'git clean -f',
    'shred',
    'dd',
    'wipefs',
    'truncate',
    'cipher /w',
];
