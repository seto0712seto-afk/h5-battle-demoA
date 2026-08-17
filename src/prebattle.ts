import type { BattleSystemConfig } from './battleSystems';
import { renderSkillDescription } from './skillPresentation';
import type { BossId, Row, SkillData, SpiritData } from './types';
type RosterGroup = 'starter' | 'reserve';

export type PreBattleStartPayload = {
  selectedSpiritIds: string[];
  selectedBossId?: BossId;
};

type StartBattleHandler = (payload: PreBattleStartPayload) => void;

const ROSTER_SLOT_COUNT = 6;
const STARTER_SLOT_COUNT = 3;

export function buildRandomQuickTeam(
  creatures: SpiritData[],
  selectionLimit = ROSTER_SLOT_COUNT,
  random: () => number = Math.random
) {
  const limit = Math.min(selectionLimit, ROSTER_SLOT_COUNT, creatures.length);
  const shuffle = (items: SpiritData[]) => {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const targetIndex = Math.floor(random() * (index + 1));
      [result[index], result[targetIndex]] = [result[targetIndex], result[index]];
    }
    return result;
  };

  const starterCount = Math.min(STARTER_SLOT_COUNT, limit);
  const frontPool = shuffle(creatures.filter((spirit) => spirit.defaultPosition === 'front'));
  const backPool = shuffle(creatures.filter((spirit) => spirit.defaultPosition === 'back'));
  const frontStarters = frontPool.slice(0, Math.min(1, starterCount));
  const backStarters = backPool.slice(0, starterCount - frontStarters.length);
  const starters = [...frontStarters, ...backStarters];
  const selectedIds = new Set(starters.map((spirit) => spirit.id));

  if (starters.length < starterCount) {
    shuffle(creatures.filter((spirit) => !selectedIds.has(spirit.id)))
      .slice(0, starterCount - starters.length)
      .forEach((spirit) => {
        starters.push(spirit);
        selectedIds.add(spirit.id);
      });
  }

  const randomizedStarters = shuffle(starters).slice(0, starterCount);
  const reserveCount = Math.max(0, limit - randomizedStarters.length);
  const availableReserveFronts = shuffle(creatures.filter((spirit) => spirit.defaultPosition === 'front' && !selectedIds.has(spirit.id)));
  const availableReserveBacks = shuffle(creatures.filter((spirit) => spirit.defaultPosition === 'back' && !selectedIds.has(spirit.id)));
  const minimumReserveFronts = Math.min(1, reserveCount, availableReserveFronts.length);
  const maximumReserveFronts = Math.min(2, reserveCount, availableReserveFronts.length);
  const requiredReserveFronts = Math.max(minimumReserveFronts, reserveCount - availableReserveBacks.length);
  const reserveFrontCount = requiredReserveFronts
    + Math.floor(random() * (maximumReserveFronts - requiredReserveFronts + 1));
  const reserveFronts = availableReserveFronts.slice(0, reserveFrontCount);
  const reserveBacks = availableReserveBacks.slice(0, reserveCount - reserveFronts.length);
  [...reserveFronts, ...reserveBacks].forEach((spirit) => selectedIds.add(spirit.id));
  const reserveFallbacks = shuffle(creatures.filter((spirit) => !selectedIds.has(spirit.id)))
    .slice(0, reserveCount - reserveFronts.length - reserveBacks.length);
  const reserves = shuffle([...reserveFronts, ...reserveBacks, ...reserveFallbacks]);
  return [...randomizedStarters, ...reserves].map((spirit) => spirit.id);
}

export class PreBattleUI {
  private lineupSlots: Array<string | null> = Array(ROSTER_SLOT_COUNT).fill(null);
  private focusedId = '';
  private notice = '至少选择 1 只首发精灵';
  private selectedBossId: BossId;
  private draggingSlotIndex: number | null = null;
  private draggingCandidateId: string | null = null;

  constructor(
    private root: HTMLElement,
    private config: BattleSystemConfig,
    private onStart: StartBattleHandler,
    initialPayload?: PreBattleStartPayload
  ) {
    const initialIds = initialPayload?.selectedSpiritIds.slice(0, this.selectionLimit()) ?? [];
    initialIds.forEach((id, index) => {
      if (index < ROSTER_SLOT_COUNT) this.lineupSlots[index] = id;
    });
    this.focusedId = initialIds[0] ?? config.creatureConfig[0]?.id ?? '';
    this.selectedBossId = initialPayload?.selectedBossId ?? config.defaultBossId ?? config.bossConfig.id;
  }

