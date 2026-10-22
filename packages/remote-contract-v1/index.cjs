'use strict';
const schema = require('./schema.json');
const VERSION = Object.freeze({major: 1, minor: 0});
const CAPABILITIES = Object.freeze(['conversation.view.v1', 'conversation.runtime.v1', 'conversation.invalidation.v1', 'operation.read.v1']);
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function invalid() {return Object.assign(new Error('remote_contract_invalid'), {code: 'remote_contract_invalid'});}
// Deliberately implements only the vocabulary used by this fixed contract.
// No coercion, eval, remote $ref resolution or automatic unknown-field deletion.
function matches(value, rule) {
  if (rule.$ref) return matches(value, schema.$defs[rule.$ref.replace('#/$defs/', '')]);
  const types = Array.isArray(rule.type) ? rule.type : rule.type ? [rule.type] : [];
  const typed = type => type === 'null' ? value === null : type === 'object' ? object(value) : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : typeof value === type;
  if (types.length && !types.some(typed)) return false;
  if (Object.hasOwn(rule, 'const') && value !== rule.const) return false;
  if (rule.enum && !rule.enum.includes(value)) return false;
  if (typeof value === 'number' && rule.minimum !== undefined && value < rule.minimum) return false;
  if (typeof value === 'string' && rule.pattern && !new RegExp(rule.pattern).test(value)) return false;
  if (object(value)) {
    if (rule.required?.some(key => !Object.hasOwn(value, key))) return false;
    for (const [key, child] of Object.entries(rule.properties || {})) if (Object.hasOwn(value, key) && !matches(value[key], child)) return false;
  }
  if (Array.isArray(value) && rule.items && !value.every(item => matches(item, rule.items))) return false;
  return true;
}
function validate(name, value) {if (!matches(value, schema.$defs[name])) throw invalid(); return value;}
function validateNegotiation(value) {return validate('negotiation', value);}
function validateRuntime(value) {
  validate('runtime', value);
  if (value.control.canWrite && value.control.owner !== 'this_device') throw invalid();
  for (const choice of value.pendingChoices) {
    if (!object(choice) || typeof choice.toolCallId !== 'string' || !Array.isArray(choice.questions)) throw invalid();
    for (const question of choice.questions) {
      if (!object(question) || typeof question.question !== 'string' || typeof question.header !== 'string' || !Array.isArray(question.options) || question.options.some(option => !object(option) || typeof option.label !== 'string' || typeof option.description !== 'string')) throw invalid();
    }
  }
  return value;
}
function validateView(value) {
  validate('view', value);
  validateRuntime(value.runtime);
  if (value.page.conversation.conversationId !== value.runtime.conversationId) throw invalid();
  return value;
}
function validateChanges(value) {
  validate('changes', value);
  let previous = -1;
  for (const event of value.events) {
    if (event.sequence <= previous || event.sequence > value.sequence) throw invalid();
    previous = event.sequence;
  }
  return value;
}
function validateOperation(value) {
  validate('operation', value);
  const progress = value.progress;
  if (value.terminal !== ['succeeded', 'failed', 'cancelled'].includes(value.state) || progress.requestId !== value.operationId || progress.conversationId !== value.conversationId || progress.terminal !== value.terminal) throw invalid();
  return value;
}
module.exports = {VERSION, CAPABILITIES, validateNegotiation, validateRuntime, validateView, validateChanges, validateOperation};
