import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { editAutoApproveSettings, terminalAutoApproveSettings, autoApproveSettings } from '../src/catalog';

function createMockEnv() {
    const globals = new Map<string, unknown>();
    const states = new Map<string, unknown>();

    const context = {
        subscriptions: [],
        globalState: {
            get: (k: string, fallback: unknown) => states.has(k) ? structuredClone(states.get(k)) : fallback,
            update: async (k: string, v: unknown) => { states.set(k, structuredClone(v)); },
        },
    };

    const vscode = {
        ConfigurationTarget: { Global: 1 },
        workspace: {
            getConfiguration(section: string) {
                return {
                    get: (k: string, fallback: unknown) => globals.get(`${section}.${k}`) ?? fallback,
                    inspect: (k: string) => ({ globalValue: globals.get(`${section}.${k}`) }),
                    update: async (k: string, v: unknown) => {
                        if (v === undefined) globals.delete(`${section}.${k}`);
                        else globals.set(`${section}.${k}`, v);
                    },
                };
            },
        },
    };

    const outDir = path.resolve(__dirname, '..', '..', 'out');
    const settingsGuardCode = fs.readFileSync(path.join(outDir, 'settingsGuard.js'), 'utf8');

    const mod: { exports: any } = { exports: {} };
    const localRequire = (name: string) => {
        if (name === 'vscode') return vscode;
        if (name === './catalog') return { SETTINGS_SNAPSHOT_KEY: 'autoAcceptAgent.settingsSnapshot' };
        return require(name);
    };

    const fn = vm.compileFunction(
        settingsGuardCode,
        ['require', 'module', 'exports'],
        { filename: path.join(outDir, 'settingsGuard.js') },
    );
    fn(localRequire, mod, mod.exports);

    return { SettingsGuard: mod.exports.SettingsGuard, context, globals, states };
}

test('lifecycle: editAutoApproveSettings separates edit approvals from global tool approvals', () => {
    // chat.tools.global.autoApprove must not be in editAutoApproveSettings
    assert.equal(editAutoApproveSettings.some(([section]) => section === 'chat.tools.global'), false);
    // chat.tools.global.autoApprove is guarded inside terminalAutoApproveSettings
    assert.equal(terminalAutoApproveSettings.some(([section]) => section === 'chat.tools.global'), true);
});

test('lifecycle: second settings owner does not restore first live owner settings', async () => {
    const { SettingsGuard, context, globals } = createMockEnv();

    const a = new SettingsGuard(context, () => {});
    const b = new SettingsGuard(context, () => {});

    await a.apply(autoApproveSettings);
    assert.equal(globals.get('chat.tools.edits.autoApprove'), true);

    // b.recover() should detect live owner 'a' and not wipe settings
    await b.recover();
    assert.equal(globals.get('chat.tools.edits.autoApprove'), true);

    // a.restore() restores settings properly
    await a.restore();
    assert.equal(globals.get('chat.tools.edits.autoApprove'), undefined);
});
