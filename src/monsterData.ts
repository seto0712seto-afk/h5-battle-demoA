import type { MonsterDefinition, MonsterSkillDefinition } from './monsterTypes';

const skills: Record<string, MonsterSkillDefinition> = {};
const monsters: Record<string, MonsterDefinition> = {};

function addSkill(skill: MonsterSkillDefinition) {
  skills[skill.id] = skill;
  return skill.id;
}

function damageSkill(
  id: string,
  name: string,
  power: number,
  damageType: 'physical' | 'magical',
  targetRule: 'enemy_single' | 'enemy_all',
  description: string
) {
  return addSkill({
    id,
    tier: '怪物技能',
    name,
    behaviorCategory: '攻击',
    cooldown: 0,
    isBasicAttack: power === 50 && targetRule === 'enemy_single',
    execution: { power, damageType, targetRule },
    description
  });
}

function addMonster(definition: MonsterDefinition) {
  monsters[definition.id] = definition;
}

type ThemeEnemyAuthoringDefinition = Pick<
  MonsterDefinition,
  'id' | 'name' | 'level' | 'category' | 'role' | 'defaultPosition' | 'coefficients' | 'baseHp'
>;

type ThemeEnemyDefinitions = {
  gruntWarrior: ThemeEnemyAuthoringDefinition;
  gruntShooter: ThemeEnemyAuthoringDefinition;
  gruntMage: ThemeEnemyAuthoringDefinition;
  eliteWarrior: ThemeEnemyAuthoringDefinition;
  eliteShooter: ThemeEnemyAuthoringDefinition;
  eliteMage: ThemeEnemyAuthoringDefinition;
};

function addThemeEnemies(config: {
  prefix: string;
  enemies: ThemeEnemyDefinitions;
  skills: {
    warriorBasic: string;
    shooterBasic: string;
    mageBasic: string;
    warriorPreview: string;
    shooterArea: string;
    mageGrowth: string;
  };
}) {
  const warriorBasic = damageSkill(
    `${config.prefix}_WARRIOR_BASIC`,
    config.skills.warriorBasic,
    50,
    'physical',
    'enemy_single',
    '对当前合法单体目标造成50物理威力伤害。'
  );
  const shooterBasic = damageSkill(
    `${config.prefix}_SHOOTER_BASIC`,
    config.skills.shooterBasic,
    50,
    'physical',
    'enemy_single',
    '对当前合法单体目标造成50物理威力伤害。'
  );
  const mageBasic = damageSkill(
    `${config.prefix}_MAGE_BASIC`,
    config.skills.mageBasic,
    50,
    'magical',
    'enemy_single',
    '对当前合法单体目标造成50魔法威力伤害。'
  );
  const warriorPreview = addSkill({
    id: `${config.prefix}_ELITE_WARRIOR_PREVIEW`,
    tier: '精英技能',
    name: config.skills.warriorPreview,
    behaviorCategory: '预告攻击',
    cooldown: 0,
    isBasicAttack: false,
    execution: {
      power: 150,
      damageType: 'physical',
      targetRule: 'enemy_single',
      telegraph: {
        enabled: true,
        followupSkillId: `${config.prefix}_ELITE_WARRIOR_PREVIEW`,
        targetSelection: 'random_legal_single_target',
        lockMode: 'unit',
        invalidTargetResult: 'whiff'
      }
    },
    description: '预告并锁定当前合法单体目标；下一次正常行动造成150物理威力伤害，目标失效时落空。'
  });
  const shooterArea = damageSkill(
    `${config.prefix}_ELITE_SHOOTER_AREA`,
    config.skills.shooterArea,
    40,
    'physical',
    'enemy_all',
    '对玩家场上全体分别造成40物理威力伤害。'
  );
  const mageGrowth = addSkill({
    id: `${config.prefix}_ELITE_MAGE_GROWTH`,
    tier: '精英技能',
    name: config.skills.mageGrowth,
    behaviorCategory: '强化',
    cooldown: 0,
    isBasicAttack: false,
    execution: {
      damageType: 'none',
      targetRule: 'self',
      effects: [{ type: 'increase_runtime_skill_power', targetSkillId: mageBasic, amount: 15 }]
    },
    description: `本场战斗中直接使【${config.skills.mageBasic}】当前威力提高15，不创建状态，可无限成长。`
  });

  addMonster({
    ...config.enemies.gruntWarrior,
    skills: [{ skillId: warriorBasic, weight: 100, selectionMode: 'weighted' }]
  });
  addMonster({
    ...config.enemies.gruntShooter,
    skills: [{ skillId: shooterBasic, weight: 100, selectionMode: 'weighted' }]
  });
  addMonster({
    ...config.enemies.gruntMage,
    skills: [{ skillId: mageBasic, weight: 100, selectionMode: 'weighted' }]
  });
  addMonster({
    ...config.enemies.eliteWarrior,
    skills: [
      { skillId: warriorBasic, weight: 67, selectionMode: 'weighted' },
      { skillId: warriorPreview, weight: 33, selectionMode: 'weighted' }
    ]
  });
  addMonster({
    ...config.enemies.eliteShooter,
    skills: [
      { skillId: shooterBasic, weight: 75, selectionMode: 'weighted' },
      { skillId: shooterArea, weight: 25, selectionMode: 'weighted' }
    ]
  });
  addMonster({
    ...config.enemies.eliteMage,
    skills: [
      { skillId: mageBasic, weight: 75, selectionMode: 'weighted' },
      { skillId: mageGrowth, weight: 25, selectionMode: 'forced_opening' }
    ]
  });
}

