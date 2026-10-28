using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Xml;
using System.Text.RegularExpressions;
using System.Reflection;

[assembly: AssemblyTitle("Codex Forge Bootstrap")]
[assembly: AssemblyProduct("Codex Forge")]
[assembly: AssemblyVersion("0.3.1.0")]

internal static class BootstrapCore {
    static BootstrapCore() {
        AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling",false);
        AppContext.SetSwitch("Switch.System.IO.BlockLongPaths",false);
    }
    internal static readonly JavaScriptSerializer Json=new JavaScriptSerializer { MaxJsonLength=32*1024*1024 };
    internal static Dictionary<string,object> Read(string file) { return Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(file)); }
    internal static string Text(Dictionary<string,object> value,string key) { return Convert.ToString(value[key]); }
    internal static string Hash(string file) { using(var stream=File.OpenRead(file))using(var algorithm=SHA256.Create())return BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-","").ToLowerInvariant(); }
    internal static string PayloadDigest(Dictionary<string,object> manifest) {
        var rows=new List<string>();foreach(Dictionary<string,object> item in (IEnumerable)manifest["files"])rows.Add(Text(item,"path")+"\0"+Convert.ToInt64(item["bytes"])+"\0"+Text(item,"sha256"));rows.Sort(StringComparer.Ordinal);
        using(var algorithm=SHA256.Create())return BitConverter.ToString(algorithm.ComputeHash(Encoding.UTF8.GetBytes(String.Join("\n",rows)))).Replace("-","").ToLowerInvariant();
    }
    internal static void Need(bool ok,string error) { if(!ok)throw new InvalidDataException(error); }
    internal static string SafePath(string root,string relative) {
        Need(!String.IsNullOrEmpty(relative)&&!Path.IsPathRooted(relative)&&relative.IndexOfAny(new[]{':','\\','\0'})<0,"无效的安装路径");
        foreach(string part in relative.Split('/'))Need(part.Length>0&&part!="."&&part!=".."&&!part.EndsWith(".")&&!part.EndsWith(" ")&&part.IndexOfAny(Path.GetInvalidFileNameChars())<0,"安装路径越界或无效");
        string resolved=Path.GetFullPath(Path.Combine(root,relative.Replace('/',Path.DirectorySeparatorChar)));
        Need(resolved.StartsWith(Path.GetFullPath(root).TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase),"安装路径越界");return resolved;
    }
    internal static void ValidateAdapter(Dictionary<string,object> adapter) {
        Need(Convert.ToInt32(adapter["schemaVersion"])==1&&Convert.ToInt32(adapter["apiVersion"])==2&&Text(adapter,"architecture")=="x64","不支持的 Forge API 或系统架构");
        string version=Text(adapter,"codexVersion");Version parsed;
        Need(Version.TryParse(version,out parsed)&&parsed.Revision>=0&&version!="26.1013.4894.0","不支持的客户端版本");
        Need(Text(adapter,"packageIdentity")=="OpenAI.Codex"&&Text(adapter,"publisher")=="CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B","官方产品身份不匹配");
        Need(Text(adapter,"downloadUrl")=="https://persistent.oaistatic.com/codex-app-prod/releases/"+version+"/ChatGPT-x64.msix","下载地址必须属于适配版本的官方 HTTPS 源");
        Need(System.Text.RegularExpressions.Regex.IsMatch(Text(adapter,"packageSHA256"),"^[a-f0-9]{64}$")&&Convert.ToInt64(adapter["packageBytes"])>0&&Convert.ToInt64(adapter["packageBytes"])<4L*1024*1024*1024,"官方摘要或大小无效");
    }
    internal static void VerifyFiles(string root,Dictionary<string,object> manifest,CancellationToken token) {
        foreach(Dictionary<string,object> item in (IEnumerable)manifest["files"]) { token.ThrowIfCancellationRequested();string file=SafePath(root,Text(item,"path"));Need(File.Exists(file)&&Hash(file)==Text(item,"sha256"),"文件摘要不符："+Text(item,"path")); }
    }
    internal static void ExtractApp(string package,string destination,Dictionary<string,object> adapter,CancellationToken token) {
        using(var zip=ZipFile.OpenRead(package)) {
            var manifest=zip.GetEntry("AppxManifest.xml");Need(manifest!=null,"缺少官方应用清单");
            var xml=new XmlDocument { XmlResolver=null };using(var input=manifest.Open())using(var reader=XmlReader.Create(input,new XmlReaderSettings { DtdProcessing=DtdProcessing.Prohibit,XmlResolver=null }))xml.Load(reader);
            var identity=xml.SelectSingleNode("/*[local-name()='Package']/*[local-name()='Identity']");
            Need(identity!=null&&identity.Attributes["Name"].Value==Text(adapter,"packageIdentity")&&identity.Attributes["Version"].Value==Text(adapter,"codexVersion")&&identity.Attributes["ProcessorArchitecture"].Value=="x64"&&identity.Attributes["Publisher"].Value==Text(adapter,"publisher"),"官方 MSIX 身份、架构或版本不匹配");
            long total=0;int count=0;var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach(var entry in zip.Entries) {
                token.ThrowIfCancellationRequested();string name=Uri.UnescapeDataString(entry.FullName);
                if(!name.StartsWith("app/",StringComparison.Ordinal))continue;
                if(name.EndsWith("/"))continue;
                Need(++count<=20000&&(total+=entry.Length)<=12L*1024*1024*1024,"官方包解压大小超限");
                Need(((entry.ExternalAttributes>>16)&0xF000)!=0xA000&&names.Add(name),"包内存在链接或重复文件");
                string target=SafePath(destination,name);Directory.CreateDirectory(Path.GetDirectoryName(target));entry.ExtractToFile(target,false);
            }
            Need(File.Exists(Path.Combine(destination,"app","ChatGPT.exe")),"官方包缺少客户端");
        }
    }
    internal static void Run(string executable,string arguments,string directory,CancellationToken token,string temporaryDirectory) {
        var info=new ProcessStartInfo(executable,arguments) { WorkingDirectory=directory,UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true };
        info.EnvironmentVariables.Remove("FAST_NO_PATCH");info.EnvironmentVariables.Remove("FAST_EXTENSION_DEBUG");
        // Appx's signature provider needs writable temporary storage. Use the
        // installation's own workspace instead of an inherited, restricted TEMP.
        Directory.CreateDirectory(temporaryDirectory);
        info.EnvironmentVariables["TEMP"]=temporaryDirectory;info.EnvironmentVariables["TMP"]=temporaryDirectory;
        using(var process=Process.Start(info)) {
            var stdout=process.StandardOutput.ReadToEndAsync();var stderr=process.StandardError.ReadToEndAsync();
            while(!process.WaitForExit(200))if(token.IsCancellationRequested){process.Kill();process.WaitForExit();token.ThrowIfCancellationRequested();}
            if(process.ExitCode!=0)throw new Exception("准备程序失败："+stderr.Result+stdout.Result);
        }
    }
    internal static string Quote(string value) { return "\""+value.Replace("\"","\\\"")+"\""; }
    static async Task Download(Dictionary<string,object> adapter,string file,Action<string,int> progress,CancellationToken token) {
        long expected=Convert.ToInt64(adapter["packageBytes"]);string partial=file+".partial";
        if(File.Exists(file)) { if(new FileInfo(file).Length==expected&&Hash(file)==Text(adapter,"packageSHA256"))return;File.Delete(file); }
        ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;
        using(var handler=new HttpClientHandler { AllowAutoRedirect=false })using(var http=new HttpClient(handler) { Timeout=TimeSpan.FromHours(2) }) {
            for(int attempt=0;;attempt++){try {
                long offset=File.Exists(partial)?new FileInfo(partial).Length:0;
                if(offset>expected){File.Delete(partial);offset=0;}
                if(offset==expected)break;
                using(var request=new HttpRequestMessage(HttpMethod.Get,Text(adapter,"downloadUrl"))) {
                request.Headers.UserAgent.ParseAdd("Codex-Forge/0.3.1");if(offset>0)request.Headers.Range=new System.Net.Http.Headers.RangeHeaderValue(offset,null);
                    using(var response=await http.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,token)) {
                        Need(response.StatusCode==HttpStatusCode.OK||response.StatusCode==HttpStatusCode.PartialContent,"官方客户端下载失败：HTTP "+(int)response.StatusCode);
                        if(response.StatusCode==HttpStatusCode.OK)offset=0;
                        else Need(response.Content.Headers.ContentRange!=null&&response.Content.Headers.ContentRange.From==offset&&response.Content.Headers.ContentRange.Length==expected,"下载续传范围无效");
                        using(var input=await response.Content.ReadAsStreamAsync())using(var output=new FileStream(partial,offset==0?FileMode.Create:FileMode.Append,FileAccess.Write,FileShare.None)) {
                            byte[] buffer=new byte[1024*1024];int read;long current=offset;
                            while((read=await input.ReadAsync(buffer,0,buffer.Length,token))>0){current+=read;Need(current<=expected,"官方包下载大小超限");await output.WriteAsync(buffer,0,read,token);progress("下载官方 Codex："+(current/1048576)+" / "+(expected/1048576)+" MB",(int)(current*70/expected));}
                            Need(current==expected,"官方客户端下载不完整");
                        }
                    }
                }
                break;
            }catch(Exception error){if(error is OperationCanceledException||attempt>=2)throw;progress("下载中断，正在重试…",0);}
            await Task.Delay(1500,token);}
        }
        Need(new FileInfo(partial).Length==expected&&Hash(partial)==Text(adapter,"packageSHA256"),"官方客户端 SHA-256 不匹配");File.Move(partial,file);
    }
    static bool RunningFrom(string directory) {
        try {
            string prefix=Path.GetFullPath(directory).TrimEnd('\\')+"\\";
            foreach(string processName in new[]{"ChatGPT","Codex"}) {
                Process[] processes;
                try { processes=Process.GetProcessesByName(processName); }
                catch { continue; }
                foreach(Process process in processes) {
                    try { string file=process.MainModule.FileName; if(file!=null&&file.StartsWith(prefix,StringComparison.OrdinalIgnoreCase)) return true; }
                    catch { }
                    finally { process.Dispose(); }
                }
            }
        } catch { }
        return false;
    }
    internal static int CleanupOldClients(string root,string keepRelative,string currentVersion) {
        string clients=SafePath(root,"clients"),keep=Path.GetFullPath(SafePath(root,keepRelative));int removed=0;
        if(Directory.Exists(clients)) foreach(string directory in Directory.GetDirectories(clients)) {
            if(String.Equals(Path.GetFullPath(directory),keep,StringComparison.OrdinalIgnoreCase)) continue;
            if(!Path.GetFileName(directory).StartsWith("Codex-Forge-",StringComparison.OrdinalIgnoreCase)) continue;
            string receipt=Path.Combine(directory,"forge-install.json");
            if(!File.Exists(receipt)||RunningFrom(directory)) continue;
            Dictionary<string,object> manifest;
            try { manifest=Read(receipt); }
            catch(Exception) { continue; }
            bool managed;
            try { managed=Text(manifest,"product")=="Codex Forge"&&manifest.ContainsKey("fullInstallation")&&Convert.ToBoolean(manifest["fullInstallation"])&&manifest.ContainsKey("sourceMSIXVersion"); }
            catch(Exception) { managed=false; }
            if(!managed) continue;
            try { Directory.Delete(directory,true);removed++; }
            catch(IOException) { }
            catch(UnauthorizedAccessException) { }
            catch(ArgumentException) { }
        }
        string cache=Path.Combine(root,".cache"),current="Codex-"+currentVersion+"-x64.msix";
        if(Directory.Exists(cache)) foreach(string file in Directory.GetFiles(cache)) {
            string name=Path.GetFileName(file);if(String.Equals(name,current,StringComparison.OrdinalIgnoreCase)) continue;
            if(!Regex.IsMatch(name,@"^Codex-[0-9]+(\.[0-9]+){2,3}-x64\.msix(?:\.partial)?$",RegexOptions.IgnoreCase)) continue;
            try { File.Delete(file);removed++; } catch(IOException) { } catch(UnauthorizedAccessException) { }
        }
        return removed;
    }
    internal static async Task Prepare(string payload,string root,Action<string,int> progress,CancellationToken token) {
        Directory.CreateDirectory(root);
        using(var setupLock=new FileStream(Path.Combine(root,".forge-prepare.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)) {
            var config=Read(Path.Combine(payload,"forge.config.json"));var adapter=Read(Path.Combine(payload,"adapters",Text(config,"codexVersion")+".json"));ValidateAdapter(adapter);
            Need(Text(config,"version")==Text(adapter,"forgeVersion")&&Convert.ToInt32(config["apiVersion"])==Convert.ToInt32(adapter["apiVersion"]),"Forge 与适配器版本不匹配");
            progress("校验 Forge 安装文件…",0);var payloadManifest=Read(Path.Combine(payload,"forge-payload.json"));VerifyFiles(payload,payloadManifest,token);string payloadDigest=PayloadDigest(payloadManifest);
            string versionName="Codex-Forge-"+Text(config,"version")+"-"+Text(adapter,"codexVersion"),relative="clients/"+versionName,target=SafePath(root,relative);
            string receipt=Path.Combine(target,"forge-install.json");
            if(Directory.Exists(target)) {
                Need(File.Exists(receipt),"目标目录已存在但不属于 Forge");
                bool reusable=false;
                try { var installed=Read(receipt);reusable=Text(installed,"product")=="Codex Forge"&&Text(installed,"forgeVersion")==Text(config,"version")&&Text(installed,"sourceMSIXVersion")==Text(adapter,"codexVersion")&&Text(installed,"forgePayloadSHA256")==payloadDigest; if(reusable)VerifyFiles(target,installed,token); }
                catch { reusable=false; }
                if(reusable){Publish(root,relative);CleanupOldClients(root,relative,Text(adapter,"codexVersion"));progress("客户端已准备好",100);return;}
                versionName+="-"+payloadDigest.Substring(0,12);relative="clients/"+versionName;target=SafePath(root,relative);receipt=Path.Combine(target,"forge-install.json");
                Need(!Directory.Exists(target),"当前版本已有不同 Forge 内容，请先关闭旧客户端后重试");
            }
            string cache=Path.Combine(root,".cache");Directory.CreateDirectory(cache);string package=Path.Combine(cache,"Codex-"+Text(adapter,"codexVersion")+"-x64.msix");
            await Download(adapter,package,progress,token);
            progress("验证官方数字签名…",72);
            string powershell=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\powershell.exe");
            Run(powershell,"-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "+Quote(Path.Combine(payload,"scripts","verify-official.ps1"))+" -Package "+Quote(package)+" -Publisher "+Quote(Text(adapter,"publisher")),payload,token,Path.Combine(cache,"work"));
            string staging=Path.Combine(root,".forge-setup-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(staging);
            try {
                progress("解压并验证客户端版本…",76);string official=Path.Combine(staging,"official");ExtractApp(package,official,adapter,token);
                string source=Path.Combine(official,"app"),node=Path.Combine(source,@"resources\cua_node\bin\node.exe"),output=Path.Combine(staging,"client");
                progress("应用 Forge API "+Text(config,"apiVersion")+" 适配器…",86);
                Run(node,Quote(Path.Combine(payload,"scripts","build-client.mjs"))+" "+Quote(source)+" "+Quote(output),payload,token,Path.Combine(staging,"temp"));
                progress("校验最终安装…",95);var installed=Read(Path.Combine(output,"forge-install.json"));Need(Text(installed,"forgeVersion")==Text(config,"version")&&Text(installed,"sourceMSIXVersion")==Text(adapter,"codexVersion")&&Text(installed,"forgePayloadSHA256")==payloadDigest,"生成的客户端版本或 Forge 内容不一致");VerifyFiles(output,installed,token);
                token.ThrowIfCancellationRequested();Directory.CreateDirectory(Path.GetDirectoryName(target));Directory.Move(output,target);Publish(root,relative);CleanupOldClients(root,relative,Text(adapter,"codexVersion"));progress("官方客户端及 Codex Forge 已准备好",100);
            }finally{if(Directory.Exists(staging))Directory.Delete(staging,true);}
        }
    }
    static void Publish(string root,string relative) {
        string pointer=Path.Combine(root,"current.json"),next=pointer+".next";File.WriteAllText(next,Json.Serialize(new {directory=relative}),new UTF8Encoding(false));
        if(File.Exists(pointer))File.Replace(next,pointer,pointer+".previous");else File.Move(next,pointer);
    }
}

internal sealed class BootstrapForm:Form {
    readonly Label status=new Label { AutoSize=false,Left=24,Top=68,Width=530,Height=72 };
    readonly ProgressBar progress=new ProgressBar { Left=24,Top=148,Width=530,Height=20 };
    readonly Button button=new Button { Left=440,Top=190,Width=114,Height=32,Text="取消" };
    readonly CancellationTokenSource cancel=new CancellationTokenSource();bool finished;int result=1;readonly string root,payload;
    internal int Result { get {return result;} }
    internal BootstrapForm(string root,string payload) {
        this.root=root;this.payload=payload;Text="Codex Forge · 准备客户端";ClientSize=new Size(580,245);StartPosition=FormStartPosition.CenterScreen;FormBorderStyle=FormBorderStyle.FixedDialog;MaximizeBox=false;Font=new Font("Microsoft YaHei UI",10);
        Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath);Controls.Add(new Label { Text="安装适配的官方 Codex 客户端",Left=24,Top=24,Width=530,Height=32,Font=new Font(Font.FontFamily,14,FontStyle.Bold) });Controls.Add(status);Controls.Add(progress);Controls.Add(button);
        button.Click+=(s,e)=>{if(finished)Close();else{cancel.Cancel();button.Enabled=false;status.Text="正在取消，请稍候…";}};
        FormClosing+=(s,e)=>{if(!finished){e.Cancel=true;cancel.Cancel();}};
        Shown+=async(s,e)=>{try{await Task.Run(()=>BootstrapProgram.Execute(root,payload,UpdateProgress,cancel.Token));result=0;status.Text="准备完成。现在可以从桌面启动 Codex Forge。";}catch(OperationCanceledException){status.Text="已取消。再次启动 Codex Forge 可继续准备。";}catch(Exception error){status.Text=error.Message+"\n重新启动 Codex Forge 可重试。日志：forge-prepare.log";}finally{finished=true;button.Enabled=true;button.Text="关闭";}};
    }
    void UpdateProgress(string text,int value){if(IsDisposed)return;BeginInvoke((Action)(()=>{status.Text=text;progress.Value=Math.Max(0,Math.Min(100,value));}));}
}
internal static class BootstrapProgram {
    internal static async Task Execute(string root,string payload,Action<string,int> progress,CancellationToken token) {
        Directory.CreateDirectory(root);string log=Path.Combine(root,"forge-prepare.log");
        try{string last="";await BootstrapCore.Prepare(payload,root,(message,value)=>{progress(message,value);string phase=message.Split('：')[0];if(phase!=last){last=phase;File.AppendAllText(log,DateTime.UtcNow.ToString("o")+" "+message+Environment.NewLine);}},token);File.WriteAllText(Path.Combine(root,"forge-prepare-result.json"),"{\"status\":\"ready\"}");}
        catch(Exception error){File.AppendAllText(log,error+Environment.NewLine);File.WriteAllText(Path.Combine(root,"forge-prepare-result.json"),BootstrapCore.Json.Serialize(new {status="failed",error=error.Message}));throw;}
    }
    [STAThread] static int Main(string[] args) {
        AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling",false);
        AppContext.SetSwitch("Switch.System.IO.BlockLongPaths",false);
        string payload=AppDomain.CurrentDomain.BaseDirectory,root=null;bool silent=false;
        try{for(int i=0;i<args.Length;i++){if(args[i]=="--root"&&i+1<args.Length)root=Path.GetFullPath(args[++i]);else if(args[i]=="--silent")silent=true;else throw new Exception("无效的准备参数");}if(root==null)throw new Exception("缺少 Forge 安装目录");
            if(silent){Execute(root,payload,(text,value)=>{},CancellationToken.None).GetAwaiter().GetResult();return 0;}
            Application.EnableVisualStyles();using(var form=new BootstrapForm(root,payload)){Application.Run(form);return form.Result;}
        }catch(Exception error){if(!silent)MessageBox.Show(error.Message,"Codex Forge",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1;}
    }
}
