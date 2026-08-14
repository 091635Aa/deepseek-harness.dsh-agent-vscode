"use strict";
/**
 * Newline-delimited JSON-RPC 2.0 client over a child process stdio pair, plus
 * the DeepSeek Harness SDK wire shapes the extension speaks. The wire contract
 * mirrors `@deepseek-ai/dsh-sdk-protocol` (one compact JSON frame per
 * `\n`-terminated line; stdout of the child carries ONLY protocol frames).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SDK_SERVER_INFO_NAME = exports.LineJsonRpcClient = exports.JsonRpcResponseError = void 0;
class JsonRpcResponseError extends Error {
    code;
    data;
    constructor(code, message, data) {
        super(`JSON-RPC error ${code}: ${message}`);
        this.name = 'JsonRpcResponseError';
        this.code = code;
        this.data = data;
    }
}
exports.JsonRpcResponseError = JsonRpcResponseError;
/**
 * Line-framed JSON-RPC client. Requests are correlated by id; notifications
 * dispatch to a single handler. Malformed lines are ignored, matching the
 * protocol transport contract.
 */
class LineJsonRpcClient {
    input;
    output;
    onNotification;
    nextId = 1;
    buffer = '';
    pending = new Map();
    closed = false;
    constructor(input, output, onNotification) {
        this.input = input;
        this.output = output;
        this.onNotification = onNotification;
        this.input.setEncoding('utf8');
        this.input.on('data', (chunk) => this.onData(chunk));
        this.input.on('end', () => this.rejectAll(new Error('protocol transport closed')));
    }
    onData(chunk) {
        this.buffer += chunk;
        let nl;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (line === '')
                continue;
            let frame;
            try {
                frame = JSON.parse(line);
            }
            catch {
                continue; // malformed line: ignore, per protocol
            }
            this.dispatch(frame);
        }
    }
    dispatch(frame) {
        if (typeof frame !== 'object' || frame === null)
            return;
        const f = frame;
        if (typeof f.method === 'string' && typeof f.id === 'number') {
            // request from server — the harness server never sends these today
            return;
        }
        if (typeof f.method === 'string') {
            const params = f.params;
            this.onNotification(f.method, params);
            return;
        }
        if (typeof f.id === 'number') {
            const entry = this.pending.get(f.id);
            if (!entry)
                return;
            this.pending.delete(f.id);
            const resp = f;
            if (resp.error !== undefined) {
                entry.reject(new JsonRpcResponseError(resp.error.code, resp.error.message, resp.error.data));
            }
            else {
                entry.resolve(resp.result);
            }
        }
    }
    request(method, params) {
        if (this.closed)
            return Promise.reject(new Error('JSON-RPC client is closed'));
        const id = this.nextId++;
        const frame = { jsonrpc: '2.0', id, method };
        if (params !== undefined)
            frame.params = params;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve: resolve, reject });
            this.output.write(JSON.stringify(frame) + '\n');
        });
    }
    rejectAll(err) {
        if (this.closed)
            return;
        this.closed = true;
        for (const [, entry] of this.pending)
            entry.reject(err);
        this.pending.clear();
    }
    dispose() {
        this.rejectAll(new Error('JSON-RPC client disposed'));
        this.input.removeAllListeners();
    }
}
exports.LineJsonRpcClient = LineJsonRpcClient;
exports.SDK_SERVER_INFO_NAME = 'deepseek-harness-sdk-runtime';
//# sourceMappingURL=protocol.js.map