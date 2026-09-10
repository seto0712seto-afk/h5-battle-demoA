import type { BattleSystemConfig } from './battleSystems';
import { DEFAULT_RANDOM_DUNGEON_SEED, DUNGEON_RANDOM, STAGES, stageById } from './stages';
import type { BossId, StageConfig, StageEnemyConfig } from './types';

type StageSelectHandler = (stage: StageConfig) => void;

export class StageSelectUI {
  private selectedStageId = STAGES[0]?.id ?? '';
  private randomSeed = DEFAULT_RANDOM_DUNGEON_SEED;

  constructor(
    private root: HTMLElement,
    private config: BattleSystemConfig,
    private selectedSpiritIds: string[],
    private onSelect: StageSelectHandler,
    private onBack: () => void
  ) {}

  mount() {
    this.render();
  }

  private render() {
    this.root.innerHTML = '';
    const shell = element('main', 'stage-select-shell');
    shell.append(this.renderHeader());

    const layout = element('section', 'stage-select-layout');
    layout.append(this.renderStageMenu());
    layout.append(this.renderStageDetail());
    shell.append(layout);

    this.root.append(shell);
  }

  private renderHeader() {
    const header = element('header', 'topbar prebattle-topbar');
    const title = element('div', 'title-block');
    title.append(textEl('span', 'eyebrow', 'PVE Boss 战'));
    title.append(textEl('h1', '', '选择副本'));

    const status = element('div', 'top-status');
    status.append(this.statusPill('已选精灵', `${this.selectedSpiritIds.length} 只`));
    status.append(this.statusPill('首发', this.selectedSpiritIds.slice(0, 3).map((id) => this.spiritName(id)).join(' / ') || '--'));
    status.append(button('返回阵容', 'ghost-button compact', this.onBack));
    header.append(title, status);
    return header;
  }

  private renderStageMenu() {
    const panel = element('section', 'prebattle-panel stage-menu-panel');
    panel.append(sectionTitle('副本菜单'));

    const list = element('div', 'stage-menu-list');
    STAGES.forEach((stage, index) => {
      const selected = stage.id === this.selectedStageId;
      const item = button('', `stage-menu-item${selected ? ' is-selected' : ''}`, () => {
        this.selectedStageId = stage.id;
        this.render();
      });
      item.append(textEl('span', 'stage-index', String(index + 1)));
      const body = element('div', 'stage-menu-body');
      body.append(textEl('strong', '', stage.name));
      body.append(textEl('span', '', stage.carryOverPlayerState ? `${stage.battles.length} 场连续战斗` : '单场 Boss 战'));
      item.append(body);
      item.append(this.renderStageBadges(stage));
      list.append(item);
    });

    panel.append(list);
    return panel;
  }

  private renderStageDetail() {
    const stage = this.selectedStage();
    const panel = element('section', 'prebattle-panel stage-detail-panel');

    const head = element('div', 'stage-detail-head');
    const title = element('div', 'stage-detail-title');
    title.append(this.renderStageBadges(stage));
    title.append(textEl('h2', '', stage.name));
    title.append(textEl('p', '', stage.description));
    head.append(title);
    panel.append(head);

    const meta = element('div', 'stage-detail-meta');
    meta.append(this.metaBlock('战斗场次', `${stage.battles.length}`));
    meta.append(this.metaBlock('连续战斗', stage.carryOverPlayerState ? '是' : '否'));
    meta.append(this.metaBlock('玩家状态继承', stage.carryOverPlayerState ? '继承' : '不继承'));
    panel.append(meta);

    if (stage.id === DUNGEON_RANDOM) {
      const seedRow = element('label', 'stage-seed-row');
      seedRow.append(textEl('span', '', '阵容 Seed'));
      const input = element('input', 'stage-seed-input');
      input.type = 'number';
      input.value = String(this.randomSeed);
      input.addEventListener('change', () => {
        const parsed = Number.parseInt(input.value, 10);
        this.randomSeed = Number.isFinite(parsed) ? parsed : DEFAULT_RANDOM_DUNGEON_SEED;
        this.render();
      });
      seedRow.append(input);
      panel.append(seedRow);
    }

    panel.append(sectionTitle('战斗内容'));
    const battles = element('div', 'stage-battle-list');
    stage.battles.forEach((battle, index) => {
      const row = element('article', 'stage-battle-row');
      row.append(textEl('strong', '', `第 ${index + 1} 场`));
      row.append(textEl('span', '', battle.enemies.map((enemy) => `${this.bossName(enemy)} ×1`).join(' / ')));
      if (battle.targetRounds) row.append(textEl('span', '', `目标 ${battle.targetRounds[0]}～${battle.targetRounds[1]} 回合`));
      battle.notes?.forEach((note) => row.append(textEl('span', '', `备注：${note}`)));
      battles.append(row);
    });
    panel.append(battles);
    panel.append(this.renderEnemyIntel(stage));

    const rule = element('div', 'stage-rule-box');
    if (stage.carryOverPlayerState) {
      rule.append(textEl('strong', '', '连战规则'));
      rule.append(textEl('p', '', '每场胜利后保留当前登场阵容、前后排、生命、阵亡情况和团队妖力；清除临时状态、冷却与战斗内成长，下一场不会恢复为初始首发。'));
    } else {
      rule.append(textEl('strong', '', '关卡规则'));
      rule.append(textEl('p', '', '击败当前场全部敌人后完成副本。'));
    }
    panel.append(rule);

    panel.append(button('开始挑战', 'primary-button full stage-enter-button', () => this.onSelect(stage)));
    return panel;
  }

