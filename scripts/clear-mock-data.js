import { MongoClient } from 'mongodb'

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/'
const DATABASE_NAME = process.env.MONGO_DATABASE || 'mmo-cr-copilot-backend'

const client = new MongoClient(MONGO_URI)

async function clearData() {
  try {
    await client.connect()
    const db = client.db(DATABASE_NAME)

    const payloadsRes = await db.collection('payloads').deleteMany({})
    const personasRes = await db.collection('persona-mappings').deleteMany({})

    console.log(
      `Cleared ${payloadsRes.deletedCount} payload(s) from 'payloads' collection.`
    )
    console.log(
      `Cleared ${personasRes.deletedCount} mapping(s) from 'persona-mappings' collection.`
    )
    console.log('Database reset to clean state.')
  } catch (error) {
    console.error('Error clearing data:', error)
    process.exitCode = 1
  } finally {
    await client.close()
  }
}

clearData()
