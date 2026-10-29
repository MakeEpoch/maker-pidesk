import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zstdCompressSync } from 'node:zlib'

import {
  ACTIVE_SECONDS,
  MAX_AGE_SECONDS,
  needsInput,
  parseLines,
  summarizeDshEvents,
  dshTaskFromSummary,
  dshTaskFromEvents,
  summarizeCodexRecords,
  codexTaskFromSummary,
  collectTasks,
  pushPayload,
  pushToPidesk,
} from '../host/agents.js'
import { readConfig, publicConfig, expandHome, notifyReady } from '../host/config.js'
import {
  barkPayload,
  barkUrl,
  clip,
  defaultLevel,
  noticesFor,
  sendNotice,
  wants,
  webhookPayload,
} from '../host/notify.js'

const now = Date.now() / 1000
const dshEvents = (over = {}) => ([
  { type: 'session', time: 1 },
  { type: 'user/message', time: 1e12, data: { content: [{ type: 'text', text: '帮我修 bug' }] } },
  { type: 'session/title', time: 1e12, data: { title: '修 bug' } },
  { type: 'turn/start', time: 1e12 },
  { type: 'assistant/message', time: (now - 10) * 1000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '正在修' }] } } },
  ...(over.extra || []),
])

test('needsInput 检测问句结尾', () => {
  assert.equal(needsInput('要用方案A还是方案B？'), true)
  assert.equal(needsInput('完成。'), false)
  assert.equal(needsInput(''), false)
  assert.equal(needsInput('配置好了吗?'), true)
})

test('parseLines 跳过坏行与超长行', () => {
  const text = '{"a":1}\nnot-json\n{"b":2}\n' + 'x'.repeat(1_100_000) + '\n{"c":3}'
  const parsed = parseLines(text)
  assert.deepEqual(parsed.map((r) => Object.keys(r)[0]), ['a', 'b', 'c'])
})

test('DSH running：turn 未闭合且近期有输出', () => {
  const task = dshTaskFromEvents('session-abc', dshEvents(), now)
  assert.equal(task.id, 'dsh:session-abc')
  assert.equal(task.status, 'running')
  assert.equal(task.title, '修 bug')
  assert.equal(task.detail, '正在修')
})

test('DSH turn 闭合 + 问句结尾 → needs_input', () => {
  const events = dshEvents({ extra: [
    { type: 'assistant/message', time: (now - 5) * 1000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '要用方案A还是方案B？' }] } } },
    { type: 'turn/end', time: (now - 5) * 1000 },
  ] })
  const task = dshTaskFromEvents('session-q', events, now)
  assert.equal(task.status, 'needs_input')
})

test('DSH turn 闭合 + 陈述结尾 → done', () => {
  const events = dshEvents({ extra: [
    { type: 'assistant/message', time: (now - 5) * 1000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '修好了。' }] } } },
    { type: 'turn/end', time: (now - 5) * 1000 },
  ] })
  const task = dshTaskFromEvents('session-d', events, now)
  assert.equal(task.status, 'done')
})

test('DSH 标题缺失回退首条用户消息', () => {
  const events = dshEvents().filter((e) => e.type !== 'session/title')
  const task = dshTaskFromEvents('session-x', events, now)
  assert.equal(task.title, '帮我修 bug')
})

test('DSH 超龄任务不产出', () => {
  const events = dshEvents().map((e) => ({ ...e, time: (now - MAX_AGE_SECONDS - 100) * 1000 }))
  const summary = summarizeDshEvents('session-old', events)
  assert.equal(dshTaskFromSummary(summary, now), null)
})

const codexRecords = (over = {}) => ([
  { type: 'session_meta', payload: { id: 'cx1', cwd: '/work/project' } },
  { type: 'event_msg', payload: { type: 'task_started', started_at: now - 30 } },
  ...(over.extra || []),
])

test('Codex running：started 多于 complete', () => {
  const task = codexTaskFromSummary(summarizeCodexRecords('f', codexRecords()), now)
  assert.equal(task.id, 'codex:cx1')
  assert.equal(task.status, 'running')
  assert.equal(task.title, '/work/project')
})

test('Codex 完成带问句 → needs_input', () => {
  const records = codexRecords({ extra: [
    { type: 'event_msg', payload: { type: 'task_complete', completed_at: now - 20, last_agent_message: '全部测试通过，要提交吗？' } },
  ] })
  const task = codexTaskFromSummary(summarizeCodexRecords('f', records), now)
  assert.equal(task.status, 'needs_input')
  assert.equal(task.detail, '全部测试通过，要提交吗？')
})

