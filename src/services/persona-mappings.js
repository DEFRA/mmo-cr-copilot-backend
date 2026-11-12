export const PERSONA_MAPPINGS_COLLECTION = 'persona-mappings'

const keyFor = (projectSlug, githubHandle) =>
  `${projectSlug}:${githubHandle.toLowerCase()}`

function toEntry(doc) {
  return {
    githubHandle: doc.githubHandle,
    persona: doc.persona,
    updatedAt: doc.updatedAt.toISOString()
  }
}

/** A project's own handle → persona mappings, alphabetical by handle; there are no cross-project defaults. */
export async function listPersonaMappings(db, projectSlug) {
  const docs = await db
    .collection(PERSONA_MAPPINGS_COLLECTION)
    .find({ projectSlug })
    .toArray()

  return docs
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
    updatedAt: updatedAt.toISOString()
  }
}

/** Removes a handle's mapping from one project. Returns true when one was deleted. */
export async function deletePersonaMapping(db, projectSlug, githubHandle) {
  const { deletedCount } = await db
    .collection(PERSONA_MAPPINGS_COLLECTION)
    .deleteOne({ _id: keyFor(projectSlug, githubHandle) })

  return deletedCount > 0
}
