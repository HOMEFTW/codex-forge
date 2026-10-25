using System;
using System.IO;
using System.Diagnostics;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using System.Reflection;
[assembly: AssemblyTitle("Codex Forge")]
[assembly: AssemblyProduct("Codex Forge")]
[assembly: AssemblyDescription("Codex Forge plugin host launcher")]
[assembly: AssemblyVersion("0.2.0.0")]
internal static class Launcher {
    static string Quote(string value) { return "\""+value.Replace("\"", "\\\"")+"\""; }
    [STAThread] static int Main(string[] args) {
        Application.EnableVisualStyles();
        try {
            string root=AppDomain.CurrentDomain.BaseDirectory;
            string pointer=Path.Combine(root,"current.json");
            if(!File.Exists(pointer)&&File.Exists(Path.Combine(root,"bootstrap.json"))) {
                var setup=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(root,"bootstrap.json")));
                string relative=setup["directory"] as string,selected=Path.GetFullPath(Path.Combine(root,relative??""));
                if(String.IsNullOrEmpty(relative)||Path.IsPathRooted(relative)||!selected.StartsWith(root,StringComparison.OrdinalIgnoreCase))throw new Exception("Forge 准备程序路径无效。");
                var prepare=new ProcessStartInfo(Path.Combine(selected,"CodexForgeBootstrap.exe"),"--root "+Quote(root.TrimEnd(Path.DirectorySeparatorChar))) { UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=root };
                using(var child=Process.Start(prepare)){child.WaitForExit();if(child.ExitCode!=0)return child.ExitCode;}
            }
            if(File.Exists(pointer)) {
                var config=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(pointer));
                string relative=config["directory"] as string;
                string selected=Path.GetFullPath(Path.Combine(root,relative??""));
                if(String.IsNullOrEmpty(relative)||Path.IsPathRooted(relative)||!selected.StartsWith(root,StringComparison.OrdinalIgnoreCase)) throw new Exception("Forge 当前版本路径无效。");
                root=selected;
            }
            string script=Path.Combine(root,"Launch-Codex-Forge.ps1");
            if(!File.Exists(script)||!File.Exists(Path.Combine(root,"forge-install.json"))) throw new Exception("安装内容不完整，请完整重新安装 Codex Forge。");
            string parameters="-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "+Quote(script);
            for(int i=0;i<args.Length;i++) {
                if(args[i]=="--profile"&&i+1<args.Length) parameters+=" -ProfileRoot "+Quote(Path.GetFullPath(args[++i]));
                else if(args[i]=="--debug-port"&&i+1<args.Length) { int port; if(!Int32.TryParse(args[++i],out port)||port<1024||port>65535) throw new Exception("无效调试端口。"); parameters+=" -DebugPort "+port; }
                else throw new Exception("不支持的启动参数。");
            }
            var info=new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\powershell.exe"),parameters) { UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=root };
            using(var child=Process.Start(info)) {
                var output=child.StandardOutput.ReadToEndAsync();var error=child.StandardError.ReadToEndAsync();child.WaitForExit();
                if(child.ExitCode!=0) { string message=output.Result+error.Result; MessageBox.Show(String.IsNullOrWhiteSpace(message)?"启动失败，请检查安装。":message,"Codex Forge",MessageBoxButtons.OK,child.ExitCode==2?MessageBoxIcon.Information:MessageBoxIcon.Error); }
                return child.ExitCode;
            }
        } catch(Exception e) { MessageBox.Show(e.Message,"Codex Forge",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1; }
    }
}
