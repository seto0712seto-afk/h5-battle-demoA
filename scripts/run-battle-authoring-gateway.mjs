import { createServer } from 'vite';

const viteServer = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error'
});

let runningGateway;

try {
  const gateway = await viteServer.ssrLoadModule('/src/battleAuthoringGateway.ts');
  const configuredPort = process.env.BATTLE_AUTHORING_GATEWAY_PORT;
  const port = configuredPort === undefined
    ? gateway.BATTLE_AUTHORING_GATEWAY_DEFAULT_PORT
    : Number(configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('BATTLE_AUTHORING_GATEWAY_PORT must be an integer from 1 to 65535.');
  }
  runningGateway = await gateway.startBattleAuthoringGateway({ port });
  console.log(
    `Battle Authoring Gateway ready: ${runningGateway.url} (API ${gateway.BATTLE_AUTHORING_GATEWAY_API_VERSION})`
  );
} catch (error) {
  console.error(`Battle Authoring Gateway failed: ${error instanceof Error ? error.message : String(error)}`);
  await viteServer.close();
  process.exitCode = 1;
}

if (runningGateway) {
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await runningGateway.close();
    await viteServer.close();
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}