  mount() {
    this.render();
  }

  private render() {
    const focused = this.focusedSpirit();
    this.root.innerHTML = '';

    const shell = element('main', 'prebattle-shell');
    shell.append(this.renderHeader());
    const layout = element('section', 'prebattle-layout');
    layout.append(this.renderCandidateList());
    layout.append(this.renderDetailPanel(focused));
    layout.append(this.renderTeamPreview());
    shell.append(layout);

    this.root.append(shell);
  }

  private renderHeader() {
    const header = element('header', 'topbar prebattle-topbar');
    const title = element('div', 'title-block');
    title.append(textEl('span', 'eyebrow', 'PVE Boss 战'));
    title.append(textEl('h1', '', '战前准备'));

    const status = element('div', 'top-status');
    status.append(this.statusPill('已选择', `${this.lineupIds().length} / ${this.selectionLimit()}`));
    status.append(this.statusPill('首发', `${this.starterIds().length} / 3`));
    status.append(this.statusPill('后备', `${this.reserveIds().length} / 3`));

    header.append(title, status);
    return header;
  }

  private renderCandidateList() {
    const panel = element('section', 'prebattle-panel candidate-panel');
    panel.append(sectionTitle('候选精灵'));

    const list = element('div', 'candidate-list');
    this.config.creatureConfig.forEach((spirit) => {
      const slotIndex = this.lineupSlots.indexOf(spirit.id);
      const isSelected = slotIndex >= 0;
      const selectedGroupClass = isSelected ? (slotIndex < STARTER_SLOT_COUNT ? ' is-starter' : ' is-reserve') : '';
      const card = button('', `candidate-card${isSelected ? ' is-selected' : ''}${selectedGroupClass}${this.focusedId === spirit.id ? ' is-focused' : ''}`, () => {
        this.focusedId = spirit.id;
        this.render();
      });
      card.draggable = true;
      card.dataset.spiritId = spirit.id;
      card.style.setProperty('--accent', spirit.accent);
      card.addEventListener('dragstart', (event) => {
        this.draggingCandidateId = spirit.id;
        this.draggingSlotIndex = null;
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('application/x-spirit-id', spirit.id);
          event.dataTransfer.setData('text/plain', `spirit:${spirit.id}`);
        }
        card.classList.add('is-dragging');
      });
      card.addEventListener('dragend', () => {
        this.draggingCandidateId = null;
        card.classList.remove('is-dragging');
        this.root.querySelectorAll('.roster-slot.is-drop-target').forEach((node) => node.classList.remove('is-drop-target'));
      });
      card.append(this.renderMiniAvatar(spirit));
      card.append(textEl('strong', '', spirit.name));

      const meta = element('div', 'candidate-meta');
      const tags = element('div', 'candidate-tags');
      tags.append(textEl('span', positionTagClass(spirit.defaultPosition), positionLabel(spirit.defaultPosition)));
      if (isSelected) {
        tags.append(textEl('span', `selected-tag lineup-tag ${slotIndex < STARTER_SLOT_COUNT ? 'is-starter' : 'is-reserve'}`, this.rosterLocation(spirit.id)));
      }
      meta.append(tags);
      card.append(meta);
      list.append(card);
    });