  private renderStageBadges(stage: StageConfig) {
    const badges = element('span', 'stage-badge-group');
    badges.append(textEl('span', stage.carryOverPlayerState ? 'stage-badge is-chain' : 'stage-badge', stage.carryOverPlayerState ? '连战' : '单场'));
    if (stage.carryOverPlayerState) {
      const testingBadge = textEl('span', 'stage-badge is-testing', '测试中');
      testingBadge.title = '当前为测试内容，规则与数值尚未正式确定';
      badges.append(testingBadge);
    }
    return badges;
  }

  private renderEnemyIntel(stage: StageConfig) {
    const section = element('section', 'stage-enemy-intel-section');
    section.append(sectionTitle('敌方技能情报'));
    const list = element('div', 'stage-enemy-intel-list');
    const enemyIds = [...new Set(stage.battles.flatMap((battle) => battle.enemies.map(stageEnemyId)))];

    enemyIds.forEach((enemyId, index) => {
      const boss = this.config.bossConfigsById?.[enemyId];
      if (!boss) return;
      const details = element('details', 'stage-enemy-intel');
      details.open = enemyIds.length === 1 || index === 0;
      const summary = element('summary', 'stage-enemy-intel-summary');
      summary.append(textEl('strong', '', boss.display?.displayName ?? boss.name));
      summary.append(textEl('span', '', `${boss.display?.previewSkills.length ?? 0} 个技能`));
      details.append(summary);

      const skills = element('div', 'boss-prebattle-skill-list');
      boss.display?.previewSkills.forEach((skill) => {
        const card = element('article', 'boss-prebattle-skill-card');
        card.append(textEl('strong', '', skill.name));
        const meta = element('div', 'skill-meta-row');
        meta.append(textEl('span', 'skill-meta-pill', skill.behaviorCategory));
        if (skill.element) meta.append(textEl('span', 'skill-meta-pill', `${skill.element}系`));
        meta.append(textEl('span', 'skill-meta-pill', skill.targetDescription));
        if (skill.damageTypeDescription) meta.append(textEl('span', 'skill-meta-pill', skill.damageTypeDescription));
        if (skill.power !== undefined) meta.append(textEl('span', 'skill-meta-pill', `威力 ${skill.power}`));
        meta.append(textEl('span', 'skill-meta-pill', `CD ${skill.cooldown}`));
        if (skill.telegraphFollowupName) {
          meta.append(textEl('span', 'skill-meta-pill is-telegraph', `预告后：${skill.telegraphFollowupName}`));
        }
        card.append(meta);
        card.append(textEl('p', 'skill-description', skill.description));
        skills.append(card);
      });
      details.append(skills);
      list.append(details);
    });

    section.append(list);
    return section;
  }

  private selectedStage() {
    return stageById(this.selectedStageId, this.randomSeed);
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

  private spiritName(id: string) {
    return this.config.creatureConfig.find((spirit) => spirit.id === id)?.name ?? id;
  }

  private bossName(enemy: StageEnemyConfig) {
    const id = stageEnemyId(enemy);
    return this.config.bossConfigsById?.[id]?.display?.displayName ?? this.config.bossConfigsById?.[id]?.name ?? this.config.bossConfig.display?.displayName ?? this.config.bossConfig.name;
  }
}

function stageEnemyId(enemy: StageEnemyConfig): BossId {
  return typeof enemy === 'string' ? enemy : enemy.enemyId;
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
