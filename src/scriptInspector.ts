import * as fs from 'fs';
import * as path from 'path';
import { findBlockedPattern } from './blocked';

const MAX_SCRIPT_SIZE = 65_536; // 64 KB

/**
 * Inspects a terminal command for indirect destructive operations.
 * If the command invokes a script file (bash, python, node, npm run, etc.),
 * reads the script contents and checks for blocked patterns.
 *
 * @returns The matched blocked pattern, or null if safe / uninspectable.
 */
export interface ScriptInspectorOptions {
    unknownScriptPolicy?: 'warn' | 'block';
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
): string | null {
    const tokens = tokenize(commandLine);
    if (tokens.length < 2) {
        return null;
    }

    const cmd = baseName(tokens[0]).toLowerCase();
    const visited = new Set<string>();

    // Handle: bash script.sh, python script.py, node script.js, etc.
    if (isScriptInterpreter(cmd)) {
        const scriptPath = findPositionalArg(tokens);
        if (scriptPath) {
            return inspectFile(scriptPath, workspaceFolders, blockedPatterns, log, options, visited, 0);
        }
        return null;
    }

    // Handle: npm run <script>, npx <script>
    if (cmd === 'npm' && tokens.length >= 3) {
        const sub = tokens[1].toLowerCase();
        if (sub === 'run' || sub === 'run-script') {
            return inspectNpmScript(tokens[2], workspaceFolders, blockedPatterns, log, options);
        }
    }
    if ((cmd === 'yarn' || cmd === 'pnpm') && tokens.length >= 2 && !tokens[1].startsWith('-')) {
        return inspectNpmScript(tokens[1], workspaceFolders, blockedPatterns, log, options);
    }

    // Handle: ./script.sh, ./cleanup.py (direct executable scripts)
    if (/\.(sh|bash|py|js|mjs|rb|pl)$/i.test(tokens[0])) {
        return inspectFile(tokens[0], workspaceFolders, blockedPatterns, log, options, visited, 0);
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
    for (const ch of text) {
        if (quote) {
            if (ch === quote) {
                quote = '';
            } else {
                current += ch;
            }
            continue;
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

function baseName(filePath: string): string {
    const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    const base = slash >= 0 ? filePath.slice(slash + 1) : filePath;
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
): string | null {
    if (depth > 3) {
        return null;
    }
    const resolved = resolveFilePath(filePath, workspaceFolders);
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

        // Check 4: check sourced shell scripts (source <file> or . <file>)
        const scriptDir = path.dirname(resolved);
        const sourceRegex = /(?:^\s*source\s+|^\s*\.\s+)([^\s;&|]+)/gm;
        while ((match = sourceRegex.exec(content)) !== null) {
            const sourcedTarget = match[1].trim().replace(/^['"]|['"]$/g, '');
            if (sourcedTarget && !sourcedTarget.startsWith('$')) {
                const nestedResolved = path.isAbsolute(sourcedTarget)
                    ? sourcedTarget
                    : path.resolve(scriptDir, sourcedTarget);
                const nestedHit = inspectFile(nestedResolved, workspaceFolders, blockedPatterns, log, options, visited, depth + 1);
                if (nestedHit) {
                    log(`Script inspector: nested sourced script "${sourcedTarget}" has blocked pattern "${nestedHit}"`);
                    return nestedHit;
                }
            }
        }

        // Check 5: check local Python imports (import <mod> or from <mod> import)
        if (resolved.endsWith('.py')) {
            const importRegex = /(?:^\s*import\s+|^\s*from\s+)([a-zA-Z0-9_]+)/gm;
            while ((match = importRegex.exec(content)) !== null) {
                const modName = match[1];
                const localModPath = path.resolve(scriptDir, `${modName}.py`);
                if (fs.existsSync(localModPath)) {
                    const nestedHit = inspectFile(localModPath, workspaceFolders, blockedPatterns, log, options, visited, depth + 1);
                    if (nestedHit) {
                        log(`Script inspector: imported local module "${modName}" has blocked pattern "${nestedHit}"`);
                        return nestedHit;
                    }
                }
            }
        }

        return null;
    } catch (err: unknown) {
        log(`Script inspector: cannot read "${resolved}": ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}

function inspectNpmScript(
    scriptName: string,
    workspaceFolders: readonly string[],
    blockedPatterns: readonly string[],
    log: (message: string) => void,
    options: ScriptInspectorOptions = {},
): string | null {
    for (const folder of workspaceFolders) {
        const pkgPath = path.join(folder, 'package.json');
        try {
            const raw = fs.readFileSync(pkgPath, 'utf8');
            const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
            const scriptCmd = pkg.scripts?.[scriptName];
            if (!scriptCmd) {
                continue;
            }

            // Check the script command text itself
            const hit = findBlockedPattern(scriptCmd, blockedPatterns);
            if (hit) {
                log(`Script inspector: blocked pattern "${hit}" in npm script "${scriptName}" (${pkgPath})`);
                return hit;
            }

            // Recursively check if the npm script invokes another script file
            const nested = inspectCommand(scriptCmd, workspaceFolders, blockedPatterns, log, options);
            if (nested) {
                return nested;
            }
        } catch {
            // package.json not found or not readable in this folder
        }
    }
    return null;
}

function resolveFilePath(filePath: string, workspaceFolders: readonly string[]): string | null {
    if (path.isAbsolute(filePath)) {
        return fs.existsSync(filePath) ? filePath : null;
    }
    for (const folder of workspaceFolders) {
        const resolved = path.resolve(folder, filePath);
        if (fs.existsSync(resolved)) {
            return resolved;
        }
    }
    return null;
}

