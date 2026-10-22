'use strict';
const routes = require('./routes.json');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => {throw Object.assign(new Error('remote_contract_invalid'), {code: 'remote_contract_invalid'});};
const states = ['accepted', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'];
function validateDurableOperation(value) {
  if (!object(value) || typeof value.operationId !== 'string' || !states.includes(value.state) || typeof value.terminal !== 'boolean' || value.terminal !== ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(value.state) || !Number.isSafeInteger(value.acceptedAt) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < value.acceptedAt || !(value.code === null || typeof value.code === 'string') || !(value.conversationId === null || typeof value.conversationId === 'string')) invalid();
  if (value.progress !== null && (!object(value.progress) || value.progress.requestId !== value.operationId || value.progress.conversationId !== value.conversationId || value.progress.terminal !== value.terminal || typeof value.progress.event !== 'string')) invalid();
  return value;
}
function validateResource(value, resource) {
  if (!object(value) || value.schemaVersion !== '1.0' || value.resource !== resource || !routes.queries.includes(resource) || !Object.hasOwn(value, 'value')) invalid();
  return value;
}
module.exports = {validateDurableOperation, validateResource, routes};
