import { MongoClient } from 'mongodb'

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/'
const DATABASE_NAME = process.env.MONGO_DATABASE || 'mmo-cr-copilot-backend'

const client = new MongoClient(MONGO_URI)

async function clearData() {
  try {
    await client.connect()
    const db = client.db(DATABASE_NAME)

    const collections = [
      'payloads',
      'persona-mappings',
      'projects',
      'repositories',
      'jira-issues',
      'pr-jira-links',
      'jira-sprint-scope',
      'sonar-snapshots',
      'sonar-pr-snapshots',
      'audit-logs'
    ]

    await Promise.all(
      collections.map(async (name) => {
        const res = await db.collection(name).deleteMany({})
        console.log(`Cleared ${res.deletedCount} document(s) from '${name}'.`)
      })
    )

    console.log('Database reset to clean state.')
  } catch (error) {
    console.error('Error clearing data:', error)
    process.exitCode = 1
  } finally {
    await client.close()
  }
}

await clearData()
