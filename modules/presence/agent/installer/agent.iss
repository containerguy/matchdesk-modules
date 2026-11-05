; Mitspielzentrale Agent: Installer pro Benutzer (ohne Adminrechte), gebaut mit Inno Setup 6.
;   iscc /DAppVersion=1.1.0 /DSourceDir=..\dist /DOutputDir=..\dist installer\agent.iss
; Erwartet in SourceDir: matchdesk-agent.exe (bereits signiert, wenn signiert wird).

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist"
#endif
#define AppName "Mitspielzentrale Agent"
#define AppExe "matchdesk-agent.exe"
#define RunKey "Software\Microsoft\Windows\CurrentVersion\Run"
#define ProtocolKey "Software\Classes\matchdesk-agent"

[Setup]
; Feste AppId: Updates installieren über die vorhandene Version.
AppId={{6F1C2B7E-3A4D-4E8B-9C21-5D7A0B3E9F14}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Mitspielzentrale
AppPublisherURL=https://github.com/containerguy/matchdesk-modules
AppSupportURL=https://github.com/containerguy/matchdesk-modules/issues
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} Setup
PrivilegesRequired=lowest
DefaultDirName={autopf}\{#AppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableWelcomePage=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
SetupIconFile=..\icons\app.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
CloseApplications=force
RestartApplications=no
OutputDir={#OutputDir}
OutputBaseFilename=matchdesk-agent-setup
Compression=lzma2/max
SolidCompression=yes

[Languages]
Name: "de"; MessagesFile: "compiler:Languages\German.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
de.AutostartTask=Mit Windows starten (empfohlen)
en.AutostartTask=Start with Windows (recommended)
de.LaunchNow=Agent jetzt starten
en.LaunchNow=Start the agent now

[Messages]
de.WelcomeLabel2=[name/ver]%n%nDer Agent meldet der Mitspielzentrale, welches Spiel du gerade spielst. Er läuft unauffällig im Infobereich neben der Uhr. Adminrechte sind nicht nötig.%n%nNach der Installation auf der Seite „Spielt gerade“ auf „Agent verbinden“ klicken.
en.WelcomeLabel2=[name/ver]%n%nThe agent tells Matchdesk which game you are playing. It runs quietly in the notification area next to the clock. No admin rights needed.%n%nAfter installing, click “Connect agent” on the “Now playing” page.

[Tasks]
Name: "autostart"; Description: "{cm:AutostartTask}"

[Files]
Source: "{#SourceDir}\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"

[Registry]
; Links matchdesk-agent://pair?… aus dem Browser öffnen den Agenten.
Root: HKCU; Subkey: "{#ProtocolKey}"; ValueType: string; ValueName: ""; ValueData: "URL:{#AppName}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "{#ProtocolKey}"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "{#ProtocolKey}\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExe}"",0"
Root: HKCU; Subkey: "{#ProtocolKey}\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExe}"" ""%1"""
Root: HKCU; Subkey: "{#RunKey}"; ValueType: string; ValueName: "{#AppName}"; ValueData: """{app}\{#AppExe}"" -background"; Tasks: autostart; Check: KeepAutostart; Flags: uninsdeletevalue

[Run]
; Interaktiv: Haken „jetzt starten“. Still (Update aus dem Tray): neuen Agenten direkt wieder starten.
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchNow}"; Flags: nowait postinstall skipifsilent
Filename: "{app}\{#AppExe}"; Parameters: "-background"; Flags: nowait skipifnotsilent

[UninstallDelete]
; Gespeicherte Verbindung (verschlüsselter Schlüssel) und Protokoll.
Type: filesandordirs; Name: "{localappdata}\Mitspielzentrale\Agent"
Type: dirifempty; Name: "{localappdata}\Mitspielzentrale"

[Code]
var
  WasInstalled, HadAutostart: Boolean;

function InitializeSetup(): Boolean;
begin
  WasInstalled := RegKeyExists(HKEY_CURRENT_USER, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{6F1C2B7E-3A4D-4E8B-9C21-5D7A0B3E9F14}_is1');
  HadAutostart := RegValueExists(HKEY_CURRENT_USER, '{#RunKey}', '{#AppName}');
  Result := True;
end;

// Stilles Update aus dem Tray: Wer den Autostart im Tray abgeschaltet hat, behält das.
function KeepAutostart(): Boolean;
begin
  Result := not (WizardSilent and WasInstalled and not HadAutostart);
end;

// Autostart kann auch im Tray eingeschaltet worden sein: beim Deinstallieren immer entfernen.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    RegDeleteValue(HKEY_CURRENT_USER, '{#RunKey}', '{#AppName}');
end;
