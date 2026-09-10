
import { BattleGame } from './battle';
import type { BattleSystemConfig } from './battleSystems';
import {
  formatMultiplier,
  formatPercent,
  hpPercent
} from './formulas';
import { renderSkillDescription, statusDescription } from './skillPresentation';
import type { BattleFxEvent, BattleState, EnemyBattlePosition, Row, RuntimeSpirit, SkillData } from './types';

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
  slotPosition: EnemyBattlePosition | null;
}> = [
  { label: '1', row: 'front', slotPosition: 'front_1' },
  { label: '2', row: 'back', slotPosition: 'back_1' },
  { label: '3', row: 'front', slotPosition: 'front' },
  { label: '4', row: 'back', slotPosition: null },
  { label: '5', row: 'front', slotPosition: 'front_2' },
  { label: '6', row: 'back', slotPosition: 'back_2' }
];

export interface BattleUIOptions {
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
  private unsubscribeGame: (() => void) | null = null;
  private timeoutHandles = new Set<number>();
  private intervalHandles = new Set<number>();
  private transientNodes = new Set<HTMLElement>();
  private disposed = false;
  private abandonConfirmationOpen = false;

  constructor(private root: HTMLElement, private game: BattleGame, private config: BattleSystemConfig, private options: BattleUIOptions = {}) {}

  mount() {
    if (this.disposed || this.unsubscribeGame) return;
    this.unsubscribeGame = this.game.subscribe((state) => {
      if (!this.disposed) this.render(state);
    });
    this.game.start();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abandonConfirmationOpen = false;
    this.unsubscribeGame?.();
    this.unsubscribeGame = null;
    this.intervalHandles.forEach((handle) => window.clearInterval(handle));
    this.timeoutHandles.forEach((handle) => window.clearTimeout(handle));
    this.intervalHandles.clear();
    this.timeoutHandles.clear();
    this.transientNodes.forEach((node) => node.remove());
    this.transientNodes.clear();
    this.clearBattleFxClasses();
    this.root.innerHTML = '';
    document.body.classList.remove('has-enemy-detail');
  }

