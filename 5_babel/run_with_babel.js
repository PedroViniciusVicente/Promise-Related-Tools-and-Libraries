const fs = require('fs');
const os = require('os');
const path = require('path');
const babel = require('@babel/core');

const APP_PATH = path.resolve(__dirname, 'app.js');
const TARGET_PROMISE = 'promise2';
const DELAY_MS = 5000;

function isConsoleLogStatement(node) {
  if (!node || node.type !== 'ExpressionStatement') return false;
  const callee = node.expression.callee;
  return callee && callee.type === 'MemberExpression' &&
    callee.object.name === 'console' && callee.property.name === 'log';
}

function delayResolvePlugin({ types: t }) {
  return {
    visitor: {
      VariableDeclarator(nodePath) {
        if (nodePath.node.id.name !== TARGET_PROMISE) return;
        if (!t.isNewExpression(nodePath.node.init)) return;
        if (nodePath.node.init.callee.name !== 'Promise') return;

        const executor = nodePath.node.init.arguments[0];
        const resolveName = executor.params[0] && executor.params[0].name;
        if (!resolveName) return;

        nodePath.get('init.arguments.0').traverse({
          CallExpression(callPath) {
            if (callPath.node.callee.name !== resolveName) return;

            const statementPath = callPath.getStatementParent();
            const prevPath = statementPath.getSibling(statementPath.key - 1);

            const bodyStatements = [];
            if (isConsoleLogStatement(prevPath.node)) {
              bodyStatements.push(prevPath.node);
              prevPath.remove();
            }
            bodyStatements.push(statementPath.node);

            statementPath.replaceWith(
              t.expressionStatement(
                t.callExpression(t.identifier('setTimeout'), [
                  t.arrowFunctionExpression([], t.blockStatement(bodyStatements)),
                  t.numericLiteral(DELAY_MS),
                ])
              )
            );
            statementPath.skip();
          },
        });
      },
    },
  };
}

const source = fs.readFileSync(APP_PATH, 'utf8');
const { code } = babel.transformSync(source, { plugins: [delayResolvePlugin] });

const tmpFile = path.join(os.tmpdir(), `app-delayed-${Date.now()}.js`);
fs.writeFileSync(tmpFile, code);

process.on('exit', () => {
  fs.unlinkSync(tmpFile);
});

require(tmpFile);