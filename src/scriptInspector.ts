import * as fs from 'fs';
import * as path from 'path';
import { findBlockedPattern } from './blocked';

const MAX_SCRIPT_SIZE = 65_536; // 64 KB

export interface ScriptInspectorOptions {
    unknownScriptPolicy?: 'warn' | 'block';
    cwd?: string;
    visitedNpmScripts?: Set<string>;
}

/**
 * Inspects a terminal command for indirect destructive operations.
 * If the command invokes a script file (bash, python, node, npm run, etc.),
 * reads the script contents and checks for blocked patterns and native deletion APIs.
 *
 * @returns The matched blocked pattern, or null if safe / uninspectable.
 */
export function inspectCommand(
    commandLine: string,
    workspaceFolders: readonly string[],
    blockedPatterns: readonly string[],
    log: (message: string) => void,
    options: ScriptInspectorOptions = {},
    cwd?: string,
): string | null {
    let tokens = tokenize(commandLine);
    if (!tokens.length) {
        return null;
    }

    tokens = unwrapExecutionTokens(tokens);
    if (!tokens.length) {
        return null;
    }

    const effectiveCwd = cwd || options.cwd;
    const cmd = baseName(tokens[0]).toLowerCase();
    const visited = new Set<string>();

    // Handle: bash script.sh, python script.py, node script.js, etc.
    if (isScriptInterpreter(cmd)) {
        const scriptPath = findPositionalArg(tokens);
        if (scriptPath) {
            return inspectFile(scriptPath, workspaceFolders, blockedPatterns, log, options, visited, 0, effectiveCwd);
        }
        return null;
    }

    // Handle: npm run <script>, npx <script>
    if (cmd === 'npm' && tokens.length >= 3) {
        const sub = tokens[1].toLowerCase();
        if (sub === 'run' || sub === 'run-script') {
            return inspectNpmScript(tokens[2], workspaceFolders, blockedPatterns, log, options, options.visitedNpmScripts ?? new Set<string>(), effectiveCwd);
        }
    }
    if ((cmd === 'yarn' || cmd === 'pnpm') && tokens.length >= 2 && !tokens[1].startsWith('-')) {
        return inspectNpmScript(tokens[1], workspaceFolders, blockedPatterns, log, options, options.visitedNpmScripts ?? new Set<string>(), effectiveCwd);
    }

    // Handle: ./script.sh, ./cleanup.py, script.sh (direct executable scripts, with or without args)
    if (/\.(sh|bash|py|js|mjs|rb|pl)$/i.test(tokens[0])) {
        return inspectFile(tokens[0], workspaceFolders, blockedPatterns, log, options, visited, 0, effectiveCwd);
    }

    return null;
}

// ── Helpers ──────────────────────────────────────────────────────────

const SCRIPT_INTERPRETERS = new Set([
    'bash', 'sh', 'zsh', 'dash', 'fish',
    'python', 'python3',
    'node',
    'ruby', 'perl',
]);

