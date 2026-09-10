import type { SkillData, SpiritData } from './types';

export const TEAM_MANA_MAX = 10;
export const TEAM_MANA_INITIAL = 0;
export const BASE_ACTION_SPEED = 40;

export const SPIRITS: SpiritData[] = [
  {
    id: 'P01',
    sourceId: 'M01',
    name: '炽刃狐',
    primaryRole: 'attack',
    maxHp: 257,
    physicalAttack: 150,
    magicAttack: 90,
    physicalDefense: 79,
    magicDefense: 83,
    speed: 150,
    skillIds: ['M01-S1', 'M01-S2', 'M01-S3'],
    accent: '#dc5a3d',
    defaultPosition: 'back',
    shortDescription: '高速物理爆发，通过连续使用降低炽能连斩费用。',
    battleStyle: '迅爪零费输出，炽能连斩形成连续减费，烈斩爆发负责高额暴击。',
    playTip: '连续使用炽能连斩可逐次降低实际费用。'
  },
  {
    id: 'P02',
    sourceId: 'M02',
    name: '逐风隼',
    primaryRole: 'attack',
    secondaryRole: 'protect',
    maxHp: 279,
    physicalAttack: 131,
    magicAttack: 83,
    physicalDefense: 87,
    magicDefense: 85,
    speed: 138,
    skillIds: ['M02-S1', 'M02-S2', 'M02-S3'],
    accent: '#4287a8',
    defaultPosition: 'front',
    shortDescription: '通过迎击积累爆发，再用风暴突袭兑现暴击。',
    battleStyle: '风切与蓄势迎击积累爆发，风暴突袭在爆发状态下必定暴击。',
    playTip: '先获得爆发，再使用风暴突袭。'
  },
  {
    id: 'P03',
    sourceId: 'M03',
    name: '烈芽猿',
    primaryRole: 'attack',
    secondaryRole: 'recover',
    maxHp: 246,
    physicalAttack: 86,
    magicAttack: 135,
    physicalDefense: 99,
    magicDefense: 91,
    speed: 140,
    skillIds: ['M03-S1', 'M03-S2', 'M03-S3'],
    accent: '#d9783f',
    defaultPosition: 'front',
    shortDescription: '兼顾魔法输出、自我修复与单体持续回复。',
    battleStyle: '烈芽打击维持自身血线，生机播种提供回复，健康时用繁盛爆弹暴击。',
    playTip: '生命高于一半时，繁盛爆弹必定暴击。'
  },
  {
    id: 'P04',
    sourceId: 'M04',
    name: '震岳獾',
    primaryRole: 'protect',
    secondaryRole: 'attack',
    maxHp: 409,
    physicalAttack: 76,
    magicAttack: 68,
    physicalDefense: 126,
    magicDefense: 106,
    speed: 77,
    skillIds: ['M04-S1', 'M04-S2', 'M04-S3'],
    accent: '#8b6d62',
    defaultPosition: 'front',
    shortDescription: '积累护盾并将当前护盾值转化为固定伤害。',
    battleStyle: '震击和岩壁守护积累护盾，盾压在不消耗护盾的前提下追加等额固定伤害。',
    playTip: '盾压确认时记录护盾值，结算不会消耗护盾。'
  },
  {
    id: 'P05',
    sourceId: 'M05',
    name: '苔壳龟',
    primaryRole: 'protect',
    secondaryRole: 'recover',
    maxHp: 383,
    physicalAttack: 63,
    magicAttack: 56,
    physicalDefense: 139,
    magicDefense: 128,
    speed: 72,
    skillIds: ['M05-S1', 'M05-S2', 'M05-S3'],
    accent: '#4d8968',
    defaultPosition: 'front',
    shortDescription: '通过群体护盾和自我回复稳定团队血线。',
    battleStyle: '苔甲冲撞提供低量群盾，缩壳回春自救，苍苔壁垒提供高量群盾。',
    playTip: '根据队伍压力选择自疗或群体护盾。'
  },
  {
    id: 'P06',
    sourceId: 'M06',
    name: '铁甲犀',
    primaryRole: 'protect',
    secondaryRole: 'energy',
    maxHp: 428,
    physicalAttack: 77,
    magicAttack: 64,
    physicalDefense: 127,
    magicDefense: 117,
    speed: 64,
    skillIds: ['M06-S1', 'M06-S2', 'M06-S3'],
    accent: '#2f7c67',
    defaultPosition: 'front',
    shortDescription: '兼顾回能、定点护盾与群体盾阵。',
    battleStyle: '蓄能冲撞补充妖力，铁壁援护提供定点护盾，能量转移让全队护盾跨行动保留。',
    playTip: '先建立护盾，再用能量转移延长整队护盾价值。'
  },
  {
    id: 'P07',
    sourceId: 'M07',
    name: '月玲灵',
    primaryRole: 'recover',
    secondaryRole: 'attack',
    maxHp: 181,
    physicalAttack: 74,
    magicAttack: 123,
    physicalDefense: 115,
    magicDefense: 115,
    speed: 138,
    skillIds: ['M07-S1', 'M07-S2', 'M07-S3'],
    accent: '#bd6686',
    defaultPosition: 'back',
    shortDescription: '以群体治疗维持队伍，并可消耗生命换取魔法爆发。',
    battleStyle: '月露微光小幅群疗，蚀月爆弹以生命换伤害，满月甘霖负责紧急修复。',
    playTip: '蚀月爆弹会消耗自身生命，但最低保留 1 点生命。'
  },
  {
    id: 'P08',
    sourceId: 'M08',
    name: '守铃鹿',
    primaryRole: 'recover',
    secondaryRole: 'protect',
    maxHp: 249,
    physicalAttack: 59,
    magicAttack: 70,
    physicalDefense: 135,
    magicDefense: 141,
    speed: 110,
    skillIds: ['M08-S1', 'M08-S2', 'M08-S3'],
    accent: '#527fa0',
    defaultPosition: 'back',
    shortDescription: '提供前排治疗、群体回复和入场首次定点保护。',
    battleStyle: '铃音守护修复前排，鹿鸣回春铺设群体持续回复，灵铃庇佑保护单体。',
    playTip: '每次入场后的第一次技能若选择灵铃庇佑，该技能实际费用为 0。'
  },
  {
    id: 'P09',
    sourceId: 'M09',
    name: '引雷貂',
    primaryRole: 'energy',
    secondaryRole: 'attack',
    maxHp: 284,
    physicalAttack: 90,
    magicAttack: 150,
    physicalDefense: 90,
    magicDefense: 90,
    speed: 120,
    skillIds: ['M09-S1', 'M09-S2', 'M09-S3'],
    accent: '#7159a7',
    defaultPosition: 'back',
    shortDescription: '快速补充团队妖力，并通过易伤放大后续输出。',
    battleStyle: '引雷蓄能回妖，感电标记施加易伤，雷霆贯击负责高威力魔法伤害。',
    playTip: '先施加易伤，再集中使用高威力技能。'
  },
  {
    id: 'P10',
    sourceId: 'M10',
    name: '星甲貘',
    primaryRole: 'energy',
    secondaryRole: 'protect',
    maxHp: 421,
    physicalAttack: 75,
    magicAttack: 90,
    physicalDefense: 118,
    magicDefense: 118,
    speed: 68,
    skillIds: ['M10-S1', 'M10-S2', 'M10-S3'],
    accent: '#6577a4',
    defaultPosition: 'front',
    shortDescription: '通过固定伤害、护盾和首次免费回流调节团队资源。',
    battleStyle: '星辉充能小幅回妖，星甲冲击提供固定伤害与护盾，星能回流进行大额资源循环。',
    playTip: '星能回流本场第一次使用为 0 费，之后恢复为 5 费。'
  },
  {
    id: 'P11', sourceId: 'M11', name: '酒秀才', element: '水', roleSystem: 'concept',
    primaryRole: 'recover', secondaryRole: 'support', maxHp: 285, physicalAttack: 70, magicAttack: 90,
    physicalDefense: 100, magicDefense: 110, speed: 135, skillIds: ['M11-S1', 'M11-S2', 'M11-S3'],
    accent: '#6aa9d8', defaultPosition: 'back', shortDescription: '兼具治疗与爆发层数支援的水系后排。',
    battleStyle: '以醉墨点波维持前排，用温酒回春救急，并通过满觞壮行支援主攻手。',
    playTip: '满觞壮行的爆发层数会在目标下次攻击时全部消耗。'
  },
  {
    id: 'P12', sourceId: 'M12', name: '僧帽菇', element: '木', roleSystem: 'concept',
    primaryRole: 'protect', secondaryRole: 'support', maxHp: 360, physicalAttack: 80, magicAttack: 70,
    physicalDefense: 120, magicDefense: 120, speed: 90, skillIds: ['M12-S1', 'M12-S2', 'M12-S3'],
    accent: '#73a66b', defaultPosition: 'front', shortDescription: '能够生成并延长护盾持续时间的木系前排。',
    battleStyle: '先建立护盾，再用孢息续甲延长关键目标的护盾持续时间。',
    playTip: '孢息续甲只能选择当前持有护盾的友方。'
  },
  {
    id: 'P13', sourceId: 'M13', name: '馋猫', element: '火', roleSystem: 'concept',
    primaryRole: 'attack', secondaryRole: 'attack', maxHp: 285, physicalAttack: 145, magicAttack: 70,
    physicalDefense: 85, magicDefense: 90, speed: 115, skillIds: ['M13-S1', 'M13-S2', 'M13-S3'],
    accent: '#d86d4f', defaultPosition: 'back', shortDescription: '依靠高倍率必暴技能完成收割的火系物理输出。',
    battleStyle: '以低费物理攻击周转妖力，积攒资源释放饕焰盛宴。',
    playTip: '饕焰盛宴必定暴击，适合集中资源完成斩杀。'
  },
  {
    id: 'P14', sourceId: 'M14', name: '响蝠', element: '金', roleSystem: 'concept',
    primaryRole: 'attack', secondaryRole: 'attack', maxHp: 270, physicalAttack: 70, magicAttack: 130,
    physicalDefense: 85, magicDefense: 95, speed: 130, skillIds: ['M14-S1', 'M14-S2', 'M14-S3'],
    accent: '#b2a06d', defaultPosition: 'back', shortDescription: '先叠爆发、再用条件必暴兑现伤害的金系法攻。',
    battleStyle: '回响蓄鸣快速叠加爆发，随后以震金绝响一次性消耗并必定暴击。',
    playTip: '非攻击技能不会消耗爆发层数。'
  },
  {
    id: 'P15', sourceId: 'M15', name: '望月鹿·雄性', element: '土', roleSystem: 'concept',
    primaryRole: 'protect', secondaryRole: 'attack', maxHp: 375, physicalAttack: 100, magicAttack: 70,
    physicalDefense: 115, magicDefense: 100, speed: 90, skillIds: ['M15-S1', 'M15-S2', 'M15-S3'],
    accent: '#9b8060', defaultPosition: 'front', shortDescription: '将当前护盾转化为额外固定伤害的土系前排。',
    battleStyle: '先通过磐月重铠积累护盾，再用护势崩岩把护盾值转化为额外固定伤害。',
    playTip: '护势崩岩读取护盾快照，但不会消耗护盾。'
  },
  {
    id: 'P16', sourceId: 'M16', name: '望月鹿·雌性', element: '土', roleSystem: 'concept',
    primaryRole: 'recover', secondaryRole: 'protect', maxHp: 330, physicalAttack: 70, magicAttack: 85,
    physicalDefense: 110, magicDefense: 130, speed: 95, skillIds: ['M16-S1', 'M16-S2', 'M16-S3'],
    accent: '#b99575', defaultPosition: 'back', shortDescription: '兼顾自动补低血与定点护盾的土系治疗。',
    battleStyle: '月露轻歌持续补偿最低生命队友，盈月回生在高妖力时强化，月华庇护负责救急。',
    playTip: '盈月回生在扣费前团队妖力至少为 5 时额外治疗 20%。'
  }
];

