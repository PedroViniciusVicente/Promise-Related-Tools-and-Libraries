const path = require('path');
const { DelayInjector, launchInspected, waitForInspector, getFreePort } = require('./instrumentation');

async function main() {
  const appPath = path.resolve(__dirname, 'app.js');
  const port = await getFreePort();

  const child = launchInspected(appPath, { port, brk: true });

  const cleanup = () => { try { child.kill('SIGKILL'); } catch {} };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(1); });

  await waitForInspector(port);

  const injector = new DelayInjector({ port });
  await injector.attach();

  const released = injector.releaseInitialBreak();

  await injector.addDelay({
    scriptPath: appPath,
    lineNumber: 13, // 0-indexed => "Promise 2 finished"
    delayMs: 5000,
    label: 'promise2-resolve',
  });

  // The step that was missing: actually start the process running.
  await injector.start();

  await released;

  child.on('exit', async (code) => {
    console.log(`app exited with code ${code}`);
    await injector.detach();
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});