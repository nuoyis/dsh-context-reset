/**
 * dsh-context-reset — 长会话上下文重置（Host 插件）。
 * @author nuoyis
 *
 * 思路：模型把这一轮的结论写成交接简报（context_save），插件把简报落盘
 * （AGENTS.md 托管块 + .dsh/context/state.md），然后在回合结束、agent 空闲时
 * 把会话表面（surface）里除系统提示之外的全部历史替换成这条简报。
 *
 * 替换只写会话日志（compaction/prune + user/message 的 surfaceOp: replace），
 * 不调用任何模型，所以重置这一步本身不花 token；下一轮请求直接以简报为起点。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, isAbsolute } from 'node:path'
// schemastery 仅用于设置面板。插件目录被链接到 profile 之外时 Node 解析不到它，
// 此时降级为「没有设置面板、走默认值」，插件本身照常工作。
let Schema = null
try {
  const mod = await import('@deepseek-ai/schemastery')
  Schema = mod.default ?? mod
} catch {
  Schema = null
}

const BEGIN = '<!-- dsh-context:begin -->'
const END = '<!-- dsh-context:end -->'

const ASK_TEXT = [
  '【上下文重置 · 系统请求】上下文窗口快用完了。请立刻调用 context_save 工具，把这一轮的工作写成交接简报，然后结束本轮，不要继续做别的任务。',
  '',
  '简报要写成给「下一轮完全没看过这段对话的自己」看的样子，控制在 4000 字符内，包含：',
  '1. 目标：用户到底要什么（一句话）；',
  '2. 已完成：做完了什么、结论是什么、产物路径；',
  '3. 待办：还没做完的具体步骤，按顺序列；',
  '4. 关键信息：重要文件路径、命令、配置、踩过的坑与原因；',
  '5. 不要做：明确排除的方向或用户否掉的方案。',
  '',
  '写完调用 context_save(brief) 即可，本轮结束后上下文会自动重置。',
].join('\n')

/** 每会话的重置状态。 */
const entries = new Map()

function entryOf(session) {
  const key = String(session?.id ?? 'unknown')
  let entry = entries.get(key)
  if (!entry) {
    entry = { pending: false, brief: '', briefAt: 0, askedAt: 0, busy: false, lastReset: null }
    entries.set(key, entry)
  }
  return entry
}

function cwdOf(ctx, agent) {
  const session = agent?.session
  try {
    const workingDirectory = ctx.get?.('workingDirectory')
    if (workingDirectory?.get && session) return workingDirectory.get(session)
  } catch {
    /* 服务不可用时退回 session 头部 */
  }
  return session?.header?.cwd ?? session?.meta?.cwd ?? process.cwd()
}

