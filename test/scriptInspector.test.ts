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

test('scriptInspector: inspects ./cleanup.sh without arguments', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        const scriptPath = path.join(tmpDir, 'cleanup.sh');
        fs.writeFileSync(scriptPath, '#!/bin/bash\nrm -rf /tmp/target\n');

        const hit = inspectCommand('./cleanup.sh', [tmpDir], blocked, noopLog);
        assert.equal(hit, 'rm -rf');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scriptInspector: unwraps execution wrappers like sudo, env, and env vars', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        const scriptPath = path.join(tmpDir, 'cleanup.sh');
        fs.writeFileSync(scriptPath, '#!/bin/bash\nrm -rf /tmp/target\n');

        assert.equal(inspectCommand('sudo bash cleanup.sh', [tmpDir], blocked, noopLog), 'rm -rf');
        assert.equal(inspectCommand('env bash cleanup.sh', [tmpDir], blocked, noopLog), 'rm -rf');
        assert.equal(inspectCommand('NODE_ENV=production sudo bash cleanup.sh', [tmpDir], blocked, noopLog), 'rm -rf');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scriptInspector: follows nested child scripts invoked from a script', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        const childPath = path.join(tmpDir, 'child.sh');
        fs.writeFileSync(childPath, '#!/bin/bash\nrm -rf /data\n');

        const parentPath = path.join(tmpDir, 'parent.sh');
        fs.writeFileSync(parentPath, '#!/bin/bash\necho "Running child"\nbash child.sh\n');

        assert.equal(inspectCommand('bash parent.sh', [tmpDir], blocked, noopLog), 'rm -rf');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scriptInspector: inspects Python package initialization (__init__.py)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        const pkgDir = path.join(tmpDir, 'cleanpkg');
        fs.mkdirSync(pkgDir);
        fs.writeFileSync(path.join(pkgDir, '__init__.py'), 'import os\nos.system("rm -rf /")\n');

        const mainPy = path.join(tmpDir, 'main.py');
        fs.writeFileSync(mainPy, 'import cleanpkg\nprint("started")\n');

        assert.equal(inspectCommand('python main.py', [tmpDir], blocked, noopLog), 'rm -rf /');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scriptInspector: detects aliased destructive imports in Python', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        const pyPath = path.join(tmpDir, 'aliased.py');
        fs.writeFileSync(pyPath, 'from shutil import rmtree\nrmtree("/data")\n');

        assert.equal(inspectCommand('python aliased.py', [tmpDir], blocked, noopLog), 'shutil.rmtree');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scriptInspector: follows JavaScript require("./cleanup.js") and aliased imports', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        const depPath = path.join(tmpDir, 'cleanup.js');
        fs.writeFileSync(depPath, 'const { rmSync } = require("fs");\nrmSync("./data", { recursive: true });\n');

        const mainJs = path.join(tmpDir, 'main.js');
        fs.writeFileSync(mainJs, 'require("./cleanup.js");\nconsole.log("running");\n');

        assert.equal(inspectCommand('node main.js', [tmpDir], blocked, noopLog), 'fs.rmSync');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scriptInspector: inspects npm lifecycle hooks (prebuild, postbuild)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        const pkgPath = path.join(tmpDir, 'package.json');
        fs.writeFileSync(pkgPath, JSON.stringify({
            name: 'hook-pkg',
            scripts: {
                prebuild: 'rm -rf dist',
                build: 'echo "compiling"',
            },
        }));

        assert.equal(inspectCommand('npm run build', [tmpDir], blocked, noopLog), 'rm -rf');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scriptInspector: guards against cycles in npm script recursion', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        const pkgPath = path.join(tmpDir, 'package.json');
        fs.writeFileSync(pkgPath, JSON.stringify({
            name: 'cycle-pkg',
            scripts: {
                a: 'npm run b',
                b: 'npm run a',
            },
        }));

        // Does not infinite loop or stack overflow
        assert.equal(inspectCommand('npm run a', [tmpDir], blocked, noopLog), null);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scriptInspector: unknownScriptPolicy blocks depth-exceeded, oversized, unresolvable, and unreadable', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        // 1. Unresolvable
        assert.equal(
            inspectCommand('bash nonexistent.sh', [tmpDir], blocked, noopLog, { unknownScriptPolicy: 'warn' }),
            null,
        );
        assert.equal(
            inspectCommand('bash nonexistent.sh', [tmpDir], blocked, noopLog, { unknownScriptPolicy: 'block' }),
            'unresolvable-script',
        );

        // 2. Oversized script (>64 KB)
        const hugePath = path.join(tmpDir, 'huge.sh');
        const hugeBuf = Buffer.alloc(70_000, 32); // 70 KB of spaces
        fs.writeFileSync(hugePath, hugeBuf);
        assert.equal(
            inspectCommand('bash huge.sh', [tmpDir], blocked, noopLog, { unknownScriptPolicy: 'block' }),
            'oversized-script',
        );
        assert.equal(
            inspectCommand('bash huge.sh', [tmpDir], blocked, noopLog, { unknownScriptPolicy: 'warn' }),
            null,
        );

        // 3. Depth exceeded
        let prev = 'depth_base.sh';
        fs.writeFileSync(path.join(tmpDir, prev), '#!/bin/bash\necho ok\n');
        for (let i = 1; i <= 5; i++) {
            const next = `depth_${i}.sh`;
            fs.writeFileSync(path.join(tmpDir, next), `#!/bin/bash\nbash ${prev}\n`);
            prev = next;
        }
        assert.equal(
            inspectCommand(`bash depth_5.sh`, [tmpDir], blocked, noopLog, { unknownScriptPolicy: 'block' }),
            'depth-exceeded',
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scriptInspector: resolves relative paths using working directory cwd', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        const subDir = path.join(tmpDir, 'subdir');
        fs.mkdirSync(subDir);
        fs.writeFileSync(path.join(subDir, 'local.sh'), '#!/bin/bash\nrm -rf /tmp/local\n');

        // Path resolved against cwd (subDir), even if not in workspace root directly
        assert.equal(
            inspectCommand('bash local.sh', [tmpDir], blocked, noopLog, {}, subDir),
            'rm -rf',
        );
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

test('scriptInspector: inspects compound commands joined by &&, ||, ;, and |', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        const scriptPath = path.join(tmpDir, 'cleanup.sh');
        fs.writeFileSync(scriptPath, '#!/bin/bash\nrm -rf /tmp/target\n');

        assert.equal(inspectCommand('echo ok && bash cleanup.sh', [tmpDir], blocked, noopLog), 'rm -rf');
        assert.equal(inspectCommand('false || bash cleanup.sh', [tmpDir], blocked, noopLog), 'rm -rf');
        assert.equal(inspectCommand('echo done; bash cleanup.sh', [tmpDir], blocked, noopLog), 'rm -rf');
        assert.equal(inspectCommand('cat safe.txt | bash cleanup.sh', [tmpDir], blocked, noopLog), 'rm -rf');
        assert.equal(inspectCommand('echo ok && echo safe', [tmpDir], blocked, noopLog), null);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scriptInspector: inspects python -m <module> invocation', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        const cleanupPy = path.join(tmpDir, 'cleanup.py');
        fs.writeFileSync(cleanupPy, 'import shutil\nshutil.rmtree("./fixture")\n');

        assert.equal(inspectCommand('python -m cleanup', [tmpDir], blocked, noopLog), 'shutil.rmtree');
        assert.equal(inspectCommand('python3 -m cleanup', [tmpDir], blocked, noopLog), 'shutil.rmtree');

        // Package with __main__.py
        const pkgDir = path.join(tmpDir, 'mypkg');
        fs.mkdirSync(pkgDir);
        fs.writeFileSync(path.join(pkgDir, '__main__.py'), 'import shutil\nshutil.rmtree("./data")\n');

        assert.equal(inspectCommand('python -m mypkg', [tmpDir], blocked, noopLog), 'shutil.rmtree');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scriptInspector: inspects inline code execution via -c and -e', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        assert.equal(
            inspectCommand('python -c "import shutil; shutil.rmtree(\'./fixture\')"', [tmpDir], blocked, noopLog),
            'shutil.rmtree',
        );
        assert.equal(
            inspectCommand('python3 -c "from shutil import rmtree; rmtree(\'./fixture\')"', [tmpDir], blocked, noopLog),
            'shutil.rmtree',
        );
        assert.equal(
            inspectCommand('node -e "const fs = require(\'fs\'); fs.rmSync(\'./fixture\', {recursive:true})"', [tmpDir], blocked, noopLog),
            'fs.rmSync',
        );
        assert.equal(
            inspectCommand('bash -c "rm -rf ./fixture"', [tmpDir], blocked, noopLog),
            'rm -rf',
        );
        assert.equal(
            inspectCommand('python -c "print(\'hello safe world\')"', [tmpDir], blocked, noopLog),
            null,
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scriptInspector: unwraps sudo with flags like -u root', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-test-'));
    try {
        const scriptPath = path.join(tmpDir, 'cleanup.sh');
        fs.writeFileSync(scriptPath, '#!/bin/bash\nrm -rf /tmp/target\n');

        assert.equal(inspectCommand('sudo -u root bash cleanup.sh', [tmpDir], blocked, noopLog), 'rm -rf');
        assert.equal(inspectCommand('sudo -u root -g admin env FOO=1 bash cleanup.sh', [tmpDir], blocked, noopLog), 'rm -rf');
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
