// Tessera Studio's Windows setup: a frameless window drawn in HTML (ui/index.html) with WebView2, in front of the
// Inno Setup engine (packaging/windows/tessera.iss), which does the actual install silently: files, shortcuts, the
// uninstaller, removing Glob. Built by packaging/windows/setup/build_setup.py with the C# compiler that ships with
// .NET Framework 4 (C# 5: no string interpolation, no ?.).
//
// The engine is appended to this exe after the compiled program:
//   [engine exe][info json][engine length: 8 bytes][json length: 4 bytes]["TSSETUP1"]
// The UI files and the WebView2 SDK DLLs are embedded resources, unpacked to a temp folder at start.
//
// Silent installs (/SILENT, /VERYSILENT: the app's own updater) and machines without the WebView2 runtime skip the
// window and hand every argument to the engine as is.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Tessera Studio Setup")]
[assembly: AssemblyProduct("Tessera Studio")]
[assembly: AssemblyCompany("SoulNassim")]
[assembly: AssemblyCopyright("Copyright (c) 2026 SoulNassim")]

namespace TesseraSetup
{
    internal static class Program
    {
        internal const string AppExe = "TesseraStudio.exe";
        internal const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\{105F9546-80AD-43FC-9AB7-CE91E9291134}_is1";
        internal static string Temp;
        internal static Payload Info;

        [STAThread]
        private static int Main(string[] args)
        {
            Temp = Path.Combine(Path.GetTempPath(), "TesseraSetup-" + Process.GetCurrentProcess().Id);
            Directory.CreateDirectory(Temp);
            try
            {
                Info = Payload.Read();
                if (Info == null)
                {
                    Native.Message("This setup file is damaged. Download it again from https://soulnassim.github.io/tessera/");
                    return 1;
                }
                bool silent = false;
                foreach (string a in args)
                {
                    string u = a.ToUpperInvariant();
                    if (u == "/SILENT" || u == "/VERYSILENT" || u.StartsWith("/LOG") || u == "/?" || u == "/HELP") silent = true;
                }
                if (silent || !WebViewHost.Prepare()) return Engine.RunPassthrough(args);

                Native.SetDpiAware();
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                return WebViewHost.Run();
            }
            finally
            {
                Cleanup();
            }
        }

        private static void Cleanup()
        {
            // WebView2's browser process lets go of its profile folder a moment after the window closes.
            for (int i = 0; i < 10; i++)
            {
                try { Directory.Delete(Temp, true); return; }
                catch (Exception) { Thread.Sleep(200); }
            }
        }
    }

    // ------------------------------------------------------------------ payload

    internal sealed class Payload
    {
        private const string Magic = "TSSETUP1";
        public long EngineOffset;
        public long EngineLength;
        public string Version = "0.0.0";
        public long Bytes;
        public int Files;
        public string License = "";

        public static Payload Read()
        {
            string self = Assembly.GetExecutingAssembly().Location;
            using (FileStream fs = File.OpenRead(self))
            using (BinaryReader br = new BinaryReader(fs))
            {
                if (fs.Length < 20) return null;
                fs.Seek(-20, SeekOrigin.End);
                long engineLen = br.ReadInt64();
                int jsonLen = br.ReadInt32();
                string magic = Encoding.ASCII.GetString(br.ReadBytes(8));
                if (magic != Magic) return null;
                long jsonStart = fs.Length - 20 - jsonLen;
                fs.Seek(jsonStart, SeekOrigin.Begin);
                string json = Encoding.UTF8.GetString(br.ReadBytes(jsonLen));
                var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
                Payload p = new Payload();
                p.EngineLength = engineLen;
                p.EngineOffset = jsonStart - engineLen;
                if (d.ContainsKey("version")) p.Version = Convert.ToString(d["version"]);
                if (d.ContainsKey("bytes")) p.Bytes = Convert.ToInt64(d["bytes"]);
                if (d.ContainsKey("files")) p.Files = Convert.ToInt32(d["files"]);
                if (d.ContainsKey("license")) p.License = Convert.ToString(d["license"]);
                return p;
            }
        }

