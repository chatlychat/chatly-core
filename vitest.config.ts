import { defineConfig } from 'vitest/config';

const vitestExecution = { pool: 'threads' as const };

export default defineConfig({
  test: {
    ...vitestExecution,
    // NODE, not jsdom. The default environment having no `window` is the
    // first half of the zero-DOM proof; the hook specs opt in to jsdom
    // per-file with a docblock because React's renderer needs a document.
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    exclude: ['**/node_modules/**'],
  },
});
