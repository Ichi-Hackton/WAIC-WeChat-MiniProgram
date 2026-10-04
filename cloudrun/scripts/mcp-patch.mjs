// 12306-mcp 站名表快取補丁（冪等應用器）
//
// 背景：12306-mcp 於模組載入時（build/index.js 頂層 await getStations()）拉取官網
//       站名 JS；官網間歇性風控會返回攔截頁/空內容，解析得到「空站名表」卻不報錯，
//       導致服務存活但所有站名解析為 null —— 查詢永久報
//       「Error: Station not found. FromStationResult: null, ToStationResult: null」。
//
// 策略：補丁 getStations() —— 拉取成功且站數合理（≥500）→ 寫入本地快取
//       station-cache.json；拉取失敗或站數異常 → 回退快取；無快取 → 維持原始
//       拋錯（由 mcp-start.ps1 的探活重啟機制兜底）。
//       站名表為準靜態數據（全國站名幾乎不變），快取無過期風險；
//       查詢路徑（CLeftTicketUrl）會輪換、有過期風險，故不做快取。
//
// 用法：node cloudrun/scripts/mcp-patch.mjs
//   （冪等：已含補丁標記則跳過；源碼版本變更導致定位失敗時僅警告）
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// 腳本位於 <repo>/cloudrun/scripts/ → 倉庫根為上上級；.mcp/ 不入庫故路徑由腳本推導
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const target = join(repoRoot, '.mcp', '12306', 'node_modules', '12306-mcp', 'build', 'index.js');

const MARK = 'PATCH-STATION-CACHE';

// 與 12306-mcp@0.3.10 build/index.js 的 getStations 原文逐字一致（定位用）
const ORIGINAL = `async function getStations() {
    const html = await make12306Request(WEB_URL);
    if (html == null) {
        throw new Error('Error: get 12306 web page failed.');
    }
    const match = html.match('.(/script/core/common/station_name.+?.js)');
    if (match == null) {
        throw new Error('Error: get station name js file failed.');
    }
    const stationNameJSFilePath = match[0];
    const stationNameJS = await make12306Request(new URL(stationNameJSFilePath, WEB_URL));
    if (stationNameJS == null) {
        throw new Error('Error: get station name js file failed.');
    }
    const rawData = stationNameJS.replace('var station_names =\\'', '').replace('\\';', '');
    const stationsData = parseStationsData(rawData);
    // 加上缺失的车站信息
    for (const station of MISSING_STATIONS) {
        if (!stationsData[station.station_code]) {
            stationsData[station.station_code] = station;
        }
    }
    return stationsData;
}`;

const PATCHED = `async function getStations() {
    // ${MARK} BEGIN —— 站名表本地快取回退（穩定性補丁，由 mcp-patch.mjs 注入）
    // 官網風控攔截時站名 JS 拉到空頁，解析為空表卻不報錯，服務存活但站名
    // 解析全為 null。改為：拉取成功且站數合理 → 落盤快取；失敗/異常 → 回退
    // 快取；無快取 → 維持原始拋錯（由啟動腳本探活重啟兜底）。
    const { readFileSync: __read, writeFileSync: __write } = await import('node:fs');
    const __cacheUrl = new URL('./station-cache.json', import.meta.url);
    const __fetchFresh = async () => {
        const html = await make12306Request(WEB_URL);
        if (html == null) {
            throw new Error('Error: get 12306 web page failed.');
        }
        const match = html.match('.(/script/core/common/station_name.+?.js)');
        if (match == null) {
            throw new Error('Error: get station name js file failed.');
        }
        const stationNameJSFilePath = match[0];
        const stationNameJS = await make12306Request(new URL(stationNameJSFilePath, WEB_URL));
        if (stationNameJS == null) {
            throw new Error('Error: get station name js file failed.');
        }
        const rawData = stationNameJS.replace('var station_names =\\'', '').replace('\\';', '');
        const stationsData = parseStationsData(rawData);
        // 加上缺失的车站信息
        for (const station of MISSING_STATIONS) {
            if (!stationsData[station.station_code]) {
                stationsData[station.station_code] = station;
            }
        }
        return stationsData;
    };
    let __fresh = null;
    try {
        __fresh = await __fetchFresh();
        if (Object.keys(__fresh).length < 500) {
            throw new Error('station table suspiciously small: ' + Object.keys(__fresh).length);
        }
    } catch (e) {
        try {
            const __cached = JSON.parse(__read(__cacheUrl, 'utf8'));
            console.error('[patch] 站名表拉取失敗（' + (e && e.message) + '），回退本地快取（' + new Date(__cached.fetchedAt).toISOString() + '，' + Object.keys(__cached.stations).length + ' 站）');
            return __cached.stations;
        } catch (_) {
            throw e;
        }
    }
    try {
        __write(__cacheUrl, JSON.stringify({ fetchedAt: Date.now(), stations: __fresh }));
        console.error('[patch] 站名表拉取成功並已寫入本地快取（' + Object.keys(__fresh).length + ' 站）');
    } catch (_) { /* 快取寫入失敗不影響本次返回 */ }
    return __fresh;
    // ${MARK} END
}`;

let source;
try {
  source = readFileSync(target, 'utf8');
} catch {
  console.error('[patch] 找不到 12306-mcp 入口（' + target + '），請先由 mcp-start.ps1 安裝依賴');
  process.exit(1);
}

if (source.includes(MARK)) {
  console.log('[patch] 補丁已應用，跳過');
  process.exit(0);
}

const idx = source.indexOf(ORIGINAL);
if (idx === -1) {
  console.error('[patch] 警告：12306-mcp 版本變更，getStations 原文定位失敗，未打補丁（原始行為不變）');
  process.exit(2);
}

writeFileSync(target, source.slice(0, idx) + PATCHED + source.slice(idx + ORIGINAL.length), 'utf8');
console.log('[patch] 站名表快取補丁已應用於 ' + target);
