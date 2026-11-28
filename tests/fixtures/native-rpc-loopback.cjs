'use strict';
// Serializes every frame through the official RPC library; functions must cross
// as capabilities, exactly as manager-control and final authorizer callbacks do.
function loopback(rpc, bridge) {
  function endpoint() {
    const queue=[]; let resolve,reject,closed=false;
    return {encodingLevel:'structuredClonable',peer:null,
      send(value){if(closed)throw Error('RPC closed');this.peer.deliver(structuredClone(value));},
      deliver(value){if(resolve){const done=resolve;resolve=reject=null;done(value);}else queue.push(value);},
      receive(){if(closed)return Promise.reject(Error('RPC closed'));if(queue.length)return Promise.resolve(queue.shift());return new Promise((ok,no)=>{resolve=ok;reject=no;});},
      abort(){closed=true;reject?.(Error('RPC closed'));},
    };
  }
  const a=endpoint(),b=endpoint();a.peer=b;b.peer=a;
  class Control extends rpc.TF {openForgeRemoteApprovals(){return bridge;}}
  const server=new rpc.oB(b,new Control()),client=new rpc.oB(a);
  return {control:client.getRemoteMain(),close(){a.abort();b.abort();},server,client};
}
module.exports={loopback};
