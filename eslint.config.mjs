import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["out/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      "no-debugger": "error",
      "no-duplicate-case": "error",
      "no-constant-binary-expression": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
    },
  },
];
