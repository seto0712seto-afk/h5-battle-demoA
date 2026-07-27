# 怪物配置维护

当前怪物源表为 `monster-config-v0.7.xlsx`，运行时读取生成后的 `src/monsterData.generated.ts`。

修改 Excel 后，在项目根目录执行：

```powershell
npm install
npm run import:monsters
```

注意：

- `怪物批量配置` 每只怪物固定占 16 行。
- 技能权重属于怪物自身配置，不属于公共技能。
- `src/monsterData.generated.ts` 是生成文件，不应手动编辑。
- 预告、强制首动、强制后继和状态效果使用结构化配置执行，不解析技能描述。
- 当前特殊技能的结构化补充规则集中在 `scripts/import-monsters.mjs` 的 `executionOverrides` 与 `selectionMode`。
