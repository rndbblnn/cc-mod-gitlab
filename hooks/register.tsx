import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Change, MR, Ship } from '../types'
import {
  age,
  ago,
  diff,
  fetchMRs,
  fit,
  getMR,
  glyph,
  legend,
  mergeLabel,
  mrsGuidance,
  mrsText,
  needsAttention,
  parseMRRef,
  parseProjects,
  pipelineColor,
  touchesMRs,
  upsert,
  type Api,
} from './model'
import { fetchShips, parseProdJobs, SHIP_DAYS, SHIP_MAX, shipChanges, shipLabel, shipsText, shipUrl } from './ship'

// Bump a shape tag when that value's fields change: it declines what an older
// version stored, which outlives a reload.
const mrs = atom({ plugin: 'gitlab-panel', key: 'mrs' } as const, [], { shape: 'mrs-1' })
const loading = atom({ plugin: 'gitlab-panel', key: 'loading' } as const, false, { shape: 'loading-1' })
const error = atom({ plugin: 'gitlab-panel', key: 'error' } as const, null, { shape: 'error-1' })
const refreshedAt = atom({ plugin: 'gitlab-panel', key: 'refreshedAt' } as const, 0, { shape: 'refreshedAt-1' })
const selected = atom({ plugin: 'gitlab-panel', key: 'selected' } as const, null, { shape: 'selected-1' })
const mode = atom({ plugin: 'gitlab-panel', key: 'mode' } as const, 'none', { shape: 'mode-1' })
const changes = atom({ plugin: 'gitlab-panel', key: 'changes' } as const, [], { shape: 'changes-1' })
const now = atom({ plugin: 'gitlab-panel', key: 'now' } as const, 0, { shape: 'now-1' })
const ships = atom({ plugin: 'gitlab-panel', key: 'ships' } as const, [], { shape: 'ships-2' })
const startOpened = atom({ plugin: 'gitlab-panel', key: 'startOpened' } as const, false, { shape: 'start-opened-1' })

const PLUGIN = 'gitlab-panel'
const PANE = 'gitlab'
const TITLE = 'GitLab MRs'
const KEEP_CHANGES = 30
/** After Claude pushes or runs `glab mr`, re-read sooner than the poll would. */
const AFTER_WRITE_MS = 15_000

// Module state: starts over on a reload, which is fine for all of it.
let refreshing: Promise<void> | undefined
let queued = false
/** Epoch ms of a re-read asked for by a write, picked up by the clock. */
let soonAt = 0
/** Commit ancestry answers (`projectId:sha:liveSha` › live), which never change. */
const ancestry = new Map<string, boolean>()

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Options, set as `register` runs. */
const cfg = { projects: [] as string[], host: 'gitlab.com', glab: 'glab', refreshMs: 60_000, instruct: true, openOnStart: true, prodJobs: parseProdJobs(undefined), shipDays: SHIP_DAYS, shipMax: SHIP_MAX }

/** `glab api <path>` as JSON; throws with glab's own message when it fails. */
async function glab($: EngineInterface, path: string, extra: readonly string[] = []): Promise<unknown> {
  const argv = [cfg.glab, 'api', ...(cfg.host ? ['--hostname', cfg.host] : []), ...extra, path]
  const r = await $.process.run(argv, { timeoutMs: 30_000 })
  if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 300) || `glab exited ${r.exitCode}`)
  try {
    return JSON.parse(r.stdout)
  } catch {
    throw new Error(`Unexpected glab answer: ${r.stdout.slice(0, 120)}`)
  }
}

function api($: EngineInterface): Api {
  return path => glab($, path)
}

async function record($: EngineInterface, found: Change[]) {
  if (!found.length) return
  await update($, changes, list => [...found, ...list].slice(0, KEEP_CHANGES))
  const loud = found.filter(c => c.what !== 'opened')
  if (loud.length === 1) await $.ui.toast(`${loud[0]!.ref}: ${loud[0]!.what}`)
  else if (loud.length > 1) await $.ui.toast(`GitLab: ${loud.length} MR changes`)
}

