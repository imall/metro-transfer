# 捷運接駁班次

依裝置時間（或預計搭乘時間），從臺北捷運各站 PDF 時刻表推算起站到目的地（含轉乘）最近可搭的班次。

網頁：https://imall.dev/metro-transfer/

- 範圍：紅、綠、橘、藍線。不含文湖線、環狀線、新北投與小碧潭支線。
- 時刻表改版時：`python -I scripts/fetch_timetables.py --refresh`（需 `pypdf`），再 commit `data/timetables.js`，並把 `index.html` 的 `?v=` 與 `sw.js` 的 `CACHE` 版本一起加一（避開 Cloudflare 與 PWA 快取）。
- 測試：`node scripts/test_router.mjs`

資料來源：[臺北捷運各站時刻表](https://web.metro.taipei/)，表定時間僅供參考。
