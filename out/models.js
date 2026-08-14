"use strict";
/**
 * Model/provider route configuration for the child harness runtime. The SDK
 * handshake (`initialize`) is process-wide: every SDK-created agent runs the
 * provider/model named there, so changing the model requires a runtime restart.
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
exports.DEFAULT_MODELS = void 0;
exports.readModelOptions = readModelOptions;
exports.readMaxTokens = readMaxTokens;
exports.readSystemPrompt = readSystemPrompt;
const vscode = __importStar(require("vscode"));
exports.DEFAULT_MODELS = [
    { label: 'DeepSeek V4 Flash', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    { label: 'DeepSeek V4 Pro', provider: 'deepseek-official', model: 'deepseek-v4-pro' },
];
function readModelOptions() {
    const raw = vscode.workspace.getConfiguration('dshAgent').get('models');
    if (!Array.isArray(raw))
        return [...exports.DEFAULT_MODELS];
    const out = [];
    for (const item of raw) {
        if (typeof item !== 'object' || item === null)
            continue;
        const r = item;
        if (typeof r.label === 'string' && typeof r.provider === 'string' && typeof r.model === 'string') {
            out.push({ label: r.label, provider: r.provider, model: r.model });
        }
    }
    return out.length > 0 ? out : [...exports.DEFAULT_MODELS];
}
function readMaxTokens() {
    const v = vscode.workspace.getConfiguration('dshAgent').get('maxTokens');
    return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}
function readSystemPrompt(workspace) {
    const raw = vscode.workspace.getConfiguration('dshAgent').get('systemPrompt') ?? '';
    return raw.replaceAll('{{cwd}}', workspace);
}
//# sourceMappingURL=models.js.map