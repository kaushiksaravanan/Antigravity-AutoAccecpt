import * as http from 'http';
import WebSocket from 'ws';

export interface CDPClientOptions {
    /** Max reconnection attempts before giving up. Default: 10 */
    maxRetries: number;
    /** Initial delay between reconnection attempts in ms. Default: 1000 */
    initialRetryDelay: number;
    /** Maximum delay between reconnection attempts in ms. Default: 30000 */
    maxRetryDelay: number;
    /** Timeout for individual CDP method calls in ms. Default: 5000 */
    callTimeout: number;
}

const DEFAULT_OPTIONS: CDPClientOptions = {
    maxRetries: 10,
    initialRetryDelay: 1000,
    maxRetryDelay: 30000,
    callTimeout: 5000,
};

export class CDPClient {
    private ws: WebSocket | null = null;
    private messageId = 1;
    private callbacks = new Map<number, {
        resolve: (val: any) => void;
        reject: (err: any) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    private port = 9222;
    private retryCount = 0;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private intentionalDisconnect = false;
    private isDisposed = false;
    private options: CDPClientOptions;

    // Event callbacks
    private _onDisconnect: (() => void) | null = null;
    private _onReconnect: (() => void) | null = null;
    private _onReconnectFailed: (() => void) | null = null;
    private _onLog: ((message: string) => void) | null = null;

    constructor(options: Partial<CDPClientOptions> = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    /** Register a callback for disconnect events. */
    public onDisconnect(cb: () => void): void {
        this._onDisconnect = cb;
    }

    /** Register a callback for successful reconnect events. */
    public onReconnect(cb: () => void): void {
        this._onReconnect = cb;
    }

    /** Register a callback when all reconnect attempts are exhausted. */
    public onReconnectFailed(cb: () => void): void {
        this._onReconnectFailed = cb;
    }

    /** Register a callback for log messages. */
    public onLog(cb: (message: string) => void): void {
        this._onLog = cb;
    }

    /** Whether the WebSocket is currently open and ready. */
    public get isConnected(): boolean {
        try {
            return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
        } catch {
            return false;
        }
    }

    private log(message: string): void {
        try {
            if (this._onLog) {
                this._onLog(message);
            }
        } catch {
            // Logging should never throw — silently ignore
        }
    }

    /**
     * Connect to the VS Code CDP endpoint.
     * Discovers the correct WebSocket target via the /json/list endpoint.
     */
    public async connect(port: number = 9222): Promise<void> {
        if (this.isDisposed) {
            throw new Error('Cannot connect: CDPClient has been disposed.');
        }
        if (typeof port !== 'number' || port <= 0 || port > 65535) {
            throw new Error(`Invalid port number: ${port}`);
        }

        this.port = port;
        this.intentionalDisconnect = false;
        this.retryCount = 0;
        return this.doConnect();
    }

    private doConnect(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.isDisposed) {
                reject(new Error('CDPClient is disposed'));
                return;
            }

            let req: http.ClientRequest;
            try {
                req = http.get(`http://127.0.0.1:${this.port}/json/list`, (res) => {
                    let data = '';
                    res.on('data', (chunk: string) => { data += chunk; });
                    res.on('end', () => {
                        try {
                            const targets = JSON.parse(data);
                            if (!Array.isArray(targets) || targets.length === 0) {
                                reject(new Error('No CDP targets found.'));
                                return;
                            }

                            const ideTarget = targets.find(
                                (t: any) =>
                                    t &&
                                    (t.type === 'page' ||
                                        t.type === 'app' ||
                                        (t.title && typeof t.title === 'string' && t.title.includes('Visual Studio Code')))
                            );
                            if (!ideTarget || !ideTarget.webSocketDebuggerUrl) {
                                reject(new Error('Could not find IDE CDP target'));
                                return;
                            }

                            try {
                                this.ws = new WebSocket(ideTarget.webSocketDebuggerUrl);
                            } catch (wsErr: unknown) {
                                const errMsg = wsErr instanceof Error ? wsErr.message : String(wsErr);
                                reject(new Error(`Failed to create WebSocket: ${errMsg}`));
                                return;
                            }

                            this.ws.on('open', () => {
                                this.log('CDP WebSocket connected.');
                                this.retryCount = 0;
                                resolve();
                            });

                            this.ws.on('message', (raw: WebSocket.RawData) => {
                                try {
                                    this.handleMessage(raw);
                                } catch (msgErr: unknown) {
                                    const errMsg = msgErr instanceof Error ? msgErr.message : String(msgErr);
                                    this.log(`Error handling message: ${errMsg}`);
                                }
                            });

                            this.ws.on('error', (err: Error) => {
                                this.log(`CDP WebSocket error: ${err?.message ?? 'unknown error'}`);
                                // If we haven't resolved yet (during initial connect) this rejects the promise.
                                // If already connected, the 'close' handler will drive reconnect.
                            });

                            this.ws.on('close', () => {
                                this.log('CDP WebSocket closed.');
                                this.ws = null;
                                this.rejectAllPending('WebSocket connection closed');
                                try {
                                    if (this._onDisconnect) {
                                        this._onDisconnect();
                                    }
                                } catch { /* best-effort callback */ }
                                if (!this.intentionalDisconnect && !this.isDisposed) {
                                    this.scheduleReconnect();
                                }
                            });
                        } catch (e: unknown) {
                            const errMsg = e instanceof Error ? e.message : String(e);
                            reject(new Error(`Failed to parse CDP target list: ${errMsg}`));
                        }
                    });

                    res.on('error', (err: Error) => {
                        reject(new Error(`Error reading CDP response: ${err?.message ?? 'unknown'}`));
                    });
                });
            } catch (httpErr: unknown) {
                const errMsg = httpErr instanceof Error ? httpErr.message : String(httpErr);
                reject(new Error(`Failed to create HTTP request: ${errMsg}`));
                return;
            }

            req.on('error', (err: Error) => {
                reject(new Error(`Failed to reach CDP endpoint at port ${this.port}: ${err?.message ?? 'unknown'}`));
            });

            req.setTimeout(this.options.callTimeout, () => {
                try {
                    req.destroy();
                } catch { /* best-effort */ }
                reject(new Error(`CDP discovery request timed out on port ${this.port}`));
            });
        });
    }

    /**
     * Schedule a reconnection attempt with exponential backoff.
     */
    private scheduleReconnect(): void {
        if (this.intentionalDisconnect || this.isDisposed) {
            return;
        }
        if (this.retryCount >= this.options.maxRetries) {
            this.log(`Reconnect failed after ${this.options.maxRetries} attempts. Giving up.`);
            try {
                if (this._onReconnectFailed) {
                    this._onReconnectFailed();
                }
            } catch { /* best-effort callback */ }
            return;
        }

        const delay = Math.min(
            this.options.initialRetryDelay * Math.pow(2, this.retryCount),
            this.options.maxRetryDelay
        );
        this.retryCount++;
        this.log(`Reconnecting in ${delay}ms (attempt ${this.retryCount}/${this.options.maxRetries})...`);

        this.retryTimer = setTimeout(async () => {
            this.retryTimer = null;
            if (this.intentionalDisconnect || this.isDisposed) { return; }
            try {
                await this.doConnect();
                this.log('Reconnected successfully.');
                try {
                    if (this._onReconnect) {
                        this._onReconnect();
                    }
                } catch { /* best-effort callback */ }
            } catch {
                this.scheduleReconnect();
            }
        }, delay);
    }

    /**
     * Handle incoming WebSocket messages.
     * Converts Buffer/ArrayBuffer to string before parsing.
     */
    private handleMessage(raw: WebSocket.RawData): void {
        if (!raw) {
            this.log('Received null/undefined message, skipping.');
            return;
        }

        let message: string;
        if (typeof raw === 'string') {
            message = raw;
        } else if (Buffer.isBuffer(raw)) {
            message = raw.toString('utf-8');
        } else if (raw instanceof ArrayBuffer) {
            message = Buffer.from(raw).toString('utf-8');
        } else if (Array.isArray(raw)) {
            message = Buffer.concat(raw).toString('utf-8');
        } else {
            this.log('Received unrecognized message format, skipping.');
            return;
        }

        try {
            const data = JSON.parse(message);
            if (data && typeof data.id === 'number' && this.callbacks.has(data.id)) {
                const cb = this.callbacks.get(data.id)!;
                clearTimeout(cb.timer);
                this.callbacks.delete(data.id);
                if (data.error) {
                    cb.reject(new Error(`CDP error: ${JSON.stringify(data.error)}`));
                } else {
                    cb.resolve(data.result);
                }
            }
        } catch {
            this.log('Failed to parse CDP message, ignoring.');
        }
    }

    /**
     * Reject all pending callbacks — called on disconnect to avoid hanging promises.
     */
    private rejectAllPending(reason: string): void {
        try {
            for (const [, cb] of this.callbacks) {
                try {
                    clearTimeout(cb.timer);
                    cb.reject(new Error(reason));
                } catch { /* best-effort per-callback */ }
            }
            this.callbacks.clear();
        } catch {
            // If the map itself is corrupted, just reset
            this.callbacks = new Map();
        }
    }

    /**
     * Send a CDP method call and return the result.
     * Rejects after callTimeout ms if no response is received.
     */
    public async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
        if (this.isDisposed) {
            throw new Error('Cannot send: CDPClient has been disposed.');
        }
        if (!method || typeof method !== 'string') {
            throw new Error('CDP method name must be a non-empty string.');
        }
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('CDP WebSocket is not connected');
        }

        return new Promise((resolve, reject) => {
            const id = this.messageId++;

            const timer = setTimeout(() => {
                if (this.callbacks.has(id)) {
                    this.callbacks.delete(id);
                    reject(new Error(`CDP call "${method}" timed out after ${this.options.callTimeout}ms`));
                }
            }, this.options.callTimeout);

            this.callbacks.set(id, { resolve, reject, timer });

            try {
                this.ws!.send(JSON.stringify({ id, method, params }));
            } catch (sendErr: unknown) {
                // Clean up the callback on send failure
                if (this.callbacks.has(id)) {
                    clearTimeout(timer);
                    this.callbacks.delete(id);
                }
                const errMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
                reject(new Error(`Failed to send CDP message: ${errMsg}`));
            }
        });
    }

    /**
     * Intentionally disconnect and cancel any pending reconnection.
     */
    public disconnect(): void {
        if (this.isDisposed) { return; }
        this.intentionalDisconnect = true;

        if (this.retryTimer) {
            try {
                clearTimeout(this.retryTimer);
            } catch { /* best-effort */ }
            this.retryTimer = null;
        }

        this.rejectAllPending('Client disconnected intentionally');

        if (this.ws) {
            try {
                this.ws.close();
            } catch {
                // WebSocket may already be closed — ignore
            }
            this.ws = null;
        }
    }

    /**
     * Full disposal — disconnect and prevent further use.
     */
    public dispose(): void {
        if (this.isDisposed) { return; }
        this.isDisposed = true;
        this.disconnect();
        this._onDisconnect = null;
        this._onReconnect = null;
        this._onReconnectFailed = null;
        this._onLog = null;
    }
}
