import { expect, test } from 'claude-code/testing'

import { fetchShips, orderShips, parseProdJobs, prodJobFor, shipChanges, shipLabel, shipState, shipUrl, stagesOf, type Job } from './ship'
import { SINGLE_CELL, glyph, legend, mergeLabel } from './model'

const AT = Date.parse('2026-11-05T12:00:00Z')
const RULES = parseProdJobs(undefined)

const job = (id: number, stage: string, name: string, status: string, extra: Partial<Job> = {}): Job => ({ id, stage, name, status, allowFailure: false, ...extra })

const merged = (project: string, iid: number, sha: string, mergedAt = '2026-11-04T10:00:00Z') => ({
  iid,
  project_id: project.length,
  title: `t ${iid}`,
  references: { full: `grp/${project}!${iid}` },
  web_url: `https://gitlab.com/grp/${project}/-/merge_requests/${iid}`,
  target_branch: 'main',
  merged_at: mergedAt,
  squash_commit_sha: sha,
})

const rawJob = (j: Job, sha = 'x') => ({ id: j.id, name: j.name, stage: j.stage, status: j.status, allow_failure: j.allowFailure, ref: 'main', commit: { id: sha }, finished_at: '2026-11-05T11:30:00Z' })

test('prodJobs: a named project wins over the * fallback', async () => {
  expect(prodJobFor('grp/midas/midas-app', RULES)).toBe('deploy:production')
  expect(prodJobFor('grp/midas/midas-sync', RULES)).toBe('2.terraform apply prod')
  expect(prodJobFor('x', parseProdJobs('a=b'))).toBe(undefined)
})

test('stages roll up in run order: failure, then in flight, then manual', async () => {
  const jobs = [job(1, 'tag', '1.tag', 'success'), job(2, 'build', '1.jar', 'success'), job(3, 'build', '2.docker', 'running'), job(4, 'deploy prod', 'p', 'manual')]
  expect(stagesOf(jobs)).toEqual([
    { name: 'tag', status: 'success' },
    { name: 'build', status: 'running' },
    { name: 'deploy prod', status: 'manual' },
  ])
  expect(stagesOf([job(1, 's', 'a', 'failed', { allowFailure: true })])).toEqual([{ name: 's', status: 'success' }])
})

test('shipState reads the prod job and the stages before it', async () => {
  const pre = [job(1, 'tag', '1.tag', 'success'), job(2, 'build', '2.docker', 'success')]
  const prod = (status: string) => job(5, 'deploy prod', '2.terraform apply prod', status)
  const st = (jobs: Job[], own = 10, newest = 10) => shipState({ jobs, prodJob: '2.terraform apply prod', ownPipelineId: own, newestPipelineId: newest })
  expect(st([...pre, prod('manual')])).toBe('waiting')
  expect(st([...pre, prod('manual')], 10, 12)).toBe('stale')
  expect(st([job(1, 'tag', '1.tag', 'success'), job(2, 'build', '2.docker', 'running'), prod('created')])).toBe('building')
  expect(st([job(1, 'tag', '1.tag', 'success'), job(2, 'build', '2.docker', 'failed'), prod('manual')])).toBe('failed')
  expect(st([...pre, prod('running')])).toBe('deploying')
  expect(st([...pre, prod('failed')])).toBe('failed')
  expect(st(pre)).toBe('no-deploy')
})

test('fetchShips: live by ancestry, the rest from their own pipeline', async () => {
  const calls: string[] = []
  const appJobs = [job(1, 'tag', 'tag', 'success'), job(2, 'deploy', 'deploy:preview', 'success'), job(3, 'deploy', 'deploy:production', 'manual'), job(4, 'validate', 'validate', 'created')]
  const api = async (path: string): Promise<unknown> => {
    calls.push(path)
    if (path.startsWith('merge_requests?')) return [merged('midas-app', 1, 'old'), merged('midas-app', 2, 'new'), merged('midas-orchestrator', 3, 'orc', '2026-11-01T00:00:00Z'), merged('other', 4, 'o')]
    if (path.includes('/jobs?scope')) return path.startsWith(`projects/${'midas-app'.length}/`) ? [rawJob(job(9, 'deploy', 'deploy:production', 'success'), 'live')] : []
    if (path.includes('/repository/merge_base')) return { id: path.includes('refs%5B%5D=old&') ? 'old' : 'base' }
    if (path.includes('pipelines?ref=')) return [{ id: 20, web_url: 'https://p/20' }]
    if (path.includes('pipelines?sha=new')) return [{ id: 20, web_url: 'https://p/20' }]
    if (path.includes('pipelines?sha=')) return []
    if (path.endsWith('/pipelines/20/jobs?per_page=100')) return appJobs.map(j => rawJob(j))
    throw new Error(`unexpected ${path}`)
  }
  const cache = new Map<string, boolean>()
  const got = await fetchShips(api, ['midas-app', 'midas-orchestrator'], RULES, AT, 7, cache)
  expect(got.map(s => [s.ref, s.state])).toEqual([
    ['midas-app!2', 'waiting'],
    ['midas-app!1', 'live'],
  ])
  expect(got[0]!.stages.map(s => s.status)).toEqual(['success', 'manual', 'pending'])
  expect(shipUrl(got[0]!)).toBe('https://p/20')
  // The orchestrator MR has no pipeline and is past the grace period: dropped. "other" is not watched.
  expect(calls.some(c => c.includes('pipelines?sha=orc'))).toBe(true)
  const before = calls.length
  await fetchShips(api, ['midas-app'], RULES, AT, 7, cache)
  expect(calls.slice(before).filter(c => c.includes('merge_base')).length).toBe(0)
})

