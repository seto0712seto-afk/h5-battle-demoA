
import { BattleGame } from './battle';
import type { BattleSystemConfig } from './battleSystems';
import {
  formatMultiplier,
  formatPercent,
  hpPercent
} from './formulas';
import { skillDescriptionWithStatusDetails, statusDescription } from './skillPresentation';
import type { BattleFxEvent, BattleState, Row, RuntimeSpirit, SkillData } from './types';

const PLAYER_POSITIONS: Array<{ label: string; slotIndex: number; row: Row }> = [
  { label: '2', slotIndex: 0, row: 'back' },
  { label: '1', slotIndex: 0, row: 'front' },
  { label: '4', slotIndex: 1, row: 'back' },
  { label: '3', slotIndex: 1, row: 'front' },
  { label: '6', slotIndex: 2, row: 'back' },
  { label: '5', slotIndex: 2, row: 'front' }
];

const ENEMY_POSITIONS: Array<{
  label: string;
  row: Row;
  slotPosition: 'front' | 'back_1' | 'back_2' | null;
}> = [
  { label: '1', row: 'front', slotPosition: null },
  { label: '2', row: 'back', slotPosition: 'back_1' },
  { label: '3', row: 'front', slotPosition: 'front' },
  { label: '4', row: 'back', slotPosition: null },
  { label: '5', row: 'front', slotPosition: null },
  { label: '6', row: 'back', slotPosition: 'back_2' }
];

interface BattleUIOptions {
  resultTitle?: (state: BattleState) => string;
  resultButtonLabel?: (state: BattleState) => string;
  onResultAction?: (state: BattleState) => void;
}

export class BattleUI {
  private notice = '';
  private flashingHit: { spiritIds: string[]; serial: number } | null = null;
  private seenHitSerial = 0;
  private seenFxSerial = 0;
  private selectedEnemyId: string | null = null;
  private hasRenderedBattleFrame = false;
  private forceNextRender = false;

  constructor(private root: HTMLElement, private game: BattleGame, private config: BattleSystemConfig, private options: BattleUIOptions = {}) {}

  mount() {
    this.game.subscribe((state) => this.render(state));
    this.game.start();
  }

  private render(state: BattleState) {
    this.syncHitFeedback(state);
    if (this.hasRenderedBattleFrame && !this.forceNextRender && state.phase === 'running') {
      this.flashingHit?.spiritIds.forEach((id) => this.addTransientClass(this.spiritCell(id), 'is-hit', 520));
      this.syncEnemyTelegraphIndicators(state);
      this.syncPlayerTelegraphIndicators(state);
      this.syncBattleFx(state);
      return;
    }
    this.forceNextRender = false;
    this.root.innerHTML = '';
    document.body.classList.toggle('has-enemy-detail', Boolean(this.selectedEnemyId && state.phase !== 'victory' && state.phase !== 'defeat'));

    const shell = element('main', 'shell');
    shell.append(this.renderHeader(state));

    const stage = element('section', 'battle-stage');
    stage.append(this.renderRoundOrder(state));
    stage.append(this.renderPlayerModule(state));
    stage.append(this.renderEnemyModule(state));
    stage.append(this.renderNeutralModule(state));
    shell.append(stage);

    shell.append(this.renderBenchArea(state));
    shell.append(this.renderOperationArea(state));
    if (this.selectedEnemyId && state.phase !== 'victory' && state.phase !== 'defeat') {
      const detail = this.renderEnemyDetail(state, this.selectedEnemyId);
      if (detail) shell.append(detail);
    }
    if (state.phase === 'victory' || state.phase === 'defeat') {
      shell.append(this.renderResult(state));
    }

    this.root.append(shell);
    this.hasRenderedBattleFrame = true;
    this.syncBattleFx(state);
  }

  private renderImmediately(state: BattleState = this.game.state) {
    this.forceNextRender = true;
    this.render(state);
  }

