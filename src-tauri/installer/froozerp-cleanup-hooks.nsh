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
