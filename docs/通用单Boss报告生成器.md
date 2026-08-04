# 通用单 Boss 报告生成器

- 版本：v1.0
- 日期：2026-07-30

## 入口

```powershell
npm.cmd run simulate:boss:generic -- --boss=FORGE_BOSS_WARRIOR
```

需要玩家倾向对照时，使用同一参数启用均衡型、进攻型、防守型三组样本：

```powershell
npm.cmd run simulate:boss:generic -- --boss=FORGE_BOSS_WARRIOR --tendencyRuns=1000
```

三组使用相同阵容Seed和相同战斗规则，仅改变合法行动的评分权重。`playerTendency` 可选值固定为 `balanced`、`offense`、`defense`。

如需精确控制总样本，可分别设置：

```powershell
npm.cmd run simulate:boss:generic -- --boss=FORGE_BOSS_WARRIOR --balancedTendencyRuns=1667 --offenseTendencyRuns=1667 --defenseTendencyRuns=1666
```

复用已有诊断轨迹，不重新模拟：

```powershell
npm.cmd run simulate:boss:generic -- --boss=FORGE_BOSS_WARRIOR --reuseFrom=validation-artifacts/single-boss-v2/forge-post-heat
```

未传入倾向样本参数时不会额外运行倾向对照；如复用目录已经包含三组轨迹，可同时传入 `--tendencyRuns=<每组样本数>`。

## 架构

```text
现有 BattleTelemetry
→ unified-events.mjs 标准化
→ boss-mechanics.json 机制窗口配置
→ generic-engine.mjs 通用统计与归因
→ generic-renderer.mjs 单文件 Markdown 报告
```

旧遥测和旧报告继续兼容。通用报告不读取 Boss 名称，也不按 Boss ID 或技能 ID 分支；这些差异只允许写在 `config/boss-mechanics.json`。

## 统一事件字段

每条事件固定包含：

```text
battleId, seed, round, actionIndex, eventType,
sourceId, targetId, targetPosition, skillId, mechanicId,
value, resourceCost, statusId, phaseId, timestampOrder, metadata
```

TypeScript 契约位于 `src/battleTelemetry.ts` 的 `UnifiedBattleEvent`。旧遥测由 `scripts/boss-report/unified-events.mjs` 转换，并补齐回合、行动结束、技能结算、目标锁定和机制窗口等派生事件。

## Boss 机制配置

```json
{
  "bossId": "BOSS_ID",
  "bossName": "显示名称",
  "mechanics": [
    {
      "mechanicId": "mechanic_id",
      "displayName": "机制名称",
      "type": "telegraph_attack",
      "startEvent": { "eventType": "telegraph_start", "skillIds": ["SKILL_A"] },
      "resolveEvent": { "eventType": "skill_resolve", "skillIds": ["SKILL_B"] },
      "endEvent": { "eventType": "skill_resolve", "skillIds": ["SKILL_B"] },
      "targetScope": "locked_target",
      "responseTags": ["heal_target", "shield_target", "swap_target", "burst_kill"],
      "outcomeMetrics": ["life_damage", "shield_absorb", "kill", "replacement"],
      "postImpactRounds": 3
    }
  ]
}
```

事件选择器支持 `eventType`、`skillIds`、`sourceSide`、`targetSide`、`statusIds`、`phaseIds` 和 `metadataEquals`。

当前响应标签：

```text
attack, high_cost_attack, resource_spend,
heal, shield, heal_target, shield_target,
swap, swap_target, position_change, burst_kill
```

当前结果指标：

```text
life_damage, shield_absorb, kill, replacement,
boss_damage, window_kill, resource_delta, mechanic_prevented
```

新增 Boss 时优先组合现有选择器、响应标签和结果指标。只有统一事件无法表达机制起止、目标或结果时，才扩展通用引擎。

Boss 如需附加固定阵容或 A/B 对照，可以在自身配置中增加：

```json
{
  "customCohorts": [
    {
      "id": "CUSTOM-A",
      "label": "候选A",
      "scope": "main",
      "runs": 300,
      "roster": "fixed",
      "teamId": "TEAM-BALANCED",
      "policy": "balanced-v3",
      "seedOffset": 100
    }
  ]
}
```

运行器会自动执行并纳入同一报告，不需要修改分析器或渲染器。

## 当前边界

- 单场、单 Boss 已通用；多 Boss、跨战斗和跨关卡共享机制尚未纳入同一归因上下文。
- `phase_change`、`status_apply` 和 `status_remove` 已在统一协议中保留，但现有旧遥测没有完整提供时，报告会明确显示“无事件”，不会猜测。
- “核心输出死亡”需要正式精灵职能标签进入事件层；当前只能输出早期减员候选，不作确定归因。
- 处理与忽略仍是观察性关联；需要因果结论时应运行同 Seed 强制策略配对。
