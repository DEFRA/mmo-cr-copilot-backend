export const DASHBOARD_ADMIN_GROUP = 'AG-Users-CopilotAnalytics-Dashboard-Admin'
export const PROJECT_ADMIN_GROUP = 'AG-Test-Project-Admin'
export const PROJECT_USER_GROUP = 'AG-Test-Project-User'

export const ADMIN = {
  oid: 'admin-1',
  name: 'Admin User',
  groups: [DASHBOARD_ADMIN_GROUP]
}

export const PROJECT_ADMIN = {
  oid: 'project-admin-1',
  name: 'Project Admin',
  groups: [PROJECT_ADMIN_GROUP]
}

export const PROJECT_USER = {
  oid: 'project-user-1',
  name: 'Project User',
  groups: [PROJECT_USER_GROUP]
}

export const OUTSIDER = {
  oid: 'outsider-1',
  name: 'Outsider',
  groups: ['AG-Somewhere-Else']
}

export const devToken = (claims) =>
  `dev-mock.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`

/** Authorization header for a caller; needs AUTH_DEV_BYPASS (set for tests). */
export const asUser = (user) => ({
  authorization: `Bearer ${devToken(user)}`
})

/**
 * Maps the shared test groups for one project: PROJECT_ADMIN_GROUP as project
 * admin and PROJECT_USER_GROUP as project user. The dashboard admin group is
 * mapped too, so ADMIN works even after a test cleared role_mappings.
 */
export async function grantAccess(db, slug) {
  const collection = db.collection('role_mappings')
  const now = new Date()
  const upsert = (groupName, role, scope, projectSlug) =>
    collection.updateOne(
      { groupName, projectSlug },
      {
        $set: { role, scope, updatedAt: now },
        $setOnInsert: { groupName, projectSlug, createdAt: now }
      },
      { upsert: true }
    )
  await upsert(DASHBOARD_ADMIN_GROUP, 'Dashboard.Admin', 'global', null)
  if (slug) {
    await upsert(PROJECT_ADMIN_GROUP, 'project-admin', 'project', slug)
    await upsert(PROJECT_USER_GROUP, 'project-user', 'project', slug)
  }
  // Imported lazily: config must not load before vitest-mongodb sets MONGO_URI.
  const { invalidateRoleCache } = await import('#/services/role-mappings.js')
  invalidateRoleCache()
}
