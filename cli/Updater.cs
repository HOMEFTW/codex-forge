using System;
using System.IO;
using System.IO.Compression;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

internal static class ForgeUpdateCore {
    internal const long Limit=256L*1024*1024;
    internal static string S(Dictionary<string,object> d,string key) { return BootstrapCore.Text(d,key); }
    internal static void Need(bool ok,string message) { BootstrapCore.Need(ok,message); }
    internal static bool Compatible(string version,IEnumerable ranges) {
        foreach(string range in ranges)foreach(string group in range.Split(new[]{"||"},StringSplitOptions.None)) {
            bool match=true;foreach(string item in group.Split(new[]{' '},StringSplitOptions.RemoveEmptyEntries)) {
                var token=Regex.Match(item,@"^(>=|<=|>|<|=|\^|~)?(\d+\.\d+\.\d+(?:\.\d+)?)$");Need(token.Success,"插件版本范围无效");
                string op=token.Groups[1].Value;Version target=new Version(token.Groups[2].Value),actual=new Version(version);int compare=actual.CompareTo(target);
                if(op=="^"||op=="~") {int major=target.Major,minor=target.Minor,build=target.Build;Version end=op=="~"?new Version(major,minor+1,0):major>0?new Version(major+1,0,0):minor>0?new Version(0,minor+1,0):new Version(0,0,build+1);match&=compare>=0&&actual<end;}
                else match&=op==">="?compare>=0:op=="<="?compare<=0:op==">"?compare>0:op=="<"?compare<0:compare==0;
            }if(match)return true;
        }return false;
    }
    internal static void CheckPlugins(Dictionary<string,object> plan,string home) {
        string state=Path.Combine(home,"plugins.json");if(!File.Exists(state))return;
        var entries=(Dictionary<string,object>)BootstrapCore.Read(state)["plugins"];
        foreach(var entry in entries) {
            if(entry.Key.StartsWith("forge.")||!((Dictionary<string,object>)entry.Value).ContainsKey("enabled")||!Convert.ToBoolean(((Dictionary<string,object>)entry.Value)["enabled"]))continue;
            string file=BootstrapCore.SafePath(home,"plugins/"+entry.Key+"/plugin.json");if(!File.Exists(file))continue;
            var plugin=BootstrapCore.Read(file);var ranges=(Dictionary<string,object>)plugin["compatibility"];
            Need(Convert.ToInt32(plugin["apiVersion"])==Convert.ToInt32(plan["apiVersion"])&&Compatible(S(plan,"forgeVersion"),(IEnumerable)ranges["forge"])&&Compatible(S(plan,"codexVersion"),(IEnumerable)ranges["codex"]),"已启用插件 "+entry.Key+" 未声明兼容目标版本，请先安装兼容版或在插件管理中停用");
        }
    }
    internal static void PlainPath(string file) {
        for(string value=Path.GetFullPath(file);!String.IsNullOrEmpty(value);value=Path.GetDirectoryName(value))if(File.Exists(value)||Directory.Exists(value))Need((File.GetAttributes(value)&FileAttributes.ReparsePoint)==0,"更新路径不允许链接或联接");
    }
    internal static Uri Asset(string value,string repository) {
        Uri uri;Need(Uri.TryCreate(value,UriKind.Absolute,out uri)&&uri.Scheme=="https"&&uri.Host=="github.com"&&uri.UserInfo==""&&uri.AbsolutePath.StartsWith("/"+repository+"/releases/download/",StringComparison.Ordinal),"更新地址不属于所选 GitHub 仓库");return uri;
    }
    internal static void Validate(Dictionary<string,object> m,string repository) {
        Need(Convert.ToInt32(m["schemaVersion"])==3&&S(m,"platform")=="win32-x64"&&S(m,"repository")==repository&&S(m,"distribution")=="msi-portable"&&!Convert.ToBoolean(m["containsOfficialClient"]),"更新清单身份不符");
        Need(Convert.ToInt32(m["apiVersion"])==3,"此更新器仅支持 Forge API 3");
        foreach(string k in new[]{"forgeVersion","codexVersion"}) { Version v;Need(Version.TryParse(S(m,k),out v)&&v.Build>=0,"版本号无效"); }
        Need(S(m,"codexVersion")!="26.1013.4894.0","禁止安装已撤回的客户端");
        foreach(string prefix in new[]{"","portable"}) {
            string hash=prefix==""?"sha256":"portableSha256",bytes=prefix==""?"bytes":"portableBytes",url=prefix==""?"url":"portableUrl";
            Need(Regex.IsMatch(S(m,hash),"^[a-f0-9]{64}$")&&Convert.ToInt64(m[bytes])>0&&Convert.ToInt64(m[bytes])<=Limit,"更新摘要或大小无效");
            Need(Asset(S(m,url),repository).AbsolutePath.EndsWith(prefix==""?".msi":".zip",StringComparison.OrdinalIgnoreCase),"更新文件类型不符");
        }
    }
    internal static HttpClient Client(string proxy) {
        ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;
        var handler=new HttpClientHandler { AllowAutoRedirect=false };
        if(!String.IsNullOrWhiteSpace(proxy)) { Uri uri;Need(Uri.TryCreate(proxy,UriKind.Absolute,out uri)&&(uri.Scheme=="http"||uri.Scheme=="https")&&uri.UserInfo==""&&uri.AbsolutePath=="/"&&uri.Query==""&&uri.Fragment=="","代理应为 http(s)://主机:端口，不含凭据");handler.Proxy=new WebProxy(uri);handler.UseProxy=true; }
        var client=new HttpClient(handler) { Timeout=TimeSpan.FromMinutes(30) };client.DefaultRequestHeaders.UserAgent.ParseAdd("Codex-Forge-Updater/0.5.2");return client;
    }
    internal static async Task<HttpResponseMessage> Get(HttpClient client,Uri uri,long offset,CancellationToken token) {
        for(int redirects=0;redirects<6;redirects++) {
            using(var request=new HttpRequestMessage(HttpMethod.Get,uri)) {
                if(offset>0)request.Headers.Range=new RangeHeaderValue(offset,null);
                var response=await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,token);
                int code=(int)response.StatusCode;if(code<300||code>=400)return response;
                var location=response.Headers.Location;response.Dispose();Need(location!=null,"更新源重定向缺少地址");uri=new Uri(uri,location);
                Need(uri.Scheme=="https"&&uri.UserInfo==""&&(uri.Host=="github.com"||uri.Host=="api.github.com"||uri.Host=="release-assets.githubusercontent.com"||uri.Host=="objects.githubusercontent.com"),"更新源重定向到不受信任的地址");
            }
        }
        throw new IOException("更新源重定向过多");
    }
    internal static async Task<Dictionary<string,object>> Check(HttpClient client,string repository,CancellationToken token) {
        Need(Regex.IsMatch(repository,@"^[\w.-]+/[\w.-]+$"),"仓库请使用 owner/repository 格式");
        using(var response=await Get(client,new Uri("https://github.com/"+repository+"/releases/latest/download/codex-forge-release.json"),0,token)) {
            response.EnsureSuccessStatusCode();using(var input=await response.Content.ReadAsStreamAsync())using(var data=new MemoryStream()) {
                byte[] buffer=new byte[65536];int read;while((read=await input.ReadAsync(buffer,0,buffer.Length,token))>0){Need(data.Length+read<=2*1024*1024,"更新清单过大");data.Write(buffer,0,read);}
                var m=BootstrapCore.Json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(data.ToArray()));Validate(m,repository);return m;
            }
        }
    }
    internal static bool Verified(string file,long bytes,string sha) { return File.Exists(file)&&new FileInfo(file).Length==bytes&&BootstrapCore.Hash(file)==sha; }
    internal static async Task<string> Download(HttpClient client,string url,string file,long bytes,string sha,Action<string,int> progress,CancellationToken token) {
        Directory.CreateDirectory(Path.GetDirectoryName(file));if(Verified(file,bytes,sha))return file;
        string partial=file+".partial";
        for(int retry=0;;retry++) {
            token.ThrowIfCancellationRequested();long offset=File.Exists(partial)?new FileInfo(partial).Length:0;
            if(offset>bytes){File.Delete(partial);offset=0;}
            if(offset==bytes)break;
            try { using(var response=await Get(client,new Uri(url),offset,token)) {
                response.EnsureSuccessStatusCode();bool resume=response.StatusCode==HttpStatusCode.PartialContent;
                if(resume){var range=response.Content.Headers.ContentRange;Need(range!=null&&range.Unit=="bytes"&&range.From==offset&&range.To==bytes-1&&range.Length==bytes,"下载续传范围不符");}
                else { Need(response.StatusCode==HttpStatusCode.OK,"下载状态无效");offset=0; }
                using(var input=await response.Content.ReadAsStreamAsync())using(var output=new FileStream(partial,offset==0?FileMode.Create:FileMode.Append,FileAccess.Write,FileShare.None)) {
                    byte[] buffer=new byte[65536];int read;long current=offset;
                    while((read=await input.ReadAsync(buffer,0,buffer.Length,token))>0){current+=read;Need(current<=bytes,"下载大小超出清单");await output.WriteAsync(buffer,0,read,token);progress("下载："+(current/1048576)+" / "+(bytes/1048576)+" MB",(int)(100*current/bytes));}output.Flush(true);
                }
                Need(new FileInfo(partial).Length==bytes,"连接提前结束");break;
            }} catch(OperationCanceledException){throw;}catch(HttpRequestException){if(retry>=2)throw;}catch(IOException){if(retry>=2)throw;}
        }
        if(!Verified(partial,bytes,sha)){File.Delete(partial);throw new InvalidDataException("SHA-256 校验失败，请重试");}
        if(File.Exists(file))File.Delete(file);File.Move(partial,file);return file;
    }
    // Each delta reconstructs one complete release artifact. Every edge and the
    // final output is hashed; a chain must be cheaper than the full artifact.
    internal static List<Dictionary<string,object>> DeltaChain(Dictionary<string,object> manifest,string cache,string target,long fullBytes,string kind) {
        var result=new List<Dictionary<string,object>>();if(!manifest.ContainsKey("deltas"))return result;
        var costs=new Dictionary<string,long>();var routes=new Dictionary<string,List<Dictionary<string,object>>>();
        var edges=new List<Dictionary<string,object>>();
        foreach(Dictionary<string,object> edge in (IEnumerable)manifest["deltas"]) {
            if(S(edge,"kind")!=kind)continue;Need(edges.Count<64,"增量链过长");Asset(S(edge,"url"),S(manifest,"repository"));
            foreach(string key in new[]{"sha256","fromSha256","toSha256"})Need(Regex.IsMatch(S(edge,key),"^[a-f0-9]{64}$"),"增量摘要无效");
            Need(Convert.ToInt64(edge["bytes"])>0&&Convert.ToInt64(edge["bytes"])<=Limit,"增量大小无效");edges.Add(edge);
            string from=S(edge,"fromSha256"),file=Path.Combine(cache,from+".artifact");
            if(File.Exists(file)&&new FileInfo(file).Length<=Limit&&BootstrapCore.Hash(file)==from){costs[from]=0;routes[from]=new List<Dictionary<string,object>>();}
        }
        for(int pass=0;pass<edges.Count;pass++)foreach(var edge in edges){string from=S(edge,"fromSha256"),to=S(edge,"toSha256");long cost;if(!costs.TryGetValue(from,out cost))continue;cost+=Convert.ToInt64(edge["bytes"]);if(cost>=fullBytes||costs.ContainsKey(to)&&costs[to]<=cost)continue;costs[to]=cost;routes[to]=new List<Dictionary<string,object>>(routes[from]);routes[to].Add(edge);}
        return routes.ContainsKey(target)?routes[target]:result;
    }
    internal static void ApplyDelta(string baseline,string deltaFile,string destination,string expectedSha,long expectedBytes,CancellationToken token) {
        var delta=BootstrapCore.Read(deltaFile);Need(Convert.ToInt32(delta["schemaVersion"])==1&&S(delta,"format")=="forge-blocks-v1","增量格式不兼容");
        Need(BootstrapCore.Hash(baseline)==S(delta,"fromSha256")&&S(delta,"toSha256")==expectedSha&&Convert.ToInt64(delta["toBytes"])==expectedBytes&&expectedBytes>0&&expectedBytes<=Limit,"增量基线或目标不符");
        string partial=destination+".building";
        try { using(var input=File.OpenRead(baseline))using(var output=new FileStream(partial,FileMode.Create,FileAccess.Write,FileShare.None)) {
            byte[] buffer=new byte[65536];int count=0;
            foreach(Dictionary<string,object> op in (IEnumerable)delta["operations"]) {
                token.ThrowIfCancellationRequested();Need(++count<=100000,"增量操作过多");
                if(op.ContainsKey("data")){byte[] data=Convert.FromBase64String(S(op,"data"));Need(output.Length+data.Length<=expectedBytes,"增量输出超限");output.Write(data,0,data.Length);}
                else { long at=Convert.ToInt64(op["offset"]),left=Convert.ToInt64(op["bytes"]);Need(at>=0&&left>0&&at<=input.Length-left&&output.Length+left<=expectedBytes,"增量复制范围无效");input.Position=at;while(left>0){int read=input.Read(buffer,0,(int)Math.Min(left,buffer.Length));Need(read>0,"增量基线不完整");output.Write(buffer,0,read);left-=read;} }
            }output.Flush(true);
        }
        Need(Verified(partial,expectedBytes,expectedSha),"增量结果校验失败");if(File.Exists(destination))File.Delete(destination);File.Move(partial,destination);
        }finally{if(File.Exists(partial))File.Delete(partial);}
    }
    internal static async Task<string> Stage(HttpClient client,Dictionary<string,object> m,string root,Action<string,int> progress,CancellationToken token) {
        bool portable=File.Exists(Path.Combine(root,"portable.ini"));string kind=portable?"portable":"msi",sha=S(m,portable?"portableSha256":"sha256"),url=S(m,portable?"portableUrl":"url");long bytes=Convert.ToInt64(m[portable?"portableBytes":"bytes"]);
        string cache=Path.Combine(root,".cache","forge-updates");Directory.CreateDirectory(cache);string artifact=Path.Combine(cache,sha+".artifact");
        if(!Verified(artifact,bytes,sha)) {
            try { var chain=DeltaChain(m,cache,sha,bytes,kind);foreach(var edge in chain) {
                string delta=await Download(client,S(edge,"url"),Path.Combine(cache,S(edge,"sha256")+".delta.json"),Convert.ToInt64(edge["bytes"]),S(edge,"sha256"),progress,token);
                ApplyDelta(Path.Combine(cache,S(edge,"fromSha256")+".artifact"),delta,Path.Combine(cache,S(edge,"toSha256")+".artifact"),S(edge,"toSha256"),Convert.ToInt64(edge["toBytes"]),token);
            }}catch(OperationCanceledException){throw;}catch(Exception){progress("增量不可用，改用完整包",0);}
            await Download(client,url,artifact,bytes,sha,progress,token);
        }
        string file=Path.Combine(cache,"Codex-Forge-"+S(m,"forgeVersion")+(portable?".zip":".msi"));File.Copy(artifact,file,true);return file;
    }
    internal static void InstallPortable(string archive,string root,Dictionary<string,object> m,CancellationToken token) {
        PlainPath(root);PlainPath(Path.Combine(root,"forge"));PlainPath(Path.Combine(root,"bootstrap.json"));PlainPath(Path.Combine(root,".forge-prepare.lock"));
        using(var setupLock=new FileStream(Path.Combine(root,".forge-prepare.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)) {
        Need(Verified(archive,Convert.ToInt64(m["portableBytes"]),S(m,"portableSha256")),"安装前摘要复核失败");
        Need(!BootstrapCore.RunningFrom(root),"请先完整退出此目录的 Forge 客户端，再安装更新");
        string stage=Path.Combine(root,".forge-update-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(stage);
        try {
            using(var zip=ZipFile.OpenRead(archive)){long size=0;var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);foreach(var entry in zip.Entries){token.ThrowIfCancellationRequested();string name=entry.FullName.Replace('\\','/');if(name.StartsWith("./"))name=name.Substring(2);if(name==""||name.EndsWith("/"))continue;Need(seen.Add(name)&&seen.Count<=20000&&((entry.ExternalAttributes>>16)&0xF000)!=0xA000&&(size+=entry.Length)<=Limit*4,"ZIP 内容无效或过大");string file=BootstrapCore.SafePath(stage,name);Directory.CreateDirectory(Path.GetDirectoryName(file));entry.ExtractToFile(file,false);}}
            var pointer=BootstrapCore.Read(Path.Combine(stage,"bootstrap.json"));string relative=S(pointer,"directory");Need(relative=="forge/"+S(m,"forgeVersion"),"安装包版本与清单不符");string payload=BootstrapCore.SafePath(stage,relative),target=BootstrapCore.SafePath(root,relative);
            var manifest=BootstrapCore.Read(Path.Combine(payload,"forge-payload.json"));Need(S(manifest,"forgeVersion")==S(m,"forgeVersion")&&S(manifest,"payloadDigest")==BootstrapCore.PayloadDigest(manifest),"Forge 内容摘要无效");BootstrapCore.VerifyFiles(payload,manifest,token);
            PlainPath(target);
            if(Directory.Exists(target)) {
                bool intact=false;try{BootstrapCore.VerifyFiles(target,manifest,token);intact=true;}catch(OperationCanceledException){throw;}catch{ }
                if(!intact){string backup=target+".previous-"+Guid.NewGuid().ToString("N");Directory.Move(target,backup);try{Directory.Move(payload,target);}catch{Directory.Move(backup,target);throw;}}
            }else{Directory.CreateDirectory(Path.GetDirectoryName(target));Directory.Move(payload,target);}
            foreach(string name in new[]{"CodexForge.exe","CodexForge.exe.config","CodexForgeUpdater.exe","CodexForgeUpdater.exe.config"})Need(File.Exists(Path.Combine(stage,name)),"ZIP 缺少启动器或更新器");
            // Publish only after the new version has been checked. Client data,
            // plugins and the previous version directory are never overwritten.
            foreach(string name in new[]{"CodexForge.exe","CodexForge.exe.config","CodexForgeUpdater.exe","CodexForgeUpdater.exe.config"})AtomicCopy(Path.Combine(stage,name),Path.Combine(root,name));
            AtomicCopy(Path.Combine(stage,"bootstrap.json"),Path.Combine(root,"bootstrap.json"));
        } finally { Directory.Delete(stage,true); }
        }
    }
    internal static void AtomicCopy(string from,string to){PlainPath(to);PlainPath(to+".previous");string next=to+".next";PlainPath(next);File.Copy(from,next,true);if(File.Exists(to))File.Replace(next,to,to+".previous");else File.Move(next,to);}
}

internal sealed class ForgeUpdaterForm : Form {
    readonly string root;readonly string forgeHome=Environment.GetEnvironmentVariable("CODEX_FORGE_HOME")??Path.Combine(Environment.GetEnvironmentVariable("CODEX_HOME")??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".codex"),"forge");readonly TextBox repository=new TextBox(),proxy=new TextBox();readonly Label status=new Label();readonly ProgressBar progress=new ProgressBar();readonly Button check=new Button(),download=new Button(),install=new Button(),cancel=new Button(),repair=new Button();CancellationTokenSource cancellation;Dictionary<string,object> plan;string staged;bool busy;
    internal ForgeUpdaterForm(string directory,string source) {
        root=directory;Text="Codex Forge 独立更新器 · 0.5.2";ClientSize=new Size(620,360);StartPosition=FormStartPosition.CenterScreen;FormBorderStyle=FormBorderStyle.FixedDialog;MaximizeBox=false;
        Controls.Add(new Label { Text="安装目录："+root,Left=20,Top=16,Width=580,Height=38 });
        Controls.Add(new Label { Text="GitHub 发布仓库",Left=20,Top=60,Width=150 });repository.SetBounds(180,58,420,25);repository.Text=source;repository.AccessibleName="GitHub 发布仓库";
        Controls.Add(new Label { Text="HTTP 代理（留空用系统）",Left=20,Top=100,Width=160 });proxy.SetBounds(180,98,420,25);proxy.AccessibleName="HTTP 代理";
        status.SetBounds(20,140,580,80);status.Text="独立检查、断点续传、校验和安装。客户端无法启动时也可修复。";progress.SetBounds(20,230,580,18);
        check.Text="检查更新";download.Text="下载 / 续传";install.Text="安装更新";cancel.Text="取消下载";repair.Text="修复当前安装";
        var buttons=new[]{check,download,install,cancel,repair};for(int i=0;i<buttons.Length;i++)buttons[i].SetBounds(20+i*118,280,110,32);
        Controls.AddRange(new Control[]{repository,proxy,status,progress,check,download,install,cancel,repair});download.Enabled=install.Enabled=cancel.Enabled=false;
        check.Click+=async(s,e)=>await Work(async token=>{plan=null;staged=null;using(var client=ForgeUpdateCore.Client(proxy.Text)){var candidate=await ForgeUpdateCore.Check(client,repository.Text.Trim(),token);string setup=Path.Combine(root,"bootstrap.json");if(File.Exists(setup)){var p=BootstrapCore.Read(setup);var current=BootstrapCore.Read(Path.Combine(BootstrapCore.SafePath(root,ForgeUpdateCore.S(p,"directory")),"forge.config.json"));ForgeUpdateCore.Need(new Version(ForgeUpdateCore.S(candidate,"forgeVersion"))>=new Version(ForgeUpdateCore.S(current,"version")),"不允许降级 Forge");ForgeUpdateCore.Need(new Version(ForgeUpdateCore.S(candidate,"codexVersion"))>=new Version(ForgeUpdateCore.S(current,"codexVersion")),"不允许降级官方客户端");}ForgeUpdateCore.CheckPlugins(candidate,forgeHome);plan=candidate;Update("可安装 Forge "+ForgeUpdateCore.S(plan,"forgeVersion")+" / Codex "+ForgeUpdateCore.S(plan,"codexVersion")+"。请先确认外部插件支持新版本。",0);}});
        download.Click+=async(s,e)=>await Work(async token=>{using(var client=ForgeUpdateCore.Client(proxy.Text))staged=await Task.Run(()=>ForgeUpdateCore.Stage(client,plan,root,Update,token));Update("下载及 SHA-256 校验完成，请退出客户端后安装。",100);});
        install.Click+=async(s,e)=>await Work(async token=>{ForgeUpdateCore.Validate(plan,repository.Text.Trim());ForgeUpdateCore.CheckPlugins(plan,forgeHome);if(File.Exists(Path.Combine(root,"portable.ini"))){await Task.Run(()=>ForgeUpdateCore.InstallPortable(staged,root,plan,token));Update("更新已安装。启动 Codex Forge 将准备对应官方客户端。旧版配置指针已保留为 .previous。",100);}else{ForgeUpdateCore.Need(!BootstrapCore.RunningFrom(root),"请先完整退出 Forge 客户端");ForgeUpdateCore.Need(ForgeUpdateCore.Verified(staged,Convert.ToInt64(plan["bytes"]),ForgeUpdateCore.S(plan,"sha256")),"安装前摘要复核失败");Process.Start(new ProcessStartInfo("msiexec.exe","/i "+BootstrapCore.Quote(staged)+" /passive /norestart") { UseShellExecute=false });BeginInvoke((Action)Close);}});
        repair.Click+=async(s,e)=>await Work(async token=>{ForgeUpdateCore.Need(!BootstrapCore.RunningFrom(root),"请先完整退出 Forge 客户端");var p=BootstrapCore.Read(Path.Combine(root,"bootstrap.json"));await Task.Run(()=>BootstrapCore.Prepare(BootstrapCore.SafePath(root,ForgeUpdateCore.S(p,"directory")),root,Update,token));});
        cancel.Click+=(s,e)=>cancellation.Cancel();repository.TextChanged+=(s,e)=>{plan=null;staged=null;download.Enabled=install.Enabled=false;};FormClosing+=(s,e)=>{if(busy){e.Cancel=true;cancellation.Cancel();}};
    }
    async Task Work(Func<CancellationToken,Task> action){if(busy)return;busy=true;cancellation=new CancellationTokenSource();check.Enabled=download.Enabled=install.Enabled=repair.Enabled=repository.Enabled=proxy.Enabled=false;cancel.Enabled=true;try{await action(cancellation.Token);}catch(OperationCanceledException){Update("已取消，部分下载已保留，可继续下载。",progress.Value);}catch(Exception e){Update(e.Message,0);}finally{busy=false;check.Enabled=repair.Enabled=repository.Enabled=proxy.Enabled=true;download.Enabled=plan!=null;install.Enabled=staged!=null;cancel.Enabled=false;cancellation.Dispose();}}
    void Update(string message,int value){if(InvokeRequired){BeginInvoke((Action)(()=>Update(message,value)));return;}status.Text=message;progress.Value=Math.Max(0,Math.Min(100,value));}
}
internal static class ForgeUpdater {
    [STAThread] static int Main(string[] args) {
        try { string root=AppDomain.CurrentDomain.BaseDirectory,repository="HOMEFTW/codex-forge";bool worker=false;
            for(int i=0;i<args.Length;i++){if(args[i]=="--root"&&i+1<args.Length)root=Path.GetFullPath(args[++i]);else if(args[i]=="--repository"&&i+1<args.Length)repository=args[++i];else if(args[i]=="--worker")worker=true;else throw new Exception("无效更新器参数");}
            if(!File.Exists(Path.Combine(root,"bootstrap.json"))) { Application.EnableVisualStyles();using(var dialog=new FolderBrowserDialog { Description="请选择 Codex Forge 安装目录" }){if(dialog.ShowDialog()!=DialogResult.OK)return 1;root=dialog.SelectedPath;} }
            ForgeUpdateCore.Need(File.Exists(Path.Combine(root,"bootstrap.json")),"所选目录不是 Forge 安装目录");
            if(!worker){string own=System.Reflection.Assembly.GetExecutingAssembly().Location,copy=Path.Combine(root,".cache","updater-runs",BootstrapCore.Hash(own),"CodexForgeUpdater.exe");Directory.CreateDirectory(Path.GetDirectoryName(copy));if(!File.Exists(copy))File.Copy(own,copy);if(File.Exists(own+".config"))File.Copy(own+".config",copy+".config",true);Process.Start(new ProcessStartInfo(copy,"--worker --root "+BootstrapCore.Quote(root.TrimEnd('\\'))+" --repository "+BootstrapCore.Quote(repository)) {UseShellExecute=false});return 0;}
            Application.EnableVisualStyles();using(var updateLock=new FileStream(Path.Combine(root,".forge-updater.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None))Application.Run(new ForgeUpdaterForm(root,repository));return 0;
        }catch(Exception e){MessageBox.Show(e.Message,"Codex Forge 更新器",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1;}
    }
}
