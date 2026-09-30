import * as vscode from 'vscode';
import { SETTINGS_SNAPSHOT_KEY, autoApproveSettings } from './catalog';

interface PersistedSetting {
    section: string;
    key: string;
    hadValue: boolean;
    value: unknown;
}

/**
 * Writes auto-approve settings at user scope and puts the previous values back.
 * The snapshot is stored in globalState before the first write, so a crash
 * can still be repaired on the next launch.
 */
export class SettingsGuard {
    private applied = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly log: (message: string) => void,
    ) {}

    async recover(): Promise<void> {
        const leftover = this.read();
        if (leftover.length === 0) {
            return;
        }
        this.log('Restoring settings left from a previous session.');
        await this.restoreEntries(leftover);
    }

    async apply(): Promise<void> {
        if (this.applied) {
            return;
        }

        const snapshot = new Map<string, PersistedSetting>();
        for (const existing of this.read()) {
            snapshot.set(this.id(existing.section, existing.key), existing);
        }

        for (const [section, key] of autoApproveSettings) {
            const settingId = this.id(section, key);
            if (snapshot.has(settingId)) {
                continue;
            }
            const inspect = vscode.workspace.getConfiguration(section).inspect(key);
            snapshot.set(settingId, {
                section,
                key,
                hadValue: inspect?.globalValue !== undefined,
                value: inspect?.globalValue,
            });
        }

        await this.write([...snapshot.values()]);

        let applied = 0;
        let skipped = 0;
        for (const [section, key, value] of autoApproveSettings) {
            try {
                const config = vscode.workspace.getConfiguration(section);
                const current = config.inspect(key)?.globalValue;
                if (current === value) {
                    skipped++;
                    continue;
                }
                await config.update(key, value, vscode.ConfigurationTarget.Global);
                applied++;
            } catch (err: unknown) {
                skipped++;
                this.log(`Skipped ${section}.${key}: ${errorMessage(err)}`);
            }
        }

        this.applied = true;
        this.log(`Settings applied: ${applied} updated, ${skipped} already set or unavailable.`);
    }

    async restore(): Promise<void> {
        const entries = this.read();
        if (!this.applied && entries.length === 0) {
            return;
        }
        this.log('Restoring previous settings.');
        await this.restoreEntries(entries);
        this.applied = false;
    }

    private async restoreEntries(entries: PersistedSetting[]): Promise<void> {
        const remaining: PersistedSetting[] = [];
        let restored = 0;

        for (const snapshot of entries) {
            const settingId = this.id(snapshot.section, snapshot.key);
            try {
                const config = vscode.workspace.getConfiguration(snapshot.section);
                const current = config.inspect(snapshot.key)?.globalValue;
                const target = snapshot.hadValue ? snapshot.value : undefined;
                if (current !== target) {
                    await config.update(snapshot.key, target, vscode.ConfigurationTarget.Global);
                    restored++;
                }
            } catch (err: unknown) {
                remaining.push(snapshot);
                this.log(`Failed to restore ${settingId}: ${errorMessage(err)}`);
            }
        }

        await this.write(remaining);
        this.log(`Settings restore finished: ${restored} updated, ${remaining.length} still pending.`);
    }

    private read(): PersistedSetting[] {
        const value = this.context.globalState.get<unknown>(SETTINGS_SNAPSHOT_KEY, []);
        if (!Array.isArray(value)) {
            return [];
        }
        return value.filter((entry): entry is PersistedSetting => {
            if (!entry || typeof entry !== 'object') {
                return false;
            }
            const candidate = entry as PersistedSetting;
            return typeof candidate.section === 'string'
                && typeof candidate.key === 'string'
                && typeof candidate.hadValue === 'boolean';
        });
    }

    private async write(entries: PersistedSetting[]): Promise<void> {
        await this.context.globalState.update(SETTINGS_SNAPSHOT_KEY, entries);
    }

    private id(section: string, key: string): string {
        return `${section}.${key}`;
    }
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