  private resetBattleView() {
    this.notice = '';
    this.selectedEnemyId = null;
    this.flashingHit = null;
    this.seenHitSerial = 0;
    this.seenFxSerial = 0;
    this.forceNextRender = true;
  }

  private renderHeader(state: BattleState) {
    const header = element('header', 'topbar');
    const title = element('div', 'title-block');
    title.append(textEl('span', 'eyebrow', 'PVE Boss 战'));
    title.append(textEl('h1', '', 'H5 Demo 核心战斗验证版'));

    const status = element('div', 'top-status');
    status.append(this.statPill('回合', String(state.round.index)));

    const reset = button('重新开始', 'ghost-button', () => {
      this.resetBattleView();
      this.game.reset();
      this.game.start();
    });

    header.append(title, status, reset);
    return header;
  }

  private renderPlayerModule(state: BattleState) {
    const module = element('section', 'module-panel player-module');
    module.append(this.moduleHead('玩家区域'));

    const board = element('div', 'formation-board player-board');
    PLAYER_POSITIONS.forEach((position) => {
      board.append(this.renderPlayerPosition(state, position));
    });
    module.append(board);
    return module;
  }

  private renderBenchArea(state: BattleState) {
    const area = element('section', 'bench-area');
    area.append(textEl('strong', 'bench-label', '后备精灵'));
    const list = element('div', 'bench-strip');
    const fieldIds = new Set(state.slots.map((slot) => slot.spiritId).filter(Boolean));
    const benchIds = this.config.creatureConfig
      .filter((spirit) => state.selectedSpiritIds.includes(spirit.id) && !fieldIds.has(spirit.id))
      .map((spirit) => spirit.id);
    if (benchIds.length === 0) {
      list.append(textEl('span', 'muted', '当前没有后备精灵'));
    } else {
      benchIds.forEach((spiritId) => list.append(this.renderBenchPill(state, spiritId)));
    }
    area.append(list);
    return area;
  }

