# Aurora Watch Lite

A local stock watchlist with pre-market, regular and after-hours quotes. Nothing to install: it runs on Windows PowerShell, which comes with Windows 10 and 11.

Want a python version? see: https://github.com/dtomyn/AuroraWatch

## Run it

1. Copy this folder anywhere on your computer.
2. Double-click **Start Aurora Watch.bat**.
3. The app opens in your browser. Close the black window to stop it.

Tickers are saved to `watchlist.json` in this folder.

## If something goes wrong

- **Windows SmartScreen warning:** this can appear for files from the internet. Check where the folder came from, then choose **More info**, then **Run anyway**.
- **The window closes or shows a policy error:** a work computer may block PowerShell scripts. Only your IT team can change that.
- **Port in use:** the app tries ports 5000 to 5009 and opens the right address itself.

## Settings

Set `WATCHLIST_FILE` or `PORT` as environment variables to change the config path or first port tried.

Quotes come from Yahoo Finance's public chart endpoint, which is unofficial and may be delayed. For information only.
