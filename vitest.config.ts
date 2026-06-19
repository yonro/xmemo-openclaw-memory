import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "index.test.ts",
      "doctor-contract-api.test.ts",
    ],
  },
})
