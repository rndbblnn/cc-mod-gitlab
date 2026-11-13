/** One open merge request as the panel tracks it. */
export type MR = {
  /** Short reference, e.g. "midas-backend!1363". */
  ref: string
  /** Full project path, e.g. "group/sub/midas-backend". */
  project: string
  projectId: number
  iid: number
  title: string
  draft: boolean
  /** GitLab's detailed_merge_status: mergeable | conflict | not_approved | ci_still_running | ... */
  mergeStatus: string
  conflicts: boolean
  /** Head pipeline status (success | failed | running | pending | canceled | manual | ...); null when none. */
  pipeline: string | null
  /** User (non-system) comment count. */
  notes: number
  sourceBranch: string
  targetBranch: string
  url: string
  reviewers: string[]
  createdAt?: string
  updatedAt?: string
}

/** Something the panel noticed between two reads. */
export type Change = {
  ref: string
  title: string
  /** e.g. "pipeline running → failed", "no longer open". */
  what: string
  /** Colour hint: good | bad | info. */
  tone: 'good' | 'bad' | 'info'
  at: number
}

/** One stage of a merge commit's pipeline, its jobs rolled up. */
export type ShipStage = { name: string; status: string }

/** Where a merged MR stands on its way to prod. */
export type ShipState = 'live' | 'deploying' | 'waiting' | 'stale' | 'building' | 'failed' | 'no-deploy' | 'no-pipeline'

/** One of your merged MRs on its way to prod. */
export type Ship = {
  ref: string
  project: string
  projectId: number
  iid: number
  title: string
  url: string
  targetBranch: string
  mergedAt: string
  /** The commit the merge put on the target branch. */
  sha: string
  /** The project's prod deploy job name (from the `prodJobs` option). */
  prodJob: string
  /** The merge commit's pipeline stages, in order; empty once live. */
  stages: ShipStage[]
  state: ShipState
  pipelineId?: number
  pipelineUrl?: string
  /** When the merge commit's pipeline last changed: the list is ordered on it. */
  pipelineUpdatedAt?: string
  /** The newest pipeline on the target branch: the one to deploy from when this MR's own is stale. */
  newestPipelineId?: number
  newestPipelineUrl?: string
}

declare module 'claude-code' {
  interface PluginState {
    'gitlab-panel': {
      /** Your open MRs in the watched projects, as last read. */
      mrs: Shaped<MR[]>
      loading: Shaped<boolean>
      error: Shaped<string | null>
      /** Epoch ms of the last full read; 0 before the first. */
      refreshedAt: Shaped<number>
      /** The MR whose detail view is open (its ref); null shows the list. */
      selected: Shaped<string | null>
      /** 'comment' while the comment box is open. */
      mode: Shaped<'none' | 'comment'>
      changes: Shaped<Change[]>
      /** Clock for "refreshed 30s ago". */
      now: Shaped<number>
      /** Set once the session's start-up open has run, so a hot reload does not reopen a pane the person closed. */
      startOpened: Shaped<boolean>
      /** Your merged MRs not in prod yet, as last read. */
      ships: Shaped<Ship[]>
    }
  }
}
