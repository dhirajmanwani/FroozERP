!macro NSIS_HOOK_PREINSTALL
  DetailPrint "FroozERP update: stopping local backend before replacing packaged files."
  DetailPrint "FroozERP update: preserving business data under %APPDATA%\com.srtcompany.froozerp"

  ; Stop only the FroozERP backend sidecar located under the selected install directory.
  ; This prevents Retry/Ignore file-write prompts for binaries\froozerp-backend-node.exe.
  FileOpen $0 "$TEMP\froozerp-stop-backend.ps1" w
  FileWrite $0 "$$ErrorActionPreference = 'Stop'$\r$\n"
  FileWrite $0 "$$target = [System.IO.Path]::GetFullPath('$INSTDIR\binaries\froozerp-backend-node.exe')$\r$\n"
  FileWrite $0 "Get-CimInstance Win32_Process -Filter $\"Name='froozerp-backend-node.exe'$\" | ForEach-Object {$\r$\n"
  FileWrite $0 "  if ($$_.ExecutablePath -and ([System.IO.Path]::GetFullPath($$_.ExecutablePath) -ieq $$target)) {$\r$\n"
  FileWrite $0 "    Stop-Process -Id $$_.ProcessId -Force -ErrorAction Stop$\r$\n"
  FileWrite $0 "  }$\r$\n"
  FileWrite $0 "}$\r$\n"
  FileWrite $0 "Start-Sleep -Milliseconds 500$\r$\n"
  FileWrite $0 "exit 0$\r$\n"
  FileClose $0
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$TEMP\froozerp-stop-backend.ps1"'
  Sleep 1000

  ; Confirm the backend executable can be opened for writing before NSIS starts copying files.
  FileOpen $0 "$TEMP\froozerp-check-backend-unlock.ps1" w
  FileWrite $0 "$$path = '$INSTDIR\binaries\froozerp-backend-node.exe'$\r$\n"
  FileWrite $0 "if (!(Test-Path -LiteralPath $$path)) { exit 0 }$\r$\n"
  FileWrite $0 "try {$\r$\n"
  FileWrite $0 "  $$stream = [System.IO.File]::Open($$path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)$\r$\n"
  FileWrite $0 "  $$stream.Close()$\r$\n"
  FileWrite $0 "  exit 0$\r$\n"
  FileWrite $0 "} catch {$\r$\n"
  FileWrite $0 "  exit 35$\r$\n"
  FileWrite $0 "}$\r$\n"
  FileClose $0
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$TEMP\froozerp-check-backend-unlock.ps1"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "FroozERP update: backend sidecar file is still locked: $INSTDIR\binaries\froozerp-backend-node.exe"
    MessageBox MB_ICONSTOP "FroozERP local backend could not be stopped safely. The update has been cancelled before replacing files. Close FroozERP and retry from Update Center."
    Abort
  ${EndIf}

  DetailPrint "FroozERP update: backend sidecar stopped and file unlocked."
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "FroozERP cleanup: preserving business data under %APPDATA%\com.srtcompany.froozerp"
  DetailPrint "FroozERP cleanup: removing legacy user/Chrome shortcut duplicates only"

  ; Keep the per-machine shortcuts created by the current installer.
  ; Remove older user-profile and Chrome/PWA shortcuts that can launch stale copies.
  Delete "$DESKTOP\FroozERP.lnk"
  Delete "$SMPROGRAMS\FroozERP.lnk"
  Delete "$COMMONSMPROGRAMS\FroozERP.lnk"
  Delete "$SMPROGRAMS\Chrome Apps\FroozERP.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\d0400be39e01c338dfc0b992b6a2c220"

  ; Remove old empty Chrome Apps folder only if this shortcut was the last entry.
  RMDir "$SMPROGRAMS\Chrome Apps"

  DetailPrint "FroozERP cleanup: old shortcut cleanup completed. Business data preserved."
!macroend
