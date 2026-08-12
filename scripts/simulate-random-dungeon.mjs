import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'vite';
import { createExperienceRadar } from './experience-metrics.mjs';
import { writeExperienceArtifacts } from './render-experience-summary.mjs';
import { fixedTeam, rangeTuning } from './single-boss-config.mjs';
import { createTenSpiritSpecialtyMetrics } from './ten-spirit-specialty-metrics.mjs';
import { installTestOnlyBossMirror, sourceBossId } from './test-only-boss-mirrors.mjs';
import {
  createScoreBreakdown,
  decisionScoreSources,
  estimateRegenFuture,
  estimateShieldPressFixedDamage,
  evaluateHunterWoundSwap,
  expectedShieldValue,
  normalizeDecisionSample,
  percentHealAmount,
  playerTendencyProfile,
  scoreShieldFormationFuture,
  scoreWindCutFuture,
  selfAndTargetEffectiveHeal,
  totalScoreForTendency,
  usesWeightedDecisionPolicy
} from './battle-policy.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));
const runCount = Math.max(1, Number(args.runs ?? 1000));
const baseSeed = Number(args.seed ?? 2026072701) >>> 0;
const outputPath = fileURLToPath(new URL(args.output ?? '../validation-artifacts/random-dungeon-1000-summary.json', import.meta.url));
const maxStepsPerBattle = Math.max(100, Number(args.maxSteps ?? 2500));
const experienceEnabled = args.experience === 'true';
const benchmarkBossId = args.bossId;
const testOnlySourceBossId = args.testOnlySourceBossId;
const artifactDirectory = fileURLToPath(new URL(args.artifactDir ?? '../validation-artifacts/', import.meta.url));
const policy = args.policy ?? 'balanced-v2';
const playerTendency = args.playerTendency ?? 'balanced';
const testStrategy = args.testStrategy ?? 'none';
const specialtyMetricsEnabled = args.specialtyMetrics === 'true';
const aiStrategy = args.aiStrategy ?? (testStrategy === 'refresh_seek_test' ? 'refresh_seek_test' : playerTendency);
const rosterMode = args.roster ?? 'random';
const fixedTeamId = args.team;
const tuningId = args.tuning;
const debugDecisions = args['debug-decisions'] === 'true' || args.debugDecisions === 'true';
const decisionSampleLimit = Math.max(0, Number(args.decisionSampleLimit ?? 120));
const diagnosticTraceEnabled = args['diagnostic-trace'] === 'true' || args.diagnosticTrace === 'true';
const diagnosticTracePath = fileURLToPath(new URL(
  args.diagnosticTraceOutput ?? '../validation-artifacts/diagnostic-trace.json',
  import.meta.url
));
if (!['balanced-v2', 'balanced-v3', 'balanced-v3-neutral', 'balanced-v4-hunter-aware'].includes(policy)) throw new Error(`Unknown policy: ${policy}`);
playerTendencyProfile(playerTendency);
if (!['none', 'refresh_seek_test'].includes(testStrategy)) throw new Error(`Unknown test strategy: ${testStrategy}`);
if (!['random', 'fixed'].includes(rosterMode)) throw new Error(`Unknown roster mode: ${rosterMode}`);
if (rosterMode === 'fixed' && !fixedTeamId) throw new Error('Fixed roster requires --team.');

const vite = await createServer({
  root: projectRoot,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true }
});

