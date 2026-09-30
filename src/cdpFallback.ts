import * as http from 'http';
import WebSocket = require('ws');
import { FIND_BLOCKED_SOURCE } from './blocked';

export interface CdpHost {
    isActive(): boolean;
    enabled(): boolean;
    port(): number;
    log(message: string): void;
    blockedCommands(): readonly string[];
    customButtonTexts(): readonly string[];
    interceptLooseButtons(): boolean;
}

interface CdpTargetInfo {
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
        this.connected = true;

        await new Promise<void>((resolve) => {
            const ws = new WebSocket(browserWsUrl);
            let settled = false;
            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
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
                clearTimeout(timeout);
                rejectPending(new Error('CDP socket error'));
                ws.close();
                finish();
            });

            ws.on('close', () => {
                rejectPending(new Error('CDP socket closed'));
            });

            ws.on('open', () => {
                void this.evaluateTargets(send)
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

    private async evaluateTargets(send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<CdpResponse>): Promise<void> {
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
            let sessionId: string | undefined;
            try {
                const attach = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
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

                if (typeof result === 'string' && result.startsWith('clicked:')) {
                    if (result.includes('expand') || result.includes('requires input')) {
                        this.lastExpandTimes[target.targetId] = Date.now();
                    }
                    this.host.log(`CDP ${target.targetId.slice(0, 6)} -> ${result}`);
                } else if (typeof result === 'string' && result.startsWith('blocked:')) {
                    this.host.log(`CDP refused a button: ${result}`);
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

function isExtensionWebview(target: CdpTargetInfo): boolean {
    return (target.url ?? '').includes('vscode-webview');
}

function buildPermissionScript(
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
            var containerText = ((container || document.body).innerText || '').slice(0, 4000);
            var blocked = findBlockedPattern(containerText, BLOCKED_CMDS);
            if (blocked) return 'blocked:' + blocked;

            var lastClickTime = parseInt(clickable.getAttribute('data-aa-t') || '0', 10);
            if (lastClickTime && (Date.now() - lastClickTime < 5000)) return null;
            return clickable;
        }
        return null;
    }

    for (var t = 0; t < BUTTON_TEXTS.length; t++) {
        var btn = findButton(document.body, BUTTON_TEXTS[t]);
        if (!btn) continue;
        if (typeof btn === 'string') return btn;
        btn.setAttribute('data-aa-t', '' + Date.now());
        btn.click();
        return 'clicked:' + BUTTON_TEXTS[t];
    }

    if (typeof CAN_EXPAND === 'undefined' || CAN_EXPAND) {
        var expandTexts = ['expand', 'requires input'];
        for (var e = 0; e < expandTexts.length; e++) {
            var expBtn = findButton(document.body, expandTexts[e]);
            if (!expBtn) continue;
            if (typeof expBtn === 'string') return expBtn;
            expBtn.setAttribute('data-aa-t', '' + Date.now());
            expBtn.click();
            return 'clicked:' + expandTexts[e];
        }
    }
    return 'no-permission-button';
})()
`;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
