// ESLint: code-quality rules from ESLint and typescript-eslint, plus a few style
// rules (quotes, semicolons). Indentation and whitespace come from .editorconfig.
import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['out/', 'dist/', 'node_modules/', '.vscode-test/', 'temp/', 'plans/', '*.vsix'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { '@stylistic': stylistic },
    languageOptions: {
      globals: { ...globals.node },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
      '@stylistic/semi': ['error', 'always'],
      // Unused parameters are fine when they're named _like_this.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // The build scripts are plain CommonJS run by Node.
    files: ['scripts/**/*.js'],
    languageOptions: { sourceType: 'commonjs' },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