    panel.append(list);
    return panel;
  }

  private renderDetailPanel(spirit: SpiritData) {
    const panel = element('section', 'prebattle-panel detail-prebattle-panel');
    panel.style.setProperty('--accent', spirit.accent);

    const head = element('div', 'spirit-detail-head');
    const chip = element('div', 'unit-chip');
    chip.style.setProperty('--accent', spirit.accent);
    chip.textContent = spirit.name.slice(0, 1);
    const title = element('div', '');
    title.append(textEl('h2', '', spirit.name));
    title.append(textEl('p', '', spirit.shortDescription));
    head.append(chip, title);
    panel.append(head);

    const stats = element('div', 'spirit-stat-grid');
    stats.append(this.metaBlock('生命', String(spirit.maxHp)));
    stats.append(this.metaBlock('物攻', String(spirit.physicalAttack)));
    stats.append(this.metaBlock('物防', String(spirit.physicalDefense)));
    stats.append(this.metaBlock('速度', String(spirit.speed)));
    stats.append(this.metaBlock('魔攻', String(spirit.magicAttack)));
    stats.append(this.metaBlock('魔防', String(spirit.magicDefense)));
    panel.append(stats);

    panel.append(sectionTitle('技能'));
    const skills = element('div', 'prebattle-skill-list');
    spirit.skillIds.forEach((skillId) => {
      const skill = this.config.skillConfig[skillId];
      if (!skill) return;
      const row = element('article', 'prebattle-skill-card');
      row.append(textEl('strong', '', skill.name));
      row.append(renderSkillMeta(skill));
      row.append(renderSkillDescription(skill));
      skills.append(row);
    });
    panel.append(skills);

    const action = button(this.isInLineup(spirit.id) ? '移出出战' : '加入出战', 'primary-button full', () => {
      this.toggleSelection(spirit.id);
    });
    panel.append(action);
    return panel;
  }

  private renderTeamPreview() {
    const panel = element('section', 'prebattle-panel team-preview-panel');
    panel.append(sectionTitle('出战队伍预览'));

    const summary = element('div', 'preview-summary');
    summary.append(this.metaBlock('已选择', `${this.lineupIds().length} / ${this.selectionLimit()}`));
    summary.append(this.metaBlock('可开始', this.canStart() ? '可以' : `首发至少 ${this.requiredSelection()} 只`));
    panel.append(summary);

    panel.append(textEl('h3', '', '首发'));
    panel.append(this.renderRosterGrid('starter'));

    if (this.starterIds().length >= STARTER_SLOT_COUNT && !this.starterIds().some((id) => this.spiritById(id).defaultPosition === 'front')) {
      panel.append(textEl('p', 'risk-note', '当前初始登场没有默认前排，Boss 可能直接攻击后排。'));
    }

    panel.append(textEl('h3', '', '后备'));
    panel.append(this.renderRosterGrid('reserve'));
    panel.append(this.renderQuickBattleButton());

    const start = button('选择副本', 'primary-button start-battle-button', () => {
      if (!this.canStart()) {
        this.notice = `首发至少需要 ${this.requiredSelection()} 只精灵`;
        this.render();
        return;
      }
      this.onStart({
        selectedSpiritIds: this.lineupIds(),
        selectedBossId: this.selectedBossId
      });
    });
    if (!this.canStart()) {
      start.disabled = true;
      start.classList.add('is-disabled');
    }
    panel.append(start);
    const lineupIncomplete = this.lineupIds().length < this.selectionLimit();
    panel.append(textEl(
      'p',
      !this.canStart() || lineupIncomplete ? 'start-hint is-warning' : 'start-hint',
      this.startHintText()
    ));

    return panel;
  }

  private renderQuickBattleButton() {
    return button('一键战斗', 'quick-team-button quick-team-single', () => this.applyRandomQuickTeam());
  }

  private renderRosterGrid(group: RosterGroup) {
    const grid = element('div', `roster-grid ${group === 'starter' ? 'is-starter' : 'is-reserve'}`);
    const offset = group === 'starter' ? 0 : STARTER_SLOT_COUNT;
    for (let slot = 0; slot < STARTER_SLOT_COUNT; slot += 1) {
      grid.append(this.renderRosterSlot(offset + slot, group, slot));
    }
    return grid;
  }

  private renderRosterSlot(orderIndex: number, group: RosterGroup, localIndex: number) {
    const spiritId = this.lineupSlots[orderIndex];
    const slot = element('article', `roster-slot ${group === 'starter' ? 'is-starter' : 'is-reserve'}${spiritId ? ' is-filled' : ''}`);
    slot.dataset.rosterIndex = String(orderIndex);
    slot.append(textEl('span', 'roster-slot-label', `${group === 'starter' ? '首发' : '后备'} ${localIndex + 1}`));
    this.bindRosterDropEvents(slot, orderIndex);

    if (!spiritId) {
      slot.append(textEl('span', 'roster-empty-plus', '+'));
      slot.append(textEl('p', 'muted', '空位'));
      return slot;
    }

    const spirit = this.spiritById(spiritId);
    slot.draggable = true;
    slot.style.setProperty('--accent', spirit.accent);
    slot.addEventListener('dragstart', (event) => {
      this.draggingSlotIndex = orderIndex;
      this.draggingCandidateId = null;
      event.dataTransfer?.setData('text/plain', String(orderIndex));
      event.dataTransfer?.setDragImage(slot, 24, 24);
      slot.classList.add('is-dragging');
    });
    slot.addEventListener('dragend', () => {
      this.draggingSlotIndex = null;
      slot.classList.remove('is-dragging');
      this.root.querySelectorAll('.roster-slot.is-drop-target').forEach((node) => node.classList.remove('is-drop-target'));
    });

    slot.append(this.renderMiniAvatar(spirit));
    slot.append(textEl('strong', '', spirit.name));
    slot.append(textEl('span', `roster-position-tag ${positionTagClass(spirit.defaultPosition)}`, positionLabel(spirit.defaultPosition)));

    const controls = element('div', 'roster-slot-actions');
    controls.append(button('移除', 'mini-action-button is-danger roster-remove-button', () => this.removeSelection(spiritId)));
    slot.append(controls);
    return slot;
  }

  private bindRosterDropEvents(slot: HTMLElement, targetIndex: number) {
    slot.addEventListener('dragover', (event) => {
      const hasCandidateDrag = this.draggingCandidateId !== null;
      const hasRosterDrag = this.draggingSlotIndex !== null && this.draggingSlotIndex !== targetIndex;
      if (!hasCandidateDrag && !hasRosterDrag) return;
      event.preventDefault();
      slot.classList.add('is-drop-target');
    });
    slot.addEventListener('dragleave', () => {
      slot.classList.remove('is-drop-target');
    });
    slot.addEventListener('drop', (event) => {
      event.preventDefault();
      slot.classList.remove('is-drop-target');
      const spiritId = this.draggedCandidateId(event);
      if (spiritId) {
        this.placeCandidateInRoster(spiritId, targetIndex);
        return;
      }
      const rawIndex = event.dataTransfer?.getData('text/plain');
      const sourceIndex = rawIndex ? Number(rawIndex) : this.draggingSlotIndex;
      if (sourceIndex === null || Number.isNaN(sourceIndex)) return;
      this.moveRosterSlot(sourceIndex, targetIndex);
    });
  }

  private metaBlock(label: string, value: string) {
    const block = element('div', 'prebattle-meta');
    block.append(textEl('span', '', label));
    block.append(textEl('strong', '', value));
    return block;
  }

  private statusPill(label: string, value: string) {
    const pill = element('div', 'stat-pill');
    pill.append(textEl('span', '', label));
    pill.append(textEl('strong', '', value));
    return pill;
  }

  private toggleSelection(spiritId: string) {
    this.focusedId = spiritId;
    if (this.isInLineup(spiritId)) {
      this.removeSelection(spiritId);
      return;
    }
    if (this.lineupIds().length >= this.selectionLimit()) return;
    const emptyIndex = this.lineupSlots.findIndex((id) => id === null);
    if (emptyIndex < 0) return;
    this.lineupSlots[emptyIndex] = spiritId;
    this.render();
  }

  private removeSelection(spiritId: string) {
    this.lineupSlots = this.lineupSlots.map((id) => (id === spiritId ? null : id));
    this.render();
  }

  private moveRosterSlot(sourceIndex: number, targetIndex: number) {
    if (sourceIndex === targetIndex) return;
    if (sourceIndex < 0 || sourceIndex >= ROSTER_SLOT_COUNT || targetIndex < 0 || targetIndex >= ROSTER_SLOT_COUNT) return;
    const sourceId = this.lineupSlots[sourceIndex];
    if (!sourceId) return;
    const next = [...this.lineupSlots];
    next[sourceIndex] = next[targetIndex];
    next[targetIndex] = sourceId;
    this.lineupSlots = next;
    this.draggingSlotIndex = null;
    this.render();
  }

  private draggedCandidateId(event: DragEvent) {
    const typedId = event.dataTransfer?.getData('application/x-spirit-id');
    if (typedId) return typedId;
    const rawText = event.dataTransfer?.getData('text/plain') ?? '';
    if (rawText.startsWith('spirit:')) return rawText.slice('spirit:'.length);
    return this.draggingCandidateId;
  }

  private placeCandidateInRoster(spiritId: string, targetIndex: number) {
    if (targetIndex < 0 || targetIndex >= ROSTER_SLOT_COUNT) return;
    const existingIndex = this.lineupSlots.indexOf(spiritId);
    if (existingIndex === targetIndex) {
      this.draggingCandidateId = null;
      return;
    }
    const targetId = this.lineupSlots[targetIndex];
    if (existingIndex < 0 && !targetId && this.lineupIds().length >= this.selectionLimit()) {
      this.notice = `最多只能选择 ${this.selectionLimit()} 只精灵`;
      this.draggingCandidateId = null;
      this.render();
      return;
    }

    const next = [...this.lineupSlots];
    if (existingIndex >= 0) {
      next[existingIndex] = null;
      this.notice = targetId ? '已移动精灵并替换目标格' : '已移动精灵到目标格';
    } else {
      this.notice = targetId ? '已替换目标格精灵' : '已加入目标格';
    }
    next[targetIndex] = spiritId;
    this.lineupSlots = next;
    this.focusedId = spiritId;
    this.draggingCandidateId = null;
    this.render();
  }

  private applyQuickTeam(ids: string[]) {
    this.lineupSlots = Array(ROSTER_SLOT_COUNT).fill(null);
    ids.slice(0, this.selectionLimit()).forEach((id, index) => {
      if (index < ROSTER_SLOT_COUNT) this.lineupSlots[index] = id;
    });
    this.focusedId = ids[0] ?? this.focusedId;
    this.notice = '已随机载入一键战斗组合';
    this.render();
  }

  private applyRandomQuickTeam() {
    this.applyQuickTeam(buildRandomQuickTeam(this.config.creatureConfig, this.selectionLimit()));
  }

  private focusedSpirit() {
    return this.config.creatureConfig.find((item) => item.id === this.focusedId) ?? this.config.creatureConfig[0];
  }

  private spiritById(id: string) {
    const spirit = this.config.creatureConfig.find((item) => item.id === id);
    if (!spirit) throw new Error('Unknown spirit: ' + id);
    return spirit;
  }

  private selectionLimit() {
    return Math.min(ROSTER_SLOT_COUNT, this.config.selectionLimit ?? ROSTER_SLOT_COUNT);
  }

  private requiredSelection() {
    return this.config.requiredSelection ?? 1;
  }

  private isInLineup(spiritId: string) {
    return this.lineupSlots.includes(spiritId);
  }

  private canStart() {
    return this.starterIds().length >= this.requiredSelection();
  }

  private startHintText() {
    if (!this.canStart()) return this.notice;
    if (this.starterIds().length < STARTER_SLOT_COUNT) {
      return '首发未满，空余登场位将保持为空；队伍未满编。';
    }
    if (this.lineupIds().length < this.selectionLimit()) {
      return '队伍未满编，可继续选择副本。';
    }
    return '进入副本选择后再开始战斗。';
  }

  private lineupIds() {
    return this.lineupSlots.filter((id): id is string => Boolean(id));
  }

  private starterIds() {
    return this.lineupSlots.slice(0, STARTER_SLOT_COUNT).filter((id): id is string => Boolean(id));
  }

  private reserveIds() {
    return this.lineupSlots.slice(STARTER_SLOT_COUNT).filter((id): id is string => Boolean(id));
  }

  private rosterLocation(spiritId: string) {
    const index = this.lineupSlots.indexOf(spiritId);
    if (index < 0) return '未上阵';
    return index < STARTER_SLOT_COUNT ? `首发 ${index + 1}` : `后备 ${index - STARTER_SLOT_COUNT + 1}`;
  }

  private renderMiniAvatar(spirit: SpiritData) {
    const avatar = element('span', 'mini-avatar');
    avatar.style.setProperty('--accent', spirit.accent);
    avatar.textContent = spirit.name.slice(0, 1);
    return avatar;
  }
}