addThemeEnemies({
  prefix: 'FORGE',
  enemies: {
    gruntWarrior: {
      id: 'FORGE_GRUNT_WARRIOR', name: '熔壳卫兵', level: 1, category: 'minor', role: 'warrior', defaultPosition: 'front',
      coefficients: { physicalAttack: 1, physicalDefense: 1.2, magicAttack: 0, magicDefense: 0.8, speed: 1 }, baseHp: 450
    },
    gruntShooter: {
      id: 'FORGE_GRUNT_SHOOTER', name: '灰羽弩手', level: 1, category: 'minor', role: 'shooter', defaultPosition: 'back',
      coefficients: { physicalAttack: 1.25, physicalDefense: 1, magicAttack: 0, magicDefense: 1, speed: 1 }, baseHp: 300
    },
    gruntMage: {
      id: 'FORGE_GRUNT_MAGE', name: '熔纹术士', level: 1, category: 'minor', role: 'mage', defaultPosition: 'back',
      coefficients: { physicalAttack: 0, physicalDefense: 0.8, magicAttack: 1.25, magicDefense: 1.2, speed: 1 }, baseHp: 300
    },
    eliteWarrior: {
      id: 'FORGE_ELITE_WARRIOR', name: '赤铠督战者', level: 1, category: 'elite', role: 'warrior', defaultPosition: 'front',
      coefficients: { physicalAttack: 1.5, physicalDefense: 1.2, magicAttack: 0, magicDefense: 0.8, speed: 1 }, baseHp: 900
    },
    eliteShooter: {
      id: 'FORGE_ELITE_SHOOTER', name: '焦羽箭卫', level: 1, category: 'elite', role: 'shooter', defaultPosition: 'back',
      coefficients: { physicalAttack: 1.875, physicalDefense: 1, magicAttack: 0, magicDefense: 1, speed: 1 }, baseHp: 450
    },
    eliteMage: {
      id: 'FORGE_ELITE_MAGE', name: '炽印咏火者', level: 1, category: 'elite', role: 'mage', defaultPosition: 'back',
      coefficients: { physicalAttack: 0, physicalDefense: 0.8, magicAttack: 1.875, magicDefense: 1.2, speed: 1 }, baseHp: 450
    }
  },
  skills: {
    warriorBasic: '熔岩斩', shooterBasic: '灰烬箭', mageBasic: '熔火弹',
    warriorPreview: '裂地怒斩', shooterArea: '焦羽箭雨', mageGrowth: '魔力强化'
  }
});

