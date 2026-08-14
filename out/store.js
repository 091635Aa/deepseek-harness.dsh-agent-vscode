"use strict";
/**
 * In-memory transcript model + JSON history persistence. One SessionRecord
 * per SDK session id: messages (user / assistant / tool cards / notices),
 * todo list, title, and the model route it ran on. History is written to a
 * caller-provided JSON file (debounced by the controller).
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionStore = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
class SessionStore {
    historyFile;
    sessions = new Map();
    activeId;
    constructor(historyFile) {
        this.historyFile = historyFile;
        if (historyFile !== undefined && fs.existsSync(historyFile)) {
            this.load(historyFile);
        }
    }
    load(file) {
        try {
            const raw = fs.readFileSync(file, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed.version !== 1 || !Array.isArray(parsed.sessions))
                return;
            for (const s of parsed.sessions) {
                if (typeof s.id !== 'string' || !Array.isArray(s.messages))
                    continue;
                this.sessions.set(s.id, {
                    id: s.id,
                    title: typeof s.title === 'string' ? s.title : '',
                    createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
                    updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
                    model: typeof s.model === 'string' ? s.model : '',
                    running: false,
                    closed: true, // a restored session belongs to a dead runtime
                    messages: s.messages,
                    todos: Array.isArray(s.todos) ? s.todos : [],
                });
            }
        }
        catch {
            // unreadable/corrupt history is not fatal
        }
    }
    createSession(model) {
        const rec = {
            id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            title: '新会话',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            model,
            running: false,
            closed: false,
            messages: [],
            todos: [],
        };
        this.sessions.set(rec.id, rec);
        this.activeId = rec.id;
        return rec;
    }
    get(id) {
        return this.sessions.get(id);
    }
    list() {
        return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    closeAll() {
        for (const s of this.sessions.values()) {
            s.closed = true;
            s.running = false;
        }
    }
    delete(id) {
        this.sessions.delete(id);
        if (this.activeId === id)
            this.activeId = undefined;
    }
    touch(rec) {
        rec.updatedAt = Date.now();
    }
    persist() {
        if (this.historyFile === undefined)
            return;
        try {
            fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
            const data = { version: 1, sessions: this.list() };
            const tmp = `${this.historyFile}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
            fs.renameSync(tmp, this.historyFile);
        }
        catch {
            // persistence is best-effort; a full disk must not kill the chat
        }
    }
}
exports.SessionStore = SessionStore;
//# sourceMappingURL=store.js.map