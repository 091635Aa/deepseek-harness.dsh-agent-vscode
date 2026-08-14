/**
 * End-to-end smoke test for the DSH Agent child runtime.
 *
 * Boots the extension's cordis.yml with the real dsh-jsonrpc-agent bin,
 * performs the SDK initialize handshake, sends one prompt to a real model,
 * and verifies the streamed session events produce a committed assistant
 * answer. Prints every event type observed so renderer mappings can be
 * validated against the live wire.
 *
 * Usage:
 *   node tests/smoke.mjs [--prompt "text"] [--expect "PONG"]
 * Env: DSH_SMOKE_REPO (default: nearest ancestor with the jsonrpc demo bin)
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

function findRepo(start) {
  let dir = path.resolve(start)
  for (;;) {
    if (existsSync(path.join(dir, 'packages', 'examples', 'jsonrpc-demo', 'lib', 'bin.js'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const repo = process.env.DSH_SMOKE_REPO || findRepo(here)
if (!repo) {
  console.error('smoke: no repo found (set DSH_SMOKE_REPO)')
  process.exit(2)
}

const bin = path.join(repo, 'packages', 'examples', 'jsonrpc-demo', 'lib', 'bin.js')
if (!existsSync(bin)) {
  console.error('smoke: missing built bin:', bin)
  process.exit(2)
}

const args = process.argv.slice(2)
const promptArg = (args.find((a) => a.startsWith('--prompt=')) ?? '').slice(9)
const expectArg = (args.find((a) => a.startsWith('--expect=')) ?? '').slice(9)
const prompt = promptArg || 'Reply with exactly: PONG'
const expect = expectArg || 'PONG'

// config under the examples resolution tree so bare plugins resolve
const configPath = path.join(repo, 'examples', 'jsonrpc-agent', 'vscode-agent.cordis.yml')
writeFileSync(configPath, readFileSync(path.join(root, 'media', 'cordis.yml'), 'utf8'), 'utf8')

const sessionRoot = path.join(tmpdir(), 'dsh-smoke-' + Date.now())
mkdirSync(sessionRoot, { recursive: true })
const workspace = path.join(repo, 'examples', 'jsonrpc-agent')

const env = {
  ...process.env,
  DSH_CWD: workspace,
  DSH_SYSTEM_PROMPT: 'You are a smoke-test agent. Be extremely brief.',
  DSH_SESSION_ROOT: sessionRoot,
}

const child = spawn(process.env.DSH_SMOKE_NODE || 'node', [bin, configPath], {
  cwd: repo,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
})

let stdoutBuf = ''
let stderrBuf = ''
const seenEvents = new Set()
let assistantText = ''
let status = 'unknown'
let idle = false
let timeout
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function fail(msg) {
  console.error('SMOKE FAIL:', msg)
  console.error('--- stderr tail ---')
  console.error(stderrBuf.slice(-4000))
  try { child.kill() } catch { /* noop */ }
  cleanup()
  process.exit(1)
}

function cleanup() {
  clearTimeout(timeout)
  try { rmSync(sessionRoot, { recursive: true, force: true }) } catch { /* noop */ }
}

function request(id, method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }) + '\n')
}

function handleNotification(method, params) {
  if (method === 'session.status') {
    status = params.status
    idle = params.status === 'idle'
  } else if (method === 'session.event') {
    const ev = params.event
    seenEvents.add(ev.type)
    if (ev.type === 'assistant/chunk') {
      const c = ev.data.chunk
      if (c.type === 'text-delta') assistantText += c.text
    }
    if (ev.type === 'assistant/message') {
      for (const block of ev.data.message.content) {
        if (block.type === 'text') assistantText = block.text
      }
    }
  } else if (method === 'subagent.started' || method === 'subagent.finished') {
    // observed; nothing to do
  }
}

child.stdout.setEncoding('utf8')
let lineBuf = ''
child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk
  lineBuf += chunk
  let nl
  while ((nl = lineBuf.indexOf('\n')) >= 0) {
    const line = lineBuf.slice(0, nl).trim()
    lineBuf = lineBuf.slice(nl + 1)
    if (line === '') continue
    let frame
    try { frame = JSON.parse(line) } catch { continue }
    if (typeof frame.method === 'string') handleNotification(frame.method, frame.params)
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => { stderrBuf += chunk })

let exited = false
child.on('exit', (code) => {
  exited = true
  if (code !== 0 && !settled) fail(`runtime exited early with code ${code}`)
})
child.on('error', (err) => fail(`spawn error: ${String(err)}`))

let settled = false

async function run() {
  const sessionId = 'smoke-' + Date.now()

  // 1. initialize
  request(1, 'initialize', {
    cwd: workspace,
    provider: 'deepseek-official',
    model: process.env.DSH_SMOKE_MODEL || 'deepseek-v4-flash',
    maxTokens: 256,
  })
  const initOk = await waitForResponse(1, 90000)
  if (!initOk) fail('initialize timed out (no response id=1)')

  console.log('✓ initialize ok')

  // 2. prompt
  request(2, 'session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: prompt }] })
  const promptOk = await waitForResponse(2, 30000)
  if (!promptOk) fail('session/prompt timed out')
  console.log('✓ prompt accepted (message queued)')

  // 3. wait for agent idle + some assistant output
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    await wait(500)
    if (exited) break
    if (idle && assistantText !== '') break
  }

  console.log('event types observed:', [...seenEvents].sort().join(', '))
  console.log('final status:', status)
  console.log('assistant text:', JSON.stringify(assistantText.slice(0, 300)))

  const ok = idle && assistantText.includes(expect)
  if (!ok) {
    if (assistantText === '' && seenEvents.has('turn/end')) {
      fail('agent produced no assistant text')
    }
    fail(`expected "${expect}" in assistant output`)
  }
  console.log(`✓ assistant output contains "${expect}"`)

  // 4. shutdown
  request(3, 'shutdown')
  const shutdownOk = await waitForResponse(3, 10000)
  console.log('✓ shutdown', shutdownOk ? 'ok' : '(no response, continuing)')
  await wait(500)
  if (child.exitCode === null) child.kill()
  settled = true
  cleanup()
  console.log('SMOKE PASS')
  process.exit(0)
}

async function waitForResponse(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const re = new RegExp('\\{"jsonrpc":"2\\.0","id":' + id + ',')
    if (re.test(stdoutBuf)) return true
    await wait(200)
  }
  return false
}

run().catch((err) => fail(String(err)))