const DESTRUCTIVE_APIS: Array<{ regex: RegExp; label: string }> = [
    { regex: /\bshutil\.rmtree\s*\(/i, label: 'shutil.rmtree' },
    { regex: /\bos\.(remove|unlink|rmdir)\s*\(/i, label: 'os.remove' },
    { regex: /\bfs(\.promises)?\.(rm|unlink|rmdir)(Sync)?\s*\(/i, label: 'fs.rmSync' },
    { regex: /\bRemove-Item\b/i, label: 'Remove-Item' },
];

function isScriptInterpreter(cmd: string): boolean {
    return SCRIPT_INTERPRETERS.has(cmd);
}

function tokenize(text: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let quote = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text.charAt(i);
        if (quote) {
            if (ch === quote) {
                quote = '';
            } else {
                current += ch;
            }
            continue;
        }
        if (ch === '\\' && i + 1 < text.length && !quote) {
            const nextCh = text.charAt(i + 1);
            if (nextCh === ' ' || nextCh === '\t' || nextCh === '"' || nextCh === "'" || nextCh === '\\') {
                i++;
                current += nextCh;
                continue;
            }
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === ' ' || ch === '\t') {
            if (current) {
                tokens.push(current);
            }
            current = '';
            continue;
        }
        current += ch;
    }
    if (current) {
        tokens.push(current);
    }
    return tokens;
}

function unwrapExecutionTokens(tokens: string[]): string[] {
    let current = tokens;
    let depth = 0;
    while (current.length && depth < 6) {
        const head = current[0].toLowerCase();
        if (head === 'sudo' || head === 'env' || head === 'nohup' || head === 'time' || head === 'nice' || head === 'command') {
            current = current.slice(1);
            depth++;
            continue;
        }
        if (/^[a-z_][a-z0-9_]*=/i.test(current[0])) {
            current = current.slice(1);
            depth++;
            continue;
        }
        break;
    }
    return current;
}

function baseName(filePath: string): string {
    let base = filePath;
    const isPath = base.indexOf('/') !== -1 || base.indexOf(':') !== -1 ||
                 (base.indexOf('\\') !== -1 && base.indexOf('\\') !== base.lastIndexOf('\\')) ||
                 base.indexOf('.\\') === 0 || base.indexOf('..\\') === 0;
    if (isPath) {
        const slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
        if (slash >= 0) base = base.slice(slash + 1);
    } else {
        base = base.replace(/\\/g, '');
    }
    return base.replace(/\.(exe|com|cmd|bat|ps1)$/i, '');
}

/** Finds the first non-flag token after the command name. */
function findPositionalArg(tokens: string[]): string | null {
    for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === '-c' || t === '-e' || t === '-m') {
            return null;
        }
        if (t.startsWith('-')) {
            continue;
        }
        return t;
    }
    return null;
}