test('Codex 陈旧 task_complete 仍按完成展示', () => {
  const records = codexRecords({ extra: [
    { type: 'event_msg', payload: { type: 'task_complete', completed_at: now - ACTIVE_SECONDS - 60, last_agent_message: '完成' } },
  ] })
  const task = codexTaskFromSummary(summarizeCodexRecords('f', records), now)
  assert.equal(task.status, 'done')
})

test('pushPayload 结构', () => {
  const task = { id: 'x', source: 'DSH', title: 't', detail: '', status: 'done', updated: 1 }
  assert.equal(pushPayload([task], 1234.4).pushed_at, 1234)
  // 毫秒时间戳自动转秒（pidesk 侧按秒校验 ±600s）
  const ms = Date.now()
  assert.equal(pushPayload([task], ms).pushed_at, Math.round(ms / 1000))
  const payload = pushPayload([task], 1234)
  assert.equal(payload.agents.length, 1)
  assert.deepEqual(Object.keys(payload).sort(), ['agents', 'pushed_at'])
})

test('pushToPidesk 成功、失败与请求头', async () => {
  const ok = await pushToPidesk({
    url: 'http://x/api/agents-push', token: 'tok', payload: pushPayload([], 1),
    fetchImpl: async () => ({ ok: true, status: 200 }),
  })
  assert.deepEqual(ok, { ok: true, status: 200, count: 0 })
  const fail = await pushToPidesk({
    url: 'http://x/api/agents-push', token: 'tok', payload: pushPayload([], 1),
    fetchImpl: async () => ({ ok: false, status: 403 }),
  })
  assert.equal(fail.ok, false)
  assert.equal(fail.status, 403)
  let seen = null
  await pushToPidesk({
    url: 'http://x/api/agents-push', token: 'secret-token', payload: pushPayload([], 1),
    fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 200 } },
  })
  assert.equal(seen.init.headers.Authorization, 'Bearer secret-token')
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.headers['Content-Type'], 'application/json')
})

test('默认关闭且未配置地址时不会发送；启用时必须填写地址', () => {
  assert.equal(readConfig({}).enabled, false)
  assert.equal(readConfig({}).url, '')
  assert.throws(() => readConfig({ enabled: true }), /推送地址/)
})

test('配置校验', () => {
  const base = { url: 'http://pi:8765/api/agents-push', token: 'abcdefgh1234', intervalSeconds: 15, dshHome: '~/.dsh', codexHome: '~/.codex' }
  assert.equal(readConfig(base).intervalSeconds, 15)
  assert.equal(readConfig(base).dshHome, expandHome('~/.dsh'))
  assert.throws(() => readConfig({ ...base, url: 'ftp://x' }), /http/)
  assert.throws(() => readConfig({ ...base, intervalSeconds: 1 }), /间隔/)
  assert.throws(() => readConfig({ ...base, token: 'short' }), /令牌/)
  assert.throws(() => readConfig({ ...base, enabled: 'yes' }), /布尔/)
  const pub = publicConfig(base)
  assert.equal(pub.token, undefined)
  assert.equal(pub.tokenConfigured, true)
})

test('readConfig 兼容 volatile 引用对象与缺省', () => {
  const base = { url: 'http://pi:8765/api/agents-push', intervalSeconds: { get: () => 30 } }
  const config = readConfig(base)
  assert.equal(config.intervalSeconds, 30)
  assert.equal(config.enabled, false)
  assert.equal(config.codexHome, expandHome('~/.codex'))
})

// --------- 真实文件系统往返（zstd 压缩写 → 插件解压读） ---------

async function mkdtempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix))
}

