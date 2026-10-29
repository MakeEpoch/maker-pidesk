/**
 * pidesk-sync — host half.
 *
 * 聚合本机 DSH（优先宿主 sessionQuery 服务，回退直读 ~/.dsh/sessions 的
 * session.v4.jsonl.zstd）与 Codex（~/.codex/sessions 的 rollout-*.jsonl）
 * 的任务进度，定时推送到 pidesk 信息屏的 /api/agents-push。
 *
 * 任务状态：
 *  - running      turn 开始未结束（DSH）或 task_started 多于 task_complete（Codex）
 *  - done         任务结束，最后回复不是问句
 *  - needs_input  任务结束，最后回复以问句结尾（等待用户回答）
 *
 * 解析按文件 mtime+size 缓存中间摘要：没变动的会话不会重新解压/重读，
 * 每轮只做 stat 与状态重新分类。
 */

import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { zstdDecompressSync } from 'node:zlib'
import { readdir, readFile, stat } from 'node:fs/promises'

/** 与 pidesk 侧 ACTIVE_SECONDS 一致：最近有输出视为进行中。 */
export const ACTIVE_SECONDS = 5 * 60
/** 超过该秒数的任务不再推送。 */
export const MAX_AGE_SECONDS = 24 * 60 * 60
/** 单次推送任务上限（与 pidesk PUSH_MAX_TASKS 一致）。 */
export const MAX_TASKS = 50
/** 跳过超长 JSONL 行（按字符数×2 近似字节）。 */
const MAX_LINE_CHARS = 1_000_000
const QUESTION_END = /[？?][」』"')）\s]*$/

export function summarize(text, limit = 120) {
  text = String(text ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text
}

function firstText(content) {
  for (const part of content || []) {
    if (part && typeof part === 'object' && typeof part.text === 'string' && part.text) return part.text
  }
  return ''
}

export function needsInput(text) {
  return QUESTION_END.test(String(text ?? '').trim().slice(-40))
}

/** 逐行解析 jsonl 文本；坏行与超长行跳过。 */
export function parseLines(text) {
  const out = []
  let start = 0
  while (start < text.length) {
    const end = text.indexOf('\n', start)
    const line = text.slice(start, end === -1 ? text.length : end)
    start = end === -1 ? text.length : end + 1
    if (!line || line.length > MAX_LINE_CHARS) continue
    try { out.push(JSON.parse(line)) } catch { /* 损坏行 */ }
  }
  return out
}

function classify({ hasOpenTurn, lastOutput, updated, now }) {
  const running = hasOpenTurn && now - updated < ACTIVE_SECONDS
  if (running) return 'running'
  return needsInput(lastOutput) ? 'needs_input' : 'done'
}

// ---------------------------------------------------------------- DSH 侧

/**
 * DSH 会话事件（sessionQuery 的 listEvents 形状，或直读 jsonl 的记录）
 * → 中间摘要。事件形如 session/title / user/message / turn/start /
 * assistant/message / step/* / turn/end。
 */
export function summarizeDshEvents(sessionId, events) {
  if (!Array.isArray(events) || !events.length) return null
  let title = ''
  let lastAssistant = ''
  let firstUser = ''
  let lastTime = 0
  let turnStarts = 0
  let turnEnds = 0
  // updated 只取「可见对话事件」的时间：user/message、assistant/message、
  // turn/start、turn/end、session/title。系统事件（permission/sandbox/
  // approval/job/step/command/session/end-seed 等）不推进 updated——否则一个
  // 早已结束的会话会因为落盘期的系统事件被误判为「刚更新」。
  // session 头事件（type='session'）通常无 time 或为创建时间，同样不推进。
  const touch = (event) => {
    if (typeof event.time === 'number') lastTime = Math.max(lastTime, event.time)
  }
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const data = event.data ?? event
    switch (event.type) {
      case 'session': {
        // 只关心主任务：teammate/subagent 会话（origin=subagent 或带 parentSession）跳过
        if (data.origin === 'subagent' || data.parentSession) return null
        break
      }
      case 'session/title': touch(event); title = data.title || title; break
      case 'assistant/message': {
        touch(event)
        const text = firstText(data.message?.content)
        if (text) lastAssistant = text
        break
      }
      case 'user/message': touch(event); if (!firstUser) firstUser = firstText(data.content); break
      case 'turn/start': touch(event); turnStarts += 1; break
      case 'turn/end': touch(event); turnEnds += 1; break
      default: break
    }
  }
  const updated = lastTime > 0 ? lastTime / 1000 : 0
  if (!updated) return null
  // 空会话（无用户输入也无助手输出，比如点新建后直接关闭）不是任务
  if (!firstUser && !lastAssistant && !title) return null
  return {
    sessionId,
    title: summarize(title || firstUser, 60) || sessionId,
    lastAssistant,
    hasOpenTurn: turnStarts > turnEnds,
    updated,
  }
}

/** 摘要 → 推送任务行。 */
export function dshTaskFromSummary(summary, now) {
  if (!summary) return null
  if (now - summary.updated > MAX_AGE_SECONDS) return null
  return {
    id: `dsh:${summary.sessionId}`,
    source: 'DSH',
    title: summary.title,
    detail: summarize(summary.lastAssistant),
    status: classify({
      hasOpenTurn: summary.hasOpenTurn,
      lastOutput: summary.lastAssistant,
      updated: summary.updated,
      now,
    }),
    updated: Math.round(summary.updated),
  }
}

export function dshTaskFromEvents(sessionId, events, now) {
  return dshTaskFromSummary(summarizeDshEvents(sessionId, events), now)
}

/**
 * 直读 <dshHome>/sessions/<workspace>/session-<id>/session.v4.jsonl.zstd。
 * cache: Map<path, {mtimeMs, size, summary}>；未变化的文件复用摘要。
 */
export async function dshTasksFromFilesystem(dshHome, now, { cache, io, sessionIds } = {}) {
  const tasks = []
  const root = join(dshHome, 'sessions')
  const wanted = sessionIds?.length ? new Set(sessionIds) : null
  let workspaces
  try { workspaces = await readdir(root, { withFileTypes: true }) } catch { return tasks }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = join(root, workspace.name)
    let sessions
    try { sessions = await readdir(workspaceDir, { withFileTypes: true }) } catch { continue }
    for (const session of sessions) {
      if (!session.isDirectory() || !session.name.startsWith('session-')) continue
      if (wanted && !wanted.has(session.name)) continue
      const archive = join(workspaceDir, session.name, 'session.v4.jsonl.zstd')
      const task = await taskFromArchive(archive, session.name, now, cache, io)
      if (task) tasks.push(task)
    }
  }
  return tasks
}

