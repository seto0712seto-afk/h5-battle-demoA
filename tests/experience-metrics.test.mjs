import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { createExperienceRadar, percentile, sanitizeJson } from '../scripts/experience-metrics.mjs';
import { renderExperienceMarkdown, writeExperienceArtifacts } from '../scripts/render-experience-summary.mjs';

let server;
let BattleGame;
let battleSystemConfig;

before(async () => {
  server = await createServer({ configFile: false, cacheDir: '.vite-cache', server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  ({ BattleGame } = await server.ssrLoadModule('/src/battle.ts'));
  ({ battleSystemConfig } = await server.ssrLoadModule('/src/battleSystems.ts'));
});

after(async () => {
  await server?.close();
});

test('遥测开启与关闭时同 Seed 战斗状态保持一致', () => {
  const config = battleSystemConfig();
  const selectedSpiritIds = config.creatureConfig.slice(0, 6).map((spirit) => spirit.id);
  const plain = new BattleGame({ config, selectedSpiritIds, battleSeed: 'telemetry-invariance' });
  const observed = new BattleGame({
    config,
    selectedSpiritIds,
    battleSeed: 'telemetry-invariance',
    telemetry: new Proxy({}, {
      get: () => (payload) => {
        payload.round = -999;
        throw new Error('collector failure must remain isolated');
      }
    })
  });
  driveBattle(plain, config, 120);
  driveBattle(observed, config, 120);
  assert.deepEqual(observed.state, plain.state);
  assert.deepEqual(observed.getMonsterRandomHistory(), plain.getMonsterRandomHistory());
  assert.ok(observed.getTelemetryErrors().length > 0);
});

test('分位数覆盖空数组、单双元素与奇偶中位数', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.9), 7);
  assert.equal(percentile([1, 3, 5], 0.5), 3);
  assert.equal(percentile([1, 3, 5, 7], 0.5), 4);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
});

test('指标聚合区分实际治疗、溢出、护盾、妖力、换宠和死亡', () => {
  const config = battleSystemConfig();
  const spirit = config.creatureConfig[0];
  const incoming = config.creatureConfig[1];
  const skillId = spirit.skillIds[0];
  const radar = createExperienceRadar(config, { runs: 1, seedBase: 10 });
  radar.startRun({ seed: 11, team: [spirit.id, incoming.id] });
  const handle = radar.createBattleCollector({ seed: 11, stage: 1, team: [spirit.id, incoming.id] });
  const collector = handle.collector;
  collector.onBattleStart({ seed: 11, selectedSpiritIds: [spirit.id, incoming.id], activeSpiritIds: [spirit.id], enemyIds: ['enemy@1'], enemyDefinitionIds: ['enemy'], mana: 0, maxMana: config.teamMana.max });
  collector.onActionStart({ round: 1, side: 'player', unitId: spirit.id, actionContext: 'normal', mana: 0 });
  collector.onSkillConfirmed({ round: 1, actorId: spirit.id, skillId, actionContext: 'normal', actualCost: 0, manaBefore: 1, enhanced: false, targetDependent: false });
  collector.onDamageResolved({ round: 1, sourceSide: 'player', sourceId: spirit.id, skillId, targetSide: 'enemy', targetId: 'enemy@1', attempted: 20, actual: 15, absorbed: 0 });
  collector.onHealingResolved({ round: 1, actorId: spirit.id, skillId, targetId: spirit.id, attempted: 20, effective: 12, overheal: 8 });
  collector.onShieldGranted({ round: 1, actorId: spirit.id, skillId, targetId: spirit.id, attempted: 10, granted: 10, mode: 'stacking' });
  collector.onEnergyChanged({ round: 1, source: 'skill', actorId: spirit.id, skillId, before: 9, attemptedGain: 3, gained: 1, spent: 0, after: 10 });
  collector.onSwitchResolved({ round: 1, outgoingId: spirit.id, incomingId: incoming.id, forced: false });
  collector.onUnitDefeated({ round: 2, side: 'player', unitId: spirit.id, sourceId: 'enemy@1', skillId: 'enemy-skill' });
  const fakeGame = {
    state: { mana: { current: 10, max: 10 }, spirits: { [spirit.id]: { id: spirit.id, hp: 0, statuses: {} } } },
    getTelemetryErrors: () => []
  };
  radar.finishBattle(handle, {
    victory: true, rounds: 2, survivingSpirits: 1, totalRemainingHp: incoming.maxHp,
    totalMaxHp: spirit.maxHp + incoming.maxHp, errors: [], enemyIds: ['enemy']
  }, fakeGame);
  radar.finishRun(true);
  const report = radar.finalize({ overview: { runs: 1, clears: 1, clearRate: 1 } }, thresholds(), null);
  assert.equal(report.skills[skillId].damageDealt, 15);
  assert.equal(report.skills[skillId].effectiveHealing, 12);
  assert.equal(report.skills[skillId].overheal, 8);
  assert.equal(report.skills[skillId].shieldGranted, 10);
  assert.equal(report.skills[skillId].energyGenerated, 1);
  assert.equal(report.skills[skillId].energyOverflow, 2);
  assert.equal(report.spirits[spirit.id].switchedOut, 1);
  assert.equal(report.spirits[incoming.id].switchedIn, 1);
  assert.equal(report.spirits[spirit.id].deaths, 1);
});

