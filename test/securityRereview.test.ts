import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { findBlockedPattern } from '../src/blocked';
import { DEFAULT_BLOCKED_COMMANDS } from '../src/catalog';
import { inspectCommand } from '../src/scriptInspector';
import { buildPermissionScript } from '../src/cdpFallback';

const patterns = DEFAULT_BLOCKED_COMMANDS;
const noopLog = () => {};

test('security: matcher catches unquoted sudo flags, nested subshells, and chained commands in -c', () => {
    assert.equal(findBlockedPattern('sudo -u root rm -fr ./fixture', patterns), 'rm -rf');
    assert.equal(findBlockedPattern('echo $(echo $(rm -fr ./fixture))', patterns), 'rm -rf');
    assert.equal(findBlockedPattern('bash -c "echo ok; del fixture.txt"', patterns), 'del');
    assert.equal(findBlockedPattern('bash -c "echo safe; git status"', patterns), null);
});

test('security: inspectCommand catches compound commands and module switches', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-rereview-'));
    try {
        const cleanupSh = path.join(tmpDir, 'cleanup.sh');
        fs.writeFileSync(cleanupSh, 'rm -rf ./fixture\n');

        const cleanupPy = path.join(tmpDir, 'cleanup.py');
        fs.writeFileSync(cleanupPy, 'import shutil\nshutil.rmtree("./fixture")\n');

        // Compounds
        assert.equal(inspectCommand('echo ok && bash cleanup.sh', [tmpDir], patterns, noopLog), 'rm -rf');
        assert.equal(inspectCommand('echo ok; bash cleanup.sh', [tmpDir], patterns, noopLog), 'rm -rf');
        assert.equal(inspectCommand('false || bash cleanup.sh', [tmpDir], patterns, noopLog), 'rm -rf');

        // Wrappers
        assert.equal(inspectCommand('env bash cleanup.sh', [tmpDir], patterns, noopLog), 'rm -rf');
        assert.equal(inspectCommand('sudo bash cleanup.sh', [tmpDir], patterns, noopLog), 'rm -rf');
        assert.equal(inspectCommand('sudo -u root bash cleanup.sh', [tmpDir], patterns, noopLog), 'rm -rf');

        // Python -m module
        assert.equal(inspectCommand('python -m cleanup', [tmpDir], patterns, noopLog), 'shutil.rmtree');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('security: inspectCommand traverses Python packages and JavaScript imports', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-rereview-'));
    try {
        // Python package pkg/__init__.py
        const pkgDir = path.join(tmpDir, 'pkg');
        fs.mkdirSync(pkgDir);
        fs.writeFileSync(path.join(pkgDir, '__init__.py'), 'import shutil\nshutil.rmtree("./fixture")\n');

        const mainPy = path.join(tmpDir, 'main.py');
        fs.writeFileSync(mainPy, 'import pkg\n');

        assert.equal(inspectCommand('python main.py', [tmpDir], patterns, noopLog), 'shutil.rmtree');

        // JavaScript require("./cleanup.js")
        const cleanupJs = path.join(tmpDir, 'cleanup.js');
        fs.writeFileSync(cleanupJs, 'const fs = require("fs");\nfs.rmSync("./fixture", {recursive:true});\n');

        const mainJs = path.join(tmpDir, 'main.js');
        fs.writeFileSync(mainJs, 'require("./cleanup.js");\n');

        assert.equal(inspectCommand('node main.js', [tmpDir], patterns, noopLog), 'fs.rmSync');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('security: inspectCommand detects aliased imports and inline native deletion', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-rereview-'));
    try {
        const aliasPy = path.join(tmpDir, 'alias.py');
        fs.writeFileSync(aliasPy, 'from shutil import rmtree\nrmtree("./fixture")\n');

        assert.equal(inspectCommand('python alias.py', [tmpDir], patterns, noopLog), 'shutil.rmtree');

        // Inline python -c
        assert.equal(
            inspectCommand('python -c "import shutil; shutil.rmtree(\'./fixture\')"', [tmpDir], patterns, noopLog),
            'shutil.rmtree',
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('security: inspectCommand enforces unknown policy on depth exhaustion and read errors', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-rereview-'));
    try {
        // Chain of 5 sourced scripts
        for (let i = 0; i < 4; i++) {
            fs.writeFileSync(path.join(tmpDir, `s${i}.sh`), `source s${i + 1}.sh\n`);
        }
        fs.writeFileSync(path.join(tmpDir, 's4.sh'), 'rm -rf ./fixture\n');

        assert.equal(
            inspectCommand('bash s0.sh', [tmpDir], patterns, noopLog, { unknownScriptPolicy: 'block' }),
            'depth-exceeded',
        );

        // Non-existent script under block policy
        assert.equal(
            inspectCommand('bash missing.sh', [tmpDir], patterns, noopLog, { unknownScriptPolicy: 'block' }),
            'unresolvable-script',
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('security: inspectCommand respects npm prebuild hooks and protects against cycles', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-rereview-'));
    try {
        // Hook in prebuild
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
            scripts: {
                prebuild: 'rm -rf ./fixture',
                build: 'echo done',
            },
        }));

        assert.equal(inspectCommand('npm run build', [tmpDir], patterns, noopLog), 'rm -rf');

        // Self-referencing loop
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
            scripts: {
                loop: 'npm run loop',
            },
        }));

        assert.equal(
            inspectCommand('npm run loop', [tmpDir], patterns, noopLog, { unknownScriptPolicy: 'block' }),
            null,
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('security: buildPermissionScript handles mock DOM and refuses empty or oversized text', () => {
    const script = buildPermissionScript([], patterns, true, false);

    // 1. Empty container text returns 'missing-container-text'
    const emptyDoc = {
        body: {},
        querySelector: (s: string) => s === '[data-vscode-context]' ? {} : null,
        createTreeWalker: () => {
            let i = 0;
            const btn = {
                textContent: 'Run',
                tagName: 'BUTTON',
                parentElement: { className: 'step', innerText: '' },
                classList: { contains: () => false },
                getAttribute: () => null,
                setAttribute: () => {},
                querySelector: () => null,
            };
            return { nextNode: () => i++ === 0 ? btn : null };
        },
    };
    const resEmpty = vm.runInNewContext(script, { document: emptyDoc, NodeFilter: { SHOW_ELEMENT: 1 } });
    assert.equal(resEmpty, 'missing-container-text');

    // 2. Oversized container text (>65536) returns 'blocked:container-text-oversized'
    const oversizedDoc = {
        body: {},
        querySelector: (s: string) => s === '[data-vscode-context]' ? {} : null,
        createTreeWalker: () => {
            let i = 0;
            const btn = {
                textContent: 'Run',
                tagName: 'BUTTON',
                parentElement: { className: 'step', innerText: 'x'.repeat(65537) + '\nrm -rf ./fixture' },
                classList: { contains: () => false },
                getAttribute: () => null,
                setAttribute: () => {},
                querySelector: () => null,
            };
            return { nextNode: () => i++ === 0 ? btn : null };
        },
    };
    const resOversized = vm.runInNewContext(script, { document: oversizedDoc, NodeFilter: { SHOW_ELEMENT: 1 } });
    assert.equal(resOversized, 'blocked:container-text-oversized');
});