        public string ExtractEngine()
        {
            string target = Path.Combine(Program.Temp, "TesseraStudio-Engine.exe");
            if (File.Exists(target) && new FileInfo(target).Length == EngineLength) return target;
            string self = Assembly.GetExecutingAssembly().Location;
            using (FileStream src = File.OpenRead(self))
            using (FileStream dst = File.Create(target))
            {
                src.Seek(EngineOffset, SeekOrigin.Begin);
                byte[] buf = new byte[1 << 20];
                long left = EngineLength;
                while (left > 0)
                {
                    int n = src.Read(buf, 0, (int)Math.Min(buf.Length, left));
                    if (n <= 0) throw new IOException("The setup file ends early.");
                    dst.Write(buf, 0, n);
                    left -= n;
                }
            }
            return target;
        }
    }

    // ------------------------------------------------------------------ the Inno Setup engine

    internal static class Engine
    {
        public static int RunPassthrough(string[] args)
        {
            string exe = Program.Info.ExtractEngine();
            StringBuilder cmd = new StringBuilder();
            foreach (string a in args) cmd.Append(Quote(a)).Append(' ');
            Process p = Process.Start(new ProcessStartInfo(exe, cmd.ToString().Trim()) { UseShellExecute = false });
            p.WaitForExit();
            return p.ExitCode;
        }