test('专项技能指标直接使用技能实例、护盾实例和状态实例归因', () => {
  const config = battleSystemConfig();
  const team = ['P06', 'P08', 'P09', 'P10'];
  const radar = createExperienceRadar(config, { runs: 1, seedBase: 20 });
  radar.startRun({ seed: 21, team });
  const handle = radar.createBattleCollector({ seed: 21, stage: 1, team });
  const collector = handle.collector;
  collector.onBattleStart({ seed: 21, selectedSpiritIds: team, activeSpiritIds: ['P06', 'P08', 'P09'], enemyIds: ['enemy@1'], enemyDefinitionIds: ['enemy'], mana: 0, maxMana: 10 });

  collector.onSkillConfirmed({ round: 1, actorId: 'P06', skillId: 'M06-S2', skillCastId: 'cast-iron', configuredCost: 3, actualCost: 3, manaBefore: 5, enhanced: true, targetDependent: true, energyGainRequested: 0, stateBeforeCast: {} });
  collector.onHealingResolved({ round: 1, actorId: 'P06', skillId: 'M06-S2', skillCastId: 'cast-iron', targetId: 'P06', attempted: 77, effective: 60, overheal: 17 });
  collector.onShieldGranted({ round: 1, actorId: 'P06', skillId: 'M06-S2', skillCastId: 'cast-iron', shieldInstanceId: 'shield-iron', targetId: 'P06', attempted: 200, granted: 200, mode: 'stacking' });
  collector.onShieldAbsorbed({ round: 2, targetId: 'P06', shieldInstanceId: 'shield-iron', sourceUnitId: 'P06', sourceSkillId: 'M06-S2', absorbedDamage: 100, remainingShield: 100, incomingDamageBeforeShield: 100, hpDamageAfterShield: 0 });

  collector.onSkillConfirmed({ round: 2, actorId: 'P08', skillId: 'M08-S3', skillCastId: 'cast-bell', configuredCost: 4, actualCost: 0, manaBefore: 4, enhanced: true, targetDependent: true, energyGainRequested: 0, isFreeCast: true, freeCastReason: 'first_skill_after_entry', stateBeforeCast: { entrySkillAvailable: true } });
  collector.onHealingResolved({ round: 2, actorId: 'P08', skillId: 'M08-S3', skillCastId: 'cast-bell', targetId: 'P08', attempted: 150, effective: 120, overheal: 30 });
  collector.onShieldGranted({ round: 2, actorId: 'P08', skillId: 'M08-S3', skillCastId: 'cast-bell', shieldInstanceId: 'shield-bell', targetId: 'P08', attempted: 150, granted: 150, mode: 'stacking' });
  collector.onShieldAbsorbed({ round: 3, targetId: 'P08', shieldInstanceId: 'shield-bell', sourceUnitId: 'P08', sourceSkillId: 'M08-S3', absorbedDamage: 75, remainingShield: 75, incomingDamageBeforeShield: 90, hpDamageAfterShield: 15 });

  collector.onSkillConfirmed({ round: 3, actorId: 'P09', skillId: 'M09-S3', skillCastId: 'cast-mark', configuredCost: 2, actualCost: 2, manaBefore: 5, enhanced: false, targetDependent: false, energyGainRequested: 0, stateBeforeCast: {} });
  collector.onStatusChanged({ round: 3, change: 'apply', statusInstanceId: 'vuln-1', statusId: 'vulnerable', statusName: '易伤', sourceUnitId: 'P09', sourceSkillId: 'M09-S3', targetUnitId: 'enemy@1', stackBefore: 0, stackDelta: 1, stackAfter: 1, durationBefore: 0, durationAfter: 3 });
  collector.onDamageResolved({ round: 4, sourceSide: 'player', sourceId: 'P09', skillId: 'M09-S2', targetSide: 'enemy', targetId: 'enemy@1', attempted: 150, actual: 150, absorbed: 0, activeVulnerabilityStatusInstanceId: 'vuln-1', damageTakenMultiplier: 3, exposedMultiplier: 2, vulnerabilityMultiplier: 1.5, finalDamageWithoutTakenModifiers: 50, finalDamageWithoutVulnerability: 100, extraDamageFromExposed: 50, extraDamageFromVulnerability: 50 });
  collector.onStatusChanged({ round: 5, change: 'remove', statusInstanceId: 'vuln-1', statusId: 'vulnerable', statusName: '易伤', targetUnitId: 'enemy@1', stackBefore: 1, stackDelta: -1, stackAfter: 0, durationBefore: 1, durationAfter: 0, removeReason: 'duration_expired' });

  collector.onSkillConfirmed({ round: 5, actorId: 'P10', skillId: 'M10-S3', skillCastId: 'cast-return', configuredCost: 5, actualCost: 0, manaBefore: 0, enhanced: true, targetDependent: false, energyGainRequested: 5, isFreeCast: true, freeCastReason: 'first_use_in_battle', stateBeforeCast: {} });
  collector.onSkillResolved({ round: 5, actorId: 'P10', skillId: 'M10-S3', skillCastId: 'cast-return', configuredCost: 5, actualCost: 0, energyGainRequested: 5, energyGainActual: 5, energyOverflow: 0, energyAfterSkillResolution: 5, resetTrigger: 'none', stateAfterCast: {} });

  const fakeGame = { state: { mana: { current: 5, max: 10 }, spirits: {}, enemies: {} }, getTelemetryErrors: () => [] };
  radar.finishBattle(handle, { victory: true, rounds: 5, survivingSpirits: 4, totalRemainingHp: 1000, totalMaxHp: 1000, errors: [], enemyIds: ['enemy'] }, fakeGame);
  radar.finishRun(true);
  const report = radar.finalize({ overview: { runs: 1, clears: 1, clearRate: 1 } }, thresholds(), null);
  assert.equal(report.skillValidation.ironSupport.effectiveHealing, 60);
  assert.equal(report.skillValidation.ironSupport.shieldUtilizationRate, 0.5);
  assert.equal(report.skillValidation.bellBlessing.freeEffectiveHealing, 120);
  assert.equal(report.skillValidation.bellBlessing.freeShieldUtilizationRate, 0.5);
  assert.equal(report.skillValidation.vulnerability.coveredRounds, 1);
  assert.equal(report.skillValidation.vulnerability.extraDamage, 50);
  assert.equal(report.skillValidation.exposure.coveredHits, 1);
  assert.equal(report.skillValidation.exposure.baseDamage, 50);
  assert.equal(report.skillValidation.exposure.extraDamage, 50);
  assert.equal(report.skillValidation.starReturn.firstFreeUses, 1);
  assert.equal(report.skillValidation.starReturn.netEnergy, 5);
});