test('dshTasksFromFilesystem 解压真实 zstd 会话文件', async () => {
  const root = await mkdtempDir('pidesk-sync-')
  try {
    const sessionDir = join(root, 'sessions', 'ws', 'session-real')
    await mkdir(sessionDir, { recursive: true })
    const lines = dshEvents().map((e) => JSON.stringify(e)).join('\n')
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines, 'utf8')))
    const { dshTasksFromFilesystem } = await import('../host/agents.js')
    const cache = new Map()
    const tasks = await dshTasksFromFilesystem(root, now, { cache })
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].id, 'dsh:session-real')
    assert.equal(tasks[0].status, 'running')
    // 缓存命中：文件未变时不再解压（读缓存路径）
    const again = await dshTasksFromFilesystem(root, now, { cache })
    assert.equal(again.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('codexTasksFromFilesystem 读取 rollout 文件并排序', async () => {
  const root = await mkdtempDir('pidesk-sync-')
  try {
    const dir = join(root, 'sessions', '2026', '10', '25')
    await mkdir(dir, { recursive: true })
    const doneRecords = codexRecords({ extra: [
      { type: 'event_msg', payload: { type: 'task_complete', completed_at: now - 20, last_agent_message: '全部通过' } },
    ] })
    await writeFile(join(dir, 'rollout-done.jsonl'), doneRecords.map((r) => JSON.stringify(r)).join('\n'))
    await new Promise((r) => setTimeout(r, 20))
    await writeFile(join(dir, 'rollout-running.jsonl'), codexRecords().map((r) => JSON.stringify(r)).join('\n'))
    const { codexTasksFromFilesystem } = await import('../host/agents.js')
    const tasks = await codexTasksFromFilesystem(root, now, {})
    // 两个文件同 threadId —— 归并成一条（按更新时间取新的）
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].status, 'done')
    assert.equal(tasks[0].source, 'Codex')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('collectTasks：服务只发现会话目录，内容走文件，合并排序', async () => {
  const dshRoot = await mkdtempDir('pidesk-sync-')
  const codexRoot = await mkdtempDir('pidesk-sync-')
  try {
    // DSH 侧：一个落盘会话 + 服务目录里的一个新会话（尚无文件）
    const sessionDir = join(dshRoot, 'sessions', 'ws', 'session-onsvc')
    await mkdir(sessionDir, { recursive: true })
    const lines = dshEvents().map((e) => JSON.stringify(e)).join('\n')
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines, 'utf8')))
    const dir = join(codexRoot, 'sessions', '2026', '10', '25')
    await mkdir(dir, { recursive: true })
    const records = codexRecords({ extra: [
      { type: 'event_msg', payload: { type: 'task_complete', completed_at: now - 3600, last_agent_message: '旧任务完成' } },
    ] })
    await writeFile(join(dir, 'rollout-old.jsonl'), records.map((r) => JSON.stringify(r)).join('\n'))
    const query = {
      listSessions: async () => [
        { header: { id: 'session-onsvc' } },
        { header: { id: 'session-fresh' } },
      ],
    }
    const tasks = await collectTasks({
      query, dshHome: dshRoot, codexHome: codexRoot, now, io: {},
    })
    const ids = tasks.map((t) => t.id)
    assert.ok(ids.includes('dsh:session-onsvc'), '包含文件侧 DSH 任务（有标题）')
    // 服务目录里尚无文件的新会话不生成占位（空会话不是任务）
    assert.ok(!ids.includes('dsh:session-fresh'), '无文件的新会话不占位')
    assert.ok(ids.includes('codex:cx1'), '包含文件侧 Codex 任务')
    // 落盘会话标题来自文件内容，不是 session id
    const onsvc = tasks.find((t) => t.id === 'dsh:session-onsvc')
    assert.equal(onsvc.title, '修 bug')
    // updated 降序
    for (let i = 1; i < tasks.length; i++) {
      assert.ok(tasks[i - 1].updated >= tasks[i].updated)
    }
  } finally {
    await rm(dshRoot, { recursive: true, force: true })
    await rm(codexRoot, { recursive: true, force: true })
  }
})

test('collectTasks：服务缺失回退 DSH 文件', async () => {
  const dshRoot = await mkdtempDir('pidesk-sync-')
  try {
    const sessionDir = join(dshRoot, 'sessions', 'ws', 'session-fallback')
    await mkdir(sessionDir, { recursive: true })
    const lines = dshEvents().map((e) => JSON.stringify(e)).join('\n')
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines, 'utf8')))
    const tasks = await collectTasks({
      query: null, dshHome: dshRoot, codexHome: '/nonexistent', now, io: {},
    })
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].id, 'dsh:session-fallback')
  } finally {
    await rm(dshRoot, { recursive: true, force: true })
  }
})

// --------- 插件入口生命周期与故障隔离 ---------

// --------- 手机推送（Bark / Webhook） ---------

const task = (id, status, over = {}) => ({
  id, source: 'DSH', title: '修 bug', detail: '修好了。', status, updated: 1, ...over,
})

test('barkUrl 拼接与编码', () => {
  assert.equal(barkUrl('https://api.day.app/', 'Abc-123_xy'), 'https://api.day.app/Abc-123_xy')
  // 末尾斜杠归一、key 编码
  assert.equal(barkUrl('https://bark.example.com/', 'a b'), 'https://bark.example.com/a%20b')
})

test('wants 事件订阅判定', () => {
  assert.equal(wants('needs_input,done', 'done'), true)
  assert.equal(wants('needs_input', 'done'), false)
  assert.equal(wants('', 'done'), false)
  assert.equal(wants(['done'], 'done'), true)
})

