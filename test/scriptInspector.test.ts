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