function clip(text, max) {
  const value = String(text ?? '').trim()
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

function stamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

/** 手造一条 user 消息（MessageId 只是编译期 brand，运行时是普通字符串）。 */
function userMessage(text) {
  return { id: `ctxreset-${randomUUID()}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function stateMarkdown(brief, meta) {
  return [
    '# 交接简报（由 dsh-context-reset 自动维护）',
    '',
    `- 写入时间：${meta.writtenAt}`,
    `- 会话：${meta.sessionId}`,
    `- 触发：${meta.reason}`,
    '',
    brief,
    '',
  ].join('\n')
}

function agentsBlock(brief, meta) {
  return [
    BEGIN,
    '## 交接简报（自动维护，手改会被覆盖）',
    '',
    `> ${meta.writtenAt} · ${meta.reason}`,
    '',
    brief,
    END,
  ].join('\n')
}

/** 把托管块写进 AGENTS.md：有就替换，没有就追加到末尾。 */
async function writeAgentsFile(path, block) {
  let text = ''
  try {
    text = await readFile(path, 'utf8')
  } catch {
    text = ''
  }
  const start = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (start !== -1 && end > start) {
    text = `${text.slice(0, start)}${block}${text.slice(end + END.length)}`
  } else {
    const head = text.trimEnd()
    text = `${head}${head ? '\n\n' : ''}${block}\n`
  }
  await writeFile(path, text, 'utf8')
}

/** 当前表面里哪些节点属于“系统头”（必须保留）。 */
function systemHeadLength(session, nodes) {
  let index = 0
  while (index < nodes.length) {
    const event = session.eventAt(nodes[index])
    if (event && event.type === 'system/message') index += 1
    else break
  }
  return index
}

function shadowTokenCount(ctx, session, seqs) {
  let total = 0
  for (const seq of seqs) {
    const event = session.eventAt(seq)
    if (!event) continue
    try {
      total += Number(ctx.tokenMeter.estimateMessage(session.deriveEventMessage(event))) || 0
    } catch {
      /* 估算失败不影响重置 */
    }
  }
  return total
}

/**
 * 无模型重置：保留系统头，把其余表面节点替换成一条交接消息。
 * @returns {{removed:number, tokens:number}|null}
 */
function resetSurface(ctx, agent, brief, reason) {
  const session = agent.session
  const nodes = [...session.surface.nodes]
  const head = systemHeadLength(session, nodes)
  if (head >= nodes.length) return null
  const startSeq = nodes[head]
  const endSeq = nodes[nodes.length - 1]
  const shadowedSeqs = nodes.slice(head)
  const tokens = shadowTokenCount(ctx, session, shadowedSeqs)
  const text = [
    `【上下文已重置 · ${stamp()} · ${reason}】`,
    '之前这段对话的历史已经被清空，只保留系统提示和下面这份交接简报；简报同时写在工作区的 AGENTS.md 托管块与 .dsh/context/state.md 里。',
    '',
    brief,
    '',
    '后续任何请求都基于上面这份简报继续：先看「待办」，不要重复「已完成」里的事情。',
  ].join('\n')
  const message = userMessage(text)
  session.append('compaction/prune', {
    shadowedRange: { start: startSeq, end: endSeq },
    shadowedSeqs,
    shadowedTokenCount: tokens,
  })
  session.append('user/message', message, {
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: shadowedSeqs,
  })
  return { removed: shadowedSeqs.length, tokens }
}

async function saveBrief(ctx, config, agent, brief, reason) {
  const cwd = cwdOf(ctx, agent)
  const maxChars = config.maxBriefChars
  const text = clip(brief, maxChars)
  if (!text) throw new Error('brief 不能为空：请把目标、已完成、待办、关键信息写成一份简报')
  const stateDir = isAbsolute(config.stateDir) ? config.stateDir : join(cwd, config.stateDir)
  const statePath = join(stateDir, 'state.md')
  const agentsPath = isAbsolute(config.agentsFile) ? config.agentsFile : join(cwd, config.agentsFile)
  const meta = {
    writtenAt: stamp(),
    sessionId: String(agent.session?.id ?? ''),
    reason,
  }
  await mkdir(stateDir, { recursive: true })
  await writeFile(statePath, stateMarkdown(text, meta), 'utf8')
  let agentsWritten = ''
  if (config.writeAgentsFile) {
    try {
      await writeAgentsFile(agentsPath, agentsBlock(text, meta))
      agentsWritten = agentsPath
    } catch (error) {
      agentsWritten = ''
      ctx.logger?.warn?.(`context-reset: 写 AGENTS.md 失败：${String(error)}`)
    }
  }
  const entry = entryOf(agent.session)
  entry.brief = text
  entry.briefAt = Date.now()
  entry.pending = true
  entry.askedAt = 0
  return { text, statePath, agentsPath: agentsWritten }
}

/** 空闲时执行：有待办就重置，压力过高就请模型写简报。 */
async function settle(ctx, config, agent) {
  const entry = entryOf(agent.session)
  if (entry.busy) return
  entry.busy = true
  try {
    if (entry.pending && entry.brief) {
      const result = await agent.runMaintenance(async () => resetSurface(ctx, agent, entry.brief, '自动'))
      if (result) {
        entry.pending = false
        entry.lastReset = { at: Date.now(), ...result }
      }
      return
    }
    if (!config.enabled) return
    let pressure = null
    try {
      pressure = ctx.tokenMeter.contextPressure(agent.session)
    } catch {
      pressure = null
    }
    if (!pressure || !pressure.contextWindow) return
    const percent = (pressure.pressureTokens / pressure.contextWindow) * 100
    if (percent < config.autoAtPercent) {
      entry.askedAt = 0
      return
    }
    if (entry.askedAt) return
    entry.askedAt = Date.now()
    await agent.followup(userMessage(ASK_TEXT))
  } catch (error) {
    ctx.logger?.warn?.(`context-reset: ${String(error)}`)
  } finally {
    entry.busy = false
  }
}

export const name = 'context-reset'
export const inject = ['tools', 'commands', 'tokenMeter']

export const Config = Schema ? Schema.object({
  enabled: Schema.boolean().default(true).description('达到阈值时自动请模型写交接简报并重置'),
  autoAtPercent: Schema.number().min(1).max(100).default(85).description('上下文压力（已用 token / 窗口）达到该百分比时自动请求简报'),
  agentsFile: Schema.string().default('AGENTS.md').description('简报写入的文件，相对项目目录'),
  stateDir: Schema.string().default('.dsh/context').description('简报存档目录，相对项目目录'),
  maxBriefChars: Schema.number().min(200).default(6000).description('简报最大字符数，超出截断'),
  writeAgentsFile: Schema.boolean().default(true).description('是否把简报写进 AGENTS.md 托管块'),
}) : undefined

export function apply(ctx, config) {
  const settings = {
    enabled: config?.enabled !== false,
    autoAtPercent: Number(config?.autoAtPercent ?? 85),
    agentsFile: String(config?.agentsFile ?? 'AGENTS.md'),
    stateDir: String(config?.stateDir ?? '.dsh/context'),
    maxBriefChars: Number(config?.maxBriefChars ?? 6000),
    writeAgentsFile: config?.writeAgentsFile !== false,
  }

  ctx.tools.register({
    name: 'context_save',
    description: [
      '把这一轮的工作写成交接简报，并安排在回合结束后清空对话上下文（只保留系统提示和这份简报）。',
      '什么时候用：上下文快满、或被系统要求写简报时；跑完一个阶段、需要换新对话继续时；',
      '预计后面还要接着做、但现在这段历史已经没用时。不要为了省一点上下文频繁调用。',
      '简报是写给「完全没看过这段对话的自己」的：目标、已完成（含产物路径）、待办、关键文件与命令、踩过的坑、用户否掉的方向。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        brief: {
          type: 'string',
          description: '交接简报正文（Markdown）。目标 / 已完成 / 待办 / 关键信息 / 不要做。',
        },
        reason: {
          type: 'string',
          description: '为什么现在保存，写进存档头部。可省略。',
        },
      },
      required: ['brief'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          chars: { type: 'number' },
          stateFile: { type: 'string' },
          agentsFile: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render(args, value) {
        const lines = [`已保存交接简报（${value.chars} 字符）→ ${value.stateFile}`]
        if (value.agentsFile) lines.push(`同时写进 ${value.agentsFile} 的托管块。`)
        lines.push('本轮结束、agent 空闲后会自动把上下文替换成这份简报。现在可以正常收尾本轮。')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('context_save 只能在 agent 回合里调用')
      const reason = String(args?.reason ?? '').trim() || '模型主动保存'
      const saved = await saveBrief(ctx, settings, agent, args?.brief, reason)
      return {
        ok: true,
        chars: saved.text.length,
        stateFile: saved.statePath,
        agentsFile: saved.agentsPath,
      }
    },
  })

  ctx.commands.register({
    definitionId: 'dsh-context-reset',
    name: 'handoff',
    description: '写交接简报并重置上下文（/handoff [补充要求]）',
    handler: async (invocation) => {
      const agent = invocation.agent
      const entry = entryOf(agent.session)
      const note = String(invocation.rawInput ?? '').trim()
      if (entry.brief) {
        try {
          const result = await agent.runMaintenance(async () => resetSurface(ctx, agent, entry.brief, '手动 /handoff'))
          entry.pending = false
          if (!result) return { kind: 'error', text: '没有可重置的历史。' }
          entry.lastReset = { at: Date.now(), ...result }
          return {
            kind: 'success',
            text: `已用最近一份交接简报重置上下文：清掉 ${result.removed} 条历史（约 ${result.tokens} tokens）。`,
          }
        } catch (error) {
          return { kind: 'error', text: `重置失败：${String(error)}` }
        }
      }
      await agent.followup(userMessage(note ? `${ASK_TEXT}\n\n补充要求：${note}` : ASK_TEXT))
      return { kind: 'success', text: '已请模型写交接简报；这一轮结束后自动重置上下文。' }
    },
  })

  ctx.on('agent/status', (payload) => {
    if (payload?.status !== 'idle') return
    const agent = payload?.agent
    if (!agent) return
    void settle(ctx, settings, agent)
  })
}