test('barkPayload 结构、截断与级别', () => {
  const payload = barkPayload(task('dsh:1', 'needs_input'), 'needs_input', { level: 'timeSensitive' })
  assert.equal(payload.title, 'DSH · 待回答')
  assert.equal(payload.level, 'timeSensitive')
  assert.equal(payload.group, 'pidesk')
  assert.equal(payload.isArchive, '1')
  assert.equal(payload.id, 'pidesk-dsh:1-needs_input')
  assert.match(payload.body, /^修 bug\n修好了。$/)
  // 超长内容截断
  const long = barkPayload(task('dsh:2', 'done', { detail: 'x'.repeat(5000) }), 'done')
  assert.ok(long.body.length < 400, `body 被截断：${long.body.length}`)
  assert.ok(long.body.endsWith('…'))
  // 非法级别回退 active
  assert.equal(barkPayload(task('dsh:3', 'done'), 'done', { level: 'boom' }).level, 'active')
  // 分组可配置、空值回退默认
  assert.equal(barkPayload(task('dsh:4', 'done'), 'done', { group: 'mine' }).group, 'mine')
  assert.equal(barkPayload(task('dsh:5', 'done'), 'done', { group: '' }).group, 'pidesk')
})

test('noticesFor：分组与铃声按配置传递', () => {
  const previous = new Map([['a', 'running']])
  const [notice] = noticesFor([task('a', 'needs_input')], previous, {
    events: 'done,needs_input',
    level: 'timeSensitive',
    group: 'mygroup',
  }).notices
  assert.equal(notice.payload.group, 'mygroup')
  assert.equal(notice.payload.level, 'timeSensitive')
  assert.equal(notice.payload.sound, 'bell', '待回答带铃声')
  const [done] = noticesFor([task('a', 'done')], previous, {
    events: 'done',
    group: 'g',
  }).notices
  assert.equal(done.payload.sound, undefined, '完成不指定铃声')
})

test('defaultLevel：待回答默认时效性，完成默认普通', () => {
  assert.equal(defaultLevel('needs_input'), 'timeSensitive')
  assert.equal(defaultLevel('done'), 'active')
  assert.equal(defaultLevel('done', 'critical'), 'critical')
  assert.equal(defaultLevel('done', 'nope'), 'active')
})

test('noticesFor：首轮只建基线，边沿才推', () => {
  const tasks = [task('a', 'running'), task('b', 'done')]
  const first = noticesFor(tasks, null, { events: 'done,needs_input' })
  assert.equal(first.notices.length, 0, '首轮不推送')
  assert.equal(first.next.get('b'), 'done')

  // 第二轮：a 由 running → done 应触发，b 保持 done 不重复
  const second = noticesFor(
    [task('a', 'done'), task('b', 'done')],
    first.next,
    { events: 'done,needs_input' },
  )
  assert.equal(second.notices.length, 1)
  assert.equal(second.notices[0].task.id, 'a')
  assert.equal(second.notices[0].payload.title, 'DSH · 已完成')

  // done ↔ needs_input 的抖动不再打扰（只有 running → 结束态算）
  const jitter = noticesFor(
    [task('a', 'needs_input')],
    second.next,
    { events: 'done,needs_input' },
  )
  assert.equal(jitter.notices.length, 0)
})

test('noticesFor：未订阅事件与单轮上限', () => {
  const previous = new Map([['a', 'running'], ['b', 'running'], ['c', 'running'], ['d', 'running']])
  const only = noticesFor([task('a', 'needs_input')], previous, { events: 'done' })
  assert.equal(only.notices.length, 0, '未订阅 needs_input 不推')
  const many = noticesFor(
    ['a', 'b', 'c', 'd'].map((id) => task(id, 'done')),
    previous,
    { events: 'done' },
  )
  assert.equal(many.notices.length, 3, '单轮最多 3 条')
})

test('sendNotice：成功、HTTP 失败与网络异常都不抛', async () => {
  let seen = null
  const ok = await sendNotice({
    url: 'https://api.day.app/k',
    payload: { body: 'hi' },
    fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 200 } },
  })
  assert.deepEqual(ok, { ok: true, status: 200 })
  assert.equal(seen.init.method, 'POST')
  assert.equal(JSON.parse(seen.init.body).body, 'hi')

  const failed = await sendNotice({
    url: 'https://api.day.app/k',
    payload: {},
    fetchImpl: async () => ({ ok: false, status: 400 }),
  })
  assert.deepEqual(failed, { ok: false, status: 400 })

  const boom = await sendNotice({
    url: 'https://api.day.app/k',
    payload: {},
    fetchImpl: async () => { throw new Error('network down') },
  })
  assert.equal(boom.ok, false)
  assert.match(boom.error, /network down/)

  // 未配置地址 → skipped
  const skipped = await sendNotice({ url: '', payload: {} })
  assert.equal(skipped.skipped, true)
})

test('webhookPayload 包住通知内容', () => {
  const payload = barkPayload(task('dsh:1', 'done'), 'done')
  const wrapped = webhookPayload(task('dsh:1', 'done'), 'done', payload)
  assert.equal(wrapped.source, 'pidesk-sync')
  assert.equal(wrapped.event, 'done')
  assert.equal(wrapped.task.id, 'dsh:1')
  assert.equal(wrapped.notification.title, payload.title)
})