/** Re-reads every open MR; overlapping calls fold into one more run. */
async function refresh($: EngineInterface): Promise<void> {
  if (refreshing) {
    queued = true
    return refreshing
  }
  refreshing = (async () => {
    do {
      queued = false
      await update($, loading, () => true)
      try {
        const prev = await read($, mrs)
        const hadRead = (await read($, refreshedAt)) > 0
        const got = await fetchMRs(api($), cfg.projects)
        const at = Date.now()
        await record($, hadRead ? diff(prev, got, at) : [])
        await update($, mrs, () => got)
        await update($, refreshedAt, () => at)
        await update($, now, () => at)
        await update($, error, () => null)
        if (cfg.shipDays > 0) await refreshShips($, hadRead, at)
        const sel = await read($, selected)
        if (sel && !got.some(m => m.ref === sel)) {
          await update($, selected, () => null)
          await update($, mode, () => 'none')
        }
      } catch (err) {
        await update($, error, () => errText(err))
      } finally {
        await update($, loading, () => false)
      }
      await statusLine($)
    } while (queued)
  })().finally(() => {
    refreshing = undefined
  })
  return refreshing
}

/** Re-reads the Shipping section; a failure keeps the last list (the MR list's error line covers glab being down). */
async function refreshShips($: EngineInterface, hadRead: boolean, at: number): Promise<void> {
  try {
    const prev = await read($, ships)
    const got = await fetchShips(api($), cfg.projects, cfg.prodJobs, at, cfg.shipDays, ancestry, cfg.shipMax)
    if (ancestry.size > 2000) ancestry.clear()
    await record($, hadRead ? shipChanges(prev, got, at) : [])
    await update($, ships, () => got)
  } catch {
    // Keep the last read.
  }
}

/** Re-reads one MR (the detail view's refresh). */
async function refreshOne($: EngineInterface, mr: MR): Promise<void> {
  try {
    const got = await getMR(api($), mr.projectId, mr.iid)
    if (got.mergeStatus === 'merged' || got.mergeStatus === 'not_open') return void refresh($)
    await record($, diff([mr], [got], Date.now()))
    await update($, mrs, list => upsert(list, got, cfg.projects))
  } catch {
    void refresh($)
  }
}

async function openPane($: EngineInterface, focusIt = false): Promise<boolean> {
  await update($, now, () => Date.now())
  const r = await $.ui.open({ id: PANE, title: TITLE, columns: 64, backgroundColor: 'transparent', ...(focusIt ? { focus: true as const } : {}) })
  return r.isPlaced
}

async function comment($: EngineInterface, mr: MR, body: string): Promise<void> {
  try {
    await glab($, `projects/${mr.projectId}/merge_requests/${mr.iid}/notes`, ['-X', 'POST', '-f', `body=${body}`])
    await update($, mrs, list => list.map(m => (m.ref === mr.ref ? { ...m, notes: m.notes + 1 } : m)))
    await $.ui.toast(`Comment added to ${mr.ref}`)
  } catch (err) {
    await $.ui.toast(`Could not comment on ${mr.ref}: ${errText(err)}`)
  }
}

async function openUrl($: EngineInterface, url: string) {
  try {
    const r = await $.process.run(['xdg-open', url], { timeoutMs: 5000 })
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `exit ${r.exitCode}`)
  } catch {
    try {
      await $.process.run(['open', url], { timeoutMs: 5000 })
    } catch (err) {
      await $.ui.toast(`Could not open the browser: ${errText(err)}`)
    }
  }
}

async function statusLine($: EngineInterface) {
  if (!(await read($, refreshedAt))) return $.ui.status(undefined)
  const list = await read($, mrs)
  const failed = list.filter(m => m.pipeline === 'failed').length
  const blocked = list.filter(m => m.conflicts || m.mergeStatus === 'conflict' || m.mergeStatus === 'need_rebase').length
  const ready = list.filter(m => m.mergeStatus === 'mergeable' && !m.draft).length
  const bits = [`⇄ ${list.length} MR${list.length === 1 ? '' : 's'}`]
  if (failed) bits.push(`${failed} ⊗`)
  if (blocked) bits.push(`${blocked} conflict`)
  if (ready) bits.push(`${ready} ready`)
  const deployable = (await read($, ships)).filter(s => s.state === 'waiting' || s.state === 'stale').length
  if (deployable) bits.push(`${deployable} to deploy`)
  $.ui.status(`${bits.join(' ∙ ')} ∙ /gitlab`)
}

type Els = { Text: any; Button: any }

/**
 * The list as one line per MR under a dim project heading: pipeline glyph, an
 * aligned !iid column, the title, then merge status and age pushed to the right.
 * Pressing a row opens the MR in the browser.
 */
