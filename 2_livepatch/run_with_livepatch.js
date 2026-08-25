const CDP = require('chrome-remote-interface');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

async function waitForInspector(port, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timed out waiting for inspector');
}

async function runWithPatchedDelays(scriptPath, patches) {
  const scriptUrl = 'file://' + path.resolve(scriptPath);
  const port = 9229;

  const child = spawn('node', [`--inspect-brk=${port}`, scriptPath], { stdio: 'inherit' });
  process.on('exit', () => child.kill('SIGKILL'));

  await waitForInspector(port);
  const client = await CDP({ port });
  const { Debugger, Runtime } = client;

  let scriptId = null;
  const scriptReady = new Promise((resolve) => {
    Debugger.scriptParsed((script) => {
      if (script.url === scriptUrl) {
        scriptId = script.scriptId;
        resolve();
      }
    });
  });
  const paused = new Promise((resolve) => Debugger.paused(resolve));

  await Debugger.enable();
  await Runtime.enable();
  await Runtime.runIfWaitingForDebugger();

  await scriptReady;
  await paused;

  let { scriptSource } = await Debugger.getScriptSource({ scriptId });

  for (const { label, targetSnippet, wrapDelayMs } of patches) {
    const wrapped = `setTimeout(() => {\n    ${targetSnippet}\n  }, ${wrapDelayMs});`;
    scriptSource = scriptSource.replace(targetSnippet, wrapped);
    console.log(`[livepatch] "${label}": extra setTimeout: ${wrapDelayMs}ms`);
  }

  await Debugger.setScriptSource({ scriptId, scriptSource });
  await Debugger.resume();

  return new Promise((resolve) => {
    child.on('exit', async (code) => {
      await client.close();
      resolve(code);
    });
  });
}

if (require.main === module) {
  const appPath = path.resolve(__dirname, 'app.js');

  runWithPatchedDelays(appPath, [
    {
      label: 'promise2-timer',
      targetSnippet: 'setTimeout(() => {\n    console.log("Promise 2 finished");\n    resolve("Result from Promise 2");\n  }, 3000);',
      wrapDelayMs: 5000,
    },
  ])
    .then((code) => {
      console.log(`app exited with code ${code}`);
      process.exit(code ?? 0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}