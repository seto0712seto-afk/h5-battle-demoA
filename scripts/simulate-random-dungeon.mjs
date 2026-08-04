import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'vite';
import { createExperienceRadar } from './experience-metrics.mjs';
import { writeExperienceArtifacts } from './render-experience-summary.mjs';
import { fixedTeam, rangeTuning } from './single-boss-config.mjs';
import {
  createScoreBreakdown,
  decisionScoreSources,
  evaluateHunterWoundSwap,
  expectedShieldValue,
  normalizeDecisionSample,
  percentHealAmount,
  playerTendencyProfile,
  scoreShieldFormationFuture,
  scoreWindCutFuture,
  selfAndTargetEffectiveHeal,
  totalScoreForTendency
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
const artifactDirectory = fileURLToPath(new URL(args.artifactDir ?? '../validation-artifacts/', import.meta.url));
const policy = args.policy ?? 'balanced-v2';
const playerTendency = args.playerTendency ?? 'balanced';
const rosterMode = args.roster ?? 'random';
const fixedTeamId = args.team;
const tuningId = args.tuning;
const debugDecisions = args['debug-decisions'] === 'true' || args.debugDecisions === 'true';
const decisionSampleLimit = Math.max(0, Number(args.decisionSampleLimit ?? 300));
const diagnosticTraceEnabled = args['diagnostic-trace'] === 'true' || args.diagnosticTrace === 'true';
const diagnosticTracePath = fileURLToPath(new URL(
  args.diagnosticTraceOutput ?? '../validation-artifacts/diagnostic-trace.json',
  import.meta.url
));
if (!['balanced-v2', 'balanced-v3', 'balanced-v3-neutral', 'balanced-v4-hunter-aware'].includes(policy)) throw new Error(`Unknown policy: ${policy}`);
playerTendencyProfile(playerTendency);
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
    rosterMode,
    fixedTeamId: fixedTeamId ?? null,
    tuningId: tuningId ?? null
  });
  const decisionSamples = [];
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
        telemetry: combineTelemetryCollectors(telemetryHandle?.collector, diagnosticHandle?.collector)
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
        (sample) => {
          diagnosticHandle?.recordDecision(sample);
          if (debugDecisions && decisionSamples.length < decisionSampleLimit) {
            decisionSamples.push({ seed: runSeed, stage: stageIndex + 1, ...sample });
          }
        }
      );
      result.stage = stageIndex + 1;
      result.enemyIds = battleConfig.enemies.map((enemy) => typeof enemy === 'string' ? enemy : enemy.enemyId);
      runResult.stages.push(result);
      aggregateBattle(summary, result, stageIndex + 1);
      if (telemetryHandle) experienceRadar.finishBattle(telemetryHandle, result, game);
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
      onSkillConfirmed: (event) => {
        const entry = roundEntry(event.round);
        entry.playerSkills.push({ actorId: event.actorId, skillId: event.skillId, targetId: event.targetId ?? null });
        skillUses[event.skillId] = (skillUses[event.skillId] ?? 0) + 1;
        const previousSkillId = lastSkillByActor.get(event.actorId);
        const currentSkillStreak = previousSkillId === event.skillId
          ? (skillStreakByActor.get(event.actorId) ?? 1) + 1
          : 1;
        if (previousSkillId === event.skillId) {
          repeatedSkillActions += 1;
        }
        lastSkillByActor.set(event.actorId, event.skillId);
        skillStreakByActor.set(event.actorId, currentSkillStreak);
        maxSkillStreak = Math.max(maxSkillStreak, currentSkillStreak);
        const isAttack = attackSkillIds.has(event.skillId);
        pushEvent('skill_confirmed', event, { skill: skillMetadata[event.skillId] ?? null });
        if (amplificationCount < 2) {
          skillActionsBeforeSecondAmplification += 1;
          if (isAttack) attacksBeforeSecondAmplification += 1;
        } else {
          skillActionsAfterSecondAmplification += 1;
          if (isAttack) attacksAfterSecondAmplification += 1;
        }
      },
      onDamageResolved: (event) => {
        const entry = roundEntry(event.round);
        if (event.sourceSide === 'player') entry.damageToBoss += event.actual;
        else {
          entry.damageToPlayers += event.actual;
          entry.effectiveShield += event.absorbed;
        }
        pushEvent('damage', event);
      },
      onHealingResolved: (event) => {
        roundEntry(event.round).effectiveHealing += event.effective;
        pushEvent('healing', event);
      },
      onShieldGranted: (event) => {
        roundEntry(event.round).shieldGranted += event.granted;
        pushEvent('shield', event);
      },
      onEnergyChanged: (event) => pushEvent('energy', event),
      onSwitchResolved: (event) => pushEvent('switch', event),
      onRowSwitchResolved: (event) => pushEvent('row_switch', event),
      onReplacementLifecycle: (event) => pushEvent('replacement', event),
      onBossSkillUsed: (event) => {
        roundEntry(event.round).bossSkills.push({
          skillId: event.skillId,
          source: event.source,
          telegraph: event.telegraph,
          power: event.power,
          targetIds: [...event.targetIds]
        });
        if (event.skillId === 'MAGE_BOSS_MANA_EXPANSION') amplificationCount += 1;
        if (!event.telegraph && event.power > 0) lastBossAttackPower = event.power;
        pushEvent('boss_skill', event);
      },
      onUnitDefeated: (event) => {
        roundEntry(event.round).defeatedUnits.push({ side: event.side, unitId: event.unitId, skillId: event.skillId });
        if (event.side === 'player' && firstCasualtyPowerTier === null) firstCasualtyPowerTier = lastBossAttackPower;
        pushEvent('defeated', event);
      },
      onBattleEnd: (event) => pushEvent('battle_end', event)
    },
    finish(result) {
      const perRound = [];
      for (let round = 1; round <= result.rounds; round += 1) {
        const entry = roundEntry(round);
        entry.playerNetHpLoss = entry.damageToPlayers - entry.effectiveHealing;
        entry.netDamageTrade = entry.damageToBoss - entry.damageToPlayers;
        perRound.push(entry);
      }
      return {
        ...context,
        result: result.victory ? 'victory' : 'defeat',
        rounds: result.rounds,
        playerActions: result.playerActions,
        forcedReplacements: result.replacements,
        tacticalSwaps: result.tacticalSwaps,
        rowSwitches: result.rowSwitches,
        finalMana: result.finalMana,
        survivingSpirits: result.survivingSpirits,
        finalHpRatio: result.totalMaxHp > 0 ? result.totalRemainingHp / result.totalMaxHp : 0,
        bossRemainingHpRatio: result.bossRemainingHpRatio,
        errors: [...result.errors],
        skillUses,
        repeatedSkillActions,
        maxSkillStreak,
        amplificationCount,
        firstCasualtyPowerTier,
        attacksBeforeSecondAmplification,
        skillActionsBeforeSecondAmplification,
        attacksAfterSecondAmplification,
        skillActionsAfterSecondAmplification,
        events,
        perRound
      };
    }
  };
}

