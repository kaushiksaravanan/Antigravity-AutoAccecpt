import * as http from 'http';
import WebSocket = require('ws');
import { FIND_BLOCKED_SOURCE, findBlockedPattern } from './blocked';
import { inspectCommand } from './scriptInspector';

export interface BlockedCommandInfo {
    command: string;
    pattern: string;
    agent: string;
    timestamp: string;
}

export interface CdpHost {
    isActive(): boolean;
    enabled(): boolean;
    port(): number;
    log(message: string): void;
    blockedCommands(): readonly string[];
    customButtonTexts(): readonly string[];
    interceptLooseButtons(): boolean;
    workspaceRoots(): readonly string[];
    unknownScriptPolicy(): 'warn' | 'block';
    onBlocked?(info: BlockedCommandInfo): void;
}

export interface CdpTargetInfo {
    targetId: string;
    type: string;
    url?: string;
}

interface CdpResponse {
    id?: number;
    result?: {
        targetInfos?: CdpTargetInfo[];
        sessionId?: string;
        result?: { value?: unknown };
    };
}

interface PendingCall {
    resolve: (value: CdpResponse) => void;
    reject: (error: Error) => void;
}

/**
 * Optional fallback that clicks approval buttons inside VS Code webviews.
 * It talks to one debugging port and only attaches to vscode-webview targets.
 */
export class CdpFallback {
    private interval: ReturnType<typeof setInterval> | null = null;
    private busy = false;
    private cycle = 0;
    private generation = 0;
    private readonly lastExpandTimes: Record<string, number> = {};
    private currentWs: WebSocket | null = null;
    private connected = false;

    constructor(private readonly host: CdpHost) {}

    isConnected(): boolean {
        return this.connected;
    }

    start(): void {
        this.stop();
        if (!this.host.enabled()) {
            return;
        }

        const port = this.host.port();
        this.interval = setInterval(() => {
            void this.check().catch((err: unknown) => {
                this.host.log(`CDP poll error: ${errorMessage(err)}`);
            });
        }, 1500);
        this.host.log(`CDP fallback started on 127.0.0.1:${port}.`);
    }

    stop(): void {
        this.generation++;
        this.connected = false;
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        if (this.currentWs) {
            try {
                this.currentWs.close();
            } catch {
                // Ignore socket close error
            }
            this.currentWs = null;
        }
    }

    private async check(): Promise<void> {
        if (!this.host.isActive() || this.busy) {
            return;
        }

        const now = Date.now();
        for (const key of Object.keys(this.lastExpandTimes)) {
            if (now - this.lastExpandTimes[key] > 60_000) {
                delete this.lastExpandTimes[key];
            }
        }

        this.busy = true;
        try {
            await this.scan(this.host.port());
        } finally {
            this.busy = false;
        }
    }