addThemeEnemies({
  prefix: 'RANGE',
  enemies: {
    gruntWarrior: {
      id: 'RANGE_GRUNT_WARRIOR', name: '猎场盾卫', level: 1, category: 'minor', role: 'warrior', defaultPosition: 'front',
      coefficients: { physicalAttack: 1, physicalDefense: 1.2, magicAttack: 0, magicDefense: 0.8, speed: 1 }, baseHp: 450
    },
    gruntShooter: {
      id: 'RANGE_GRUNT_SHOOTER', name: '风羽弩手', level: 1, category: 'minor', role: 'shooter', defaultPosition: 'back',
      coefficients: { physicalAttack: 1.25, physicalDefense: 1, magicAttack: 0, magicDefense: 1, speed: 1 }, baseHp: 300
    },
    gruntMage: {
      id: 'RANGE_GRUNT_MAGE', name: '风痕术士', level: 1, category: 'minor', role: 'mage', defaultPosition: 'back',
      coefficients: { physicalAttack: 0, physicalDefense: 0.8, magicAttack: 1.25, magicDefense: 1.2, speed: 1 }, baseHp: 300
    },
    eliteWarrior: {
      id: 'RANGE_ELITE_WARRIOR', name: '猎场监军', level: 1, category: 'elite', role: 'warrior', defaultPosition: 'front',
      coefficients: { physicalAttack: 1.5, physicalDefense: 1.2, magicAttack: 0, magicDefense: 0.8, speed: 1 }, baseHp: 900
    },
    eliteShooter: {
      id: 'RANGE_ELITE_SHOOTER', name: '裂风箭卫', level: 1, category: 'elite', role: 'shooter', defaultPosition: 'back',
      coefficients: { physicalAttack: 1.875, physicalDefense: 1, magicAttack: 0, magicDefense: 1, speed: 1 }, baseHp: 450
    },
    eliteMage: {
      id: 'RANGE_ELITE_MAGE', name: '风眼祭司', level: 1, category: 'elite', role: 'mage', defaultPosition: 'back',
      coefficients: { physicalAttack: 0, physicalDefense: 0.8, magicAttack: 1.875, magicDefense: 1.2, speed: 1 }, baseHp: 450
    }
  },
  skills: {
    warriorBasic: '猎场重击', shooterBasic: '风羽箭', mageBasic: '风刃术',
    warriorPreview: '破风强袭', shooterArea: '裂风箭雨', mageGrowth: '风力增幅'
  }
});

addThemeEnemies({
  prefix: 'MAGE',
  enemies: {
    gruntWarrior: {
      id: 'MAGE_GRUNT_WARRIOR', name: '法塔魔像', level: 1, category: 'minor', role: 'warrior', defaultPosition: 'front',
      coefficients: { physicalAttack: 1, physicalDefense: 1.2, magicAttack: 0, magicDefense: 0.8, speed: 1 }, baseHp: 450
    },
    gruntShooter: {
      id: 'MAGE_GRUNT_SHOOTER', name: '秘法射手', level: 1, category: 'minor', role: 'shooter', defaultPosition: 'back',
      coefficients: { physicalAttack: 1.25, physicalDefense: 1, magicAttack: 0, magicDefense: 1, speed: 1 }, baseHp: 300
    },
    gruntMage: {
      id: 'MAGE_GRUNT_MAGE', name: '炽印术士', level: 1, category: 'minor', role: 'mage', defaultPosition: 'back',
      coefficients: { physicalAttack: 0, physicalDefense: 0.8, magicAttack: 1.25, magicDefense: 1.2, speed: 1 }, baseHp: 300
    },
    eliteWarrior: {
      id: 'MAGE_ELITE_WARRIOR', name: '符文守卫', level: 1, category: 'elite', role: 'warrior', defaultPosition: 'front',
      coefficients: { physicalAttack: 1.5, physicalDefense: 1.2, magicAttack: 0, magicDefense: 0.8, speed: 1 }, baseHp: 900
    },
    eliteShooter: {
      id: 'MAGE_ELITE_SHOOTER', name: '晶矢使徒', level: 1, category: 'elite', role: 'shooter', defaultPosition: 'back',
      coefficients: { physicalAttack: 1.875, physicalDefense: 1, magicAttack: 0, magicDefense: 1, speed: 1 }, baseHp: 450
    },
    eliteMage: {
      id: 'MAGE_ELITE_MAGE', name: '炽印咏法者', level: 1, category: 'elite', role: 'mage', defaultPosition: 'back',
      coefficients: { physicalAttack: 0, physicalDefense: 0.8, magicAttack: 1.875, magicDefense: 1.2, speed: 1 }, baseHp: 450
    }
  },
  skills: {
    warriorBasic: '符文重击', shooterBasic: '晶矢', mageBasic: '炽焰弹',
    warriorPreview: '巨像震击', shooterArea: '晶矢散射', mageGrowth: '魔力强化'
  }
});

