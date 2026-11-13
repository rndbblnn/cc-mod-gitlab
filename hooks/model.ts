// Pure logic for the GitLab panel: parsing GitLab API answers, filtering by project,
// ordering, diffs and labels. No `$` here, so it is unit-tested directly.
import type { Change, MR } from '../types'

/** Caps on one read: one list page per 100 MRs, then one detail call per tracked MR. */
export const MAX_PAGES = 5
export const MAX_DETAILS = 50
export const CONCURRENCY = 4

/** A GitLab REST call (`glab api <path>`), answering the parsed JSON. */
export type Api = (path: string) => Promise<unknown>

/** The watched projects from the `projects` option: comma/space separated, trimmed, deduped. */
export function parseProjects(s: unknown): string[] {
  if (typeof s !== 'string') return []
  return [...new Set(s.split(/[,\s]+/).map(p => p.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean))]
}

/** True when `path` is one of `projects`: a full path matches exactly, a bare name its last segment. */
export function matches(path: string, projects: readonly string[]): boolean {
  if (!projects.length) return true
  const last = path.split('/').pop()!.toLowerCase()
  const full = path.toLowerCase()
  return projects.some(p => (p.includes('/') ? p.toLowerCase() === full : p.toLowerCase() === last))
}

/** Index of the project in the configured order (unlisted last). */
export function projectRank(path: string, projects: readonly string[]): number {
  const i = projects.findIndex(p => matches(path, [p]))
  return i < 0 ? projects.length : i
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** One MR from a GitLab merge request object; undefined when it is not one. */
export function toMR(raw: unknown): MR | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const iid = num(o.iid)
  const projectId = num(o.project_id)
  const refs = (o.references ?? {}) as Record<string, unknown>
  const full = str(refs.full)
  if (iid === undefined || projectId === undefined || !full) return undefined
  const project = full.replace(/!\d+$/, '')
  const pipe = (o.head_pipeline ?? o.pipeline) as { status?: unknown } | null | undefined
  const reviewers = Array.isArray(o.reviewers)
    ? o.reviewers.map(r => str((r as { username?: unknown })?.username)).filter((r): r is string => !!r)
    : []
  return {
    ref: `${project.split('/').pop()}!${iid}`,
    project,
    projectId,
    iid,
    title: str(o.title) ?? '',
    draft: o.draft === true || o.work_in_progress === true,
    mergeStatus: str(o.detailed_merge_status) ?? str(o.merge_status) ?? 'unchecked',
    conflicts: o.has_conflicts === true,
    pipeline: pipe && typeof pipe === 'object' ? (str(pipe.status) ?? null) : null,
    notes: num(o.user_notes_count) ?? 0,
    sourceBranch: str(o.source_branch) ?? '',
    targetBranch: str(o.target_branch) ?? '',
    url: str(o.web_url) ?? '',
    reviewers,
    createdAt: str(o.created_at),
    updatedAt: str(o.updated_at),
  }
}

/** Every MR you opened that is still open, all pages. */
export async function listMine(api: Api): Promise<MR[]> {
  const out: MR[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await api(`merge_requests?scope=created_by_me&state=opened&per_page=100&page=${page}`)
    if (!Array.isArray(res)) throw new Error('Unexpected GitLab answer for merge_requests')
    for (const raw of res) {
      const m = toMR(raw)
      if (m) out.push(m)
    }
    if (res.length < 100) break
  }
  return out
}

/** One MR re-read on its own: the list omits the head pipeline and may say "unchecked". */
export async function getMR(api: Api, projectId: number, iid: number): Promise<MR> {
  const m = toMR(await api(`projects/${projectId}/merge_requests/${iid}`))
  if (!m) throw new Error(`GitLab has no MR !${iid} in project ${projectId}`)
  return m
}

/**
 * Your open MRs in the watched projects, each with its head pipeline, in panel order.
 * A failed detail read keeps the list's version of that MR.
 */
export async function fetchMRs(api: Api, projects: readonly string[]): Promise<MR[]> {
  const list = (await listMine(api)).filter(m => matches(m.project, projects))
  const out = [...list]
  const todo = list.slice(0, MAX_DETAILS)
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY)
    const got = await Promise.all(batch.map(m => getMR(api, m.projectId, m.iid).catch(() => m)))
    got.forEach((m, n) => (out[i + n] = m))
  }
  return order(out, projects)
}

