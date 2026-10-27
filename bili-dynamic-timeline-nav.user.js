// ==UserScript==
// @name         B站动态时间线导航
// @namespace    https://github.com/Fedyya0720/bili-dynamic-timeline-nav
// @homepageURL  https://github.com/Fedyya0720/bili-dynamic-timeline-nav
// @supportURL   https://github.com/Fedyya0720/bili-dynamic-timeline-nav/issues
// @downloadURL  https://raw.githubusercontent.com/Fedyya0720/bili-dynamic-timeline-nav/main/bili-dynamic-timeline-nav.user.js
// @updateURL    https://raw.githubusercontent.com/Fedyya0720/bili-dynamic-timeline-nav/main/bili-dynamic-timeline-nav.user.js
// @version      1.0
// @description  通过B站API全量/增量抓取UP主动态，IndexedDB本地缓存，支持详情页连续翻阅、点击跳转、停止与自动重试
// @author       https://github.com/Fedyya0720
// @match        https://space.bilibili.com/*
// @match        https://t.bilibili.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
    'use strict';

    // ---------- 0. 环境与UID识别 ----------
    const isSpace = window.location.hostname === 'space.bilibili.com';
    const spaceMatch = window.location.pathname.match(/^\/(\d+)/);
    const detailMatch = window.location.pathname.match(/^\/(\d+)/);

    let hostMid = null;
    let currentDynamicId = null;

    if (isSpace && spaceMatch) {
        hostMid = spaceMatch[1];
        GM_setValue('last_bili_host_mid', hostMid);
    } else if (!isSpace && detailMatch) {
        currentDynamicId = detailMatch[1];
        hostMid = GM_getValue('last_bili_host_mid', null);
    }

    if (!hostMid) {
        console.warn('[B站导航] 未找到UID，请先在空间页运行。');
        return;
    }

    // ---------- 1. 文本提取核心逻辑 ----------
    function extractDynamicText(item) {
        const dynamic = item.modules?.module_dynamic;
        if (!dynamic) return '（无内容）';

        // 1. 优先取纯文字
        if (dynamic.desc?.text && dynamic.desc.text.trim()) {
            return dynamic.desc.text.replace(/\n/g, ' ').slice(0, 80);
        }

        // 2. 解析附加内容 (major)
        const major = dynamic.major;
        if (major) {
            if (major.type === 'MAJOR_TYPE_ARCHIVE' && major.archive?.title) {
                return `【视频】${major.archive.title}`;
            }
            if (major.type === 'MAJOR_TYPE_ARTICLE' && major.article?.title) {
                return `【专栏】${major.article.title}`;
            }
            if (major.type === 'MAJOR_TYPE_DRAW' && major.draw?.items?.length) {
                return `【图文】${major.draw.items.length}张图片`;
            }
            if (major.type === 'MAJOR_TYPE_LIVE_RCMD' && major.live_rcmd?.content) {
                return '【直播推荐】';
            }
            if (major.type === 'MAJOR_TYPE_PGC' && major.pgc?.title) {
                return `【番剧】${major.pgc.title}`;
            }
            // 新版图文 Opus
            if (major.opus) {
                if (major.opus.title) return `【图文】${major.opus.title}`;
                if (major.opus.summary?.text) {
                    return major.opus.summary.text.replace(/\n/g, ' ').slice(0, 80);
                }
            }
        }

        // 3. 转发动态兜底
        if (item.type === 'DYNAMIC_TYPE_FORWARD') {
            return '【转发动态】';
        }

        return '（无文字内容）';
    }

    // ---------- 2. IndexedDB 封装 ----------
    const DB_NAME = 'BiliDynamicCache';
    const DB_VERSION = 1;
    let db = null;

    function openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('dynamics')) {
                    const store = db.createObjectStore('dynamics', { keyPath: 'dynamic_id' });
                    store.createIndex('host_mid', 'host_mid', { unique: false });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }
            };
            req.onsuccess = (e) => { db = e.target.result; resolve(db); };
            req.onerror = () => reject(req.error);
        });
    }

    function getCachedList(host_mid) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction('dynamics', 'readonly');
            const store = tx.objectStore('dynamics');
            const index = store.index('host_mid');
            const req = index.getAll(IDBKeyRange.only(host_mid));
            req.onsuccess = () => resolve(req.result.sort((a, b) => a.timestamp - b.timestamp));
            req.onerror = () => reject(req.error);
        });
    }

    function putDynamics(host_mid, items) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction('dynamics', 'readwrite');
            const store = tx.objectStore('dynamics');
            items.forEach(item => {
                const ts = item.modules?.module_author?.pub_ts || 0;
                store.put({
                    dynamic_id: item.id_str,
                    host_mid: host_mid,
                    timestamp: ts,
                    text: extractDynamicText(item), // 使用新的提取逻辑
                    created_at: new Date(ts * 1000).toISOString().slice(0, 10)
                });
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    function hasDynamic(dynamic_id) {
        return new Promise((resolve) => {
            const tx = db.transaction('dynamics', 'readonly');
            const req = tx.objectStore('dynamics').getKey(dynamic_id);
            req.onsuccess = () => resolve(req.result !== undefined);
            req.onerror = () => resolve(false);
        });
    }

    // 清空当前 UP 主的缓存
    function clearCache(host_mid) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction('dynamics', 'readwrite');
            const store = tx.objectStore('dynamics');
            const index = store.index('host_mid');
            const req = index.openCursor(IDBKeyRange.only(host_mid));
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                }
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    // ---------- 3. API 请求与抓取 ----------
    async function fetchDynamicPage(host_mid, offset) {
        const params = new URLSearchParams({ host_mid: host_mid, timezone_offset: '-480' });
        if (offset) params.set('offset', offset);
        const url = `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?${params.toString()}`;
        const res = await fetch(url, { credentials: 'include' });
        const json = await res.json();
        if (json.code !== 0) throw new Error(`API ${json.code}: ${json.message || '未知错误'}`);
        return json.data;
    }

    let crawlAbort = false;
    let isCrawling = false;

    async function crawlAll(host_mid, incremental, onProgress) {
        let offset = '';
        let totalFetched = 0;
        let stop = false;
        let retryCount = 0;
        const MAX_RETRIES = 3;

        while (!stop && !crawlAbort) {
            let data = null;
            try {
                data = await fetchDynamicPage(host_mid, offset);
                retryCount = 0;
            } catch (err) {
                if (retryCount < MAX_RETRIES) {
                    retryCount++;
                    onProgress(totalFetched, true, `网络波动，${retryCount}秒后重试...`);
                    await new Promise(r => setTimeout(r, retryCount * 1000));
                    continue;
                } else {
                    throw new Error(`重试失败，可能被B站临时风控限制。`);
                }
            }

            const items = data.items || [];
            if (items.length === 0) break;

            if (incremental) {
                const newItems = [];
                for (const item of items) {
                    if (await hasDynamic(item.id_str)) {
                        stop = true;
                        break;
                    }
                    newItems.push(item);
                }
                if (newItems.length > 0) {
                    await putDynamics(host_mid, newItems);
                    totalFetched += newItems.length;
                }
            } else {
                await putDynamics(host_mid, items);
                totalFetched += items.length;
            }

            onProgress(totalFetched, data.has_more);
            offset = data.offset;
            if (!data.has_more || !offset) break;
            await new Promise(r => setTimeout(r, 1200 + Math.random() * 500));
        }
        return totalFetched;
    }

    // ---------- 4. 样式 ----------
    const style = document.createElement('style');
    style.textContent = `
    #bili-dyn-ball { position: fixed; right: 18px; bottom: 18px; width: 44px; height: 44px; border-radius: 50%; background: linear-gradient(140deg, #00a1d6, #0084b4); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 18px; cursor: pointer; z-index: 999999; box-shadow: 0 3px 12px rgba(0,161,214,.45); transition: transform .2s; font-family: sans-serif; }
    #bili-dyn-ball:hover { transform: scale(1.08); }
    #bili-dyn-panel { position: fixed; right: 18px; bottom: 72px; width: 300px; background: rgba(24,24,27,.97); backdrop-filter: blur(16px); border: 1px solid #323238; border-radius: 14px; padding: 14px; display: none; flex-direction: column; gap: 8px; max-height: calc(100vh - 90px); z-index: 999999; color: #e8e8ea; font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 12px; color-scheme: dark; }
    #bili-dyn-panel.is-space { height: 540px; }
    #bili-dyn-panel.is-detail { height: 480px; }
    #bili-dyn-panel .header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 8px; border-bottom: 1px solid #2e2e34; font-weight: 600; }
    #bili-dyn-panel .close { cursor: pointer; color: #888; }
    #bili-dyn-panel .status { min-height: 16px; color: #85858d; font-size: 11px; word-break: break-all; }
    #bili-dyn-panel .btn-row { display: flex; gap: 6px; }
    #bili-dyn-panel button { flex: 1; padding: 7px; border-radius: 6px; border: 1px solid #38383f; background: #2a2a2f; color: #d2d2d8; cursor: pointer; font-size: 12px; transition: background .15s; }
    #bili-dyn-panel button:hover:not(:disabled) { background: #34343b; color: #fff; }
    #bili-dyn-panel button:disabled { opacity: .4; cursor: not-allowed; }
    #bili-dyn-panel .primary { background: #00a1d6; border-color: #00a1d6; color: #fff; font-weight: 600; }
    #bili-dyn-panel .primary:hover:not(:disabled) { background: #00b5e5; }
    
    /* 清空和停止按钮的特定样式 */
    #bili-dyn-panel .danger { color: #ff8a8a; border-color: #5a2b2b; background: #2a1c1c; }
    #bili-dyn-panel .danger:hover:not(:disabled) { background: #3f2222; color: #ffa8a8; }
    #bili-dyn-panel .warn { color: #ffb055; background: #38291a; border-color: #7a5322; }

    #bili-dyn-list-wrap { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    #bili-dyn-list { flex: 1; overflow-y: auto; background: #202024; border-radius: 8px; font-size: 11px; line-height: 1.45; }
    #bili-dyn-list::-webkit-scrollbar { width: 6px; }
    #bili-dyn-list::-webkit-scrollbar-thumb { background: #3b3b43; border-radius: 3px; }
    .bili-dyn-item { display: flex; gap: 6px; padding: 6px 8px; border-bottom: 1px solid #282830; cursor: pointer; }
    .bili-dyn-item:hover { background: #2a2a30; }
    .bili-dyn-item.active { background: #2a3a44; border-left: 3px solid #00a1d6; }
    .bili-dyn-item .time { color: #00a1d6; font-weight: 600; white-space: nowrap; font-size: 10px; }
    .bili-dyn-item .text { color: #a5a5ad; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    #bili-dyn-nav { display: flex; gap: 6px; margin-top: 4px; }
    #bili-dyn-info { text-align: center; font-size: 10px; color: #6a6a72; margin-top: 4px; }
    `;
    document.head.appendChild(style);

    // ---------- 5. UI ----------
    const ball = document.createElement('div');
    ball.id = 'bili-dyn-ball';
    ball.textContent = '📅';
    ball.title = 'B站动态时间线导航';

    const panel = document.createElement('div');
    panel.id = 'bili-dyn-panel';
    panel.className = isSpace ? 'is-space' : 'is-detail';
    panel.innerHTML = `
        <div class="header"><span>📅 动态时间线导航</span><span class="close" id="bili-dyn-close">✕</span></div>
        <div class="status" id="bili-dyn-status">正在检查数据…</div>
        
        <!-- 抓取按钮组 -->
        <div class="btn-row" id="bili-dyn-crawl-btns">
            <button id="bili-dyn-full" class="primary">全量抓取</button>
            <button id="bili-dyn-incr">增量更新</button>
            <button id="bili-dyn-clear" class="danger" title="清空当前UP主的缓存数据">清空缓存</button>
            <button id="bili-dyn-stop" class="warn" style="display:none;">⏸ 停止</button>
        </div>

        <div id="bili-dyn-list-wrap">
            <div style="display:flex; justify-content:space-between; font-size:10px; color:#85858d; margin-bottom:4px;">
                <span id="bili-dyn-count">0 条</span><span>点击跳转</span>
            </div>
            <div id="bili-dyn-list"></div>
        </div>
        <div id="bili-dyn-nav">
            <button id="bili-dyn-prev" disabled>◀ 上一条</button>
            <button id="bili-dyn-next" disabled>下一条 ▶</button>
        </div>
        <div id="bili-dyn-info"></div>
    `;
    document.body.appendChild(ball);
    document.body.appendChild(panel);

    const statusEl = panel.querySelector('#bili-dyn-status');
    const listEl = panel.querySelector('#bili-dyn-list');
    const countEl = panel.querySelector('#bili-dyn-count');
    const infoEl = panel.querySelector('#bili-dyn-info');
    const btnFull = panel.querySelector('#bili-dyn-full');
    const btnIncr = panel.querySelector('#bili-dyn-incr');
    const btnClear = panel.querySelector('#bili-dyn-clear');
    const btnStop = panel.querySelector('#bili-dyn-stop');
    const prevBtn = panel.querySelector('#bili-dyn-prev');
    const nextBtn = panel.querySelector('#bili-dyn-next');
    const crawlBtns = panel.querySelector('#bili-dyn-crawl-btns');

    let currentList = [];
    let currentIndex = -1;

    if (!isSpace) crawlBtns.style.display = 'none';

    // ---------- 6. 渲染列表 ----------
    function renderList() {
        countEl.textContent = `${currentList.length} 条`;
        listEl.innerHTML = '';
        const frag = document.createDocumentFragment();
        currentList.forEach((item, idx) => {
            const div = document.createElement('div');
            div.className = 'bili-dyn-item' + (idx === currentIndex ? ' active' : '');
            div.dataset.index = idx;
            const timeSpan = document.createElement('span');
            timeSpan.className = 'time';
            timeSpan.textContent = item.created_at;
            const textSpan = document.createElement('span');
            textSpan.className = 'text';
            textSpan.textContent = item.text || '（无文字内容）';
            div.append(timeSpan, textSpan);
            div.addEventListener('click', () => navigateTo(idx));
            frag.appendChild(div);
        });
        listEl.appendChild(frag);
        updateNav();
    }

    function updateNav() {
        prevBtn.disabled = currentIndex <= 0;
        nextBtn.disabled = currentList.length === 0 || currentIndex >= currentList.length - 1;
        if (currentList.length > 0 && currentIndex >= 0) {
            infoEl.textContent = `第 ${currentIndex + 1} / ${currentList.length} 条  ·  ${currentList[currentIndex].created_at}`;
            const activeEl = listEl.querySelector(`.bili-dyn-item[data-index="${currentIndex}"]`);
            if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
        } else if (currentList.length > 0) {
            infoEl.textContent = `共 ${currentList.length} 条`;
        } else {
            infoEl.textContent = '';
        }
    }

    function navigateTo(index) {
        if (index < 0 || index >= currentList.length) return;
        GM_setValue('bili_nav_session', { hostMid: hostMid, list: currentList, index: index });
        window.location.href = `https://t.bilibili.com/${currentList[index].dynamic_id}`;
    }

    prevBtn.addEventListener('click', () => { if (currentIndex > 0) navigateTo(currentIndex - 1); });
    nextBtn.addEventListener('click', () => { if (currentIndex < currentList.length - 1) navigateTo(currentIndex + 1); });

    // ---------- 7. 数据加载逻辑 ----------
    async function initData() {
        if (isSpace) {
            try {
                const list = await getCachedList(hostMid);
                currentList = list;
                currentIndex = -1;
                renderList();
                statusEl.textContent = list.length > 0 ? `已从缓存加载 ${list.length} 条` : '无缓存，请点击“全量抓取”';
            } catch (e) {
                statusEl.textContent = '读取缓存失败: ' + e.message;
            }
        } else {
            const session = GM_getValue('bili_nav_session', null);
            if (session && session.hostMid === hostMid) {
                currentList = session.list;
                currentIndex = currentList.findIndex(item => item.dynamic_id === currentDynamicId);
                renderList();
                statusEl.textContent = `已恢复导航上下文`;
                panel.style.display = 'flex';
                ball.textContent = '✕';
            } else {
                currentList = [];
                statusEl.textContent = '无导航上下文，请回到空间页重新开始';
                renderList();
            }
        }
    }

    // ---------- 8. 抓取与控制逻辑 ----------
    function toggleButtons(crawling) {
        btnFull.style.display = crawling ? 'none' : 'block';
        btnIncr.style.display = crawling ? 'none' : 'block';
        btnClear.style.display = crawling ? 'none' : 'block';
        btnStop.style.display = crawling ? 'block' : 'none';
        
        btnFull.disabled = crawling;
        btnIncr.disabled = crawling;
        btnClear.disabled = crawling;
    }

    async function doCrawl(incremental) {
        if (isCrawling || !isSpace) return;
        isCrawling = true;
        crawlAbort = false;
        toggleButtons(true);
        statusEl.textContent = incremental ? '增量更新中…' : '全量抓取中…';

        try {
            const fetched = await crawlAll(hostMid, incremental, (total, hasMore, msg) => {
                if (msg) statusEl.textContent = msg;
                else statusEl.textContent = `${incremental ? '增量' : '全量'}抓取: 已获取 ${total} 条${hasMore ? '…' : ' (完成)'}`;
            });
            statusEl.textContent = `抓取完成，本次获取 ${fetched} 条`;
            await initData();
        } catch (e) {
            statusEl.textContent = '抓取出错: ' + e.message;
        } finally {
            isCrawling = false;
            toggleButtons(false);
        }
    }

    btnFull.addEventListener('click', () => doCrawl(false));
    btnIncr.addEventListener('click', () => doCrawl(true));
    btnStop.addEventListener('click', () => {
        crawlAbort = true;
        statusEl.textContent = '正在停止…';
    });

    // 清空缓存事件
    btnClear.addEventListener('click', async () => {
        if (isCrawling) return;
        const confirmed = confirm("⚠️ 警告：确定要清空当前UP主的所有本地缓存吗？\n\n此操作不可逆，下次需要重新进行全量抓取。");
        if (!confirmed) return;

        try {
            statusEl.textContent = '正在清空缓存…';
            await clearCache(hostMid);
            GM_setValue('bili_nav_session', null); // 顺便清空可能存在的跨域会话
            currentList = [];
            currentIndex = -1;
            renderList();
            statusEl.textContent = '缓存已清空。';
        } catch (e) {
            statusEl.textContent = '清空失败: ' + e.message;
        }
    });

    // ---------- 9. 初始化与交互 ----------
    ball.addEventListener('click', () => {
        const hidden = panel.style.display !== 'flex';
        panel.style.display = hidden ? 'flex' : 'none';
        ball.textContent = hidden ? '✕' : '📅';
    });
    panel.querySelector('#bili-dyn-close').addEventListener('click', () => {
        panel.style.display = 'none';
        ball.textContent = '📅';
    });

    (async () => {
        if (isSpace) {
            try {
                await openDB();
            } catch (e) {
                statusEl.textContent = 'IndexedDB 初始化失败';
                return;
            }
        }
        await initData();
    })();

})();
