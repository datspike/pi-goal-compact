/**
 * Границы слоёв pi-goal-compact. Запуск: npm run lint:arch; входит в npm run verify.
 * Списка известных нарушений нет и заводить его нельзя: нарушение исправляется,
 * а намеренная смена границы оформляется решением в docs/adr/.
 *
 * Правила слоёв добавляются вместе с решением об архитектуре; здесь то, что верно при любом устройстве.
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Модуль внутри цикла нельзя понять и изменить отдельно от остальных.",
      from: {},
      to: { circular: true },
    },
    {
      name: "src-not-to-tests-or-scripts",
      severity: "error",
      comment: "Поставляемый код не импортирует тесты и служебные скрипты.",
      from: { path: "^src/" },
      to: { path: "^(test|scripts)/" },
    },
    {
      name: "only-index-is-composition-root",
      severity: "error",
      comment: "src/index.ts собирает расширение; остальной код его не импортирует.",
      from: { pathNot: "^src/index\\.ts$" },
      to: { path: "^src/index\\.ts$" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".mts", ".js", ".mjs", ".json"],
    },
  },
};
