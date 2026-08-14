/* DSH Agent panel client — zero-dependency vanilla JS. */
(function () {
  'use strict'

  const vscode = acquireVsCodeApi()

  const state = {
    models: [],
    currentModel: null,
    sessions: [],
    activeId: null,
    transcript: null, // { messages, todos, title, model, closed, ... }
    connected: false,
    detail: '未连接',
    running: false,
  }

  const $ = (id) => document.getElementById(id)
  const transcriptEl = $('transcript')
  const inputEl = $('input')
  const sendBtn = $('btn-send')
  const toastEl = $('toast')

  /* ---------------- markdown (GFM subset, escaped, safe) ---------------- */

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function renderInline(src) {
    const codes = []
    let text = String(src).replace(/`([^`]+)`/g, (m, c) => {
      codes.push(esc(c))
      return '\u0000' + (codes.length - 1) + '\u0000'
    })
    text = esc(text)
    text = text.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (m, label, url) => '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(label) + '</a>',
    )
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>')
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    text = text.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>')
    text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>')
    text = text.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + codes[Number(i)] + '</code>')
    return text
  }

  function renderMarkdown(src) {
    const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n')
    const out = []
    let para = []
    let i = 0
    const flushPara = () => {
      if (para.length > 0) {
        out.push('<p>' + renderInline(para.join('\n').replace(/\n/g, '<br>')) + '</p>')
        para = []
      }
    }
    while (i < lines.length) {
      const line = lines[i]
      const fence = line.match(/^```(\w*)\s*$/)
      if (fence) {
        flushPara()
        const code = []
        i++
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++ }
        i++
        out.push('<pre><code class="lang-' + esc(fence[1]) + '">' + esc(code.join('\n')) + '</code></pre>')
        continue
      }
      const h = line.match(/^(#{1,6})\s+(.*)$/)
      if (h) {
        flushPara()
        const lvl = h[1].length
        out.push('<h' + lvl + '>' + renderInline(h[2]) + '</h' + lvl + '>')
        i++
        continue
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushPara()
        out.push('<hr>')
        i++
        continue
      }
      if (/^\s*>\s?/.test(line)) {
        flushPara()
        const q = []
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
        out.push('<blockquote>' + renderInline(q.join('\n').replace(/\n/g, '<br>')) + '</blockquote>')
        continue
      }
      const li = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/)
      if (li) {
        flushPara()
        const ordered = /\d+\./.test(li[1])
        const items = []
        while (i < lines.length) {
          const m = lines[i].match(/^\s*([-*+]|\d+\.)\s+(.*)$/)
          if (!m) break
          items.push(renderInline(m[2]))
          i++
        }
        const tag = ordered ? 'ol' : 'ul'
        out.push('<' + tag + '>' + items.map((it) => '<li>' + it + '</li>').join('') + '</' + tag + '>')
        continue
      }
      if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        flushPara()
        const parseRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => renderInline(c.trim()))
        const header = parseRow(line)
        i += 2
        const rows = []
        while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(parseRow(lines[i])); i++ }
        out.push(
          '<table><thead><tr>' + header.map((c) => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table>',
        )
        continue
      }
      if (/^\s*$/.test(line)) {
        flushPara()
        i++
        continue
      }
      para.push(line)
      i++
    }
    flushPara()
    return out.join('')
  }

  /* ---------------- tool cards ---------------- */

  const TOOL_ICON = {
    bash: '🖥️', write: '📝', edit: '✏️', read: '📄', list: '📂', search: '🔍',
    web_search: '🌐', web_fetch: '🔗', subagent: '👤', todo_write: '✅',
    skill: '📘', ask_user: '❓', workflow: '🔀',
  }

  function toolIcon(name) {
    if (TOOL_ICON[name] !== undefined) return TOOL_ICON[name]
    if (name.includes('web')) return '🌐'
    if (name.includes('fs') || name.includes('file') || name.includes('read') || name.includes('write') || name.includes('edit')) return '📄'
    if (name.includes('bash') || name.includes('shell') || name.includes('pwsh') || name.includes('run')) return '🖥️'
    if (name.includes('subagent')) return '👤'
    return '🛠️'
  }

  function truncate(s, n) {
    s = String(s ?? '')
    return s.length > n ? s.slice(0, n) + '\n…（已截断）' : s
  }

  function prettyJson(raw) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      return String(raw ?? '')
    }
  }

  function renderToolCard(card) {
    const el = document.createElement('div')
    el.className = 'tool-card' + (card.isError ? ' error' : '')
    el.dataset.callId = card.callId
    const argsText = truncate(prettyJson(card.args), 1500)
    const status = card.endTime !== undefined ? (card.isError ? '❌' : '✅') : '⏳'
    el.innerHTML =
      '<div class="tc-head">' +
      '<span>' + toolIcon(card.name) + '</span>' +
      '<span class="tc-name">' + esc(card.name) + '</span>' +
      '<span class="tc-status">' + status + '</span>' +
      '</div>' +
      '<div class="tc-detail" hidden>' +
      '<pre>' + esc(argsText) + '</pre>' +
      (card.resultText !== undefined
        ? '<div class="tc-result">' + esc(truncate(card.resultText, 3000)) + '</div>'
        : '') +
      '</div>'
    const head = el.querySelector('.tc-head')
    head.addEventListener('click', () => {
      const detail = el.querySelector('.tc-detail')
      detail.hidden = !detail.hidden
    })
    return el
  }

  /* ---------------- message rendering ---------------- */

  function renderMessage(msg) {
    const wrap = document.createElement('div')
    if (msg.role === 'notice') {
      wrap.className = 'msg notice'
      wrap.textContent = msg.text ?? ''
      return wrap
    }
    wrap.className = 'msg ' + msg.role
    const meta = document.createElement('div')
    meta.className = 'meta'
    const body = document.createElement('div')
    body.className = 'body'
    if (msg.role === 'user') {
      meta.textContent = '🧑 你'
      body.textContent = msg.text ?? ''
    } else if (msg.role === 'assistant') {
      const statusTag = statusLabel(msg.status)
      meta.innerHTML = '<span>🤖 ' + esc(state.currentModel ? state.currentModel.label : 'DSH') + '</span>' + statusTag
      body.innerHTML = renderMarkdown(msg.text)
      if (msg.reasoning) {
        const r = document.createElement('details')
        r.className = 'reasoning'
        r.innerHTML = '<summary>💭 思考过程</summary><div>' + esc(msg.reasoning) + '</div>'
        body.appendChild(r)
      }
      for (const card of msg.toolCalls ?? []) body.appendChild(renderToolCard(card))
      if (msg.usage !== undefined && msg.usage !== null) {
        const u = document.createElement('div')
        u.className = 'usage'
        u.textContent = usageText(msg.usage)
        body.appendChild(u)
      }
      if (msg.error) {
        const e = document.createElement('div')
        e.className = 'usage'
        e.textContent = '⚠️ ' + msg.error
        body.appendChild(e)
      }
    } else {
      meta.textContent = '🛠 工具'
      body.textContent = msg.text ?? ''
    }
    wrap.appendChild(meta)
    wrap.appendChild(body)
    return wrap
  }

  function statusLabel(status) {
    if (status === 'cancelled') return '<span class="status-tag cancelled">已取消</span>'
    if (status === 'error') return '<span class="status-tag error">出错</span>'
    if (status === 'max-tokens') return '<span class="status-tag max-tokens">已达输出上限</span>'
    return ''
  }

  function usageText(u) {
    const parts = ['in ' + (u.inputTokens ?? 0)]
    if (u.cacheRead) parts.push('cache ' + u.cacheRead)
    if (u.cacheWrite) parts.push('cacheW ' + u.cacheWrite)
    parts.push('out ' + (u.outputTokens ?? 0))
    if (u.reasoning) parts.push('reasoning ' + u.reasoning)
    return 'tokens: ' + parts.join(' · ')
  }

  /* ---------------- transcript ---------------- */

  function activeMessages() {
    return state.transcript && state.transcript.messages ? state.transcript.messages : []
  }

  function renderTranscript() {
    transcriptEl.textContent = ''
    const msgs = activeMessages()
    if (msgs.length === 0) {
      const empty = document.createElement('div')
      empty.id = 'empty'
      empty.innerHTML = '🪄 在下方输入消息，开始与 DSH 智能体协作。<br>也可右键选中代码 → “询问选中代码”。'
      transcriptEl.appendChild(empty)
      return
    }
    const frag = document.createDocumentFragment()
    for (const m of msgs) frag.appendChild(renderMessage(m))
    transcriptEl.appendChild(frag)
    scrollBottom(true)
  }

  function scrollBottom(force) {
    const nearBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 120
    if (force || nearBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight
  }

  function bubbleEl(msgId) {
    for (const child of transcriptEl.children) {
      if (child.dataset && child.dataset.msgId === msgId) return child
    }
    return undefined
  }

  function ensureBubble(msgId) {
    let el = bubbleEl(msgId)
    if (el !== undefined) return el
    el = document.createElement('div')
    el.className = 'msg assistant'
    el.dataset.msgId = msgId
    const meta = document.createElement('div')
    meta.className = 'meta'
    meta.innerHTML = '<span>🤖 ' + esc(state.currentModel ? state.currentModel.label : 'DSH') + '</span>'
    const body = document.createElement('div')
    body.className = 'body'
    el.appendChild(meta)
    el.appendChild(body)
    el._body = body
    el._meta = meta
    const emptyNode = transcriptEl.querySelector('#empty')
    if (emptyNode !== undefined) emptyNode.remove()
    transcriptEl.appendChild(el)
    scrollBottom()
    return el
  }

  function updateBubbleContent(el, text, reasoning) {
    el._body.textContent = ''
    el._body.innerHTML = renderMarkdown(text)
    let r = el.querySelector('.reasoning')
    if (reasoning) {
      if (r === null) {
        r = document.createElement('details')
        r.className = 'reasoning'
        el._body.appendChild(r)
      }
      r.innerHTML = '<summary>💭 思考过程</summary><div>' + esc(reasoning) + '</div>'
    } else if (r !== null) {
      r.remove()
    }
  }

  /* ---------------- header ---------------- */

  function renderModelSelect() {
    const sel = $('model-select')
    sel.textContent = ''
    for (const m of state.models) {
      const opt = document.createElement('option')
      opt.value = m.provider + '|' + m.model
      opt.textContent = m.label
      if (state.currentModel && m.provider === state.currentModel.provider && m.model === state.currentModel.model) {
        opt.selected = true
      }
      sel.appendChild(opt)
    }
  }

  function renderTabs() {
    const tabs = $('session-tabs')
    tabs.textContent = ''
    if (state.sessions.length === 0) {
      const span = document.createElement('span')
      span.className = 'hint'
      span.textContent = '（无会话）'
      tabs.appendChild(span)
      return
    }
    for (const s of state.sessions) {
      const tab = document.createElement('button')
      tab.className = 'session-tab' + (s.id === state.activeId ? ' active' : '') + (s.closed ? ' closed' : '')
      tab.title = s.title + ' · ' + s.model + (s.running ? ' · 运行中' : '')
      tab.textContent = (s.running ? '● ' : '') + s.title
      const close = document.createElement('span')
      close.className = 'close'
      close.textContent = '×'
      close.addEventListener('click', (ev) => {
        ev.stopPropagation()
        vscode.postMessage({ type: 'delete-session', id: s.id })
      })
      tab.appendChild(close)
      tab.addEventListener('click', () => {
        if (s.id !== state.activeId) vscode.postMessage({ type: 'switch-session', id: s.id })
      })
      tabs.appendChild(tab)
    }
  }

  function renderConn() {
    const dot = $('conn-dot')
    const text = $('conn-text')
    dot.className = 'dot'
    if (state.running) {
      dot.classList.add('running')
      text.textContent = state.detail || '运行中…'
    } else if (state.connected) {
      dot.classList.add('connected')
      text.textContent = state.detail || '已连接'
    } else {
      dot.classList.add('error')
      text.textContent = state.detail || '未连接'
    }
  }

  function renderTodos() {
    const wrap = $('todos-wrap')
    const ul = $('todos')
    ul.textContent = ''
    const todos = state.transcript && state.transcript.todos ? state.transcript.todos : []
    if (todos.length === 0) {
      wrap.hidden = true
      return
    }
    wrap.hidden = false
    for (const t of todos) {
      const li = document.createElement('li')
      li.className = t.status
      li.textContent = t.content
      ul.appendChild(li)
    }
  }

  function renderComposer() {
    sendBtn.disabled = state.running || inputEl.value.trim() === ''
    $('btn-stop').disabled = !state.running
  }

  function renderAll() {
    renderModelSelect()
    renderTabs()
    renderTranscript()
    renderTodos()
    renderConn()
    renderComposer()
    $('model-badge').textContent = state.currentModel ? state.currentModel.label : ''
  }

  /* ---------------- deltas ---------------- */

  function applyDelta(d) {
    if (d.sessionId !== state.activeId) return
    if (!state.transcript) return
    switch (d.kind) {
      case 'user-msg':
        state.transcript.messages.push(d.msg)
        transcriptEl.appendChild(renderMessage(d.msg))
        scrollBottom()
        break
      case 'assistant-delta': {
        const el = ensureBubble(d.msgId)
        updateBubbleContent(el, d.text, d.reasoning)
        break
      }
      case 'assistant-commit': {
        const el = ensureBubble(d.msgId)
        updateBubbleContent(el, d.text, d.reasoning)
        el._body.querySelectorAll('.tool-card').forEach((n) => n.remove())
        for (const card of d.toolCalls ?? []) el._body.appendChild(renderToolCard(card))
        const oldUsage = el.querySelector('.usage')
        if (oldUsage !== null) oldUsage.remove()
        if (d.usage !== undefined && d.usage !== null) {
          const u = document.createElement('div')
          u.className = 'usage'
          u.textContent = usageText(d.usage)
          el._body.appendChild(u)
        }
        const msg = activeMessages().find((m) => m.id === d.msgId)
        if (msg !== undefined) {
          msg.text = d.text
          msg.reasoning = d.reasoning
          msg.usage = d.usage
          msg.toolCalls = d.toolCalls
        }
        break
      }
      case 'tool-start': {
        const el = ensureBubble(d.msgId)
        const existing = el._body.querySelector('.tool-card[data-call-id="' + CSS.escape(d.card.callId) + '"]')
        if (existing !== null) existing.remove()
        el._body.appendChild(renderToolCard(d.card))
        break
      }
      case 'tool-end': {
        const el = bubbleEl(d.msgId)
        if (el === undefined) return
        const existing = el.querySelector('.tool-card[data-call-id="' + CSS.escape(d.card.callId) + '"]')
        if (existing !== null) {
          const fresh = renderToolCard(d.card)
          existing.replaceWith(fresh)
          fresh.querySelector('.tc-detail').hidden = false
        }
        const msg = activeMessages().find((m) => m.id === d.msgId)
        if (msg !== undefined) {
          const card = (msg.toolCalls ?? []).find((c) => c.callId === d.card.callId)
          if (card !== undefined) Object.assign(card, d.card)
        }
        break
      }
      case 'turn-end': {
        for (const child of transcriptEl.children) {
          if (child.dataset && child.dataset.msgId !== undefined) {
            const st = d.status
            if (st === 'cancelled') child.querySelector('.meta')?.insertAdjacentHTML('beforeend', '<span class="status-tag cancelled">已取消</span>')
            if (st === 'error') child.querySelector('.meta')?.insertAdjacentHTML('beforeend', '<span class="status-tag error">出错</span>')
            if (st === 'max-tokens') child.querySelector('.meta')?.insertAdjacentHTML('beforeend', '<span class="status-tag max-tokens">已达输出上限</span>')
          }
        }
        if (d.error) toast('⚠️ ' + d.error)
        break
      }
      case 'notice': {
        const n = document.createElement('div')
        n.className = 'msg notice'
        n.textContent = d.text
        transcriptEl.appendChild(n)
        state.transcript.messages.push({ id: 'n-' + Date.now() + Math.random().toString(36).slice(2, 5), role: 'notice', time: Date.now(), text: d.text })
        scrollBottom()
        break
      }
      case 'title':
        state.transcript.title = d.title
        renderTabs()
        break
      case 'todos':
        state.transcript.todos = d.todos
        renderTodos()
        break
      default:
        break
    }
  }

  /* ---------------- host messages ---------------- */

  window.addEventListener('message', (event) => {
    const msg = event.data
    switch (msg.type) {
      case 'state': {
        state.models = msg.models ?? []
        state.currentModel = msg.currentModel ?? state.currentModel
        state.sessions = msg.sessions ?? []
        state.activeId = msg.activeId
        state.transcript = msg.transcript
        state.connected = msg.connected === true
        state.detail = msg.detail ?? ''
        state.running = state.transcript ? state.transcript.running === true : false
        renderAll()
        break
      }
      case 'session-list':
        state.sessions = msg.sessions ?? []
        state.activeId = msg.activeId
        renderTabs()
        break
      case 'switch-session':
        state.transcript = msg.session
        state.activeId = state.transcript.id
        state.running = state.transcript.running === true
        renderTranscript()
        renderTabs()
        renderTodos()
        renderConn()
        renderComposer()
        break
      case 'delta':
        applyDelta(msg)
        break
      case 'running':
        state.running = msg.running === true
        if (state.transcript) state.transcript.running = state.running
        renderConn()
        renderComposer()
        break
      case 'connected':
        state.connected = msg.connected === true
        state.detail = msg.detail ?? ''
        renderConn()
        break
      case 'model':
        state.currentModel = msg.model
        renderModelSelect()
        $('model-badge').textContent = msg.model.label
        break
      case 'context':
        inputEl.value += (inputEl.value ? '\n' : '') + msg.text
        inputEl.focus()
        renderComposer()
        break
      case 'focus-input':
        inputEl.focus()
        break
      case 'error':
        toast('⚠️ ' + msg.message)
        break
      default:
        break
    }
  })

  /* ---------------- user actions ---------------- */

  function toast(text) {
    toastEl.textContent = text
    toastEl.style.display = 'block'
    clearTimeout(toast._t)
    toast._t = setTimeout(() => { toastEl.style.display = 'none' }, 5000)
  }

  sendBtn.addEventListener('click', () => {
    const text = inputEl.value
    if (text.trim() === '' || state.running) return
    inputEl.value = ''
    inputEl.style.height = ''
    renderComposer()
    vscode.postMessage({ type: 'send', text })
  })

  inputEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault()
      sendBtn.click()
    }
  })
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto'
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px'
    renderComposer()
  })

  $('btn-new').addEventListener('click', () => vscode.postMessage({ type: 'new-session' }))
  $('btn-stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }))
  $('btn-export').addEventListener('click', () => vscode.postMessage({ type: 'export' }))
  $('btn-restart').addEventListener('click', () => vscode.postMessage({ type: 'restart-runtime' }))
  $('model-select').addEventListener('change', (ev) => {
    const [provider, model] = ev.target.value.split('|')
    const option = state.models.find((m) => m.provider === provider && m.model === model)
    if (option !== undefined) vscode.postMessage({ type: 'change-model', label: option.label, provider, model })
  })
  $('ctx-selection').addEventListener('click', () => vscode.postMessage({ type: 'context', kind: 'selection' }))
  $('ctx-file').addEventListener('click', () => vscode.postMessage({ type: 'context', kind: 'file' }))
  $('btn-todos-toggle').addEventListener('click', () => {
    $('todos').hidden = !$('todos').hidden
  })

  vscode.postMessage({ type: 'ready' })
})()