async function taskFromArchive(archive, sessionId, now, cache, io) {
  let info
  try { info = await stat(archive) } catch { cache?.delete(archive); return null }
  // 早退：文件本身超过展示窗口就没必要解压
  if (now - info.mtimeMs / 1000 > MAX_AGE_SECONDS) return null
  const cached = cache?.get(archive)
  let summary
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    summary = cached.summary
  } else {
    try {
      const text = await readZstdStream(archive)
      summary = summarizeDshEvents(sessionId, parseLines(text))
    } catch (error) {
      io?.warn?.(`DSH 会话读取失败 ${sessionId}：${safe(error)}`)
      cache?.delete(archive)
      return null
    }
    if (summary) cache?.set(archive, { mtimeMs: info.mtimeMs, size: info.size, summary })
    else cache?.delete(archive)
  }
  return dshTaskFromSummary(summary, now)
}

/**
 * 解压 DSH 的多帧 zstd 会话文件。DSH 增量 append，一个文件上千个 frame；
 * Node zlib 的 zstd 实现只解首帧，必须用 zstdcat（Pi/工作站都有），
 * 失败时回退单帧解压（老文件单帧时可工作）。
 */
function readZstdStream(archive) {
  return new Promise((resolve, reject) => {
    const child = spawn('zstdcat', [archive], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let stderr = ''
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8').slice(0, 200) })
    child.on('error', () => {
      // 无 zstdcat（或 spawn 失败）：单帧回退
      readFile(archive)
        .then((buffer) => resolve(zstdDecompressSync(buffer).toString('utf8')))
        .catch(reject)
    })
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'))
      else if (chunks.length) resolve(Buffer.concat(chunks).toString('utf8'))
      else reject(new Error(`zstdcat exit ${code}: ${stderr || 'no output'}`))
    })
  })
}

