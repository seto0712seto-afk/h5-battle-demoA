import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

test('精灵设计表 v2.3 的 16 只精灵、属性与技能全部进入正式配置', async (context) => {
  const vite = await createServer({ root: projectRoot, configFile: false, cacheDir: '.vite-cache', appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  context.after(() => vite.close());
  const { SPIRITS, SKILLS } = await vite.ssrLoadModule('/src/data.ts');

  assert.equal(SPIRITS.length, 16);
  assert.equal(Object.keys(SKILLS).length, 48);
  assert.deepEqual(SPIRITS.map((spirit) => spirit.sourceId), Array.from({ length: 16 }, (_, index) => `M${String(index + 1).padStart(2, '0')}`));
  assert.deepEqual(
    SPIRITS.map(({ id, name, maxHp, physicalAttack, magicAttack, physicalDefense, magicDefense, speed }) => [id, name, maxHp, physicalAttack, magicAttack, physicalDefense, magicDefense, speed]),
    [
      ['P01', '炽刃狐', 257, 150, 90, 79, 83, 150], ['P02', '逐风隼', 279, 131, 83, 87, 85, 138],
      ['P03', '烈芽猿', 246, 86, 135, 99, 91, 140], ['P04', '震岳獾', 409, 76, 68, 126, 106, 77],
      ['P05', '苔壳龟', 383, 63, 56, 139, 128, 72], ['P06', '铁甲犀', 428, 77, 64, 127, 117, 64],
      ['P07', '月玲灵', 181, 74, 123, 115, 115, 138], ['P08', '守铃鹿', 249, 59, 70, 135, 141, 110],
      ['P09', '引雷貂', 284, 90, 150, 90, 90, 120], ['P10', '星甲貘', 421, 75, 90, 118, 118, 68],
      ['P11', '酒秀才', 285, 70, 90, 100, 110, 135], ['P12', '僧帽菇', 360, 80, 70, 120, 120, 90],
      ['P13', '馋猫', 285, 145, 70, 85, 90, 115], ['P14', '响蝠', 270, 70, 130, 85, 95, 130],
      ['P15', '望月鹿·雄性', 375, 100, 70, 115, 100, 90], ['P16', '望月鹿·雌性', 330, 70, 85, 110, 130, 95]
    ]
  );
  assert.equal(SKILLS['M01-S3'].power, 250);
  assert.equal(SKILLS['M06-S3'].addShieldGuardTurns, 2);
  assert.equal(SKILLS['M12-S3'].extendShieldDurationActions, 1);
  assert.equal(SKILLS['M16-S2'].enhanceRules[0].condition.value, 5);
});

test('怪物配置表 v1.6 的五种怪物、等级公式、顺序技能与八场编队全部生效', async (context) => {
  const vite = await createServer({ root: projectRoot, configFile: false, cacheDir: '.vite-cache', appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  context.after(() => vite.close());
  const [{ MONSTERS, MONSTER_SKILLS }, { calculateMonsterStats, createMonsterAiRuntime, selectMonsterAction, SeededBattleRandom }, { stageById }] = await Promise.all([
    vite.ssrLoadModule('/src/monsterData.ts'), vite.ssrLoadModule('/src/monsterSystem.ts'), vite.ssrLoadModule('/src/stages.ts')
  ]);

  const expected = {
    E01: [390, 80, 70, 120, 120, 80], E02: [270, 70, 140, 85, 85, 130], E03: [300, 115, 75, 100, 95, 115],
    B01: [900, 70, 115, 105, 110, 80], B02: [675, 140, 70, 90, 80, 130]
  };
  Object.entries(expected).forEach(([id, values]) => {
    const stats = calculateMonsterStats(MONSTERS[id]);
    assert.deepEqual([stats.maxHp, stats.physicalAttack, stats.magicAttack, stats.physicalDefense, stats.magicDefense, stats.speed], values);
  });
  assert.deepEqual(calculateMonsterStats({
    ...MONSTERS.E01,
    baseHp: 140,
    coefficients: { ...MONSTERS.E01.coefficients, physicalAttack: 1 }
  }), {
    maxHp: 420, physicalAttack: 100, physicalDefense: 120, magicAttack: 70, magicDefense: 120, speed: 80
  });
  assert.deepEqual(
    ['ES001', 'ES002', 'ES003', 'ES004', 'ES005', 'BS001', 'BS002', 'BS003', 'BS004', 'BS005'].map((id) => MONSTER_SKILLS[id].name),
    ['石躯撞击', '火团喷射', '聚火', '爆炎喷射', '木棒猛敲', '银蛇点水', '蛇息凝神', '银环穿心', '狼毫风斩', '凌风猛袭']
  );

  const runtime = createMonsterAiRuntime(MONSTERS.E02, {}, 0);
  const random = new SeededBattleRandom('source-sequence');
  assert.equal(selectMonsterAction(MONSTERS.E02, {}, runtime, random).skillId, 'ES002');
  assert.equal(selectMonsterAction(MONSTERS.E02, {}, runtime, random).skillId, 'ES003');

  const chapter = stageById('LULI_CHAPTER_ONE');
  assert.equal(chapter.battles.length, 8);
  assert.deepEqual(chapter.battles.map((battle) => battle.targetRounds), [[2, 3], [3, 5], [4, 6], [3, 5], [4, 6], [5, 7], [5, 7], [6, 9]]);
  assert.deepEqual(chapter.battles[7].enemies.map((entry) => entry.enemyId), ['B02', 'B01']);
  assert.equal(chapter.battles[2].enemies[1].aiSequenceStartIndex, 1);
  assert.ok(chapter.battles[4].notes[0].includes('未提供具体数值'));
});
