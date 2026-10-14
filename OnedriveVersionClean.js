// ==UserScript==
// @name         Universal OneDrive Cleaner & Nuker (Personal + Business, Full)
// @namespace    http://tampermonkey.net/
// @version      8.7
// @description  Cleans old file versions and empties recycle bin. Adaptive rate control (AIMD) converges near SharePoint's per-user throttle limit.
// @author       Me
// @match        *://*.sharepoint.com/*
// @match        *://onedrive.live.com/*
// @match        *://*.onedrive.com/*
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      my.microsoftpersonalcontent.com
// ==/UserScript==

(function() {
    'use strict';

    // --- CONFIGURATION ---
    const VERSIONS_TO_KEEP = 2;
    const EXTENSIONS_TO_SKIP = [];
    const CONCURRENT_REQUESTS = 2;
    const MAX_RETRIES = 3;
    const PAGE_SIZE = 2000;
    const PROGRESS_LOG_EVERY = 25;

    // 'desc' = newest uploads first (recommended for streaming)
    // 'asc'  = oldest uploads first
    const SCAN_SORT_DIRECTION = 'desc';

    // --- ADAPTIVE RATE CONTROL (AIMD) ---
    // Starts at INITIAL_DELAY. On sustained success, multiplies delay by
    // SPEED_UP_FACTOR every SPEED_UP_EVERY successes (speeds up). On throttle,
    // multiplies delay by SLOW_DOWN_FACTOR (slows down). If PANIC_THRESHOLD
    // throttles happen back-to-back, uses PANIC_FACTOR instead.
    const RATE = {
        MIN_DELAY_MS: 300,           // absolute fastest — 200 req/min ceiling
        MAX_DELAY_MS: 8000,          // slowest — 7.5 req/min floor
        INITIAL_DELAY_MS: 800,       // starting point
        SPEED_UP_EVERY: 15,          // successes before each speed-up
        SPEED_UP_FACTOR: 0.95,       // multiply delay by this to speed up
        SLOW_DOWN_FACTOR: 1.6,       // multiply delay by this on throttle
        PANIC_THRESHOLD: 3,          // consecutive throttles before panic mode
        PANIC_FACTOR: 2.5,           // multiply delay by this in panic mode
        WINDOW_RATE_MS: 60000,       // rate measurement window
        WINDOW_THROTTLE_MS: 300000,  // throttle-count window (5 min)
        REPORT_EVERY_MS: 30000,      // log a rate summary every N ms
    };

    // Live state
    let currentDelay = RATE.INITIAL_DELAY_MS;
    let successStreak = 0;
    let consecutiveThrottles = 0;
    let totalRequests = 0;
    let totalThrottles = 0;
    let requestTimes = [];
    let throttleTimes = [];
    let lastReportTime = 0;
    let sessionStartTime = 0;

    // --- TOAST CONFIGURATION ---
    const TOAST_DURATION_MS = 2800;
    const TOAST_MAX_VISIBLE = 6;
    const TOAST_NAME_MAX = 42;

    // --- Global Variables ---
    let SITE_URL = "";
    let STARTING_FOLDER = "";
    let ACCOUNT_TYPE = "";
    let IS_PERSONAL = false;
    let requestDigest = "";
    let tokenFetchTime = 0;

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // ============================================================
    // --- ADAPTIVE RATE CONTROLLER ---
    // ============================================================
    function currentRate() {
        const cutoff = Date.now() - RATE.WINDOW_RATE_MS;
        requestTimes = requestTimes.filter(t => t > cutoff);
        return requestTimes.length;
    }

    function recentThrottleCount() {
        const cutoff = Date.now() - RATE.WINDOW_THROTTLE_MS;
        throttleTimes = throttleTimes.filter(t => t > cutoff);
        return throttleTimes.length;
    }

    function recordSuccess() {
        successStreak++;
        consecutiveThrottles = 0;
        if (successStreak >= RATE.SPEED_UP_EVERY && currentDelay > RATE.MIN_DELAY_MS) {
            const before = currentDelay;
            currentDelay = Math.max(RATE.MIN_DELAY_MS, currentDelay * RATE.SPEED_UP_FACTOR);
            successStreak = 0;
            if (before - currentDelay >= 5) {
                console.log(`⬆️  Speed up → ${Math.round(currentDelay)}ms (~${(60000 / currentDelay).toFixed(0)} req/min)`);
            }
        }
    }

    function recordThrottle() {
        totalThrottles++;
        throttleTimes.push(Date.now());
        successStreak = 0;
        consecutiveThrottles++;

        const factor = consecutiveThrottles >= RATE.PANIC_THRESHOLD
            ? RATE.PANIC_FACTOR
            : RATE.SLOW_DOWN_FACTOR;

        const before = currentDelay;
        currentDelay = Math.min(RATE.MAX_DELAY_MS, currentDelay * factor);

        if (before !== currentDelay) {
            const mode = consecutiveThrottles >= RATE.PANIC_THRESHOLD ? 'PANIC' : 'throttle';
            console.log(`⬇️  Slow down (${mode} x${consecutiveThrottles}) → ${Math.round(currentDelay)}ms (~${(60000 / currentDelay).toFixed(0)} req/min)`);
        }
    }

    function maybeReport() {
        const now = Date.now();
        if (now - lastReportTime < RATE.REPORT_EVERY_MS) return;
        lastReportTime = now;

        const rate = currentRate();
        const throttle5m = recentThrottleCount();
        const elapsedMin = (now - sessionStartTime) / 60000;

        console.log(
            `📊 Rate: ${rate} req/min | delay: ${Math.round(currentDelay)}ms | ` +
            `throttles (5m): ${throttle5m} | total: ${totalRequests} req / ${totalThrottles} throttled | ` +
            `uptime: ${elapsedMin.toFixed(1)} min`
        );
    }

    function rateSummary() {
        const elapsedMin = (Date.now() - sessionStartTime) / 60000;
        const avgRate = elapsedMin > 0 ? (totalRequests / elapsedMin).toFixed(1) : '0';
        return {
            totalRequests,
            totalThrottles,
            finalDelay: Math.round(currentDelay),
            finalRatePerMin: (60000 / currentDelay).toFixed(0),
            avgRatePerMin: avgRate,
            runtimeMin: elapsedMin.toFixed(1),
        };
    }

    // ============================================================
    // --- DISAPPEARING TOAST / LOG SYSTEM ---
    // ============================================================
    let toastContainer = null;
    let toastSequence = 0;

    function ensureToastStyles() {
        if (document.getElementById('odc-toast-styles')) return;
        const style = document.createElement('style');
        style.id = 'odc-toast-styles';
        style.textContent = `
            #odc-toast-container {
                position: fixed;
                top: 16px;
                right: 16px;
                display: flex;
                flex-direction: column;
                align-items: flex-end;
                gap: 8px;
                z-index: 2147483647;
                pointer-events: none;
                font-family: "Segoe UI", "Helvetica Neue", sans-serif;
            }
            .odc-toast {
                min-width: 220px;
                max-width: 380px;
                padding: 10px 14px;
                border-radius: 8px;
                color: #ffffff;
                font-size: 13px;
                font-weight: 600;
                line-height: 1.35;
                box-shadow: 0 6px 18px rgba(0,0,0,.35);
                background: rgba(32,32,32,.96);
                border-left: 4px solid #0078d4;
                opacity: 0;
                transform: translateX(24px) scale(.96);
                animation: odc-toast-in .28s ease-out forwards;
                word-break: break-word;
                pointer-events: auto;
                cursor: pointer;
                overflow: hidden;
            }
            .odc-toast.odc-hide { animation: odc-toast-out .35s ease-in forwards; }
            .odc-toast.odc-success { border-left-color: #107c10; }
            .odc-toast.odc-error   { border-left-color: #d13438; }
            .odc-toast.odc-info    { border-left-color: #0078d4; }
            .odc-toast.odc-warn    { border-left-color: #ffb900; }
            @keyframes odc-toast-in {
                from { opacity: 0; transform: translateX(24px) scale(.96); }
                to   { opacity: 1; transform: translateX(0) scale(1); }
            }
            @keyframes odc-toast-out {
                from { opacity: 1; transform: translateX(0) scale(1); }
                to   { opacity: 0; transform: translateX(24px) scale(.96); }
            }
        `;
        document.head.appendChild(style);
    }

    function shortenName(name, max = TOAST_NAME_MAX) {
        if (!name) return '(unnamed)';
        const s = String(name);
        return s.length > max ? s.slice(0, max - 1) + '…' : s;
    }

    function showToast(message, type = 'info', duration = TOAST_DURATION_MS) {
        try {
            if (!document.body) return null;
            ensureToastStyles();

            if (!toastContainer || !document.body.contains(toastContainer)) {
                toastContainer = document.createElement('div');
                toastContainer.id = 'odc-toast-container';
                document.body.appendChild(toastContainer);
            }

            while (toastContainer.children.length >= TOAST_MAX_VISIBLE) {
                toastContainer.removeChild(toastContainer.firstElementChild);
            }

            const toast = document.createElement('div');
            toast.className = `odc-toast odc-${type}`;
            toast.textContent = message;
            toast.dataset.seq = String(++toastSequence);
            toastContainer.appendChild(toast);

            let removed = false;
            const remove = () => {
                if (removed) return;
                removed = true;
                toast.classList.add('odc-hide');
                setTimeout(() => toast.remove(), 380);
            };

            const timer = setTimeout(remove, duration);
            toast.addEventListener('click', () => { clearTimeout(timer); remove(); });
            return toast;
        } catch (e) { return null; }
    }

    let sessionStats = { recycled: 0, failed: 0, binDeleted: 0, binFailed: 0, scanned: 0, eligible: 0 };
    function resetSessionStats() {
        sessionStats = { recycled: 0, failed: 0, binDeleted: 0, binFailed: 0, scanned: 0, eligible: 0 };
    }

    // ============================================================
    // --- GLOBAL THROTTLE COOLDOWN (separate from adaptive delay) ---
    // When SharePoint says Retry-After: N, we MUST honor it. This is
    // in addition to the adaptive delay — a hard pause, not a soft one.
    // ============================================================
    let globalCooldownUntil = 0;

    async function waitForCooldown() {
        const now = Date.now();
        if (globalCooldownUntil > now) await sleep(globalCooldownUntil - now);
    }

    function triggerGlobalCooldown(ms) {
        globalCooldownUntil = Math.max(globalCooldownUntil, Date.now() + ms);
        console.warn(`🚦 Hard cooldown: ${Math.round(ms / 1000)}s (Retry-After)`);
        showToast(`🚦 Retry-After ${Math.round(ms / 1000)}s — pausing…`, 'warn', 2500);
    }

    // --- Detect account type ---
    function detectAccountType() {
        const url = window.location.href;
        const hostname = window.location.hostname;
        if (url.includes('/personal/') || (unsafeWindow._spPageContextInfo && unsafeWindow._spPageContextInfo.webServerRelativeUrl?.startsWith('/personal/'))) {
            return 'business';
        }
        if (hostname.includes('sharepoint.com')) return 'business';
        return 'business';
    }

    // --- Auto-detect site URL and starting folder ---
    function detectSiteAndFolder() {
        const origin = window.location.origin;
        const fullUrl = window.location.href;
        let siteUrl = null;
        let startingFolder = null;
        let accountType = detectAccountType();

        IS_PERSONAL = window.location.hostname.includes('live.com') || fullUrl.includes('/personal/');

        console.log(`🔍 Detecting ${accountType} OneDrive account...`);

        const pathMatch = fullUrl.match(/\/personal\/([^\/?&]+)/);
        if (pathMatch) {
            const userPart = pathMatch[1];
            siteUrl = `${origin}/personal/${userPart}`;
            startingFolder = `/personal/${userPart}/Documents`;
            console.log(`✅ Detected site: ${siteUrl}`);
            return { siteUrl, startingFolder, accountType };
        }

        if (unsafeWindow._spPageContextInfo) {
            const webUrl = unsafeWindow._spPageContextInfo.webServerRelativeUrl;
            if (webUrl && webUrl.startsWith('/personal/')) {
                siteUrl = origin + webUrl;
                startingFolder = webUrl + '/Documents';
                console.log(`✅ Detected site from context: ${siteUrl}`);
                return { siteUrl, startingFolder, accountType };
            }
        }

        const userInput = prompt(
            `Could not auto-detect. Please enter:\n` +
            `1. Your OneDrive site URL (e.g., https://your-company.sharepoint.com/personal/username)\n` +
            `2. Or your user ID (the part after /personal/)\n` +
            `Leave blank to cancel:`
        );

        if (userInput && userInput.trim()) {
            const input = userInput.trim();
            if (input.includes('http')) {
                const url = new URL(input);
                const match = url.pathname.match(/\/personal\/([^\/]+)/);
                if (match) {
                    siteUrl = `${url.origin}/personal/${match[1]}`;
                    startingFolder = `/personal/${match[1]}/Documents`;
                }
            } else {
                siteUrl = `${origin}/personal/${input}`;
                startingFolder = `/personal/${input}/Documents`;
            }
            console.log(`✅ Using user-provided: ${siteUrl}`);
            return { siteUrl, startingFolder, accountType };
        }
        throw new Error('Could not detect OneDrive site or user cancelled.');
    }

    // --- Get authentication headers ---
    async function getValidHeaders() {
        const headers = {
            "Accept": "application/json;odata=verbose",
            "Content-Type": "application/json;odata=verbose",
            "X-Requested-With": "XMLHttpRequest"
        };

        if (Date.now() - tokenFetchTime > 20 * 60 * 1000) {
            console.log("🔄 Fetching fresh security token...");
            // Count this toward rate stats too
            requestTimes.push(Date.now());
            totalRequests++;

            const digestResponse = await fetch(`${SITE_URL}/_api/contextinfo`, {
                method: 'POST',
                headers: { 'Accept': 'application/json;odata=nometadata' },
                credentials: 'include'
            });
            const digestData = await digestResponse.json();
            requestDigest = digestData.FormDigestValue;
            tokenFetchTime = Date.now();
        }
        headers['X-RequestDigest'] = requestDigest;
        return headers;
    }

    // --- Generic fetch with adaptive rate control ---
    async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
        try {
            await waitForCooldown();
            await sleep(currentDelay);

            requestTimes.push(Date.now());
            totalRequests++;

            const response = await fetch(url, options);

            // --- Throttle: hard cooldown + adaptive backoff ---
            if (response.status === 429 || response.status === 503) {
                recordThrottle();

                if (retries > 0) {
                    const retryAfter = response.headers.get('Retry-After');
                    const waitTime = retryAfter
                        ? parseInt(retryAfter) * 1000
                        : 3000 * (MAX_RETRIES - retries + 1);

                    triggerGlobalCooldown(waitTime);
                    await sleep(waitTime);
                    return fetchWithRetry(url, options, retries - 1);
                }

                console.error(`❌ Max retries exceeded (throttled) for ${url}`);
                return response;
            }

            // --- Other server errors: short retry, no rate change ---
            if (response.status >= 500) {
                if (retries > 0) {
                    console.warn(`⚠️ Server error (${response.status}), retrying (${retries} left)…`);
                    await sleep(1500);
                    return fetchWithRetry(url, options, retries - 1);
                }
                console.error(`❌ Max retries exceeded (server error) for ${url}`);
                return response;
            }

            // --- Success (2xx/3xx/4xx non-throttle) ---
            recordSuccess();
            maybeReport();
            return response;
        } catch (error) {
            if (retries > 0) {
                console.warn(`⚠️ Network error, retrying (${retries} left)...`);
                await sleep(3000);
                return fetchWithRetry(url, options, retries - 1);
            }
            throw error;
        }
    }

    // --- Parse SharePoint Modified date to sortable timestamp ---
    function parseModifiedDate(raw) {
        if (!raw) return 0;
        const t = Date.parse(raw);
        return isNaN(t) ? 0 : t;
    }

    // --- Get versions for a file ---
    async function getFileVersions(filePath, headers) {
        const encodedPath = encodeURIComponent(filePath).replace(/'/g, "%27");
        let url;

        if (IS_PERSONAL) {
            url = `${SITE_URL}/_api/web/GetFileByServerRelativeUrl('${encodedPath}')/Versions?$select=ID,VersionLabel,IsCurrentVersion,Created`;
        } else {
            url = `${SITE_URL}/_api/web/GetListItemUsingPath(decodedUrl='${encodedPath}')/versions?$select=VersionId,VersionLabel,IsCurrentVersion&$top=5000`;
        }

        const response = await fetchWithRetry(url, { headers, credentials: 'include' });

        if (response.ok) {
            const data = await response.json();
            return data.d ? data.d.results : [];
        } else {
            console.error(`   ❌ Failed to fetch versions for ${filePath} (status ${response.status})`);
            return [];
        }
    }

    // --- Delete a version ---
    async function deleteVersion(filePath, version, headers) {
        const encodedPath = encodeURIComponent(filePath).replace(/'/g, "%27");
        let url, method = 'POST';

        if (IS_PERSONAL) {
            url = `${SITE_URL}/_api/web/GetFileByServerRelativeUrl('${encodedPath}')/Versions/RecycleByLabel('${version.VersionLabel}')`;
        } else {
            url = `${SITE_URL}/_api/web/GetFileByServerRelativePath(decodedUrl='${encodedPath}')/versions/RecycleByLabel(versionLabel='${version.VersionLabel}')`;
        }

        const response = await fetchWithRetry(url, { method, headers, credentials: 'include' });
        return response.ok;
    }

    // --- Clean file versions ---
    async function cleanFileVersions(filePath, fileName, headers) {
        const versions = await getFileVersions(filePath, headers);
        if (versions.length <= VERSIONS_TO_KEEP) return;

        const sortedVersions = versions.sort((a, b) => {
            const dateA = a.Created ? new Date(a.Created) : new Date(0);
            const dateB = b.Created ? new Date(b.Created) : new Date(0);
            return dateA - dateB;
        });

        const nonCurrentVersions = sortedVersions.filter(v => !v.IsCurrentVersion);
        const versionsToDelete = nonCurrentVersions.slice(0, nonCurrentVersions.length - (VERSIONS_TO_KEEP - 1));

        if (versionsToDelete.length === 0) return;

        for (const v of versionsToDelete) {
            const success = await deleteVersion(filePath, v, headers);
            const label = v.VersionLabel || v.ID || '?';
            if (success) {
                sessionStats.recycled++;
                showToast(`🗑️ Recycled v${label} — ${shortenName(fileName)}`, 'success');
            } else {
                sessionStats.failed++;
                showToast(`⚠️ Failed v${label} — ${shortenName(fileName)}`, 'error');
            }
            // No extra sleep — fetchWithRetry's adaptive delay is the only throttle
        }
    }

    // --- Process in batches (no extra sleep, adaptive delay handles pacing) ---
    async function processInBatches(items, batchSize, processFn) {
        for (let i = 0; i < items.length; i += batchSize) {
            const batch = items.slice(i, i + batchSize);
            await Promise.all(batch.map(item => processFn(item)));
        }
    }

    // ============================================================
    // --- STREAMING SCAN + CLEAN ---
    // ============================================================
    async function streamScanAndClean(scanHeaders) {
        const listUrl = `${SITE_URL}/Documents`;
        const baseUrl = `${SITE_URL}/_api/web/GetList(@a1)/RenderListDataAsStream?@a1='${encodeURIComponent(listUrl)}'`;

        const viewXml =
            `<View Scope='Recursive'>` +
                `<ViewFields>` +
                    `<FieldRef Name='FileLeafRef' />` +
                    `<FieldRef Name='FileRef' />` +
                    `<FieldRef Name='Modified' />` +
                    `<FieldRef Name='_UIVersionString' />` +
                    `<FieldRef Name='owshiddenversion' />` +
                `</ViewFields>` +
                `<Query>` +
                    `<OrderBy><FieldRef Name='ID' Ascending='${SCAN_SORT_DIRECTION === 'asc' ? 'TRUE' : 'FALSE'}' /></OrderBy>` +
                `</Query>` +
                `<RowLimit Paged='TRUE'>${PAGE_SIZE}</RowLimit>` +
            `</View>`;

        const requestBody = {
            parameters: {
                "__metadata": { "type": "SP.RenderListDataParameters" },
                "ViewXml": viewXml,
                "FolderServerRelativeUrl": STARTING_FOLDER,
                "RenderOptions": 2,
                "AllowMultipleValueFilterForTaxonomyFields": true,
                "AddRequiredFields": true
            }
        };

        const versionHistogram = {};
        const pendingDeletes = [];
        let nextHref = null;
        let firstPage = true;
        let pageNum = 0;
        let processedFiles = 0;
        let eligibleTotal = 0;

        while (firstPage || nextHref) {
            firstPage = false;
            pageNum++;

            let url = baseUrl;
            if (nextHref) url += '&' + nextHref.replace(/^\?/, '');

            const response = await fetchWithRetry(url, {
                method: 'POST',
                headers: scanHeaders,
                credentials: 'include',
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                console.error(`   ❌ Page ${pageNum} failed (status ${response.status}) — stopping`);
                break;
            }

            const data = await response.json();
            const payload = data.d || data;
            const rows = payload.Row || [];
            nextHref = payload.NextHref || null;

            const pageFiles = [];
            for (const r of rows) {
                if (String(r.FSObjType) !== "0") continue;
                if (!r.FileRef || !r.FileLeafRef) continue;

                let versionCount = parseInt(r.owshiddenversion, 10);
                if (isNaN(versionCount) || versionCount < 1) {
                    const label = parseFloat(r._UIVersionString);
                    versionCount = isNaN(label) ? 1 : Math.max(1, Math.floor(label));
                }

                pageFiles.push({
                    ServerRelativeUrl: r.FileRef,
                    Name: r.FileLeafRef,
                    VersionCount: versionCount,
                    UIVersionLabel: r._UIVersionString || '',
                    ModifiedRaw: r["Modified."] || r.Modified || ''
                });
            }

            sessionStats.scanned += pageFiles.length;

            for (const f of pageFiles) {
                const bucket = f.VersionCount >= 10 ? '10+' : String(f.VersionCount);
                versionHistogram[bucket] = (versionHistogram[bucket] || 0) + 1;
            }

            const eligible = pageFiles.filter(f => {
                const fileName = f.Name.toLowerCase();
                if (EXTENSIONS_TO_SKIP.some(ext => fileName.endsWith(ext))) return false;
                return f.VersionCount > VERSIONS_TO_KEEP;
            });

            eligible.sort((a, b) => parseModifiedDate(b.ModifiedRaw) - parseModifiedDate(a.ModifiedRaw));

            eligibleTotal += eligible.length;
            sessionStats.eligible = eligibleTotal;

            console.log(`📄 Page ${pageNum}: ${rows.length} rows | seen ${sessionStats.scanned} | eligible-so-far ${eligibleTotal}${nextHref ? ' | more pages' : ' | last page'}`);

            if (eligible.length > 0) {
                // Fire deletions in the background so scanning and deleting run simultaneously.
                pendingDeletes.push(processInBatches(eligible, CONCURRENT_REQUESTS, async (file) => {
                    try {
                        await cleanFileVersions(file.ServerRelativeUrl, file.Name, await getValidHeaders());
                    } catch (e) {
                        console.error(`   ❌ Error on ${file.Name}:`, e);
                        sessionStats.failed++;
                    }
                    processedFiles++;
                    if (processedFiles % PROGRESS_LOG_EVERY === 0) {
                        const elapsedMin = (Date.now() - sessionStartTime) / 60000;
                        const ratePerMin = processedFiles / Math.max(elapsedMin, 0.01);
                        console.log(`   ⏱️ ${processedFiles} files processed | ${ratePerMin.toFixed(1)} files/min | delay ${Math.round(currentDelay)}ms`);
                    }
                }));
            }
            // No extra sleep — next page fetch already paced by adaptive delay
        }

        // Wait for all background deletions to finish before reporting.
        await Promise.all(pendingDeletes);

        console.log("\n📊 Version-count distribution (whole library):");
        Object.keys(versionHistogram).sort((a, b) => {
            if (a === '10+') return 1;
            if (b === '10+') return -1;
            return parseInt(a) - parseInt(b);
        }).forEach(k => {
            console.log(`   ${k.padStart(3)} revision(s): ${versionHistogram[k]} files`);
        });

        console.log(`📊 Scanned: ${sessionStats.scanned} files | Eligible: ${eligibleTotal} | Processed: ${processedFiles}`);
    }

    // --- Main execution handler ---
    async function startCleanup(btn) {
        try {
            resetSessionStats();
            sessionStartTime = Date.now();
            currentDelay = RATE.INITIAL_DELAY_MS;
            successStreak = 0;
            consecutiveThrottles = 0;
            totalRequests = 0;
            totalThrottles = 0;
            requestTimes = [];
            throttleTimes = [];
            lastReportTime = 0;

            if (!SITE_URL) {
                const detection = detectSiteAndFolder();
                SITE_URL = detection.siteUrl;
                STARTING_FOLDER = detection.startingFolder;
                ACCOUNT_TYPE = detection.accountType;
            }

            console.log("\n🚀 Starting OneDrive version cleanup (adaptive rate)...");
            console.log(`📌 Account Type: ${ACCOUNT_TYPE}`);
            console.log(`📌 Personal: ${IS_PERSONAL}`);
            console.log(`📌 Site URL: ${SITE_URL}`);
            console.log(`📌 Library root: ${STARTING_FOLDER}`);
            console.log(`📌 Keep threshold: ${VERSIONS_TO_KEEP} revisions per file`);
            console.log(`📌 Scan order: ID ${SCAN_SORT_DIRECTION === 'asc' ? 'ascending' : 'descending'}`);
            console.log(`📌 Rate control: start ${RATE.INITIAL_DELAY_MS}ms, range [${RATE.MIN_DELAY_MS}ms, ${RATE.MAX_DELAY_MS}ms]`);

            showToast(`🚀 Streaming scan + adaptive cleanup started…`, 'info', 3000);

            const scanHeaders = await getValidHeaders();
            await streamScanAndClean(scanHeaders);

            const s = rateSummary();
            console.log("\n🎉 Version cleanup complete!");
            console.log(`📈 Rate summary — avg ${s.avgRatePerMin} req/min over ${s.runtimeMin} min`);
            console.log(`📈 Final delay: ${s.finalDelay}ms (~${s.finalRatePerMin} req/min) | ${s.totalThrottles} throttle events total`);

            showToast(
                `🎉 Done — ${sessionStats.recycled} recycled${sessionStats.failed ? `, ${sessionStats.failed} failed` : ''} | ` +
                `avg ${s.avgRatePerMin} req/min`,
                sessionStats.failed ? 'warn' : 'success',
                6000
            );
        } catch (error) {
            console.error("❌ Error during cleanup:", error);
            showToast(`❌ Cleanup failed: ${shortenName(error && error.message, 60)}`, 'error', 5000);
        } finally {
            if (btn) {
                btn.innerHTML = '🧹 Clean Versions';
                btn.disabled = false;
                btn.style.backgroundColor = '#0078d4';
                btn.style.cursor = 'pointer';
            }
        }
    }

    // --- Recycle Bin (personal + business) ---
    async function nukeRecycleBin(btn) {
        try {
            resetSessionStats();
            sessionStartTime = Date.now();

            if (!SITE_URL) {
                const detection = detectSiteAndFolder();
                SITE_URL = detection.siteUrl;
                ACCOUNT_TYPE = detection.accountType;
                IS_PERSONAL = window.location.hostname.includes('live.com') || window.location.href.includes('/personal/');
            }

            console.log("🗑️ Commencing Recycle Bin purge...");
            showToast("🗑️ Purging Recycle Bin…", 'info', 2500);

            if (IS_PERSONAL) {
                console.log("   🧑‍💻 Personal OneDrive detected, using direct API...");
                await emptyPersonalRecycleBin();
            } else {
                const headers = await getValidHeaders();
                console.log("   📦 Moving all items to Second-Stage...");
                const stage1 = await fetchWithRetry(`${SITE_URL}/_api/site/getrecyclebinitems(rowLimit='5000',isAscending='false',itemState=1,orderBy=3)/MoveAllToSecondStage`, { method: 'POST', headers, credentials: 'include' });
                if (stage1.ok) {
                    console.log("   ✅ First-stage cleared.");
                    showToast("✅ First-stage recycle bin cleared", 'success');
                } else {
                    console.error("   ❌ Failed to clear First-stage.");
                    showToast("❌ Failed to clear First-stage bin", 'error');
                }

                console.log("   🔥 Permanently deleting items from Second-Stage...");
                const stage2 = await fetchWithRetry(`${SITE_URL}/_api/site/getrecyclebinitems(rowLimit='5000',isAscending='false',itemState=2,orderBy=3)/DeleteAllSecondStageItems`, { method: 'POST', headers, credentials: 'include' });
                if (stage2.ok) {
                    console.log("   ✅ Second-stage cleared. Storage space reclaimed!");
                    showToast("🗑️ Second-stage cleared — storage reclaimed!", 'success', 4500);
                } else {
                    console.error("   ❌ Failed to clear Second-stage.");
                    showToast("❌ Failed to clear Second-stage bin", 'error', 4500);
                }
            }
        } catch (error) {
            console.error("❌ Error emptying recycle bin:", error);
            showToast(`❌ Recycle bin purge failed: ${shortenName(error && error.message, 60)}`, 'error', 5000);
        } finally {
            if (btn) {
                btn.innerHTML = '🗑️ Empty Recycle Bin';
                btn.disabled = false;
                btn.style.backgroundColor = '#d13438';
                btn.style.cursor = 'pointer';
            }
        }
    }

    // Helper: empty personal OneDrive recycle bin using GM_xmlhttpRequest
    async function emptyPersonalRecycleBin() {
        const ctx = unsafeWindow._spPageContextInfo;
        if (!ctx || !ctx.siteId) {
            console.error("❌ Could not obtain siteId from _spPageContextInfo.");
            showToast("❌ Could not obtain siteId", 'error', 4500);
            return;
        }

        let siteId = ctx.siteId.replace(/[{}]/g, '');
        let webId = ctx.webId ? ctx.webId.replace(/[{}]/g, '') : '';

        if (!webId || webId === '00000000-0000-0000-0000-000000000000') {
            console.log("   🔍 webId is empty, fetching real web ID...");
            const headers = await getValidHeaders();
            const webResp = await fetchWithRetry(`${SITE_URL}/_api/web?$select=Id`, { headers, credentials: 'include' });
            if (webResp.ok) {
                const webData = await webResp.json();
                if (webData.d && webData.d.Id) {
                    webId = webData.d.Id.replace(/[{}]/g, '');
                    console.log(`   ✅ Retrieved webId: ${webId}`);
                }
            }
        }

        if (!webId || webId === '00000000-0000-0000-0000-000000000000') {
            console.error("❌ Could not obtain valid webId.");
            showToast("❌ Could not obtain valid webId", 'error', 4500);
            return;
        }

        const apiBase = `https://my.microsoftpersonalcontent.com/_api/v2.1/sites/my.microsoftpersonalcontent.com,${siteId},${webId}`;
        const deleteAllUrl = `${apiBase}/recycleBin/items/deleteAll?%24top=100`;
        console.log(`   🔗 Calling deleteAll via GM_xmlhttpRequest: ${deleteAllUrl}`);

        const cookieHeader = document.cookie;
        console.log(`   🍪 Sending cookies (length ${cookieHeader.length})`);
        const headers = {
            'Accept': 'application/json;odata=verbose',
            'Content-Type': 'application/json;odata=verbose',
            'X-Requested-With': 'XMLHttpRequest',
            'Cookie': cookieHeader
        };
        const request = (method, url) => new Promise((resolve) => {
            GM_xmlhttpRequest({
                method,
                url,
                headers,
                onload: resolve,
                onerror: resolve
            });
        });
        const deleteAllResp = await request('POST', deleteAllUrl);

        if (deleteAllResp.status >= 200 && deleteAllResp.status < 300) {
            console.log("   ✅ Recycle bin emptied successfully!");
            showToast("🗑️ Recycle bin emptied!", 'success', 4500);
            return;
        }

        console.warn(`   ⚠️ deleteAll failed (status ${deleteAllResp.status}). Falling back to manual deletion...`);
        showToast("⚠️ Bulk delete failed — switching to item-by-item…", 'warn', 3000);

        const listUrl = `${apiBase}/recycleBin/items?orderby=deletedDateTime%20desc&%24top=101`;
        const listResp = await request('GET', listUrl);

        if (listResp.status >= 200 && listResp.status < 300) {
            const data = JSON.parse(listResp.responseText);
            const items = data.value || data.d?.results || [];
            console.log(`   📦 Found ${items.length} items in recycle bin.`);
            showToast(`📦 Found ${items.length} item(s) in recycle bin`, 'info', 2500);

            for (const item of items) {
                const itemId = item.Id || item.ID || item.id;
                if (!itemId) continue;
                const deleteUrl = `${apiBase}/recycleBin/items/${itemId}`;
                const delResp = await request('DELETE', deleteUrl);

                const itemName = item.name || item.Name || itemId;
                if (delResp.status >= 200 && delResp.status < 300) {
                    console.log(`   ✅ Deleted: ${itemName}`);
                    sessionStats.binDeleted++;
                    showToast(`🔥 Deleted: ${shortenName(itemName)}`, 'success');
                } else {
                    console.warn(`   ❌ Failed to delete: ${itemName} (status ${delResp.status})`);
                    sessionStats.binFailed++;
                    showToast(`❌ Failed: ${shortenName(itemName)} (${delResp.status})`, 'error');
                }
                await sleep(200);
            }

            showToast(`🗑️ Recycle bin emptied — ${sessionStats.binDeleted} deleted${sessionStats.binFailed ? `, ${sessionStats.binFailed} failed` : ''}`, sessionStats.binFailed ? 'warn' : 'success', 4500);
        } else {
            console.error("❌ Could not list recycle bin items.");
            showToast("❌ Could not list recycle bin items", 'error', 4500);
        }
    }

    // --- Combined: clean versions, then empty the recycle bin ---
    async function runCleanupAndNuke(btn) {
        try {
            await startCleanup(null);
            await nukeRecycleBin(null);
        } finally {
            if (btn) {
                btn.innerHTML = '🧹 Clean & Empty Bin';
                btn.disabled = false;
                btn.style.backgroundColor = '#0078d4';
                btn.style.cursor = 'pointer';
            }
        }
    }

    // --- UI INJECTION ---
    function createUI() {
        if (document.getElementById('onedrive-tools-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'onedrive-tools-panel';
        panel.style.position = 'fixed';
        panel.style.bottom = '20px';
        panel.style.right = '20px';
        panel.style.display = 'flex';
        panel.style.flexDirection = 'column';
        panel.style.gap = '10px';
        panel.style.zIndex = '999999';

        const getBtnStyle = (bgColor) => `
            padding: 12px 16px;
            background-color: ${bgColor};
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            font-family: "Segoe UI", "Helvetica Neue", sans-serif;
            font-weight: bold;
            transition: opacity 0.2s;
        `;
        const actionBtn = document.createElement('button');
        actionBtn.innerHTML = '🧹 Clean & Empty Bin';
        actionBtn.style.cssText = getBtnStyle('#0078d4');
        actionBtn.onmouseenter = () => actionBtn.style.opacity = '0.8';
        actionBtn.onmouseleave = () => actionBtn.style.opacity = '1';
        actionBtn.onclick = async () => {
            actionBtn.innerHTML = '⏳ Working...';
            actionBtn.disabled = true;
            actionBtn.style.backgroundColor = '#666666';
            actionBtn.style.cursor = 'not-allowed';
            await runCleanupAndNuke(actionBtn);
        };

        panel.appendChild(actionBtn);
        document.body.appendChild(panel);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        createUI();
    } else {
        window.addEventListener('load', createUI);
    }

    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand("Clean & Empty Bin", () => runCleanupAndNuke(null));
    }
})();