test('notifyReady：通道可工作判定', () => {
  const base = readConfig({})
  assert.equal(notifyReady(base), false, '默认关闭')
  assert.equal(notifyReady({ ...base, notifyEnabled: true }), false, '缺 key')
  assert.equal(
    notifyReady({ ...base, notifyEnabled: true, notifyKey: 'Abcdefgh1234' }),
    true,
    '公共实例 + key 即可工作',
  )
  assert.equal(
    notifyReady({ ...base, notifyEnabled: true, notifyKey: 'Abcdefgh1234', notifyChannel: 'webhook' }),
    false,
    '切 webhook 后缺地址',
  )
  assert.equal(
    notifyReady({
      ...base, notifyEnabled: true, notifyChannel: 'webhook', notifyWebhook: 'https://hook.example.com/x',
    }),
    true,
  )
})

test('手机推送配置校验与脱敏', () => {
  const base = readConfig({})
  // 事件字段清洗成规范串
  assert.equal(readConfig({ notifyEvents: ' done , needs_input ' }).notifyEvents, 'done,needs_input')
  assert.equal(readConfig({ notifyEvents: '' }).notifyEvents, '')
  assert.throws(() => readConfig({ notifyEvents: 'done,running' }), /事件/)
  assert.throws(() => readConfig({ notifyLevel: 'loud' }), /级别/)
  assert.throws(() => readConfig({ notifyKey: '短' }), /key/)
  assert.throws(() => readConfig({ notifyWebhook: 'ftp://x' }), /Webhook/)
  // 服务地址末尾斜杠归一、分组名去空格
  assert.equal(readConfig({ notifyServer: 'https://bark.example.com/' }).notifyServer, 'https://bark.example.com')
  assert.equal(readConfig({ notifyGroup: '  my group  ' }).notifyGroup, 'my group')
  assert.equal(readConfig({ notifyGroup: '   ' }).notifyGroup, 'pidesk', '空分组回退默认')
  // 通道/事件类型非法值被拒
  assert.throws(() => readConfig({ notifyChannel: 'carrier-pigeon' }), /通道/)
  assert.throws(() => readConfig({ notifyEnabled: 'yes' }), /布尔/)
  const pub = publicConfig({ notifyKey: 'Abcdefgh1234' })
  assert.equal(pub.notifyKey, undefined)
  assert.equal(pub.notifyKeyConfigured, true)
})

test('clip 折叠空白并截断', () => {
  assert.equal(clip('  a   b  ', 10), 'a b')
  assert.equal(clip('abcdef', 3), 'ab…')
  assert.equal(clip(undefined, 5), '')
})

test('端到端：首轮建基线，running → done 才发 Bark', async () => {
  const root = await mkdtempDir('pidesk-sync-')
  const realFetch = globalThis.fetch
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  let onTick = null
  const calls = []
  try {
    const sessionDir = join(root, 'sessions', 'ws', 'session-e2e')
    await mkdir(sessionDir, { recursive: true })
    const archive = join(sessionDir, 'session.v4.jsonl.zstd')
    const write = async (lines) => {
      await writeFile(archive, zstdCompressSync(Buffer.from(lines.map((e) => JSON.stringify(e)).join('\n'), 'utf8')))
      await new Promise((r) => setTimeout(r, 20))
    }
    // 第一轮：任务在跑
    await write([
      { type: 'user/message', time: (now - 60) * 1000, data: { content: [{ type: 'text', text: '跑个任务' }] } },
      { type: 'turn/start', time: (now - 60) * 1000 },
      { type: 'assistant/message', time: (now - 30) * 1000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '正在跑' }] } } },
    ])
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      return { ok: true, status: 200 }
    }
    globalThis.setInterval = (fn) => { onTick = fn; return { unref: () => {} } }
    globalThis.clearInterval = () => {}

    const { apply } = await import('../host/index.js')
    let disposer = null
    const ctx = {
      effect: (fn) => { disposer = fn(); return () => disposer?.() },
      logger: { info: () => {}, warn: () => {} },
      get: () => null,
    }
    apply(ctx, {
      enabled: true,
      url: 'http://pi:8765/api/agents-push',
      token: 'test-token-123',
      intervalSeconds: 5,
      dshHome: root,
      codexHome: '/nonexistent',
      notifyEnabled: true,
      notifyKey: 'Abcdefgh1234',
      notifyEvents: 'done,needs_input',
      notifyLevel: 'timeSensitive',
    })
    // 首轮由 apply 内部触发；等它落地
    await new Promise((r) => setTimeout(r, 300))
    const barkCalls = () => calls.filter((u) => u.includes('api.day.app'))
    assert.equal(barkCalls().length, 0, '首轮只建基线，不推送')
    assert.ok(calls.some((u) => u.includes('agents-push')), '屏幕推送照常')

    // 第二轮：任务结束（turn 闭合 + 陈述句）
    await write([
      { type: 'user/message', time: (now - 60) * 1000, data: { content: [{ type: 'text', text: '跑个任务' }] } },
      { type: 'turn/start', time: (now - 60) * 1000 },
      { type: 'assistant/message', time: (now - 5) * 1000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '跑完了。' }] } } },
      { type: 'turn/end', time: (now - 5) * 1000 },
    ])
    await onTick()
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(barkCalls().length, 1, 'running → done 触发一条手机通知')
    assert.match(barkCalls()[0], /^https:\/\/api\.day\.app\/Abcdefgh1234$/)

    // 第三轮：状态不变，不重复打扰
    await onTick()
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(barkCalls().length, 1, '状态不变不重发')

    await disposer?.()
  } finally {
    globalThis.fetch = realFetch
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
    await rm(root, { recursive: true, force: true })
  }
})

