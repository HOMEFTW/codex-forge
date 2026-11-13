'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {atomic,json}=require('./collaboration-store.cjs');
const {ForgeError}=require('./forge-errors.cjs');
function alias(name){return 'forge_'+name.replace(/[^A-Za-z0-9_-]/g,'_').slice(0,42)+'_'+crypto.createHash('sha256').update(name).digest('hex').slice(0,10);}
class ForgePluginBroker {
  constructor({root,tools,callTool,contextFor=context=>context}={}){Object.assign(this,{root,tools,callTool,contextFor});this.file=path.join(root,'plugin-broker.json');this.token=crypto.randomBytes(32).toString('hex');this.server=null;this.revision=0;this.controllers=new Set();this.closed=false;this.startPromise=null;this.disposing=null;}
  start(){
    if(this.closed)return Promise.reject(new ForgeError('CAPABILITY_UNAVAILABLE','插件工具宿主已关闭'));
    if(this.startPromise)return this.startPromise;
    this.server=http.createServer(async(request,response)=>{
      if(this.closed||request.method!=='POST'||request.headers.authorization!=='Bearer '+this.token||!['127.0.0.1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress)){response.writeHead(403);response.end();return;}
      const controller=new AbortController();this.controllers.add(controller);response.once('close',()=>{controller.abort();this.controllers.delete(controller);});
      try{
        const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>1024*1024)throw new ForgeError('RESOURCE_EXHAUSTED','插件工具参数超过限制');chunks.push(chunk);}
        const input=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');let value;
        if(request.url==='/tools/list')value=this.tools().map(item=>({name:alias(item.name),description:item.description,inputSchema:item.inputSchema,...(item.annotations?{annotations:item.annotations}:{})}));
        else if(request.url==='/tools/call'){
          const definition=this.tools().find(item=>alias(item.name)===input.name);if(!definition)throw new ForgeError('METHOD_NOT_FOUND','插件工具已撤销或不存在');
          const context=this.contextFor(input.context||{});value=await this.callTool(definition.name,input.args||{},context,{signal:controller.signal});
        }else throw new ForgeError('METHOD_NOT_FOUND','未知插件工具代理方法');
        const encoded=JSON.stringify({ok:true,value});if(Buffer.byteLength(encoded)>2*1024*1024)throw new ForgeError('RESOURCE_EXHAUSTED','插件工具结果超过限制');response.writeHead(200,{'content-type':'application/json'});response.end(encoded);
      }catch(error){if(!response.destroyed){response.writeHead(400,{'content-type':'application/json'});response.end(JSON.stringify({ok:false,error:{code:error.code||'INTERNAL_ERROR',message:String(error.message).slice(0,1000)}}));}}
    });
    const server=this.server;
    this.startPromise=(async()=>{
      try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});server.unref();this.publish();return this;}
      catch(error){this.stopPublishing();await new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve);});throw error;}
    })();
    return this.startPromise;
  }
  publish(){if(this.closed||!this.server?.listening)return false;atomic(this.file,{schemaVersion:1,pid:process.pid,port:this.server.address().port,token:this.token,revision:++this.revision});return true;}
  stopPublishing(){this.closed=true;if(json(this.file,{})?.token===this.token)try{fs.unlinkSync(this.file);}catch(error){if(error.code!=='ENOENT')throw error;}}
  dispose(){
    this.stopPublishing();for(const controller of this.controllers)controller.abort();
    if(!this.disposing)this.disposing=(async()=>{try{await this.startPromise;}catch{}if(this.server)await new Promise(resolve=>{this.server.closeAllConnections?.();this.server.close(resolve);});})();
    return this.disposing;
  }
}
async function brokerRequest(root,method,args={},fetchImpl=globalThis.fetch){
  const connection=json(path.join(root,'plugin-broker.json'),null);if(!connection)return method==='list'?[]:Promise.reject(new ForgeError('CAPABILITY_UNAVAILABLE','Forge 插件工具宿主未启动'));
  if(connection.schemaVersion!==1||!Number.isInteger(connection.port)||connection.port<1||connection.port>65535||!/^\w{64}$/.test(connection.token))throw new ForgeError('PERMISSION_DENIED','插件工具代理身份无效');
  const response=await fetchImpl('http://127.0.0.1:'+connection.port+'/tools/'+method,{method:'POST',headers:{authorization:'Bearer '+connection.token,'content-type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(method==='list'?3000:120000),redirect:'error'});
  const chunks=[];let count=0;for await(const chunk of response.body){count+=chunk.length;if(count>2*1024*1024)throw new ForgeError('RESOURCE_EXHAUSTED','插件工具代理响应过大');chunks.push(chunk);}
  const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value.ok)throw Object.assign(Error(value.error?.message||'插件工具调用失败'),{code:value.error?.code||'INTERNAL_ERROR'});return value.value;
}
module.exports={ForgePluginBroker,brokerRequest,alias};