function listRows(
  els: Els,
  list: readonly MR[],
  width: number,
  at: number,
  onOpen: (url: string) => void,
) {
  const { Text, Button } = els
  const iidW = Math.max(0, ...list.map(m => String(m.iid).length + 1))
  const labels = list.map(m => mergeLabel(m))
  const ages = list.map(m => age(m.updatedAt, at))
  const labelW = Math.max(0, ...labels.map(l => l.text.length))
  const ageW = Math.max(0, ...ages.map(a => a.length))
  const out: RenderChildren[] = []
  let project = ''
  list.forEach((m, n) => {
    if (m.project !== project) {
      project = m.project
      const count = list.filter(x => x.project === project).length
      if (n > 0) out.push(<Text key={`gap-${project}`}> </Text>)
      out.push(
        <Text key={`head-${project}`} wrap="truncate-end">
          <Text bold>{project.split('/').pop()}</Text>
          <Text dimColor> {count}</Text>
        </Text>,
      )
    }
    const room = width - 2 - 2 - iidW - 1
    const metaW = labelW + 1 + ageW
    const showMeta = room - metaW - 1 >= 14
    const titleW = showMeta ? room - metaW - 1 : room
    const l = labels[n]!
    out.push(
      <Button key={`row-${m.ref}`} plain onPress={() => onOpen(m.url)}>
        {'  '}
        <Text color={pipelineColor(m.pipeline)}>{glyph(m.pipeline)}</Text>{' '}
        <Text dimColor>{fit(`!${m.iid}`, iidW)}</Text>{' '}
        <Text dimColor={m.draft} bold={needsAttention(m)}>
          {fit(m.title.replace(/^(Draft|WIP):\s*/i, ''), titleW)}
        </Text>
        {showMeta ? (
          <Text>
            {' '}
            <Text color={l.color}>{l.text.padStart(labelW)}</Text> <Text dimColor>{ages[n]!.padStart(ageW)}</Text>
          </Text>
        ) : (
          ''
        )}
      </Button>,
    )
  })
  return out
}

/**
 * The Shipping section: your last merged MRs, most recently updated pipeline first, one line each:
 * state glyph, project!iid, title, one mark per pipeline stage, the state and the pipeline's age.
 * Pressing a row opens the pipeline to act on.
 */
function shipRows(els: Els, list: readonly Ship[], width: number, at: number, onOpen: (url: string) => void) {
  const { Text, Button } = els
  if (!list.length) return []
  const refW = Math.max(...list.map(s => s.ref.length))
  const labels = list.map(s => shipLabel(s))
  const ages = list.map(s => age(s.pipelineUpdatedAt ?? s.mergedAt, at))
  const labelW = Math.max(...labels.map(l => l.text.length))
  const ageW = Math.max(...ages.map(a => a.length))
  const pipsW = Math.max(...list.map(s => s.stages.length))
  const out: RenderChildren[] = [
    <Text key="ship-gap"> </Text>,
    <Text key="ship-head" bold>
      Shipping
    </Text>,
  ]
  list.forEach((s, n) => {
    const l = labels[n]!
    const metaW = (pipsW ? pipsW + 1 : 0) + labelW + 1 + ageW
    const room = width - 2 - 2 - refW - 1
    const showMeta = room - metaW - 1 >= 10
    const titleW = showMeta ? room - metaW - 1 : room
    out.push(
      <Button key={`ship-${s.ref}`} plain onPress={() => onOpen(shipUrl(s))}>
        {'  '}
        <Text color={l.color}>{l.glyph}</Text> <Text dimColor>{fit(s.ref, refW)}</Text> <Text>{fit(s.title, titleW)}</Text>
        {showMeta ? (
          <Text>
            {' '}
            {s.stages.map((st, i) => (
              <Text key={`pip-${i}`} color={pipelineColor(st.status)}>
                {glyph(st.status)}
              </Text>
            ))}
            {pipsW ? ' '.repeat(pipsW - s.stages.length + 1) : ''}
            <Text color={l.color}>{l.text.padEnd(labelW)}</Text> <Text dimColor>{ages[n]!.padStart(ageW)}</Text>
          </Text>
        ) : (
          ''
        )}
      </Button>,
    )
  })
  return out
}

