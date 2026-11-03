export const PERSONA_MAPPINGS_COLLECTION = 'persona-mappings'

const keyFor = (projectSlug, githubHandle) =>
  `${projectSlug}:${githubHandle.toLowerCase()}`

function toEntry(doc) {
  return {
    githubHandle: doc.githubHandle,
    persona: doc.persona,
    updatedAt: doc.updatedAt.toISOString(),
    scope: doc.projectSlug ? 'project' : 'default'
  }
}

/**
 * A project's handle → persona mappings, alphabetical by handle. Rows saved
 * before mappings were scoped have no project; they act as read-only defaults
 * that a project's own row for the same handle overrides.
 */
export async function listPersonaMappings(db, projectSlug) {
  const docs = await db
    .collection(PERSONA_MAPPINGS_COLLECTION)
    .find({
      $or: [
        { projectSlug },
        { projectSlug: null },
        { projectSlug: { $exists: false } }
      ]
    })
    .toArray()

  const byHandle = new Map()
  for (const doc of docs.filter((d) => !d.projectSlug)) {
    byHandle.set(doc.githubHandle.toLowerCase(), doc)
  }
  for (const doc of docs.filter((d) => d.projectSlug)) {
    byHandle.set(doc.githubHandle.toLowerCase(), doc)
  }

  return [...byHandle.values()]
    .sort((a, b) => a.githubHandle.localeCompare(b.githubHandle))
    .map(toEntry)
}

/** One handle's project-scoped mapping, or null; used for the audit before-state. */
export async function findPersonaMapping(db, projectSlug, githubHandle) {
  const doc = await db
    .collection(PERSONA_MAPPINGS_COLLECTION)
    .findOne({ _id: keyFor(projectSlug, githubHandle) })

  return doc ? toEntry(doc) : null
}

/** Creates or replaces a handle's persona within one project, case-insensitively. */
export async function upsertPersonaMapping(
  db,
  projectSlug,
  githubHandle,
  persona
) {
  const updatedAt = new Date()

  await db
    .collection(PERSONA_MAPPINGS_COLLECTION)
    .updateOne(
      { _id: keyFor(projectSlug, githubHandle) },
      { $set: { projectSlug, githubHandle, persona, updatedAt } },
      { upsert: true }
    )

  return {
    githubHandle,
    persona,
    updatedAt: updatedAt.toISOString(),
    scope: 'project'
  }
}

/** Removes a handle's mapping from one project. Returns true when one was deleted. */
export async function deletePersonaMapping(db, projectSlug, githubHandle) {
  const { deletedCount } = await db
    .collection(PERSONA_MAPPINGS_COLLECTION)
    .deleteOne({ _id: keyFor(projectSlug, githubHandle) })

  return deletedCount > 0
}