function positionLabel(row: Row) {
  return row === 'front' ? '默认前排' : '默认后排';
}

function positionTagClass(row: Row) {
  return `position-tag is-${row}`;
}

function renderSkillMeta(skill: SkillData) {
  const wrap = element('div', 'skill-meta-row');
  wrap.append(textEl('span', 'skill-meta-pill', skill.kind === 'attack' ? '攻击' : '辅助'));
  if (skill.power) wrap.append(textEl('span', 'skill-meta-pill', `威力 ${skill.power}`));
  if (!skill.power && skill.fixedDamage) wrap.append(textEl('span', 'skill-meta-pill', `固定伤害 ${skill.fixedDamage}`));
  if (skill.costAllMana) wrap.append(manaIconGroup('cost', null, '全部妖力'));
  if (skill.cost > 0) wrap.append(manaIconGroup('cost', skill.cost));
  if (skill.gain > 0) wrap.append(manaIconGroup('gain', skill.gain));
  if (skill.restoreManaTo !== undefined) wrap.append(manaIconGroup('gain', null, `恢复至 ${skill.restoreManaTo}`));
  if (skill.cooldown && skill.cooldown > 0) wrap.append(textEl('span', 'skill-meta-pill', `CD ${skill.cooldown}`));
  return wrap;
}

function manaIconGroup(kind: 'cost' | 'gain', count: number | null, label?: string) {
  const group = element('span', `mana-icon-group ${kind === 'cost' ? 'is-cost' : 'is-gain'}`);
  group.append(element('span', 'mana-icon-cell'));
  group.append(textEl('span', 'mana-icon-more', count === null ? `*${label ?? ''}` : `*${count}`));
  return group;
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