test('shipChanges reports reaching prod, failing and becoming deployable', async () => {
  const s = (state: never) => ({ ref: 'a!1', title: 't', state }) as never
  expect(shipChanges([s('building' as never)], [s('waiting' as never)], 1)[0]!.what).toBe('ready to deploy')
  expect(shipChanges([s('deploying' as never)], [s('live' as never)], 1)[0]!.tone).toBe('good')
  expect(shipChanges([s('waiting' as never)], [s('waiting' as never)], 1)).toEqual([])
  expect(shipLabel({ state: 'stale', newestPipelineId: 42 }).text).toBe('deploy #42')
})

test('fetchShips keeps the window and only the most recently merged ones', async () => {
  const list = [
    merged('midas-app', 1, 'a', '2026-11-05T08:00:00Z'),
    merged('midas-app', 2, 'b', '2026-11-05T11:00:00Z'),
    merged('midas-app', 3, 'c', '2026-11-05T10:00:00Z'),
    merged('midas-app', 4, 'd', '2026-11-05T09:00:00Z'),
    merged('midas-app', 5, 'e', '2026-11-04T10:00:00Z'), // older than 24 h
  ]
  const api = async (path: string): Promise<unknown> => {
    if (path.startsWith('merge_requests?')) return list
    if (path.includes('/jobs?scope')) return [rawJob(job(9, 'deploy', 'deploy:production', 'success'), 'a')]
    if (path.includes('/repository/merge_base')) return { id: 'none' }
    return []
  }
  const got = await fetchShips(api, ['midas-app'], RULES, AT, 1)
  expect(got.map(s => s.iid)).toEqual([])
  const live = async (path: string): Promise<unknown> => (path.includes('/repository/merge_base') ? { id: path.match(/refs%5B%5D=(\w+)&/)![1] } : api(path))
  expect((await fetchShips(live, ['midas-app'], RULES, AT, 1)).map(s => s.iid)).toEqual([2, 3, 4])
})

test('orderShips: most recently updated pipeline first, merge time when none', async () => {
  const s = (iid: number, mergedAt: string, pipelineUpdatedAt?: string) => ({ iid, mergedAt, pipelineUpdatedAt }) as never
  const got = orderShips([s(1, '2026-11-05T10:00:00Z', '2026-11-05T10:05:00Z'), s(2, '2026-11-05T11:00:00Z', '2026-11-05T09:00:00Z'), s(3, '2026-11-05T10:30:00Z')])
  expect(got.map((x: { iid: number }) => x.iid)).toEqual([3, 1, 2])
})

test('every glyph the panel draws is single-cell', async () => {
  const narrow = (t: string) => [...t].every(c => c.charCodeAt(0) < 128 || SINGLE_CELL.includes(c))
  const pipes = ['success', 'failed', 'running', 'pending', 'created', 'waiting_for_resource', 'preparing', 'scheduled', 'manual', 'canceled', 'skipped', null, 'weird']
  for (const p of pipes) expect(narrow(glyph(p))).toBe(true)
  for (const l of legend(pipes.map(pipeline => ({ pipeline })))) expect(narrow(l.glyph)).toBe(true)
  const states = ['live', 'deploying', 'waiting', 'stale', 'building', 'failed', 'no-deploy', 'no-pipeline'] as const
  for (const state of states) {
    const l = shipLabel({ state, newestPipelineId: 1 })
    expect(narrow(l.glyph + l.text)).toBe(true)
  }
  expect(narrow(mergeLabel({ mergeStatus: 'conflict', conflicts: true, draft: false }).text)).toBe(true)
})
