# 协作说明

## 本地运行

```powershell
npm.cmd install
npm.cmd run dev
```

默认地址：

```text
http://127.0.0.1:5173/
```

## 提交前检查

```powershell
npm.cmd run build
```

构建通过后再提交代码。

## 常用修改位置

| 修改内容 | 文件 |
| --- | --- |
| 精灵、技能、Boss 数据 | `src/data.ts` |
| 伤害、回复、Boss 阶段倍率 | `src/formulas.ts` |
| 战斗流程、死亡替换、Boss 行为优先级 | `src/battle.ts` |
| 战斗界面 | `src/ui.ts` |
| 战前选择界面 | `src/prebattle.ts` |
| 当前规则快照 | `docs/当前战斗数据库_v1_10.md` |

## 推荐协作方式

1. 每次改动先新建分支。
2. 规则、数值、UI 文案尽量同步更新文档。
3. 提交前运行 `npm.cmd run build`。
4. 通过 Pull Request 合并到主分支。
