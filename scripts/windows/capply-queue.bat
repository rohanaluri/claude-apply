@echo off
rem Double-click to run `capply --queue`: fills every Jobs-tab row whose
rem status is "apply", one Chrome tab per job, then marks each row. Nothing
rem is ever submitted - review each tab and click Submit yourself.
rem Assumes the repo is at ~/claude-apply in the default WSL distro; edit the
rem path below if yours differs. `bash -lic` loads ~/.bashrc so nvm's node is
rem on PATH.
title capply --queue
wsl.exe -- bash -lic "cd ~/claude-apply && node src/apply/index.mjs --queue; echo; read -rp 'Press Enter to close this window...'"