/**
 * 走宿主 sessionQuery 服务获取活跃会话目录。
 * 注意：listEvents 返回的轻量记录只含 {sessionId, seq, type, time, surface}，
 * 没有 data 载荷——标题/内容必须回到文件解析。服务在这里只用于
 * 发现会话 id 列表（跨工作区、含尚未落盘的实时信息）。
 */
export async function dshSessionIdsFromService(query, signal) {
  const ids = []
  if (!query?.listSessions) return ids
  const sessions = await query.listSessions(signal)
  for (const row of sessions) {
    const id = row?.header?.id
    if (id) ids.push(id)
  }
  return ids
}

// ---------------------------------------------------------------- Codex 侧

/** Codex rollout jsonl 记录 → 中间摘要（task 事件在 event_msg.payload）。 */
export function summarizeCodexRecords(file, records) {
  let meta = null
  let started = 0
  let completed = 0
  let detail = ''
  let lastStamp = 0
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    if (typeof record.timestamp === 'string') {
      const stamp = Date.parse(record.timestamp)
      if (Number.isFinite(stamp)) lastStamp = Math.max(lastStamp, stamp)
    }
    if (record.type === 'session_meta') {
      meta = record.payload ?? {}
    } else if (record.type === 'event_msg') {
      const payload = record.payload ?? {}
      if (payload.type === 'task_started') {
        started += 1
        if (typeof payload.started_at === 'number') lastStamp = Math.max(lastStamp, payload.started_at * 1000)
      } else if (payload.type === 'task_complete') {
        completed += 1
        if (typeof payload.completed_at === 'number') lastStamp = Math.max(lastStamp, payload.completed_at * 1000)
        if (payload.last_agent_message) detail = payload.last_agent_message
      }
    }
  }
  if (!meta) return null
  const updated = lastStamp > 0 ? lastStamp / 1000 : 0
  if (!updated) return null
  const id = meta.id ?? meta.session_id ?? file
  // 线程身份：同一 parent_thread_id 下的 rollout（turn/review 分片）属于一个任务
  const threadId = meta.parent_thread_id || id
  return {
    id,
    threadId,
    title: summarize(meta.cwd ?? id ?? String(file), 60),
    lastOutput: detail,
    hasOpenTurn: started > completed,
    updated,
  }
}

export function codexTaskFromSummary(summary, now) {
  if (!summary) return null
  if (now - summary.updated > MAX_AGE_SECONDS) return null
  return {
    // 线程身份做任务 id：同线程的分片归并成一条稳定任务
    id: `codex:${summary.threadId ?? summary.id}`,
    source: 'Codex',
    title: summary.title,
    detail: summarize(summary.lastOutput),
    status: classify({
      hasOpenTurn: summary.hasOpenTurn,
      lastOutput: summary.lastOutput,
      updated: summary.updated,
      now,
    }),
    updated: Math.round(summary.updated),
  }
}

export function codexTaskFromRecords(file, records, now) {
  return codexTaskFromSummary(summarizeCodexRecords(file, records), now)
}

/**
 * 直读 <codexHome>/sessions/**&#47;rollout-*.jsonl，取最近修改的 limit 个。
 * 同样按 mtime+size 缓存摘要。
 */