try {
  const [battleModule, systemsModule, stagesModule, prebattleModule, monsterDataModule, monsterSystemModule] = await Promise.all([
    vite.ssrLoadModule('/src/battle.ts'),
    vite.ssrLoadModule('/src/battleSystems.ts'),
    vite.ssrLoadModule('/src/stages.ts'),
    vite.ssrLoadModule('/src/prebattle.ts'),
    vite.ssrLoadModule('/src/monsterData.ts'),
    vite.ssrLoadModule('/src/monsterSystem.ts')
  ]);
  const { BattleGame } = battleModule;
  const { battleSystemConfig } = systemsModule;
  const { stageById, DUNGEON_RANDOM } = stagesModule;
  const { buildRandomQuickTeam } = prebattleModule;
  const { MONSTERS, MONSTER_SKILLS } = monsterDataModule;
  const { calculateMonsterStats } = monsterSystemModule;
  const config = battleSystemConfig();
  const testOnlyMirror = testOnlySourceBossId ? installTestOnlyBossMirror({
    sourceId: testOnlySourceBossId,
    monsters: MONSTERS,
    config,
    calculateMonsterStats,
    maxHp: optionalNumber(args.testOnlyBossHp),
    attack: optionalNumber(args.testOnlyBossAttack)
  }) : null;
  if (testOnlyMirror && benchmarkBossId !== testOnlyMirror.id) {
    throw new Error(`TEST_ONLY benchmark must use ${testOnlyMirror.id}, received ${benchmarkBossId}`);
  }
  if (benchmarkBossId && !MONSTERS[benchmarkBossId]) throw new Error(`Unknown benchmark boss: ${benchmarkBossId}`);
  const spiritInfo = Object.fromEntries(config.creatureConfig.map((spirit) => [spirit.id, spirit]));
  const presetTuning = tuningId ? rangeTuning(tuningId) : null;
  const tuning = {
    preBossHpMultiplier: optionalNumber(args.preBossHpMultiplier),
    rangeBossHp: optionalNumber(args.rangeBossHp) ?? presetTuning?.hp,
    rangeBossPhysicalAttack: optionalNumber(args.rangeBossPhysicalAttack),
    rangeBossSkillPowers: presetTuning?.skillPowers ?? parseSkillPowerOverrides(args.rangeBossSkillPowers)
  };
  applySkillPowerOverrides(MONSTER_SKILLS, tuning.rangeBossSkillPowers);
  const thresholds = experienceEnabled
    ? JSON.parse(await readFile(fileURLToPath(new URL('../config/experience-thresholds.json', import.meta.url)), 'utf8'))
    : null;
  const baseline = experienceEnabled
    ? await readOptionalJson(fileURLToPath(new URL('../validation-baselines/experience-baseline.json', import.meta.url)))
    : null;
  const experienceRadar = experienceEnabled ? createExperienceRadar(config, { runs: runCount, seedBase: baseSeed, monsters: MONSTERS }) : null;
  const specialtyMetrics = specialtyMetricsEnabled ? createTenSpiritSpecialtyMetrics(config, {
    runs: runCount,
    seedBase: baseSeed,
    bossId: benchmarkBossId ?? null,
    teamId: fixedTeamId ?? 'RANDOM',
    policy,
    playerTendency,
    testStrategy,
    aiStrategy,
    generatedAt: new Date().toISOString()
  }) : null;
  const diagnosticTraces = [];
  const diagnosticSkillMetadata = Object.fromEntries(Object.values(config.skillConfig).map((skill) => [skill.id, {
    name: skill.name,
    kind: skill.kind,
    primaryBehavior: skill.primaryBehavior,
    secondaryBehavior: skill.secondaryBehavior ?? null,
    burst: Boolean(skill.alwaysCrit || skill.critIfDamageAmp || skill.highHpCritThreshold !== undefined || skill.fullManaCrit)
  }]));

  const summary = createSummary(runCount, baseSeed, config.creatureConfig, {
    ...tuning,
    benchmarkBossId: benchmarkBossId ?? null,
    policy,
    playerTendency,
    testStrategy,
    rosterMode,
    fixedTeamId: fixedTeamId ?? null,
    tuningId: tuningId ?? null
  });
  const decisionSamples = [];
  const decisionSampleRandom = lcg(baseSeed ^ 0x51ed270b);
  let decisionSamplesSeen = 0;
  for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
    const runSeed = (baseSeed + Math.imul(runIndex + 1, 7919)) >>> 0;
    const policyRandom = lcg(runSeed ^ 0x9e3779b9);
    const team = rosterMode === 'fixed'
      ? fixedTeam(fixedTeamId)
      : buildRandomQuickTeam(config.creatureConfig, 6, policyRandom);
    const sourceStage = benchmarkBossId
      ? { id: `boss_benchmark_${benchmarkBossId}`, battles: [{ battleId: 'boss', enemies: [benchmarkBossId] }] }
      : stageById(DUNGEON_RANDOM, runSeed);
    const dungeon = applySimulationTuning(sourceStage, tuning, MONSTERS, calculateMonsterStats);
    const runResult = {
      index: runIndex + 1,
      seed: runSeed,
      team,
      cleared: false,
      defeatedAtStage: null,
      stages: []
    };
    experienceRadar?.startRun({ seed: runSeed, team, playerTendency });
    summary.totalTeamSelections += team.length;
    team.forEach((id) => summary.spirits[id].selected += 1);

    let snapshot;
    for (let stageIndex = 0; stageIndex < dungeon.battles.length; stageIndex += 1) {
      const battleConfig = dungeon.battles[stageIndex];
      const telemetryHandle = experienceRadar?.createBattleCollector({
        seed: runSeed,
        stage: stageIndex + 1,
        team: [...team],
        teamId: fixedTeamId ?? 'RANDOM',
        policy,
        playerTendency
      });
      const specialtyHandle = specialtyMetrics?.createBattleCollector({
        seed: runSeed,
        bossId: benchmarkBossId ?? resultBossId(battleConfig.enemies[0]),
        bossName: MONSTERS[benchmarkBossId ?? resultBossId(battleConfig.enemies[0])]?.name ?? benchmarkBossId ?? resultBossId(battleConfig.enemies[0]),
        teamId: fixedTeamId ?? 'RANDOM',
        aiStrategy
      });
      const diagnosticHandle = diagnosticTraceEnabled ? createDiagnosticTrace({
        seed: runSeed,
        stage: stageIndex + 1,
        team: [...team],
        teamId: fixedTeamId ?? 'RANDOM',
        policy,
        playerTendency
      }, new Set(Object.values(config.skillConfig).filter((skill) => skill.kind === 'attack').map((skill) => skill.id)), diagnosticSkillMetadata) : null;
      const game = new BattleGame({
        config,
        selectedSpiritIds: team,
        playerSnapshot: snapshot,
        enemies: battleConfig.enemies,
        battleSeed: `${runSeed}:stage:${stageIndex + 1}`,
        telemetry: combineTelemetryCollectors(telemetryHandle?.collector, diagnosticHandle?.collector, specialtyHandle?.collector)
      });
      const result = simulateBattle(
        game,
        config,
        spiritInfo,
        policyRandom,
        maxStepsPerBattle,
        experienceRadar,
        policy,
        playerTendency,
        testStrategy,
        (sample) => {
          diagnosticHandle?.recordDecision(sample);
          if (debugDecisions && decisionSampleLimit > 0) {
            decisionSamplesSeen += 1;
            const record = { seed: runSeed, stage: stageIndex + 1, ...sample };
            if (decisionSamples.length < decisionSampleLimit) decisionSamples.push(record);
            else {
              const replacementIndex = Math.floor(decisionSampleRandom() * decisionSamplesSeen);
              if (replacementIndex < decisionSampleLimit) decisionSamples[replacementIndex] = record;
            }
          }
        },
        specialtyHandle?.observeDecision
      );
      result.stage = stageIndex + 1;
      result.enemyIds = battleConfig.enemies.map((enemy) => typeof enemy === 'string' ? enemy : enemy.enemyId);
      runResult.stages.push(result);
      aggregateBattle(summary, result, stageIndex + 1);
      if (telemetryHandle) experienceRadar.finishBattle(telemetryHandle, result, game);
      if (specialtyHandle) specialtyMetrics.finishBattle(specialtyHandle, result, game);
      if (diagnosticHandle) diagnosticTraces.push(diagnosticHandle.finish(result));

      if (stageIndex === dungeon.battles.length - 1) {
        const bossId = result.enemyIds[0];
        summary.bosses[bossId] ??= { attempts: 0, playerWins: 0, playerDefeats: 0, rounds: 0 };
        summary.bosses[bossId].attempts += 1;
        summary.bosses[bossId].rounds += result.rounds;
        if (result.victory) summary.bosses[bossId].playerWins += 1;
        else summary.bosses[bossId].playerDefeats += 1;
      }

      if (!result.victory) {
        runResult.defeatedAtStage = stageIndex + 1;
        summary.defeatsByStage[stageIndex + 1] += 1;
        break;
      }
      summary.stageClears[stageIndex + 1] += 1;
      snapshot = game.createPlayerSnapshot();
    }

    runResult.cleared = runResult.stages.length === dungeon.battles.length && runResult.stages.every((stage) => stage.victory);
    if (runResult.cleared) {
      summary.clears += 1;
      team.forEach((id) => summary.spirits[id].clears += 1);
    }
    experienceRadar?.finishRun(runResult.cleared);
    if (runResult.defeatedAtStage === null && !runResult.cleared) {
      summary.anomalies.push({ run: runResult.index, seed: runSeed, type: 'incomplete-run' });
    }
    summary.runs.push(runResult);
  }

  finalizeSummary(summary);
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(outputPath, JSON.stringify(summary, null, 2), 'utf8');
  await writeFile(join(artifactDirectory, 'decision-samples.json'), JSON.stringify(decisionSamples, null, 2), 'utf8');
  if (diagnosticTraceEnabled) {
    await mkdir(dirname(diagnosticTracePath), { recursive: true });
    await writeFile(diagnosticTracePath, JSON.stringify(diagnosticTraces, null, 2), 'utf8');
  }
  if (specialtyMetrics) {
    await writeFile(join(artifactDirectory, 'specialty-summary.json'), JSON.stringify(specialtyMetrics.finalize(), null, 2), 'utf8');
  }
  if (experienceRadar && thresholds) {
    const experienceReport = experienceRadar.finalize(summary, thresholds, baseline, {
      commit: process.env.GITHUB_SHA ?? 'local',
      branch: process.env.GITHUB_REF_NAME ?? 'project-main'
    });
    await writeExperienceArtifacts(experienceReport, artifactDirectory);
    if (experienceReport.outliers.runtimeAnomalies.length > 0) process.exitCode = 1;
  }
  process.stdout.write(JSON.stringify(summary.overview, null, 2) + '\n');
  process.stdout.write(`RESULT_FILE=${outputPath}\n`);
} finally {
  await vite.close();
}