test('Boss预告、转移命中和未兑现原因进入机制遥测', () => {
  const config = battleSystemConfig();
  const spirit = config.creatureConfig[0];
  const radar = createExperienceRadar(config, {
    runs: 1,
    seedBase: 10,
    monsters: {
      RANGE_BOSS_SHOOTER: {
        category: 'boss',
        skills: [
          { skillId: 'RANGE_BOSS_ARROWSTORM_CHARGE' },
          { skillId: 'RANGE_BOSS_SKYFALL' }
        ]
      }
    }
  });
  radar.startRun({ seed: 11, team: [spirit.id] });
  const handle = radar.createBattleCollector({ seed: 11, stage: 1, team: [spirit.id], policy: 'balanced-v3', teamId: 'TEST' });
  handle.collector.onBossSkillUsed({
    round: 1, enemyId: 'enemy@1', enemyDefinitionId: 'RANGE_BOSS_SHOOTER',
    skillId: 'RANGE_BOSS_ARROWSTORM_CHARGE', source: 'weighted', telegraph: true,
    targetIds: [spirit.id], power: 100, lockedTargetId: spirit.id, lockedOriginSlotIndex: 0
  });
  handle.collector.onSwitchResolved({
    round: 1, outgoingId: spirit.id, incomingId: 'P02', forced: false,
    slotIndex: 0, rowBefore: 'back', rowAfter: 'back'
  });
  handle.collector.onDamageResolved({
    round: 2, sourceSide: 'enemy', sourceId: 'enemy@1', skillId: 'RANGE_BOSS_SKYFALL',
    targetSide: 'player', targetId: 'P02', attempted: 100, actual: 90, absorbed: 10,
    power: 100, targetRow: 'back'
  });
  handle.collector.onBossSkillUsed({
    round: 2, enemyId: 'enemy@1', enemyDefinitionId: 'RANGE_BOSS_SHOOTER',
    skillId: 'RANGE_BOSS_SKYFALL', source: 'forced_followup', telegraph: false,
    targetIds: ['P02'], power: 100, lockedTargetId: spirit.id, lockedOriginSlotIndex: 0
  });
  const fakeGame = {
    state: { mana: { current: 0, max: 10 }, spirits: { [spirit.id]: { id: spirit.id, hp: spirit.maxHp, statuses: {} } } },
    getTelemetryErrors: () => []
  };
  radar.finishBattle(handle, {
    victory: true, rounds: 2, playerActions: 1, finalMana: 0, bossRemainingHpRatio: 0,
    survivingSpirits: 1, totalRemainingHp: spirit.maxHp, totalMaxHp: spirit.maxHp,
    errors: [], enemyIds: ['RANGE_BOSS_SHOOTER']
  }, fakeGame);
  radar.finishRun(true);
  const report = radar.finalize({ overview: { runs: 1, clears: 1, clearRate: 1 } }, thresholds(), null);
  const mechanics = report.bosses.RANGE_BOSS_SHOOTER.mechanics;
  assert.equal(mechanics.lockCreatedCount, 1);
  assert.equal(mechanics.lockResponseSwapCount, 1);
  assert.equal(mechanics.piercingShotTransferredHitCount, 1);
  assert.equal(mechanics.backRowDamageTotal, 90);
});

