import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractBvId,
  formatTimestamp,
  parseBilibiliSubtitleJson,
  parseSrtOrVtt,
  parsePlainText,
  parseAnySubtitleInput,
  formatSubtitleLines,
  fingerprintSubtitle,
  chunkSubtitles,
  fetchVideoInfo,
  fetchSubtitle,
  getBilibiliGuestCookie,
  normalizeBilibiliSessionCookie,
  BILIBILI_ERROR_CODES,
} from './bilibili.js'

test('extractBvId 能够从各种格式中准确识别 BV 号', () => {
  assert.equal(extractBvId('BV1qb17BxEQZ'), 'BV1qb17BxEQZ')
  assert.equal(extractBvId('https://www.bilibili.com/video/BV1qb17BxEQZ?spm_id_from=333.999'), 'BV1qb17BxEQZ')
  assert.equal(extractBvId('【恋爱军师】BV159BxBdEc8 这是标题'), 'BV159BxBdEc8')
  assert.equal(extractBvId('bvid: BV1DNyVBaEte'), 'BV1DNyVBaEte')
  assert.equal(extractBvId(''), null)
  assert.equal(extractBvId('invalid string'), null)
  assert.equal(extractBvId('BV123'), null) // 长度不够
})

test('formatTimestamp 秒数转换为 [MM:SS]', () => {
  assert.equal(formatTimestamp(0), '[00:00]')
  assert.equal(formatTimestamp(75.5), '[01:15]')
  assert.equal(formatTimestamp(3600), '[60:00]')
  assert.equal(formatTimestamp(-10), '[00:00]')
})

test('parseBilibiliSubtitleJson 正确解析 B 站官方/AI字幕结构', () => {
  const mockJson = {
    body: [
      { from: 1.2, to: 3.5, content: '大家好我是谟西' },
      { from: 4.0, to: 6.8, content: '今天来看这个投稿案例' },
      { from: 7.0, to: 8.0, content: '   ' }, // 空白过滤
    ],
  }
  const items = parseBilibiliSubtitleJson(mockJson, 'BV1test')
  assert.equal(items.length, 2)
  assert.equal(items[0].line, 1)
  assert.equal(items[0].bvid, 'BV1test')
  assert.equal(items[0].content, '大家好我是谟西')
  assert.equal(items[1].line, 2)
  assert.equal(items[1].content, '今天来看这个投稿案例')
})

test('parseSrtOrVtt 正确解析标准 SRT 与 VTT 格式', () => {
  const srt = `
1
00:00:01,200 --> 00:00:03,500
第一句话

2
00:01:10.500 --> 00:01:15.000
第二句话
换行内容
`
  const items = parseSrtOrVtt(srt, 'BV1test')
  assert.equal(items.length, 2)
  assert.equal(items[0].content, '第一句话')
  assert.equal(items[0].from, 1.2)
  assert.equal(items[1].content, '第二句话 换行内容')
  assert.equal(items[1].from, 70.5)
})

test('parsePlainText 支持带时间戳或纯文本按行切分', () => {
  const text = `
[01:20] 对方主动给我发了早安
[01:25] 但后续半天没有回复
第三句没有任何时间戳
`
  const items = parsePlainText(text, 'BV1plain')
  assert.equal(items.length, 3)
  assert.equal(items[0].content, '对方主动给我发了早安')
  assert.equal(items[0].from, 80)
  assert.equal(items[1].content, '但后续半天没有回复')
  assert.equal(items[1].from, 85)
  assert.equal(items[2].content, '第三句没有任何时间戳')
})

test('parseAnySubtitleInput 自动检测 JSON、SRT 与纯文本', () => {
  const jsonStr = JSON.stringify([{ from: 0, to: 1, content: 'JSON字幕' }])
  const items1 = parseAnySubtitleInput(jsonStr, 'BV1')
  assert.equal(items1[0].content, 'JSON字幕')

  const srtStr = '00:00:01,000 --> 00:00:02,000\nSRT字幕'
  const items2 = parseAnySubtitleInput(srtStr, 'BV2')
  assert.equal(items2[0].content, 'SRT字幕')

  const plain = '普通文本第一行\n普通文本第二行'
  const items3 = parseAnySubtitleInput(plain, 'BV3')
  assert.equal(items3.length, 2)
})

test('formatSubtitleLines 生成带时间戳与行号引用的标准化格式', () => {
  const items = [
    { line: 1, bvid: 'BV1test', from: 65, to: 70, content: '测试内容A' },
    { line: 2, bvid: 'BV1test', from: 72, to: 75, content: '测试内容B' },
  ]
  const formatted = formatSubtitleLines(items)
  assert.equal(formatted, '[01:05] BV1test:1 测试内容A\n[01:12] BV1test:2 测试内容B')
})

