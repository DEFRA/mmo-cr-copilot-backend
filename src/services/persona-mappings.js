export const PERSONA_MAPPINGS_COLLECTION = 'persona-mappings'

function toEntry(doc) {
  return {
    githubHandle: doc.githubHandle,
    persona: doc.persona,
    updatedAt: doc.updatedAt.toISOString()
  }
}

/** Every configured GitHub handle → persona mapping, alphabetical by handle. */
export async function listPersonaMappings(db) {
  const docs = await db
    .collection(PERSONA_MAPPINGS_COLLECTION)
    .find({})
    .sort({ githubHandle: 1 })
    .toArray()

  return docs.map(toEntry)
}

/**
 * Creates or replaces the persona assigned to a GitHub handle. Keyed on the
 * lower-cased handle so the mapping is case-insensitive, while the
 * originally-entered casing is kept for display.
 */
export async function upsertPersonaMapping(db, githubHandle, persona) {
  const updatedAt = new Date()

  await db
    .collection(PERSONA_MAPPINGS_COLLECTION)
    .updateOne(
      { _id: githubHandle.toLowerCase() },
      { $set: { githubHandle, persona, updatedAt } },
      { upsert: true }
    )

  return { githubHandle, persona, updatedAt: updatedAt.toISOString() }
}

/** Removes a GitHub handle's mapping. Returns true when one was deleted. */
export async function deletePersonaMapping(db, githubHandle) {
  const { deletedCount } = await db
    .collection(PERSONA_MAPPINGS_COLLECTION)
    .deleteOne({ _id: githubHandle.toLowerCase() })

  return deletedCount > 0
}
