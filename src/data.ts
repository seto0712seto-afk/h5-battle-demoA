import type { SkillData, SpiritData } from './types';

export const TEAM_MANA_MAX = 10;
export const TEAM_MANA_INITIAL = 0;
export const BASE_ACTION_SPEED = 40;

export const SPIRITS: SpiritData[] = [
  {
    id: 'P01',
    name: '炽刃狐',
    primaryRole: 'attack',
    maxHp: 262,
    physicalAttack: 133,
    magicAttack: 80,
    physicalDefense: 84,
    magicDefense: 88,
    speed: 130,
    skillIds: ['M01-S1', 'M01-S2', 'M01-S3'],
    accent: '#dc5a3d',
    defaultPosition: 'back',
    shortDescription: '高速物理爆发，通过连续使用降低炽能连斩费用。',
    battleStyle: '迅爪零费输出，炽能连斩形成连续减费，烈斩爆发负责高额暴击。',
    playTip: '连续使用炽能连斩可逐次降低实际费用。'
  },
  {
    id: 'P02',
    name: '逐风隼',
    primaryRole: 'attack',
    secondaryRole: 'protect',
    maxHp: 274,
    physicalAttack: 124,
    magicAttack: 78,
    physicalDefense: 92,
    magicDefense: 89,
    speed: 126,
    skillIds: ['M02-S1', 'M02-S2', 'M02-S3'],
    accent: '#4287a8',
    defaultPosition: 'back',
    shortDescription: '通过迎击积累爆发，再用风暴突袭兑现暴击。',
    battleStyle: '风切与蓄势迎击积累爆发，风暴突袭在爆发状态下必定暴击。',
    playTip: '先获得爆发，再使用风暴突袭。'
  },
  {
    id: 'P03',
    name: '烈芽猿',
    primaryRole: 'attack',
    secondaryRole: 'recover',
    maxHp: 268,
    physicalAttack: 79,
    magicAttack: 124,
    physicalDefense: 98,
    magicDefense: 90,
    speed: 120,
    skillIds: ['M03-S1', 'M03-S2', 'M03-S3'],
    accent: '#d9783f',
    defaultPosition: 'back',
    shortDescription: '兼顾魔法输出、自我修复与单体持续回复。',
    battleStyle: '烈芽打击维持自身血线，生机播种提供回复，健康时用繁盛爆弹暴击。',
    playTip: '生命高于一半时，繁盛爆弹必定暴击。'
  },
  {
    id: 'P04',
    name: '震岳獾',
    primaryRole: 'protect',
    secondaryRole: 'attack',
    maxHp: 383,
    physicalAttack: 83,
    magicAttack: 74,
    physicalDefense: 128,
    magicDefense: 107,
    speed: 83,
    skillIds: ['M04-S1', 'M04-S2', 'M04-S3'],
    accent: '#8b6d62',
    defaultPosition: 'front',
    shortDescription: '积累护盾并将其消耗为固定伤害。',
    battleStyle: '震击和岩壁守护积累护盾，盾压消耗护盾追加等额固定伤害。',
    playTip: '盾压会消耗当前全部护盾，护盾越高追加伤害越高。'
  },
  {
    id: 'P05',
    name: '苔壳龟',
    primaryRole: 'protect',
    secondaryRole: 'recover',
    maxHp: 371,
    physicalAttack: 81,
    magicAttack: 71,
    physicalDefense: 128,
    magicDefense: 118,
    speed: 82,
    skillIds: ['M05-S1', 'M05-S2', 'M05-S3'],
    accent: '#4d8968',
    defaultPosition: 'front',
    shortDescription: '通过群体护盾和自我回复稳定团队血线。',
    battleStyle: '苔甲冲撞提供低量群盾，缩壳回春自救，苍苔壁垒提供高量群盾。',
    playTip: '根据队伍压力选择自疗或群体护盾。'
  },
  {
    id: 'P06',
    name: '铁甲犀',
    primaryRole: 'protect',
    secondaryRole: 'energy',
    maxHp: 385,
    physicalAttack: 87,
    magicAttack: 73,
    physicalDefense: 125,
    magicDefense: 114,
    speed: 77,
    skillIds: ['M06-S1', 'M06-S2', 'M06-S3'],
    accent: '#2f7c67',
    defaultPosition: 'front',
    shortDescription: '兼顾回能、定点护盾与友方技能节能。',
    battleStyle: '蓄能冲撞补充妖力，铁壁援护在妖力达到 5 时额外治疗单体，能量转移降低友方下一次技能费用。',
    playTip: '能量转移不能选择自身，适合交给高费用技能使用者。'
  },
  {
    id: 'P07',
    name: '月玲灵',
    primaryRole: 'recover',
    secondaryRole: 'attack',
    maxHp: 209,
    physicalAttack: 76,
    magicAttack: 126,
    physicalDefense: 104,
    magicDefense: 104,
    speed: 124,
    skillIds: ['M07-S1', 'M07-S2', 'M07-S3'],
    accent: '#bd6686',
    defaultPosition: 'back',
    shortDescription: '以群体治疗维持队伍，并可消耗生命换取魔法爆发。',
    battleStyle: '月露微光小幅群疗，蚀月爆弹以生命换伤害，满月甘霖负责紧急修复。',
    playTip: '蚀月爆弹会消耗自身生命，但最低保留 1 点生命。'
  },
  {
    id: 'P08',
    name: '守铃鹿',
    primaryRole: 'recover',
    secondaryRole: 'protect',
    maxHp: 267,
    physicalAttack: 72,
    magicAttack: 86,
    physicalDefense: 119,
    magicDefense: 124,
    speed: 113,
    skillIds: ['M08-S1', 'M08-S2', 'M08-S3'],
    accent: '#527fa0',
    defaultPosition: 'back',
    shortDescription: '提供前排治疗、群体回复和入场首次定点保护。',
    battleStyle: '铃音守护修复前排，鹿鸣回春同时治疗自身与另一名友方，灵铃庇佑保护单体。',
    playTip: '每次入场后第一次使用灵铃庇佑时，该技能实际费用为 1。'
  },
  {
    id: 'P09',
    name: '引雷貂',
    primaryRole: 'energy',
    secondaryRole: 'attack',
    maxHp: 265,
    physicalAttack: 79,
    magicAttack: 131,
    physicalDefense: 93,
    magicDefense: 93,
    speed: 115,
    skillIds: ['M09-S1', 'M09-S3', 'M09-S2'],
    accent: '#7159a7',
    defaultPosition: 'back',
    shortDescription: '快速补充团队妖力，并通过易伤放大后续输出。',
    battleStyle: '引雷蓄能回妖，感电标记施加易伤，雷霆贯击负责高威力魔法伤害。',
    playTip: '先施加易伤，再集中使用高威力技能。'
  },
  {
    id: 'P10',
    name: '星甲貘',
    primaryRole: 'energy',
    secondaryRole: 'protect',
    maxHp: 378,
    physicalAttack: 75,
    magicAttack: 90,
    physicalDefense: 117,
    magicDefense: 117,
    speed: 77,
    skillIds: ['M10-S1', 'M10-S2', 'M10-S3'],
    accent: '#6577a4',
    defaultPosition: 'front',
    shortDescription: '通过固定伤害、护盾和首次免费回流调节团队资源。',
    battleStyle: '星辉充能小幅回妖，星甲冲击提供固定伤害与护盾，星能回流进行大额资源循环。',
    playTip: '星能回流本场第一次使用为 0 费，之后恢复为 3 费。'
  }
];