function combineTelemetryCollectors(...collectors) {
  const active = collectors.filter(Boolean);
  if (active.length === 0) return undefined;
  const eventNames = [...new Set(active.flatMap((collector) => Object.keys(collector)))];
  return Object.fromEntries(eventNames.map((eventName) => [eventName, (payload) => {
    active.forEach((collector) => collector[eventName]?.(payload));
  }]));
}

function createDiagnosticTrace(context, attackSkillIds, skillMetadata) {
  const rounds = new Map();
  const events = [];
  let eventSequence = 0;
  const skillUses = {};
  const lastSkillByActor = new Map();
  const skillStreakByActor = new Map();
  let maxSkillStreak = 0;
  let repeatedSkillActions = 0;
  let amplificationCount = 0;
  let lastBossAttackPower = null;
  let firstCasualtyPowerTier = null;
  let attacksBeforeSecondAmplification = 0;
  let skillActionsBeforeSecondAmplification = 0;
  let attacksAfterSecondAmplification = 0;
  let skillActionsAfterSecondAmplification = 0;
  const pushEvent = (type, event, extra = {}) => {
    events.push({ sequence: ++eventSequence, type, ...event, ...extra });
  };

  const roundEntry = (round) => {
    if (!rounds.has(round)) {
      rounds.set(round, {
        round,
        damageToBoss: 0,
        damageToPlayers: 0,
        playerNetHpLoss: 0,
        netDamageTrade: 0,
        effectiveHealing: 0,
        effectiveShield: 0,
        shieldGranted: 0,
        playerSkills: [],
        bossSkills: [],
        defeatedUnits: []
      });
    }
    return rounds.get(round);
  };

  return {
    recordDecision(sample) {
      pushEvent('ai_decision', sample);
    },
    collector: {
      onBattleStart: (event) => pushEvent('battle_start', event),
      onRoundStart: ({ round }) => roundEntry(round),
      onActionStart: (event) => pushEvent('action_start', event),
      onSkillC