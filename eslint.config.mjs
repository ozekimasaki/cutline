import { plugin as shadcn } from "@shadcn/lint";
import tsParser from "@typescript-eslint/parser";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    "node_modules/**",
    "dist/**",
    ".output/**",
    ".tanstack/**",
    "engine-rs/**",
    "engine/**",
    "premiere-uxp/**",
    "src-deno/**",
    "src/routeTree.gen.ts",
  ]),
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { shadcn },
    settings: {
      shadcn: {
        ui: "@/components/ui",
        note: "Use shadcn/ui primitives and theme tokens. After UI changes, run npm run lint.",
      },
    },
    rules: {
      "shadcn/no-restyle": [
        "error",
        {
          allow: ["layout"],
          contracts: [
            { pattern: "^Button$", allow: ["layout", "w-*"] },
            { pattern: "^Card$", allow: ["layout"] },
            { pattern: "^CardHeader$", allow: ["layout"] },
            { pattern: "^CardTitle$", allow: ["layout", "typography"] },
            { pattern: "^CardContent$", allow: ["layout"] },
            { pattern: "^Tabs$", allow: ["layout"] },
            { pattern: "^TabsList$", allow: ["layout"] },
            { pattern: "^ScrollArea$", allow: ["layout"] },
            { pattern: "^Progress$", allow: ["layout"] },
            { pattern: "^Separator$", allow: ["layout"] },
          ],
        },
      ],
      "shadcn/no-raw-colors": "error",
      "shadcn/no-arbitrary-values": ["error", { allow: ["layout"] }],
      "shadcn/no-inline-styles": "error",
      "shadcn/require-static-classes": "error",
    },
  },
  {
    files: ["src/components/ui/**"],
    rules: {
      "shadcn/no-restyle": "off",
      "shadcn/no-arbitrary-values": "off",
      "shadcn/require-static-classes": "off",
      "shadcn/no-inline-styles": "off",
    },
  },
]);