test('端到端：pidesk 不可达时手机推送照发', async () => {
  const root = await mkdtempDir('pidesk-sync-')
  const realFetch = globalThis.fetch
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  let onTick = null
  const calls = []
  try {
    const sessionDir = join(root, 'sessions', 'ws', 'session-offline')
    await mkdir(sessionDir, { recursive: true })
    const archive = join(sessionDir, 'session.v4.jsonl.zstd')
    const write = async (lines) => {
      await writeFile(archive, zstdCompressSync(Buffer.from(lines.map((e) => JSON.stringify(e)).join('\n'), 'utf8')))
      await new Promise((r) => setTimeout(r, 20))
    }
    const base = [
      { type: 'user/message', time: (now - 60) * 1000, data: { content: [{ type: 'text', text: '写文档' }] } },
      { type: 'turn/start', time: (now - 60) * 1000 },
    ]
    // 首轮：任务在跑
    await write([
      ...base,
      { type: 'assistant/message', time: (now - 30) * 1000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '正在写' }] } } },
    ])
    // 屏幕地址一律失败，Bark 一律成功
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      if (String(url).includes('agents-push')) throw new Error('connect ECONNREFUSED')
      return { ok: true, status: 200 }
    }
    globalThis.setInterval = (fn) => { onTick = fn; return { unref: () => {} } }
    globalThis.clearInterval = () => {}

    const { apply } = await import('../host/index.js')
    let disposer = null
    apply(
      {
        effect: (fn) => { disposer = fn(); return () => disposer?.() },
        logger: { info: () => {}, warn: () => {} },
        get: () => null,
      },
      {
        enabled: true,
        url: 'http://pi-offline:8765/api/agents-push',
        token: 'test-token-123',
        intervalSeconds: 5,
        dshHome: root,
        codexHome: '/nonexistent',
        notifyEnabled: true,
        notifyKey: 'Abcdefgh1234',
        notifyEvents: 'done',
      },
    )
    await new Promise((r) => setTimeout(r, 300))
    const barkCalls = () => calls.filter((u) => u.includes('api.day.app'))
    assert.equal(barkCalls().length, 0, '首轮建基线')
    // 第二轮：任务闭合 → running → done 边沿
    await write([
      ...base,
      { type: 'assistant/message', time: (now - 5) * 1000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '写完了。' }] } } },
      { type: 'turn/end', time: (now - 5) * 1000 },
    ])
    await onTick()
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(barkCalls().length, 1, '屏幕连不上不影响手机推送')
    await disposer?.()
  } finally {
    globalThis.fetch = realFetch
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
    await rm(root, { recursive: true, force: true })
  }
})

