const path = require('path');
const { runWithPatchedDelays } = require('./instrumentation');

const appPath = path.resolve(__dirname, 'app.js');

runWithPatchedDelays(appPath, [
  {
    label: 'promise2-timer',
    uniqueAnchor: `console.log("Promise 2 finished");\n    resolve("Result from Promise 2");\n  }, `,
    originalDelayMs: 3000,
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