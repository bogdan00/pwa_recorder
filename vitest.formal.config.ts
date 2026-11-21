import { defineConfig } from 'vitest/config';

/**
 * Dedicated Vitest configuration for Tier 2 Formal Verification (Z3 SMT Solver).
 *
 * Uses the Node environment (no jsdom overhead) so Z3's WebAssembly module loads
 * cleanly and proves unbounded ∀-theorems in ~1–3 seconds.
 *
 * Invoked via `npm run test:formal`, `npm run precheck` (.githooks/pre-push),
 * and GitHub Actions CI (.github/workflows/deploy.yml).
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/formal/**/*.formal.test.ts'],
    testTimeout: 30_000,
    // Share a single worker process so Z3 WASM initializes once across all suites
    fileParallelism: false,
  },
});
