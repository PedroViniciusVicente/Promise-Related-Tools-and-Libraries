const path = require('path');

const APP_PATH = path.resolve(__dirname, 'app.js');

const RULES = [
  {
    label: 'promise2-timer',
    match: 'app.js:13',
    extraDelayMs: 5000,
  },
];

function installDelayProxy(rules) {
  const original = global.setTimeout;

  global.setTimeout = new Proxy(original, {
    apply(target, thisArg, args) {
      const [fn, ms, ...rest] = args;
      const stack = new Error().stack || '';
      const rule = rules.find((r) => stack.includes(r.match));
      const finalMs = rule ? ms + rule.extraDelayMs : ms;
      if (rule) {
        console.log(`[monkeypatch] "${rule.label}": ${ms}ms -> ${finalMs}ms`);
      }
      return Reflect.apply(target, thisArg, [fn, finalMs, ...rest]);
    },
  });
}

installDelayProxy(RULES);
require(APP_PATH);