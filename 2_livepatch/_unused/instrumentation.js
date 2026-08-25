const CDP = require('chrome-remote-interface');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const http = require('http');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function waitForInspector(port, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryFetch = () => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/json/version', timeout: 1000 },
        (res) => { res.resume(); res.statusCode === 200 ? resolve() : retry(); }
      );
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) reject(new Error('Timed out waiting for inspector'));
      else setTimeout(tryFetch, 100);
    };
    tryFetch();
  });
}

/**
 * Runs scriptPath under the inspector, patches one or more numeric delay
 * literals in its source BEFORE any of its code executes, then lets it
 * run normally with the patched values. Internally uses --inspect-brk to
 * get a window before execution starts, but exposes none of that —
 * just "run this file with these delays changed."
 */
async function runWithPatchedDelays(scriptPath, patches) {
  const scriptUrl = 'file://' + path.resolve(scriptPath);
  const port = await getFreePort();
  const child = spawn('node', [`--inspect-brk=${port}`, scriptPath], { stdio: 'inherit' });

  const killChild = () => { try { child.kill('SIGKILL'); } catch {} };
  process.on('exit', killChild);

  await waitForInspector(port);
  const client = await CDP({ port });
  const { Debugger, Runtime } = client;

  let targetScriptId = null;
  const scriptReady = new Promise((resolve) => {
    Debugger.scriptParsed((script) => {
      if (script.url === scriptUrl) {
        targetScriptId = script.scriptId;
        resolve();
      }
    });
  });
  const initialPause = new Promise((resolve) => {
    Debugger.paused(() => resolve());
  });

  await Debugger.enable();
  await Runtime.enable();

  // THE FIX: send "go" first. This is what triggers scriptParsed and the
  // automatic line-1 pause — everything else has to wait on this, not before it.
  await Runtime.runIfWaitingForDebugger();

  await scriptReady;
  await initialPause; // now paused at line 1, before any app.js code has run

  let { scriptSource } = await Debugger.getScriptSource({ scriptId: targetScriptId });
  for (const { uniqueAnchor, originalDelayMs, extraDelayMs, label } of patches) {
    const find = `${uniqueAnchor}${originalDelayMs});`;
    if (!scriptSource.includes(find)) {
      await client.close();
      killChild();
      throw new Error(`[instrumentation] pattern not found for "${label}":\n${find}`);
    }
    const newDelayMs = originalDelayMs + extraDelayMs;
    scriptSource = scriptSource.replace(find, `${uniqueAnchor}${newDelayMs});`);
    console.log(`[instrumentation] patched "${label}": ${originalDelayMs}ms -> ${newDelayMs}ms`);
  }
  await Debugger.setScriptSource({ scriptId: targetScriptId, scriptSource });

  await Debugger.resume(); // let it run for real, with patched values baked in

  return new Promise((resolve) => {
    child.on('exit', async (code) => {
      await client.close();
      resolve(code);
    });
  });
}

module.exports = { runWithPatchedDelays };