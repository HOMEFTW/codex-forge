'use strict';
const permissions = ['remote.control'];
const capabilities = {'remote-chat': {version: 1, permission: 'remote.control'}};
const methods = Object.fromEntries(['request', 'events', 'respond', 'bootstrap', 'pending'].map(name => ['remoteChat.' + name, 'remote-chat']));
module.exports = {permissions, capabilities, methods};
