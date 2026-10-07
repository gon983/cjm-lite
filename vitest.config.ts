import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          SESSION_SECRET: "test-only-secret-with-at-least-32-characters",
          BOOTSTRAP_SECRET: "test-only-bootstrap",
          APP_ENV: "development",
          APP_URL: "http://localhost:8787",
          SESSION_TTL: "43200",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./tests/setup.ts"],
    fileParallelism: false,
    testTimeout: 20000,
  },
});