/** Grouped by project in the configured order, then most recently updated first. */
export function order(mrs: readonly MR[], projects: readonly string[]): MR[] {
  return [...mrs].sort(
    (a, b) =>
      projectRank(a.project, projects) - projectRank(b.project, projects) ||
      a.project.localeCompare(b.project) ||
      (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') ||
      b.iid - a.iid,
  )
}

/** Merge statuses GitLab is still working out: not worth reporting a change to or from. */
const TRANSIENT = new Set(['unchecked', 'checking', 'preparing', 'approvals_syncing', 'cannot_be_merged_recheck'])

/** What changed between two reads: pipeline, mergeability, draft, new comments, MRs opened or gone. */
export function diff(prev: readonly MR[], next: readonly MR[], at: number): Change[] {
  const before = new Map(prev.map(m => [m.ref, m]))
  const after = new Set(next.map(m => m.ref))
  const out: Change[] = []
  const add = (m: MR, what: string, tone: Change['tone']) => out.push({ ref: m.ref, title: m.title, what, tone, at })
  for (const m of next) {
    const p = before.get(m.ref)
    if (!p) {
      add(m, 'opened', 'info')
      continue
    }
    if (p.pipeline !== m.pipeline && m.pipeline)
      add(m, `pipeline ${p.pipeline ?? 'none'} › ${m.pipeline}`, m.pipeline === 'success' ? 'good' : m.pipeline === 'failed' ? 'bad' : 'info')
    if (!p.conflicts && m.conflicts) add(m, 'has conflicts', 'bad')
    else if (p.conflicts && !m.conflicts) add(m, 'conflicts resolved', 'good')
    if (p.mergeStatus !== m.mergeStatus && !TRANSIENT.has(p.mergeStatus) && !TRANSIENT.has(m.mergeStatus) && m.mergeStatus !== 'conflict')
      add(m, `${mergeLabel(p).text} › ${mergeLabel(m).text}`, m.mergeStatus === 'mergeable' ? 'good' : 'info')
    if (p.draft !== m.draft) add(m, m.draft ? 'marked draft' : 'marked ready', 'info')
    if (m.notes > p.notes) add(m, `+${m.notes - p.notes} comment${m.notes - p.notes > 1 ? 's' : ''}`, 'info')
  }
  for (const p of prev) if (!after.has(p.ref)) add(p, 'merged or closed', 'good')
  return out
}

/** Replaces one MR in the list (or adds it), keeping the panel's order. */
export function upsert(mrs: readonly MR[], mr: MR, projects: readonly string[]): MR[] {
  if (mrs.some(m => m.ref === mr.ref)) return mrs.map(m => (m.ref === mr.ref ? mr : m))
  return order([...mrs, mr], projects)
}

// ── Labels ────────────────────────────────────────────────────────────

// Every glyph here must be one cell wide in any terminal: no East Asian "ambiguous" or emoji-capable
// characters (e.g. ▶ U+25B6, ◐ U+25D0), which some fonts draw two cells wide and which break the columns.
/** The only non-ASCII characters the panel draws: East Asian width N, in DejaVu Sans Mono and Noto Sans Mono. */
export const SINGLE_CELL = '✓⊗◔◌▸⊘∙⋯‹›⇄'
export function glyph(pipeline: string | null): string {
  switch (pipeline) {
    case 'success':
      return '✓'
    case 'failed':
      return '⊗'
    case 'running':
      return '◔'
    case 'pending':
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'scheduled':
      return '◌'
    case 'manual':
      return '▸'
    case 'canceled':
    case 'skipped':
      return '⊘'
    default:
      return '∙'
  }
}

export function pipelineColor(pipeline: string | null): string | undefined {
  switch (pipeline) {
    case 'success':
      return 'green'
    case 'failed':
      return 'red'
    case 'running':
    case 'pending':
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'scheduled':
      return 'yellow'
    case 'manual':
      return 'cyan'
    default:
      return 'gray'
  }
}

/** A short word for where the MR stands on merging, and its colour. */
export function mergeLabel(m: Pick<MR, 'mergeStatus' | 'conflicts' | 'draft'>): { text: string; color?: string } {
  if (m.conflicts || m.mergeStatus === 'conflict') return { text: 'conflicts', color: 'red' }
  if (m.draft || m.mergeStatus === 'draft_status') return { text: 'draft', color: 'gray' }
  switch (m.mergeStatus) {
    case 'mergeable':
      return { text: 'ready', color: 'green' }
    case 'not_approved':
      return { text: 'needs approval', color: 'yellow' }
    case 'discussions_not_resolved':
      return { text: 'threads open', color: 'yellow' }
    case 'ci_must_pass':
      return { text: 'ci must pass', color: 'yellow' }
    case 'ci_still_running':
      return { text: 'ci running', color: 'yellow' }
    case 'need_rebase':
      return { text: 'needs rebase', color: 'red' }
    case 'blocked_status':
      return { text: 'blocked', color: 'red' }
    case 'not_open':
      return { text: 'not open', color: 'gray' }
    case 'unchecked':
    case 'checking':
    case 'preparing':
      return { text: 'checking', color: 'gray' }
    default:
      return { text: m.mergeStatus.replace(/_/g, ' '), color: 'gray' }
  }
}

/** True for an MR that wants the person's attention: red pipeline, conflicts, rebase. */
export function needsAttention(m: MR): boolean {
  return m.pipeline === 'failed' || m.conflicts || m.mergeStatus === 'conflict' || m.mergeStatus === 'need_rebase'
}

const LEGEND: { status: string; label: string }[] = [
  { status: 'success', label: 'passed' },
  { status: 'failed', label: 'failed' },
  { status: 'running', label: 'running' },
  { status: 'pending', label: 'pending' },
  { status: 'manual', label: 'manual' },
  { status: 'canceled', label: 'canceled' },
]

/** The pipeline glyphs the list uses, for a legend line. */
export function legend(mrs: readonly Pick<MR, 'pipeline'>[]): { glyph: string; color?: string; label: string }[] {
  const seen = new Set(mrs.map(m => glyph(m.pipeline)))
  const out = LEGEND.filter(l => seen.has(glyph(l.status))).map(l => ({ glyph: glyph(l.status), color: pipelineColor(l.status), label: l.label }))
  if (seen.has('∙')) out.push({ glyph: '∙', color: 'gray', label: 'no pipeline' })
  return out
}

/** `s` cut or padded to exactly `n` columns; a cut ends in `⋯`. */
export function fit(s: string, n: number): string {
  if (n <= 0) return ''
  const chars = [...s]
  if (chars.length <= n) return s + ' '.repeat(n - chars.length)
  return chars.slice(0, Math.max(0, n - 1)).join('') + '⋯'
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** Compact age for a list column: 5m, 3h, 2d. */
export function age(iso: string | undefined, at: number): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ''
  return ago(at - t).replace(' ago', '')
}

/** An MR reference out of `/gitlab` args or a GitLab MR URL: "name!123" or ".../name/-/merge_requests/123". */
export function parseMRRef(s: string): string | undefined {
  const url = s.match(/([^/\s]+)\/-\/merge_requests\/(\d+)/)
  if (url) return `${url[1]}!${url[2]}`
  const ref = s.match(/([A-Za-z0-9_.-]+)!(\d+)/)
  return ref ? `${ref[1]}!${ref[2]}` : undefined
}

/** Is this a shell command that may open, update or push to an MR? */
export function touchesMRs(command: string): boolean {
  return /\bglab\s+(mr|api)\b|\bgit\s+push\b/.test(command)
}

// ── What Claude reads ─────────────────────────────────────────────────

/**
 * Guidance carried in the `mrs` tool's description rather than a `prompt.compose`
 * section: on Team/Enterprise orgs the built-in cc-plugin-sec-default seats
 * outermost and never runs a person's prompt.compose hooks.
 */
export function mrsGuidance(projects: readonly string[], plugin: string): string {
  const where = projects.length ? `in ${projects.join(', ')}` : 'across GitLab'
  return [
    `A panel beside the chat shows the person's own open merge requests ${where}, with pipeline and merge status.`,
    `It also lists their recently merged MRs that are not in prod yet, with how far each merge commit's pipeline is from the prod deploy job.`,
    `Call mcp__${plugin}__mrs when the person asks about their MRs or what is shipping to prod, or before you push to, rebase or comment on one of them, to see its current pipeline, merge status and conflicts.`,
  ].join('\n')
}

/** The list as text for the `mrs` tool: one line per MR. */
export function mrsText(mrs: readonly MR[], projects: readonly string[], refreshedAt: number, at: number): string {
  const where = projects.length ? projects.join(', ') : 'all projects'
  if (!mrs.length) return `No open MRs of yours in ${where} (read ${ago(at - refreshedAt)}).`
  const lines = mrs.map(m => {
    const bits = [
      `pipeline ${m.pipeline ?? 'none'}`,
      mergeLabel(m).text,
      m.notes ? `${m.notes} comments` : '',
      m.reviewers.length ? `reviewers ${m.reviewers.join(', ')}` : '',
      m.updatedAt ? `updated ${age(m.updatedAt, at)} ago` : '',
    ].filter(Boolean)
    return `- ${m.ref} ${m.title} (${m.sourceBranch} › ${m.targetBranch}) [${bits.join('; ')}] ${m.url}`
  })
  return [`Your open MRs in ${where} (read ${ago(at - refreshedAt)}):`, ...lines].join('\n')
}
