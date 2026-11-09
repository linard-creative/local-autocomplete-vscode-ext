import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', 'node_modules/','.vscode-test/'] },
  tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/ollama.ts'],
    rules: {
      'no-restricted-globals': ['error', { name: 'fetch', message: 'Only src/ollama.ts may make network calls (privacy).' }],
    },
  },
);