const forgeFrontSmash = addSkill({
  id: 'FORGE_BOSS_HEAVY_SLASH', tier: 'Boss技能', name: '前排重击', behaviorCategory: '攻击', cooldown: 0, isBasicAttack: false,
  execution: { power: 100, damageType: 'physical', targetRule: 'enemy_single', targetPreference: 'front' },
  description: '对当前玩家前排单体造成100物理威力伤害；没有前排时改为攻击当前后排。'
});
const forgeHeatBurst = addSkill({
  id: 'FORGE_BOSS_MOUNTAIN_CLEAVE', tier: 'Boss技能', name: '高温爆发', behaviorCategory: '攻击', cooldown: 0, isBasicAttack: false,
  execution: {
    power: 200,
    damageType: 'physical',
    targetRule: 'enemy_single',
    targetPreference: 'front',
    specialEffects: ['apply_exposed']
  },
  description: '对锁定目标行的当前占用者造成200物理威力伤害；换宠后由同一行的新单位承受，该行为空时落空。完成全部结算后进入熔核破绽。'
});
const forgeMountainCharge = addSkill({
  id: 'FORGE_BOSS_MOUNTAIN_CHARGE', tier: 'Boss技能', name: '熔核蓄力', behaviorCategory: '预告攻击', cooldown: 0, isBasicAttack: false,
  execution: {
    damageType: 'none', targetRule: 'self', targetPreference: 'front',
    telegraph: { enabled: true, followupSkillId: forgeHeatBurst, targetSelection: 'random_legal_single_target', lockMode: 'position', invalidTargetResult: 'whiff' }
  },
  description: '本次行动进入蓄力，锁定当前玩家前排目标行；下一次合法行动强制使用【高温爆发】，换宠不会解除锁定。'
});

addMonster({
  id: 'FORGE_BOSS_WARRIOR', name: '熔核守卫', level: 1, category: 'boss', role: 'warrior', defaultPosition: 'front',
  coefficients: { physicalAttack: 2.5, physicalDefense: 1, magicAttack: 2.5, magicDefense: 1, speed: 0.85 }, baseHp: 3000,
  skills: [
    { skillId: forgeFrontSmash, weight: 50, selectionMode: 'weighted' },
    { skillId: forgeMountainCharge, weight: 25, selectionMode: 'weighted' },
    { skillId: forgeHeatBurst, weight: 0, selectionMode: 'forced_followup' }
  ]
});

const rangeVolley = addSkill({
  id: 'RANGE_BOSS_VOLLEY', tier: 'Boss技能', name: '雷鸣箭雨', behaviorCategory: '攻击', cooldown: 0, isBasicAttack: false,
  execution: {
    power: 35, damageType: 'physical', targetRule: 'enemy_all', targetPreference: 'back',
    effects: [{ type: 'apply_status', statusId: 'hunter-wound', name: '猎伤', temporary: false, clearOnBench: true, stackable: true, maxStacks: 4, stacks: 1 }]
  },
  description: '对当前玩家后排全体分别造成35物理威力伤害；没有后排时改为攻击当前前排。命中且目标存活时施加1层【猎伤】。'
});
const rangePiercing = addSkill({
  id: 'RANGE_BOSS_PIERCING_RAIN', tier: 'Boss技能', name: '狙击', behaviorCategory: '攻击', cooldown: 0, isBasicAttack: false,
  execution: {
    power: 60,
    damageType: 'physical',
    targetRule: 'enemy_single',
    targetPreference: 'back',
    targetSelection: 'controlled_random_no_immediate_repeat',
    effects: [{ type: 'apply_status', statusId: 'hunter-wound', name: '猎伤', temporary: false, clearOnBench: true, stackable: true, maxStacks: 4, stacks: 1 }]
  },
  description: '随机攻击一名当前玩家后排，造成60物理威力伤害并在目标存活时施加1层【猎伤】；存在其他合法后排目标时，不会连续攻击同一目标；没有后排时改为攻击当前前排。'
});
const rangeSkyfall = addSkill({
  id: 'RANGE_BOSS_SKYFALL', tier: 'Boss技能', name: '雷霆贯射', behaviorCategory: '攻击', cooldown: 0, isBasicAttack: false,
  execution: {
    power: 100, damageType: 'physical', targetRule: 'enemy_single', targetPreference: 'back',
    targetStatusDamageInteraction: {
      statusId: 'hunter-wound',
      finalDamageMultiplierPerStack: 0.4
    }
  },
  description: '对锁定目标造成100物理威力伤害；目标每层【猎伤】使本次最终伤害提高40%，贯射后不消耗猎伤。若目标换宠则命中同一行的新单位，该行为空时落空且不重新选择。'
});
const rangeCharge = addSkill({
  id: 'RANGE_BOSS_ARROWSTORM_CHARGE', tier: 'Boss技能', name: '锁定蓄势', behaviorCategory: '预告攻击', cooldown: 0, isBasicAttack: false,
  execution: {
    damageType: 'none', targetRule: 'self', targetPreference: 'back',
    telegraph: { enabled: true, followupSkillId: rangeSkyfall, targetSelection: 'random_legal_single_target', lockMode: 'unit', invalidTargetResult: 'whiff' }
  },
  description: '随机锁定一名当前玩家后排；没有后排时锁定当前前排。下一次合法行动强制使用【雷霆贯射】。'
});

