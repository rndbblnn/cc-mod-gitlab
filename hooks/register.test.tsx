import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'gitlab-panel',
  component: 'Pane',
  requestId: 'gitlab',
  surface: 'terminal',
  props: { title: 'GitLab MRs', isFocused: true, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const mr = (project: string, iid: number, extra: Record<string, unknown> = {}) => ({
  iid,
  project_id: 10 + iid,
  title: `Title ${iid}`,
  references: { full: `grp/${project}!${iid}` },
  detailed_merge_status: 'mergeable',
  has_conflicts: false,
  draft: false,
  user_notes_count: 0,
  source_branch: `feat-${iid}`,
  target_branch: 'main',
  web_url: `https://gitlab.com/grp/${project}/-/merge_requests/${iid}`,
  ...extra,
})

const run = (v: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(v), stderr: '' } })

function engine(on: any, argvs: string[][], pipeline = { status: 'success' }) {
  on('command.register', () => ({ value: { command: 'gitlab' } }))
  on('tool.register', (_: unknown, e: { name: string }) => ({ value: { tool: `mcp__gitlab-panel__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    argvs.push(e.argv)
    const path = e.argv[e.argv.length - 1]!
    if (path.startsWith('merge_requests?')) return run([mr('midas-app', 1), mr('other', 2), mr('midas-backend', 3)])
    if (path.endsWith('/notes')) return run({ id: 99 })
    const iid = Number(path.split('/').pop())
    return run(mr(iid === 1 ? 'midas-app' : 'midas-backend', iid, { head_pipeline: iid === 1 ? pipeline : { status: 'failed' } }))
  })
}

test('lists only the watched projects, in order, and comments through glab', { options: { projects: 'midas-backend, midas-app' } }, async ($, on) => {
  const argvs: string[][] = []
  engine(on, argvs)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const res = await $.command.run({ command: 'gitlab', args: 'refresh' } as never)
  expect((res as { text: string }).text).toBe('2 open MRs.')
  expect(argvs[0]!.slice(0, 4)).toEqual(['glab', 'api', '--hostname', 'gitlab.com'])

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /1 failing/ })).toBeTruthy()
  expect(await ui.find({ key: 'row-midas-app!1' })).toBeTruthy()
  expect(await ui.find({ key: 'row-other!2' })).toBeFalsy()
  await ui.press({ key: 'row-midas-backend!3' })
  expect(await ui.find({ type: 'Text', text: /pipeline failed/ })).toBeTruthy()
  await ui.press({ key: 'comment-btn' })
  await ui.input({ key: 'comment', text: 'looks good' })
  const post = argvs.find(a => a[a.length - 1]!.endsWith('/notes'))
  expect(post).toEqual(['glab', 'api', '--hostname', 'gitlab.com', '-X', 'POST', '-f', 'body=looks good', 'projects/13/merge_requests/3/notes'])
  await ui.unmount()
})

test('the mrs tool answers with the list, and the prompt names the projects', { options: { projects: 'midas-app' } }, async ($, on) => {
  engine(on, [])
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: 'mcp__gitlab-panel__mrs', refresh: true } as never)
  expect(JSON.stringify(r)).toContain('- midas-app!1 Title 1 (feat-1 → main) [pipeline success; ready')
  expect(JSON.stringify(r)).not.toContain('midas-backend')
  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)
  expect(composed.sections.find(s => s.id === 'gitlab-panel:mrs')?.text).toContain('in midas-app')
})
