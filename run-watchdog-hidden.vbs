Option Explicit

Dim shell, fso, appDir, watchdog
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
watchdog = appDir & "\run-watchdog.bat"

' Window style 0 keeps the long-running watchdog console fully hidden.
shell.Run """" & watchdog & """", 0, False
