import { writeFileSync } from 'node:fs';
import ts from 'typescript';

const response = await fetch('https://ai.amaxsmp.com/api/pricing', { signal: AbortSignal.timeout(20000) });
if (!response.ok) throw new Error(`The pricing API returned HTTP ${response.status}`);
const data = await response.json();
if (!Array.isArray(data.data) || data.data.length === 0) throw new Error('The pricing API did not return a model list.');
function tierRates(node) {
  if (!ts.isCallExpression(node) || node.expression.getText() !== 'tier') throw new Error('Unsupported pricing expression.');
  const rates = {};
  function visit(part) {
    if (ts.isBinaryExpression(part) && part.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      visit(part.left); visit(part.right); return;
    }
    if (!ts.isBinaryExpression(part) || part.operatorToken.kind !== ts.SyntaxKind.AsteriskToken || !ts.isIdentifier(part.left) || !ts.isNumericLiteral(part.right)) throw new Error('Unsupported price item.');
    const key = { p: 'input', c: 'output', cr: 'cacheRead', cc: 'cacheWrite' }[part.left.text];
    if (!key) throw new Error('Unsupported billing unit.');
    rates[key] = Number(part.right.text);
  }
  visit(node.arguments[1]);
  return rates;
}
const prices = {};
const skipped = [];
for (const model of data.data) {
  if (model.quota_type !== 0 || model.billing_mode === 'per-second' || model.billing_mode === 'time') continue;
  let price;
  if (model.billing_mode === 'tiered_expr') {
    const source = ts.createSourceFile('pricing.ts', model.billing_expr, ts.ScriptTarget.Latest, true);
    const expression = source.statements[0]?.expression;
    if (!expression || !ts.isConditionalExpression(expression) || !ts.isBinaryExpression(expression.condition) || expression.condition.left.getText() !== 'len' || !ts.isNumericLiteral(expression.condition.right)) { skipped.push(model.model_name); continue; }
    try {
      const multiplier = model.model_overseas_multiplier ?? 1;
      const scale = rates => Object.fromEntries(Object.entries(rates).map(([key, value]) => [key, value * multiplier]));
      const threshold = Number(expression.condition.right.text) - (expression.condition.operatorToken.kind === ts.SyntaxKind.LessThanToken ? 1 : 0);
      price = { ...scale(tierRates(expression.whenTrue)), threshold, long: scale(tierRates(expression.whenFalse)) };
    } catch { skipped.push(model.model_name); continue; }
  } else {
    if (typeof model.model_ratio !== 'number' || typeof model.completion_ratio !== 'number') continue;
    price = { input: 2 * model.model_ratio, output: 2 * model.model_ratio * model.completion_ratio,
      ...(typeof model.cache_ratio === 'number' ? { cacheRead: 2 * model.model_ratio * model.cache_ratio } : {}),
      ...(typeof model.create_cache_ratio === 'number' ? { cacheWrite: 2 * model.model_ratio * model.create_cache_ratio } : {}) };
  }
  prices[model.model_name] = price;
}
writeFileSync('src/shared/amaxPricing.json', JSON.stringify({ source: 'https://ai.amaxsmp.com/models', retrieved: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }), currency: 'CNY', prices }, null, 2) + '\n');
console.log(JSON.stringify({ count: Object.keys(prices).length, skipped }));
