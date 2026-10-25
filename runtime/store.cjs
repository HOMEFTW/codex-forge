'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const idPattern = /^[A-Za-z0-9_-]{1,80}$/;
const nodeTypes = new Set(['text', 'sticky', 'image', 'file', 'group']);
const maxDocumentBytes = 12 * 1024 * 1024;
const copy = value => JSON.parse(JSON.stringify(value));
function check(ok, message) { if (!ok) throw new Error(message); }
function id(value) { check(typeof value === 'string' && idPattern.test(value), 'Invalid ID'); return value; }
function text(value, max = 100000) { check(typeof value === 'string' && value.length <= max, 'Invalid text or text too long'); return value; }
function number(value, min, max) { check(Number.isFinite(value) && value >= min && value <= max, 'Invalid coordinate or size'); return value; }
function validateNode(node) {
  id(node.id); check(nodeTypes.has(node.type), 'Unsupported node type');
  number(node.x, -1000000, 1000000); number(node.y, -1000000, 1000000);
  number(node.width, 140, 1600); number(node.height, 90, 1600);
  check(node.data && typeof node.data === 'object' && !Array.isArray(node.data), 'Invalid node data');
  const data = node.data;
  for (const key of Object.keys(data)) check(['title', 'text', 'color', 'asset', 'filePath', 'members', 'collapsed', 'gridColumns', 'gridRows'].includes(key), 'Unknown node data field');
  if (data.title !== undefined) text(data.title, 300);
  if (data.text !== undefined) text(data.text);
  if (data.color !== undefined) check(['yellow', 'blue', 'green', 'pink', 'neutral'].includes(data.color), 'Invalid node color');
  if (data.asset !== undefined) check(/^[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(data.asset), 'Invalid image asset');
  if (data.filePath !== undefined) check(typeof data.filePath === 'string' && data.filePath.length <= 32767 && path.isAbsolute(data.filePath) && !/[\r\n\0]/.test(data.filePath), 'File path must be absolute');
  if (data.members !== undefined) { check(Array.isArray(data.members) && data.members.length <= 1500, 'Invalid group members'); data.members.forEach(member => id(member)); check(new Set(data.members).size === data.members.length, 'Duplicate group member'); }
  if (data.collapsed !== undefined) check(typeof data.collapsed === 'boolean', 'Invalid group collapsed state');
  if (data.gridColumns !== undefined) check(Number.isSafeInteger(data.gridColumns) && data.gridColumns >= 0 && data.gridColumns <= 50, 'Invalid group columns');
  if (data.gridRows !== undefined) check(Number.isSafeInteger(data.gridRows) && data.gridRows >= 0 && data.gridRows <= 50, 'Invalid group rows');
  check(Object.keys(node).every(key => ['id', 'type', 'x', 'y', 'width', 'height', 'data'].includes(key)), 'Unknown node field');
}
function validateDocument(doc) {
  check(doc.schemaVersion === 1, 'Unsupported canvas format'); id(doc.id); text(doc.title, 200);
  if (doc.description === undefined) doc.description = '';
  if (doc.color === undefined) doc.color = 'neutral';
  text(doc.description, 2000); check(['yellow', 'blue', 'green', 'pink', 'neutral'].includes(doc.color), 'Invalid canvas color');
  check(Number.isSafeInteger(doc.revision) && doc.revision >= 0, 'Invalid revision');
  check(Array.isArray(doc.nodes) && doc.nodes.length <= 1500 && Array.isArray(doc.edges) && doc.edges.length <= 5000, 'Canvas size limit exceeded');
  const nodes = new Set();
  for (const node of doc.nodes) { validateNode(node); check(!nodes.has(node.id), 'Duplicate node ID'); nodes.add(node.id); }
  for (const node of doc.nodes) if (node.type === 'group' && node.data.members) for (const member of node.data.members) { check(member !== node.id && nodes.has(member), 'Group member does not exist'); }
  const edges = new Set();
  for (const edge of doc.edges) {
    id(edge.id); check(!edges.has(edge.id), 'Duplicate edge ID'); edges.add(edge.id);
    check(nodes.has(edge.source) && nodes.has(edge.target), 'Edge endpoint does not exist');
    check(edge.source !== edge.target, 'Cannot connect a node to itself');
    if (edge.label !== undefined) text(edge.label, 500);
    check(Object.keys(edge).every(key => ['id', 'source', 'target', 'label'].includes(key)), 'Unknown edge field');
  }
  check(Buffer.byteLength(JSON.stringify(doc)) <= maxDocumentBytes, 'Canvas too large');
  return doc;
}
function defaultRoot() { return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'fast-canvas'); }
class CanvasStore {
  constructor(root = defaultRoot()) {
    this.root = path.resolve(root); fs.mkdirSync(this.root, { recursive: true });
    this.assetsRoot = path.join(this.root, 'assets'); fs.mkdirSync(this.assetsRoot, { recursive: true });
  }
  file(canvasId) { return path.join(this.root, `${id(canvasId)}.json`); }
  read(canvasId) {
    const file = this.file(canvasId);
    check(fs.statSync(file).size <= maxDocumentBytes, 'Canvas too large');
    return validateDocument(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  list() {
    return fs.readdirSync(this.root).filter(file => /^[A-Za-z0-9_-]{1,80}\.json$/.test(file)).flatMap(file => {
      try { const doc = this.read(file.slice(0, -5)); return [{ id: doc.id, title: doc.title, description: doc.description, color: doc.color, revision: doc.revision, updatedAt: doc.updatedAt, nodes: doc.nodes.length, preview: doc.nodes.slice(0, 24).map(node => ({ id: node.id, type: node.type, x: node.x, y: node.y, width: node.width, height: node.height, color: node.data.color || null })), groups: doc.nodes.filter(node => node.type === 'group').length }]; }
      catch { return []; }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async lock(canvasId, work) {
    const file = `${this.file(canvasId)}.lock`, deadline = Date.now() + 10000;
    let handle;
    while (!handle) {
      try { handle = fs.openSync(file, 'wx'); fs.writeFileSync(handle, String(process.pid)); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const pid = Number(fs.readFileSync(file, 'utf8'));
          if (Number.isSafeInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); } catch (probe) { if (probe.code === 'ESRCH') fs.unlinkSync(file); }
          } else if (Date.now() - fs.statSync(file).mtimeMs > 60000) fs.unlinkSync(file);
        } catch (probe) { if (probe.code !== 'ENOENT') throw probe; }
        check(Date.now() < deadline, 'Canvas is busy; retry later');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try { return await work(); } finally { fs.closeSync(handle); fs.unlinkSync(file); }
  }
  save(doc) {
    validateDocument(doc);
    const target = this.file(doc.id), temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      const handle = fs.openSync(temporary, 'wx');
      try { fs.writeFileSync(handle, JSON.stringify(doc, null, 2) + '\n'); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      fs.renameSync(temporary, target);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  async create(title = '新画布', canvasId = crypto.randomUUID(), source = 'user', metadata = {}) {
    id(canvasId); text(title, 200); check(metadata && typeof metadata === 'object' && !Array.isArray(metadata), 'Invalid canvas metadata');
    const description = metadata.description === undefined ? '' : text(metadata.description, 2000);
    const color = metadata.color === undefined ? 'neutral' : metadata.color; check(['yellow', 'blue', 'green', 'pink', 'neutral'].includes(color), 'Invalid canvas color');
    return this.lock(canvasId, () => {
      check(!fs.existsSync(this.file(canvasId)), 'Canvas already exists');
      const now = new Date().toISOString();
      const doc = { schemaVersion: 1, id: canvasId, title, description, color, revision: 0, createdAt: now, updatedAt: now, nodes: [], edges: [], lastChange: { source, nodeIds: [], message: '创建画布' } };
      this.save(doc); return doc;
    });
  }
  async apply(canvasId, expectedRevision, operations, source = 'user', message = '') {
    check(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, 'expectedRevision is required');
    check(Array.isArray(operations) && operations.length > 0 && operations.length <= 300, 'Require 1-300 operations');
    text(message, 500); check(['user', 'model'].includes(source), 'Invalid change source');
    return this.lock(canvasId, () => {
      const doc = this.read(canvasId);
      if (doc.revision !== expectedRevision) { const error = new Error(`Revision conflict: expected ${expectedRevision}, current ${doc.revision}. Read the canvas and retry.`); error.code = 'REVISION_CONFLICT'; throw error; }
      const changed = new Set();
      for (const operation of operations) {
        check(operation && typeof operation === 'object', 'Invalid operation');
        const findNode = nodeId => { const node = doc.nodes.find(item => item.id === id(nodeId)); check(node, 'Node not found'); return node; };
        switch (operation.op) {
          case 'set_title': doc.title = text(operation.title, 200); break;
          case 'set_metadata': {
            if (operation.title !== undefined) doc.title = text(operation.title, 200);
            if (operation.description !== undefined) doc.description = text(operation.description, 2000);
            if (operation.color !== undefined) { check(['yellow', 'blue', 'green', 'pink', 'neutral'].includes(operation.color), 'Invalid canvas color'); doc.color = operation.color; }
            break;
          }
          case 'replace_content': {
            const content = operation.content;
            check(content && typeof content === 'object' && !Array.isArray(content), 'Invalid canvas content');
            check(Object.keys(content).every(key => ['title', 'description', 'color', 'nodes', 'edges'].includes(key)), 'Unknown canvas content field');
            const restored = copy(content);
            const previousIds = doc.nodes.map(node => node.id);
            doc.title = text(restored.title, 200); doc.description = restored.description === undefined ? doc.description : text(restored.description, 2000); doc.color = restored.color === undefined ? doc.color : restored.color; doc.nodes = restored.nodes; doc.edges = restored.edges;
            validateDocument(doc);
            for (const nodeId of [...previousIds, ...doc.nodes.map(node => node.id)]) changed.add(nodeId);
            break;
          }
          case 'upsert_node': {
            const node = copy(operation.node); validateNode(node);
            const index = doc.nodes.findIndex(item => item.id === node.id);
            if (index < 0) doc.nodes.push(node); else doc.nodes[index] = node;
            changed.add(node.id); break;
          }
          case 'set_group_members': {
            const group = findNode(operation.id); check(group.type === 'group', 'Node is not a group');
            check(Array.isArray(operation.members) && operation.members.length <= 1500, 'Invalid group members');
            const members = operation.members.map(member => id(member));
            check(new Set(members).size === members.length && !members.includes(group.id), 'Invalid group members');
            members.forEach(member => check(doc.nodes.some(node => node.id === member), 'Group member does not exist'));
            group.data.members = members; changed.add(group.id); members.forEach(member => changed.add(member)); break;
          }
          case 'update_node': {
            const node = findNode(operation.id), patch = operation.patch;
            check(patch && typeof patch === 'object' && !Array.isArray(patch), 'Invalid patch');
            check(Object.keys(patch).every(key => ['x', 'y', 'width', 'height', 'data'].includes(key)), 'Unsupported node patch');
            for (const key of ['x', 'y', 'width', 'height']) if (patch[key] !== undefined) node[key] = patch[key];
            if (patch.data !== undefined) node.data = { ...node.data, ...copy(patch.data) };
            validateNode(node); changed.add(node.id); break;
          }
          case 'remove_node': {
            findNode(operation.id); doc.nodes = doc.nodes.filter(node => node.id !== operation.id);
            doc.edges = doc.edges.filter(edge => edge.source !== operation.id && edge.target !== operation.id); changed.add(operation.id); break;
          }
          case 'upsert_edge': {
            const edge = copy(operation.edge); id(edge.id);
            const index = doc.edges.findIndex(item => item.id === edge.id);
            if (index < 0) doc.edges.push(edge); else doc.edges[index] = edge;
            changed.add(edge.source); changed.add(edge.target); break;
          }
          case 'remove_edge': {
            id(operation.id); check(doc.edges.some(edge => edge.id === operation.id), 'Edge not found');
            doc.edges = doc.edges.filter(edge => edge.id !== operation.id); break;
          }
          default: throw new Error('Unsupported operation');
        }
      }
      for (const group of doc.nodes.filter(node => node.type === 'group')) group.data.members = (group.data.members || []).filter(member => doc.nodes.some(node => node.id === member));
      validateDocument(doc);
      doc.revision++; doc.updatedAt = new Date().toISOString();
      doc.lastChange = { source, nodeIds: [...changed], message: message || (source === 'model' ? '模型更新了画布' : '已自动保存') };
      this.save(doc); return doc;
    });
  }
  async delete(canvasId, expectedRevision) {
    id(canvasId); check(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, 'expectedRevision is required');
    return this.lock(canvasId, () => {
      const doc = this.read(canvasId);
      if (doc.revision !== expectedRevision) { const error = new Error(`Revision conflict: expected ${expectedRevision}, current ${doc.revision}. Read the canvas and retry.`); error.code = 'REVISION_CONFLICT'; throw error; }
      const trash = path.join(this.root, '.trash'), restoreToken = crypto.randomUUID();
      fs.mkdirSync(trash, { recursive: true });
      fs.renameSync(this.file(canvasId), path.join(trash, `${restoreToken}.json`));
      return { deleted: true, id: canvasId, restoreToken, canvases: this.list() };
    });
  }
  async restore(restoreToken) {
    const file = path.join(this.root, '.trash', `${id(restoreToken)}.json`);
    check(fs.statSync(file).size <= maxDocumentBytes, 'Canvas too large');
    const original = validateDocument(JSON.parse(fs.readFileSync(file, 'utf8')));
    return this.lock(original.id, () => {
      check(!fs.existsSync(this.file(original.id)), 'A canvas with this ID already exists; the deleted canvas was not overwritten.');
      const doc = validateDocument(JSON.parse(fs.readFileSync(file, 'utf8')));
      // Invalidate any write that was queued before deletion, including a model's
      // old expectedRevision. History in open editors is also reset by the UI.
      doc.revision++; doc.updatedAt = new Date().toISOString();
      doc.lastChange = { source: 'user', nodeIds: [], message: '已恢复删除的画布' };
      this.save(doc); fs.unlinkSync(file);
      return { restored: true, canvas: doc, canvases: this.list() };
    });
  }
  signal(canvasId, nodeIds = []) {
    id(canvasId); check(Array.isArray(nodeIds) && nodeIds.length <= 300, 'Too many focus nodes'); nodeIds.forEach(id);
    const target = path.join(this.root, '.open.json'), temporary = `${target}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ id: canvasId, nodeIds, nonce: crypto.randomUUID() })); fs.renameSync(temporary, target);
  }
  importImage(source) {
    check(path.isAbsolute(source), 'Image path must be absolute');
    const stat = fs.statSync(source); check(stat.isFile() && stat.size <= 15 * 1024 * 1024, 'Image must be a file under 15 MB');
    const bytes = fs.readFileSync(source);
    let ext;
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ext = 'png';
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ext = 'jpg';
    else if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) ext = 'gif';
    else if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') ext = 'webp';
    check(ext, 'Only PNG/JPEG/GIF/WebP images are supported');
    const asset = `${crypto.createHash('sha256').update(bytes).digest('hex')}.${ext}`;
    fs.writeFileSync(path.join(this.assetsRoot, asset), bytes); return asset;
  }
  imageData(asset) {
    check(typeof asset === 'string' && /^[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(asset), 'Invalid asset');
    const target = path.join(this.assetsRoot, asset); check(fs.statSync(target).size <= 15 * 1024 * 1024, 'Image too large');
    const ext = path.extname(asset).slice(1);
    return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${fs.readFileSync(target).toString('base64')}`;
  }
}
module.exports = { CanvasStore, defaultRoot, validateDocument };