export const register: Register = (on, options) => {
  const n = typeof options.refreshSeconds === 'number' ? options.refreshSeconds : Number(options.refreshSeconds)
  cfg.projects = parseProjects(options.projects)
  cfg.host = typeof options.host === 'string' ? options.host.trim() : 'gitlab.com'
  cfg.glab = typeof options.glab === 'string' && options.glab.trim() ? options.glab.trim() : 'glab'
  cfg.refreshMs = (Number.isFinite(n) && n >= 0 ? n : 60) * 1000
  cfg.instruct = options.instructClaude !== false && options.instructClaude !== 'false'
  const days = typeof options.shipDays === 'number' ? options.shipDays : Number(options.shipDays ?? SHIP_DAYS)
  cfg.shipDays = Number.isFinite(days) && days >= 0 ? days : SHIP_DAYS
  const max = typeof options.shipMax === 'number' ? options.shipMax : Number(options.shipMax ?? SHIP_MAX)
  cfg.shipMax = Number.isFinite(max) && max >= 0 ? Math.floor(max) : SHIP_MAX
  cfg.prodJobs = parseProdJobs(options.prodJobs)
  cfg.openOnStart = options.openOnStart !== false && options.openOnStart !== 'false'
  const { projects, refreshMs, instruct } = cfg

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'gitlab',
      description: 'Open MRs panel: `/gitlab` shows/hides, `/gitlab refresh`, `/gitlab <project>!<iid>` opens one',
    })
    await $.tool.register({
      name: 'mrs',
      description:
        "The person's own open GitLab merge requests in the watched projects: branch, head pipeline status, merge status (conflicts, approvals, threads), comment count, reviewers and URL." +
        (instruct ? `\n\n${mrsGuidance(projects, PLUGIN)}` : ''),
      inputSchema: { type: 'object', properties: { refresh: { type: 'boolean', description: 'Re-read from GitLab first (slower).' } } },
    })

    void refresh($)

    let tick = 0
    $.clock.every(1000, () => {
      void (async () => {
        tick++
        if (tick % 10 === 0) await update($, now, () => Date.now())
        if (refreshing) return
        if (soonAt && Date.now() >= soonAt) {
          soonAt = 0
          return refresh($)
        }
        if (refreshMs && Date.now() - (await read($, refreshedAt)) >= refreshMs) await refresh($)
      })()
    })

    // Open once per session; a reload re-runs session.start and must not bring back a pane the person closed.
    if (cfg.openOnStart && e.isInteractive && !(await read($, startOpened))) {
      await update($, startOpened, () => true)
      try {
        await openPane($)
      } catch {
        // Best effort: never hold up the session's start.
      }
    }
    return started
  })

  on('command.run', { command: 'gitlab' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg === 'refresh') {
      await refresh($)
      const err = await read($, error)
      return { text: err ? `Refresh failed: ${err}` : `${(await read($, mrs)).length} open MRs.` }
    }
    const ref = arg ? parseMRRef(arg) : undefined
    if (ref) {
      await openPane($, true)
      const list = await read($, mrs)
      const hit = list.find(m => m.ref.toLowerCase() === ref.toLowerCase())
      if (!hit) return { text: `${ref} is not among your open MRs in the watched projects.` }
      await update($, selected, () => hit.ref)
      return { text: `Showing ${hit.ref}.` }
    }
    if (arg) return { text: `Usage: /gitlab | /gitlab refresh | /gitlab <project>!<iid>` }
    if ((await $.ui.panes()).some(p => p.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: 'GitLab panel closed.' }
    }
    await openPane($, true)
    return { text: projects.length ? `Watching your MRs in ${projects.join(', ')}.` : 'Watching your MRs in every project (set `projects` in /config to narrow).' }
  })

  on('tool.call', { tool: `mcp__${PLUGIN}__mrs` }, async ($, e) => {
    if ((e as { refresh?: boolean }).refresh || !(await read($, refreshedAt))) await refresh($)
    const err = await read($, error)
    const shipping = shipsText(await read($, ships))
    const text = mrsText(await read($, mrs), projects, await read($, refreshedAt), Date.now()) + (shipping ? `\n\n${shipping}` : '')
    return { result: err ? `${text}\n(last refresh failed: ${err})` : text }
  }).catch(() => ({ result: 'The GitLab panel could not read your MRs; use glab directly.' }))

  // Claude pushing or running `glab mr ⋯`: re-read a little later, once GitLab caught up.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const res = await next(e)
    if (e.tool === 'Bash' && typeof e.command === 'string' && touchesMRs(e.command)) soonAt = Date.now() + AFTER_WRITE_MS
    return res
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Input = 'Input' in ui ? ui.Input : undefined
    const width = Math.max(20, e.props.bodyColumns ?? 64)
    const list = await read($, mrs)
    const at = Math.max(await read($, now), Date.now() - 10_000)
    const isLoading = await read($, loading)
    const err = await read($, error)
    const refreshed = await read($, refreshedAt)
    const sel = await read($, selected)
    const pick = sel ? list.find(m => m.ref === sel) : undefined
    const back = () => {
      void update($, selected, () => null)
      void update($, mode, () => 'none')
    }

    if (pick) {
      const m = await read($, mode)
      const l = mergeLabel(pick)
      return (
        <Box flexDirection="column">
          <Box gap={2}>
            <Button key="back" label="‹ back" hotkey="b" plain onPress={back} />
            <Button key="refresh" label="refresh" hotkey="r" plain onPress={() => void refreshOne($, pick)} />
          </Box>
          <Text bold wrap="truncate-end">
            {pick.ref} <Text color={l.color}>{l.text}</Text>
          </Text>
          <Text>{pick.title}</Text>
          <Text dimColor wrap="truncate-end">
            {pick.sourceBranch} › {pick.targetBranch}
          </Text>
          <Text wrap="truncate-end">
            <Text color={pipelineColor(pick.pipeline)}>
              {glyph(pick.pipeline)} pipeline {pick.pipeline ?? 'none'}
            </Text>
            <Text dimColor>
              {' ∙ '}
              {pick.notes} comment{pick.notes === 1 ? '' : 's'}
              {pick.updatedAt ? ` ∙ updated ${age(pick.updatedAt, at)} ago` : ''}
            </Text>
          </Text>
          {pick.reviewers.length ? <Text dimColor wrap="truncate-end">reviewers {pick.reviewers.join(', ')}</Text> : null}
          <Text> </Text>
          {m === 'comment' && Input ? (
            <Input
              key="comment"
              label={`Comment on ${pick.ref}`}
              placeholder="markdown; Enter sends"
              submitLabel="post"
              autoFocus
              onSubmit={(value: string) => {
                const text = value.trim()
                void update($, mode, () => 'none')
                if (text) void comment($, pick, text)
              }}
            />
          ) : (
            <Box gap={2} flexWrap="wrap">
              <Button key="open" label="open" hotkey="o" plain onPress={() => void openUrl($, pick.url)} />
              <Button key="copy" label="copy link" hotkey="y" plain onPress={() => void $.ui.copy({ text: pick.url, surface: e.surface })} />
              <Button key="copy-branch" label="copy branch" hotkey="g" plain onPress={() => void $.ui.copy({ text: pick.sourceBranch, surface: e.surface })} />
              {Input ? <Button key="comment-btn" label="comment" hotkey="c" plain onPress={() => void update($, mode, () => 'comment')} /> : null}
            </Box>
          )}
        </Box>
      )
    }

    const keys: RenderChildren[] = []
    legend(list).forEach((l, n) => {
      if (n) keys.push('  ')
      keys.push(<Text color={l.color}>{l.glyph}</Text>, <Text dimColor> {l.label}</Text>)
    })
    const failed = list.filter(m => m.pipeline === 'failed').length
    const attention = list.filter(needsAttention).length
    // Docked, the body is at least the pane's height so the footer sits on its last rows.
    const dock = e.props.placement === 'dock'
    const minRows = dock ? e.props.scroll.bodyRows : undefined
    return (
      <Box flexDirection="column" minHeight={minRows}>
        <Box flexDirection="column" flexGrow={1}>
          <Text dimColor wrap="truncate">
            {failed ? <Text color="red">{failed} failing ∙ </Text> : ''}
            {attention - failed > 0 ? <Text color="red">{attention - failed} blocked ∙ </Text> : ''}
            {isLoading ? '⋯ reading GitLab⋯' : refreshed ? ago(at - refreshed) : 'not read yet'}
          </Text>
          {err ? <Text color="red" wrap="truncate-end">⊗ {err}</Text> : null}
          <Text> </Text>
          {list.length === 0 && <Text dimColor>{isLoading || !refreshed ? 'Loading⋯' : 'No open MRs of yours here.'}</Text>}
          {listRows({ Text, Button }, list, width, at, url => void openUrl($, url))}
          {shipRows({ Text, Button }, await read($, ships), width, at, url => void openUrl($, url))}
        </Box>
        <Box flexDirection="column">
          <Box gap={2}>
            <Button key="refresh-all" label="refresh" hotkey="r" plain onPress={() => void refresh($)} />
          </Box>
          {keys.length ? <Text>{keys}</Text> : null}
        </Box>
      </Box>
    )
  })
}