    private async scan(port: number): Promise<void> {
        const generation = this.generation;
        this.cycle++;
        const browserWsUrl = await this.browserWsUrl(port);
        if (generation !== this.generation) {
            return;
        }
        if (!browserWsUrl) {
            this.connected = false;
            if (this.cycle % 20 === 0) {
                this.host.log(`CDP port ${port} is not open.`);
            }
            return;
        }

        await new Promise<void>((resolve) => {
            const ws = new WebSocket(browserWsUrl);
            this.currentWs = ws;
            let settled = false;
            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                this.connected = false;
                if (this.currentWs === ws) {
                    this.currentWs = null;
                }
                resolve();
            };
            const timeout = setTimeout(() => {
                ws.close();
                finish();
            }, 5000);

            let msgId = 1;
            const pending: Record<number, PendingCall> = {};

            const rejectPending = (error: Error) => {
                for (const id of Object.keys(pending)) {
                    const call = pending[Number(id)];
                    delete pending[Number(id)];
                    call.reject(error);
                }
            };

            const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<CdpResponse> => {
                return new Promise((resolveSend, rejectSend) => {
                    if (ws.readyState !== WebSocket.OPEN) {
                        rejectSend(new Error('WebSocket is not open'));
                        return;
                    }
                    const id = msgId++;
                    const timer = setTimeout(() => {
                        delete pending[id];
                        rejectSend(new Error(`CDP timeout: ${method}`));
                    }, 2000);
                    pending[id] = {
                        resolve: (value) => {
                            clearTimeout(timer);
                            resolveSend(value);
                        },
                        reject: (error) => {
                            clearTimeout(timer);
                            rejectSend(error);
                        },
                    };
                    const payload: Record<string, unknown> = { id, method, params };
                    if (sessionId) {
                        payload.sessionId = sessionId;
                    }
                    try {
                        ws.send(JSON.stringify(payload));
                    } catch (err: unknown) {
                        clearTimeout(timer);
                        delete pending[id];
                        rejectSend(err instanceof Error ? err : new Error(String(err)));
                    }
                });
            };

            ws.on('message', (raw: WebSocket.RawData) => {
                try {
                    const msg = JSON.parse(raw.toString()) as CdpResponse;
                    if (msg.id && pending[msg.id]) {
                        pending[msg.id].resolve(msg);
                        delete pending[msg.id];
                    }
                } catch {
                    // Ignore malformed debugger traffic.
                }
            });

            ws.on('error', () => {
                this.connected = false;
                clearTimeout(timeout);
                rejectPending(new Error('CDP socket error'));
                ws.close();
                finish();
            });

            ws.on('close', () => {
                this.connected = false;
                rejectPending(new Error('CDP socket closed'));
            });

            ws.on('open', () => {
                this.connected = true;
                void this.evaluateTargets(send, generation)
                    .catch((err: unknown) => {
                        this.host.log(`CDP evaluate failed: ${errorMessage(err)}`);
                    })
                    .finally(() => {
                        clearTimeout(timeout);
                        ws.close();
                        finish();
                    });
            });
        });
    }

    private async evaluateTargets(
        send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<CdpResponse>,
        generation: number,
    ): Promise<void> {
        if (this.generation !== generation || !this.host.isActive()) {
            return;
        }
        await send('Target.setDiscoverTargets', { discover: true });
        const targetsMsg = await send('Target.getTargets');
        const allTargets = targetsMsg.result?.targetInfos ?? [];
        const webviews = allTargets.filter(isExtensionWebview).slice(0, 30);
        const reportStatus = this.cycle % 20 === 0;

        if (reportStatus) {
            this.host.log(`CDP status: ${allTargets.length} targets, ${webviews.length} extension webviews.`);
        }
        if (webviews.length === 0) {
            return;
        }

        await Promise.allSettled(webviews.map(async (target) => {
            if (this.generation !== generation || !this.host.isActive()) {
                return;
            }
            let sessionId: string | undefined;
            try {
                const attach = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                if (this.generation !== generation || !this.host.isActive()) {
                    return;
                }
                sessionId = attach.result?.sessionId;
                if (!sessionId) {
                    return;
                }

                const now = Date.now();
                const canExpand = !this.lastExpandTimes[target.targetId] || (now - this.lastExpandTimes[target.targetId] >= 8000);
                const expression = buildPermissionScript(
                    this.host.customButtonTexts(),
                    this.host.blockedCommands(),
                    this.host.interceptLooseButtons(),
                    canExpand,
                );
                const evalMsg = await send('Runtime.evaluate', { expression }, sessionId);
                const result = evalMsg.result?.result?.value;

                if (typeof result === 'string') {
                    if (result.startsWith('{')) {
                        try {
                            const candidate = JSON.parse(result) as {
                                status?: string;
                                targetId?: string;
                                buttonText?: string;
                                candidates?: string[];
                            };
                            if (candidate.status === 'candidate' && candidate.targetId && candidate.buttonText) {
                                let blockedReason: string | null = null;
                                let blockedCmd: string | null = null;
                                const roots = this.host.workspaceRoots();
                                const blockedList = this.host.blockedCommands();
                                const policy = this.host.unknownScriptPolicy();

                                for (const cmd of candidate.candidates ?? []) {
                                    const directBlocked = findBlockedPattern(cmd, blockedList);
                                    if (directBlocked) {
                                        blockedReason = directBlocked;
                                        blockedCmd = cmd;
                                        break;
                                    }
                                    const scriptBlocked = inspectCommand(
                                        cmd,
                                        roots,
                                        blockedList,
                                        (m) => this.host.log(m),
                                        { unknownScriptPolicy: policy },
                                    );
                                    if (scriptBlocked) {
                                        blockedReason = `script inspector: ${scriptBlocked}`;
                                        blockedCmd = cmd;
                                        break;
                                    }
                                }

                                if (blockedReason) {
                                    await send('Runtime.evaluate', {
                                        expression: `(function() {
                                            var el = document.querySelector('[data-aa-target="${candidate.targetId}"]');
                                            if (el) el.removeAttribute('data-aa-target');
                                        })()`,
                                    }, sessionId).catch(() => undefined);
                                    this.host.log(`CDP refused a button: ${blockedReason}`);
                                    this.host.onBlocked?.({
                                        command: blockedCmd || candidate.buttonText,
                                        pattern: blockedReason,
                                        agent: 'Antigravity Agent UI',
                                        timestamp: new Date().toLocaleTimeString(),
                                    });
                                } else {
                                    const clickMsg = await send('Runtime.evaluate', {
                                        expression: `(function() {
                                            var el = document.querySelector('[data-aa-target="${candidate.targetId}"]');
                                            if (!el) return 'target-lost';
                                            el.removeAttribute('data-aa-target');
                                            el.setAttribute('data-aa-t', '' + Date.now());
                                            el.click();
                                            return 'clicked:${candidate.buttonText}';
                                        })()`,
                                    }, sessionId);
                                    const clickResult = clickMsg.result?.result?.value;
                                    if (typeof clickResult === 'string' && clickResult.startsWith('clicked:')) {
                                        if (clickResult.includes('expand') || clickResult.includes('requires input')) {
                                            this.lastExpandTimes[target.targetId] = Date.now();
                                        }
                                        this.host.log(`CDP ${target.targetId.slice(0, 6)} -> ${clickResult}`);
                                    }
                                }
                            }
                        } catch {
                            // Malformed candidate JSON
                        }
                    } else if (result.startsWith('clicked:')) {
                        if (result.includes('expand') || result.includes('requires input')) {
                            this.lastExpandTimes[target.targetId] = Date.now();
                        }
                        this.host.log(`CDP ${target.targetId.slice(0, 6)} -> ${result}`);
                    } else if (result.startsWith('blocked:')) {
                        this.host.log(`CDP refused a button: ${result}`);
                        this.host.onBlocked?.({
                            command: 'UI Container Command',
                            pattern: result.replace(/^blocked:/, ''),
                            agent: 'Antigravity Agent UI',
                            timestamp: new Date().toLocaleTimeString(),
                        });
                    }
                }
            } catch {
                // The target can close between listing and attaching.
            } finally {
                if (sessionId) {
                    await send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
                }
            }
        }));
    }

    private browserWsUrl(port: number): Promise<string | null> {
        return new Promise((resolve) => {
            let done = false;
            const end = (value: string | null) => {
                if (done) {
                    return;
                }
                done = true;
                resolve(value);
            };

            const req = http.get({ hostname: '127.0.0.1', port, path: '/json/version', timeout: 800 }, (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    end(null);
                    return;
                }
                let data = '';
                res.on('data', (chunk: Buffer | string) => {
                    data += chunk;
                });
                res.on('error', () => end(null));
                res.on('end', () => {
                    try {
                        const info = JSON.parse(data) as { webSocketDebuggerUrl?: string };
                        end(info.webSocketDebuggerUrl ?? null);
                    } catch {
                        end(null);
                    }
                });
            });
            req.on('error', () => end(null));
            req.on('timeout', () => {
                req.destroy();
                end(null);
            });
        });
    }
}

