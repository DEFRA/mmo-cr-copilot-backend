// Jira workflow stage definitions and the status-name baseline (ADR 0011).

export const WORKFLOW_STAGES = [
  { id: 'todo', label: 'To Do', kind: 'todo', required: true },
  { id: 'in-progress', label: 'In Progress', kind: 'active', required: false },
  {
    id: 'ready-for-review',
    label: 'Ready for Review',
    kind: 'waiting',
    required: false
  },
  { id: 'in-review', label: 'In Review', kind: 'active', required: false },
  {
    id: 'ready-for-test',
    label: 'Ready for Test',
    kind: 'waiting',
    required: false
  },
  { id: 'in-test', label: 'In Test', kind: 'active', required: false },
  {
    id: 'ready-for-release',
    label: 'Ready for Release',
    kind: 'waiting',
    required: false
  },
  {
    id: 'blocked',
    label: 'Blocked or On Hold',
    kind: 'waiting',
    required: false
  },
  { id: 'done', label: 'Done', kind: 'done', required: true },
  { id: 'cancelled', label: 'Cancelled', kind: 'excluded', required: false }
]

export const STAGE_IDS = WORKFLOW_STAGES.map((s) => s.id)
export const MAX_STATUS_LENGTH = 60
export const MAX_STATUSES_PER_STAGE = 40
export const MAX_STATUSES_TOTAL = 150
export const MAX_DETECTED_STATUSES = 500

// Atlassian defaults plus common naming; see ADR 0011 for sources.
export const STATUS_BASELINE = {
  todo: [
    'To Do',
    'Backlog',
    'Open',
    'New',
    'Selected for Development',
    'Ready for Development',
    'Ready for Dev',
    'Ready',
    'Refined',
    'Refinement',
    'Triage',
    'Requested',
    'Planned',
    'Reopened'
  ],
  'in-progress': [
    'In Progress',
    'In Dev',
    'In Development',
    'Development',
    'Dev',
    'Doing',
    'Started',
    'Work in Progress',
    'WIP',
    'Implementing',
    'Building',
    'Coding',
    'Fixing'
  ],
  'ready-for-review': [
    'Ready for Review',
    'Awaiting Review',
    'Waiting for Review',
    'Ready for Code Review',
    'Review Ready'
  ],
  'in-review': [
    'In Review',
    'Under Review',
    'Code Review',
    'Peer Review',
    'Review',
    'PR Review',
    'In Code Review',
    'Second Review'
  ],
  'ready-for-test': [
    'Ready for Test',
    'Ready to Test',
    'Ready for Testing',
    'Ready for QA',
    'QA Ready',
    'Awaiting QA',
    'Awaiting Test',
    'Waiting for QA',
    'Dev Complete',
    'Dev Done'
  ],
  'in-test': [
    'In Test',
    'Testing',
    'In Testing',
    'In QA',
    'QA',
    'Under Test',
    'Verification',
    'Verifying',
    'UAT',
    'In UAT',
    'User Acceptance Testing',
    'Acceptance Testing',
    'System Test',
    'SIT'
  ],
  'ready-for-release': [
    'Ready for Release',
    'Awaiting Release',
    'Ready to Release',
    'Ready for Deployment',
    'Ready to Deploy',
    'Awaiting Deployment',
    'Ready for Production',
    'Ready for Prod',
    'Staged'
  ],
  blocked: [
    'Blocked',
    'On Hold',
    'Waiting',
    'Pending',
    'Paused',
    'Parked',
    'Impeded',
    'Waiting for Info',
    'Awaiting Info',
    'Waiting for Customer',
    'Waiting for Support',
    'Waiting for Approval',
    'Awaiting Approval',
    'Awaiting CAB Approval'
  ],
  done: [
    'Done',
    'Completed',
    'Complete',
    'Closed',
    'Resolved',
    'Released',
    'Deployed',
    'Delivered',
    'Live',
    'In Production',
    'Accepted',
    'Approved',
    'Finished',
    'Shipped',
    'Published'
  ],
  cancelled: [
    'Cancelled',
    'Canceled',
    'Rejected',
    "Won't Do",
    "Won't Fix",
    'Duplicate',
    'Declined',
    'Abandoned',
    'Obsolete',
    'Invalid',
    'Cannot Reproduce'
  ]
}
