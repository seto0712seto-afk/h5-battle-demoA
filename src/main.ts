import './styles.css';
import { battleSystemConfig, battleSystemConfigWithBoss } from './battleSystems';
import { BattleGame } from './battle';
import { PreBattleUI, type PreBattleStartPayload } from './prebattle';
import { StageSelectUI } from './stageSelect';
import { stageEnemyId } from './stageRuntime';
import { BattleUI } from './ui';
import type { PlayerBattleSnapshot, StageConfig } from './types';

const root = document.querySelector<HTMLDivElement>('#app');

if (!root) {
  throw new Error('App root not found');
}

let activeGame: { stop: () => void } | null = null;
let currentPreBattlePayload: PreBattleStartPayload | null = null;

function showPreBattle(initialPayload?: PreBattleStartPayload) {
  activeGame?.stop();
  activeGame = null;
  currentPreBattlePayload = initialPayload ?? null;
  const preBattle = new PreBattleUI(root as HTMLElement, battleSystemConfig(), handlePreBattleReady, initialPayload);
  preBattle.mount();
}

function handlePreBattleReady(payload: PreBattleStartPayload) {
  currentPreBattlePayload = payload;
  showStageSelect(payload);
}

function showStageSelect(payload: PreBattleStartPayload) {
  activeGame?.stop();
  activeGame = null;
  currentPreBattlePayload = payload;
  const stageSelect = new StageSelectUI(
    root as HTMLElement,
    battleSystemConfig(),
    payload.selectedSpiritIds,
    (stage) => showStageBattle(payload, stage, 0),
    () => showPreBattle(payload)
  );
  stageSelect.mount();
}

function showStageBattle(payload: PreBattleStartPayload, stage: StageConfig, battleIndex: number, snapshot?: PlayerBattleSnapshot) {
  activeGame?.stop();
  activeGame = null;

  const battle = stage.battles[battleIndex];
  const enemy = battle?.enemies[0];
  const selectedSpiritIds = snapshot?.selectedSpiritIds ?? payload.selectedSpiritIds;
  const selectedBossId = stageEnemyId(enemy) ?? payload.selectedBossId;
  const config = battleSystemConfigWithBoss(selectedBossId);

  const game = new BattleGame({
    selectedSpiritIds,
    selectedBossId,
    config,
    playerSnapshot: snapshot,
    enemies: battle.enemies,
    battleSeed: `${stage.id}:${stage.seed ?? 'fixed'}:${battleIndex + 1}`
  });
  const hasNextBattle = battleIndex < stage.battles.length - 1;
  let transitionStarted = false;
  let transitionTimer: number | null = null;
  let unsubscribe = () => {};

  const startNextBattle = () => {
    if (transitionStarted || !hasNextBattle) return;
    transitionStarted = true;
    const nextSnapshot = game.createPlayerSnapshot();
    unsubscribe();
    game.stop();
    showStageBattle(payload, stage, battleIndex + 1, nextSnapshot);
  };

  const ui = new BattleUI(root as HTMLElement, game, config, {
    resultTitle: (state) => {
      if (state.phase === 'defeat') return '挑战失败';
      if (hasNextBattle) return '本场胜利，准备进入下一场';
      return stage.battles.length > 1 ? '副本通关' : 'Boss 已被击败';
    },
    resultButtonLabel: (state) => {
      if (state.phase === 'defeat') return '返回副本选择';
      return hasNextBattle ? '立即进入下一场' : '返回副本选择';
    },
    onResultAction: (state) => {
      if (state.phase === 'victory' && hasNextBattle) {
        startNextBattle();
        return;
      }
      showStageSelect(currentPreBattlePayload ?? payload);
    }
  });
  ui.mount();

  unsubscribe = game.subscribe((state) => {
    if (state.phase !== 'victory' || !hasNextBattle || transitionStarted) return;
    transitionTimer = window.setTimeout(startNextBattle, 1400);
  });
  activeGame = {
    stop() {
      if (transitionTimer !== null) window.clearTimeout(transitionTimer);
      unsubscribe();
      game.stop();
    }
  };
}

showPreBattle();