export async function codexTasksFromFilesystem(codexHome, now, { cache, io } = {}, limit = 20) {
  const root = join(codexHome, 'sessions')
  const files = []
  async function walk(dir) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) files.push(path)
    }
  }
  await walk(root)
  const stamped = []
  for (const file of files) {
    try {
      const info = await stat(file)
      if (now - info.mtimeMs / 1000 <= MAX_AGE_SECONDS) stamped.push([file, info])
    } catch { /* 忽略 */ }
  }
  stamped.sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)
  // 按 threadId 归并：同一 Codex 线程的多个 rollout 分片只产出一条任务
  const threads = new Map()
  for (const [file, info] of stamped.slice(0, limit)) {
    const cached = cache?.get(file)
    let summary
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      summary = cached.summary
    } else {
      try {
        const text = await readFile(file, 'utf8')
        summary = summarizeCodexRecords(file, parseLines(text))
      } catch (error) {
        io?.warn?.(`Codex 会话读取失败 ${file}：${safe(error)}`)
        cache?.delete(file)
        continue
      }
      if (summary) cache?.set(file, { mtimeMs: info.mtimeMs, size: info.size, summary })
      else cache?.delete(file)
    }
    if (!summary) continue
    const previous = threads.get(summary.threadId)
    // 归并规则：取更新时间最新的分片为代表（状态/内容随最新分片）；
    // 旧分片仍在跑而新分片已结束 → 以最新为准（新分片完成即线程完成）
    if (!previous || summary.updated > previous.updated) {
      threads.set(summary.threadId, summary)
    }
  }
  const tasks = []
  for (const summary of threads.values()) {
    const task = codexTaskFromSummary(summary, now)
    if (task) tasks.push(task)
  }
  return tasks
}

// ---------------------------------------------------------------- 聚合与推送

/**
 * 汇总任务列表：DSH 一律走文件解析（标题/内容只在文件里有），
 * sessionQuery 服务仅用于发现活跃会话 id（补充尚未落盘的新会话）。
 * 与 pidesk 侧一致按 updated 降序、截断到 MAX_TASKS。
 */
export async function collectTasks({ query, dshHome, codexHome, now, signal, io }) {
  const dshCache = io?.dshCache
  const codexCache = io?.codexCache
  let sessionIds = null
  try {
    sessionIds = query ? await dshSessionIdsFromService(query, signal) : null
  } catch (error) {
    io?.warn?.(`DSH sessionQuery 读取失败：${safe(error)}`)
    sessionIds = null
  }
  let dsh = []
  try {
    dsh = await dshTasksFromFilesystem(dshHome, now, {
      cache: dshCache,
      io,
      sessionIds,
    })
  } catch (error) {
    io?.warn?.(`DSH 会话文件读取失败：${safe(error)}`)
  }
  let codex = []
  try {
    codex = await codexTasksFromFilesystem(codexHome, now, { cache: codexCache, io })
  } catch (error) {
    io?.warn?.(`Codex 会话读取失败：${safe(error)}`)
  }
  return [...dsh, ...codex].sort((a, b) => b.updated - a.updated).slice(0, MAX_TASKS)
}

function safe(error) {
  return String(error?.message ?? error).slice(0, 200)
}

/** 组装推送体。pushedAt 接受秒或毫秒时间戳，统一输出秒。 */
export function pushPayload(tasks, pushedAt) {
  const seconds = pushedAt > 1e12 ? Math.round(pushedAt / 1000) : Math.round(pushedAt)
  return { agents: tasks, pushed_at: seconds }
}

/** POST 到 pidesk；返回 {ok, status, count}。 */
export async function pushToPidesk({ url, token, payload, fetchImpl, timeoutMs = 5000 }) {
  const doFetch = fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const count = Array.isArray(payload.agents) ? payload.agents.length : 0
    return { ok: response.ok, status: response.status, count }
  } finally {
    clearTimeout(timer)
  }
}
