import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    clearMocks: true,
    fileParallelism: false,
    // Fail closed: a module that reads config before vitest-mongodb sets
    // MONGO_URI gets an unreachable host and a test-only database, never the
    // local development database.
    env: {
      MONGO_URI: 'mongodb://127.0.0.1:1/',
      MONGO_DATABASE: 'mmo-cr-copilot-backend-test',
      AUTH_DEV_BYPASS: 'true'
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.js'],
      exclude: [...configDefaults.exclude, 'coverage']
    },
    setupFiles: ['.vite/mongo-memory-server.js', '.vite/setup-files.js']
  }
})
