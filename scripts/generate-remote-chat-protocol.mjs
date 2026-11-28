// Generate the bounded API 6 surface from `codex app-server generate-json-schema`.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const source = process.argv[2];
if (!source) throw Error('Usage: node scripts/generate-remote-chat-protocol.mjs <protocol-directory>');
const definitions = {
  'model/list': ['ModelListParams', 'cursor limit includeHidden'],
  'project/list': ['ProjectListParams', 'cursor limit sortDirection sortKey'],
  'thread/list': ['ThreadListParams', 'cursor limit archived cwd projectId searchTerm sortDirection sortKey modelProviders sourceKinds currentAccountOnly'],
  'thread/read': ['ThreadReadParams', 'threadId includeTurns'],
  'thread/turns/list': ['ThreadTurnsListParams', 'threadId cursor limit sortDirection itemsView'],
  'thread/items/list': ['ThreadItemsListParams', 'threadId turnId cursor limit sortDirection deferOutput'],
  'thread/items/read': ['ThreadItemsReadParams', 'threadId turnId itemIds'],
  'thread/start': ['ThreadStartParams', 'model modelProvider cwd projectId serviceTier'],
  'thread/resume': ['ThreadResumeParams', 'threadId excludeTurns initialTurnsPage'],
  'thread/fork': ['ThreadForkParams', 'threadId beforeTurnId lastTurnId excludeTurns'],
  'thread/name/set': ['ThreadSetNameParams', 'threadId name'],
  'thread/archive': ['ThreadArchiveParams', 'threadId'],
  'thread/unarchive': ['ThreadUnarchiveParams', 'threadId'],
  'turn/start': ['TurnStartParams', 'threadId input model effort serviceTier serviceTierForTurn collaborationMode clientUserMessageId'],
  'turn/steer': ['TurnSteerParams', 'threadId expectedTurnId input clientUserMessageId'],
  'turn/interrupt': ['TurnInterruptParams', 'threadId turnId'],
};
const approvals = {
  'item/commandExecution/requestApproval': 'CommandExecutionRequestApprovalResponse',
  'item/fileChange/requestApproval': 'FileChangeRequestApprovalResponse',
  'item/permissions/requestApproval': 'PermissionsRequestApprovalResponse',
  'item/tool/requestUserInput': 'ToolRequestUserInputResponse',
  'mcpServer/elicitation/request': 'McpServerElicitationRequestResponse',
};
function load(name, fields, folder = 'v2') {
  const document = JSON.parse(fs.readFileSync(path.join(source, folder, name + '.json'), 'utf8'));
  const picked = {};
  function clean(value) {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') return value;
    const result = Object.fromEntries(Object.entries(value).filter(([key]) => !['description', 'title', '$schema', 'definitions', 'default', 'format'].includes(key)).map(([key, item]) => [key, clean(item)]));
    if (result.$ref) {
      const key = result.$ref.slice('#/definitions/'.length);
      if (!Object.hasOwn(picked, key)) { picked[key] = {}; picked[key] = clean(document.definitions[key]); }
    }
    return result;
  }
  const selected = fields ? {...document, properties: Object.fromEntries(fields.split(' ').map(key => {
    if (!document.properties[key]) throw Error(name + ' missing ' + key);
    return [key, document.properties[key]];
  }))} : document;
  const schema = clean(selected); schema.additionalProperties = false;
  return {schema, definitions: picked};
}
const result = {source: 'Codex 26.1120.5083.0 app-server JSON schema', requests: Object.fromEntries(Object.entries(definitions).map(([method, [name, fields]]) => [method, load(name, fields)])), responses: Object.fromEntries(Object.entries(approvals).map(([method, name]) => [method, load(name, null, '')]))};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.writeFileSync(path.join(root, 'runtime/remote-chat-protocol.json'), JSON.stringify(result, null, 2) + '\n');
