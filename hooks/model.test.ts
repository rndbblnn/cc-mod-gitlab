import { expect, test } from 'claude-code/testing'

import type { MR } from '../types'
import { diff, fetchMRs, fit, legend, matches, mergeLabel, mrsText, parseMRRef, parseProjects, toMR, touchesMRs, type Api } from './model'

const raw = (project: string, iid: number, extra: Record<string, unknown> = {}) => ({
  iid,
  project_id: project.length,
  title: `t ${iid}`,
  references: { full: `grp/${project}!${iid}` },
  detailed_merge_status: 'mergeable',
  has_conflicts: false,
  draft: false,
  user_notes_count: 0,
  source_branch: `b${iid}`,
  target_branch: 'main',
  web_url: `https://gitlab.com/grp/${project}/-/merge_requests/${iid}`,
  updated_at: `2026-11-0${iid % 9}T00:00:00Z`,
  ...extra,
})

const M = (over: Partial<MR> = {}): MR => ({ ...toMR(raw('app', 1))!, ...over })

test('parseProjects splits, trims and dedupes', async () => {
  expect(parseProjects(' midas-backend, midas-app ,midas-app\nmidas-sync ')).toEqual(['midas-backend', 'midas-app', 'midas-sync'])
  expect(parseProjects('')).toEqual([])
  expect(parseProjects(undefined)).toEqual([])
})

test('a bare name matches the last segment; a path matches exactly; none matches all', async () => {
  expect(matches('a/midas/midas-app', ['midas-app'])).toBe(true)
  expect(matches('a/midas/midas-app-v2', ['midas-app'])).toBe(false)
  expect(matches('a/midas/midas-app', ['a/midas/midas-app'])).toBe(true)
  expect(matches('b/midas/midas-app', ['a/midas/midas-app'])).toBe(false)
  expect(matches('x/y', [])).toBe(true)
})

test('toMR reads the REST shape, with the head pipeline when present', async () => {
  const m = toMR(raw('midas-app', 7, { head_pipeline: { status: 'failed' }, reviewers: [{ username: 'ada' }], draft: true }))
  expect(m?.ref).toBe('midas-app!7')
  expect(m?.project).toBe('grp/midas-app')
  expect(m?.pipeline).toBe('failed')
  expect(m?.reviewers).toEqual(['ada'])
  expect(m?.draft).toBe(true)
  expect(toMR({ title: 'nope' })).toBe(undefined)
})

test('fetchMRs filters by project, reads details and orders by the configured list', async () => {
  const calls: string[] = []
  const api: Api = async path => {
    calls.push(path)
    if (path.startsWith('merge_requests?')) return [raw('midas-app', 1), raw('other', 2), raw('midas-backend', 3)]
    const iid = Number(path.split('/').pop())
    return raw(iid === 1 ? 'midas-app' : 'midas-backend', iid, { head_pipeline: { status: 'running' } })
  }
  const got = await fetchMRs(api, ['midas-backend', 'midas-app'])
  expect(got.map(m => m.ref)).toEqual(['midas-backend!3', 'midas-app!1'])
  expect(got.every(m => m.pipeline === 'running')).toBe(true)
  expect(calls.length).toBe(3)
})

test('diff reports pipeline, conflicts, comments and MRs gone', async () => {
  const a = M({ pipeline: 'running' })
  const b = M({ ref: 'app!2', iid: 2 })
  const changes = diff([a, b], [{ ...a, pipeline: 'failed', conflicts: true, notes: 2 }], 5)
  expect(changes.map(c => `${c.ref} ${c.what} ${c.tone}`)).toEqual([
    'app!1 pipeline running › failed bad',
    'app!1 has conflicts bad',
    'app!1 +2 comments info',
    'app!2 merged or closed good',
  ])
  expect(diff([M({ mergeStatus: 'unchecked' })], [M({ mergeStatus: 'not_approved' })], 0)).toEqual([])
})

test('labels, refs, legend and fit', async () => {
  expect(mergeLabel(M({ conflicts: true })).text).toBe('conflicts')
  expect(mergeLabel(M({ mergeStatus: 'not_approved' })).text).toBe('needs approval')
  expect(parseMRRef('https://gitlab.com/g/s/midas-app/-/merge_requests/12')).toBe('midas-app!12')
  expect(parseMRRef('midas-backend!1363')).toBe('midas-backend!1363')
  expect(legend([M({ pipeline: 'failed' }), M({ pipeline: null })]).map(l => l.label)).toEqual(['failed', 'no pipeline'])
  expect(fit('abcdef', 4)).toBe('abc⋯')
  expect(touchesMRs('git push -u origin HEAD')).toBe(true)
  expect(touchesMRs('git status')).toBe(false)
})

test('mrsText lists one line per MR', async () => {
  const t = mrsText([M({ pipeline: 'success', notes: 3 })], ['app'], 0, 1000)
  expect(t).toContain('- app!1 t 1 (b1 › main) [pipeline success; ready; 3 comments')
})
