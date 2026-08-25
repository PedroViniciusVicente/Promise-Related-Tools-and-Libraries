const path = require('path');
const { runWithInjectedMonkeypatch } = require('./instrumentation');

const appPath = path.resolve(__dirname, 'app.js');

runWithInjectedMonkeypatch(appPath, [
  {
    label: 'promise2-timer',
    match: 'app.js:13', // matches setTimeout calls whose stack trace includes this line
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