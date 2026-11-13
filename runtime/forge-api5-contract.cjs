'use strict';

const permissions = [
  'canvas.read','canvas.write','todos.read','todos.write','skills.read','skills.manage',
  'memory.read','memory.write','statistics.read','statistics.detect','collaboration.read','collaboration.run',
  'conversation.history','conversation.manage','conversation.send','conversation.events',
  'llm.call','llm.providers','tools.call','tools.register','services.call','services.provide','backend.node',
  'hooks.register','files.read','files.write','shell.execute','credentials.manage','network.request',
  'jobs.manage','schedules.manage','plugins.read','plugins.manage','logs.read','logs.write',
  'theme.read','theme.write','theme.register','shortcuts','settings.write',
];
const capabilities = {
  canvas:{version:1,permission:'canvas.read'}, todos:{version:1,permission:'todos.read'},
  skills:{version:1,permission:'skills.read'}, memory:{version:1,permission:'memory.read'},
  statistics:{version:1,permission:'statistics.read'}, collaboration:{version:1,permission:'collaboration.read'},
  'conversation-history':{version:1,permission:'conversation.history'},
  'conversation-management':{version:1,permission:'conversation.manage'},
  'conversation-send':{version:1,permission:'conversation.send'},
  'conversation-events':{version:1,permission:'conversation.events'},
  llm:{version:1,permission:'llm.call'}, tools:{version:1,permission:'tools.call'},
  services:{version:1,permission:'services.call'}, backend:{version:1,permission:'backend.node'},
  hooks:{version:1,permission:'hooks.register'}, files:{version:1,permission:'files.read'},
  shell:{version:1,permission:'shell.execute'}, credentials:{version:1,permission:'credentials.manage'},
  'network-request':{version:1,permission:'network.request'}, jobs:{version:1,permission:'jobs.manage'},
  schedules:{version:1,permission:'schedules.manage'}, plugins:{version:1,permission:'plugins.read'},
  logs:{version:1,permission:null}, theme:{version:1,permission:'theme.read'},
  shortcuts:{version:1,permission:'shortcuts'},
};
const methods = {
  'canvas.request':'canvas','todos.request':'todos','skills.request':'skills','memory.request':'memory',
  'statistics.request':'statistics','collaboration.request':'collaboration',
  'conversation.list':'conversation-history','conversation.read':'conversation-history',
  'conversation.create':'conversation-management','conversation.fork':'conversation-management',
  'conversation.send':'conversation-send','conversation.cancel':'conversation-send',
  'conversation.events':'conversation-events','llm.providers':'llm','llm.sample':'llm','llm.stream':'llm',
  'tools.list':'tools','tools.call':'tools','services.request':'services','backend.call':'backend',
  'hooks.list':'hooks','files.request':'files','shell.execute':'shell','credentials.set':'credentials',
  'credentials.delete':'credentials','credentials.describe':'credentials','network.fetch':'network-request',
  'jobs.request':'jobs','schedules.request':'schedules','plugins.list':'plugins','plugins.catalog':'plugins',
  'plugins.install':'plugins','plugins.checkUpdate':'plugins','plugins.update':'plugins',
  'plugins.enable':'plugins','plugins.uninstall':'plugins','logs.write':'logs','logs.read':'logs',
  'theme.get':'theme','theme.set':'theme','theme.register':'theme',
  'shortcuts.register':'shortcuts','shortcuts.unregister':'shortcuts','settings.set':'settings',
  'settings.snapshot':'settings','files.watch':'files','services.channel':'services','backend.channel':'backend',
};
const permissionCapabilities = Object.fromEntries(permissions.map(permission => {
  let name=permission.split('.')[0];
  if(permission.startsWith('conversation.')) name=({history:'conversation-history',manage:'conversation-management',send:'conversation-send',events:'conversation-events'})[permission.split('.')[1]];
  if(permission==='network.request')name='network-request';
  if(permission==='settings.write')name='settings';
  if(permission==='llm.providers')name='backend';
  if(permission==='tools.register'||permission==='services.provide')name='backend';
  return [permission,name];
}));
const hookNames=['llm.before','llm.after','tools.before','tools.after','conversation.beforeSend','conversation.afterSend'];
const contextPermissions=['conversation.read','conversation.history','conversation.manage','conversation.send','conversation.events','llm.call','tools.call','files.read','shell.execute','jobs.manage','schedules.manage','backend.node','services.call','todos.read','statistics.read','collaboration.read'];
function canReadContext(manifest){return manifest.permissions?.includes('conversation.read')||manifest.apiVersion>=5&&contextPermissions.some(permission=>manifest.permissions?.includes(permission));}
module.exports={permissions,capabilities,methods,permissionCapabilities,hookNames,contextPermissions,canReadContext};
