const CDP = require('chrome-remote-interface');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const http = require('http');


function waitForInspector(port, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function tryFetch() {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/json/version', timeout: 1000 },
        (res) => {
          res.resume();
          res.statusCode === 200 ? resolve() : retry();
        }
      );
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });

      function retry() {
        if (Date.now() - start > timeoutMs) reject(new Error('Timed out waiting for inspector'));
        else setTimeout(tryFetch, 100);
      }
    })();
  });
}

function buildMonkeypatchScript(rules) {
  return `(function() {
    const rules = ${JSON.stringify(rules)};
    const original = global.setTimeout;
    global.setTimeout = function(fn, ms, ...args) {
      const stack = new Error().stack || '';
      const rule = rules.find(r => stack.includes(r.match));
      const finalMs = rule ? ms + rule.extraDelayMs : ms;
      if (rule) console.log('[monkeypatch] "' + rule.label + '": ' + ms + 'ms -> ' + finalMs + 'ms');
      return original(fn, finalMs, ...args);
    };
  })();`;
}

async function runWithInjectedDelays(scriptPath, rules) {
  const port = 9229;

  const child = spawn('node', [`--inspect-brk=${port}`, scriptPath], { stdio: 'inherit' });
  process.once('exit', () => { try { child.kill('SIGKILL'); } catch {} });

  await waitForInspector(port);
  const client = await CDP({ port });
  await client.Runtime.enable();

  const { exceptionDetails } = await client.Runtime.evaluate({
    expression: buildMonkeypatchScript(rules),
  });
  if (exceptionDetails) {
    await client.close();
    child.kill('SIGKILL');
    throw new Error('Falha ao injetar o monkeypatch: ' + JSON.stringify(exceptionDetails));
  }

  await client.Runtime.runIfWaitingForDebugger();

  return new Promise((resolve) => {
    child.on('exit', async (code) => {
      await client.close();
      resolve(code);
    });
  });
}

if (require.main === module) {
  const appPath = path.resolve(__dirname, 'app.js');

  runWithInjectedDelays(appPath, [
    {
      label: 'promise2-timer',
      match: 'app.js:13',
      extraDelayMs: 5000,
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