export const SKILLS: Record<string, SkillData> = {
  'M01-S1': {
    id: 'M01-S1', name: '迅爪', primaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 45, cost: 0, gain: 0,
    description: '对敌方单体造成物理伤害。'
  },
  'M01-S2': {
    id: 'M01-S2', name: '炽能连斩', primaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 85, cost: 2, gain: 0,
    consecutiveUseCostReduction: 1, minimumCost: 0, resetConsecutiveUseAtMinimumCost: true,
    description: '连续使用时实际费用按 2→1→0 变化；0 费成功释放或使用其他技能后重置为 2。'
  },
  'M01-S3': {
    id: 'M01-S3', name: '烈斩爆发', primaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 180, cost: 6, gain: 0,
    alwaysCrit: true,
    description: '对敌方单体造成物理伤害，本次攻击必定暴击。'
  },
  'M02-S1': {
    id: 'M02-S1', name: '风切', primaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 25, cost: 0, gain: 0,
    addDamageAmpStacks: 1,
    description: '造成物理伤害，自身获得 1 层爆发。'
  },
  'M02-S2': {
    id: 'M02-S2', name: '蓄势迎击', primaryBehavior: 'attack', secondaryBehavior: 'protect', kind: 'attack', damageType: 'physical', target: 'boss', power: 55, cost: 1, gain: 0,
    addChargeTurns: 1,
    description: '造成物理伤害，自身获得 1 回合蓄势。'
  },
  'M02-S3': {
    id: 'M02-S3', name: '风暴突袭', primaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 100, cost: 3, gain: 0,
    critIfDamageAmp: true,
    description: '造成物理伤害；自身存在爆发时，本次攻击必定暴击。'
  },
  'M03-S1': {
    id: 'M03-S1', name: '烈芽打击', primaryBehavior: 'attack', secondaryBehavior: 'recover', kind: 'attack', damageType: 'magic', target: 'boss', power: 25, cost: 0, gain: 0,
    selfHealPercent: 0.08,
    description: '造成魔法伤害，并恢复自身 8% 最大生命。'
  },
  'M03-S2': {
    id: 'M03-S2', name: '生机播种', primaryBehavior: 'recover', kind: 'support', damageType: 'none', target: 'ally-field', cost: 2, gain: 0,
    addRegenTurns: 4,
    description: '使一个场上存活友方获得 4 回合回复；目标每次行动开始时恢复 10% 最大生命。'
  },
  'M03-S3': {
    id: 'M03-S3', name: '繁盛爆弹', primaryBehavior: 'attack', kind: 'attack', damageType: 'magic', target: 'boss', power: 80, cost: 2, gain: 0,
    highHpCritThreshold: 0.5,
    description: '造成魔法伤害；自身生命高于 50% 最大生命时，本次攻击必定暴击。'
  },
  'M04-S1': {
    id: 'M04-S1', name: '震击', primaryBehavior: 'attack', secondaryBehavior: 'protect', kind: 'attack', damageType: 'physical', target: 'boss', power: 30, cost: 0, gain: 0,
    shieldValue: 40,
    description: '造成物理伤害，自身获得 40 护盾。'
  },
  'M04-S2': {
    id: 'M04-S2', name: '盾压', primaryBehavior: 'attack', kind: 'attack', damageType: 'fixed', target: 'boss', cost: 2, gain: 0,
    shieldToFixedDamageRatio: 1,
    description: '确认技能时消耗自身当前全部护盾，并造成等于实际消耗护盾量的固定伤害。'
  },
  'M04-S3': {
    id: 'M04-S3', name: '岩壁守护', primaryBehavior: 'protect', kind: 'support', damageType: 'none', target: 'self', cost: 3, gain: 0,
    shieldValue: 280,
    description: '自身获得 280 护盾。'
  },
  'M05-S1': {
    id: 'M05-S1', name: '苔甲冲撞', primaryBehavior: 'protect', secondaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 20, cost: 0, gain: 0,
    teamShieldValue: 25,
    description: '造成物理伤害，我方全体获得 25 护盾。'
  },
  'M05-S2': {
    id: 'M05-S2', name: '缩壳回春', primaryBehavior: 'recover', kind: 'heal', damageType: 'none', target: 'self', cost: 2, gain: 0,
    healPercent: 0.3,
    description: '恢复自身 30% 最大生命。'
  },
  'M05-S3': {
    id: 'M05-S3', name: '苍苔壁垒', primaryBehavior: 'protect', kind: 'support', damageType: 'none', target: 'ally-all', cost: 4, gain: 0,
    teamShieldValue: 150,
    description: '我方全体获得 150 护盾。'
  },
  'M06-S1': {
    id: 'M06-S1', name: '蓄能冲撞', primaryBehavior: 'energy', secondaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 25, cost: 0, gain: 1,
    description: '造成物理伤害，团队获得 1 妖力。'
  },
  'M06-S2': {
    id: 'M06-S2', name: '铁壁援护', primaryBehavior: 'protect', secondaryBehavior: 'recover', kind: 'support', damageType: 'none', target: 'ally-field', cost: 3, gain: 0,
    shieldValue: 200,
    enhanceRules: [{
      condition: { type: 'team_mana_at_least', value: 5 },
      reason: '技能确认时团队妖力达到 5',
      value: '额外治疗目标 20% 最大生命',
      checkTiming: 'confirmation',
      effect: { healPercentBonus: 0.2 }
    }],
    description: '使一个场上存活友方获得 200 护盾；确认技能时团队妖力达到 5，额外治疗目标 20% 最大生命。'
  },
  'M06-S3': {
    id: 'M06-S3', name: '能量转移', primaryBehavior: 'energy', kind: 'support', damageType: 'none', target: 'ally-field', excludeSelfTarget: true, cost: 1, gain: 0,
    addEnergySaving: true,
    description: '选择自身以外的一个场上存活友方，使其获得节能；目标下一次使用技能时，实际妖力消耗降低 50%（向下取整，最低 0），随后移除节能。'
  },
  'M07-S1': {
    id: 'M07-S1', name: '月露微光', primaryBehavior: 'recover', secondaryBehavior: 'attack', kind: 'attack', damageType: 'magic', target: 'boss', power: 10, cost: 0, gain: 0,
    teamHealPercent: 0.05,
    description: '造成魔法伤害，我方全体恢复各自 5% 最大生命。'
  },
  'M07-S2': {
    id: 'M07-S2', name: '蚀月爆弹', primaryBehavior: 'attack', kind: 'attack', damageType: 'magic', target: 'boss', power: 140, cost: 2, gain: 0,
    selfHpCostPercent: 0.1,
    description: '伤害结算前消耗自身 10% 最大生命，最低保留 1 生命；随后造成魔法伤害。'
  },
  'M07-S3': {
    id: 'M07-S3', name: '满月甘霖', primaryBehavior: 'recover', kind: 'heal', damageType: 'none', target: 'ally-all', cost: 6, gain: 0,
    teamHealPercent: 0.3,
    description: '我方全体恢复各自 30% 最大生命。'
  },
  'M08-S1': {
    id: 'M08-S1', name: '铃音守护', primaryBehavior: 'recover', secondaryBehavior: 'attack', kind: 'attack', damageType: 'magic', target: 'boss', power: 25, cost: 0, gain: 0,
    frontHealPercent: 0.08,
    description: '造成魔法伤害，我方当前前排恢复 8% 最大生命。'
  },
  'M08-S2': {
    id: 'M08-S2', name: '鹿鸣回春', primaryBehavior: 'recover', kind: 'support', damageType: 'none', target: 'ally-field', excludeSelfTarget: true, cost: 4, gain: 0,
    healSelfAndTargetPercent: 0.3,
    description: '选择自身以外的一个场上存活友方，使自身与目标分别恢复 30% 最大生命。'
  },
  'M08-S3': {
    id: 'M08-S3', name: '灵铃庇佑', primaryBehavior: 'recover', secondaryBehavior: 'protect', kind: 'support', damageType: 'none', target: 'ally-field', cost: 4, gain: 0,
    healFlatValue: 150, shieldValue: 150, firstSkillAfterEntryCostReduction: 3,
    description: '一个场上存活友方恢复 150 生命并获得 150 护盾；每次入场后第一次使用本技能时，实际费用为 1。'
  },
  'M09-S1': {
    id: 'M09-S1', name: '引雷蓄能', primaryBehavior: 'energy', kind: 'support', damageType: 'none', target: 'team-mana', cost: 0, gain: 2,
    description: '团队获得 2 妖力。'
  },
  'M09-S2': {
    id: 'M09-S2', name: '雷霆贯击', primaryBehavior: 'attack', kind: 'attack', damageType: 'magic', target: 'boss', power: 200, cost: 5, gain: 0,
    description: '对敌方单体造成魔法伤害。'
  },
  'M09-S3': {
    id: 'M09-S3', name: '感电标记', primaryBehavior: 'attack', kind: 'debuff', damageType: 'none', target: 'boss', cost: 2, gain: 0,
    addBossVulnerabilityTurns: 3,
    description: '使敌方单体获得 3 回合易伤，受到伤害提高 50%。'
  },
  'M10-S1': {
    id: 'M10-S1', name: '星辉充能', primaryBehavior: 'energy', secondaryBehavior: 'attack', kind: 'attack', damageType: 'magic', target: 'boss', power: 20, cost: 0, gain: 1,
    description: '造成魔法伤害，团队获得 1 妖力。'
  },
  'M10-S2': {
    id: 'M10-S2', name: '星甲冲击', primaryBehavior: 'protect', secondaryBehavior: 'attack', kind: 'attack', damageType: 'fixed', target: 'boss', cost: 3, gain: 0,
    fixedDamage: 200, shieldValue: 50,
    description: '对敌方单体造成 200 固定伤害，自身获得 50 护盾；固定伤害不读取攻防且不暴击。'
  },
  'M10-S3': {
    id: 'M10-S3', name: '星能回流', primaryBehavior: 'energy', kind: 'support', damageType: 'none', target: 'team-mana', cost: 3, gain: 4,
    firstUseInBattleCostReduction: 3,
    description: '团队获得 4 妖力；本场第一次使用实际费用为 0，后续恢复为 3 费。'
  }
};
