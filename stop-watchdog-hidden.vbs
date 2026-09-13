Option Explicit

Dim shell, fso, appDir, stopScript
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
stopScript = appDir & "\stop-watchdog.bat"

shell.Run """" & stopScript & """ STOP", 0, False
