import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// 26.1120 moved the manager and its request admission table into the utility.
// Extend that existing RPC control; never create a second app-server connection.
export function patchRemoteApprovalHost(original, patched = original) {
  assert.equal(createHash('sha256').update(original).digest('hex'), '1a27128021253ea901a0edab2fc5013920104ca1ad73d7ff7fc4df6e0098cf46', 'Remote approval host module changed');
  const replace = (from, to) => {
    assert.equal(patched.split(from).length, 2, 'Remote approval host anchor changed: ' + from);
    patched = patched.replace(from, () => to);
  };
  const open = 'openClient(){return this.#el(),new u_(()=>(this.#el(),this.#ei),"client",this.#Z)}';
  replace(open, open + 'openForgeRemoteApprovals(){return this.#el(),require(require("node:path").join(process.resourcesPath,"fast-extension/remote-approvals-native.cjs")).open({manager:this.#ei,router:this.#es,assertCurrent:this.#el,lease:iK})}');
  // The extra authorizer is evaluated by native sendThreadResponse immediately
  // before its existing admission/connection guard and transport send.
  replace('async sendResponse(e,t,r=!1){let n=this.requests.get(t.id);', 'async sendResponse(e,t,r=!1,forgeAuthorize){let n=this.requests.get(t.id);');
  replace('this.replies.send(e,t,n.admission,r)', 'this.replies.send(e,t,n.admission,r,forgeAuthorize)');
  replace('async send(e,t,r,n){if(n&&"connected"!==this.#eS.getConnectionState())', 'async send(e,t,r,n,forgeAuthorize){if(n&&"connected"!==this.#eS.getConnectionState())');
  replace('this.#eS.handleClientResponse(t,i.threadId,()=>s=this.#eQ()&&this.#ez.get(t.id)===i)', 'this.#eS.handleClientResponse(t,i.threadId,Object.assign(()=>s=this.#eQ()&&this.#ez.get(t.id)===i,{authorize:forgeAuthorize}))');
  return patched;
}

export function patchRemoteApprovalMain(original, patched, spec) {
  assert.equal(createHash('sha256').update(original).digest('hex'), spec.sha256, 'Remote approval main module changed');
  const anchor = 'this.appServerManagersService=new P$(this.hostAppServerManagers,this.hostAppServerAccounts)';
  assert.equal(patched.split(anchor).length, 2, 'Remote approval manager registry anchor changed');
  return patched.replace(anchor, anchor + ',this.disposables.add(require(require("node:path").join(process.resourcesPath,"fast-extension/main.cjs")).attachNativeRemoteApprovals(this.hostAppServerManagers))');
}
