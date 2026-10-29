import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_BLOCKED_COMMANDS } from '../src/catalog';
import { inspectCommand } from '../src/scriptInspector';

const blocked = DEFAULT_BLOCKED_COMMANDS;
const noopLog = () => {};

test('scriptInspector: detects blocked patterns inside shell scripts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        const scriptPath = path.join(tmpDir, 'cleanup.sh');
        fs.writeFileSync(scriptPath, '#!/bin/bash\necho "cleaning"\nrm -rf /tmp/target\n');

        const hit = inspectCommand(`bash ${scriptPath}`, [tmpDir], blocked, noopLog);
        assert.equal(hit, 'rm -rf');

        const hitRel = inspectCommand('sh cleanup.sh', [tmpDir], blocked, noopLog);
        assert.equal(hitRel, 'rm -rf');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scriptInspector: detects blocked patterns inside python scripts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        const scriptPath = path.join(tmpDir, 'wipe.py');
        fs.writeFileSync(scriptPath, 'import os\nos.system("rm -rf /")\n');

        const hit = inspectCommand(`python ${scriptPath}`, [tmpDir], blocked, noopLog);
        assert.equal(hit, 'rm -rf /');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scriptInspector: detects blocked patterns inside npm run scripts in package.json', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        const pkgPath = path.join(tmpDir, 'package.json');
        fs.writeFileSync(pkgPath, JSON.stringify({
            name: 'test-pkg',
            scripts: {
                clean: 'rm -rf dist',
                build: 'tsc -p .',
                nuke: 'git clean -fd',
            },
        }));

        assert.equal(inspectCommand('npm run clean', [tmpDir], blocked, noopLog), 'rm -rf');
        assert.equal(inspectCommand('npm run nuke', [tmpDir], blocked, noopLog), 'git clean -fd');
        assert.equal(inspectCommand('npm run build', [tmpDir], blocked, noopLog), null);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scriptInspector: detects nested script invocation via npm run', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        const scriptPath = path.join(tmpDir, 'destroy.sh');
        fs.writeFileSync(scriptPath, '#!/bin/bash\nshred -u secret.txt\n');

        const pkgPath = path.join(tmpDir, 'package.json');
        fs.writeFileSync(pkgPath, JSON.stringify({
            name: 'test-pkg',
            scripts: {
                cleanup: 'bash destroy.sh',
            },
        }));

        assert.equal(inspectCommand('npm run cleanup', [tmpDir], blocked, noopLog), 'shred');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scriptInspector: allows safe commands and non-script commands', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        const scriptPath = path.join(tmpDir, 'safe.sh');
        fs.writeFileSync(scriptPath, '#!/bin/bash\necho "Hello world"\ngit status\n');

        assert.equal(inspectCommand(`bash ${scriptPath}`, [tmpDir], blocked, noopLog), null);
        assert.equal(inspectCommand('ls -la', [tmpDir], blocked, noopLog), null);
        assert.equal(inspectCommand('echo "rm -rf is dangerous"', [tmpDir], blocked, noopLog), null);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scriptInspector: detects native language deletion APIs in python and node', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        // Python shutil.rmtree
        const pyPath = path.join(tmpDir, 'clean.py');
        fs.writeFileSync(pyPath, 'import shutil\nshutil.rmtree("/tmp/target")\n');
        assert.equal(inspectCommand(`python clean.py`, [tmpDir], blocked, noopLog), 'shutil.rmtree');

        // Node fs.rmSync
        const jsPath = path.join(tmpDir, 'clean.js');
        fs.writeFileSync(jsPath, 'const fs = require("fs");\nfs.rmSync("/tmp/target", { recursive: true });\n');
        assert.equal(inspectCommand(`node clean.js`, [tmpDir], blocked, noopLog), 'fs.rmSync');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scriptInspector: follows sourced shell scripts and local python imports', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        // Nested shell script via source
        const helperPath = path.join(tmpDir, 'helpers.sh');
        fs.writeFileSync(helperPath, 'rm -rf /tmp/data\n');
        const mainShPath = path.join(tmpDir, 'main.sh');
        fs.writeFileSync(mainShPath, '#!/bin/bash\nsource helpers.sh\n');
        assert.equal(inspectCommand(`bash main.sh`, [tmpDir], blocked, noopLog), 'rm -rf');

        // Nested Python module via import
        const destroyMod = path.join(tmpDir, 'wipe_helper.py');
        fs.writeFileSync(destroyMod, 'import shutil\nshutil.rmtree("/tmp/app")\n');
        const mainPy = path.join(tmpDir, 'main.py');
        fs.writeFileSync(mainPy, 'import wipe_helper\nprint("done")\n');
        assert.equal(inspectCommand(`python main.py`, [tmpDir], blocked, noopLog), 'shutil.rmtree');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scriptInspector: unknownScriptPolicy blocks unresolvable scripts when set to block', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        assert.equal(
            inspectCommand('bash non_existent.sh', [tmpDir], blocked, noopLog, { unknownScriptPolicy: 'warn' }),
            null,
        );
        assert.equal(
            inspectCommand('bash non_existent.sh', [tmpDir], blocked, noopLog, { unknownScriptPolicy: 'block' }),
            'unresolvable-script',
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