test('插件入口 apply 生命周期：注册定时器并清理', async () => {
  const { apply } = await import('../host/index.js')
  const intervals = []
  let timerCleared = 0
  const handles = new Map()
  const ctx = {
    effect: (fn) => { const disposer = fn(); return () => disposer?.() },
    logger: { info: () => {}, warn: () => {} },
    get: () => null,
  }
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = (fn, ms) => { intervals.push(ms); const h = { unref: () => {} }; handles.set(fn, h); return h }
  globalThis.clearInterval = () => { timerCleared += 1 }
  let disposer = null
  try {
    const ctxWithCapture = { ...ctx, effect: (fn) => { disposer = fn(); return () => disposer?.() } }
    apply(ctxWithCapture, {
      url: 'http://127.0.0.1:9/api/agents-push',
      token: 'test-token-123',
      intervalSeconds: 15,
      dshHome: '/nonexistent',
      codexHome: '/nonexistent',
    })
    assert.equal(intervals.length, 1)
    assert.equal(intervals[0], 15000)
    await disposer?.()
    assert.equal(timerCleared, 1)
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
})

test('apply 单轮失败不外抛（隔离）', async () => {
  const { apply } = await import('../host/index.js')
  const warnings = []
  const ctx = {
    effect: (fn) => { const d = fn(); return () => d?.() },
    logger: { info: () => {}, warn: (m) => warnings.push(m) },
    get: () => { throw new Error('service boom') },
  }
  let disposer = null
  const ctxWithCapture = { ...ctx, effect: (fn) => { disposer = fn(); return () => disposer?.() } }
  apply(ctxWithCapture, {
    url: 'http://127.0.0.1:9/api/agents-push',
    token: 'test-token-123',
    intervalSeconds: 15,
    dshHome: '/nonexistent',
    codexHome: '/nonexistent',
  })
  // 等待首轮 tick 完成（连不上的地址应只产生 warn，不抛错）
  await new Promise((r) => setTimeout(r, 200))
  await disposer?.()
  assert.ok(Array.isArray(warnings))
})

test('apply 配置无效时暂停推送但不崩溃', async () => {
  const { apply } = await import('../host/index.js')
  const warnings = []
  const ctx = {
    effect: (fn) => { const d = fn(); return () => d?.() },
    logger: { info: () => {}, warn: (m) => warnings.push(m) },
    get: () => null,
  }
  let disposer = null
  const ctxWithCapture = { ...ctx, effect: (fn) => { disposer = fn(); return () => disposer?.() } }
  apply(ctxWithCapture, { url: 'not-a-url', token: 'test-token-123', intervalSeconds: 15 })
  await new Promise((r) => setTimeout(r, 150))
  await disposer?.()
  assert.ok(warnings.some((w) => w.includes('配置无效')))
})

test('空会话（无用户输入无输出）不产出任务', async () => {
  const root = await mkdtempDir('pidesk-sync-')
  try {
    const sessionDir = join(root, 'sessions', 'ws', 'session-empty')
    await mkdir(sessionDir, { recursive: true })
    // 只有 session 元数据和权限事件 —— 点了新建但没说话就关闭
    const lines = [
      { type: 'session', time: 1, data: { id: 'session-empty' } },
      { type: 'permission/preset', time: 1, data: { preset: 'workspace-write' } },
      { type: 'sandbox/mode', time: 1, data: { mode: 'workspace-write' } },
    ].map((e) => JSON.stringify(e)).join('\n')
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines, 'utf8')))
    const { dshTasksFromFilesystem } = await import('../host/agents.js')
    const tasks = await dshTasksFromFilesystem(root, now, {})
    assert.equal(tasks.length, 0)
    // summarize 层面直接验证
    const { summarizeDshEvents } = await import('../host/agents.js')
    assert.equal(summarizeDshEvents('session-empty', JSON.parse('[]')), null)
    assert.equal(summarizeDshEvents('session-empty', [
      { type: 'session', time: 1e12 },
      { type: 'turn/start', time: 1e12 },
    ]), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('teammate/subagent 会话不产出任务（只关心主任务）', async () => {
  const root = await mkdtempDir('pidesk-sync-')
  try {
    // teammate 会话目录：裸 uuid 命名（无 session- 前缀），session 头带 origin=subagent + parentSession
    const teammateDir = join(root, 'sessions', 'ws', 'a323a142-17a9-4bd3')
    await mkdir(teammateDir, { recursive: true })
    const teammateLines = [
      { type: 'session', time: 1, data: { id: 'a323a142', parentSession: 'session-main', origin: 'subagent', delegationDepth: 1 } },
      { type: 'user/message', time: (now - 10) * 1000, data: { content: [{ type: 'text', text: 'teammate 任务提示' }] } },
      { type: 'assistant/message', time: (now - 5) * 1000, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'teammate 输出' }] } } },
    ].map((e) => JSON.stringify(e)).join('\n')
    await writeFile(join(teammateDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(teammateLines, 'utf8')))
    const { dshTasksFromFilesystem } = await import('../host/agents.js')
    // 目录扫描（session- 前缀过滤）不收 teammate 目录
    let tasks = await dshTasksFromFilesystem(root, now, {})
    assert.equal(tasks.length, 0)
    // 即便服务 id 匹配（wanted 含 uuid），session 头过滤也拦截
    tasks = await dshTasksFromFilesystem(root, now, { sessionIds: ['a323a142-17a9-4bd3'] })
    assert.equal(tasks.length, 0)
    // 直接验证 summarizeDshEvents 拦截 subagent
    const { summarizeDshEvents } = await import('../host/agents.js')
    assert.equal(summarizeDshEvents('a323a142', JSON.parse(JSON.stringify([
      { type: 'session', data: { origin: 'subagent' } },
      { type: 'user/message', time: 1e12, data: { content: [{ type: 'text', text: 'x' }] } },
    ]))), null)
    // 主会话（无 origin/parentSession）不受影响
    assert.notEqual(summarizeDshEvents('session-main', [
      { type: 'session', time: 1e12, data: { id: 'session-main' } },
      { type: 'user/message', time: 1e12, data: { content: [{ type: 'text', text: '主任务' }] } },
    ]), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('系统事件不推进 updated：末尾 session/end-seed 等带更晚 time 也取最后对话事件时间', () => {
  const visibleTime = (now - 5) * 1000
  const summary = summarizeDshEvents('session-sys', [
    { type: 'session', time: 1, data: { id: 'session-sys' } },
    { type: 'user/message', time: 1e12, data: { content: [{ type: 'text', text: '生成图片+ 视频+音频' }] } },
    { type: 'turn/start', time: 1e12 },
    { type: 'assistant/message', time: visibleTime, data: { message: { role: 'assistant', content: [{ type: 'text', text: '都生成了。' }] } } },
    { type: 'turn/end', time: visibleTime },
    // 会话已结束，随后落盘的系统事件 time 更晚——不应让任务显得「新鲜」
    { type: 'permission/preset', time: (now - 1) * 1000, data: { preset: 'workspace-write' } },
    { type: 'approval/policy', time: (now - 1) * 1000, data: { mode: 'danger-full-access' } },
    { type: 'session/end-seed', time: (now - 1) * 1000, data: {} },
  ])
  assert.ok(summary, '有对话内容的会话应产出摘要')
  assert.ok(Math.abs(summary.updated - visibleTime / 1000) < 0.001, `updated=${summary.updated} 应等于最后对话事件时间`)
  // 会话早已结束：即便系统事件发生在 1 秒前，也不算 running
  const task = dshTaskFromEvents('session-sys', [
    { type: 'user/message', time: 1e12, data: { content: [{ type: 'text', text: 'x' }] } },
    { type: 'turn/start', time: 1e12 },
    { type: 'turn/end', time: visibleTime },
    { type: 'session/end-seed', time: (now - 1) * 1000 },
  ], now)
  assert.equal(task.status, 'done')
  assert.equal(task.updated, Math.round(visibleTime / 1000))
})

test('Codex 同线程多个 rollout 归并为一条任务', async () => {
  const root = await mkdtempDir('pidesk-sync-')
  try {
    const dir = join(root, 'sessions', '2026', '10', '25')
    await mkdir(dir, { recursive: true })
    // 线程 01a161f2 下的三个分片：一个 running、两个 done（不同更新时间）
    const shard = (id, extra, thread = '01a161f2') => ([
      { type: 'session_meta', payload: { id, parent_thread_id: thread, cwd: '/work/project' } },
      { type: 'event_msg', payload: { type: 'task_started', started_at: now - 3600 } },
      ...extra,
    ])
    const runningShard = shard('s1', [])
    const doneShardOld = shard('s2', [{ type: 'event_msg', payload: { type: 'task_complete', completed_at: now - 3000, last_agent_message: '旧完成' } }])
    const doneShardNew = shard('s3', [{ type: 'event_msg', payload: { type: 'task_complete', completed_at: now - 100, last_agent_message: '新完成' } }])
    await writeFile(join(dir, 'rollout-a.jsonl'), runningShard.map((r) => JSON.stringify(r)).join('\n'))
    await writeFile(join(dir, 'rollout-b.jsonl'), doneShardOld.map((r) => JSON.stringify(r)).join('\n'))
    await new Promise((r) => setTimeout(r, 20))
    await writeFile(join(dir, 'rollout-c.jsonl'), doneShardNew.map((r) => JSON.stringify(r)).join('\n'))
    // 另一个独立线程的任务
    const otherThread = shard('t1', [{ type: 'event_msg', payload: { type: 'task_complete', completed_at: now - 50, last_agent_message: '其他线程' } }], 'thread-xyz')
    await new Promise((r) => setTimeout(r, 20))
    await writeFile(join(dir, 'rollout-d.jsonl'), otherThread.map((r) => JSON.stringify(r)).join('\n'))
    const { codexTasksFromFilesystem } = await import('../host/agents.js')
    const tasks = await codexTasksFromFilesystem(root, now, {})
    // 两个线程 → 两条任务
    assert.equal(tasks.length, 2)
    const byThread = Object.fromEntries(tasks.map((t) => [t.id, t]))
    const main = byThread['codex:01a161f2']
    assert.ok(main, '主线程归并任务存在')
    // 取最新分片内容
    assert.equal(main.detail, '新完成')
    assert.equal(main.status, 'done')
    assert.ok(byThread['codex:thread-xyz'], '独立线程任务存在')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
