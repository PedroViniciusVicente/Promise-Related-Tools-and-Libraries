const CDP = require('chrome-remote-interface');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const http = require('http');

class DelayInjector {
  constructor({ port } = {}) {
    this.port = port;
    this.client = null;
    this.breakpoints = new Map();
    this._onInitialBreak = null;
  }

  async attach() {
    this.client = await CDP({ port: this.port });
    const { Debugger, Runtime } = this.client;

    // Register listener before enabling, same reasoning as before —
    // cheap insurance even though it's not the bug this time.
    Debugger.paused(async ({ hitBreakpoints }) => {
      if (!hitBreakpoints || hitBreakpoints.length === 0) {
        if (this._onInitialBreak) {
          const cb = this._onInitialBreak;
          this._onInitialBreak = null;
          await cb();
        } else {
          console.warn('[instrumentation] initial break hit with no handler; resuming');
          await this.client.Debugger.resume();
        }
        return;
      }

      const bpId = hitBreakpoints[0];
      const meta = this.breakpoints.get(bpId);
      const delayMs = meta ? meta.delayMs : 0;
      const label = meta ? meta.label : bpId;

      console.log(`[instrumentation] paused at "${label}", delaying ${delayMs}ms`);
      setTimeout(async () => {
        try {
          await this.client.Debugger.resume();
          console.log(`[instrumentation] resumed "${label}"`);
        } catch (err) {
          console.error('[instrumentation] resume failed', err);
        }
      }, delayMs);
    });

    await Debugger.enable();
    await Runtime.enable(); // required before runIfWaitingForDebugger
  }

  releaseInitialBreak() {
    return new Promise((resolve) => {
      this._onInitialBreak = async () => {
        await this.client.Debugger.resume();
        resolve();
      };
    });
  }

  // Actually kicks off execution for a process launched with --inspect-brk.
  // Without this call, the process never runs at all.
  async start() {
    await this.client.Runtime.runIfWaitingForDebugger();
  }

  async addDelay({ scriptPath, lineNumber, delayMs, label }) {
    const url = 'file://' + path.resolve(scriptPath);
    const { breakpointId } = await this.client.Debugger.setBreakpointByUrl({
      url,
      lineNumber,
    });
    this.breakpoints.set(breakpointId, { delayMs, label: label || `${scriptPath}:${lineNumber}` });
    return breakpointId;
  }

  async removeDelay(breakpointId) {
    await this.client.Debugger.removeBreakpoint({ breakpointId });
    this.breakpoints.delete(breakpointId);
  }

  async detach() {
    if (this.client) await this.client.close();
  }
}

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

function launchInspected(scriptPath, { port, brk = false } = {}) {
  const flag = brk ? `--inspect-brk=${port}` : `--inspect=${port}`;
  return spawn('node', [flag, scriptPath], { stdio: 'inherit' });
}

// HTTP-only readiness check — doesn't open a debug session at all,
// so it can't interfere with the real client's pause/resume flow.
function waitForInspector(port, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryFetch = () => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/json/version', timeout: 1000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else retry();
        }
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
 * Builds a self-contained JS snippet that monkeypatches global.setTimeout
 * to add extra delay when a rule's `match` string appears in the call's
 * stack trace. Runs entirely inside the target process via Runtime.evaluate.
 */
function buildMonkeypatchScript(rules) {
  return `
    (function() {
      const rules = ${JSON.stringify(rules)};
      const originalSetTimeout = global.setTimeout;

      global.setTimeout = function(fn, ms, ...args) {
        const stack = new Error().stack || '';
        const rule = rules.find(r => stack.includes(r.match));
        const finalMs = rule ? ms + rule.extraDelayMs : ms;
        if (rule) {
          console.log('[monkeypatch] timer "' + rule.label + '": ' + ms + 'ms -> ' + finalMs + 'ms');
        }
        return originalSetTimeout(fn, finalMs, ...args);
      };
    })();
  `;
}

/**
 * Runs scriptPath under the inspector, injects a monkeypatch into its
 * global scope BEFORE any of its code executes, then lets it run normally.
 * No Debugger domain, no breakpoints, no source editing — just one
 * Runtime.evaluate call ahead of start.
 */
async function runWithInjectedMonkeypatch(scriptPath, rules) {
  const port = await getFreePort();
  const child = spawn('node', [`--inspect-brk=${port}`, scriptPath], { stdio: 'inherit' });

  const killChild = () => { try { child.kill('SIGKILL'); } catch {} };
  process.on('exit', killChild);

  await waitForInspector(port);
  const client = await CDP({ port });
  const { Runtime } = client;

  await Runtime.enable();

  // Inject the patch while the process is still frozen pre-execution.
  // The global object already exists at this point even though app.js
  // hasn't run yet, so this lands before any of its code can reference setTimeout.
  const evalResult = await Runtime.evaluate({ expression: buildMonkeypatchScript(rules) });
  if (evalResult.exceptionDetails) {
    await client.close();
    killChild();
    throw new Error('[instrumentation] failed to inject monkeypatch: ' + JSON.stringify(evalResult.exceptionDetails));
  }

  await Runtime.runIfWaitingForDebugger(); // app.js now runs, setTimeout is already patched

  return new Promise((resolve) => {
    child.on('exit', async (code) => {
      await client.close();
      resolve(code);
    });
  });
}

module.exports = { DelayInjector, launchInspected, waitForInspector, getFreePort, runWithInjectedMonkeypatch };