export function isExtensionWebview(target: CdpTargetInfo): boolean {
    const url = target.url ?? '';
    if (url.startsWith('vscode-file://')) {
        return false;
    }
    if (url.startsWith('vscode-webview://')) {
        return true;
    }
    if (/^https?:\/\//i.test(url)) {
        return false;
    }
    return url.includes('vscode-webview');
}

export function buildPermissionScript(
    customTexts: readonly string[],
    blockedCommands: readonly string[],
    interceptLooseButtons: boolean,
    canExpand: boolean,
): string {
    const buttonTexts = ['run', 'accept'];
    if (interceptLooseButtons) {
        buttonTexts.push('always allow', 'allow this conversation', 'allow');
    }
    for (const text of customTexts) {
        const normalized = text.trim().toLowerCase();
        if (normalized && !buttonTexts.includes(normalized)) {
            buttonTexts.push(normalized);
        }
    }

    return `
(function () {
${FIND_BLOCKED_SOURCE}
var BLOCKED_CMDS = ${JSON.stringify(blockedCommands)};
var BUTTON_TEXTS = ${JSON.stringify(buttonTexts)};
var CAN_EXPAND = ${canExpand ? 'true' : 'false'};
    if (!document.querySelector('.react-app-container') &&
        !document.querySelector('[class*="agent"]') &&
        !document.querySelector('[data-vscode-context]')) {
        return 'not-agent-panel';
    }

    function closestClickable(node) {
        var el = node;
        while (el && el !== document.body) {
            var tag = (el.tagName || '').toLowerCase();
            if (tag === 'button' || tag.indexOf('button') !== -1 || tag.indexOf('btn') !== -1 ||
                el.getAttribute('role') === 'button' || el.classList.contains('cursor-pointer') ||
                el.onclick || el.getAttribute('tabindex') === '0') {
                return el;
            }
            el = el.parentElement;
        }
        return node;
    }

    function findButton(root, text) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        var node;
        while ((node = walker.nextNode())) {
            if (node.shadowRoot) {
                var nested = findButton(node.shadowRoot, text);
                if (nested) return nested;
            }
            var nodeText = (node.textContent || '').trim().toLowerCase();
            if (nodeText.length > 50) continue;
            var isMatch = nodeText === text ||
                (text.length >= 5 && nodeText.indexOf(text) === 0 && nodeText.length <= text.length * 3);
            if (!isMatch) continue;

            var clickable = closestClickable(node);
            var tag = (clickable.tagName || '').toLowerCase();
            var clickableEnough = tag === 'button' || tag.indexOf('button') !== -1 || tag.indexOf('btn') !== -1 ||
                clickable.getAttribute('role') === 'button' || clickable.classList.contains('cursor-pointer') ||
                clickable.onclick || clickable.getAttribute('tabindex') === '0' ||
                text === 'expand' || text === 'requires input';
            if (!clickableEnough) continue;
            if (clickable.disabled || clickable.getAttribute('aria-disabled') === 'true' ||
                clickable.classList.contains('loading') || clickable.querySelector('.codicon-loading')) {
                return null;
            }

            var container = clickable.parentElement;
            for (var depth = 0; depth < 4; depth++) {
                if (!container || container === document.body) break;
                var className = container.className || '';
                if (typeof className === 'string' && (className.indexOf('step') !== -1 || className.indexOf('chat') !== -1 || className.indexOf('response') !== -1)) {
                    break;
                }
                container = container.parentElement;
            }

            var rawText = ((container || document.body).innerText || '');
            if (rawText.length > 65536) {
                return 'blocked:container-text-oversized';
            }
            var containerText = rawText;
            if (!containerText.trim()) {
                return 'missing-container-text';
            }
            var blocked = findBlockedPattern(containerText, BLOCKED_CMDS);
            if (blocked) return 'blocked:' + blocked;

            var lastClickTime = parseInt(clickable.getAttribute('data-aa-t') || '0', 10);
            if (lastClickTime && (Date.now() - lastClickTime < 5000)) return null;

            // Extract candidate commands for pre-approval script inspection
            var candidates = [];
            var targetEl = container || document.body;
            var codeEls = (targetEl && typeof targetEl.querySelectorAll === 'function')
                ? targetEl.querySelectorAll('pre, code, .terminal-command, .monaco-editor, [class*="code"], [class*="command"]')
                : [];
            for (var c = 0; c < codeEls.length; c++) {
                var codeText = (codeEls[c].innerText || codeEls[c].textContent || '').trim();
                if (codeText && codeText.length < 2048 && candidates.indexOf(codeText) === -1) {
                    candidates.push(codeText);
                }
            }
            var lines = containerText.split(/[\\r\\n]+/);
            for (var l = 0; l < lines.length; l++) {
                var line = lines[l].trim();
                if (line && line.length < 2048 && candidates.indexOf(line) === -1) {
                    candidates.push(line);
                }
            }

            var targetId = 'aa-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
            clickable.setAttribute('data-aa-target', targetId);
            return JSON.stringify({
                status: 'candidate',
                targetId: targetId,
                buttonText: text,
                candidates: candidates
            });
        }
        return null;
    }

    for (var t = 0; t < BUTTON_TEXTS.length; t++) {
        var btn = findButton(document.body, BUTTON_TEXTS[t]);
        if (!btn) continue;
        return btn;
    }

    if (typeof CAN_EXPAND === 'undefined' || CAN_EXPAND) {
        var expandTexts = ['expand', 'requires input'];
        for (var e = 0; e < expandTexts.length; e++) {
            var expBtn = findButton(document.body, expandTexts[e]);
            if (!expBtn) continue;
            if (typeof expBtn === 'string') {
                if (expBtn.indexOf('{') === 0) {
                    try {
                        var parsed = JSON.parse(expBtn);
                        var el = document.querySelector('[data-aa-target="' + parsed.targetId + '"]');
                        if (el) {
                            el.removeAttribute('data-aa-target');
                            el.setAttribute('data-aa-t', '' + Date.now());
                            el.click();
                            return 'clicked:' + expandTexts[e];
                        }
                    } catch (e2) {}
                }
                return expBtn;
            }
        }
    }
    return 'no-permission-button';
})()
`;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
