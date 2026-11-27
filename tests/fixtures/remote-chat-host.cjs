'use strict';
// Isolated native-method integration fixture. No app-server process/network/account.
const vm = require('node:vm');
const upstream = require('./remote-chat-native-261120.json');
function createNativeConnection({request = async () => ({data: [], nextCursor: null})} = {}) {
  const methods = vm.runInNewContext('({' + Object.values(upstream.methods).join(',') + '})', {ei:require('node:crypto'), $:{PpM:()=>undefined,DDP:value=>String(value),ZJQ:()=>false}, console});
  const calls=[],replies=[],states=new Set(),principals=new Set();let state='connected';
  const add=set=>fn=>{set.add(fn);return()=>set.delete(fn);};
  const connection=Object.assign(Object.create(methods),{
    getConnectionState:()=>state,ensureReady:async()=>{if(state!=='connected')throw Error('Disconnected');},
    options:{hostId:'local'},logger:{trace(){},info(){},warning(){}},
    userVerification:{remove(){}},turnCwds:{observeClientResponse(){}},requestUserInputAutoResolution:{stopTrackingRequest(){}},
    internalNotificationHandlers:new Map(),executorRequests:{handleNotification(){}},configuration:{handleSuccessfulRequest(){}},
    registerInternalConnectionStateHandler:add(states),registerInternalAuthenticatedPrincipalChangeHandler:add(principals),
    messageDelivery:{sendMessage:message=>replies.push(message),broadcastToWindows(){}},hostEventHandler:{onRequest:()=>true},
    sendInternalRequest:async message=>{calls.push(message);return {result:await request(message.method,message.params)};},
  });
  return {connection,calls,replies,notify:(method,params)=>connection.notifyInternalNotificationHandlers({method,params}),humanRequest:request=>connection.dispatchServerRequest(request,request.params.threadId),setState:value=>{state=value;for(const fn of states)fn(value);},changeAccount:()=>{for(const fn of principals)fn({});}};
}
module.exports={createNativeConnection};