  private renderPlayerPosition(state: BattleState, position: { label: string; slotIndex: number; row: Row }) {
    const slot = state.slots[position.slotIndex];
    const cell = element('article', `position-cell ${position.row}`);
    cell.dataset.slotIndex = String(position.slotIndex);
    cell.dataset.row = position.row;
    cell.append(textEl('span', 'position-label', position.label));
    const spiritHere = slot?.row === position.row ? slot.spiritId ?? undefined : undefined;
    const threats = this.game.playerTelegraphThreats(position.slotIndex, position.row, spiritHere);
    if (threats.length > 0) {
      cell.classList.add('has-lock-warning');
      cell.append(this.createPlayerLockWarning(threats));
    }

    const hasSpiritHere = slot?.spiritId && slot.row === position.row;
    if (!hasSpiritHere || !slot?.spiritId) {
      cell.append(textEl('span', 'empty-mark', ''));
      return cell;
    }

    const runtime = state.spirits[slot.spiritId];
    const data = this.spiritData(slot.spiritId);
    cell.dataset.spiritId = slot.spiritId;
    cell.style.setProperty('--accent', data.accent);
    cell.classList.add('occupied');
    if (state.activeUnit?.type === 'spirit' && state.activeUnit.id === slot.spiritId) {
      cell.classList.add('is-active');
    }
    if (runtime.hp <= 0) {
      cell.classList.add('is-dead');
    }
    if (this.flashingHit?.spiritIds.includes(slot.spiritId)) {
      cell.classList.add('is-hit');
    }

    const pendingSkill = state.pendingSkillId ? this.config.skillConfig[state.pendingSkillId] : null;
    const selectingAlly = state.phase === 'target-select' && pendingSkill?.target === 'ally-field';
    if (selectingAlly && this.game.getHealTargets().includes(slot.spiritId)) {
      const selectTarget = () => this.call(() => this.game.chooseSkillTarget(slot.spiritId as string));
      cell.classList.add('is-targetable', 'is-ally-targetable');
      cell.tabIndex = 0;
      cell.setAttribute('role', 'button');
      cell.setAttribute('aria-label', `选择友方目标 ${data.name}`);
      cell.addEventListener('click', selectTarget);
      cell.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectTarget();
        }
      });
    }

    cell.append(this.renderUnitChip(data.name, data.accent));
    cell.append(textEl('strong', 'unit-name', data.name));
    cell.append(this.renderGrowthRecords(runtime));
    cell.append(this.metricBar('生命', runtime.hp, data.maxHp, 'hp', `${runtime.hp}/${data.maxHp}`));
    cell.append(this.metricBar('行动位', runtime.action, 100, 'action', this.roundActionText(state, 'spirit', slot.spiritId)));
    return cell;
  }

  private renderEnemyModule(state: BattleState) {
    const module = element('section', 'module-panel enemy-module');
    module.append(this.moduleHead('对手区域'));
    const board = element('div', 'formation-board enemy-board');
    ENEMY_POSITIONS.forEach((position) => {
      board.append(this.renderEnemyPosition(state, position));
    });
    module.append(board);
    return module;
  }

  private renderEnemyPosition(state: BattleState, position: (typeof ENEMY_POSITIONS)[number]) {
    const cell = element('article', `position-cell enemy-cell ${position.row}`);
    cell.append(textEl('span', 'position-label', position.label));
    const slot = position.slotPosition ? state.enemySlots.find((item) => item.position === position.slotPosition) : null;
    const enemy = slot?.enemyId ? state.enemies[slot.enemyId] : null;
    if (!enemy) {
      cell.append(textEl('span', 'empty-mark', ''));
      return cell;
    }

    const accent = enemy.category === 'boss' ? '#d84a31' : enemy.category === 'elite' ? '#a85d32' : '#c76b4d';
    cell.dataset.bossCard = 'true';
    cell.dataset.enemyId = enemy.id;
    cell.dataset.row = position.row;
    cell.style.setProperty('--accent', accent);
    cell.classList.add('occupied');
    if (enemy.hp <= 0) cell.classList.add('is-dead');
    if (this.selectedEnemyId === enemy.id) cell.classList.add('is-selected');
    if (state.activeUnit?.type === 'boss' && state.activeUnit.id === enemy.id) cell.classList.add('is-active');
    const pendingSkill = state.pendingSkillId ? this.config.skillConfig[state.pendingSkillId] : null;
    const selectingEnemy = state.phase === 'target-select' && pendingSkill?.target === 'boss';
    let activate: (() => void) | null = null;
    if (selectingEnemy) {
      const legalTargets = this.game.getLegalEnemyTargetIds();
      if (legalTargets.includes(enemy.id)) {
        cell.classList.add('is-targetable');
        activate = () => this.call(() => this.game.chooseSkillTarget(enemy.id));
      } else {
        cell.classList.add('is-target-blocked');
      }
    } else {
      cell.classList.add('can-inspect');
      activate = () => {
        this.selectedEnemyId = enemy.id;
        this.renderImmediately();
      };
    }
    if (activate) {
      cell.tabIndex = 0;
      cell.setAttribute('role', 'button');
      cell.setAttribute('aria-label', selectingEnemy ? `选择目标 ${enemy.name}` : `查看 ${enemy.name} 详情`);
      cell.addEventListener('click', activate);
      cell.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate?.();
        }
      });
    }

    cell.append(this.renderUnitChip(enemy.name, accent));
    cell.append(textEl('strong', 'unit-name', enemy.name));
    const identity = element('div', 'growth-row');
    identity.append(textEl('span', 'growth-chip enemy-category-chip', enemy.category === 'boss' ? 'Boss' : enemy.category === 'elite' ? '精英' : '小怪'));
    cell.append(identity);
    const cycle = this.game.enemyCycleView(enemy.id);
    if (cycle) {
      const cycleView = element('div', 'enemy-cycle-meter');
      cycleView.append(textEl('span', '', cycle.label), textEl('strong', '', `${cycle.current}/${cycle.max}`));
      if (cycle.current >= cycle.max) cycleView.classList.add('is-ready');
      cell.append(cycleView);
    }
    const telegraph = this.game.enemyTelegraphView(enemy.id);
    if (telegraph) {
      cell.classList.add('has-telegraph');
      cell.append(this.createEnemyTelegraphIndicator(telegraph));
    }
    cell.append(this.metricBar('生命', enemy.hp, enemy.maxHp, 'hp danger-bar', `${enemy.hp}/${enemy.maxHp}`));
    cell.append(this.metricBar('行动位', enemy.action, 100, 'action', this.roundActionText(state, 'boss', enemy.id)));
    return cell;
  }

  private createEnemyTelegraphIndicator(view: { skillName: string; targetText: string; estimatedPower: number }) {
    const indicator = element('div', 'enemy-telegraph');
    indicator.dataset.skillName = view.skillName;
    indicator.dataset.targetText = view.targetText;
    indicator.dataset.estimatedPower = String(view.estimatedPower);
    const powerText = view.estimatedPower > 0 ? `；预计威力 ${view.estimatedPower}` : '';
    indicator.title = `蓄力预告：${view.skillName}；${view.targetText}${powerText}`;
    indicator.append(textEl('span', 'enemy-telegraph-label', '预告'));
    indicator.append(textEl('strong', '', view.skillName));
    indicator.append(textEl('small', '', `${view.targetText}${view.estimatedPower > 0 ? ` · 威力 ${view.estimatedPower}` : ''}`));
    return indicator;
  }

  private createPlayerLockWarning(threats: Array<{ enemyName: string; skillName: string; lockMode: 'unit' | 'position' }>) {
    const warning = element('div', 'player-lock-warning');
    const detail = threats.map((threat) => `${threat.enemyName}准备使用${threat.skillName}${threat.lockMode === 'position' ? '攻击该位置' : '攻击该精灵'}`).join('；');
    const skillText = threats.length === 1 ? threats[0].skillName : `${threats.length}个攻击`;
    warning.dataset.threatKey = threats.map((threat) => `${threat.enemyName}:${threat.skillName}:${threat.lockMode}`).join('|');
    warning.title = detail;
    warning.setAttribute('aria-label', detail);
    warning.append(textEl('span', 'player-lock-warning-label', '锁定'), textEl('strong', '', skillText));
    return warning;
  }

  private syncEnemyTelegraphIndicators(state: BattleState) {
    this.root.querySelectorAll<HTMLElement>('.enemy-cell[data-enemy-id]').forEach((cell) => {
      const enemyId = cell.dataset.enemyId;
      if (!enemyId || !state.enemies[enemyId]) return;
      const view = this.game.enemyTelegraphView(enemyId);
      const current = cell.querySelector<HTMLElement>('.enemy-telegraph');
      cell.classList.toggle('has-telegraph', Boolean(view));
      if (!view) {
        current?.remove();
        return;
      }
      if (
        current?.dataset.skillName === view.skillName &&
        current.dataset.targetText === view.targetText &&
        current.dataset.estimatedPower === String(view.estimatedPower)
      ) return;
      const next = this.createEnemyTelegraphIndicator(view);
      if (current) current.replaceWith(next);
      else cell.append(next);
    });
  }

  private syncPlayerTelegraphIndicators(state: BattleState) {
    this.root.querySelectorAll<HTMLElement>('.player-board .position-cell[data-slot-index][data-row]').forEach((cell) => {
      const slotIndex = Number(cell.dataset.slotIndex);
      const row = cell.dataset.row as Row;
      const slot = state.slots[slotIndex];
      const spiritId = slot?.row === row ? slot.spiritId ?? undefined