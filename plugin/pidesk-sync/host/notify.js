/**
 * pidesk-sync — 手机推送通道（Bark）。
 *
 * 为什么需要它：Apple Watch 自己没有独立推送通道，第三方 App 的通知只能经
 * APNs 到 iPhone，再由系统在 iPhone 锁屏/息屏时镜像到配对的 Watch。APNs 的
 * 推送凭据（p8/p12）是绕不开的卡点——Bark 把这件事做掉了：
 *   - 公共实例 https://api.day.app：装 App 拿 key 直接用，零部署零 Apple 账号；
 *   - 自托管 bark-server：仓库公开了 topic/keyID/teamID 与配套 .p8，同样不需要
 *     自己的开发者账号（换掉 server 地址即可）。
 * 因此本模块统一用 Bark 协议，server 可配置，另留 generic Webhook 通道做兜底。
 *
 * 触发时机由 index.js 决定（任务状态 running → done/needs_input 的边沿），
 * 这里只负责：是否该推、推什么、怎么发。全部纯函数 + 可注入 fetch，便于测试。
 */

/** 通知级别：active 亮屏、timeSensitive 穿透专注模式、critical 穿透静音（需 App 授权）。 */
export const LEVELS = ['active', 'timeSensitive', 'passive', 'critical']
/** 可订阅的事件类型。 */
export const EVENTS = ['done', 'needs_input']
/** body 最大字符数（Bark payload 上限 4096 字节，中文按 3 字节估）。 */
export const BODY_LIMIT = 300
/** title 最大字符数。 */
export const TITLE_LIMIT = 60
/** 单轮最多发几条通知，避免会话多时刷屏。 */
export const MAX_NOTICES_PER_ROUND = 3
/** 连续失败多少次后暂停该通道（下一轮重新计数成功后清零）。 */
export const FAILURE_LIMIT = 3

const STATUS_LABEL = {
  done: '已完成',
  needs_input: '待回答',
}

export function normalizeServer(server) {
  return String(server ?? '').trim().replace(/\/+$/, '')
}

/** Bark URL：POST <server>/<key>，key 需 URL 编码（路径段）。 */
export function barkUrl(server, key) {
  return `${normalizeServer(server)}/${encodeURIComponent(String(key ?? '').trim())}`
}

/**
 * 该事件是否订阅。events 为逗号分隔字符串或数组，'none' 或空表示不推。
 */
export function wants(events, status) {
  if (!events) return false
  const list = Array.isArray(events) ? events : String(events).split(',')
  return list.map((item) => String(item).trim()).filter(Boolean).includes(status)
}

/** 截断到 limit 个字符，超出加省略号。 */
export function clip(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > limit ? value.slice(0, limit - 1) + '…' : value
}

/**
 * 任务 + 状态 → Bark 请求体。
 *
 * title 放「来源 · 状态」，body 放标题与最后一条输出；group 固定 pidesk，
 * 便于在手机/Watch 上折叠；needs_input 用 timeSensitive 级别，专注模式也能到。
 */
export function barkPayload(task, status, { level, group, sound } = {}) {
  const source = task?.source || 'Agent'
  const label = STATUS_LABEL[status] || status
  const title = clip(`${source} · ${label}`, TITLE_LIMIT)
  const head = clip(task?.title, TITLE_LIMIT)
  const detail = clip(task?.detail, BODY_LIMIT)
  const body = detail ? `${head}\n${detail}` : head || label
  const payload = {
    title,
    body,
    group: String(group || '').trim() || 'pidesk',
    level: LEVELS.includes(level) ? level : 'active',
    isArchive: '1',
  }
  if (sound) payload.sound = sound
  if (task?.id) payload.id = `pidesk-${task.id}-${status}`
  return payload
}

/** 默认级别：待回答用时效性通知，完成用普通通知。 */
export function defaultLevel(status, configured) {
  if (configured && LEVELS.includes(configured)) return configured
  return status === 'needs_input' ? 'timeSensitive' : 'active'
}

/**
 * 对比两轮快照，产出本轮要推送的通知（只在 running → 结束态的边沿触发）。
 *
 * previous 为 null 表示首轮：只建基线不推送，否则插件一启动就会把历史上
 * 所有已完成任务全推一遍。
 */
export function noticesFor(tasks, previous, { events, level, group } = {}) {
  const current = new Map()
  for (const task of tasks || []) {
    if (task?.id) current.set(task.id, task)
  }
  const notices = []
  if (previous) {
    for (const [id, task] of current) {
      const status = task.status
      if (status === 'running') continue
      if (!wants(events, status)) continue
      const before = previous.get(id)
      // 只认 running → 结束态；done ↔ needs_input 的抖动不再重复打扰
      if (before !== 'running') continue
      notices.push({
        task,
        status,
        payload: barkPayload(task, status, {
          level: defaultLevel(status, level),
          group,
          sound: status === 'needs_input' ? 'bell' : undefined,
        }),
      })
      if (notices.length >= MAX_NOTICES_PER_ROUND) break
    }
  }
  const next = new Map()
  for (const [id, task] of current) next.set(id, task.status)
  return { notices, next }
}

/** 兜底通道：把 Bark 载荷原样 POST 到自定义 Webhook（兼容自建转发/ntfy 等）。 */
export function webhookPayload(task, status, payload) {
  return {
    source: 'pidesk-sync',
    event: status,
    task: { id: task?.id, title: task?.title, detail: task?.detail, source: task?.source },
    notification: payload,
  }
}

/**
 * 发送一条通知。返回 {ok, status?}；网络错误也返回对象，不抛异常。
 * url 为空视为通道未配置，返回 skipped，让调用方不必区分。
 */
export async function sendNotice({ url, payload, fetchImpl, timeoutMs = 8000 }) {
  if (!url) return { ok: false, skipped: true }
  const doFetch = fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    return { ok: response.ok, status: response.status }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}