function optionalNumber(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric simulation option: ${value}`);
  return parsed;
}

function parseSkillPowerOverrides(value) {
  if (!value) return undefined;
  return Object.fromEntries(String(value).split(',').map((entry) => {
    const [skillId, rawPower] = entry.split(':');
    const power = Number(rawPower);
    if (!skillId || !Number.isFinite(power)) throw new Error(`Invalid skill power override: ${entry}`);
    return [skillId, power];
  }));
}

function applySkillPowerOverrides(skills, overrides) {
  Object.entries(overrides ?? {}).forEach(([skillId, power]) => {
    if (!skills[skillId]) throw new Error(`Unknown skill power override: ${skillId}`);
    skills[skillId].execution.power = power;
  });
}

function applySimulationTuning(stage, tuning, monsters, calculateStats) {
  if (Object.values(tuning).every((value) => value === undefined)) return stage;
  return {
    ...stage,
    battles: stage.battles.map((battle, battleIndex) => ({
      ...battle,
      enemies: battle.enemies.map((entry) => {
        const normalized = typeof entry === 'string' ? { enemyId: entry } : entry;
        const overrides = { ...(normalized.overrides ?? {}) };
        if (battleIndex < 4 && tuning.preBossHpMultiplier !== undefined) {
          overrides.maxHp = Math.ceil(calculateStats(monsters[normalized.enemyId]).maxHp * tuning.preBossHpMultiplier);
        }
        if (normalized.enemyId === 'RANGE_BOSS_SHOOTER') {
          if (tuning.rangeBossHp !== undefined) overrides.maxHp = tuning.rangeBossHp;
          if (tuning.rangeBossPhysicalAttack !== undefined) overrides.physicalAttack = tuning.rangeBossPhysicalAttack;
        }
        return { ...normalized, overrides };
      })
    }))
  };
}

function simulateBattle(game, config, spiritInfo, random, maxSteps, experienceRadar = null, policy = 'balanced-v2', playerTendency = 'balanced', recordDecision = null) {
  const result = {
    victory: false,
    phase: game.state.phase,
    rounds: 0,
    playerActions: 0,
    replacements: 0,
    tacticalSwaps: 0,
    rowSwitches: 0,
    steps: 0,
    finalMana: 0,
    survivingSpirits: 0,
    totalRemainingHp: 0,
    totalMaxHp: 0,
    skillUses: {},
    errors: []
  };

  while (!['victory', 'defeat'].includes(game.state.phase) && result.steps < maxSteps) {
    result.steps += 1;
    try {
      if (game.state.phase === 'running') {
        game.advance();
        continue;
      }
      if (game.state.phase === 'forced-replacement') {
        const candidates = game.getReplacementCandidates();
        const candidate = candidates
          .map((id) => ({ id, score: replacementScore(game, spiritInfo, id) }))
          .sort((a, b) => b.score - a.score)[0];
        if (!candidate) throw new Error('forced replacement has no candidate');
        const action = game.resolveForcedReplacement(candidate.id);
        if (!action.ok) throw new Error(`replacement failed: ${action.message ?? 'unknown'}`);
        result.replacements += 1;
        continue;
      }
      if (game.state.phase === 'target-select') {
        throw new Error('policy left battle in target-select phase');
      }
      if (game.state.phase === 'player-action') {
        const actor = game.getActingSpirit();
        if (!actor) throw new Error('player-action without actor');
        if (game.state.actionContext === 'normal') experienceRadar?.recordEnhancedAvailability(game, actor.id);
        if (policy === 'balanced-v2' && game.state.actionContext === 'normal' && shouldTacticalSwap(game, spiritInfo, actor.id)) {
          const bench = game.getBenchSpiritIds()
            .map((id) => ({ id, score: replacementScore(game, spiritInfo, id) }))
            .sort((a, b) => b.score - a.score)[0];
          if (bench) {
            const swapped = game.swapWithBench(bench.id);
            if (swapped.ok) {
              result.tacticalSwaps += 1;
              result.playerActions += 1;
              continue;
            }
          }
        }
        const v3Policy = policy === 'balanced-v3' || policy === 'balanced-v3-neutral' || policy === 'balanced-v4-hunter-aware';
        const choice = chooseSkill(game, config, spiritInfo, actor.id, random, policy, playerTendency, v3Policy ? null : recordDecision);
        if (!choice) throw new Error(`no usable skill for ${actor.id}`);
        if (v3Policy && game.state.actionContext === 'normal') {
          const alternatives = [choice, ...v3NonSkillCandidates(
            game,
            spiritInfo,
            actor.id,
            policy !== 'balanced-v3-neutral',
            playerTendency,
            policy === 'balanced-v4-hunter-aware'
          )];
          alternatives.sort((a, b) => b.score - a.score);
          recordDecision?.({
            policy,
            playerTendency,
            round: game.state.round.index,
            actorId: actor.id,
            mana: game.state.mana.current,
            selected: normalizeDecisionSample(alternatives[0]),
            candidates: alternatives.slice(0, 6).map(normalizeDecisionSample)
          });
          if (alternatives[0].action === 'swap') {
            const swapped = game.swapWithBench(alternatives[0].targetId);
            if (!swapped.ok) throw new Error(`v3 tactical swap failed: ${swapped.message ?? 'unknown'}`);
            result.tacticalSwaps += 1;
            result.playerActions += 1;
            continue;
          }
          if (alternatives[0].action === 'row-switch') {
            const switched = game.switchRow();
            if (!switched.ok) throw new Error(`v3 row switch failed: ${switched.message ?? 'unknown'}`);
            result.rowSwitches += 1;
            result.playerActions += 1;
            continue;
          }
        }
        const action = executeChoice(game, choice);
        if (!action.ok) throw new Error(`skill ${choice.skill.id} failed: ${action.message ?? 'unknown'}`);
        result.skillUses[choice.skill.id] = (result.skillUses[choice.skill.id] ?? 0) + 1;
        result.playerActions += 1;
        continue;
      }
      throw new Error(`unhandled phase: ${game.state.phase}`);
    } catch (error) {
      result.errors.push({ step: result.steps, phase: game.state.phase, message: error instanceof Error ? error.message : String(error) });
      break;
    }
  }

  if (result.steps >= maxSteps && !['victory', 'defeat'].includes(game.state.phase)) {
    result.errors.push({ step: result.steps, phase: game.state.phase, message: 'battle step limit reached' });
  }
  result.phase = game.state.phase;
  result.victory = game.state.phase === 'victory';
  result.rounds = game.state.round.index;
  result.finalMana = game.state.mana.current;
  const selected = game.state.selectedSpiritIds;
  result.survivingSpirits = selected.filter((id) => game.getSpirit(id).hp > 0).length;
  result.totalRemainingHp = selected.reduce((sum, id) => sum + Math.max(0, game.getSpirit(id).hp), 0);
  result.totalMaxHp = selected.reduce((sum, id) => sum + spiritInfo[id].maxHp, 0);
  const enemies = Object.values(game.state.enemies);
  result.bossRemainingHpRatio = enemies.reduce((sum, enemy) => sum + Math.max(0, enemy.hp), 0) /
    Math.max(1, enemies.reduce((sum, enemy) => sum + enemy.maxHp, 0));
  return result;
}

function v3NonSkillCandidates(game, spiritInfo, actorId, mechanicAware = true, playerTendency = 'balanced', hunterAware = false) {
  const actor = game.getSpirit(actorId);
  const actorInfo = spiritInfo[actorId];
  const actorRatio = actor.hp / Math.max(1, actorInfo.maxHp);
  const threatened = isTelegraphTarget(game, actorId);
  const candidates = game.getBenchSpiritIds().map((id) => {
    const incoming = game.getSpirit(id);
    const info = spiritInfo[id];
    const incomingRatio = incoming.hp / Math.max(1, info.maxHp);
    const breakdown = createScoreBreakdown();
    if (actorRatio < 0.25 && incomingRatio > 0.55) breakdown.futureMitigation += 185 * (incomingRatio - actorRatio);
    if (threatened && mechanicAware) {
      const actorDurability = actor.hp + actorInfo.physicalDefense + actorInfo.magicDefense;
      const incomingDurability = incoming.hp + info.physicalDefense + info.magicDefense;
      breakdown.bossMechanicResponse += Math.max(-80, Math.min(130, (incomingDurability - actorDurability) * 0.22));
      breakdown.delayRisk -= 15;
    }
    if (hunterAware) {
      const hunterResponse = hunterWoundSwapResponse(game, actorId, id);
      if (hunterResponse?.shouldSwap) {
        breakdown.bossMechanicResponse += 1200;
        breakdown.futureMitigation += Math.min(300, hunterResponse.preventedHpDamage);
        breakdown.delayRisk -= 20;
      }
    }
    if (!threatened && actorRatio >= 0.25) breakdown.delayRisk -= 90;
    return { action: 'swap', targetId: id, score: totalScoreForTendency(breakdown, playerTendency), breakdown, scoreSources: decisionScoreSources(breakdown, playerTendency) };
  });

  const rowBreakdown = createScoreBreakdown();
  // Current repository rule treats both cells of one line as the same locked target.
  // Row switching is still scored and sampled, but it cannot evade an active lock.
  rowBreakdown.delayRisk -= threatened && mechanicAware ? 120 : 45;
  candidates.push({ action: 'row-switch', targetId: null, score: totalScoreForTendency(rowBreakdown, playerTendency), breakdown: rowBreakdown, scoreSources: decisionScoreSources(rowBreakdown, playerTendency) });
  return candidates;
}

function hunterWoundSwapResponse(game, actorId, replacementId) {
  const actor = game.getSpirit(actorId);
  const replacement = game.getSpirit(replacementId);
  const stacks = actor.statuses['hunter-wound']?.stacks ?? 0;
  if (stacks <= 0) return null;
  const enemyId = game.getActiveEnemyIds().find((id) => game.getEnemy(id)?.definitionId === 'RANGE_BOSS_SHOOTER');
  if (!enemyId) return null;
  const currentPreview = game.enemySkillDamagePreview(enemyId, 'RANGE_BOSS_SKYFALL', actorId);
  const replacementPreview = game.enemySkillDamagePreview(enemyId, 'RANGE_BOSS_SKYFALL', replacementId);
  if (!currentPreview || !replacementPreview) return null;
  return evaluateHunterWoundSwap({
    stacks,
    currentHp: actor.hp,
    currentHpDamage: currentPreview.hpDamage,
    replacementHp: replacement.hp,
    replacementHpDamage: replacementPreview.hpDamage
  });
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
}

function chooseSkill(game, config, spiritInfo, actorId, random, policy = 'balanced-v2', playerTendency = 'balanced', recordDecision = null) {
  const actor = game.getSpirit(actorId);
  const actorData = spiritInfo[actorId];
  const activeIds = game.getActiveSpiritIds();
  const livingTeamIds = game.state.selectedSpiritIds.filter((id) => game.getSpirit(id).hp > 0);
  const allies = activeIds.map((id) => unitView(game, spiritInfo, id));
  const team = livingTeamIds.map((id) => unitView(game, spiritInfo, id));
  const minRatio = Math.min(...allies.map((ally) => ally.ratio));
  const averageRatio = team.reduce((sum, ally) => sum + ally.ratio, 0) / Math.max(1, team.length);
  const candidates = [];

  for (const skillId of actorData.skillIds) {
    const skill = config.skillConfig[skillId];
    if (!skill) continue;
    const targetIds = skill.target === 'boss'
      ? game.getLegalEnemyTargetIds()
      : skill.target === 'ally-field'
        ? game.getHealTargets()
        : [undefined];
    for (const targetId of targetIds) {
      const button = game.getSkillButtonState(skill, actor, targetId);
      if (!button.usable) continue;
      const v3Policy = policy === 'balanced-v3' || policy === 'balanced-v3-neutral';
      const evaluated = v3Policy
        ? skillScoreV3({ game, config, spiritInfo, skill, button, actorId, targetId, allies, team, minRatio, averageRatio, mechanicAware: policy !== 'balanced-v3-neutral', playerTendency })
        : { score: skillScore({ game, spiritInfo, skill, button, actorId, targetId, allies, minRatio, averageRatio }), breakdown: null };
      let score = evaluated.score;
      score += random() * 0.01;
      candidates.push({ skill, targetId, score, breakdown: evaluated.breakdown, scoreSources: evaluated.breakdown ? decisionScoreSources(evaluated.breakdown, playerTendency) : null });
    }
  }
  const sorted = candidates.sort((a, b) => b.score - a.score);
  if (recordDecision && sorted.length > 0) {
    recordDecision({
      policy,
      playerTendency,
      round: game.state.round.index,
      actorId,
      mana: game.state.mana.current,
      selected: normalizeDecisionSample(sorted[0]),
      candidates: sorted.slice(0, 6).map(normalizeDecisionSample)
    });
  }
  return sorted[0] ?? null;
}

function skillScoreV3({ game, config, spiritInfo, skill, button, actorId, targetId, allies, team, minRatio, averageRatio, mechanicAware = true, playerTendency = 'balanced' }) {
  const breakdown = createScoreBreakdown();
  const actor = game.getSpirit(actorId);
  const actorData = spiritInfo[actorId];
  const mana = game.state.mana.current;
  const manaValue = mana <= 2 ? 52 : mana <= 5 ? 30 : 12;
  const enemy = targetId ? game.getEnemy(targetId) : game.state.boss;
  const attackStat = skill.damageType === 'physical' ? actorData.physicalAttack : actorData.magicAttack;
  const expectedDamage = skill.kind === 'attack'
    ? skill.fixedDamage ?? Math.max(1, Math.ceil(button.powerTotal * attackStat / 100))
    : 0;

  breakdown.energyValue += button.manaGainActual * manaValue;
  breakdown.energyCostPenalty -= button.actualCost * (mana <= 3 ? 20 : mana >= 8 ? 4 : 9);

  if (skill.kind === 'attack') {
    breakdown.immediateDamage += 45 + expectedDamage;
    if (enemy) {
      const remainingRatio = enemy.hp / Math.max(1, enemy.maxHp);
      breakdown.immediateDamage += (1 - remainingRatio) * 24;
      if (enemy.hp <= expectedDamage) breakdown.immediateDamage += 95;
      const targetSurvival = Math.min(1, enemy.hp / Math.max(1, expectedDamage * 1.4));
      if (skill.id === 'M02-S1') {
        const payoffSkill = config.skillConfig['M02-S3'];
        const payoffDamage = Math.ceil((payoffSkill?.power ?? 0) * actorData.physicalAttack / 100);
        breakdown.futureDamage += scoreWindCutFuture({
          nextAttackExpectedDamage: payoffDamage,
          survivalProbability: actor.hp / Math.max(1, actorData.maxHp),
          canAffordPayoff: mana + button.manaGainActual >= (payoffSkill?.cost ?? 0),
          targetSurvivalProbability: targetSurvival
        });
      }
    }
    if (skill.addDamageAmpStacks) breakdown.futureDamage += 18 * skill.addDamageAmpStacks;
    if (skill.addChargeTurns) breakdown.futureDamage += 24 * skill.addChargeTurns;
    if (skill.alwaysCrit || skill.fullManaCrit || skill.highHpCritThreshold !== undefined || skill.critIfDamageAmp) {
      breakdown.immediateDamage += 18;
    }
    if (button.enhanced) breakdown.immediateDamage += 28;
    if (skill.selfHpCostPercent) {
      const ratio = actor.hp / actorData.maxHp;
      breakdown.delayRisk -= ratio < 0.35 ? 180 : 22;
    }
  }

  const healing = estimateSkillHealing(game, spiritInfo, skill, actorId, targetId);
  breakdown.effectiveHealing += healing.effective * 1.25;
  breakdown.overhealPenalty -= healing.overheal * 0.55;
  if (healing.effective > 0 && minRatio < 0.35) breakdown.genericRule += 145;
  else if (healing.effective > 0 && averageRatio < 0.65) breakdown.genericRule += 55;
  if (skill.id === 'M08-S2') {
    const meaningfullyInjured = allies.filter((ally) => ally.ratio <= 0.8).length;
    if (meaningfullyInjured >= 2 && targetId !== actorId) breakdown.genericRule += 500;
    else if (targetId !== actorId && healing.effective > 0) breakdown.genericRule += 250;
    else if (meaningfullyInjured < 2) breakdown.delayRisk -= 70;
  }

  const shielding = estimateSkillShielding(game, spiritInfo, skill, actorId, targetId);
  breakdown.effectiveShield += shielding.effective;
  breakdown.overshieldPenalty -= shielding.excess * 0.25;

  if (skill.addShieldFormationTurns) {
    const shielded = allies.filter((ally) => game.getSpirit(ally.id).shieldValue > 0);
    const telegraphDamage = expectedTelegraphDamage(game);
    breakdown.futureMitigation += scoreShieldFormationFuture({
      shieldedCount: shielded.length,
      totalShield: shielded.reduce((sum, ally) => sum + game.getSpirit(ally.id).shieldValue, 0),
      expectedIncomingDamage: telegraphDamage || 240,
      retainedActionWindows: Math.min(2, skill.addShieldFormationTurns),
      battleEndingSoon: Boolean(enemy && enemy.hp <= team.reduce((sum, ally) => sum + Math.max(0, ally.hp), 0) * 0.08)
    });
  }

  if (skill.addRegenTurns && targetId) {
    const target = game.getSpirit(targetId);
    breakdown.futureMitigation += target.statuses.regen ? 4 : 58;
  }
  if (skill.addBossVulnerabilityTurns) breakdown.futureDamage += enemy?.statuses?.vulnerable ? 5 : 135;

  const targetThreatened = targetId ? isTelegraphTarget(game, targetId) : false;
  const actorThreatened = isTelegraphTarget(game, actorId);
  if (mechanicAware && (targetThreatened || (skill.target === 'self' && actorThreatened)) && (healing.effective > 0 || shielding.effective > 0)) {
    breakdown.bossMechanicResponse += 115;
  }
  if (mechanicAware && expectedTelegraphDamage(game) > 0 && skill.kind === 'attack' && enemy?.hp <= expectedDamage * 1.25) {
    breakdown.bossMechanicResponse += 105;
  }

  const exposed = game.getActiveEnemyIds().some((id) => game.enemyStatusView(id).statuses.includes('破绽'));
  if (mechanicAware && exposed && skill.kind === 'attack') {
    breakdown.bossMechanicResponse += expectedDamage * 0.45 + (button.actualCost >= 3 ? 25 : 0);
  }
  const magePower = currentMagePulsePower(game);
  if (magePower >= 240) {
    if (skill.kind === 'attack') breakdown.bossMechanicResponse += Math.min(80, expectedDamage * 0.22);
    if (healing.effective > 0 || shielding.effective > 0) breakdown.bossMechanicResponse += 55;
    if (skill.kind !== 'attack' && healing.effective === 0 && shielding.effective === 0) breakdown.delayRisk -= 45;
  }

  if (button.actualCost === 0) breakdown.energyValue += 6;
  if (game.state.round.index > 35) {
    const antiStall = 90 + Math.min(180, (game.state.round.index - 35) * 5);
    if (skill.kind === 'attack') breakdown.antiStall += antiStall;
    else breakdown.antiStall -= antiStall * 0.65;
  }
  return { score: totalScoreForTendency(breakdown, playerTendency), breakdown };
}

function estimateSkillHealing(game, spiritInfo, skill, actorId, targetId) {
  const activeIds = game.getActiveSpiritIds();
  let requested = 0;
  let effective = 0;
  const addPercent = (id, percent) => {
    if (!id || !percent) return;
    const unit = game.getSpirit(id);
    const maxHp = spiritInfo[id].maxHp;
    const amount = Math.floor(maxHp * percent);
    requested += amount;
    effective += percentHealAmount(unit.hp, maxHp, percent);
  };
  if (skill.healPercent) addPercent(targetId ?? actorId, skill.healPercent);
  if (skill.healSelfAndTargetPercent) {
    const target = targetId ?? actorId;
    const actor = game.getSpirit(actorId);
    const targetUnit = game.getSpirit(target);
    requested += Math.floor(spiritInfo[actorId].maxHp * skill.healSelfAndTargetPercent);
    if (target !== actorId) requested += Math.floor(spiritInfo[target].maxHp * skill.healSelfAndTargetPercent);
    effective += selfAndTargetEffectiveHeal({
      actorHp: actor.hp,
      actorMaxHp: spiritInfo[actorId].maxHp,
      targetHp: targetUnit.hp,
      targetMaxHp: spiritInfo[target].maxHp,
      percent: skill.healSelfAndTargetPercent,
      sameTarget: target === actorId
    });
  }
  if (skill.teamHealPercent) activeIds.forEach((id) => addPercent(id, skill.teamHealPercent));
  if (skill.frontHealPercent) {
    game.state.slots.filter((slot) => slot.row === 'front' && slot.spiritId).forEach((slot) => addPercent(slot.spiritId, skill.frontHealPercent));
  }
  if (skill.selfHealPercent) addPercent(actorId, skill.selfHealPercent);
  if (skill.healFlatValue) {
    const id = targetId ?? actorId;
    const unit = game.getSpirit(id);
    requested += skill.healFlatValue;
    effective += Math.min(Math.max(0, spiritInfo[id].maxHp - unit.hp), skill.healFlatValue);
  }
  const button = game.getSkillButtonState(skill, game.getSpirit(actorId), targetId);
  const bonusPercent = button.enhanced && skill.enhanceRules?.length
    ? skill.enhanceRules.reduce((sum, rule) => sum + (rule.effect.healPercentBonus ?? 0), 0)
    : 0;
  if (bonusPercent) addPercent(targetId ?? actorId, bonusPercent);
  return { requested, effective, overheal: Math.max(0, requested - effective) };
}

function estimateSkillShielding(game, spiritInfo, skill, actorId, targetId) {
  const targetIds = skill.teamShieldValue
    ? game.getActiveSpiritIds()
    : skill.shieldValue
      ? [skill.target === 'ally-field' ? targetId : actorId].filter(Boolean)
      : [];
  const amount = skill.teamShieldValue ?? skill.shieldValue ?? 0;
  let effective = 0;
  let excess = 0;
  const incoming = expectedTelegraphDamage(game) || 180;
  targetIds.forEach((id) => {
    const unit = game.getSpirit(id);
    const front = game.state.slots.some((slot) => slot.spiritId === id && slot.row === 'front');
    const survivalNeed = 1 - unit.hp / Math.max(1, spiritInfo[id].maxHp);
    const usefulNewShield = Math.max(0, Math.min(amount, incoming - unit.shieldValue));
    effective += expectedShieldValue({ currentShield: usefulNewShield, incomingDamage: incoming, survivalNeed, isFront: front });
    excess += Math.max(0, unit.shieldValue + amount - incoming * 2);
  });
  return { effective, excess };
}

function expectedTelegraphDamage(game) {
  return Math.max(0, ...game.getActiveEnemyIds().map((id) => game.enemyTelegraphView(id)?.estimatedPower ?? 0));
}

function isTelegraphTarget(game, spiritId) {
  const slot = game.state.slots.find((item) => item.spiritId === spiritId);
  return Boolean(slot && game.playerTelegraphThreats(slot.index, slot.row, spiritId).length > 0);
}

function currentMagePulsePower(game) {
  const mageId = game.getActiveEnemyIds().find((id) => game.getEnemy(id)?.definitionId === 'MAGE_BOSS');
  if (!mageId) return 0;
  return game.enemyDetailView(mageId)?.skills.find((skill) => skill.id === 'MAGE_BOSS_ARCANE_BOLT')?.currentPower ?? 0;
}

function skillScore({ game, spiritInfo, skill, button, actorId, targetId, allies, minRatio, averageRatio }) {
  const actor = game.getSpirit(actorId);
  const actorData = spiritInfo[actorId];
  const mana = game.state.mana.current;
  const manaValue = mana <= 2 ? 55 : mana <= 5 ? 32 : 14;
  const costPenalty = button.actualCost * (mana <= 3 ? 18 : mana >= 8 ? 3 : 8);
  let score = button.manaGainActual * manaValue - costPenalty;

  if (skill.kind === 'attack') {
    const attackStat = skill.damageType === 'physical' ? actorData.physicalAttack : actorData.magicAttack;
    const expectedDamage = skill.fixedDamage ?? Math.max(1, button.powerTotal * attackStat / 100);
    score += 55 + expectedDamage;
    if (skill.alwaysCrit || skill.fullManaCrit || skill.highHpCritThreshold || skill.critIfDamageAmp) score += 20;
    if (button.enhanced) score += 35;
    if (skill.addDamageAmpStacks || skill.addChargeTurns) score += 24;
    if (skill.selfHpCostPercent) {
      const ratio = actor.hp / actorData.maxHp;
      score -= ratio < 0.35 ? 170 : 18;
    }
    if (skill.selfHealPercent) score += effectiveHeal(actor.hp, actorData.maxHp, skill.selfHealPercent) * 0.8;
    if (skill.teamHealPercent) {
      score += allies.reduce((sum, ally) => sum + effectiveHeal(ally.hp, ally.maxHp, skill.teamHealPercent), 0) * 0.7;
    }
    if (skill.frontHealPercent) {
      const frontIds = new Set(game.state.slots.filter((slot) => slot.row === 'front').map((slot) => slot.spiritId));
      score += allies.filter((ally) => frontIds.has(ally.id)).reduce((sum, ally) => sum + effectiveHeal(ally.hp, ally.maxHp, skill.frontHealPercent), 0) * 0.9;
    }
    if (skill.shieldValue || skill.teamShieldValue) score += shieldScore(game, spiritInfo, skill, actorId, targetId);
    if (targetId) {
      const enemy = game.getEnemy(targetId);
      score += (1 - enemy.hp / Math.max(1, enemy.maxHp)) * 28;
      score += enemy.hp <= expectedDamage ? 90 : 0;
    }
  } else if (skill.kind === 'heal' || skill.kind === 'support') {
    score += supportScore(game, spiritInfo, skill, actorId, targetId, minRatio, averageRatio);
  } else if (skill.kind === 'debuff') {
    const enemy = targetId ? game.getEnemy(targetId) : game.state.boss;
    score += enemy?.statuses?.vulnerable ? -80 : 145;
  } else if (skill.kind === 'buff') {
    score += 65;
  }
  if (button.enhanced) score += 20;
  if (button.actualCost === 0) score += 8;
  if (game.state.round.index > 40) {
    const antiStallWeight = 160 + Math.min(240, (game.state.round.index - 40) * 6);
    score += skill.kind === 'attack' ? antiStallWeight : -antiStallWeight;
  }
  return score;
}

function supportScore(game, spiritInfo, skill, actorId, targetId, minRatio, averageRatio) {
  const activeIds = game.getActiveSpiritIds();
  const targetIds = skill.target === 'ally-all' ? activeIds : [targetId ?? actorId];
  let heal = 0;
  for (const id of new Set(targetIds)) {
    const unit = game.getSpirit(id);
    const maxHp = spiritInfo[id].maxHp;
    heal += effectiveHeal(unit.hp, maxHp, skill.healPercent ?? 0);
    heal += effectiveHeal(unit.hp, maxHp, skill.healSelfAndTargetPercent ?? 0);
    heal += Math.min(Math.max(0, maxHp - unit.hp), skill.healFlatValue ?? 0);
  }
  if (skill.healSelfAndTargetPercent && targetId && targetId !== actorId) {
    const actor = game.getSpirit(actorId);
    heal += effectiveHeal(actor.hp, spiritInfo[actorId].maxHp, skill.healSelfAndTargetPercent);
  }
  if (skill.teamHealPercent) {
    heal += activeIds.reduce((sum, id) => {
      const unit = game.getSpirit(id);
      return sum + effectiveHeal(unit.hp, spiritInfo[id].maxHp, skill.teamHealPercent);
    }, 0);
  }
  let score = heal * 1.2 + shieldScore(game, spiritInfo, skill, actorId, targetId);
  if (heal > 0 && minRatio < 0.35) score += 170;
  else if (heal > 0 && averageRatio < 0.65) score += 70;
  if (heal === 0 && !skill.shieldValue && !skill.teamShieldValue && !skill.addShieldFormationTurns && skill.gain <= 0) score -= 80;
  if (skill.addRegenTurns && targetId) {
    score += game.getSpirit(targetId).statuses.regen ? 5 : 65;
  }
  if (skill.addShieldFormationTurns) {
    const alreadyActive = activeIds.some((id) => game.getSpirit(id).statuses['shield-formation']);
    score += alreadyActive ? 20 : 110;
  }
  return score;
}

function shieldScore(game, spiritInfo, skill, actorId, targetId) {
  const targets = skill.teamShieldValue
    ? game.getActiveSpiritIds()
    : [skill.target === 'ally-field' ? targetId : actorId].filter(Boolean);
  const shield = skill.teamShieldValue ?? skill.shieldValue ?? 0;
  return targets.reduce((sum, id) => {
    const unit = game.getSpirit(id);
    const ratio = unit.hp / spiritInfo[id].maxHp;
    const front = game.state.slots.some((slot) => slot.spiritId === id && slot.row === 'front');
    const need = ratio < 0.35 ? 1.15 : ratio < 0.65 ? 0.8 : 0.35;
    return sum + shield * need * (front ? 0.7 : 0.45);
  }, 0);
}

function executeChoice(game, choice) {
  const action = game.useSkill(choice.skill.id, choice.skill.target === 'boss');
  if (!action.ok) return action;
  if (game.state.phase === 'target-select') {
    if (!choice.targetId) return { ok: false, message: 'target required but absent' };
    return game.chooseSkillTarget(choice.targetId);
  }
  return action;
}

function shouldTacticalSwap(game, spiritInfo, actorId) {
  const actor = game.getSpirit(actorId);
  if (actor.hp / spiritInfo[actorId].maxHp > 0.18) return false;
  const bench = game.getBenchSpiritIds();
  if (bench.length === 0) return false;
  return bench.some((id) => game.getSpirit(id).hp / spiritInfo[id].maxHp > 0.65);
}

function replacementScore(game, spiritInfo, id) {
  const unit = game.getSpirit(id);
  const info = spiritInfo[id];
  const ratio = unit.hp / Math.max(1, info.maxHp);
  const durability = info.maxHp + info.physicalDefense + info.magicDefense;
  return ratio * 1000 + durability + (info.defaultPosition === 'front' ? 40 : 0);
}

function unitView(game, spiritInfo, id) {
  const unit = game.getSpirit(id);
  const maxHp = spiritInfo[id].maxHp;
  return { id, hp: unit.hp, maxHp, ratio: unit.hp / Math.max(1, maxHp) };
}

function effectiveHeal(hp, maxHp, percent) {
  return Math.min(Math.max(0, maxHp - hp), Math.floor(maxHp * percent));
}

function lcg(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function createSummary(runs, seed, spirits, tuning) {
  return {
    metadata: {
      runs,
      seed,
      tuning,
      policy: tuning.policy ?? 'balanced-v2',
      playerTendency: tuning.playerTendency ?? 'balanced',
      policyDescription: tuning.policy === 'balanced-v4-hunter-aware'
        ? '沿用V3多项评分；猎伤持有者预计被贯射击杀且存在可存活后备时，优先主动换宠清除猎伤。'
        : tuning.policy === 'balanced-v3' || tuning.policy === 'balanced-v3-neutral'
          ? '可解释多项评分：即时收益、资源、未来收益、Boss机制响应、溢出与延迟风险共同决策。'
          : '优先集火残血合法目标；低血时提高治疗和护盾权重；低妖力时提高回能权重；18%以下生命且有健康后备时主动换宠；超过40回合后主动提高攻击权重以打破无限防守循环。',
      generatedAt: new Date().toISOString()
    },
    clears: 0,
    stageClears: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    defeatsByStage: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    stageStats: Object.fromEntries([1, 2, 3, 4, 5].map((stage) => [stage, { attempts: 0, rounds: 0, actions: 0, remainingHpRatio: 0, replacements: 0, tacticalSwaps: 0 }])),
    bosses: {},
    spirits: Object.fromEntries(spirits.map((spirit) => [spirit.id, { name: spirit.name, selected: 0, clears: 0 }])),
    skillUses: {},
    totalTeamSelections: 0,
    anomalies: [],
    runs: [],
    overview: {}
  };
}

function aggregateBattle(summary, result, stage) {
  const stat = summary.stageStats[stage];
  stat.attempts += 1;
  stat.rounds += result.rounds;
  stat.actions += result.playerActions;
  stat.remainingHpRatio += result.totalMaxHp > 0 ? result.totalRemainingHp / result.totalMaxHp : 0;
  stat.replacements += result.replacements;
  stat.tacticalSwaps += result.tacticalSwaps;
  Object.entries(result.skillUses).forEach(([id, uses]) => {
    summary.skillUses[id] = (summary.skillUses[id] ?? 0) + uses;
  });
  result.errors.forEach((error) => summary.anomalies.push({ stage, ...error }));
}

function finalizeSummary(summary) {
  const runs = summary.metadata.runs;
  Object.values(summary.stageStats).forEach((stat) => {
    stat.averageRounds = round(stat.rounds / Math.max(1, stat.attempts));
    stat.averagePlayerActions = round(stat.actions / Math.max(1, stat.attempts));
    stat.averageRemainingHpRatio = round(stat.remainingHpRatio / Math.max(1, stat.attempts));
  });
  Object.values(summary.bosses).forEach((boss) => {
    boss.playerWinRate = round(boss.playerWins / Math.max(1, boss.attempts));
    boss.averageRounds = round(boss.rounds / Math.max(1, boss.attempts));
  });
  Object.values(summary.spirits).forEach((spirit) => {
    spirit.clearRateWhenSelected = round(spirit.clears / Math.max(1, spirit.selected));
  });
  summary.overview = {
    runs,
    clears: summary.clears,
    clearRate: round(summary.clears / runs),
    stageReach: Object.fromEntries([1, 2, 3, 4, 5].map((stage) => [stage, summary.stageStats[stage].attempts])),
    stageClears: summary.stageClears,
    defeatsByStage: summary.defeatsByStage,
    averageRoundsByStage: Object.fromEntries([1, 2, 3, 4, 5].map((stage) => [stage, summary.stageStats[stage].averageRounds])),
    anomalyCount: summary.anomalies.length
  };
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}
