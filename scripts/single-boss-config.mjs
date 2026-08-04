export const SINGLE_BOSS_IDS = [
  'FORGE_BOSS_WARRIOR',
  'RANGE_BOSS_SHOOTER',
  'MAGE_BOSS'
];

export const FIXED_TEAMS = {
  'TEAM-BALANCED': ['P04', 'P01', 'P08', 'P06', 'P09', 'P07'],
  'TEAM-OFFENSE': ['P04', 'P01', 'P02', 'P03', 'P09', 'P10'],
  'TEAM-DEFENSE': ['P05', 'P08', 'P07', 'P04', 'P06', 'P10'],
  'TEAM-LOW-MANA': ['P04', 'P01', 'P07', 'P05', 'P02', 'P03']
};

export const RANGE_TUNINGS = {
  'RANGE-CONTROL': {
    id: 'RANGE-CONTROL',
    hp: 2200,
    skillPowers: {
      RANGE_BOSS_VOLLEY: 35,
      RANGE_BOSS_PIERCING_RAIN: 60,
      RANGE_BOSS_SKYFALL: 100
    }
  },
  'RANGE-A': {
    id: 'RANGE-A',
    hp: 2100,
    skillPowers: {
      RANGE_BOSS_VOLLEY: 35,
      RANGE_BOSS_PIERCING_RAIN: 60,
      RANGE_BOSS_SKYFALL: 100
    }
  },
  'RANGE-B': {
    id: 'RANGE-B',
    hp: 2100,
    skillPowers: {
      RANGE_BOSS_VOLLEY: 35,
      RANGE_BOSS_PIERCING_RAIN: 70,
      RANGE_BOSS_SKYFALL: 120
    }
  }
};

export function fixedTeam(teamId) {
  const team = FIXED_TEAMS[teamId];
  if (!team) throw new Error(`Unknown fixed team: ${teamId}`);
  return [...team];
}

export function rangeTuning(tuningId) {
  const tuning = RANGE_TUNINGS[tuningId];
  if (!tuning) throw new Error(`Unknown range tuning: ${tuningId}`);
  return {
    ...tuning,
    skillPowers: { ...tuning.skillPowers }
  };
}
