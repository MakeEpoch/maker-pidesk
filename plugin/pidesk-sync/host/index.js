/**
 * pidesk-sync — cordis host plugin entry.
 *
 * 周期：每 intervalSeconds 秒聚合一次任务 → POST 到 pidesk。
 * - DSH 数据优先走宿主 sessionQuery 服务（精确、实时）；服务不可用回退直读
 *   ~/.dsh/sessions 的 session.v4.jsonl.zstd（Node 内建 zstd 解压，mtime 缓存）。
 * - Codex 走 ~/.codex/sessions 的 rollout-*.jsonl（task_started/task_complete）。
 * - 单轮失败只记日志，下一轮重试；dispose 清理定时器与进行中的请求。
 * 无浏览器半边（纯 host 定时任务），不占用设置页以外的任何 GUI 资源。
 */

import { collectTasks, pushPayload, pushToPidesk } from './agents.js'
import { defaults, readConfig, notifyReady } from './config.js'
import {
  FAILURE_LIMIT,
  barkUrl,
  noticesFor,
  sendNotice,
  webhookPayload,
} from './notify.js'

export { Config } from './config.js'
export * from './agents.js'
export * from './notify.js'

export const name = 'pidesk-sync'
export const inject = []

const LOG = 'pidesk-sync'

export function apply(ctx, rawConfig) {
  ctx.effect(() => {
    const state = {
      timer: null,
      busy: false,
      disposed: false,
      controller: null,
      dshCache: new Map(),
      codexCache: new Map(),
      lastResult: null,
      // 手机推送：上一轮任务状态（id → status），首轮只建基线
      statusCache: null,
      notifyFailures: 0,
      warnings: [],
    }
    const log = (level, message) => {
      const text = `[${LOG}] ${message}`
      if (ctx.logger?.[level]) ctx.logger[level](text)
    }
    const warn = (message) => {
      if (state.warnings.length < 50 && !state.warnings.includes(message)) state.warnings.push(message)
      log('warn', message)
    }

    /**
     * 手机推送（Bark / Webhook）：只在 running → done/needs_input 的边沿发。
     * 基线逻辑：通道刚配置好或刚启用时，用当前任务状态建基线而不推送，
     * 否则一启用就会把历史已完成任务全推一遍。
     */
    const dispatchNotices = async (config, tasks) => {
      const ready = notifyReady(config)
      const { notices, next } = noticesFor(tasks, state.statusCache, {
        events: config.notifyEvents,
        level: config.notifyLevel,
        group: config.notifyGroup,
      })
      // 通道未配置时同样维护基线，这样中途启用不会补推历史任务
      const hasBaseline = state.statusCache !== null
      state.statusCache = next
      if (!ready) return
      if (!hasBaseline) {
        log('info', '手机推送已启用，已建立任务基线，下一轮起推送完成事件')
        return
      }
      if (!notices.length) return
      if (state.notifyFailures >= FAILURE_LIMIT) return
      for (const notice of notices) {
        const url =
          config.notifyChannel === 'webhook'
            ? config.notifyWebhook
            : barkUrl(config.notifyServer, config.notifyKey)
        const payload =
          config.notifyChannel === 'webhook'
            ? webhookPayload(notice.task, notice.status, notice.payload)
            : notice.payload
        const result = await sendNotice({ url, payload })
        if (result.skipped) return
        if (result.ok) {
          state.notifyFailures = 0
          log('info', `已推送手机通知：${notice.task.title}（${notice.status}）`)
        } else {
          state.notifyFailures += 1
          warn(
            `手机推送失败（${state.notifyFailures}/${FAILURE_LIMIT}）：${
              result.error ?? `HTTP ${result.status}`
            }`,
          )
          if (state.notifyFailures >= FAILURE_LIMIT) {
            warn('手机推送连续失败，已暂停；修复配置后自动恢复')
            break
          }
        }
      }
    }

    const tick = async () => {
      if (state.busy || state.disposed) return
      state.busy = true
      state.controller = new AbortController()
      let config
      try {
        config = readConfig(rawConfig)
      } catch (error) {
        warn(`配置无效，暂停推送：${safe(error)}`)
        state.busy = false
        return
      }
      if (!config.enabled) {
        state.lastResult = { ok: true, disabled: true, at: Date.now() }
        state.busy = false
        return
      }
      try {
        const now = Date.now() / 1000
        const io = {
          warn,
          dshCache: state.dshCache,
          codexCache: state.codexCache,
        }
        let query = null
        try {
          query = ctx.get?.('sessionQuery') ?? null
        } catch (error) {
          query = null
        }
        const tasks = await collectTasks({
          query,
          dshHome: config.dshHome,
          codexHome: config.codexHome,
          now,
          signal: state.controller.signal,
          io,
        })
        if (state.disposed) return
        // 手机推送独立于屏幕：pidesk 不可达时手表仍应收到
        try {
          await dispatchNotices(config, tasks)
        } catch (error) {
          warn(`手机推送异常：${safe(error)}`)
        }
        const payload = pushPayload(tasks, Date.now())
        const result = await pushToPidesk({ url: config.url, token: config.token, payload })
        state.lastResult = { ...result, at: Date.now() }
        if (result.ok) {
          if (state.warnings.length) state.warnings = []
          log('info', `已推送 ${result.count} 个任务到 ${maskUrl(config.url)}`)
        } else {
          warn(`推送失败 HTTP ${result.status}：${maskUrl(config.url)}`)
        }
      } catch (error) {
        if (!state.disposed) warn(`本轮推送失败：${safe(error)}`)
      } finally {
        state.busy = false
        state.controller = null
      }
    }

    const start = () => {
      const config = safeConfig(rawConfig)
      const seconds = config?.intervalSeconds ?? defaults.intervalSeconds
      if (state.timer) clearInterval(state.timer)
      state.timer = setInterval(() => { tick().catch(() => {}) }, seconds * 1000)
      state.timer.unref?.()
      // 启动后尽快推第一次，让屏幕尽早拿到数据
      tick().catch(() => {})
    }

    function safeConfig(raw) {
      try { return readConfig(raw) } catch { return null }
    }

    start()

    // volatile 配置变更时 Loader 会重入 apply()，这里不需要额外监听
    return async () => {
      state.disposed = true
      if (state.timer) clearInterval(state.timer)
      state.controller?.abort()
      // 等待进行中的一轮退出（有界）
      for (let i = 0; i < 50 && state.busy; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      state.dshCache.clear()
      state.codexCache.clear()
      log('info', '已停止推送')
    }
  }, 'pidesk-sync: host')
}

function safe(error) {
  return String(error?.message ?? error).slice(0, 200)
}

function maskUrl(url) {
  return String(url ?? '').replace(/\/\/[^@]+@/, '//***@')
}
