using System;using System.IO;using System.Reflection;
internal static class LauncherTests {
 static bool Stale(string root){return (bool)typeof(Launcher).GetMethod("CurrentPointerStale",BindingFlags.Static|BindingFlags.NonPublic).Invoke(null,new object[]{root+Path.DirectorySeparatorChar,Path.Combine(root,"current.json"),Path.Combine(root,"bootstrap.json")});}
 static void Put(string root,string name,string value){string file=Path.Combine(root,name);Directory.CreateDirectory(Path.GetDirectoryName(file));File.WriteAllText(file,value);}
 static void Check(bool value,string message){if(!value)throw new Exception(message);}
 static int Main(string[] args){try{
  string root=args[0];
  Put(root,"bootstrap.json","{\"directory\":\"forge/0.3.3\"}");
  Put(root,"current.json","{\"directory\":\"clients/old\"}");
  Put(root,"forge/0.3.3/forge.config.json","{\"version\":\"0.3.3\",\"codexVersion\":\"26.1027.6604.0\"}");
  Put(root,"forge/0.3.3/forge-payload.json","{\"payloadDigest\":\"new-content\"}");
  Put(root,"clients/old/forge-install.json","{\"forgeVersion\":\"0.3.3\",\"sourceMSIXVersion\":\"26.1027.3384.0\",\"forgePayloadSHA256\":\"old-content\"}");
  Check(Stale(root),"Same Forge version must rebuild for new native client");
  Put(root,"clients/old/forge-install.json","{\"forgeVersion\":\"0.3.3\",\"sourceMSIXVersion\":\"26.1027.6604.0\",\"forgePayloadSHA256\":\"old-content\"}");
  Check(Stale(root),"Same native client must rebuild for new payload");
  Put(root,"clients/old/forge-install.json","{\"forgeVersion\":\"0.3.3\",\"sourceMSIXVersion\":\"26.1027.6604.0\",\"forgePayloadSHA256\":\"new-content\"}");
  Check(!Stale(root),"Matching installation must be reused");
  File.Delete(Path.Combine(root,"forge/0.3.3/forge-payload.json"));Check(Stale(root),"Missing payload manifest must fail closed");
  Console.WriteLine("LAUNCHER_CORE_PASS");return 0;
 }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
