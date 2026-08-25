const CDP = require('chrome-remote-interface');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const http = require('http');

function launchInspected(scriptPath, port) {
  return spawn('node', [`--inspect-brk=${port}`, scriptPath], { stdio: 'inherit' });
}

function waitForInspector(port, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryFetch = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1000 }, (res) => {
        res.resume();
        res.statusCode === 200 ? resolve() : retry();
      });
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

class DelayInjector {
  constructor({ port }) {
    this.port = port;
    this.client = null;
    this.breakpoints = new Map();
    this.onInitialBreak = null;
  }

  async attach() {
    this.client = await CDP({ port: this.port });
    const { Debugger, Runtime } = this.client;

    Debugger.paused(async ({ hitBreakpoints }) => {
      if (!hitBreakpoints?.length) {
        await this.onInitialBreak();
        return;
      }

      const { delayMs, label } = this.breakpoints.get(hitBreakpoints[0]);

      console.log(`[delay-injector] paused at "${label}", delaying ${delayMs}ms`);
      setTimeout(async () => {
        await this.client.Debugger.resume();
        console.log(`[delay-injector] resumed "${label}"`);
      }, delayMs);
    });

    await Debugger.enable();
    await Runtime.enable();
  }

  releaseInitialBreak() {
    return new Promise((resolve) => {
      this.onInitialBreak = async () => {
        await this.client.Debugger.resume();
        resolve();
      };
    });
  }

  async start() {
    await this.client.Runtime.runIfWaitingForDebugger();
  }

  async addDelay({ scriptPath, lineNumber, delayMs, label }) {
    const url = 'file://' + path.resolve(scriptPath);
    const { breakpointId } = await this.client.Debugger.setBreakpointByUrl({ url, lineNumber });
    this.breakpoints.set(breakpointId, { delayMs, label: label ?? `${scriptPath}:${lineNumber}` });
    return breakpointId;
  }

  async removeDelay(breakpointId) {
    await this.client.Debugger.removeBreakpoint({ breakpointId });
    this.breakpoints.delete(breakpointId);
  }

  async detach() {
    await this.client?.close();
  }
}

async function main() {
  const appPath = path.resolve(__dirname, 'app.js');
  const port = 9229;

  const child = launchInspected(appPath, port);
  const cleanup = () => { try { child.kill('SIGKILL'); } catch {} };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(1); });

  await waitForInspector(port);

  const injector = new DelayInjector({ port });
  await injector.attach();
  const released = injector.releaseInitialBreak();

  await injector.addDelay({
    scriptPath: appPath,
    lineNumber: 13,
    delayMs: 5000,
    label: 'promise2-resolve',
  });

  await injector.start();
  await released;

  child.on('exit', async (code) => {
    console.log(`app exited with code ${code}`);
    await injector.detach();
    process.exit(code ?? 0);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}