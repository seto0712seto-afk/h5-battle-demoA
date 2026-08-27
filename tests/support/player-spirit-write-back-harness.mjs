export async function loadPlayerSpiritWriteBackHarness(viteServer) {
  const core = await viteServer.ssrLoadModule('/src/playerSpiritAuthoringWriterCore.ts');
  return Object.freeze({
    readSourceAtPath: core.readPlayerSpiritAuthoringSourceAtPath,
    writeUpdateAtPath: core.writePlayerSpiritAuthoringUpdateAtPath
  });
}