  private render(state: BattleState) {
    if (this.disposed) return;
    const battleInProgress = this.isBattleInProgress(state);
    if (!battleInProgress) this.abandonConfirmationOpen = false;
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
    if (battleInProgress && this.abandonConfirmationOpen) {
      shell.append(this.renderAbandonConfirmation());
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
    this.abandonConfirmationOpen = false;
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

    const actions = element('div', 'top-actions');
    if (this.isBattleInProgress(state)) {
      actions.append(button('放弃', 'ghost-button abandon-button', () => {
        this.openAbandonConfirmation();
      }));
    }
    actions.append(reset);

    header.append(title, status, actions);
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
    const benchIds = this.game.getBenchSpiritIds();
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
    if (enemy.element) identity.append(textEl('span', 'growth-chip', `${enemy.element}系`));
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
      const spiritId = slot?.row === row ? slot.spiritId ?? undefined : undefined;
      const threats = this.game.playerTelegraphThreats(slotIndex, row, spiritId);
      const current = cell.querySelector<HTMLElement>('.player-lock-warning');
      cell.classList.toggle('has-lock-warning', threats.length > 0);
      if (threats.length === 0) {
        current?.remove();
        return;
      }
      const next = this.createPlayerLockWarning(threats);
      if (current?.dataset.threatKey === next.dataset.threatKey) return;
      current?.remove();
      cell.append(next);
    });
  }

  private renderEnemyDetail(state: BattleState, enemyId: string) {
    const detail = this.game.enemyDetailView(enemyId);
    if (!detail || !state.enemies[enemyId]) {
      this.selectedEnemyId = null;
      return null;
    }
    const overlay = element('div', 'enemy-detail-overlay');
    overlay.addEventListener('click', () => {
      this.selectedEnemyId = null;
      this.renderImmediately();
    });
    const panel = element('section', 'enemy-detail-panel');
    panel.addEventListener('click', (event) => event.stopPropagation());

    const head = element('header', 'enemy-detail-head');
    const title = element('div', 'enemy-detail-title');
    title.append(textEl('h2', '', detail.name));
    const close = button('×', 'enemy-detail-close', () => {
      this.selectedEnemyId = null;
      this.renderImmediately();
    });
    close.title = '关闭';
    close.setAttribute('aria-label', '关闭敌方详情');
    head.append(title, close);
    panel.append(head);

    const coefficients = element('div', 'enemy-coefficient-grid');
    coefficients.append(this.detailValue('物攻系数', `×${formatMultiplier(detail.coefficients.physicalAttack)}`));
    coefficients.append(this.detailValue('魔攻系数', `×${formatMultiplier(detail.coefficients.magicAttack)}`));
    coefficients.append(this.detailValue('物防系数', `×${formatMultiplier(detail.coefficients.physicalDefense)}`));
    coefficients.append(this.detailValue('魔防系数', `×${formatMultiplier(detail.coefficients.magicDefense)}`));
    coefficients.append(this.detailValue('速度系数', `×${formatMultiplier(detail.coefficients.speed)}`));
    panel.append(this.detailSection('属性系数', coefficients));

    const statuses = element('div', 'enemy-detail-list');
    if (detail.statuses.length === 0) {
      statuses.append(textEl('p', 'enemy-detail-empty', '当前没有状态。'));
    } else {
      detail.statuses.forEach((status) => {
        const item = element('article', 'enemy-detail-item');
        item.append(textEl('strong', '', status.name));
        item.append(textEl('p', '', status.detail));
        statuses.append(item);
      });
    }
    panel.append(this.detailSection('状态详情', statuses));
    overlay.append(panel);
    return overlay;
  }

  private detailSection(title: string, content: HTMLElement) {
    const section = element('section', 'enemy-detail-section');
    section.append(textEl('h3', '', title));
    section.append(content);
    return section;
  }

  private detailValue(label: string, value: string) {
    const item = element('div', 'enemy-detail-value');
    item.append(textEl('span', '', label));
    item.append(textEl('strong', '', value));
    return item;
  }

  private renderNeutralModule(state: BattleState) {
    const module = element('section', 'module-panel neutral-module');
    module.append(this.moduleHead('中立区域'));

    const preview = element('ol', 'log-preview');
    state.logs.slice(0, 4).forEach((entry) => {
      const item = element('li', 'log-entry');
      item.textContent = entry;
      preview.append(item);
    });
    module.append(preview);

    const details = element('details', 'log-details');
    const summary = element('summary', 'log-summary');
    summary.textContent = '展开全部日志';
    const list = element('ol', 'log-list');
    state.logs.forEach((entry) => {
      const item = element('li', 'log-entry');
      item.textContent = entry;
      list.append(item);
    });
    details.append(summary, list);
    module.append(details);
    return module;
  }

  private renderRoundOrder(state: BattleState) {
    const panel = element('aside', 'module-panel round-order-panel round-order-sidebar');
    const head = element('div', 'round-order-head');
    head.append(textEl('strong', '', `第 ${state.round.index} 回合行动顺序`));
    head.append(textEl('span', '', '速度变化下回合生效'));
    panel.append(head);

    const track = element('ol', 'round-order-track');
    state.round.actionSlots.forEach((actionSlot, index) => {
      const item = element('li', `round-order-item is-${actionSlot.status} is-${actionSlot.type}`);
      const name = actionSlot.type === 'boss' ? this.game.enemyName(actionSlot.unitId) : this.spiritData(actionSlot.unitId).name;
      const accent = actionSlot.type === 'boss' ? '#d84a31' : this.spiritData(actionSlot.unitId).accent;
      item.style.setProperty('--order-accent', accent);
      item.append(textEl('span', 'round-order-index', String(index + 1)));
      const unit = element('span', 'round-order-unit');
      unit.append(textEl('strong', '', name));
      unit.append(textEl('small', '', this.roundActionStatusText(actionSlot.status)));
      if (actionSlot.type === 'boss') {
        const telegraph = this.game.enemyTelegraphView(actionSlot.unitId);
        if (telegraph) {
          unit.append(textEl('small', 'round-order-forced-action', `待执行：${telegraph.skillName}`));
        }
      }
      item.append(unit);
      track.append(item);
    });
    panel.append(track);
    return panel;
  }

  private renderOperationArea(state: BattleState) {
    const area = element('section', 'operation-area');

    const info = element('div', 'operation-info');
    info.append(this.renderManaBlock(state));
    if (this.notice) {
      info.append(textEl('div', 'notice', this.notice));
    }
    area.append(info);

    area.append(this.renderActionList(state));
    area.append(this.renderActionDetail(state));

    return area;
  }

  private renderActionList(state: BattleState) {
    const panel = element('div', 'action-panel action-list-panel');
    panel.append(sectionTitle('行动列表'));

    if (state.phase === 'forced-replacement') {
      panel.append(textEl('p', 'muted', '选择替换登场的精灵'));
      return panel;
    }

    if (state.phase === 'target-select') {
      panel.append(textEl('p', 'muted', '选择技能目标'));
      return panel;
    }

    const actor = this.game.getActingSpirit();
    if (!actor || state.phase !== 'player-action') {
      panel.append(textEl('p', 'idle-text', '等待本回合下一行动位'));
      return panel;
    }

    const data = this.spiritData(actor.id);
    const skillList = element('div', 'skill-list');
    data.skillIds.forEach((skillId) => {
      const skill = this.config.skillConfig[skillId];
      const skillState = this.game.getSkillButtonState(skill, actor);
      const skillButton = button('', 'skill-button', () => this.call(() => this.game.useSkill(skill.id, true)));
      if (!skillState.usable) {
        skillButton.classList.add('is-disabled');
      }
      if (skillState.enhanced) skillButton.classList.add('is-enhanced');
      skillButton.title = skillState.enhanced
        ? `${skillState.enhanceReason ?? ''}：${skillState.enhanceValue ?? ''}`
        : skillState.unavailableReason ?? '';
      skillButton.addEventListener('mouseenter', () => this.paintManaPreview(skill, actor));
      skillButton.addEventListener('mouseleave', () => this.clearManaPreview());
      skillButton.append(textEl('strong', '', skill.name));
      skillButton.append(this.renderSkillMeta(actor, skill, skillState));
      skillList.append(skillButton);
    });
    panel.append(skillList);

    const ops = element('div', 'operation-grid');
    ops.append(button('换宠', 'operation-button', () => this.renderSwapMenu()));
    ops.append(button('切换前后排', 'operation-button', () => this.call(() => this.game.switchRow())));
    panel.append(ops);

    return panel;
  }

  private renderActionDetail(state: BattleState) {
    const panel = element('div', 'action-panel detail-panel');
    panel.append(sectionTitle('技能信息'));

    if (state.phase === 'forced-replacement') {
      const replacement = state.replacement;
      if (replacement) {
        panel.append(textEl('p', 'detail-title', replacement.reason));
        const list = element('div', 'choice-list');
        replacement.candidates.forEach((id) => {
          list.append(this.renderSwapCandidate(state, id, () => this.game.resolveForcedReplacement(id)));
        });
        panel.append(list);
      }
      return panel;
    }

    if (state.phase === 'target-select') {
      const skill = state.pendingSkillId ? this.config.skillConfig[state.pendingSkillId] : null;
      panel.append(textEl('p', 'detail-title', skill ? skill.name : '选择目标'));
      const list = element('div', 'choice-list');
      if (skill?.target === 'boss') {
        const frontAlive = this.game.getActiveEnemyIds().some((id) => this.game.getEnemy(id).row === 'front');
        panel.append(textEl('p', 'target-rule-note', frontAlive ? '敌方前排存活：当前技能只能选择前排。' : '敌方无存活前排：后排目标已开放。'));
        this.game.getLegalEnemyTargetIds().forEach((id) => {
          const enemy = this.game.getEnemy(id);
          const skillState = this.game.getSkillButtonState(skill, this.game.getActingSpirit(), id);
          const label = `${enemy.name} ${enemy.hp}/${enemy.maxHp}${skillState.enhanced && skillState.targetDependent ? `｜强化：${skillState.enhanceValue}` : ''}`;
          list.append(button(label, `choice-button${skillState.enhanced && skillState.targetDependent ? ' is-enhanced-target' : ''}`, () => this.call(() => this.game.chooseSkillTarget(id))));
        });
      } else {
        this.game.getHealTargets().forEach((id) => {
          const spirit = this.game.getSpirit(id);
          const data = this.spiritData(id);
          const skillState = skill ? this.game.getSkillButtonState(skill, this.game.getActingSpirit(), id) : null;
          const label = `${data.name} ${spirit.hp}/${data.maxHp}${skillState?.enhanced && skillState.targetDependent ? `｜强化：${skillState.enhanceValue}` : ''}`;
          list.append(button(label, `choice-button${skillState?.enhanced && skillState.targetDependent ? ' is-enhanced-target' : ''}`, () => this.call(() => this.game.chooseSkillTarget(id))));
        });
      }
      panel.append(list);
      panel.append(button('返回', 'ghost-button full', () => {
        this.notice = '';
        this.game.cancelTargetSelect();
      }));
      return panel;
    }

    const actor = this.game.getActingSpirit();
    if (!actor || state.phase !== 'player-action') {
      panel.append(textEl('p', 'muted', '等待下一行动位'));
      return panel;
    }

    const data = this.spiritData(actor.id);
    data.skillIds.forEach((skillId) => {
      const skill = this.config.skillConfig[skillId];
      panel.append(this.renderSkillDetail(actor, skill));
    });
    return panel;
  }

  private renderSkillDetail(actor: RuntimeSpirit, skill: SkillData) {
    const card = element('article', 'skill-detail-card');
    card.append(textEl('strong', '', skill.name));
    card.append(this.renderSkillMeta(actor, skill, this.game.getSkillButtonState(skill, actor)));
    card.append(renderSkillDescription(skill));
    return card;
  }

  private renderSwapMenu() {
    const state = this.game.state;
    const listPanel = document.querySelector('.action-list-panel');
    const detailPanel = document.querySelector('.detail-panel');
    if (!listPanel || !detailPanel) return;

    listPanel.innerHTML = '';
    listPanel.append(sectionTitle('换宠'));
    listPanel.append(textEl('p', 'muted', '从后备精灵中选择一只登场'));
    listPanel.append(button('返回行动列表', 'ghost-button full', () => {
      this.notice = '';
      this.renderImmediately(state);
    }));

    detailPanel.innerHTML = '';
    detailPanel.append(sectionTitle('后备精灵'));
    const list = element('div', 'choice-list');
    const bench = this.game.getBenchSpiritIds();
    if (bench.length === 0) {
      list.append(textEl('p', 'muted', '没有可用后备。'));
    }
    bench.forEach((id) => {
      list.append(this.renderSwapCandidate(state, id, () => this.game.swapWithBench(id)));
    });
    detailPanel.append(list);
  }

  private renderSwapCandidate(state: BattleState, spiritId: string, action: () => { ok: boolean; message?: string }) {
    const runtime = state.spirits[spiritId];
    const data = this.spiritData(spiritId);
    const card = element('article', 'swap-card');
    card.style.setProperty('--accent', data.accent);

    const pick = button(`${data.name} ${runtime.hp}/${data.maxHp}`, 'choice-button swap-pick', () => this.call(action));
    card.append(pick);

    const skills = element('div', 'swap-skill-list');
    data.skillIds.forEach((skillId) => {
      const skill = this.config.skillConfig[skillId];
      const row = element('div', 'swap-skill');
      row.append(textEl('strong', '', skill.name));
      row.append(this.renderSkillMeta(runtime, skill));
      row.append(renderSkillDescription(skill));
      skills.append(row);
    });
    card.append(skills);
    return card;
  }

  private renderManaBlock(state: BattleState) {
    const block = element('div', 'stat-block mana-block');
    const head = element('div', 'mana-head');
    head.append(textEl('span', '', '团队妖力'));
    head.append(textEl('strong', '', `${state.mana.current}/${state.mana.max}`));
    block.append(head);

    const grid = element('div', 'mana-grid');
    for (let index = 0; index < state.mana.max; index += 1) {
      const cell = element('span', index < state.mana.current ? 'mana-cell filled' : 'mana-cell');
      cell.dataset.index = String(index);
      grid.append(cell);
    }
    block.append(grid);
    return block;
  }

  private renderBenchPill(state: BattleState, spiritId: string) {
    const runtime = state.spirits[spiritId];
    const data = this.spiritData(spiritId);
    const pill = element('span', 'bench-pill');
    if (runtime.hp <= 0) pill.classList.add('is-dead');
    pill.style.setProperty('--accent', data.accent);
    pill.textContent = `${data.name} ${runtime.hp}/${data.maxHp}`;
    return pill;
  }

  private renderGrowthRecords(runtime: RuntimeSpirit) {
    const wrap = element('div', 'growth-row');
    const growths: Array<{ label: string; detail?: string }> = [];
    if (runtime.physicalAttackBonus > 0) growths.push({ label: `物攻 +${formatPercent(runtime.physicalAttackBonus)}`, detail: '当前物理攻击强化。' });
    if (runtime.magicAttackBonus > 0) growths.push({ label: `魔攻 +${formatPercent(runtime.magicAttackBonus)}`, detail: '当前魔法攻击强化。' });
    if (runtime.nextSkillPowerBonus > 0) growths.push({ label: `下次威力 +${runtime.nextSkillPowerBonus}`, detail: '下一次具有威力的技能获得该数值加成。' });
    if (runtime.shieldNextBossAction > 0) growths.push({ label: `护盾 ${runtime.shieldNextBossAction}`, detail: '用于抵挡下一次 Boss 行动造成的伤害。' });
    if (runtime.damageAmpStacks > 0) growths.push({ label: `爆发 ${runtime.damageAmpStacks}`, detail: statusDescription('damage-amp') });
    if (runtime.chargeTurns > 0 || runtime.freshChargeTurns > 0) growths.push({ label: '蓄势', detail: statusDescription('charge') });
    if (runtime.regenTurns > 0 || runtime.freshRegenTurns > 0) growths.push({ label: `回复 ${Math.max(runtime.regenTurns, runtime.freshRegenTurns)}`, detail: statusDescription('regen') });
    if (runtime.shieldValue > 0) growths.push({ label: `护盾 ${runtime.shieldValue}`, detail: '优先吸收受到的伤害；持有者正常行动结束会清除既有护盾。' });
    if (runtime.statuses['energy-saving']) growths.push({ label: '节能', detail: statusDescription('energy-saving') });
    if (runtime.statuses['shield-guard']) growths.push({ label: `盾阵 ${runtime.statuses['shield-guard'].duration}`, detail: statusDescription('shield-guard') });
    if (runtime.shieldExtensionTurns > 0) growths.push({ label: `护盾延长 ${runtime.shieldExtensionTurns}`, detail: '当前护盾额外保留的正常行动次数。' });
    Object.entries(runtime.skillPowerGrowth)
      .filter(([, value]) => value > 0)
      .forEach(([skillId, value]) => {
        growths.push({ label: `${this.config.skillConfig[skillId]?.name ?? skillId} +${value}`, detail: '本场战斗中该技能当前威力的永久成长。' });
      });
    if (growths.length === 0) {
      wrap.append(textEl('span', 'growth-chip is-empty', '无成长'));
      return wrap;
    }
    growths.forEach((growth) => {
      const chip = textEl('span', 'growth-chip', growth.label);
      if (growth.detail) {
        chip.title = growth.detail;
        chip.setAttribute('aria-label', `${growth.label}：${growth.detail}`);
      }
      wrap.append(chip);
    });
    return wrap;
  }

  private renderUnitChip(name: string, accent: string) {
    const chip = element('div', 'unit-chip');
    chip.style.setProperty('--accent', accent);
    chip.textContent = name.slice(0, 1);
    return chip;
  }

  private moduleHead(title: string, subtitle?: string) {
    const head = element('div', 'module-head');
    head.append(textEl('strong', '', title));
    if (subtitle) head.append(textEl('span', '', subtitle));
    return head;
  }

  private statBlock(label: string, value: string, title?: string) {
    const block = element('div', 'stat-block');
    if (title) block.title = title;
    const labelRow = element('div', 'stat-label-row');
    labelRow.append(textEl('span', '', label));
    if (title) {
      labelRow.append(textEl('span', 'info-dot', 'i'));
    }
    block.append(labelRow);
    block.append(textEl('strong', '', value));
    return block;
  }

  private statPill(label: string, value: string, title?: string) {
    const pill = element('div', 'stat-pill');
    if (title) pill.title = title;
    pill.append(textEl('span', '', label));
    pill.append(textEl('strong', '', value));
    return pill;
  }

  private metricBar(label: string, value: number, max: number, className: string, valueText: string) {
    const wrap = element('div', 'metric-line');
    wrap.append(textEl('span', 'metric-label', label));
    const track = element('div', `compact-track ${className}`);
    const fill = element('span', 'compact-fill');
    fill.style.width = `${hpPercent(value, max)}%`;
    track.append(fill);
    wrap.append(track);
    wrap.append(textEl('span', 'metric-value', valueText));
    return wrap;
  }

  private roundActionText(state: BattleState, type: 'spirit' | 'boss', unitId: string) {
    const actionSlot = state.round.actionSlots.find((slot) => slot.type === type && slot.unitId === unitId);
    if (!actionSlot) return '本回合无行动位';
    return this.roundActionStatusText(actionSlot.status);
  }

  private roundActionStatusText(status: BattleState['round']['actionSlots'][number]['status']) {
    const labels = {
      pending: '待行动',
      executing: '行动中',
      completed: '已行动',
      invalid: '已失效',
      skipped: '已跳过'
    };
    return labels[status];
  }

  private paintManaPreview(skill: SkillData, actor?: RuntimeSpirit | null) {
    this.clearManaPreview();
    const cells = Array.from(this.root.querySelectorAll<HTMLElement>('.mana-cell'));
    const current = this.game.state.mana.current;
    const skillState = this.game.getSkillButtonState(skill, actor ?? null);
    const gain = skillState.manaGainActual;
    const cost = skillState.actualCost;
    if (cost > 0) {
      const start = current >= cost ? current - cost : 0;
      const end = Math.min(this.game.state.mana.max, start + cost);
      for (let index = start; index < end; index += 1) {
        cells[index]?.classList.add('preview-cost');
      }
    }
    if (gain > 0) {
      const start = current + gain <= this.game.state.mana.max ? current : Math.max(0, this.game.state.mana.max - gain);
      const end = Math.min(this.game.state.mana.max, start + gain);
      for (let index = start; index < end; index += 1) {
        cells[index]?.classList.add('preview-gain');
      }
    }
  }

  private clearManaPreview() {
    this.root.querySelectorAll('.mana-cell').forEach((cell) => {
      cell.classList.remove('preview-cost', 'preview-gain');
    });
  }

  private renderSkillMeta(actor: RuntimeSpirit, skill: SkillData, skillState = this.game.getSkillButtonState(skill, actor)) {
    const wrap = element('div', 'skill-meta-row');
    wrap.append(textEl('span', 'skill-meta-pill', skill.kind === 'attack' ? '攻击' : '辅助'));
    if (skill.power) {
      const powerText = skillState.powerBonus > 0
        ? `威力 ${skillState.powerTotal}（+${skillState.powerBonus}）`
        : `威力 ${skillState.powerTotal}`;
      wrap.append(textEl('span', 'skill-meta-pill', powerText));
    }
    if (!skill.power && skill.fixedDamage) wrap.append(textEl('span', 'skill-meta-pill', `固定伤害 ${skill.fixedDamage}`));
    if (skill.costAllMana) wrap.append(this.manaIconGroup('cost', null, '全部妖力'));
    if (!skill.costAllMana && (skill.cost > 0 || skillState.actualCost > 0 || skillState.costDiscounted)) {
      wrap.append(this.manaIconGroup('cost', skillState.actualCost, undefined, skillState.costDiscounted));
    }
    if (skill.gain > 0 || skill.gainWhenManaBelow !== undefined) {
      if (skillState.manaGainOriginal !== skillState.manaGainActual) {
        wrap.append(this.manaIconGroup('gain', 0));
      } else {
        wrap.append(this.manaIconGroup('gain', skillState.manaGainActual));
      }
    }
    if (skill.restoreManaTo !== undefined) wrap.append(this.manaIconGroup('gain', null, `恢复至${skill.restoreManaTo}`));
    if (skill.cooldown && skill.cooldown > 0) wrap.append(textEl('span', 'skill-meta-pill', `CD ${skill.cooldown}`));
    if (skillState.enhanced) {
      const enhanced = textEl('span', 'skill-meta-pill skill-enhance-pill', `强化 ${skillState.enhanceValue ?? ''}`);
      enhanced.title = skillState.enhanceReason ?? '';
      wrap.append(enhanced);
    } else if (skillState.targetDependent) {
      wrap.append(textEl('span', 'skill-meta-pill skill-target-dependent-pill', '选择目标后判定'));
    }
    return wrap;
  }

  private manaIconGroup(kind: 'cost' | 'gain', count: number | null, label?: string, discounted = false, rawLabel = false) {
    const group = element('span', `mana-icon-group ${kind === 'cost' ? 'is-cost' : 'is-gain'}${discounted ? ' is-discounted-cost' : ''}`);
    group.append(element('span', 'mana-icon-cell'));
    group.append(textEl('span', 'mana-icon-more', count === null ? (rawLabel ? label ?? '' : `*${label ?? ''}`) : `*${count}`));
    return group;
  }

  private spiritData(id: string) {
    return this.game.getSpiritDefinition(id);
  }

  private activeName(state: BattleState) {
    if (!state.activeUnit) return state.phase === 'running' ? '等待行动位' : phaseName(state.phase);
    if (state.activeUnit.type === 'boss') return this.game.enemyName(state.activeUnit.id);
    return this.spiritData(state.activeUnit.id).name;
  }

  private isFront(spiritId: string) {
    return this.game.state.slots.some((slot) => slot.spiritId === spiritId && slot.row === 'front');
  }

  private syncBattleFx(state: BattleState) {
    const fx = state.battleFx;
    if (!fx || fx.serial <= this.seenFxSerial) return;
    this.seenFxSerial = fx.serial;
    this.keepBattleFxClassesAlive(fx);
    this.playManaChangeFx(fx);

    if (fx.kind === 'player-attack') {
      this.playPlayerAttackFx(fx);
      return;
    }

    if (fx.kind === 'player-heal' || fx.kind === 'player-support' || fx.kind === 'player-buff') {
      this.playPlayerUtilityFx(fx);
      return;
    }

    if (fx.kind === 'player-debuff') {
      this.playPlayerDebuffFx(fx);
      return;
    }

    if (fx.kind === 'boss-attack') {
      this.playBossAttackFx(fx);
      return;
    }

    if (fx.kind === 'boss-buff') {
      this.playBossBuffFx(fx);
    }
  }

  private keepBattleFxClassesAlive(fx: BattleFxEvent) {
    if (this.disposed) return;
    const duration = fx.telegraphSkillName ? 900 : 760;
    const startedAt = window.performance.now();
    const apply = () => this.applyBattleFxClasses(fx);
    apply();
    const timer = this.scheduleInterval(() => {
      if (window.performance.now() - startedAt > duration) {
        this.cancelInterval(timer);
        this.clearBattleFxClasses();
        return;
      }
      apply();
    }, 60);
  }

  private applyBattleFxClasses(fx: BattleFxEvent) {
    if (fx.actorId) {
      this.spiritCell(fx.actorId)?.classList.add('is-acting');
    }
    if (fx.kind === 'player-attack') {
      fx.targetEnemyIds?.forEach((id) => this.enemyCard(id)?.classList.add('is-shaking'));
    }
    if (fx.kind === 'player-debuff') {
      fx.targetEnemyIds?.forEach((id) => this.enemyCard(id)?.classList.add('is-powering'));
    }
    if (fx.kind === 'boss-attack') {
      this.enemyCard(fx.enemyActorId)?.classList.add('is-attacking');
      fx.targetIds?.forEach((id) => this.spiritCell(id)?.classList.add('is-hit'));
    }
    if (fx.kind === 'boss-buff') {
      this.enemyCard(fx.enemyActorId)?.classList.add('is-powering');
      if (fx.telegraphSkillName) this.enemyCard(fx.enemyActorId)?.classList.add('is-telegraph-arming');
    }
    if (fx.kind === 'player-heal' || fx.kind === 'player-support' || fx.kind === 'player-buff') {
      const targetIds = fx.targetIds?.length ? fx.targetIds : fx.actorId ? [fx.actorId] : [];
      targetIds.forEach((id) => this.spiritCell(id)?.classList.add(fx.kind === 'player-heal' ? 'is-healed' : 'is-boosted'));
    }
    this.applyManaFxClasses(fx);
  }

  private applyManaFxClasses(fx: BattleFxEvent) {
    const cells = Array.from(this.root.querySelectorAll<HTMLElement>('.mana-cell'));
    if (fx.manaCost > 0) {
      const start = Math.max(0, fx.manaBefore - fx.manaCost);
      for (let index = start; index < fx.manaBefore; index += 1) {
        cells[index]?.classList.add('mana-spend-fx');
      }
    }
    if (fx.manaGain > 0) {
      const start = Math.max(0, fx.manaAfter - fx.manaGain);
      for (let index = start; index < fx.manaAfter; index += 1) {
        cells[index]?.classList.add('mana-gain-fx');
      }
    }
  }

  private clearBattleFxClasses() {
    this.root
      .querySelectorAll('.is-acting, .is-shaking, .is-attacking, .is-powering, .is-telegraph-arming, .is-hit, .is-healed, .is-boosted, .is-value-changing, .mana-spend-fx, .mana-gain-fx')
      .forEach((node) => node.classList.remove('is-acting', 'is-shaking', 'is-attacking', 'is-powering', 'is-telegraph-arming', 'is-hit', 'is-healed', 'is-boosted', 'is-value-changing', 'mana-spend-fx', 'mana-gain-fx'));
  }

  private playPlayerAttackFx(fx: BattleFxEvent) {
    if (!fx.actorId) return;
    const source = this.spiritCell(fx.actorId);
    const boss = this.enemyCard(fx.targetEnemyIds?.[0]);
    if (!source || !boss) return;

    if (fx.actorRow === 'front') {
      this.spawnFlyingSprite(source, boss, source.querySelector('.unit-chip')?.textContent || fx.skillName?.slice(0, 1) || '', 'fx-spirit-strike');
    } else {
      this.spawnFlyingSprite(source, boss, fx.skillName || '', 'fx-skill-bolt');
    }
    this.addTransientClass(boss, 'is-shaking', 560);
    this.floatBossDamage(boss, fx.amount ? `-${fx.amount}` : fx.skillName || '');
  }

  private playPlayerUtilityFx(fx: BattleFxEvent) {
    const targetIds = fx.targetIds?.length ? fx.targetIds : fx.actorId ? [fx.actorId] : [];
    targetIds.forEach((id) => {
      const target = this.spiritCell(id);
      if (!target) return;
      this.addTransientClass(target, fx.kind === 'player-heal' ? 'is-healed' : 'is-boosted', 620);
      if (fx.kind === 'player-heal') this.floatAt(target, `+${fx.amount ?? 0}`, 'heal');
    });
  }

  private playPlayerDebuffFx(fx: BattleFxEvent) {
    const boss = this.enemyCard(fx.targetEnemyIds?.[0]);
    if (boss) {
      this.addTransientClass(boss, 'is-powering', 680);
      this.spawnAura(boss, fx.skillName || '');
    }
  }

  private playBossAttackFx(fx: BattleFxEvent) {
    const boss = this.enemyCard(fx.enemyActorId);
    if (boss) this.addTransientClass(boss, 'is-attacking', 520);
    fx.targetIds?.forEach((id) => {
      const target = this.spiritCell(id);
      if (!target) return;
      if (boss) this.spawnFlyingSprite(boss, target, fx.bossBehaviorName || '', 'fx-boss-bolt');
      this.addTransientClass(target, 'is-hit', 560);
      const amount = fx.targetAmounts?.[id] ?? fx.amount;
      this.floatAt(target, amount !== undefined ? `-${amount}` : fx.bossBehaviorName || '', 'damage');
    });
  }

  private playBossBuffFx(fx: BattleFxEvent) {
    const boss = this.enemyCard(fx.enemyActorId);
    if (boss) {
      this.addTransientClass(boss, 'is-powering', 760);
      if (fx.telegraphSkillName) this.addTransientClass(boss, 'is-telegraph-arming', 860);
      this.spawnAura(boss, fx.telegraphSkillName ? `预告：${fx.telegraphSkillName}` : fx.bossBehaviorName || '', fx.telegraphSkillName ? 'is-telegraph-aura' : '');
    }
  }

  private playManaChangeFx(fx: BattleFxEvent) {
    const cells = Array.from(this.root.querySelectorAll<HTMLElement>('.mana-cell'));
    if (fx.manaCost > 0) {
      const start = Math.max(0, fx.manaBefore - fx.manaCost);
      for (let index = start; index < fx.manaBefore; index += 1) {
        this.addTransientClass(cells[index], 'mana-spend-fx', 720);
      }
    }
    if (fx.manaGain > 0) {
      const start = Math.max(0, fx.manaAfter - fx.manaGain);
      for (let index = start; index < fx.manaAfter; index += 1) {
        this.addTransientClass(cells[index], 'mana-gain-fx', 720);
      }
    }
  }

  private spawnFlyingSprite(source: HTMLElement, target: HTMLElement, text: string, className: string) {
    const from = this.centerOf(source);
    const to = this.centerOf(target);
    const sprite = element('div', `fx-sprite ${className}`);
    sprite.textContent = text;
    sprite.style.left = `${from.x}px`;
    sprite.style.top = `${from.y}px`;
    sprite.style.setProperty('--move-x', `${to.x - from.x}px`);
    sprite.style.setProperty('--move-y', `${to.y - from.y}px`);
    const accent = getComputedStyle(source).getPropertyValue('--accent');
    if (accent) sprite.style.setProperty('--accent', accent);
    this.appendTransientNode(sprite, 720);
  }

  private floatAt(target: HTMLElement, text: string, tone: 'damage' | 'heal' | 'buff') {
    if (!text) return;
    const point = this.centerOf(target);
    const node = element('div', `fx-float ${tone}`);
    node.textContent = text;
    node.style.left = `${point.x}px`;
    node.style.top = `${point.y}px`;
    this.appendTransientNode(node, 760);
  }

  private spawnAura(target: HTMLElement, text: string, className = '') {
    const point = this.centerOf(target);
    const aura = element('div', `fx-boss-aura ${className}`.trim());
    aura.textContent = text;
    aura.style.left = `${point.x}px`;
    aura.style.top = `${point.y}px`;
    this.appendTransientNode(aura, 860);
  }

  private floatBossDamage(boss: HTMLElement, text: string) {
    if (!text) return;
    const title = boss.querySelector<HTMLElement>('h2');
    const rect = (title ?? boss).getBoundingClientRect();
    const node = element('div', 'fx-float damage boss-damage');
    node.textContent = text;
    node.style.left = `${rect.left + Math.min(rect.width + 56, boss.getBoundingClientRect().width * 0.62)}px`;
    node.style.top = `${rect.top + rect.height / 2}px`;
    this.appendTransientNode(node, 840);
  }

  private addTransientClass(target: Element | null | undefined, className: string, duration: number) {
    if (!(target instanceof HTMLElement)) return;
    target.classList.add(className);
    this.scheduleTimeout(() => target.classList.remove(className), duration);
  }

  private centerOf(target: HTMLElement) {
    const rect = target.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  }

  private spiritCell(spiritId: string) {
    return this.root.querySelector<HTMLElement>(`[data-spirit-id="${spiritId}"]`);
  }

  private enemyCard(enemyId?: string) {
    if (enemyId) return this.root.querySelector<HTMLElement>(`[data-enemy-id="${enemyId}"][data-boss-card="true"]`);
    return this.root.querySelector<HTMLElement>('[data-boss-card="true"]');
  }

  private syncHitFeedback(state: BattleState) {
    const feedback = state.hitFeedback;
    if (!feedback || feedback.serial <= this.seenHitSerial) return;
    this.seenHitSerial = feedback.serial;
    this.flashingHit = feedback;
    this.scheduleTimeout(() => {
      if (this.flashingHit?.serial === feedback.serial) {
        this.flashingHit = null;
        this.render(this.game.state);
      }
    }, 520);
  }

  private scheduleTimeout(callback: () => void, delay: number) {
    const handle = window.setTimeout(() => {
      this.timeoutHandles.delete(handle);
      if (!this.disposed) callback();
    }, delay);
    this.timeoutHandles.add(handle);
    return handle;
  }

  private scheduleInterval(callback: () => void, delay: number) {
    const handle = window.setInterval(() => {
      if (!this.disposed) callback();
    }, delay);
    this.intervalHandles.add(handle);
    return handle;
  }

  private cancelInterval(handle: number) {
    window.clearInterval(handle);
    this.intervalHandles.delete(handle);
  }

  private appendTransientNode(node: HTMLElement, duration: number) {
    if (this.disposed) return;
    this.transientNodes.add(node);
    document.body.append(node);
    this.scheduleTimeout(() => {
      this.transientNodes.delete(node);
      node.remove();
    }, duration);
  }

  private renderResult(state: BattleState) {
    const overlay = element('div', 'result-overlay');
    const modal = element('section', 'result-modal');
    modal.append(textEl('span', 'eyebrow', state.phase === 'victory' ? '胜利' : '失败'));
    modal.append(textEl('h2', '', this.options.resultTitle?.(state) ?? (state.phase === 'victory' ? 'Boss 已被击败' : '玩家队伍全灭')));
    modal.append(button(this.options.resultButtonLabel?.(state) ?? '重新开始', 'primary-button', () => {
      if (this.options.onResultAction) {
        this.options.onResultAction(state);
        return;
      }
      this.resetBattleView();
      this.game.reset();
      this.game.start();
    }));
    overlay.append(modal);
    return overlay;
  }

  private isBattleInProgress(state: BattleState) {
    return state.phase !== 'victory' && state.phase !== 'defeat';
  }

  private openAbandonConfirmation() {
    const state = this.game.state;
    if (this.disposed || this.abandonConfirmationOpen || !this.isBattleInProgress(state)) return;
    this.abandonConfirmationOpen = true;
    this.renderImmediately(state);
  }

  private cancelAbandonConfirmation() {
    if (this.disposed || !this.abandonConfirmationOpen) return;
    this.abandonConfirmationOpen = false;
    this.renderImmediately();
  }

  private confirmAbandonBattle() {
    if (this.disposed || !this.abandonConfirmationOpen) return;
    if (!this.isBattleInProgress(this.game.state)) {
      this.abandonConfirmationOpen = false;
      return;
    }
    this.abandonConfirmationOpen = false;
    const result = this.game.abandonBattle();
    if (!result.ok && !this.disposed) this.renderImmediately();
  }

  private renderAbandonConfirmation() {
    const overlay = element('div', 'abandon-confirm-overlay');
    const modal = element('section', 'abandon-confirm-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'abandon-confirm-title');
    const title = textEl('h2', '', '确认放弃战斗？');
    title.id = 'abandon-confirm-title';
    modal.append(title);
    modal.append(textEl('p', 'muted', '确认后，本场战斗将立即按失败结束。'));
    const actions = element('div', 'abandon-confirm-actions');
    actions.append(button('取消', 'ghost-button', () => this.cancelAbandonConfirmation()));
    actions.append(button('确认放弃', 'primary-button abandon-confirm-button', () => {
      this.confirmAbandonBattle();
    }));
    modal.append(actions);
    overlay.append(modal);
    return overlay;
  }

  private call(fn: () => { ok: boolean; message?: string }) {
    const result = fn();
    this.notice = result.ok ? result.message ?? '' : result.message ?? '操作不可用。';
    if (this.notice) {
      this.render(this.game.state);
    }
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function textEl<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text: string) {
  const node = element(tag, className);
  node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void) {
  const node = element('button', className);
  node.type = 'button';
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

function sectionTitle(text: string) {
  const title = element('div', 'section-title');
  title.append(textEl('span', '', text));
  return title;
}

function phaseName(phase: BattleState['phase']) {
  const names: Record<BattleState['phase'], string> = {
    running: '等待行动位',
    'player-action': '玩家行动',
    'target-select': '选择目标',
    'forced-replacement': '替换登场',
    victory: '胜利',
    defeat: '失败'
  };
  return names[phase];
}
