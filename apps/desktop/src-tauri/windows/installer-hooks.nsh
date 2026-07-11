!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\UnderstandBook" "InstallDir" "$INSTDIR"
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Install the Understand Book plugin for Codex? This adds a plugin marketplace to your Codex user configuration. You can retry later from Understand Book." \
    IDNO understand_book_skip_plugin
  ExecWait '"$INSTDIR\UnderstandBook.exe" --install-codex-plugin' $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONINFORMATION \
      "Understand Book was installed. The Codex plugin is pending and can be installed later from the reader."
  ${EndIf}
understand_book_skip_plugin:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ExecWait '"$INSTDIR\UnderstandBook.exe" --uninstall-owned-codex-plugin' $0
  DeleteRegKey HKCU "Software\UnderstandBook"
!macroend
