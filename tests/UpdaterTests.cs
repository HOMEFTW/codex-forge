using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Text;
using System.IO.Compression;

internal sealed class FixtureHTTP : HttpMessageHandler {
    internal Func<HttpRequestMessage,HttpResponseMessage> Response;
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token){token.ThrowIfCancellationRequested();return Task.FromResult(Response(request));}
}
internal static class UpdaterTests {
    static int passed;
    static void Check(bool value,string name){if(!value)throw new Exception(name);passed++;}
    static void Reject(Action action,string name){try{action();}catch{passed++;return;}throw new Exception("Expected failure: "+name);}
    static Dictionary<string,object> Dict(string text){return BootstrapCore.Json.Deserialize<Dictionary<string,object>>(text);}
    static string Hash(byte[] bytes,string directory){string file=Path.Combine(directory,"hash");File.WriteAllBytes(file,bytes);return BootstrapCore.Hash(file);}
    static async Task Run(string root){
        var data=Encoding.UTF8.GetBytes("abcdefghij");string sha=Hash(data,root),file=Path.Combine(root,"download.msi");
        var handler=new FixtureHTTP();int calls=0;
        handler.Response=request=>{calls++;Check(request.Headers.Range.Ranges.ToString()!=null,"range request");var response=new HttpResponseMessage(HttpStatusCode.PartialContent){Content=new ByteArrayContent(Encoding.UTF8.GetBytes("fghij"))};response.Content.Headers.ContentRange=new ContentRangeHeaderValue(5,9,10);return response;};
        File.WriteAllText(file+".partial","abcde");using(var client=new HttpClient(handler))await ForgeUpdateCore.Download(client,"https://github.com/A/B/releases/download/v1/a.msi",file,10,sha,(s,p)=>{},CancellationToken.None);
        Check(File.ReadAllText(file)=="abcdefghij"&&calls==1,"206 resume exact bytes");
        File.Delete(file);File.WriteAllText(file+".partial","abcde");handler=new FixtureHTTP{Response=request=>new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(data)}};
        using(var client=new HttpClient(handler))await ForgeUpdateCore.Download(client,"https://github.com/A/B/releases/download/v1/a.msi",file,10,sha,(s,p)=>{},CancellationToken.None);Check(File.ReadAllText(file)=="abcdefghij","200 restarts file instead of appending");
        File.Delete(file);handler=new FixtureHTTP{Response=request=>{var response=new HttpResponseMessage(HttpStatusCode.PartialContent){Content=new ByteArrayContent(data)};response.Content.Headers.ContentRange=new ContentRangeHeaderValue(1,10,11);return response;}};
        using(var client=new HttpClient(handler))Reject(()=>ForgeUpdateCore.Download(client,"https://github.com/A/B/releases/download/v1/a.msi",file,10,sha,(s,p)=>{},CancellationToken.None).GetAwaiter().GetResult(),"bad range");
        handler=new FixtureHTTP{Response=request=>new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(data)}};
        using(var client=new HttpClient(handler))Reject(()=>ForgeUpdateCore.Download(client,"https://github.com/A/B/releases/download/v1/a.msi",file,10,new string('a',64),(s,p)=>{},CancellationToken.None).GetAwaiter().GetResult(),"bad hash");Check(!File.Exists(file)&&!File.Exists(file+".partial"),"bad hash never published");
        File.WriteAllText(file+".partial","abc");using(var client=new HttpClient(new FixtureHTTP())){var cancel=new CancellationTokenSource();cancel.Cancel();Reject(()=>ForgeUpdateCore.Download(client,"https://github.com/A/B/releases/download/v1/a.msi",file,10,sha,(s,p)=>{},cancel.Token).GetAwaiter().GetResult(),"cancel");}Check(File.ReadAllText(file+".partial")=="abc","cancel preserves partial");
        handler=new FixtureHTTP{Response=request=>{var r=new HttpResponseMessage(HttpStatusCode.Redirect);r.Headers.Location=new Uri("http://untrusted.example/a");return r;}};
        using(var client=new HttpClient(handler))Reject(()=>ForgeUpdateCore.Get(client,new Uri("https://github.com/A/B/releases/download/v1/a"),0,CancellationToken.None).GetAwaiter().GetResult(),"untrusted redirect");
        Reject(()=>ForgeUpdateCore.Client("http://user:password@localhost:8080"),"credential proxy");
        string baseline=Path.Combine(root,"base"),deltaFile=Path.Combine(root,"delta.json"),target=Path.Combine(root,"target");File.WriteAllBytes(baseline,data);string after=Hash(Encoding.UTF8.GetBytes("fghij!"),root);
        var delta=Dict("{\"schemaVersion\":1,\"format\":\"forge-blocks-v1\",\"operations\":[{\"offset\":5,\"bytes\":5},{\"data\":\"IQ==\"}],\"toBytes\":6}");delta["fromSha256"]=sha;delta["toSha256"]=after;File.WriteAllText(deltaFile,BootstrapCore.Json.Serialize(delta));ForgeUpdateCore.ApplyDelta(baseline,deltaFile,target,after,6,CancellationToken.None);Check(File.ReadAllText(target)=="fghij!","delta reconstruction");
        Reject(()=>ForgeUpdateCore.ApplyDelta(baseline,deltaFile,target,new string('b',64),6,CancellationToken.None),"delta target mismatch");File.WriteAllText(baseline,"broken");Reject(()=>ForgeUpdateCore.ApplyDelta(baseline,deltaFile,target,after,6,CancellationToken.None),"delta base mismatch");
        File.WriteAllBytes(Path.Combine(root,sha+".artifact"),data);var edge=Dict("{\"kind\":\"portable\",\"bytes\":2,\"toBytes\":6,\"url\":\"https://github.com/A/B/releases/download/v1/a.delta.json\"}");edge["fromSha256"]=sha;edge["toSha256"]=after;edge["sha256"]=sha;var manifest=new Dictionary<string,object>{{"repository","A/B"},{"deltas",new[]{edge}}};
        Check(ForgeUpdateCore.DeltaChain(manifest,root,after,100,"portable").Count==1,"complete cheaper delta");Check(ForgeUpdateCore.DeltaChain(manifest,root,after,1,"portable").Count==0,"expensive delta rejected");Check(ForgeUpdateCore.DeltaChain(manifest,root,new string('c',64),100,"portable").Count==0,"missing chain rejected");File.WriteAllText(Path.Combine(root,sha+".artifact"),"tampered");Check(ForgeUpdateCore.DeltaChain(manifest,root,after,100,"portable").Count==0,"tampered cache rejected");
        string zip=Path.Combine(root,"hostile.zip");using(var archive=ZipFile.Open(zip,ZipArchiveMode.Create))using(var writer=new StreamWriter(archive.CreateEntry("../escaped.txt").Open()))writer.Write("bad");
        var install=new Dictionary<string,object>{{"portableBytes",new FileInfo(zip).Length},{"portableSha256",BootstrapCore.Hash(zip)}};Reject(()=>ForgeUpdateCore.InstallPortable(zip,root,install,CancellationToken.None),"zip traversal rejected");Check(!File.Exists(Path.Combine(root,"escaped.txt")),"no escaped file");
        Reject(()=>ForgeUpdateCore.Asset("https://github.com/A/C/releases/download/v1/a.zip","A/B"),"foreign repository");
        Check(ForgeUpdateCore.Compatible("0.5.0",new[]{">=0.4.0 <0.6.0"})&&!ForgeUpdateCore.Compatible("0.5.0",new[]{">=0.4.0 <0.5.0"}),"external plugin range respected");
        string pluginHome=Path.Combine(root,"plugins-home");Directory.CreateDirectory(Path.Combine(pluginHome,"plugins","test.notes"));File.WriteAllText(Path.Combine(pluginHome,"plugins.json"),"{\"plugins\":{\"test.notes\":{\"enabled\":true}}}");File.WriteAllText(Path.Combine(pluginHome,"plugins","test.notes","plugin.json"),"{\"apiVersion\":3,\"compatibility\":{\"forge\":[\">=0.4.0 <0.5.0\"],\"codex\":[\"26.1103.4239.0\"]}}");
        var plan=Dict("{\"forgeVersion\":\"0.5.0\",\"codexVersion\":\"26.1103.4239.0\",\"apiVersion\":3}");Reject(()=>ForgeUpdateCore.CheckPlugins(plan,pluginHome),"enabled incompatible plugin blocks update");
        string source=Path.Combine(root,"zip-source"),payload=Path.Combine(source,"forge","0.5.0");Directory.CreateDirectory(payload);
        string config=Path.Combine(payload,"forge.config.json");File.WriteAllText(config,"{\"version\":\"0.5.0\"}");
        var content=new Dictionary<string,object>{{"forgeVersion","0.5.0"},{"files",new[]{new Dictionary<string,object>{{"path","forge.config.json"},{"bytes",new FileInfo(config).Length},{"sha256",BootstrapCore.Hash(config)}}}}};content["payloadDigest"]=BootstrapCore.PayloadDigest(content);File.WriteAllText(Path.Combine(payload,"forge-payload.json"),BootstrapCore.Json.Serialize(content));
        foreach(string name in new[]{"CodexForge.exe","CodexForge.exe.config","CodexForgeUpdater.exe","CodexForgeUpdater.exe.config"})File.WriteAllText(Path.Combine(source,name),"fixture");File.WriteAllText(Path.Combine(source,"bootstrap.json"),"{\"directory\":\"forge/0.5.0\"}");File.WriteAllText(Path.Combine(root,"bootstrap.json"),"{\"directory\":\"forge/0.4.4\"}");File.WriteAllText(Path.Combine(root,"current.json"),"retain-current-client");File.WriteAllText(Path.Combine(root,"my-data.txt"),"retain-user-data");
        string goodZip=Path.Combine(root,"valid.zip");ZipFile.CreateFromDirectory(source,goodZip);plan["portableBytes"]=new FileInfo(goodZip).Length;plan["portableSha256"]=BootstrapCore.Hash(goodZip);
        using(var setupLock=new FileStream(Path.Combine(root,".forge-prepare.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None))Reject(()=>ForgeUpdateCore.InstallPortable(goodZip,root,plan,CancellationToken.None),"preparation lock blocks concurrent update");
        Check(File.ReadAllText(Path.Combine(root,"bootstrap.json")).Contains("0.4.4")&&!Directory.Exists(Path.Combine(root,"forge","0.5.0")),"locked update leaves installation untouched");
        ForgeUpdateCore.InstallPortable(goodZip,root,plan,CancellationToken.None);Check(File.ReadAllText(Path.Combine(root,"bootstrap.json")).Contains("0.5.0")&&File.ReadAllText(Path.Combine(root,"bootstrap.json.previous")).Contains("0.4.4"),"portable publishes pointer with backup");Check(File.ReadAllText(Path.Combine(root,"current.json"))=="retain-current-client"&&File.ReadAllText(Path.Combine(root,"my-data.txt"))=="retain-user-data","portable retains current client and user data");
        File.WriteAllText(Path.Combine(root,"forge","0.5.0","forge.config.json"),"corrupt");ForgeUpdateCore.InstallPortable(goodZip,root,plan,CancellationToken.None);Check(File.ReadAllText(Path.Combine(root,"forge","0.5.0","forge.config.json")).Contains("0.5.0"),"same-version repair restores verified payload");
        Console.WriteLine("Updater tests passed: "+passed);
    }
    static int Main(string[] args){string root=Path.Combine(Path.GetFullPath(args[0]),"updater-tests-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);try{Run(root).GetAwaiter().GetResult();return 0;}catch(Exception e){Console.Error.WriteLine(e);return 1;}finally{Directory.Delete(root,true);}}
}
