import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));
const runCount = Math.max(1, Number(args.runs ?? 1000));
const baseSeed = Number(args.seed ?? 2026072701) >>> 0;
const outputPath = fileURLToPath(new URL(args.output ?? '../validation-artifacts/random-dungeon-1000-summary.json', import.meta.url));
const maxStepsPerBattle = Math.max(100, Number(args.maxSteps ?? 2500));

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
  const { MONSTERS } = monsterDataModule;
  const { calculateMonsterStats } = monsterSystemModule;
  const config = battleSystemConfig();
  const spiritInfo = Object.fromEntries(config.creatureConfig.map((spirit) => [spirit.id, spirit]));
  const tuning = {
    preBossHpMultiplier: optionalNumber(args.preBossHpMultiplier),
    rangeBossHp: optionalNumber(args.rangeBossHp),
    rangeBossPhysicalAttack: optionalNumber(args.rangeBossPhysicalAttack)
  };

  const summary = createSummary(runCount, baseSeed, config.creatureConfig, tuning);
  for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
    const runSeed = (baseSeed + Math.imul(runIndex + 1, 7919)) >>> 0;
    const policyRandom = lcg(runSeed ^ 0x9e3779b9);
    const team = buildRandomQuickTeam(config.creatureConfig, 6, policyRandom);
    const dungeon = applySimulationTuning(stageById(DUNGEON_RANDOM, runSeed), tuning, MONSTERS, calculateMonsterStats);
    const runResult = {
      index: runIndex + 1,
      seed: runSeed,
      team,
      cleared: false,
      defeatedAtStage: null,
      stages: []
    };
    summary.totalTeamSelections += team.length;
    team.forEach((id) => summary.spirits[id].selected += 1);

    let snapshot;
    for (let stageIndex = 0; stageIndex < dungeon.battles.length; stageIndex += 1) {
      const battleConfig = dungeon.battles[stageIndex];
      const game = new BattleGame({
        config,
        selectedSpiritIds: team,
        playerSnapshot: snapshot,
        enemies: battleConfig.enemies,
        battleSeed: `${runSeed}:stage:${stageIndex + 1}`
      });
      const result = simulateBattle(game, config, spiritInfo, policyRandom, maxStepsPerBattle);
      result.stage = stageIndex + 1;
      result.enemyIds = battleConfig.enemies.map((enemy) => typeof enemy === 'string' ? enemy : enemy.enemyId);
      runResult.stages.push(result);
      aggregateBattle(summary, result, stageIndex + 1);

      if (stageIndex === 4) {
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

    runResult.cleared = runResult.stages.length === 5 && runResult.stages.every((stage) => stage.victory);
    if (runResult.cleared) {
      summary.clears += 1;
      team.forEach((id) => summary.spirits[id].clears += 1);
    }
    if (runResult.defeatedAtStage === null && !runResult.cleared) {
      summary.anomalies.push({ run: runResult.index, seed: runSeed, type: 'incomplete-run' });
    }
    summary.runs.push(runResult);
  }

  finalizeSummary(summary);
  await mkdir(fileURLToPath(new URL('../validation-artifacts/', import.meta.url)), { recursive: true });
  await writeFile(outputPath, JSON.stringify(summary, null, 2), 'utf8');
  process.stdout.write(JSON.stringify(summary.overview, null, 2) + '\n');
  process.stdout.write(`RESULT_FILE=${outputPath}\n`);
} finally {
  await vite.close();
}

function optionalNumber(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric simulation option: ${value}`);
  return parsed;
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

function simulateBattle(game, config, spiritInfo, random, maxSteps) {
  const result = {
    victory: false,
    phase: game.state.phase,
    rounds: 0,
    playerActions: 0,
    replacements: 0,
    tacticalSwaps: 0,
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
        if (game.state.actionContext === 'normal' && shouldTacticalSwap(game, spiritInfo, actor.id)) {
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
        const choice = chooseSkill(game, config, spiritInfo, actor.id, random);
        if (!choice) throw new Error(`no usable skill for ${actor.id}`);
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
  return result;
}

function chooseSkill(game, config, spiritInfo, actorId, random) {
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
      let score = skillScore({ game, spiritInfo, skill, button, actorId, targetId, allies, minRatio, averageRatio });
      score += random() * 0.01;
      candidates.push({ skill, targetId, score });
    }
  }
  return candidates.sort((a, b) => b.score - a.score)[0] ?? null;
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
      policy: 'balanced-v2',
      policyDescription: '优先集火残血合法目标；低血时提高治疗和护盾权重；低妖力时提高回能权重；18%以下生命且有健康后备时主动换宠；超过40回合后主动提高攻击权重以打破无限防守循环。',
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
