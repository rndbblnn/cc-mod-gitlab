// Pure logic for the "Shipping" section: your recently merged MRs that are not in prod yet,
// and how far each one's merge-commit pipeline is from its project's prod deploy job.
// No `$` here, so it is unit-tested directly.
import type { Ship, ShipStage, ShipState } from '../types'
import { matches, type Api } from './model'

/** How far back to look for merged MRs, by default (days). */
export const SHIP_DAYS = 1
/** At most this many merged MRs are tracked, the most recently merged. */
export const SHIP_MAX = 3
/** A merged MR whose commit gets no pipeline (e.g. an umbrella repo) is dropped after this. */
export const NO_PIPELINE_GRACE_MS = 10 * 60_000
/** Pages of successful jobs scanned for the latest prod deploy (100 jobs a page). */
export const PROD_JOB_PAGES = 3
export const DEFAULT_PROD_JOBS = 'midas-app=deploy:production, *=2.terraform apply prod'

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** `prodJobs` option: "project=job name, *=job name" › [project pattern, job name]; `*` is the fallback. */
export function parseProdJobs(s: unknown): [string, string][] {
  const text = typeof s === 'string' && s.trim() ? s : DEFAULT_PROD_JOBS
  return text
    .split(',')
    .map(e => e.split('='))
    .filter(p => p.length === 2 && p[0]!.trim() && p[1]!.trim())
    .map(([k, v]) => [k!.trim(), v!.trim()] as [string, string])
}

/** The prod deploy job's name for a project path; undefined when none is configured. */
export function prodJobFor(path: string, rules: readonly [string, string][]): string | undefined {
  return rules.find(([p]) => p !== '*' && matches(path, [p]))?.[1] ?? rules.find(([p]) => p === '*')?.[1]
}

export type Job = { id: number; name: string; stage: string; status: string; allowFailure: boolean; sha?: string; ref?: string; finishedAt?: string }

export function toJob(raw: unknown): Job | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const id = num(o.id)
  const name = str(o.name)
  if (id === undefined || !name) return undefined
  return {
    id,
    name,
    stage: str(o.stage) ?? '',
    status: str(o.status) ?? 'created',
    allowFailure: o.allow_failure === true,
    sha: str((o.commit as Record<string, unknown> | undefined)?.id),
    ref: str(o.ref),
    finishedAt: str(o.finished_at),
  }
}

const WAITING = new Set(['created', 'pending', 'waiting_for_resource', 'preparing', 'scheduled'])

/** One stage's status from its jobs: a hard failure wins, then work in flight, then a manual gate. */
export function stageStatus(jobs: readonly Pick<Job, 'status' | 'allowFailure'>[]): string {
  const s = jobs.map(j => j.status)
  if (jobs.some(j => (j.status === 'failed' && !j.allowFailure) || j.status === 'canceled')) return 'failed'
  if (s.includes('running')) return 'running'
  if (s.some(x => WAITING.has(x))) return 'pending'
  if (s.includes('manual')) return 'manual'
  if (s.length && s.every(x => x === 'skipped')) return 'skipped'
  return 'success'
}

/** A pipeline's stages in run order (by their first job), each with its rolled-up status. */
export function stagesOf(jobs: readonly Job[]): ShipStage[] {
  const by = new Map<string, Job[]>()
  for (const j of [...jobs].sort((a, b) => a.id - b.id)) by.set(j.stage, [...(by.get(j.stage) ?? []), j])
  return [...by].map(([name, js]) => ({ name, status: stageStatus(js) }))
}

/** Where a merged MR stands, from its own pipeline's jobs (prod already carrying it is checked before). */
export function shipState(a: { jobs: readonly Job[]; prodJob: string; ownPipelineId?: number; newestPipelineId?: number }): ShipState {
  const prod = a.jobs.find(j => j.name === a.prodJob)
  const before = stagesOf(prod ? a.jobs.filter(j => j.stage !== prod.stage && j.id < prod.id) : a.jobs)
  const failedBefore = before.some(s => s.status === 'failed')
  const busyBefore = before.some(s => s.status === 'running' || s.status === 'pending')
  if (!prod) return failedBefore ? 'failed' : busyBefore ? 'building' : 'no-deploy'
  switch (prod.status) {
    case 'success':
      return 'live'
    case 'failed':
    case 'canceled':
    case 'skipped':
      return 'failed'
    case 'running':
    case 'pending':
    case 'waiting_for_resource':
    case 'preparing':
      return 'deploying'
    case 'manual':
      if (failedBefore) return 'failed'
      if (busyBefore) return 'building'
      return a.newestPipelineId && a.ownPipelineId && a.newestPipelineId > a.ownPipelineId ? 'stale' : 'waiting'
    default:
      return failedBefore ? 'failed' : 'building'
  }
}

