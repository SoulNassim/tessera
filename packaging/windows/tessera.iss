; The install engine of Tessera Studio's Windows setup (Inno Setup 6). Built in CI by .github/workflows/release.yml:
;   iscc /DAppVersion=1.2.3 packaging\windows\tessera.iss
; Expects the PyInstaller output in dist\TesseraStudio (python scripts/build_desktop.py).
; People don't see this wizard: packaging/windows/setup wraps the engine in Tessera's own setup window, which runs it
; with /VERYSILENT and draws the progress itself. The wizard below only shows on PCs without WebView2.
; Installs per user (no admin prompt) into %LOCALAPPDATA%\Programs\Tessera Studio.
; Tessera Studio is its own product (its own AppId). If Glob, the app it replaces, is installed, setup removes that
; app first: only the program. Projects, settings and keys live in the user's folders and are untouched.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{105F9546-80AD-43FC-9AB7-CE91E9291134}
AppName=Tessera Studio
AppVersion={#AppVersion}
AppPublisher=SoulNassim
AppPublisherURL=https://soulnassim.github.io/tessera/
AppSupportURL=https://github.com/SoulNassim/tessera/issues
DefaultDirName={localappdata}\Programs\Tessera Studio
DefaultGroupName=Tessera Studio
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\..\dist
OutputBaseFilename=TesseraStudio-Engine
SetupIconFile=..\..\forge\ui\tessera.ico
UninstallDisplayIcon={app}\TesseraStudio.exe
LicenseFile=..\..\LICENSE
Compression=lzma2
SolidCompression=yes
; Dark like the app, with Tessera's own art. Needs Inno Setup 6.6+.
WizardStyle=modern dark
WizardImageFile=wizard-0.png,wizard-1.png,wizard-2.png
WizardSmallImageFile=wizard-small-0.png,wizard-small-1.png,wizard-small-2.png
WizardImageStretch=yes
; Show the Welcome page so the side art greets people, not just waves goodbye.
DisableWelcomePage=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\..\dist\TesseraStudio\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; Shortcuts that Glob's own uninstaller might leave behind.
Type: files; Name: "{autoprograms}\Glob.lnk"
Type: files; Name: "{autodesktop}\Glob.lnk"

[Icons]
Name: "{autoprograms}\Tessera Studio"; Filename: "{app}\TesseraStudio.exe"
Name: "{autodesktop}\Tessera Studio"; Filename: "{app}\TesseraStudio.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\TesseraStudio.exe"; Description: "{cm:LaunchProgram,Tessera Studio}"; Flags: nowait postinstall skipifsilent
; Silent installs come from the app's own updater: start the new version right away. The setup window passes
; /NOLAUNCH: it offers to open Tessera itself.
Filename: "{app}\TesseraStudio.exe"; Flags: nowait; Check: LaunchAfterSilentInstall

[Code]
const
  GlobUninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{6F3C2B1A-5D47-4E8B-9A0C-61F0B9E2D7A4}_is1';

// Glob's uninstaller removes only the files it installed (it has no [UninstallDelete]); user data stays.
procedure RemoveGlob();
var
  Cmd: String;
  Code: Integer;
begin
  if not RegQueryStringValue(HKCU, GlobUninstallKey, 'UninstallString', Cmd) then exit;
  Cmd := RemoveQuotes(Cmd);
  if not FileExists(Cmd) then exit;
  Log('Removing Glob: ' + Cmd);
  Exec(Cmd, '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

function LaunchAfterSilentInstall(): Boolean;
begin
  Result := WizardSilent and (Pos('/NOLAUNCH', Uppercase(GetCmdTail)) = 0);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then RemoveGlob();
end;
