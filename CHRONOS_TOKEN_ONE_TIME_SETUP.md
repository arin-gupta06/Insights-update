# ChronOS One-Time Token Setup (Windows)

## Goal
Set your GitHub token once, store it in a local env file, and refresh/download from the HTML page without pasting token each time.

## Files
- `chronos-token-setup.ps1`: saves token to local `.env` file (easy mode) or encrypted DPAPI file (optional)
- `chronos-proxy-server.ps1`: local proxy that injects token into GitHub API requests
- `chronos-proxy-start.bat`: quick launcher for proxy

## One-time setup
1. Open PowerShell in this folder.
2. Run:
   `powershell -ExecutionPolicy Bypass -File .\chronos-token-setup.ps1 -CreateStartupShortcut`
3. Paste your GitHub token when prompted.
4. Confirm message says token was saved to `.env`.

## Optional DPAPI mode (encrypted token file)
Use this if you prefer encrypted storage instead of env file:
`powershell -ExecutionPolicy Bypass -File .\chronos-token-setup.ps1 -UseDpapi -CreateStartupShortcut`

## Start proxy now
1. Run:
   `powershell -ExecutionPolicy Bypass -File .\chronos-proxy-server.ps1`
2. Keep this terminal open.

## Use HTML page
1. Open the report HTML.
2. Leave token field empty.
3. Click Refresh Insights.
4. If local proxy is running, page will show local secure proxy mode and refresh as usual.

## Optional auto-start
If you used `-CreateStartupShortcut`, proxy starts at Windows login. Then no manual start is needed.

## Security notes
- Easy mode env file path: `.env` in this folder (`GITHUB_TOKEN=...`)
- DPAPI mode file path: `%USERPROFILE%\.chronos\github_token.dpapi`
- Setup script tightens local file ACL for your Windows user where possible.
- Do not share token, `.env`, or encrypted file.
