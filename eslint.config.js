import neostandard from 'neostandard'

export default [
  ...neostandard({
    env: ['node', 'vitest'],
    ignores: [...neostandard.resolveIgnoresFromGitignore()],
    noJsx: true,
    noStyle: true
  }),
  {
    // SonarCloud S121 (DEFRA profile): every if/else/loop body has braces.
    // S9383 wants deliberately un-awaited promises marked with `void`.
    rules: {
      curly: ['error', 'all'],
      'no-void': ['error', { allowAsStatement: true }]
    }
  },
  {
    // Exposed globally by .vite/setup-files.js
    files: ['**/*.test.js'],
    languageOptions: {
      globals: { fetchMock: 'readonly' }
    }
  }
]
