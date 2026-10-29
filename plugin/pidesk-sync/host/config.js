import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { EVENTS, LEVELS, normalizeServer } from './notify.js'

export const defaults = Object.freeze({
  enabled: false,
  url: '',
  token: '',
  intervalSeconds: 15,
  dshHome: '~/.dsh',
  codexHome: '~/.codex',
  // 手机推送：Bark 公共实例开箱即用，换成自托管 bark-server 地址即可
  notifyEnabled: false,
  notifyChannel: 'bark',
  notifyServer: 'https://api.day.app',
  notifyKey: '',
  notifyWebhook: '',
  notifyEvents: 'needs_input,done',
  notifyLevel: 'timeSensitive',
  notifyGroup: 'pidesk',
})

const field = (schema, description) => schema.description(description).role('volatile').extra('volatile', true)

export const Config = z.object({
  enabled: field(z.boolean().default(false), '启用 pidesk 推送'),
  url: field(z.string().default(defaults.url), 'pidesk 推送地址（/api/agents-push）'),
  token: z.string().default('').description('推送令牌；只写不回显，留空保留原值').role('secret').extra('volatile', true),
  intervalSeconds: field(z.number().default(15), '推送间隔秒数（5-3600）'),
  dshHome: field(z.string().default(defaults.dshHome), 'DSH 数据目录（Host 本机）'),
  codexHome: field(z.string().default(defaults.codexHome), 'Codex 数据目录（Host 本机）'),
  notifyEnabled: field(z.boolean().default(false), '任务结束时推送到手机/手表'),
  notifyChannel: field(z.union(['bark', 'webhook']).default('bark'), '推送通道：bark 或 webhook'),
  notifyServer: field(z.string().default(defaults.notifyServer), 'Bark 服务地址（公共实例或自托管）'),
  notifyKey: z.string().default('').description('Bark device key；只写不回显，留空保留原值').role('secret').extra('volatile', true),
  notifyWebhook: field(z.string().default(''), '自定义 Webhook 地址（notifyChannel=webhook 时使用）'),
  notifyEvents: field(z.string().default(defaults.notifyEvents), '触发事件：done / needs_input，逗号分隔'),
  notifyLevel: field(z.union(LEVELS).default('timeSensitive'), '通知级别：active/timeSensitive/passive/critical'),
  notifyGroup: field(z.string().default(defaults.notifyGroup), 'Bark 消息分组名'),
})

export function expandHome(path) {
  const value = String(path ?? '').trim()
  if (!value) return value
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

export function readConfig(raw = {}) {
  const value = {}
  for (const [key, fallback] of Object.entries(defaults)) {
    const entry = raw[key]
    value[key] = entry && typeof entry.get === 'function' ? entry.get() : entry ?? fallback
  }
  if (typeof value.enabled !== 'boolean') throw new Error('enabled 必须为布尔值')
  for (const key of ['url', 'token', 'dshHome', 'codexHome']) {
    if (typeof value[key] !== 'string' || value[key].length > 4096) throw new Error(`${key} 格式无效`)
    value[key] = value[key].trim()
  }
  if ((value.enabled || value.url) && !/^https?:\/\/[^\s]+$/i.test(value.url)) throw new Error('启用时必须填写 http(s) 推送地址')
  if (value.token && !/^[\x21-\x7e]{8,128}$/.test(value.token)) {
    throw new Error('推送令牌只能是 8-128 位可打印字符')
  }
  if (!Number.isInteger(value.intervalSeconds) || value.intervalSeconds < 5 || value.intervalSeconds > 3600) {
    throw new Error('推送间隔必须在 5 到 3600 秒之间')
  }
  value.dshHome = expandHome(value.dshHome)
  value.codexHome = expandHome(value.codexHome)
  if (!value.dshHome || !value.codexHome) throw new Error('数据目录不能为空')
  if (typeof value.notifyEnabled !== 'boolean') throw new Error('notifyEnabled 必须为布尔值')
  for (const key of ['notifyServer', 'notifyKey', 'notifyWebhook', 'notifyEvents', 'notifyLevel', 'notifyGroup']) {
    if (typeof value[key] !== 'string' || value[key].length > 4096) {
      throw new Error(`${key} 格式无效`)
    }
  }
  value.notifyServer = normalizeServer(value.notifyServer)
  value.notifyWebhook = value.notifyWebhook.trim()
  value.notifyGroup = value.notifyGroup.trim().slice(0, 40) || defaults.notifyGroup
  if (value.notifyChannel !== 'bark' && value.notifyChannel !== 'webhook') {
    throw new Error('推送通道只能是 bark 或 webhook')
  }
  if (value.notifyChannel === 'bark') {
    // 空 key 不算配置错误（等于关着），但填了就要像 key
    if (value.notifyKey && !/^[A-Za-z0-9_-]{8,128}$/.test(value.notifyKey)) {
      throw new Error('Bark key 只能是 8-128 位字母数字、下划线或短横线')
    }
    if (value.notifyServer && !/^https?:\/\/[^\s]+$/i.test(value.notifyServer)) {
      throw new Error('Bark 服务地址必须是 http(s) URL')
    }
  }
  if (value.notifyWebhook && !/^https?:\/\/[^\s]+$/i.test(value.notifyWebhook)) {
    throw new Error('Webhook 地址必须是 http(s) URL')
  }
  const events = String(value.notifyEvents)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  for (const event of events) {
    if (!EVENTS.includes(event)) throw new Error('推送事件只能是 done 或 needs_input')
  }
  value.notifyEvents = events.join(',')
  if (value.notifyLevel && !LEVELS.includes(value.notifyLevel)) {
    throw new Error('通知级别无效')
  }
  return value
}

export function publicConfig(raw) {
  const { token, notifyKey, ...rest } = readConfig(raw)
  return { ...rest, tokenConfigured: Boolean(token), notifyKeyConfigured: Boolean(notifyKey) }
}

/** 手机推送是否已可工作（用于决定是否加载基线、是否告警）。 */
export function notifyReady(config) {
  if (!config.notifyEnabled) return false
  if (config.notifyChannel === 'webhook') return Boolean(config.notifyWebhook)
  return Boolean(config.notifyServer && config.notifyKey)
}
