// ==UserScript==
// @name         B站动态时间线导航
// @namespace    https://github.com/Fedyya0720/bili-dynamic-timeline-nav
// @homepageURL  https://github.com/Fedyya0720/bili-dynamic-timeline-nav
// @supportURL   https://github.com/Fedyya0720/bili-dynamic-timeline-nav/issues
// @downloadURL  https://raw.githubusercontent.com/Fedyya0720/bili-dynamic-timeline-nav/main/bili-dynamic-timeline-nav.user.js
// @updateURL    https://raw.githubusercontent.com/Fedyya0720/bili-dynamic-timeline-nav/main/bili-dynamic-timeline-nav.user.js
// @version      1.1
// @description  通过B站API全量/增量抓取UP主动态，IndexedDB本地缓存，支持详情页连续翻阅、点击跳转、停止与自动重试
// @author       https://github.com/Fedyya0720
// @match        https://space.bilibili.com/*
// @match        https://t.bilibili.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
    'use strict';

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

    if (!hostMid) return;

    // ---------- 1. 文本提取 ----------
    function extractDynamicText(item) {
        const dynamic = item.modules?.module_dynamic;
        if (!dynamic) return '（无内容）';

        if (dynamic.desc?.text && dynamic.desc.text.trim()) {
            return dynamic.desc.text.replace(/\n/g, ' ').slice(0, 80);
        }

        const major = dynamic.major;
        if (major) {
            if (major.type === 'MAJOR_TYPE_ARCHIVE' && major.archive?.title) return `【视频】${major.archive.title}`;
            if (major.type === 'MAJOR_TYPE_ARTICLE' && major.article?.title) return `【专栏】${major.article.title}`;
            if (major.type === 'MAJOR_TYPE_DRAW' && major.draw?.items?.length) return `【图文】${major.draw.items.length}张图片`;
            if (major.opus) {
                if (major.opus.title) return `【图文】${major.opus.title}`;
                if (major.opus.summary?.text) return major.opus.summary.text.replace(/\n/g, ' ').slice(0, 80);
            }
        }
        if (item.type === 'DYNAMIC_TYPE_FORWARD') return '【转发动态】';
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
                    text: extractDynamicText(item),
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

    function clearCache(host_mid) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction('dynamics', 'readwrite');
            const store = tx.objectStore('dynamics');
            const index = store.index('host_mid');
            const req = index.openCursor(IDBKeyRange.only(host_mid));
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) { cursor.delete(); cursor.continue(); }
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    // ---------- 3. 状态记录与API ----------
    // 使用 GM_setValue 记录每个 UP 主的抓取进度（因为 IndexedDB 跨域不方便，且这是简单的键值对）
    function getProgress(host_mid) {
        return GM_getValue(`bili_progress_${host_mid}`, { offset: '', is_completed: false, count: 0 });
    }
    
    function saveProgress(host_mid, progress) {
        GM_setValue(`bili_progress_${host_mid}`, progress);
    }

    async function fetchDynamicPage(host_mid, offset) {
        const params = new URLSearchParams({ 
            host_mid: host_mid, 
            timezone_offset: '-480',
            platform: 'web',
            features: 'itemOpusStyle'
        });
        if (offset) params.set('offset', offset);
        
        const url = `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?${params.toString()}`;
        const res = await fetch(url, { credentials: 'include' });
        
        if (res.status === 412) throw new Error('触发了 HTTP 412 风控');
        
        const json = await res.json();
        if (json.code !== 0) throw new Error(`API ${json.code}: ${json.message || '未知错误'}`);
        return json.data;
    }

    let crawlAbort = false;
    let isCrawling = false;

    // 核心抓取：分为 'history' (历史全量) 和 'update' (抓取最新)
    async function crawlAll(host_mid, mode, onProgress) {
        let progress = getProgress(host_mid);
        let offset = '';
        
        if (mode === 'history') {
            if (progress.is_completed) {
                // 如果已经抓完了，说明用户想重新抓
                offset = '';
                progress = { offset: '', is_completed: false, count: 0 };
                saveProgress(host_mid, progress);
            } else {
                offset = progress.offset;
                if (offset) onProgress(0, true, `从断点处继续抓取...`);
            }
        }

        let totalFetchedThisRun = 0;
        let retryCount = 0;
        let emptyPageCount = 0;
        const MAX_RETRIES = 3;

        while (!crawlAbort) {
            let data = null;
            try {
                data = await fetchDynamicPage(host_mid, offset);
                retryCount = 0; 
            } catch (err) {
                if (retryCount < MAX_RETRIES) {
                    retryCount++;
                    onProgress(totalFetchedThisRun, true, `网络波动/风控，${retryCount}秒后重试...`);
                    await new Promise(r => setTimeout(r, retryCount * 2000));
                    continue;
                } else {
                    throw new Error(`重试失败: ${err.message}`);
                }
            }

            const items = data.items || [];
            const hasMore = data.has_more;
            const nextOffset = data.offset;

            if (items.length === 0) {
                emptyPageCount++;
                if (hasMore && nextOffset && emptyPageCount < 5) {
                    offset = nextOffset;
                    await new Promise(r => setTimeout(r, 3000));
                    continue;
                } else {
                    if (mode === 'history') {
                        progress.is_completed = true;
                        saveProgress(host_mid, progress);
                    }
                    break;
                }
            } else {
                emptyPageCount = 0;
            }

            if (mode === 'history') {
                // 【全量/续传】：不管存没存过，直接覆盖存
                await putDynamics(host_mid, items);
                totalFetchedThisRun += items.length;
                
                // 更新进度
                progress.offset = nextOffset;
                progress.count = (progress.count || 0) + items.length;
                if (!hasMore) progress.is_completed = true;
                saveProgress(host_mid, progress);
                
            } else {
                // 【抓取最新】：遇到缓存存在就停
                let newItems = [];
                let stop = false;
                for (const item of items) {
                    if (await hasDynamic(item.id_str)) {
                        stop = true;
                        break;
                    }
                    newItems.push(item);
                }
                if (newItems.length > 0) {
                    await putDynamics(host_mid, newItems);
                    totalFetchedThisRun += newItems.length;
                }
                if (stop) break; // 接轨了，停止
            }

            const lastItem = items[items.length - 1];
            const lastYear = lastItem.modules?.module_author?.pub_ts 
                ? new Date(lastItem.modules.module_author.pub_ts * 1000).getFullYear() 
                : '未知';

            onProgress(totalFetchedThisRun, hasMore, mode === 'history' 
                ? `已抓 ${totalFetchedThisRun} 条 (翻至 ${lastYear} 年)` 
                : `更新了 ${totalFetchedThisRun} 条`);

            if (!hasMore || !nextOffset) {
                if (mode === 'history') {
                    progress.is_completed = true;
                    saveProgress(host_mid, progress);
                }
                break;
            }

            offset = nextOffset;

            // 动态调整请求间隔
            const delay = totalFetchedThisRun > 500 ? 2500 + Math.random() * 1000 : 1500 + Math.random() * 500;
            await new Promise(r => setTimeout(r, delay));
        }
        return totalFetchedThisRun;
    }

    // ---------- 4. 样式与 UI ----------
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

    const ball = document.createElement('div');
    ball.id = 'bili-dyn-ball';
    ball.textContent = '📅';

    const panel = document.createElement('div');
    panel.id = 'bili-dyn-panel';
    panel.className = isSpace ? 'is-space' : 'is-detail';
    panel.innerHTML = `
        <div class="header"><span>📅 动态时间线导航</span><span class="close" id="bili-dyn-close">✕</span></div>
        <div class="status" id="bili-dyn-status">正在检查数据…</div>
        <div class="btn-row" id="bili-dyn-crawl-btns">
            <button id="bili-dyn-full" class="primary">继续全量</button>
            <button id="bili-dyn-incr">抓取最新</button>
            <button id="bili-dyn-clear" class="danger" title="清空当前UP主的缓存数据">清空</button>
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

    async function initData() {
        if (isSpace) {
            try {
                const list = await getCachedList(hostMid);
                currentList = list;
                currentIndex = -1;
                renderList();
                
                const progress = getProgress(hostMid);
                if (list.length > 0) {
                    if (progress.is_completed) {
                        statusEl.textContent = `已抓完所有 (${list.length} 条)`;
                        btnFull.textContent = '重新全量';
                    } else {
                        statusEl.textContent = `已加载 ${list.length} 条 (未完成)`;
                        btnFull.textContent = '继续全量';
                    }
                } else {
                    statusEl.textContent = '无缓存，请点击抓取';
                    btnFull.textContent = '全量抓取';
                }
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

    function toggleButtons(crawling) {
        btnFull.style.display = crawling ? 'none' : 'block';
        btnIncr.style.display = crawling ? 'none' : 'block';
        btnClear.style.display = crawling ? 'none' : 'block';
        btnStop.style.display = crawling ? 'block' : 'none';
        btnFull.disabled = crawling;
        btnIncr.disabled = crawling;
        btnClear.disabled = crawling;
    }

    async function doCrawl(mode) {
        if (isCrawling || !isSpace) return;
        isCrawling = true;
        crawlAbort = false;
        toggleButtons(true);
        statusEl.textContent = mode === 'history' ? '获取历史数据中…' : '更新最新数据中…';

        try {
            const fetched = await crawlAll(hostMid, mode, (total, hasMore, msg) => {
                if (msg) statusEl.textContent = msg;
                else statusEl.textContent = mode === 'history' ? `历史抓取: ${total} 条…` : `最新更新: ${total} 条…`;
            });
            statusEl.textContent = `操作完成，本次获取 ${fetched} 条`;
            await initData();
        } catch (e) {
            statusEl.textContent = '出错: ' + e.message + '（进度已保存）';
        } finally {
            isCrawling = false;
            toggleButtons(false);
        }
    }

    btnFull.addEventListener('click', () => doCrawl('history'));
    btnIncr.addEventListener('click', () => doCrawl('update'));
    btnStop.addEventListener('click', () => { crawlAbort = true; statusEl.textContent = '正在停止（进度已保存）…'; });

    btnClear.addEventListener('click', async () => {
        if (isCrawling) return;
        if (!confirm("⚠️ 警告：确定要清空当前UP主的所有本地缓存和抓取进度吗？\n\n此操作不可逆。")) return;
        try {
            statusEl.textContent = '正在清空…';
            await clearCache(hostMid);
            GM_setValue(`bili_progress_${hostMid}`, { offset: '', is_completed: false, count: 0 });
            GM_setValue('bili_nav_session', null);
            currentList = [];
            currentIndex = -1;
            renderList();
            btnFull.textContent = '全量抓取';
            statusEl.textContent = '缓存已清空。';
        } catch (e) {
            statusEl.textContent = '清空失败: ' + e.message;
        }
    });

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