export const SKILLS: Record<string, SkillData> = {
  'M01-S1': {
    id: 'M01-S1', name: '迅爪', primaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 45, cost: 0, gain: 0,
    description: '对敌方单体造成物理伤害。'
  },
  'M01-S2': {
    id: 'M01-S2', name: '炽能连斩', primaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 90, cost: 3, gain: 0,
    consecutiveUseCostReduction: 1, minimumCost: 0,
    description: '连续使用时费用每次降低 1，最低为 0；使用其他技能后恢复为 3 费。'
  },
  'M01-S3': {
    id: 'M01-S3', name: '烈斩爆发', primaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 250, cost: 6, gain: 0,
    alwaysCrit: true,
    description: '对敌方单体造成物理伤害，本次攻击必定暴击。'
  },
  'M02-S1': {
    id: 'M02-S1', name: '风切', primaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 25, cost: 0, gain: 0,
    addDamageAmpStacks: 1,
    description: '造成物理伤害，自身获得 1 层【爆发】。'
  },
  'M02-S2': {
    id: 'M02-S2', name: '蓄势迎击', primaryBehavior: 'protect', secondaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 60, cost: 1, gain: 0,
    addChargeTurns: 1,
    description: '造成物理伤害，自身获得 1 回合【蓄势】。'
  },
  'M02-S3': {
    id: 'M02-S3', name: '风暴突袭', primaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 100, cost: 3, gain: 0,
    critIfDamageAmp: true,
    description: '造成物理伤害；持有【爆发】时必定暴击。'
  },
  'M03-S1': {
    id: 'M03-S1', name: '烈芽打击', primaryBehavior: 'attack', secondaryBehavior: 'recover', kind: 'attack', damageType: 'magic', target: 'boss', power: 30, cost: 0, gain: 0,
    selfHealPercent: 0.1,
    description: '造成魔法伤害，并恢复自身 10% 最大生命。'
  },
  'M03-S2': {
    id: 'M03-S2', name: '生机播种', primaryBehavior: 'recover', kind: 'support', damageType: 'none', target: 'ally-field', cost: 2, gain: 0,
    addRegenTurns: 4,
    description: '使一个场上存活友方获得 4 回合【回复】。'
  },
  'M03-S3': {
    id: 'M03-S3', name: '繁盛爆弹', primaryBehavior: 'attack', kind: 'attack', damageType: 'magic', target: 'boss', power: 80, cost: 2, gain: 0,
    highHpCritThreshold: 0.5,
    description: '造成魔法伤害；自身生命高于 50% 最大生命时，本次攻击必定暴击。'
  },
  'M04-S1': {
    id: 'M04-S1', name: '震击', primaryBehavior: 'protect', secondaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 30, cost: 0, gain: 0,
    shieldValue: 50,
    description: '造成物理伤害，自身获得 50 护盾。'
  },
  'M04-S2': {
    id: 'M04-S2', name: '盾压', primaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 80, cost: 2, gain: 0,
    bonusDamageFromShield: true,
    description: '造成物理伤害，并追加等于自身当前护盾的固定伤害；护盾不被消耗。'
  },
  'M04-S3': {
    id: 'M04-S3', name: '岩壁守护', primaryBehavior: 'protect', kind: 'support', damageType: 'none', target: 'self', cost: 4, gain: 0,
    shieldValue: 400,
    description: '自身获得 400 护盾。'
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
    id: 'M06-S1', name: '蓄能冲撞', primaryBehavior: 'energy', secondaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 30, cost: 0, gain: 1,
    description: '造成物理伤害，团队获得 1 妖力。'
  },
  'M06-S2': {
    id: 'M06-S2', name: '铁壁援护', primaryBehavior: 'protect', secondaryBehavior: 'recover', kind: 'support', damageType: 'none', target: 'ally-field', cost: 3, gain: 0,
    shieldValue: 200,
    description: '使一个场上存活友方获得 200 护盾。'
  },
  'M06-S3': {
    id: 'M06-S3', name: '能量转移', primaryBehavior: 'protect', kind: 'support', damageType: 'none', target: 'ally-all', cost: 3, gain: 0,
    addShieldGuardTurns: 2,
    description: '我方全体获得 2 回合【盾阵】；持续期间，持有者的护盾不会在正常行动结束后清除。'
  },
  'M07-S1': {
    id: 'M07-S1', name: '月露微光', primaryBehavior: 'recover', secondaryBehavior: 'attack', kind: 'attack', damageType: 'magic', target: 'boss', power: 30, cost: 0, gain: 0,
    teamHealPercent: 0.05,
    description: '造成魔法伤害，我方全体恢复各自 5% 最大生命。'
  },
  'M07-S2': {
    id: 'M07-S2', name: '蚀月爆弹', primaryBehavior: 'attack', kind: 'attack', damageType: 'magic', target: 'boss', power: 100, cost: 2, gain: 0,
    selfHpCostPercent: 0.1,
    description: '伤害结算前消耗自身 10% 最大生命，最低保留 1 生命；随后造成魔法伤害。'
  },
  'M07-S3': {
    id: 'M07-S3', name: '满月甘霖', primaryBehavior: 'recover', kind: 'heal', damageType: 'none', target: 'ally-all', cost: 6, gain: 0,
    teamHealPercent: 0.5,
    description: '我方全体恢复各自 50% 最大生命。'
  },
  'M08-S1': {
    id: 'M08-S1', name: '铃音守护', primaryBehavior: 'recover', secondaryBehavior: 'attack', kind: 'attack', damageType: 'magic', target: 'boss', power: 25, cost: 0, gain: 0,
    frontHealPercent: 0.08,
    description: '造成魔法伤害，我方当前前排恢复 8% 最大生命。'
  },
  'M08-S2': {
    id: 'M08-S2', name: '鹿鸣回春', primaryBehavior: 'recover', kind: 'support', damageType: 'none', target: 'ally-all', cost: 5, gain: 0,
    addRegenTurns: 4,
    description: '我方全体获得 4 回合【回复】。'
  },
  'M08-S3': {
    id: 'M08-S3', name: '灵铃庇佑', primaryBehavior: 'recover', secondaryBehavior: 'protect', kind: 'support', damageType: 'none', target: 'ally-field', cost: 3, gain: 0,
    healFlatValue: 100, shieldValue: 100, firstSkillAfterEntryCostReduction: 3,
    description: '一个场上存活友方恢复 100 生命并获得 100 护盾；每次入场后的第一次技能若选择本技能，实际费用降低 3。'
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
    addBossVulnerabilityTurns: 2,
    description: '使敌方单体获得 2 回合【易伤】。'
  },
  'M10-S1': {
    id: 'M10-S1', name: '星辉充能', primaryBehavior: 'energy', secondaryBehavior: 'attack', kind: 'attack', damageType: 'magic', target: 'boss', power: 30, cost: 0, gain: 1,
    description: '造成魔法伤害，团队获得 1 妖力。'
  },
  'M10-S2': {
    id: 'M10-S2', name: '星甲冲击', primaryBehavior: 'protect', secondaryBehavior: 'attack', kind: 'attack', damageType: 'fixed', target: 'boss', cost: 3, gain: 0,
    fixedDamage: 200, shieldValue: 100,
    description: '对敌方单体造成 200 固定伤害，自身获得 100 护盾；固定伤害不读取攻防且不暴击。'
  },
  'M10-S3': {
    id: 'M10-S3', name: '星能回流', primaryBehavior: 'energy', kind: 'support', damageType: 'none', target: 'team-mana', cost: 5, gain: 5,
    firstUseInBattleCostReduction: 5,
    description: '团队获得 5 妖力；本场第一次使用实际费用为 0，后续恢复为 5 费。'
  },
  'M11-S1': { id: 'M11-S1', name: '醉墨点波', primaryBehavior: 'attack', secondaryBehavior: 'recover', kind: 'attack', damageType: 'magic', target: 'boss', power: 30, cost: 0, gain: 0, frontHealPercent: 0.05, description: '造成魔法伤害，我方当前前排恢复 5% 最大生命。' },
  'M11-S2': { id: 'M11-S2', name: '温酒回春', primaryBehavior: 'recover', kind: 'heal', damageType: 'none', target: 'ally-field', cost: 1, gain: 0, healPercent: 0.3, description: '使一个场上存活友方恢复 30% 最大生命。' },
  'M11-S3': { id: 'M11-S3', name: '满觞壮行', primaryBehavior: 'support', kind: 'support', damageType: 'none', target: 'ally-field', cost: 1, gain: 0, addDamageAmpStacks: 3, description: '使一个场上存活友方获得 3 层【爆发】。' },
  'M12-S1': { id: 'M12-S1', name: '伞盖冲撞', primaryBehavior: 'protect', secondaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 30, cost: 0, gain: 0, shieldValue: 30, description: '造成物理伤害，自身获得 30 护盾。' },
  'M12-S2': { id: 'M12-S2', name: '菌甲层生', primaryBehavior: 'protect', kind: 'support', damageType: 'none', target: 'self', cost: 2, gain: 0, shieldValue: 200, description: '自身获得 200 护盾。' },
  'M12-S3': { id: 'M12-S3', name: '孢息续甲', primaryBehavior: 'support', kind: 'support', damageType: 'none', target: 'ally-field', cost: 3, gain: 0, requiresTargetShield: true, extendShieldDurationActions: 1, description: '使一个持有护盾的场上友方，其护盾持续时间延长 1 次普通行动。' },
  'M13-S1': { id: 'M13-S1', name: '馋爪突袭', primaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 45, cost: 0, gain: 0, description: '对敌方单体造成物理伤害。' },
  'M13-S2': { id: 'M13-S2', name: '炽尾扑食', primaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 105, cost: 2, gain: 0, description: '对敌方单体造成物理伤害。' },
  'M13-S3': { id: 'M13-S3', name: '饕焰盛宴', primaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 130, cost: 5, gain: 0, alwaysCrit: true, description: '对敌方单体造成物理伤害，本次攻击必定暴击。' },
  'M14-S1': { id: 'M14-S1', name: '鸣刃突袭', primaryBehavior: 'attack', kind: 'attack', damageType: 'magic', target: 'boss', power: 45, cost: 0, gain: 0, description: '对敌方单体造成魔法伤害。' },
  'M14-S2': { id: 'M14-S2', name: '回响蓄鸣', primaryBehavior: 'attack', kind: 'attack', damageType: 'magic', target: 'boss', power: 25, cost: 1, gain: 0, addDamageAmpStacks: 2, description: '造成魔法伤害，自身获得 2 层【爆发】。' },
  'M14-S3': { id: 'M14-S3', name: '震金绝响', primaryBehavior: 'attack', kind: 'attack', damageType: 'magic', target: 'boss', power: 80, cost: 2, gain: 0, critIfDamageAmp: true, description: '造成魔法伤害；持有【爆发】时必定暴击。' },
  'M15-S1': { id: 'M15-S1', name: '月角磐击', primaryBehavior: 'protect', secondaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 30, cost: 0, gain: 0, shieldValue: 30, description: '造成物理伤害，自身获得 30 护盾。' },
  'M15-S2': { id: 'M15-S2', name: '磐月重铠', primaryBehavior: 'protect', kind: 'support', damageType: 'none', target: 'self', cost: 4, gain: 0, shieldValue: 300, description: '自身获得 300 护盾。' },
  'M15-S3': { id: 'M15-S3', name: '护势崩岩', primaryBehavior: 'attack', kind: 'attack', damageType: 'physical', target: 'boss', power: 20, cost: 3, gain: 0, bonusDamageFromShield: true, description: '造成物理伤害，并追加等于自身当前护盾的固定伤害；护盾不被消耗。' },
  'M16-S1': { id: 'M16-S1', name: '月露轻歌', primaryBehavior: 'recover', secondaryBehavior: 'attack', kind: 'attack', damageType: 'magic', target: 'boss', power: 20, cost: 0, gain: 0, lowestHpAllyHealPercent: 0.08, description: '造成魔法伤害，并使生命比例最低的场上友方恢复 8% 最大生命。' },
  'M16-S2': { id: 'M16-S2', name: '盈月回生', primaryBehavior: 'recover', kind: 'heal', damageType: 'none', target: 'ally-field', cost: 2, gain: 0, healPercent: 0.2, enhanceRules: [{ condition: { type: 'team_mana_at_least', value: 5 }, reason: '扣费前团队妖力至少为 5', value: '额外治疗目标 20% 最大生命', checkTiming: 'confirmation', effect: { healPercentBonus: 0.2 } }], description: '使一个场上存活友方恢复 20% 最大生命；扣费前团队妖力至少为 5 时，再额外恢复 20%。' },
  'M16-S3': { id: 'M16-S3', name: '月华庇护', primaryBehavior: 'recover', secondaryBehavior: 'protect', kind: 'support', damageType: 'none', target: 'ally-field', cost: 4, gain: 0, healFlatValue: 100, shieldValue: 100, description: '使一个场上存活友方恢复 100 生命并获得 100 护盾。' }
};
