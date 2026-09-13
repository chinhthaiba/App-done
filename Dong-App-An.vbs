Set WshShell = CreateObject("WScript.Shell")
strPath = WshShell.CurrentDirectory
If Right(strPath, 1) <> "\" Then strPath = strPath & "\"
WshShell.Run Chr(34) & strPath & "Dong-App.bat" & Chr(34), 0, False
