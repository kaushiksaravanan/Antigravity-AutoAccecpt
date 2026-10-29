import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { editAutoApproveSettings, terminalAutoApproveSettings, autoApproveSettings, OPEN_VSX_URL } from '../src/catalog';

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

function createAutoAcceptorEnv(options: { choice?: string } = {}) {
    const globals = new Map<string, unknown>();
    const states = new Map<string, unknown>();
    const warnings: Array<{ message: string; options: any; items: string[] }> = [];
    const openedUrls: string[] = [];
    const infoMessages: string[] = [];

    const context = {
        subscriptions: [],
        globalState: {
            get: (k: string, fb: unknown) => states.get(k) ?? fb,
            update: async (k: string, v: unknown) => { states.set(k, v); },
        },
    };

    const status = { text: '', tooltip: '', show() {}, dispose() {} };
    const output = { appendLine() {}, dispose() {} };

    const vscode = {
        ConfigurationTarget: { Global: 1 },
        StatusBarAlignment: { Right: 2 },
        ThemeColor: class {},
        env: {
            openExternal: async (uri: { toString: () => string }) => {
                openedUrls.push(uri.toString());
                return true;
            },
        },
        Uri: {
            parse: (s: string) => ({ toString: () => s }),
        },
        workspace: {
            workspaceFolders: [],
            onDidChangeConfiguration: () => ({ dispose() {} }),
            getConfiguration(section: string) {
                return {
                    get: (k: string, fb: unknown) => globals.get(`${section}.${k}`) ?? fb,
                    inspect: (k: string) => ({ globalValue: globals.get(`${section}.${k}`) }),
                    update: async (k: string, v: unknown) => {
                        if (v === undefined) globals.delete(`${section}.${k}`);
                        else globals.set(`${section}.${k}`, v);
                    },
                };
            },
        },
        window: {
            showWarningMessage: async (msg: string, opts: any, ...items: string[]) => {
                warnings.push({ message: msg, options: opts, items });
                return options.choice;
            },
            showInformationMessage: async (msg: string) => {
                infoMessages.push(msg);
            },
            createStatusBarItem: () => status,
            createOutputChannel: () => output,
        },
        commands: {
            executeCommand: async () => {},
        },
    };

    const outDir = path.resolve(__dirname, '..', '..', 'out');

    const moduleCache = new Map<string, { exports: any }>();
    moduleCache.set('vscode', { exports: vscode });

    function loadModule(modulePath: string): any {
        const resolvedPath = path.isAbsolute(modulePath)
            ? (modulePath.endsWith('.js') ? modulePath : `${modulePath}.js`)
            : path.resolve(outDir, modulePath.endsWith('.js') ? modulePath : `${modulePath}.js`);

        if (moduleCache.has(resolvedPath)) {
            return moduleCache.get(resolvedPath)!.exports;
        }

        const source = fs.readFileSync(resolvedPath, 'utf8');
        const mod: { exports: any } = { exports: {} };
        moduleCache.set(resolvedPath, mod);

        const localRequire = (name: string) => {
            if (name === 'vscode') return vscode;
            if (name.startsWith('.')) {
                return loadModule(path.resolve(path.dirname(resolvedPath), name));
            }
            return require(name);
        };

        const fn = vm.compileFunction(
            source,
            ['require', 'module', 'exports', 'console'],
            { filename: resolvedPath },
        );
        fn(localRequire, mod, mod.exports, { log() {}, error() {}, warn() {} });
        return mod.exports;
    }

    const autoAcceptorModule = loadModule('autoAcceptor');
    const a = new autoAcceptorModule.AutoAcceptor(status, output, context);

    return { a, warnings, openedUrls, infoMessages };
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

test('popout: blocked command triggers popout dialog with 3 options and rich details', async () => {
    const { a, warnings } = createAutoAcceptorEnv();

    await a.handleBlockedCommand({
        command: 'rm -rf /critical-data',
        pattern: 'rm -rf',
        agent: 'Antigravity Agent Alpha',
        timestamp: '19:20:00',
    });

    assert.equal(warnings.length, 1);
    const w = warnings[0];

    // Popout title
    assert.ok(w.message.includes('Dangerous Command Blocked'));
    assert.ok(w.message.includes('rm -rf /critical-data'));

    // Modal options
    assert.equal(w.options.modal, true);
    assert.ok(w.options.detail.includes('rm -rf /critical-data'));
    assert.ok(w.options.detail.includes('Antigravity Agent Alpha'));
    assert.ok(w.options.detail.includes('19:20:00'));
    assert.ok(w.options.detail.includes('rm -rf'));

    // Exactly 3 CTAs
    assert.deepEqual(w.items, [
        'Accept Risk & Continue',
        'Wrong (Give Feedback on Open VSX)',
        'Correct (Dismiss)',
    ]);
});

test('popout: clicking "Accept Risk & Continue" unpauses terminal accept', async () => {
    const { a, infoMessages } = createAutoAcceptorEnv({ choice: 'Accept Risk & Continue' });

    await a.handleBlockedCommand({
        command: 'del /f /s /q *.*',
        pattern: 'del',
        agent: 'Claude Agent',
        timestamp: '19:21:00',
    });

    assert.equal(a.isTerminalPaused(), false);
    assert.ok(infoMessages.some(m => m.includes('Risk accepted. Terminal auto-accept resumed.')));
});

test('popout: clicking "Wrong (Give Feedback on Open VSX)" opens Open VSX page', async () => {
    const { a, openedUrls } = createAutoAcceptorEnv({ choice: 'Wrong (Give Feedback on Open VSX)' });

    await a.handleBlockedCommand({
        command: 'format C: /FS:NTFS',
        pattern: 'format',
        agent: 'Gemini Agent',
        timestamp: '19:22:00',
    });

    assert.equal(openedUrls.length, 1);
    assert.equal(openedUrls[0], OPEN_VSX_URL);
});

test('popout: clicking "Correct (Dismiss)" keeps terminal paused and disappears cleanly', async () => {
    const { a, openedUrls } = createAutoAcceptorEnv({ choice: 'Correct (Dismiss)' });

    await a.handleBlockedCommand({
        command: 'rm -rf /',
        pattern: 'rm -rf /',
        agent: 'Agent Rogue',
        timestamp: '19:23:00',
    });

    assert.equal(a.isTerminalPaused(), true);
    assert.equal(openedUrls.length, 0);
});
