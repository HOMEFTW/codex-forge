// Local fixture-only UI verification. Never points at a real user vault.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const { NexusService } = require('../runtime/nexus.cjs');
const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'output', 'playwright');
fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(output, 'obsidian-')), vault = path.join(directory, '演示知识库'); fs.mkdirSync(vault);
const put = (name, content) => { const target = path.join(vault, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
put('首页.md', `---
tags: [知识库, 设计]
status: active
---
# 轮机设计工作台

把项目、设备与每天的思考连接起来。这里是 **Forge 独立运行**的知识库。

> [!tip] 从这里开始
> 查看 [[设备/主机|主机设备笔记]]，或通过日记记录今天的设计工作。

## 今日关注
- [ ] 完成主机参数校核
- [x] 更新系统图纸索引

## 设备一览

\`\`\`dataview
TABLE WITHOUT ID
  file.link AS 设备,
  功率 AS "额定功率 kW",
  status AS 状态
FROM "设备"
SORT 功率 DESC
\`\`\`

## 功率对比
\`\`\`chart
type: bar
labels: [主机, 辅机]
series:
  - title: 功率 kW
    data: [1200, 300]
\`\`\`

## 系统关系
\`\`\`mermaid
graph LR
  A[燃油系统] --> B[主机]
  B --> C[推进轴系]
\`\`\`

## 设计公式
行内公式 $P = 2 \\pi n T$。

$$
Q = \\frac{P}{\\eta}
$$

==待校核==，参考脚注[^1]。
[^1]: 验证用样例数据。
`);
put('设备/主机.md', '---\naliases: [引擎]\ntags: [设备, 轮机]\n功率: 1200\nstatus: active\n---\n# 主机\n\n[[首页]]\n\n## 参数\n| 参数 | 数值 |\n| --- | ---: |\n| 功率 | 1200 |\n\n- 参数校核\n  - 输入数据\n- 图纸检查\n  - 布置检查\n');
put('设备/辅机.md', '---\ntags: [设备]\n功率: 300\nstatus: done\n---\n# 辅机\n[[主机]]\n');
put('模板/日记.md', '# {{title}}\n\n## 今日工作\n- [ ] 完成设计复核\n\n日期：{{date}}\n');
put('模板/设备.md', '# {{NAME}}\n\n{{VALUE:描述}}\n');
put('设备数据库.base', 'filters: file.inFolder("设备")\nviews:\n  - type: table\n    name: 设备表\n    order: [file.name, 功率, status]\n    summaries:\n      功率: Sum\n  - type: cards\n    name: 设备卡片\n    order: [file.name, 功率]\n');
put('嵌入测试.md', '# 嵌入测试\n![[设备/主机#参数]]\n![[设备数据库.base]]\n\n行内查询 `= this.file.name`\n');
put('恶意内容测试.md', '# 安全测试\n<img src="https://example.invalid/private" onerror="window.pwned=true">\n<script>window.pwned=true</script>\n<iframe src="https://example.invalid"></iframe>\n<a href="javascript:alert(1)">链接</a>\n');
put('.obsidian/templates.json', JSON.stringify({ folder: '模板' }));
put('.obsidian/daily-notes.json', JSON.stringify({ folder: '日记', template: '模板/日记' }));
put('.obsidian/plugins/homepage/data.json', JSON.stringify({ version: 4, homepages: { Home: { value: '首页', kind: 'File' } } }));
put('.obsidian/community-plugins.json', JSON.stringify(['table-editor-obsidian', 'obsidian-charts', 'homepage', 'obsidian-outliner', 'templater-obsidian', 'dataview', 'quickadd']));
put('.obsidian/plugins/quickadd/data.json', JSON.stringify({ choices: [{ id: 'capture', name: '快速收件', type: 'Capture', captureTo: '日记/{{DATE:YYYY-MM-DD}}_收件.md', format: { enabled: true, format: '- {{VALUE}}' }, createFileIfItDoesntExist: { enabled: true } }, { id: 'template', name: '设备笔记', type: 'Template', templatePath: '模板/设备.md', folder: { enabled: true, folders: ['设备'] }, fileNameFormat: { enabled: true, format: '{{VALUE:设备名称}}' } }] }));
const service = new NexusService({ root: path.join(directory, 'state') }); service.connect(vault);
const entry = `import React from 'react';import{createRoot}from'react-dom/client';import './ui/bridge.js';import Panel from './ui/nexus.jsx';import '@xyflow/react/dist/style.css';document.body.style.margin='0';document.getElementById('root').style.height='100vh';createRoot(document.getElementById('root')).render(<Panel api={window.fastCanvas} mode="expanded" onMode={()=>{}} onClose={()=>{}}/>);`;
await build({ stdin: { contents: entry, resolveDir: root, loader: 'jsx' }, bundle: true, outfile: path.join(directory, 'panel.js'), loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } });
const token = crypto.randomUUID();
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/rpc') {
      if (req.headers['x-test-token'] !== token) { res.writeHead(403).end(); return; }
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 10 * 1024 * 1024) throw Error('too large'); }
      const request = JSON.parse(body); if (request.method !== 'nexus') throw Error('fixture only');
      const { method, args } = request.args; if (['connect', 'disconnect'].includes(method)) throw Error('fixture vault cannot be changed');
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result: service.dispatch(method, args) })); return;
    }
    if (req.url === '/panel.js' || req.url === '/panel.css') { res.setHeader('Content-Type', req.url.endsWith('js') ? 'text/javascript' : 'text/css'); res.end(fs.readFileSync(path.join(directory, req.url.slice(1)))); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const child = '<!doctype html><html><head><link rel="stylesheet" href="/panel.css"></head><body><div id="root"></div><script src="/panel.js"></script></body></html>';
    res.end(`<!doctype html><html><head><title>Forge Nexus 验证</title></head><body style="margin:0"><iframe id="panel" title="Nexus" sandbox="allow-scripts" style="border:0;width:100%;height:100vh"></iframe><script>const frame=document.getElementById('panel');frame.srcdoc=${JSON.stringify(child).replace(/</g, "\\u003c")};window.addEventListener('message',async event=>{if(event.source!==frame.contentWindow)return;const request=event.data?.fastCanvasRequest;if(!request)return;try{const value=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json','X-Test-Token':${JSON.stringify(token)}},body:JSON.stringify(request)}).then(r=>r.json());frame.contentWindow.postMessage({fastCanvasReply:request.id,...value},'*')}catch(error){frame.contentWindow.postMessage({fastCanvasReply:request.id,error:error.message},'*')}});</script></body></html>`);
  } catch (error) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: error.message })); }
});
server.listen(0, '127.0.0.1', () => { const url = `http://127.0.0.1:${server.address().port}`; fs.writeFileSync(path.join(output, 'nexus-preview.json'), JSON.stringify({ url, directory, vault }, null, 2)); console.log(JSON.stringify({ url, directory, vault })); });
