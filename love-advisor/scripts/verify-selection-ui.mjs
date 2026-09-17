import { pathToFileURL } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')
import assert from 'node:assert/strict'
import fs from 'node:fs'

fs.mkdirSync('artifacts/selection', { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const [name, width, height] of [['desktop', 1440, 960], ['mobile', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    const records = [1, 2, 3].map(id => ({ id, senderName: id % 2 ? 'Me' : 'Peer',
      time: `2026-09-10 12:0${id}:00`, type: 'text', content: `Selected message ${id}` }))
    const conv = { id: 'conv_ui', title: 'Selection test', caseId: 'case_ui', messages: [], updatedAt: new Date().toISOString() }
    const workspace = { id: 'case_ui', title: 'Test workspace', sessionIds: ['chat_ui'] }
    let sent
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url())
      let data = {}
      if (url.pathname === '/api/cases') data = { items: [workspace] }
      if (url.pathname === '/api/sessions') data = { items: [{ id: 'chat_ui', name: 'Peer', type: 'private', totalMessages: 3 }] }
      if (url.pathname === '/api/conversations') data = { items: [conv] }
      if (url.pathname === '/api/conversations/conv_ui') data = conv
      if (url.pathname === '/api/skills') data = { items: [] }
      if (url.pathname === '/api/clb/messages') {
        return route.fulfill({ json: { ok: true, data: { items: records }, meta: { ownerName: 'Me', hasMore: false } } })
      }
      if (url.pathname === '/api/runs') {
        sent = route.request().postDataJSON()
        conv.messages = [{ role: 'user', content: sent.text, selectionContext: { sessionName: 'Peer', messages: records.filter(m => sent.selection.messageIds.includes(m.id)) } },
          { role: 'assistant', content: 'Verified answer', tools: [] }]
        return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"run.created","runId":"run_ui","conversationId":"conv_ui"}\n\ndata: {"type":"message.delta","t":"Verified answer"}\n\ndata: {"type":"run.completed"}\n\ndata: [DONE]\n\n' })
      }
      return route.fulfill({ json: { ok: true, data } })
    })
    await page.goto('http://127.0.0.1:3111')
    await page.getByRole('button', { name: '新建工作区', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isDisabled(), true)
    await page.screenshot({ path: `artifacts/selection/${name}-workspace.png` })
    await page.getByRole('button', { name: '导入私聊并创建工作区', exact: true }).click()
    await page.getByRole('button', { name: '关闭导入', exact: true }).click()
    if (width < 820) await page.getByRole('button', { name: '收起侧栏' }).click()
    await page.getByRole('button', { name: '选择聊天记录', exact: true }).click()
    await page.getByRole('checkbox', { name: '选择消息 1', exact: true }).check()
    await page.getByRole('checkbox', { name: '选择消息 2', exact: true }).check()
    await page.screenshot({ path: `artifacts/selection/${name}-picker.png` })
    await page.getByRole('button', { name: '加入上下文' }).click()
    await page.locator('.selection-preview summary').click()
    await page.getByRole('button', { name: '移除消息 1', exact: true }).click()
    assert.equal(await page.locator('.selection-item').count(), 1)
    await page.screenshot({ path: `artifacts/selection/${name}-composer.png` })
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.locator('.md-content').getByText('Verified answer', { exact: true }).waitFor()
    assert.deepEqual(sent.selection, { sessionId: 'chat_ui', messageIds: [2] })
    await page.reload()
    await page.getByText('Peer · 引用 1 条聊天记录', { exact: true }).waitFor()
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`${name}: selection, remove, send, reload passed`)
  }
} finally { await browser.close() }
