import { BattleGame, type BattleGameOptions } from './battle';
import { battleSystemConfig, resolveSelectedBossConfig, type BattleSystemConfig } from './battleSystems';
import { stageEnemyId } from './stageRuntime';
import type { BattleState, PlayerBattleSnapshot } from './types';
import { BattleUI, type BattleUIOptions } from './ui';

export interface BattleIntegrationResult {
  result: 'victory' | 'defeat';
  state: BattleState;
  playerSnapshot: PlayerBattleSnapshot;
}

export interface MountBattleOptions extends Omit<BattleGameOptions, 'config'> {
  root: HTMLElement;
  config?: BattleSystemConfig;
  resultTitle?: BattleUIOptions['resultTitle'];
  resultButtonLabel?: BattleUIOptions['resultButtonLabel'];
  onBattleEnd?: (result: BattleIntegrationResult) => void;
  onResultAction?: (result: BattleIntegrationResult) => void;
}

export interface MountedBattle {
  game: BattleGame;
  stop: () => void;
  createPlayerSnapshot: () => PlayerBattleSnapshot;
}

export function mountBattle(options: MountBattleOptions): MountedBattle {
  const firstEnemyId = stageEnemyId(options.enemies?.[0]) ?? options.selectedBossId;
  const baseConfig = options.config ?? battleSystemConfig();
  const config = resolveSelectedBossConfig(baseConfig, firstEnemyId);
  const game = new BattleGame({
    selectedSpiritIds: options.selectedSpiritIds,
    selectedBossId: options.selectedBossId,
    playerSnapshot: options.playerSnapshot,
    battleSeed: options.battleSeed,
    monsterLevel: options.monsterLevel,
    monsterStatOverrides: options.monsterStatOverrides,
    enemies: options.enemies,
    telemetry: options.telemetry,
    config
  });
  let reportedResult: BattleIntegrationResult | null = null;
  const resultFor = (state: BattleState): BattleIntegrationResult => ({
    result: state.phase === 'victory' ? 'victory' : 'defeat',
    state,
    playerSnapshot: game.createPlayerSnapshot()
  });
  const unsubscribe = game.subscribe((state) => {
    if (reportedResult || (state.phase !== 'victory' && state.phase !== 'defeat')) return;
    reportedResult = resultFor(state);
    options.onBattleEnd?.(reportedResult);
  });
  const uiOptions: BattleUIOptions = {
    resultTitle: options.resultTitle,
    resultButtonLabel: options.resultButtonLabel
  };
  if (options.onResultAction) {
    uiOptions.onResultAction = (state) => options.onResultAction?.(reportedResult ?? resultFor(state));
  }
  const ui = new BattleUI(options.root, game, config, uiOptions);
  ui.mount();

  return {
    game,
    stop() {
      unsubscribe();
      game.stop();
    },
    createPlayerSnapshot: () => game.createPlayerSnapshot()
  };
}
