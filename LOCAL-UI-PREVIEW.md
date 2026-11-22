# 本機 UI 測試（Windows）

需要 Node.js 22+ 及專案根目錄指定的 pnpm 11。以下在 PowerShell 執行：

```powershell
git clone --branch test/codex-style-conversation-ui https://github.com/dishanhai/Pixel-Starry-Sky-Desktop.git
cd Pixel-Starry-Sky-Desktop
pnpm install --frozen-lockfile
$env:PIXELSKY_USER_DATA = Join-Path $env:TEMP 'pixelsky-conversation-ui-preview'
New-Item -ItemType Directory -Force $env:PIXELSKY_USER_DATA | Out-Null
pnpm dev:demo
```

演示模式會用假資料，不會實際呼叫模型或插件；測試資料與已安裝的正式版分開。打開側欄「對話展示（Codex）」下的「中間的回覆：已結束的兩輪」：

1. 點輸入框的模型控件，換模型並調整推理強度；到設定的「對話」區檢查是否可切回分開的控制。
2. 點輸入框上方的改動條，核對檔案數、增刪數和每個檔案原始補丁；未完成的工具呼叫不算進去。
3. 展開有 `Pixelsky Threads` 的執行摘要，核對插件名、`list_threads`、兩筆 `read_thread`，再點一筆查看原始結果。
4. 用 Tab、Enter 等鍵重複操作，並縮窄視窗檢查不會蓋住輸入框。

側欄測試：在「pixel-web」點「還有 N 個對話」，可往下捲到最後一筆。點專案標題會收起整組，再點一次會回到短清單；「收起」則只從完整清單切回短清單。已封存對話仍由獨立入口開啟。

Dot 側欄測試（需連自己的 Dot）：在 Dot 回覆中送一則補充訊息，找到排隊卡片上「撤回」旁的「引導」。點選後會立即送到同一個 Dot 對話，無須等當前回覆結束；不點則照常排隊。

如要連自己的 Codex 測試，關閉演示視窗，再執行 `pnpm dev`。保持上述獨立資料目錄，並開一個可丟棄的測試工作區，不要把正式工作區用作第一次測試。
