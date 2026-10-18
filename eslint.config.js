// ESLint flat config. Formatting is Prettier's job; these rules are about correctness and readability.
// Run: npm run lint   (npm run lint -- --fix applies the auto-fixable ones)
const js = require('@eslint/js');
const globals = require('globals');

const rules = {
  // Catch real bugs
  'no-undef': 'error',
  'no-unused-vars': [
    'error',
    { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
  ],
  'no-unreachable': 'error',
  'no-dupe-keys': 'error',
  'no-self-compare': 'error',
  'no-shadow': 'error',
  'no-unused-expressions': 'error',
  'no-unsafe-finally': 'error',
  // == only for the deliberate `x == null` (null or undefined) check
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  // Modern, explicit declarations
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  'one-var': ['error', 'never'],
  // Readability: always use braces, one statement per line, no comma-chained expressions
  curly: ['error', 'all'],
  'max-statements-per-line': ['error', { max: 1 }],
  'no-sequences': 'error',
  'no-nested-ternary': 'off',
  'no-empty': ['error', { allowEmptyCatch: true }],
};

module.exports = [
  { ignores: ['node_modules/', 'data/', 'screenshots/'] },
  js.configs.recommended,
  {
    // Server, store, bank-link, lib, tests, tooling: Node (CommonJS)
    files: ['**/*.js'],
    ignores: ['public/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules,
  },
  {
    // Front end: plain browser script, no modules, no bundler
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules,
  },
];
