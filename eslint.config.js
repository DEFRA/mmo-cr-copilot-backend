import neostandard from 'neostandard'

export default [
  ...neostandard({
    env: ['node', 'vitest'],
    ignores: [...neostandard.resolveIgnoresFromGitignore()],
    noJsx: true,
    noStyle: true
  }),
  {
    // Exposed globally by .vite/setup-files.js
    files: ['**/*.test.js'],
    languageOptions: {
      globals: { fetchMock: 'readonly' }
    }
  }
]
