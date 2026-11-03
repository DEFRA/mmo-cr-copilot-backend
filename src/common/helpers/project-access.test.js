import {
  PROJECT_ROLES,
  hasRole,
  isDashboardAdmin,
  resolveProjectRole
} from '#/common/helpers/project-access.js'

const project = { slug: 'CRAR' }

describe('#project-access', () => {
  describe('#resolveProjectRole', () => {
    test('Should make a dashboard admin an admin of every project', () => {
      const user = { roles: ['Dashboard.Admin'] }

      expect(resolveProjectRole(user, project)).toBe(
        PROJECT_ROLES.dashboardAdmin
      )
      expect(resolveProjectRole(user, {})).toBe(PROJECT_ROLES.dashboardAdmin)
    })

    test.each([
      ['project-admin', PROJECT_ROLES.admin],
      ['project-user', PROJECT_ROLES.user]
    ])('Should resolve a %s mapping for the project', (mapped, expected) => {
      expect(
        resolveProjectRole({ projectRoles: { CRAR: mapped } }, project)
      ).toBe(expected)
    })

    test.each([
      ['no mappings', {}, project],
      [
        'a mapping for another project',
        { projectRoles: { FES: 'project-admin' } },
        project
      ],
      ['an unknown mapped role', { projectRoles: { CRAR: 'owner' } }, project],
      ['group names alone', { groups: ['CRAR-Admin'] }, project],
      ['no project', { projectRoles: { CRAR: 'project-user' } }, undefined]
    ])('Should deny by default with %s', (_, user, target) => {
      expect(resolveProjectRole(user, target)).toBeNull()
    })

    test('Should not treat the Dashboard.User role as access', () => {
      expect(
        resolveProjectRole({ roles: ['Dashboard.User'] }, project)
      ).toBeNull()
    })
  })

  describe('#hasRole', () => {
    test('Should order the roles', () => {
      expect(hasRole(PROJECT_ROLES.dashboardAdmin, PROJECT_ROLES.admin)).toBe(
        true
      )
      expect(hasRole(PROJECT_ROLES.admin, PROJECT_ROLES.user)).toBe(true)
      expect(hasRole(PROJECT_ROLES.user, PROJECT_ROLES.admin)).toBe(false)
      expect(hasRole(null, PROJECT_ROLES.user)).toBe(false)
    })
  })

  describe('#isDashboardAdmin', () => {
    test('Should only trust the Dashboard.Admin role', () => {
      expect(isDashboardAdmin({ roles: ['Dashboard.Admin'] })).toBe(true)
      expect(isDashboardAdmin({ roles: ['Dashboard.User'] })).toBe(false)
      expect(isDashboardAdmin(null)).toBe(false)
    })
  })
})
