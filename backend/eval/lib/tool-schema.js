// Checks model-written tool arguments against the action agent's own JSON
// schemas (pipeline/action.js ACTION_TOOLS), so "malformed argument rate" is
// measured against exactly what the model was told. The app already clamps
// and rejects bad arguments; this measures how often the model produced them.
const { ACTION_TOOLS } = require('../../pipeline/action');

const SCHEMAS = Object.fromEntries(ACTION_TOOLS.map(t => [t.function.name, t.function.parameters]));

// rawArguments: the model's arguments string. Returns a list of problems.
function validateToolCall(name, rawArguments) {
  const schema = SCHEMAS[name];
  if (!schema) return [`unknown tool "${name}"`];
  let args;
  try {
    args = JSON.parse(rawArguments || '{}');
  } catch {
    return ['arguments are not valid JSON'];
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ['arguments are not a JSON object'];
  const problems = [];
  for (const key of schema.required || []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') problems.push(`missing required "${key}"`);
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = schema.properties?.[key];
    if (!spec) { problems.push(`unexpected argument "${key}"`); continue; }
    if (spec.type === 'string' && typeof value !== 'string') problems.push(`"${key}" is not a string`);
    if (spec.enum && !spec.enum.includes(value)) problems.push(`"${key}"="${value}" is not one of ${spec.enum.join('/')}`);
  }
  return problems;
}

module.exports = { validateToolCall };
