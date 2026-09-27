import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./test/vitest.setup.ts"],
    include: [
      "src/**/*.test.ts",
      "index.test.ts",
      "doctor-contract-api.test.ts",
    ],
  },
})