type Merged = Omit<Ship, 'state' | 'stages' | 'prodJob'>

/** Your MRs merged since `since` (ISO), in the watched projects. */
export async function listMerged(api: Api, since: string, projects: readonly string[]): Promise<Merged[]> {
  const res = await api(`merge_requests?scope=created_by_me&state=merged&updated_after=${encodeURIComponent(since)}&per_page=100`)
  if (!Array.isArray(res)) throw new Error('Unexpected GitLab answer for merged merge_requests')
  const out: Merged[] = []
  for (const raw of res) {
    const o = (raw ?? {}) as Record<string, unknown>
    const iid = num(o.iid)
    const projectId = num(o.project_id)
    const full = str((o.references as Record<string, unknown> | undefined)?.full)
    const mergedAt = str(o.merged_at)
    // The commit the merge put at the target branch's head, which is what its pipeline runs on:
    // the merge commit, else the squash commit (fast-forward with squash), else the head itself.
    const sha = str(o.merge_commit_sha) ?? str(o.squash_commit_sha) ?? str(o.sha)
    if (iid === undefined || projectId === undefined || !full || !mergedAt || !sha || Date.parse(mergedAt) < Date.parse(since)) continue
    const project = full.replace(/!\d+$/, '')
    if (!matches(project, projects)) continue
    out.push({
      ref: `${project.split('/').pop()}!${iid}`,
      project,
      projectId,
      iid,
      title: str(o.title) ?? '',
      url: str(o.web_url) ?? '',
      targetBranch: str(o.target_branch) ?? 'main',
      mergedAt,
      sha,
    })
  }
  return out
}

/** The latest successful prod deploy on `branch`: its commit and when it finished. */
export async function latestProd(api: Api, projectId: number, prodJob: string, branch: string) {
  for (let page = 1; page <= PROD_JOB_PAGES; page++) {
    const res = await api(`projects/${projectId}/jobs?scope%5B%5D=success&per_page=100&page=${page}`)
    if (!Array.isArray(res)) return undefined
    const hit = res.map(toJob).find(j => j && j.name === prodJob && j.ref === branch && j.sha)
    if (hit) return { sha: hit.sha!, finishedAt: hit.finishedAt }
    if (res.length < 100) return undefined
  }
  return undefined
}

