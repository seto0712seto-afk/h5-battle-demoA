import { createServer } from 'vite';
import { createCombatMetadataRegistry, loadMetadataOverlay } from './metadata-registry.mjs';

export async function loadCombatRuntime(projectRoot, metadataPath) {
  const vite = await createServer({ root: projectRoot, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } });
  try {
    const [systems, monsters] = await Promise.all([
      vite.ssrLoadModule('/src/battleSystems.ts'),
      vite.ssrLoadModule('/src/monsterData.ts')
    ]);
    const battleConfig = systems.battleSystemConfig();
    const overlay = await loadMetadataOverlay(metadataPath);
    return {
      battleConfig,
      monsters: monsters.MONSTERS,
      monsterSkills: monsters.MONSTER_SKILLS,
      metadataRegistry: createCombatMetadataRegistry({
        creatureConfig: battleConfig.creatureConfig,
        skillConfig: battleConfig.skillConfig,
        monsters: monsters.MONSTERS,
        monsterSkills: monsters.MONSTER_SKILLS,
        overlay
      })
    };
  } finally {
    await vite.close();
  }
}
