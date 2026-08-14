/**
 * Model/provider route configuration for the child harness runtime. The SDK
 * handshake (`initialize`) is process-wide: every SDK-created agent runs the
 * provider/model named there, so changing the model requires a runtime restart.
 */

import * as vscode from 'vscode'

export interface ModelOption {
  label: string
  provider: string
  model: string
}

export const DEFAULT_MODELS: ModelOption[] = [
  { label: 'DeepSeek V4 Flash', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  { label: 'DeepSeek V4 Pro', provider: 'deepseek-official', model: 'deepseek-v4-pro' },
]

export function readModelOptions(): ModelOption[] {
  const raw = vscode.workspace.getConfiguration('dshAgent').get<unknown>('models')
  if (!Array.isArray(raw)) return [...DEFAULT_MODELS]
  const out: ModelOption[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    if (typeof r.label === 'string' && typeof r.provider === 'string' && typeof r.model === 'string') {
      out.push({ label: r.label, provider: r.provider, model: r.model })
    }
  }
  return out.length > 0 ? out : [...DEFAULT_MODELS]
}

export interface ModelSelection {
  provider: string
  model: string
}

export function readMaxTokens(): number | undefined {
  const v = vscode.workspace.getConfiguration('dshAgent').get<number>('maxTokens')
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined
}

export function readSystemPrompt(workspace: string): string {
  const raw = vscode.workspace.getConfiguration('dshAgent').get<string>('systemPrompt') ?? ''
  return raw.replaceAll('{{cwd}}', workspace)
}
