import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    // These are pure-function tests over hashes and signatures — no DOM, no component rendering.
    // The default jsdom-ish setup would load a browser environment none of them use.
    environment: "node",
    include: ["lib/__tests__/**/*.test.ts"],

    // A single forked process rather than a worker pool.
    //
    // Vitest defaults to one worker per core with a thread-pool RPC between them. On a
    // memory-constrained machine that pool is the bottleneck: workers get starved and the RPC
    // times out with "Timeout calling fetch", which looks like a test failure but is really the
    // runner failing to start. One fork is slower in the best case and reliable in the worst,
    // which is the right trade for a suite this small.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },

    // The default 5s assumes a warm, unconstrained machine. Signature recovery is not slow, but
    // module transform on a cold cache can be.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
});
