; Google Commander installer — Inno Setup 6. Built by scripts/package.mjs

#ifndef AppVersion
  #define AppVersion "1.1.0"
#endif
#define AppName "Google Commander"
#define AppExe "GoogleCommander.exe"
#define Root ".."

[Setup]
AppId={{B7E1D4A2-6C39-4F0B-8A57-3E92C1F6D804}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Google Commander contributors
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=commandline
DefaultDirName={autopf}\GoogleCommander
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableReadyPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
CloseApplications=yes
OutputDir={#Root}\dist
OutputBaseFilename=GoogleCommander-{#AppVersion}-setup
SetupIconFile={#Root}\resources\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
LZMAUseSeparateProcess=yes
WizardStyle=modern
ShowLanguageDialog=auto

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "german"; MessagesFile: "compiler:Languages\German.isl"
Name: "french"; MessagesFile: "compiler:Languages\French.isl"
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Messages]
english.WelcomeLabel2=A two-panel file manager in the style of Norton Commander: your computer on the left, your Google Drive on the right.%n%nF5 uploads and downloads, free Google Drive space is shown at the bottom of the panel.
russian.WelcomeLabel2=Двухпанельный файловый менеджер в стиле Norton Commander: файлы компьютера слева, ваш Google Drive справа.%n%nЗагрузка и скачивание клавишей F5, свободное место на Google Drive — внизу панели.
german.WelcomeLabel2=Ein Zweifenster-Dateimanager im Stil des Norton Commander: links Ihr Computer, rechts Ihr Google Drive.%n%nF5 lädt hoch und herunter, der freie Speicher auf Google Drive steht unten im Fenster.
french.WelcomeLabel2=Un gestionnaire de fichiers à deux panneaux dans le style de Norton Commander : votre ordinateur à gauche, votre Google Drive à droite.%n%nF5 envoie et télécharge, l'espace libre de Google Drive est affiché en bas du panneau.
spanish.WelcomeLabel2=Un gestor de archivos de dos paneles al estilo de Norton Commander: su ordenador a la izquierda y su Google Drive a la derecha.%n%nF5 sube y descarga, el espacio libre de Google Drive aparece abajo en el panel.

[CustomMessages]
english.DesktopIcon=Desktop shortcut
russian.DesktopIcon=Ярлык на рабочем столе
german.DesktopIcon=Verknüpfung auf dem Desktop
french.DesktopIcon=Raccourci sur le bureau
spanish.DesktopIcon=Acceso directo en el escritorio
english.Launch=Launch Google Commander
russian.Launch=Запустить Google Commander
german.Launch=Google Commander starten
french.Launch=Lancer Google Commander
spanish.Launch=Iniciar Google Commander

[Tasks]
Name: "desktopicon"; Description: "{cm:DesktopIcon}"

[Files]
Source: "{#Root}\dist\GoogleCommander\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:Launch}"; Flags: nowait postinstall skipifsilent