addMonster({
  id: 'RANGE_BOSS_SHOOTER', name: '灰羽猎王', level: 1, category: 'boss', role: 'shooter', defaultPosition: 'back',
  coefficients: { physicalAttack: 3, physicalDefense: 1, magicAttack: 0, magicDefense: 1, speed: 1 }, baseHp: 2200,
  skills: [
    { skillId: rangeVolley, weight: 35, selectionMode: 'weighted' },
    { skillId: rangePiercing, weight: 35, selectionMode: 'weighted' },
    { skillId: rangeCharge, weight: 30, selectionMode: 'weighted' },
    { skillId: rangeSkyfall, weight: 0, selectionMode: 'forced_followup' }
  ]
});

const mageBolt = addSkill({
  id: 'MAGE_BOSS_ARCANE_BOLT', tier: 'Boss技能', name: '魔力脉冲', behaviorCategory: '攻击', cooldown: 0, isBasicAttack: true,
  execution: { power: 80, damageType: 'magical', targetRule: 'enemy_single', targetPreference: 'front', consumeTemporaryPowerAfterUse: true },
  description: '对当前玩家前排单体造成当前威力的魔法伤害；没有前排时改为攻击当前后排。'
});
const mageExpansion = addSkill({
  id: 'MAGE_BOSS_MANA_EXPANSION', tier: 'Boss技能', name: '魔力增幅', behaviorCategory: '强化', cooldown: 0, isBasicAttack: false,
  execution: {
    damageType: 'none', targetRule: 'self',
    effects: [
      { type: 'increase_runtime_skill_power', targetSkillId: mageBolt, amount: 40 },
      { type: 'set_runtime_skill_temporary_power', targetSkillId: mageBolt, amount: 80 }
    ]
  },
  description: '本次行动不造成伤害，使【魔力脉冲】永久威力+40，并获得下一次脉冲临时威力+80；玩家每次攻击命中使临时威力降低10，下一次脉冲结算后清除剩余临时威力。'
});

addMonster({
  id: 'MAGE_BOSS', name: '炽印法主', level: 1, category: 'boss', role: 'mage', defaultPosition: 'back',
  coefficients: { physicalAttack: 0, physicalDefense: 1, magicAttack: 2.5, magicDefense: 1, speed: 0.9 }, baseHp: 2200,
  skills: [
    { skillId: mageBolt, weight: 100, selectionMode: 'weighted' },
    { skillId: mageExpansion, weight: 0, selectionMode: 'forced_followup' }
  ],
  actionCycle: {
    counterLabel: '魔力积蓄',
    countedSkillIds: [mageBolt],
    threshold: 3,
    forcedSkillId: mageExpansion
  },
  temporaryPowerResponse: { targetSkillId: mageBolt, reductionPerPlayerAttack: 10 }
});

export const MONSTER_SKILLS = skills;
export const MONSTERS = monsters;

export const RANDOM_GRUNT_POOL = [
  'FORGE_GRUNT_WARRIOR', 'FORGE_GRUNT_SHOOTER', 'FORGE_GRUNT_MAGE',
  'RANGE_GRUNT_WARRIOR', 'RANGE_GRUNT_SHOOTER', 'RANGE_GRUNT_MAGE',
  'MAGE_GRUNT_WARRIOR', 'MAGE_GRUNT_SHOOTER', 'MAGE_GRUNT_MAGE'
];

export const RANDOM_ELITE_POOL = [
  'FORGE_ELITE_WARRIOR', 'FORGE_ELITE_SHOOTER', 'FORGE_ELITE_MAGE',
  'RANGE_ELITE_WARRIOR', 'RANGE_ELITE_SHOOTER', 'RANGE_ELITE_MAGE',
  'MAGE_ELITE_WARRIOR', 'MAGE_ELITE_SHOOTER', 'MAGE_ELITE_MAGE'
];

export const RANDOM_BOSS_POOL = ['FORGE_BOSS_WARRIOR', 'RANGE_BOSS_SHOOTER', 'MAGE_BOSS'];
