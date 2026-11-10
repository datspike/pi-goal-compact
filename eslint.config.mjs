// Сигналы читаемости. Запуск: npm run lint:style; в npm run verify не входит.
// Пороги отмечают места, где читателю приходится держать в голове слишком много сразу.
// Это повод прочитать код, а не основание механически дробить его.
import tseslint from "typescript-eslint";

export default [
  { ignores: ["node_modules/**", ".runtime/**", ".task_files/**", "formal/**"] },
  {
    files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      complexity: ["warn", { max: 15 }],
      "max-lines": ["warn", { max: 500, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["warn", { max: 100, skipBlankLines: true, skipComments: true, IIFEs: true }],
      "max-depth": ["warn", 4],
      "max-params": ["warn", 5],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": ["warn", { fixStyle: "inline-type-imports" }],
    },
  },
];
