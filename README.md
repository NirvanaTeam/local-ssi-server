# local-ssi-server

VS Code extension that runs a local SSI-capable static server with live reload (for `<!--#include ... -->` partials).

## Commands
- Local SSI Server: Start
- Local SSI Server: Stop

## Settings

```json
{
  "localSsiServer.entry": "index.html",
  "localSsiServer.openIn": "vscode",
  "localSsiServer.host": "127.0.0.1",
  "localSsiServer.liveReload": true,
  "localSsiServer.liveReloadDelay": 150
}
```

## Dev

```bash
npm install
```

In VS Code: press `F5` (Extension Development Host) → run `Local SSI Server: Start`.

## Build VSIX (optional)

```bash
npm i -g @vscode/vsce
vsce package
```

## License
MIT

## Contact
WEBSITE: https://nirvanarise.ir  
GITHUB: https://github.com/NirvanaTeam  
TG: https://t.me/AshenRomance  
X: https://x.com/JameeSetiz  
EMAIL: nirvanarise.co@gmail.com
