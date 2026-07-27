import type { BattleSystemConfig } from './battleSystems';
import type { BossId, StageEnemyConfig } from './types';

export function stageEnemyId(enemy?: StageEnemyConfig): BossId | undefined {
  if (!enemy) return undefined;
  return typeof enemy === 'string' ? enemy : enemy.enemyId;
}

export function applyStageEnemyOverrides(config: BattleSystemConfig, enemy?: StageEnemyConfig): BattleSystemConfig {
  if (!enemy || typeof enemy === 'string' || !enemy.overrides) return config;
  return {
    ...config,
    bossConfig: {
      ...config.bossConfig,
      ...enemy.overrides
    }
  };
}
