using System;using System.IO;using System.IO.Compression;using System.Collections.Generic;using System.Threading;
internal static class BootstrapTests {
 static void Reject(Action action){try{action();}catch(InvalidDataException){return;}throw new Exception("Expected invalid data");}
 static void Put(ZipArchive zip,string name,string text){using(var writer=new StreamWriter(zip.CreateEntry(name).Open()))writer.Write(text);}
 static void Package(string file,Dictionary<string,object> adapter,string extra,string version){using(var zip=ZipFile.Open(file,ZipArchiveMode.Create)){Put(zip,"AppxManifest.xml","<Package><Identity Name=\"OpenAI.Codex\" Version=\""+version+"\" ProcessorArchitecture=\"x64\" Publisher=\""+adapter["publisher"]+"\" /></Package>");Put(zip,"app/ChatGPT.exe","fixture");Put(zip,extra,"fixture component");}}
 static int Main(string[] args){try{
  string root=args[0];var token=CancellationToken.None;var adapter=BootstrapCore.Read(args[1]);BootstrapCore.ValidateAdapter(adapter);
  string longRoot=Path.Combine(root,new String('a',120),new String('b',120));Directory.CreateDirectory(longRoot);File.WriteAllText(Path.Combine(longRoot,"long-path.txt"),"ok");
  foreach(string relative in new[]{"../escape","/absolute","C:/absolute","a\\b","a/../b","a./b","a /b","a//b","a:stream"})Reject(()=>BootstrapCore.SafePath(root,relative));
  string good=Path.Combine(root,"good.msix"),output=Path.Combine(root,"decoded");Package(good,adapter,"app/resources/node_modules/%40oai/browser-desktop/index.js",Convert.ToString(adapter["codexVersion"]));BootstrapCore.ExtractApp(good,output,adapter,token);
  if(!File.Exists(Path.Combine(output,"app/resources/node_modules/@oai/browser-desktop/index.js")))throw new Exception("Missing decoded browser component");
  string bad=Path.Combine(root,"bad.msix");Package(bad,adapter,"app/%2e%2e/escape","26.1016.8622.0");Reject(()=>BootstrapCore.ExtractApp(bad,Path.Combine(root,"bad"),adapter,token));
  string wrong=Path.Combine(root,"wrong.msix");Package(wrong,adapter,"app/resource","26.9999.1.0");Reject(()=>BootstrapCore.ExtractApp(wrong,Path.Combine(root,"wrong"),adapter,token));
  string dup=Path.Combine(root,"duplicate.msix");Package(dup,adapter,"app/resources/%40oai/file","26.1016.8622.0");using(var zip=ZipFile.Open(dup,ZipArchiveMode.Update))Put(zip,"app/resources/@oai/file","duplicate");Reject(()=>BootstrapCore.ExtractApp(dup,Path.Combine(root,"duplicate"),adapter,token));
  string leaf=Path.Combine(root,"file");File.WriteAllText(leaf,"good");var entry=new Dictionary<string,object>{{"path","file"},{"sha256",BootstrapCore.Hash(leaf)}};var manifest=new Dictionary<string,object>{{"files",new[]{entry}}};BootstrapCore.VerifyFiles(root,manifest,token);File.WriteAllText(leaf,"corrupt");Reject(()=>BootstrapCore.VerifyFiles(root,manifest,token));
  adapter["downloadUrl"]="https://example.com/client.msix";Reject(()=>BootstrapCore.ValidateAdapter(adapter));
  Console.WriteLine("BOOTSTRAP_CORE_PASS");return 0;
 }catch(Exception error){Console.Error.WriteLine(error);return 1;}}
}