function inspectFile(
    filePath: string,
    workspaceFolders: readonly string[],
    blockedPatterns: readonly string[],
    log: (message: string) => void,
    options: ScriptInspectorOptions = {},
    visited: Set<string> = new Set<string>(),
    depth: number = 0,
    cwd?: string,
): string | null {
    if (depth > 3) {
        log(`Script inspector: recursion depth limit exceeded for "${filePath}"`);
        if (options.unknownScriptPolicy === 'block') {
            return 'depth-exceeded';
        }
        return null;
    }
    const resolved = resolveFilePath(filePath, workspaceFolders, cwd);
    if (!resolved) {
        log(`Script inspector: cannot resolve path "${filePath}"`);
        if (options.unknownScriptPolicy === 'block') {
            return 'unresolvable-script';
        }
        return null;
    }

    if (visited.has(resolved)) {
        return null;
    }
    visited.add(resolved);

    try {
        const stat = fs.statSync(resolved);
        if (stat.size > MAX_SCRIPT_SIZE) {
            log(`Script inspector: "${resolved}" exceeds ${MAX_SCRIPT_SIZE} bytes, skipping`);
            if (options.unknownScriptPolicy === 'block') {
                return 'oversized-script';
            }
            return null;
        }
        const content = fs.readFileSync(resolved, 'utf8');

        // Check 1: direct blocklist check on the file content (for shell scripts)
        let hit = findBlockedPattern(content, blockedPatterns);
        if (hit) {
            log(`Script inspector: blocked pattern "${hit}" found in "${resolved}"`);
            return hit;
        }

        // Check 2: check string literals inside the script (for python/node/etc. invoking shell commands)
        const stringLiteralRegex = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
        let match: RegExpExecArray | null;
        while ((match = stringLiteralRegex.exec(content)) !== null) {
            const raw = match[0];
            const unquoted = raw.slice(1, -1).trim();
            if (unquoted) {
                hit = findBlockedPattern(unquoted, blockedPatterns);
                if (hit) {
                    log(`Script inspector: blocked pattern "${hit}" found in string literal inside "${resolved}"`);
                    return hit;
                }
            }
        }

        // Check 3: check native language destructive APIs (shutil.rmtree, fs.rmSync, Remove-Item)
        for (const api of DESTRUCTIVE_APIS) {
            if (api.regex.test(content)) {
                log(`Script inspector: destructive native API "${api.label}" found in "${resolved}"`);
                return api.label;
            }
        }

        // Check 3b: check aliased destructive imports in Python and JS
        if (resolved.endsWith('.py')) {
            if (/(?:from\s+shutil\s+import\s+[^;#\n\r]*\brmtree\b|from\s+shutil\s+import\s+\*)/.test(content) && /\brmtree\s*\(/.test(content)) {
                log(`Script inspector: aliased "shutil.rmtree" found in "${resolved}"`);
                return 'shutil.rmtree';
            }
            if (/(?:from\s+os\s+import\s+[^;#\n\r]*\b(remove|unlink|rmdir)\b|from\s+os\s+import\s+\*)/.test(content) && /\b(remove|unlink|rmdir)\s*\(/.test(content)) {
                log(`Script inspector: aliased "os.remove" found in "${resolved}"`);
                return 'os.remove';
            }
        }

        if (/\.(js|mjs|cjs|ts)$/i.test(resolved)) {
            if (/(?:import\s*\{[^}]*\b(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\b[^}]*\}\s*from\s*['"]fs['"]|const\s*\{[^}]*\b(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\b[^}]*\}\s*=\s*require\s*\(\s*['"]fs['"]\s*\))/.test(content)) {
                log(`Script inspector: aliased "fs.rmSync" found in "${resolved}"`);
                return 'fs.rmSync';
            }
            if (/\b(rmSync|rmdirSync)\s*\(/.test(content)) {
                log(`Script inspector: direct "fs.rmSync" invocation found in "${resolved}"`);
                return 'fs.rmSync';
            }
        }

        // Check 4: check sourced shell scripts (source <file> or . <file>)
        const scriptDir = path.dirname(resolved);
        const sourceRegex = /(?:^\s*source\s+|^\s*\.\s+)([^\s;&|]+)/gm;
        while ((match = sourceRegex.exec(content)) !== null) {
            const sourcedTarget = match[1].trim().replace(/^['"]|['"]$/g, '');
            if (sourcedTarget && !sourcedTarget.startsWith('$')) {
                const nestedResolved = path.isAbsolute(sourcedTarget)
                    ? sourcedTarget
                    : path.resolve(scriptDir, sourcedTarget);
                const nestedHit = inspectFile(nestedResolved, workspaceFolders, blockedPatterns, log, options, visited, depth + 1, scriptDir);
                if (nestedHit) {
                    log(`Script inspector: nested sourced script "${sourcedTarget}" has blocked pattern "${nestedHit}"`);
                    return nestedHit;
                }
            }
        }

        // Check 5: check child script invocations (bash child.sh, ./child.sh, python child.py)
        const childScriptRegex = /(?:^|\s|;|&|\|)(?:bash|sh|zsh|python|python3|node)\s+([^\s;&|]+\.(sh|bash|py|js|mjs))|(?:^|\s|;|&|\|)(\.\/[^\s;&|]+\.(sh|bash|py|js|mjs))/gm;
        while ((match = childScriptRegex.exec(content)) !== null) {
            const childTarget = (match[1] || match[3] || '').trim().replace(/^['"]|['"]$/g, '');
            if (childTarget && !childTarget.startsWith('$')) {
                const nestedResolved = path.isAbsolute(childTarget)
                    ? childTarget
                    : path.resolve(scriptDir, childTarget);
                const nestedHit = inspectFile(nestedResolved, workspaceFolders, blockedPatterns, log, options, visited, depth + 1, scriptDir);
                if (nestedHit) {
                    log(`Script inspector: child script "${childTarget}" has blocked pattern "${nestedHit}"`);
                    return nestedHit;
                }
            }
        }

        // Check 6: check local Python imports (import <mod> or from <mod> import, including packages)
        if (resolved.endsWith('.py')) {
            const importRegex = /(?:^\s*import\s+|^\s*from\s+)([a-zA-Z0-9_]+)/gm;
            while ((match = importRegex.exec(content)) !== null) {
                const modName = match[1];
                const localModFile = path.resolve(scriptDir, `${modName}.py`);
                const localPkgInit = path.resolve(scriptDir, modName, '__init__.py');
                const targetMod = fs.existsSync(localModFile) ? localModFile : fs.existsSync(localPkgInit) ? localPkgInit : null;
                if (targetMod) {
                    const nestedHit = inspectFile(targetMod, workspaceFolders, blockedPatterns, log, options, visited, depth + 1, scriptDir);
                    if (nestedHit) {
                        log(`Script inspector: imported local module "${modName}" has blocked pattern "${nestedHit}"`);
                        return nestedHit;
                    }
                }
            }
        }

        // Check 7: check local JavaScript / Node dependencies (require("./cleanup") or import ... from "./cleanup")
        if (/\.(js|mjs|cjs|ts)$/i.test(resolved)) {
            const jsDepRegex = /(?:require\s*\(\s*['"]([^'"]+)['"]\s*\)|from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
            while ((match = jsDepRegex.exec(content)) !== null) {
                const depPath = (match[1] || match[2] || match[3] || '').trim();
                if (depPath.startsWith('.')) {
                    const candidateBase = path.resolve(scriptDir, depPath);
                    const candidates = [
                        candidateBase,
                        `${candidateBase}.js`,
                        `${candidateBase}.mjs`,
                        `${candidateBase}.cjs`,
                        `${candidateBase}.ts`,
                        path.join(candidateBase, 'index.js'),
                        path.join(candidateBase, 'index.ts'),
                    ];
                    for (const cand of candidates) {
                        if (fs.existsSync(cand) && !fs.statSync(cand).isDirectory()) {
                            const nestedHit = inspectFile(cand, workspaceFolders, blockedPatterns, log, options, visited, depth + 1, scriptDir);
                            if (nestedHit) {
                                log(`Script inspector: required local file "${depPath}" has blocked pattern "${nestedHit}"`);
                                return nestedHit;
                            }
                            break;
                        }
                    }
                }
            }
        }

        return null;
    } catch (err: unknown) {
        log(`Script inspector: cannot read "${resolved}": ${err instanceof Error ? err.message : String(err)}`);
        if (options.unknownScriptPolicy === 'block') {
            return 'unreadable-script';
        }
        return null;
    }
}

function inspectNpmScript(
    scriptName: string,
    workspaceFolders: readonly string[],
    blockedPatterns: readonly string[],
    log: (message: string) => void,
    options: ScriptInspectorOptions = {},
    visitedNpmScripts: Set<string> = options.visitedNpmScripts ?? new Set<string>(),
    cwd?: string,
): string | null {
    if (visitedNpmScripts.has(scriptName)) {
        return null;
    }
    visitedNpmScripts.add(scriptName);

    const subOptions: ScriptInspectorOptions = {
        ...options,
        visitedNpmScripts,
        cwd,
    };

    const foldersToSearch = cwd ? [cwd, ...workspaceFolders] : workspaceFolders;

    for (const folder of foldersToSearch) {
        const pkgPath = path.join(folder, 'package.json');
        try {
            const raw = fs.readFileSync(pkgPath, 'utf8');
            const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
            if (!pkg.scripts) {
                continue;
            }

            // Inspect lifecycle hooks: pre<script>, <script>, post<script>
            const scriptKeys = ['pre' + scriptName, scriptName, 'post' + scriptName];
            for (const key of scriptKeys) {
                const scriptCmd = pkg.scripts[key];
                if (!scriptCmd) {
                    continue;
                }

                // Check the script command text itself
                const hit = findBlockedPattern(scriptCmd, blockedPatterns);
                if (hit) {
                    log(`Script inspector: blocked pattern "${hit}" in npm script "${key}" (${pkgPath})`);
                    return hit;
                }

                // Check if the script command invokes a script file or another npm script
                const nested = inspectCommand(scriptCmd, workspaceFolders, blockedPatterns, log, subOptions, folder);
                if (nested) {
                    return nested;
                }
            }
        } catch {
            // package.json not found or not readable in this folder
        }
    }
    return null;
}

function resolveFilePath(filePath: string, workspaceFolders: readonly string[], cwd?: string): string | null {
    if (path.isAbsolute(filePath)) {
        return fs.existsSync(filePath) ? filePath : null;
    }
    if (cwd) {
        const resolved = path.resolve(cwd, filePath);
        if (fs.existsSync(resolved)) {
            return resolved;
        }
    }
    for (const folder of workspaceFolders) {
        const resolved = path.resolve(folder, filePath);
        if (fs.existsSync(resolved)) {
            return resolved;
        }
    }
    return null;
}
