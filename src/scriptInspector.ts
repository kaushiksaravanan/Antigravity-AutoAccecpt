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
    if (!commandLine || !commandLine.trim()) {
        return null;
    }

    const effectiveCwd = cwd || options.cwd;

    // Handle compound commands (echo ok && bash cleanup.sh; del fixture.txt)
    const segments = splitCompoundCommand(commandLine);
    if (segments.length > 1) {
        for (const segment of segments) {
            const hit = inspectCommand(segment, workspaceFolders, blockedPatterns, log, options, effectiveCwd);
            if (hit) {
                return hit;
            }
        }
        return null;
    }

    let tokens = tokenize(commandLine);
    if (!tokens.length) {
        return null;
    }

    tokens = unwrapExecutionTokens(tokens);
    if (!tokens.length) {
        return null;
    }

    const cmd = baseName(tokens[0]).toLowerCase();
    const visited = new Set<string>();

    // Handle: python -m cleanup / python3 -m pkg.module
    if ((cmd === 'python' || cmd === 'python3') && tokens.includes('-m')) {
        const mIdx = tokens.indexOf('-m');
        if (mIdx !== -1 && mIdx + 1 < tokens.length) {
            const modArg = tokens[mIdx + 1];
            const modRelPath = modArg.replace(/\./g, '/');
            const parts = modArg.split('.');
            const candidates = [
                `${modRelPath}.py`,
                path.join(modRelPath, '__main__.py'),
                path.join(modRelPath, '__init__.py'),
            ];
            // Also check package initializers for dotted modules (e.g. pkg/__init__.py for pkg.main)
            if (parts.length > 1) {
                candidates.push(path.join(parts[0], '__init__.py'));
            }
            for (const cand of candidates) {
                const resolved = resolveFilePath(cand, workspaceFolders, effectiveCwd);
                if (resolved) {
                    const hit = inspectFile(resolved, workspaceFolders, blockedPatterns, log, options, visited, 0, effectiveCwd);
                    if (hit) return hit;
                }
            }
            if (options.unknownScriptPolicy === 'block') {
                return 'unresolvable-script';
            }
            return null;
        }
    }

    // Handle inline script execution: python -c "...", node -e "...", bash -c "..."
    const inlineFlagIdx = tokens.findIndex((t, idx) => idx > 0 && (t === '-c' || t === '-e' || t === '-lc'));
    if (inlineFlagIdx !== -1 && inlineFlagIdx + 1 < tokens.length) {
        const inlineCode = tokens[inlineFlagIdx + 1];
        return inspectInlineCode(cmd, inlineCode, workspaceFolders, blockedPatterns, log, options, effectiveCwd);
    }

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

    // Handle extensionless executables (e.g., ./cleanup, /bin/cleanup)
    if (tokens[0].startsWith('./') || tokens[0].startsWith('.\\') || path.isAbsolute(tokens[0])) {
        const resolved = resolveFilePath(tokens[0], workspaceFolders, effectiveCwd);
        if (resolved && fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
            return inspectFile(resolved, workspaceFolders, blockedPatterns, log, options, visited, 0, effectiveCwd);
        }
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

function splitCompoundCommand(text: string): string[] {
    const parts: string[] = [];
    let current = '';
    let quote = '';
    let parenDepth = 0;

    for (let i = 0; i < text.length; i++) {
        const ch = text.charAt(i);

        if (ch === '\\' && i + 1 < text.length && !quote) {
            current += ch + text.charAt(i + 1);
            i++;
            continue;
        }

        if (quote) {
            if (ch === quote) {
                quote = '';
            }
            current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }

        if (ch === '(') {
            parenDepth++;
            current += ch;
            continue;
        }
        if (ch === ')' && parenDepth > 0) {
            parenDepth--;
            current += ch;
            continue;
        }

        if (parenDepth === 0) {
            if ((ch === '&' && text.charAt(i + 1) === '&') || (ch === '|' && text.charAt(i + 1) === '|')) {
                if (current.trim()) {
                    parts.push(current.trim());
                }
                current = '';
                i++;
                continue;
            }
            if (ch === ';' || ch === '&' || ch === '|') {
                if (current.trim()) {
                    parts.push(current.trim());
                }
                current = '';
                continue;
            }
        }

        current += ch;
    }

    if (current.trim()) {
        parts.push(current.trim());
    }

    return parts.length > 1 ? parts : [text.trim()];
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
    while (current.length && depth < 8) {
        const head = current[0].toLowerCase();
        if (head === 'sudo') {
            let s = 1;
            while (s < current.length) {
                const tok = current[s];
                if (tok === '-u' || tok === '-g' || tok === '-h' || tok === '-p' || tok === '-C' || tok === '-r') {
                    s += 2;
                    continue;
                }
                if (tok.startsWith('-')) {
                    s += 1;
                    continue;
                }
                break;
            }
            current = s < current.length ? current.slice(s) : current.slice(1);
            depth++;
            continue;
        }
        if (head === 'env') {
            let s = 1;
            while (s < current.length) {
                const tok = current[s];
                if (tok === '-u' || tok === '-C' || tok === '-S') {
                    s += 2;
                    continue;
                }
                if (tok.startsWith('-') || tok.includes('=')) {
                    s += 1;
                    continue;
                }
                break;
            }
            current = s < current.length ? current.slice(s) : current.slice(1);
            depth++;
            continue;
        }
        if (head === 'nohup' || head === 'time' || head === 'nice' || head === 'command' || head === 'eval' || head === 'exec') {
            let s = 1;
            while (s < current.length && current[s].startsWith('-')) {
                s++;
            }
            current = s < current.length ? current.slice(s) : current.slice(1);
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

function inspectInlineCode(
    cmd: string,
    code: string,
    workspaceFolders: readonly string[],
    blockedPatterns: readonly string[],
    log: (message: string) => void,
    options: ScriptInspectorOptions,
    cwd?: string,
): string | null {
    // Check 1: direct blocked patterns in inline code
    const hit = findBlockedPattern(code, blockedPatterns);
    if (hit) {
        log(`Script inspector: blocked pattern "${hit}" found in inline code`);
        return hit;
    }

    // Check 2: destructive language APIs
    for (const api of DESTRUCTIVE_APIS) {
        if (api.regex.test(code)) {
            log(`Script inspector: destructive native API "${api.label}" found in inline code`);
            return api.label;
        }
    }

    // Check 3: aliased imports in inline Python code
    if (cmd === 'python' || cmd === 'python3') {
        const pyHit = checkPythonAliasedImports(code);
        if (pyHit) {
            log(`Script inspector: aliased "${pyHit}" found in inline Python code`);
            return pyHit;
        }

        // Inline Python module imports: python -c "import cleanup" or from cleanup import ...
        const importRegex = /(?:^\s*import\s+|^\s*from\s+\.?)([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)/gm;
        let m: RegExpExecArray | null;
        while ((m = importRegex.exec(code)) !== null) {
            const rawImport = m[1];
            const parts = rawImport.split('.');
            const candidates = [
                rawImport.replace(/\./g, '/') + '.py',
                path.join(rawImport.replace(/\./g, '/'), '__init__.py'),
                parts[0] + '.py',
                path.join(parts[0], '__init__.py'),
            ];
            for (const cand of candidates) {
                const resolved = resolveFilePath(cand, workspaceFolders, cwd);
                if (resolved) {
                    const hit = inspectFile(resolved, workspaceFolders, blockedPatterns, log, options, new Set<string>(), 1, cwd);
                    if (hit) return hit;
                }
            }
        }
    }

    // Check 4: aliased imports in inline JavaScript code
    if (cmd === 'node') {
        const jsHit = checkJsAliasedImports(code);
        if (jsHit) {
            log(`Script inspector: aliased "${jsHit}" found in inline JS code`);
            return jsHit;
        }

        // Inline JS dependencies: node -e "require('./cleanup.js')"
        const jsDepRegex = /(?:require\s*\(\s*['"]([^'"]+)['"]\s*\)|from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"])/g;
        let m: RegExpExecArray | null;
        while ((m = jsDepRegex.exec(code)) !== null) {
            const depPath = (m[1] || m[2] || m[3] || m[4] || '').trim();
            if (depPath.startsWith('.')) {
                const base = cwd || (workspaceFolders[0] ?? '.');
                const candidateBase = path.resolve(base, depPath);
                const candidates = [
                    candidateBase,
                    `${candidateBase}.js`,
                    `${candidateBase}.mjs`,
                    `${candidateBase}.cjs`,
                    path.join(candidateBase, 'index.js'),
                ];
                for (const cand of candidates) {
                    if (fs.existsSync(cand) && !fs.statSync(cand).isDirectory()) {
                        const hit = inspectFile(cand, workspaceFolders, blockedPatterns, log, options, new Set<string>(), 1, cwd);
                        if (hit) return hit;
                    }
                }
            }
        }
    }

    // Check 5: if bash/sh/zsh inline code, inspect as nested subcommands
    if (cmd === 'bash' || cmd === 'sh' || cmd === 'zsh') {
        const subHit = inspectCommand(code, workspaceFolders, blockedPatterns, log, options, cwd);
        if (subHit) {
            return subHit;
        }
    }

    return null;
}

function checkPythonAliasedImports(content: string): string | null {
    // direct rmtree from shutil: from shutil import rmtree; rmtree()
    if (/(?:from\s+shutil\s+import\s+[^;#\n\r]*\brmtree\b|from\s+shutil\s+import\s+\*)/.test(content) && /\brmtree\s*\(/.test(content)) {
        return 'shutil.rmtree';
    }
    // aliased rmtree: from shutil import rmtree as <alias>; <alias>()
    const aliasRmtreeMatch = /from\s+shutil\s+import\s+rmtree\s+as\s+([a-zA-Z0-9_]+)/.exec(content);
    if (aliasRmtreeMatch && new RegExp(`\\b${aliasRmtreeMatch[1]}\\s*\\(`).test(content)) {
        return 'shutil.rmtree';
    }
    // aliased module: import shutil as <alias>; <alias>.rmtree()
    const aliasModMatch = /import\s+shutil\s+as\s+([a-zA-Z0-9_]+)/.exec(content);
    if (aliasModMatch && new RegExp(`\\b${aliasModMatch[1]}\\.rmtree\\s*\\(`).test(content)) {
        return 'shutil.rmtree';
    }
    // direct os.remove / unlink / rmdir
    if (/(?:from\s+os\s+import\s+[^;#\n\r]*\b(remove|unlink|rmdir)\b|from\s+os\s+import\s+\*)/.test(content) && /\b(remove|unlink|rmdir)\s*\(/.test(content)) {
        return 'os.remove';
    }
    // aliased os.remove: from os import remove as <alias>; <alias>()
    const aliasOsMatch = /from\s+os\s+import\s+(?:remove|unlink|rmdir)\s+as\s+([a-zA-Z0-9_]+)/.exec(content);
    if (aliasOsMatch && new RegExp(`\\b${aliasOsMatch[1]}\\s*\\(`).test(content)) {
        return 'os.remove';
    }
    // aliased os module: import os as <alias>; <alias>.remove()
    const aliasOsMod = /import\s+os\s+as\s+([a-zA-Z0-9_]+)/.exec(content);
    if (aliasOsMod && new RegExp(`\\b${aliasOsMod[1]}\\.(remove|unlink|rmdir)\\s*\\(`).test(content)) {
        return 'os.remove';
    }
    return null;
}

function checkJsAliasedImports(content: string): string | null {
    if (/(?:import\s*\{[^}]*\b(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\b[^}]*\}\s*from\s*['"]fs['"]|const\s*\{[^}]*\b(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\b[^}]*\}\s*=\s*require\s*\(\s*['"]fs['"]\s*\))/.test(content)) {
        return 'fs.rmSync';
    }
    const aliasFsMatch = /(?:(?:import\s*\{[^}]*\b(?:rm|rmSync)\s+as\s+([a-zA-Z0-9_]+)[^}]*\}\s*from\s*['"]fs['"])|(?:const\s*\{[^}]*\b(?:rm|rmSync)\s*:\s*([a-zA-Z0-9_]+)[^}]*\}\s*=\s*require\s*\(\s*['"]fs['"]\s*\)))/.exec(content);
    const aliasName = aliasFsMatch ? (aliasFsMatch[1] || aliasFsMatch[2]) : null;
    if (aliasName && new RegExp(`\\b${aliasName}\\s*\\(`).test(content)) {
        return 'fs.rmSync';
    }
    if (/\b(rmSync|rmdirSync)\s*\(/.test(content)) {
        return 'fs.rmSync';
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
            const pyHit = checkPythonAliasedImports(content);
            if (pyHit) {
                log(`Script inspector: aliased "${pyHit}" found in "${resolved}"`);
                return pyHit;
            }
        }

        if (/\.(js|mjs|cjs|ts)$/i.test(resolved)) {
            const jsHit = checkJsAliasedImports(content);
            if (jsHit) {
                log(`Script inspector: aliased "${jsHit}" found in "${resolved}"`);
                return jsHit;
            }
        }

        // Check 4: check sourced shell scripts (source <file> or . <file>)
        const scriptDir = path.dirname(resolved);
        const sourceRegex = /(?:^\s*source\s+|^\s*\.\s+)([^\s;&|]+)/gm;
        while ((match = sourceRegex.exec(content)) !== null) {
            const sourcedTarget = match[1].trim().replace(/^['"]|['"]$/g, '');
            if (sourcedTarget && !sourcedTarget.startsWith('$')) {
                // Sourced scripts in shell look in cwd first, then scriptDir
                let nestedResolved = path.isAbsolute(sourcedTarget) ? sourcedTarget : null;
                if (!nestedResolved && cwd) {
                    const fromCwd = path.resolve(cwd, sourcedTarget);
                    if (fs.existsSync(fromCwd)) nestedResolved = fromCwd;
                }
                if (!nestedResolved) {
                    nestedResolved = path.resolve(scriptDir, sourcedTarget);
                }
                const nestedHit = inspectFile(nestedResolved, workspaceFolders, blockedPatterns, log, options, visited, depth + 1, cwd || scriptDir);
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
                // Child scripts inherit shell execution cwd
                let nestedResolved = path.isAbsolute(childTarget) ? childTarget : null;
                if (!nestedResolved && cwd) {
                    const fromCwd = path.resolve(cwd, childTarget);
                    if (fs.existsSync(fromCwd)) nestedResolved = fromCwd;
                }
                if (!nestedResolved) {
                    nestedResolved = path.resolve(scriptDir, childTarget);
                }
                const nestedHit = inspectFile(nestedResolved, workspaceFolders, blockedPatterns, log, options, visited, depth + 1, cwd || scriptDir);
                if (nestedHit) {
                    log(`Script inspector: child script "${childTarget}" has blocked pattern "${nestedHit}"`);
                    return nestedHit;
                }
            }
        }

        // Check 6: check local Python imports (import <mod> or from <mod> import, including packages and dotted paths)
        if (resolved.endsWith('.py')) {
            const importRegex = /(?:^\s*import\s+|^\s*from\s+\.?)([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)/gm;
            while ((match = importRegex.exec(content)) !== null) {
                const fullImport = match[1];
                const parts = fullImport.split('.');
                const modRelPath = fullImport.replace(/\./g, '/');
                const candidates = [
                    path.resolve(scriptDir, `${modRelPath}.py`),
                    path.resolve(scriptDir, modRelPath, '__init__.py'),
                    path.resolve(scriptDir, `${parts[0]}.py`),
                    path.resolve(scriptDir, parts[0], '__init__.py'),
                ];
                for (const targetMod of candidates) {
                    if (fs.existsSync(targetMod) && !fs.statSync(targetMod).isDirectory()) {
                        const nestedHit = inspectFile(targetMod, workspaceFolders, blockedPatterns, log, options, visited, depth + 1, scriptDir);
                        if (nestedHit) {
                            log(`Script inspector: imported local module "${fullImport}" has blocked pattern "${nestedHit}"`);
                            return nestedHit;
                        }
                    }
                }
            }
        }

        // Check 7: check local JavaScript / Node dependencies (require("./cleanup") or import ... from "./cleanup" or import "./cleanup.mjs")
        if (/\.(js|mjs|cjs|ts)$/i.test(resolved)) {
            const jsDepRegex = /(?:require\s*\(\s*['"]([^'"]+)['"]\s*\)|from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"])/g;
            while ((match = jsDepRegex.exec(content)) !== null) {
                const depPath = (match[1] || match[2] || match[3] || match[4] || '').trim();
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