test('fingerprintSubtitle 只在字幕内容一致时复用同一摘要', () => {
  const source = [{ line: 1, bvid: 'BV1testtest', from: 1, to: 2, content: '第一句字幕' }]
  assert.equal(fingerprintSubtitle(source), fingerprintSubtitle([{ ...source[0] }]))
  assert.notEqual(fingerprintSubtitle(source), fingerprintSubtitle([{ ...source[0], content: '另一句字幕' }]))
})

test('chunkSubtitles 遵守字符上限并保留行完整性与上下文重叠', () => {
  const items = []
  for (let i = 1; i <= 20; i++) {
    items.push({
      line: i,
      bvid: 'BV1test',
      from: i * 5,
      to: (i + 1) * 5,
      content: `这是第${i}行测试内容，包含若干字符用来撑大分片长度以验证分片切分边界。`,
    })
  }

  const chunks = chunkSubtitles(items, { maxChars: 250, overlapLines: 2 })
  assert.ok(chunks.length >= 3, `应该切出多个分片，当前为 ${chunks.length}`)
  assert.equal(chunks[0].fromLine, 1)
  assert.ok(chunks[0].text.includes('BV1test:1'))
  // 第二个分片因 overlapLines = 2，应当包含上个分片结尾的行
  assert.ok(chunks[1].fromLine <= chunks[0].toLine)
})

test('getBilibiliGuestCookie 正确处理成功与失败情况', async () => {
  const mockFetchSuccess = async () => ({
    ok: true,
    json: async () => ({ data: { b_3: 'test_b3', b_4: 'test_b4' } }),
  })
  const cookie = await getBilibiliGuestCookie(mockFetchSuccess)
  assert.equal(cookie, 'buvid3=test_b3; buvid4=test_b4')

  const mockFetchFail = async () => { throw new Error('network down') }
  const failCookie = await getBilibiliGuestCookie(mockFetchFail)
  assert.equal(failCookie, '')
})

test('B 站登录态只提取 SESSDATA，不接受任意 Cookie 字段', () => {
  assert.equal(
    normalizeBilibiliSessionCookie('buvid3=visitor; SESSDATA=logged_in_token%2Cvalue; bili_jct=ignored'),
    'SESSDATA=logged_in_token%2Cvalue',
  )
  assert.equal(normalizeBilibiliSessionCookie('short_token'), 'SESSDATA=short_token')
  assert.throws(() => normalizeBilibiliSessionCookie('bili_jct=not_session'), /SESSDATA/)
})

test('fetchVideoInfo 与 fetchSubtitle 联动 mock 验证', async () => {
  const mockFetch = async (url) => {
    if (url.includes('/view?bvid=')) {
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            bvid: 'BV1mockVideo',
            aid: 123456,
            cid: 987654,
            title: '恋爱军师模拟视频',
            owner: { name: '谟老师' },
            duration: 600,
          },
        }),
      }
    }
    if (url.includes('/player/v2')) {
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            subtitle: {
              subtitles: [
                {
                  lan: 'ai-zh',
                  lan_doc: '中文（AI生成）',
                  subtitle_url: '//aisubtitle.hdslb.com/mock.json',
                },
              ],
            },
          },
        }),
      }
    }
    if (url.includes('mock.json')) {
      return {
        ok: true,
        json: async () => ({
          body: [
            { from: 10, to: 15, content: '模拟的字幕内容第一句' },
            { from: 16, to: 20, content: '模拟的字幕内容第二句' },
          ],
        }),
      }
    }
    throw new Error(`Unexpected url: ${url}`)
  }

  const result = await fetchSubtitle('BV1mockVideo', { customFetch: mockFetch })
  assert.equal(result.videoInfo.title, '恋爱军师模拟视频')
  assert.equal(result.videoInfo.ownerName, '谟老师')
  assert.equal(result.items.length, 2)
  assert.ok(result.formattedText.includes('BV1mockVideo:1 模拟的字幕内容第一句'))
})

test('登录后可见的字幕返回可供前端分支处理的错误码', async () => {
  const mockFetch = async (url) => {
    if (url.includes('/view?bvid=')) {
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: { bvid: 'BV1loginTest', cid: 13579, title: '登录字幕视频', owner: { name: '测试 UP' } },
        }),
      }
    }
    if (url.includes('/player/v2')) {
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: { need_login_subtitle: true, subtitle: { subtitles: [] } },
        }),
      }
    }
    throw new Error(`Unexpected url: ${url}`)
  }

  await assert.rejects(
    fetchSubtitle('BV1loginTest', { customFetch: mockFetch }),
    error => error.code === BILIBILI_ERROR_CODES.LOGIN_REQUIRED_FOR_SUBTITLE,
  )
})