/** Is `sha` already in `liveSha`'s history? Cached: a commit's ancestry never changes. */
export async function isAncestor(api: Api, projectId: number, sha: string, liveSha: string, cache: Map<string, boolean>) {
  if (sha === liveSha) return true
  const key = `${projectId}:${sha}:${liveSha}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const res = (await api(`projects/${projectId}/repository/merge_base?refs%5B%5D=${sha}&refs%5B%5D=${liveSha}`)) as { id?: unknown } | null
  const yes = str(res?.id) === sha
  cache.set(key, yes)
  return yes
}

type Pipe = { id: number; url?: string; updatedAt?: string }
const toPipe = (raw: unknown): Pipe | undefined => {
  const o = (raw ?? {}) as Record<string, unknown>
  const id = num(o.id)
  return id === undefined ? undefined : { id, url: str(o.web_url), updatedAt: str(o.updated_at) }
}

const when = (iso: string | undefined) => (iso ? Date.parse(iso) || 0 : 0)

/** Most recently updated pipeline first (merge time when there is none yet). */
export function orderShips(ships: readonly Ship[]): Ship[] {
  return [...ships].sort(
    (a, b) => (when(b.pipelineUpdatedAt) || when(b.mergedAt)) - (when(a.pipelineUpdatedAt) || when(a.mergedAt)) || b.iid - a.iid,
  )
}

/** One project's merged MRs: is each live, and if not, where its merge commit's pipeline stands. */
async function projectShips(api: Api, list: readonly Merged[], prodJob: string, at: number, cache: Map<string, boolean>): Promise<Ship[]> {
  const { projectId, targetBranch } = list[0]!
  const live = await latestProd(api, projectId, prodJob, targetBranch).catch(() => undefined)
  const newest = await api(`projects/${projectId}/pipelines?ref=${encodeURIComponent(targetBranch)}&per_page=1`)
    .then(r => (Array.isArray(r) ? toPipe(r[0]) : undefined))
    .catch(() => undefined)
  const out: Ship[] = []
  for (const m of list) {
    const base = { ...m, prodJob, stages: [] as ShipStage[], newestPipelineId: newest?.id, newestPipelineUrl: newest?.url }
    const isLive = !!live && (await isAncestor(api, projectId, m.sha, live.sha, cache).catch(() => false))
    const pipes = await api(`projects/${projectId}/pipelines?sha=${m.sha}&per_page=1`).catch(() => [])
    const own = Array.isArray(pipes) ? toPipe(pipes[0]) : undefined
    if (!own) {
      if (isLive) out.push({ ...base, state: 'live' })
      else if (at - Date.parse(m.mergedAt) <= NO_PIPELINE_GRACE_MS) out.push({ ...base, state: 'no-pipeline' })
      continue
    }
    const raw = await api(`projects/${projectId}/pipelines/${own.id}/jobs?per_page=100`).catch(() => [])
    const jobs = (Array.isArray(raw) ? raw : []).map(toJob).filter((j): j is Job => !!j)
    out.push({
      ...base,
      stages: stagesOf(jobs),
      // A later deploy carries this commit even when its own prod job was never run.
      state: isLive ? 'live' : shipState({ jobs, prodJob, ownPipelineId: own.id, newestPipelineId: newest?.id }),
      pipelineId: own.id,
      pipelineUrl: own.url,
      pipelineUpdatedAt: own.updatedAt,
    })
  }
  return out
}

/**
 * Your `max` most recently merged MRs of the last `days`, live or not, each with its
 * merge commit's pipeline stages and where it stands against its project's prod deploy job.
 * A project that fails to read is left out rather than failing the whole section.
 */
export async function fetchShips(
  api: Api,
  projects: readonly string[],
  rules: readonly [string, string][],
  at: number,
  days = SHIP_DAYS,
  cache = new Map<string, boolean>(),
  max = SHIP_MAX,
): Promise<Ship[]> {
  const merged = (await listMerged(api, new Date(at - days * 86_400_000).toISOString(), projects))
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
    .slice(0, Math.max(0, max))
  const byProject = new Map<number, Merged[]>()
  for (const m of merged) byProject.set(m.projectId, [...(byProject.get(m.projectId) ?? []), m])
  const got = await Promise.all(
    [...byProject.values()].map(list => {
      const prodJob = prodJobFor(list[0]!.project, rules)
      return prodJob ? projectShips(api, list, prodJob, at, cache).catch(() => []) : []
    }),
  )
  return orderShips(got.flat())
}

/** The word, glyph and colour for a ship state. */
export function shipLabel(s: Pick<Ship, 'state' | 'newestPipelineId'>): { text: string; color: string; glyph: string } {
  switch (s.state) {
    case 'live':
      return { text: 'in prod', color: 'green', glyph: '✓' }
    case 'deploying':
      return { text: 'deploying', color: 'yellow', glyph: '◔' }
    case 'waiting':
      return { text: 'ready to deploy', color: 'cyan', glyph: '▸' }
    case 'stale':
      return { text: `deploy #${s.newestPipelineId}`, color: 'cyan', glyph: '▸' }
    case 'building':
      return { text: 'building', color: 'yellow', glyph: '◌' }
    case 'failed':
      return { text: 'failed', color: 'red', glyph: '⊗' }
    case 'no-deploy':
      return { text: 'no deploy job', color: 'gray', glyph: '⊘' }
    case 'no-pipeline':
      return { text: 'no pipeline yet', color: 'gray', glyph: '∙' }
  }
}

/** The page a shipping row opens: the pipeline to act on (the newest one when the MR's own is stale). */
export function shipUrl(s: Ship): string {
  if (s.state === 'stale' && s.newestPipelineUrl) return s.newestPipelineUrl
  return s.pipelineUrl ?? s.url
}

/** State changes worth a line (and a toast) between two reads. */
export function shipChanges(prev: readonly Ship[], next: readonly Ship[], at: number) {
  const before = new Map(prev.map(s => [s.ref, s]))
  const out: { ref: string; title: string; what: string; tone: 'good' | 'bad' | 'info'; at: number }[] = []
  for (const s of next) {
    const p = before.get(s.ref)
    if (!p || p.state === s.state || !['live', 'failed', 'waiting', 'stale', 'deploying'].includes(s.state)) continue
    out.push({ ref: s.ref, title: s.title, what: shipLabel(s).text, tone: s.state === 'live' ? 'good' : s.state === 'failed' ? 'bad' : 'info', at })
  }
  return out
}

/** The shipping list as text for the `mrs` tool. */
export function shipsText(ships: readonly Ship[]): string {
  if (!ships.length) return ''
  const lines = ships.map(s => {
    const track = s.stages.map(st => `${st.name}:${st.status}`).join(' › ')
    return `- ${s.ref} ${s.title} [${shipLabel(s).text}; prod job "${s.prodJob}"${track ? `; ${track}` : ''}] ${shipUrl(s)}`
  })
  return ['Your merged MRs on their way to prod:', ...lines].join('\n')
}