test('JSON安全、Markdown与CSV产物可生成', async () => {
  assert.deepEqual(sanitizeJson({ nan: Number.NaN, inf: Number.POSITIVE_INFINITY }), { nan: null, inf: null });
  const report = minimalReport();
  assert.match(renderExperienceMarkdown(report), /Battle Experience Report/);
  const directory = await mkdtemp(path.join(tmpdir(), 'experience-report-'));
  await writeExperienceArtifacts(report, directory);
  assert.match(await readFile(path.join(directory, 'experience-summary.md'), 'utf8'), /关卡节奏/);
  assert.match(await readFile(path.join(directory, 'spirit-usage.csv'), 'utf8'), /spiritId/);
  assert.match(await readFile(path.join(directory, 'skill-usage.csv'), 'utf8'), /skillId/);
  assert.match(await readFile(path.join(directory, 'mechanic-events.csv'), 'utf8'), /bossId/);
});

test('无基线与 schemaVersion 不匹配时均不导致体验流程失败', () => {
  const config = battleSystemConfig();
  const radar = createExperienceRadar(config, { runs: 0, seedBase: 1 });
  const raw = { overview: { runs: 0, clears: 0, clearRate: 0 } };
  assert.equal(radar.finalize(raw, thresholds(), null).baselineComparison, null);
  const compared = radar.finalize(raw, thresholds(), { schemaVersion: 999, stages: {} });
  assert.equal(compared.baselineComparison.compatible, false);
  assert.equal(compared.baselineComparison.reason, 'schema_version_mismatch');
});

function driveBattle(game, config, maxSteps) {
  for (let step = 0; step < maxSteps && !['victory', 'defeat'].includes(game.state.phase); step += 1) {
    if (game.state.phase === 'running') {
      game.advance();
      continue;
    }
    if (game.state.phase === 'forced-replacement') {
      game.resolveForcedReplacement(game.getReplacementCandidates()[0]);
      continue;
    }
    if (game.state.phase !== 'player-action') throw new Error(`unexpected phase ${game.state.phase}`);
    const actor = game.getActingSpirit();
    const owner = config.creatureConfig.find((spirit) => spirit.id === actor.id);
    const skill = owner.skillIds.map((id) => config.skillConfig[id]).find((item) => game.getSkillButtonState(item, actor).usable);
    if (!skill) throw new Error('scripted driver has no usable skill');
    const action = game.useSkill(skill.id, skill.target === 'boss');
    assert.equal(action.ok, true);
    if (game.state.phase === 'target-select') {
      const targets = skill.target === 'boss' ? game.getLegalEnemyTargetIds() : game.getHealTargets();
      assert.equal(game.chooseSkillTarget(targets[0]).ok, true);
    }
  }
}

function thresholds() {
  return {
    dominantSkillShare: 0.65, rareSkillShare: 0.05, rareSkillMinOwnerActions: 50,
    energyOverflowRate: 0.15, averageRoundsDelta: 1, clearRateDelta: 0.08,
    bossCoreMechanicSeenRate: 0.7
  };
}

function minimalReport() {
  return {
    schemaVersion: 1, generatedAt: new Date(0).toISOString(), commit: 'local', branch: 'project-main',
    seedMode: 'fixed', seedBase: 1, seedFormula: 'test', runs: 0, ruleset: null,
    summary: { clearRate: 0 }, stages: {}, spirits: {}, skills: {},
    energy: { overflowRate: 0, zeroEnergyActionStartRate: 0, averageEnergyAtPlayerActionStart: 0, attemptedGain: 0, gained: 0, overflow: 0, spent: 0, actionStartGained: 0, skillGained: 0 },
    bosses: {}, warnings: [], baselineComparison: null,
    outliers: { longestBattles: [], shortestClears: [], representativeDefeats: [], runtimeAnomalies: [] }
  };
}
