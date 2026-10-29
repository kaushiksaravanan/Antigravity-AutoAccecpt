/**
 * One matcher shared by the extension host and the CDP page script.
 * The source is a string so the webview can run the same function.
 *
 * A single word matches the command name only (`del` matches `del file`, not `delta`).
 * Several words match that token sequence anywhere (`rm -rf`, `git push --force`).
 */
export const FIND_BLOCKED_SOURCE = String.raw`
function findBlockedPattern(text, patterns) {
    if (text == null || !patterns || !patterns.length) return '';
    var segments = splitCommandSegments(String(text));
    for (var i = 0; i < segments.length; i++) {
        var hit = matchSegment(segments[i], patterns, 0);
        if (hit) return hit;
    }
    return matchPhrases(String(text), patterns);
}

function splitCommandSegments(text) {
    var lines = text.split(/\r?\n/);
    var segments = [];
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var queue = [line];
        var seen = [];
        while (queue.length > 0) {
            var curr = queue.shift();
            if (!curr || seen.indexOf(curr) !== -1) continue;
            seen.push(curr);
            var subs = extractSubshells(curr);
            for (var s = 0; s < subs.length; s++) {
                queue.push(subs[s]);
                var subParts = splitOperators(subs[s]);
                for (var sp = 0; sp < subParts.length; sp++) {
                    if (subParts[sp].trim()) segments.push(subParts[sp]);
                }
            }
            var parts = splitOperators(curr);
            for (var j = 0; j < parts.length; j++) {
                if (parts[j].trim()) segments.push(parts[j]);
            }
        }
    }
    return segments;
}

function extractSubshells(text) {
    var subshells = [];
    var trimmed = text.trim();
    if (trimmed.length > 2 && trimmed.charAt(0) === '(' && trimmed.charAt(trimmed.length - 1) === ')') {
        subshells.push(trimmed.slice(1, -1));
    }
    // Extract $(...)
    var dollarIdx = 0;
    while ((dollarIdx = text.indexOf('$(', dollarIdx)) !== -1) {
        var depth = 1;
        var end = dollarIdx + 2;
        while (end < text.length && depth > 0) {
            var c = text.charAt(end);
            if (c === '(') depth++;
            else if (c === ')') depth--;
            end++;
        }
        if (depth === 0) {
            subshells.push(text.slice(dollarIdx + 2, end - 1));
            dollarIdx = end;
        } else {
            break;
        }
    }
    // Extract backtick command substitutions without literal backticks
    var bt = String.fromCharCode(96);
    var bIdx = 0;
    while ((bIdx = text.indexOf(bt, bIdx)) !== -1) {
        var bEnd = text.indexOf(bt, bIdx + 1);
        if (bEnd !== -1) {
            subshells.push(text.slice(bIdx + 1, bEnd));
            bIdx = bEnd + 1;
        } else {
            break;
        }
    }
    return subshells;
}

function splitOperators(line) {
    var parts = [];
    var current = '';
    var quote = '';
    for (var i = 0; i < line.length; i++) {
        var ch = line.charAt(i);
        if (quote) {
            current += ch;
            if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === ';') {
            parts.push(current);
            current = '';
            continue;
        }
        if ((ch === '|' && line.charAt(i + 1) === '|') || (ch === '&' && line.charAt(i + 1) === '&')) {
            parts.push(current);
            current = '';
            i++;
            continue;
        }
        if (ch === '&') {
            var prev = i > 0 ? line.charAt(i - 1) : '';
            var next = i + 1 < line.length ? line.charAt(i + 1) : '';
            if (prev !== '>' && next !== '>') {
                parts.push(current);
                current = '';
                continue;
            }
        }
        if (ch === '|') {
            parts.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    parts.push(current);
    return parts;
}

function tokenize(segment) {
    var tokens = [];
    var current = '';
    var quote = '';
    for (var i = 0; i < segment.length; i++) {
        var ch = segment.charAt(i);
        if (quote) {
            if (ch === quote) quote = '';
            else current += ch;
            continue;
        }
        if (ch === '\\' && i + 1 < segment.length && !quote) {
            var nextCh = segment.charAt(i + 1);
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
            if (current) tokens.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    if (current) tokens.push(current);
    return tokens;
}

function commandName(token) {
    var base = String(token);
    var isPath = base.indexOf('/') !== -1 || base.indexOf(':') !== -1 ||
                 (base.indexOf('\\') !== -1 && base.indexOf('\\') !== base.lastIndexOf('\\')) ||
                 base.indexOf('.\\') === 0 || base.indexOf('..\\') === 0;
    if (isPath) {
        var slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
        if (slash >= 0) base = base.slice(slash + 1);
    } else {
        base = base.replace(/\\/g, '');
    }
    return base.replace(/\.(exe|com|cmd|bat|ps1)$/i, '').toLowerCase();
}

function unwrap(tokens, depth) {
    if (!tokens.length || depth > 6) return tokens;
    var head = tokens[0].toLowerCase();
    if (head === '&' || head === '.' || head === '>' || head === '$' || head === '#' || head === '%') return unwrap(tokens.slice(1), depth + 1);
    if (head === 'sudo') {
        var s = 1;
        while (s < tokens.length) {
            var tok = tokens[s];
            if (tok === '-u' || tok === '-g' || tok === '-h' || tok === '-p') {
                s += 2;
                continue;
            }
            if (tok.indexOf('-') === 0) {
                s += 1;
                continue;
            }
            break;
        }
        if (s < tokens.length) return unwrap(tokens.slice(s), depth + 1);
        return unwrap(tokens.slice(1), depth + 1);
    }
    if (head === 'env' || head === 'command' || head === 'time' || head === 'nice' || head === 'nohup' || head === 'eval') {
        return unwrap(tokens.slice(1), depth + 1);
    }
    if (head === 'xargs') {
        return unwrap(afterFlag(tokens, ['-0', '-i', '-p', '-n', '-s', '-r', '-t', '-x']), depth + 1);
    }
    if (head === 'find') {
        for (var f = 1; f < tokens.length; f++) {
            if (tokens[f] === '-exec' || tokens[f] === '-execdir') {
                return unwrap(tokens.slice(f + 1), depth + 1);
            }
        }
    }
    if (/^[a-z_][a-z0-9_]*=/i.test(tokens[0])) return unwrap(tokens.slice(1), depth + 1);
    if (/^(pwsh|powershell)(\.exe)?$/i.test(head)) return unwrap(afterFlag(tokens, ['-command', '-c']), depth + 1);
    if (/^(cmd)(\.exe)?$/i.test(head)) return unwrap(afterFlag(tokens, ['/c', '-c']), depth + 1);
    if (/^(bash|sh|zsh|dash)$/i.test(head)) return unwrap(afterFlag(tokens, ['-c', '-lc']), depth + 1);
    return tokens;
}

function afterFlag(tokens, flags) {
    for (var i = 1; i < tokens.length; i++) {
        var flag = tokens[i].toLowerCase();
        if (flags.indexOf(flag) !== -1) return tokens.slice(i + 1);
        if (flag.charAt(0) !== '-' && flag.charAt(0) !== '/') return tokens.slice(i);
    }
    return [];
}

function unwrapGitGlobals(tokens) {
    var i = 1;
    while (i < tokens.length) {
        var t = tokens[i];
        if (t === '-C' || t === '-c' || t === '--git-dir' || t === '--work-tree' || t === '--namespace' || t === '--exec-path') {
            i += 2;
            continue;
        }
        if (t.indexOf('--git-dir=') === 0 || t.indexOf('--work-tree=') === 0 || (t.indexOf('-C') === 0 && t.length > 2)) {
            i += 1;
            continue;
        }
        if (t.indexOf('-') === 0 && t !== '--') {
            i += 1;
            continue;
        }
        break;
    }
    if (i > 1 && i < tokens.length) {
        return [tokens[0]].concat(tokens.slice(i));
    }
    return tokens;
}

function normalizeFlags(tokens) {
    if (tokens.length < 2) return tokens;
    var cmd = commandName(tokens[0]);
    tokens = [cmd].concat(tokens.slice(1));
    if (cmd === 'rm') return normalizeRm(tokens);
    if (cmd === 'cipher') {
        var cipherRes = [tokens[0]];
        for (var ci = 1; ci < tokens.length; ci++) {
            if (/^\/w(:.*)?$/i.test(tokens[ci])) {
                cipherRes.push('/w');
            } else {
                cipherRes.push(tokens[ci]);
            }
        }
        return cipherRes;
    }
    if (cmd === 'git') {
        var unwrappedGit = unwrapGitGlobals(tokens);
        if (unwrappedGit.length > 2) {
            if (unwrappedGit[1] === 'push') return normalizeGitPush(unwrappedGit);
            if (unwrappedGit[1] === 'clean') return normalizeGitClean(unwrappedGit);
        }
        return unwrappedGit;
    }
    return tokens;
}

function normalizeRm(tokens) {
    var hasR = false, hasF = false;
    var rest = [];
    for (var i = 1; i < tokens.length; i++) {
        var t = tokens[i];
        if (t === '--recursive') { hasR = true; continue; }
        if (t === '--force') { hasF = true; continue; }
        if (t.charAt(0) === '-' && t.charAt(1) !== '-' && t.length > 1) {
            for (var c = 1; c < t.length; c++) {
                if (t.charAt(c) === 'r') hasR = true;
                else if (t.charAt(c) === 'f') hasF = true;
            }
            continue;
        }
        rest.push(t);
    }
    var result = [tokens[0]];
    if (hasR && hasF) result.push('-rf');
    else if (hasR) result.push('-r');
    else if (hasF) result.push('-f');
    for (var j = 0; j < rest.length; j++) result.push(rest[j]);
    return result;
}

function normalizeGitPush(tokens) {
    var hasForce = false;
    var rest = [];
    for (var i = 2; i < tokens.length; i++) {
        var t = tokens[i];
        if (t === '-f' || t === '--force') {
            hasForce = true;
        } else {
            rest.push(t);
        }
    }
    var result = [tokens[0], tokens[1]];
    if (hasForce) result.push('--force');
    for (var j = 0; j < rest.length; j++) result.push(rest[j]);
    return result;
}

function normalizeGitClean(tokens) {
    var hasF = false, hasD = false;
    var rest = [];
    for (var i = 2; i < tokens.length; i++) {
        var t = tokens[i];
        if (t === '--force') { hasF = true; continue; }
        if (t.charAt(0) === '-' && t.charAt(1) !== '-' && t.length > 1) {
            for (var c = 1; c < t.length; c++) {
                if (t.charAt(c) === 'f') hasF = true;
                else if (t.charAt(c) === 'd') hasD = true;
            }
            continue;
        }
        rest.push(t);
    }
    var result = [tokens[0], tokens[1]];
    if (hasF && hasD) result.push('-fd');
    else if (hasF) result.push('-f');
    else if (hasD) result.push('-d');
    for (var j = 0; j < rest.length; j++) result.push(rest[j]);
    return result;
}

function patternTokens(pattern) {
    return tokenize(String(pattern || '')).map(function (token) { return token.toLowerCase(); });
}

function matchSegment(segment, patterns, depth) {
    if (depth > 8) return '';
    var tokens = unwrap(tokenize(segment), 0);
    if (tokens.length === 1 && /\s/.test(tokens[0])) {
        var hitNested = findBlockedPattern(tokens[0], patterns);
        if (hitNested) return hitNested;
        return matchSegment(tokens[0], patterns, depth + 1);
    }
    if (!tokens.length) return '';
    var head = commandName(tokens[0]);
    if (head === 'echo' || head === 'printf' || head === 'write-output' || head === 'print') {
        return '';
    }
    var lower = normalizeFlags(tokens.map(function (token) { return token.toLowerCase(); }));
    if (lower.length > 0) {
        lower[0] = commandName(lower[0]);
    }
    for (var p = 0; p < patterns.length; p++) {
        var expected = patternTokens(patterns[p]);
        if (!expected.length) continue;
        if (expected.length === 1) {
            if (head === expected[0]) return patterns[p];
            continue;
        }
        if (hasSequence(lower, expected)) return patterns[p];
    }
    return '';
}

function matchPhrases(text, patterns) {
    var tokens = tokenize(text);
    if (tokens.length > 0) {
        var head = commandName(tokens[0]);
        if (head === 'echo' || head === 'printf' || head === 'write-output' || head === 'print') {
            return '';
        }
    }
    var lower = tokens.map(function (token) { return token.toLowerCase(); });
    if (lower.length > 0) {
        lower[0] = commandName(lower[0]);
    }
    for (var p = 0; p < patterns.length; p++) {
        var expected = patternTokens(patterns[p]);
        if (expected.length < 2) continue;
        if (hasSequence(lower, expected)) return patterns[p];
    }
    return '';
}

function hasSequence(tokens, expected) {
    if (!expected.length || tokens.length < expected.length) return false;
    for (var i = 0; i <= tokens.length - expected.length; i++) {
        var ok = true;
        for (var j = 0; j < expected.length; j++) {
            if (tokens[i + j] !== expected[j]) {
                ok = false;
                break;
            }
        }
        if (ok) return true;
    }
    return false;
}
`;

type Finder = (text: string, patterns: readonly string[]) => string;

let cachedFinder: Finder | undefined;

function loadFinder(): Finder {
    if (!cachedFinder) {
        const factory = new Function(`${FIND_BLOCKED_SOURCE}\nreturn findBlockedPattern;`) as () => Finder;
        cachedFinder = factory();
    }
    return cachedFinder;
}

/** Returns the matched pattern, or null when the text is allowed. */
export function findBlockedPattern(text: string, patterns: readonly string[]): string | null {
    if (!text || patterns.length === 0) {
        return null;
    }
    const hit = loadFinder()(text, patterns);
    return hit ? hit : null;
}
