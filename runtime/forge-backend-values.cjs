'use strict';
const { ForgeError } = require('./forge-errors.cjs');
const { isDeepStrictEqual } = require('node:util');
const fail = (message, code = 'INVALID_ARGUMENT') => { throw new ForgeError(code, message); };
const MAX_MESSAGE = 1024 * 1024;
function jsonValue(value, limit = MAX_MESSAGE) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { fail('后端数据必须可序列化为 JSON'); }
  if (encoded === undefined || Buffer.byteLength(encoded) > limit) fail('后端 JSON 数据超过限制', 'OUTPUT_LIMIT');
  return JSON.parse(encoded);
}
const supported = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'anyOf', 'oneOf', 'allOf', 'nullable']);
function schemaDefinition(schema, depth = 0) {
  if (depth > 16 || !schema || typeof schema !== 'object' || Array.isArray(schema)) fail('工具 schema 必须是深度不超过 16 的对象');
  for (const key of Object.keys(schema)) if (!supported.has(key)) fail('工具 schema 不支持字段：' + key);
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.some(type => !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type))) fail('工具 schema 类型无效');
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) fail('schema.properties 必须为对象');
    for (const item of Object.values(schema.properties)) schemaDefinition(item, depth + 1);
  }
  if (schema.items !== undefined) schemaDefinition(schema.items, depth + 1);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string'))) fail('schema.required 无效');
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') schemaDefinition(schema.additionalProperties, depth + 1);
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) if (schema[keyword] !== undefined) {
    if (!Array.isArray(schema[keyword]) || !schema[keyword].length || schema[keyword].length > 16) fail('schema.' + keyword + ' 无效');
    for (const item of schema[keyword]) schemaDefinition(item, depth + 1);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 100)) fail('schema.enum 无效');
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) if (schema[key] !== undefined && (!Number.isFinite(schema[key]) || !['minimum', 'maximum'].includes(key) && (!Number.isInteger(schema[key]) || schema[key] < 0))) fail('schema.' + key + ' 无效');
  jsonValue(schema, 64 * 1024);
  return schema;
}
function validateValue(schema, value, at = 'value', depth = 0) {
  if (depth > 24) fail(at + ' 超过允许的数据深度');
  const reject = detail => fail(at + ' ' + detail);
  if (schema.nullable && value === null) return value;
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const matches = type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
  if (types.length && !types.some(matches)) reject('类型不符合 schema');
  const same = other => isDeepStrictEqual(other, value);
  if (schema.enum && !schema.enum.some(same)) reject('不在枚举范围');
  if (Object.hasOwn(schema, 'const') && !same(schema.const)) reject('不符合 const');
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (schema[key]) {
    let count = 0;
    for (const item of schema[key]) { try { validateValue(item, value, at, depth + 1); count++; } catch (error) { if (error.code !== 'INVALID_ARGUMENT') throw error; } }
    if (key === 'anyOf' && count === 0 || key === 'oneOf' && count !== 1 || key === 'allOf' && count !== schema[key].length) reject('不符合 ' + key);
  }
  if (typeof value === 'string') {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) reject('字符串长度不符合 schema');
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) reject('数字不符合 schema');
  } else if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) reject('数组长度不符合 schema');
    if (schema.items) for (let i = 0; i < value.length; i++) validateValue(schema.items, value[i], at + '[' + i + ']', depth + 1);
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length < (schema.minProperties ?? 0) || keys.length > (schema.maxProperties ?? Infinity)) reject('字段数量不符合 schema');
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) reject('缺少字段 ' + key);
    for (const key of keys) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) validateValue(schema.properties[key], value[key], at + '.' + key, depth + 1);
      else if (schema.additionalProperties === false) reject('包含未声明字段 ' + key);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateValue(schema.additionalProperties, value[key], at + '.' + key, depth + 1);
    }
  }
  return value;
}
function localName(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) fail('后端方法名称无效');
  return value;
}
function namespaced(pluginId, value) {
  localName(value);
  if (!value.startsWith(pluginId + '.') || value.length <= pluginId.length + 1) fail('贡献名称必须属于插件命名空间：' + pluginId);
  return value;
}
module.exports = { MAX_MESSAGE, fail, jsonValue, schemaDefinition, validateValue, localName, namespaced };