        internal static string Quote(string a)
        {
            if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '"', '\t' }) < 0) return a;
            // Inno reads /DIR="C:\a b" the way Windows splits arguments: quote the value, not the switch.
            int eq = a.IndexOf('=');
            if (a.StartsWith("/") && eq > 0) return a.Substring(0, eq + 1) + "\"" + a.Substring(eq + 1).Replace("\"", "") + "\"";
            return "\"" + a.Replace("\"", "") + "\"";
        }

        // Installs on a background thread; reports 0..1 through onProgress as the engine's log names each file.
        public static void Install(string dir, bool desktop, Action<double, string> onProgress, Action<int, string> onExit)
        {
            Thread t = new Thread(delegate ()
            {
                int code = -1;
                string log = Path.Combine(Program.Temp, "install.log");
                try
                {
                    onProgress(0.01, "Unpacking…");
                    string exe = Program.Info.ExtractEngine();
                    if (File.Exists(log)) File.Delete(log);
                    string args = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /NOLAUNCH /SP- "
                                  + Quote("/DIR=" + dir) + " "
                                  + (desktop ? "/MERGETASKS=desktopicon" : "/MERGETASKS=!desktopicon") + " "
                                  + Quote("/LOG=" + log);
                    Process p = Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = false, CreateNoWindow = true });
                    Regex dest = new Regex(@"Dest filename: (.+)$", RegexOptions.Multiline);
                    long pos = 0;
                    int seen = 0;
                    int total = Math.Max(1, Program.Info.Files);
                    StringBuilder pending = new StringBuilder();
                    while (true)
                    {
                        bool exited = p.WaitForExit(120);
                        try
                        {
                            if (File.Exists(log))
                            {
                                using (FileStream fs = new FileStream(log, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                                {
                                    if (fs.Length > pos)
                                    {
                                        fs.Seek(pos, SeekOrigin.Begin);
                                        byte[] buf = new byte[fs.Length - pos];
                                        int n = fs.Read(buf, 0, buf.Length);
                                        pos += n;
                                        pending.Append(Encoding.UTF8.GetString(buf, 0, n));
                                    }
                                }
                                string text = pending.ToString();
                                int cut = text.LastIndexOf('\n');
                                if (cut >= 0)
                                {
                                    string last = null;
                                    foreach (Match m in dest.Matches(text.Substring(0, cut + 1)))
                                    {
                                        seen++;
                                        last = m.Groups[1].Value.Trim();
                                    }
                                    pending.Remove(0, cut + 1);
                                    if (last != null)
                                    {
                                        string shown = last.StartsWith(dir, StringComparison.OrdinalIgnoreCase) ? last.Substring(dir.Length).TrimStart('\\') : Path.GetFileName(last);
                                        onProgress(0.03 + 0.95 * Math.Min(1.0, seen / (double)total), shown);
                                    }
                                }
                            }
                        }
                        catch (IOException) { /* the engine is writing; read again next round */ }
                        if (exited) break;
                    }
                    code = p.ExitCode;
                    onExit(code, code == 0 ? "" : Tail(log));
                }
                catch (Exception ex)
                {
                    onExit(code == 0 ? -1 : code, ex.Message);
                }
            });
            t.IsBackground = true;
            t.Start();
        }

        private static string Tail(string log)
        {
            try
            {
                string[] lines = File.ReadAllLines(log);
                int from = Math.Max(0, lines.Length - 8);
                return string.Join("\n", lines, from, lines.Length - from);
            }
            catch (Exception) { return ""; }
        }

        public static string ExplainExit(int code)
        {
            switch (code)
            {
                case 2: return "Setup was cancelled before it started.";
                case 5: return "Tessera Studio is still running and couldn't be closed. Quit it from the tray icon, then try again.";
                case 6: return "Setup was stopped before it finished.";
                case 7: return "Setup couldn't get ready to install. Check there's room on the drive and that the folder can be written to.";
                default: return "Setup couldn't finish installing.";
            }
        }
    }

    // ------------------------------------------------------------------ the window

    internal static class WebViewHost
    {
        private static readonly string[] Dlls = { "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll" };
        private static string LibDir;

        // Unpacks the UI and WebView2's DLLs, and checks the WebView2 runtime is installed.
        public static bool Prepare()
        {
            try
            {
                LibDir = Path.Combine(Program.Temp, "lib");
                Directory.CreateDirectory(LibDir);
                Assembly me = Assembly.GetExecutingAssembly();
                foreach (string name in me.GetManifestResourceNames())
                {
                    string rel;
                    if (name.StartsWith("lib/")) rel = Path.Combine("lib", name.Substring(4));
                    else if (name.StartsWith("ui/")) rel = Path.Combine("ui", name.Substring(3).Replace('/', '\\'));
                    else continue;
                    string target = Path.Combine(Program.Temp, rel);
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (Stream s = me.GetManifestResourceStream(name))
                    using (FileStream f = File.Create(target)) s.CopyTo(f);
                }
                foreach (string d in Dlls) if (!File.Exists(Path.Combine(LibDir, d))) return false;
                AppDomain.CurrentDomain.AssemblyResolve += delegate (object sender, ResolveEventArgs e)
                {
                    string file = Path.Combine(LibDir, new AssemblyName(e.Name).Name + ".dll");
                    return File.Exists(file) ? Assembly.LoadFrom(file) : null;
                };
                Native.LoadLibrary(Path.Combine(LibDir, "WebView2Loader.dll"));
                return RuntimeVersion() != null;
            }
            catch (Exception)
            {
                return false;
            }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static string RuntimeVersion()
        {
            try { return Microsoft.Web.WebView2.Core.CoreWebView2Environment.GetAvailableBrowserVersionString(); }
            catch (Exception) { return null; }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        public static int Run()
        {
            SetupForm form = new SetupForm();
            Application.Run(form);
            if (form.FallBack) return Engine.RunPassthrough(new string[0]);
            return form.ExitCode;
        }
    }

    internal sealed class SetupForm : Form
    {
        private const int BaseW = 960, BaseH = 600;
        private Microsoft.Web.WebView2.WinForms.WebView2 web;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer();
        private string installedDir;
        private string installedVersion;
        private string chosenDir;
        private bool installing;
        public bool FallBack;
        public int ExitCode = 2;  // Inno's "cancelled" until something installs

        public SetupForm()
        {
            float scale = Native.DpiScale();
            Text = "Tessera Studio Setup";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size((int)(BaseW * scale), (int)(BaseH * scale));
            BackColor = Color.FromArgb(8, 8, 11);
            try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch (Exception) { }
            ReadInstalled();
            chosenDir = installedDir ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\Tessera Studio");

            web = new Microsoft.Web.WebView2.WinForms.WebView2();
            web.Dock = DockStyle.Fill;
            web.DefaultBackgroundColor = Color.FromArgb(8, 8, 11);
            Controls.Add(web);
            Load += async delegate
            {
                try
                {
                    var env = await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.Temp, "profile"));
                    await web.EnsureCoreWebView2Async(env);
                    var core = web.CoreWebView2;
                    core.Settings.AreDevToolsEnabled = Environment.GetEnvironmentVariable("TESSERA_SETUP_DEVTOOLS") == "1";
                    core.Settings.AreDefaultContextMenusEnabled = false;
                    core.Settings.IsZoomControlEnabled = false;
                    core.Settings.IsStatusBarEnabled = false;
                    core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                    core.SetVirtualHostNameToFolderMapping("setup.tessera", Path.Combine(Program.Temp, "ui"),
                        Microsoft.Web.WebView2.Core.CoreWebView2HostResourceAccessKind.Allow);
                    core.NewWindowRequested += delegate (object s, Microsoft.Web.WebView2.Core.CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; };
                    core.WebMessageReceived += OnMessage;
                    core.Navigate("https://setup.tessera/index.html");
                }
                catch (Exception)
                {
                    FallBack = true;
                    Close();
                }
            };
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ClassStyle |= 0x20000;       // CS_DROPSHADOW
                cp.Style |= 0x20000 | 0x80000;  // WS_MINIMIZEBOX | WS_SYSMENU: minimize and the taskbar menu still work
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Native.Round(Handle);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // Closing mid-install would leave a half-copied app: keep the window until the engine is done.
            if (installing && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; return; }
            base.OnFormClosing(e);
        }

        private void ReadInstalled()
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(Program.UninstallKey))
            {
                if (k == null) return;
                string dir = k.GetValue("InstallLocation") as string;
                if (!string.IsNullOrEmpty(dir)) installedDir = dir.TrimEnd('\\');
                installedVersion = k.GetValue("DisplayVersion") as string;
            }
        }

        private void Post(Dictionary<string, object> msg)
        {
            string s = json.Serialize(msg);
            if (InvokeRequired) { BeginInvoke((Action)delegate { Post(msg); }); return; }
            if (web.CoreWebView2 != null) web.CoreWebView2.PostWebMessageAsJson(s);
        }

        private static Dictionary<string, object> Msg(string type)
        {
            return new Dictionary<string, object> { { "type", type } };
        }

        private void OnMessage(object sender, Microsoft.Web.WebView2.Core.CoreWebView2WebMessageReceivedEventArgs e)
        {
            Dictionary<string, object> m;
            try { m = json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson); }
            catch (Exception) { return; }
            string type = m.ContainsKey("type") ? Convert.ToString(m["type"]) : "";
            switch (type)
            {
                case "ready":
                    var init = Msg("init");
                    init["version"] = Program.Info.Version;
                    init["bytes"] = Program.Info.Bytes;
                    init["dir"] = chosenDir;
                    init["installed"] = installedVersion ?? "";
                    init["license"] = Program.Info.License;
                    Post(init);
                    // Unpack the engine now, while people read the first screen.
                    ThreadPool.QueueUserWorkItem(delegate { try { Program.Info.ExtractEngine(); } catch (Exception) { } });
                    break;
                case "drag":
                    Native.DragWindow(Handle);
                    break;
                case "minimize":
                    WindowState = FormWindowState.Minimized;
                    break;
                case "close":
                    Close();
                    break;
                case "browse":
                    string picked = Native.PickFolder(Handle, chosenDir);
                    if (picked != null)
                    {
                        // A plain folder like D:\Games gets its own Tessera Studio folder inside it.
                        if (!Path.GetFileName(picked).Equals("Tessera Studio", StringComparison.OrdinalIgnoreCase))
                            picked = Path.Combine(picked, "Tessera Studio");
                        chosenDir = picked;
                        var d = Msg("dir");
                        d["dir"] = chosenDir;
                        Post(d);
                    }
                    break;
                case "install":
                    if (installing) break;
                    string dir = m.ContainsKey("dir") ? Convert.ToString(m["dir"]) : chosenDir;
                    bool desktop = m.ContainsKey("desktop") && Convert.ToBoolean(m["desktop"]);
                    bool launch = m.ContainsKey("launch") && Convert.ToBoolean(m["launch"]);
                    chosenDir = dir;
                    installing = true;
                    Engine.Install(dir, desktop,
                        delegate (double p, string file)
                        {
                            var pm = Msg("progress");
                            pm["p"] = p;
                            pm["file"] = file;
                            Post(pm);
                        },
                        delegate (int code, string detail)
                        {
                            installing = false;
                            ExitCode = code;
                            if (code == 0)
                            {
                                var dm = Msg("done");
                                dm["launch"] = launch;
                                Post(dm);
                            }
                            else
                            {
                                var em = Msg("error");
                                em["message"] = Engine.ExplainExit(code);
                                em["detail"] = detail;
                                Post(em);
                            }
                        });
                    break;
                case "launch":
                    try
                    {
                        string app = Path.Combine(chosenDir, Program.AppExe);
                        Process.Start(new ProcessStartInfo(app) { UseShellExecute = true, WorkingDirectory = chosenDir });
                    }
                    catch (Exception) { }
                    Close();
                    break;
                case "log":
                    string log = Path.Combine(Program.Temp, "install.log");
                    // Copied out of the temp folder, which goes away with this window.
                    string keep = Path.Combine(Path.GetTempPath(), "TesseraStudio-Setup.log");
                    try { File.Copy(log, keep, true); Process.Start("notepad.exe", "\"" + keep + "\""); } catch (Exception) { }
                    break;
            }
        }
    }

    // ------------------------------------------------------------------ Win32

    internal static class Native
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr LoadLibrary(string path);
        [DllImport("user32.dll")] private static extern bool ReleaseCapture();
        [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int MessageBoxW(IntPtr h, string text, string caption, uint type);
        [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] private static extern uint GetDpiForSystem();
        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);

        public static void Message(string text) { MessageBoxW(IntPtr.Zero, text, "Tessera Studio Setup", 0x10); }

        public static void SetDpiAware()
        {
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (Exception) { }  // per-monitor v2
            try { SetProcessDPIAware(); } catch (Exception) { }
        }

        public static float DpiScale()
        {
            try { return GetDpiForSystem() / 96f; } catch (Exception) { return 1f; }
        }

        public static void Round(IntPtr h)
        {
            try
            {
                int round = 2;  // DWMWCP_ROUND (Windows 11)
                DwmSetWindowAttribute(h, 33, ref round, 4);
                int dark = 1;   // DWMWA_USE_IMMERSIVE_DARK_MODE
                DwmSetWindowAttribute(h, 20, ref dark, 4);
                int border = 0x0B0808;  // DWMWA_BORDER_COLOR, COLORREF (0x00BBGGRR): near the page background
                DwmSetWindowAttribute(h, 34, ref border, 4);
            }
            catch (Exception) { }
        }

        public static void DragWindow(IntPtr h)
        {
            ReleaseCapture();
            SendMessage(h, 0xA1, new IntPtr(2), IntPtr.Zero);  // WM_NCLBUTTONDOWN, HTCAPTION
        }

        // The modern Explorer folder picker (IFileOpenDialog with FOS_PICKFOLDERS), not the old tree dialog.
        public static string PickFolder(IntPtr owner, string start)
        {
            IFileOpenDialog dlg = null;
            try
            {
                dlg = (IFileOpenDialog)new FileOpenDialogRCW();
                uint opts;
                dlg.GetOptions(out opts);
                dlg.SetOptions(opts | 0x20 | 0x40 | 0x800);  // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST
                dlg.SetTitle("Choose where to install Tessera Studio");
                string existing = start;
                while (!string.IsNullOrEmpty(existing) && !Directory.Exists(existing)) existing = Path.GetDirectoryName(existing);
                if (!string.IsNullOrEmpty(existing))
                {
                    IShellItem item;
                    Guid iid = typeof(IShellItem).GUID;
                    if (SHCreateItemFromParsingName(existing, IntPtr.Zero, ref iid, out item) == 0) dlg.SetFolder(item);
                }
                if (dlg.Show(owner) != 0) return null;
                IShellItem result;
                dlg.GetResult(out result);
                string path;
                result.GetDisplayName(0x80058000, out path);  // SIGDN_FILESYSPATH
                return path;
            }
            catch (Exception)
            {
                return null;
            }
            finally
            {
                if (dlg != null) Marshal.ReleaseComObject(dlg);
            }
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
        private static extern int SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IShellItem item);

        [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
        private class FileOpenDialogRCW { }

        [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IFileOpenDialog
        {
            [PreserveSig] int Show(IntPtr parent);
            void SetFileTypes();
            void SetFileTypeIndex();
            void GetFileTypeIndex();
            void Advise();
            void Unadvise();
            void SetOptions(uint fos);
            void GetOptions(out uint fos);
            void SetDefaultFolder(IShellItem si);
            void SetFolder(IShellItem si);
            void GetFolder();
            void GetCurrentSelection();
            void SetFileName();
            void GetFileName();
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
            void SetOkButtonLabel();
            void SetFileNameLabel();
            void GetResult(out IShellItem si);
        }

        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellItem
        {
            void BindToHandler();
            void GetParent();
            void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
            void GetAttributes();
            void Compare();
        }
    }
}
