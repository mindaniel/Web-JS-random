// ==UserScript==
// @name         Universal OneDrive Cleaner & Nuker (Personal + Business, Full)
// @namespace    http://tampermonkey.net/
// @version      8.4
// @description  Cleans old file versions and empties recycle bin in OneDrive/SharePoint. Flat-scan via RenderListDataAsStream + client-side Modified sort.
// @author       You
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
    const CONCURRENT_REQUESTS = 1;
    const REQUEST_DELAY_MS = 800;
    const MAX_RETRIES = 3;
    const PAGE_SIZE = 2000;
    const PROGRESS_LOG_EVERY = 25;   // log progress every N files during processing

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

    let sessionStats = { recycled: 0, failed: 0, binDeleted: 0, binFailed: 0, scanned: 0 };
    function resetSessionStats() {
        sessionStats = { recycled: 0, failed: 0, binDeleted: 0, binFailed: 0, scanned: 0 };
    }

    // ============================================================
    // --- GLOBAL RATE-LIMIT GATE ---
    // ============================================================
    let globalCooldownUntil = 0;

    async function waitForCooldown() {
        const now = Date.now();
        if (globalCooldownUntil > now) await sleep(globalCooldownUntil - now);
    }

    function triggerGlobalCooldown(ms) {
        globalCooldownUntil = Math.max(globalCooldownUntil, Date.now() + ms);
        console.warn(`🚦 Global cooldown engaged for ${Math.round(ms/1000)}s`);
        showToast(`🚦 Throttled — pausing all requests ${Math.round(ms/1000)}s…`, 'warn', 2500);
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

    // --- Generic fetch with retry ---
    async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
        try {
            await waitForCooldown();
            await sleep(REQUEST_DELAY_MS);

            const response = await fetch(url, options);

            if (response.status === 429 || response.status === 503) {
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

            if (response.status >= 500) {
                if (retries > 0) {
                    console.warn(`⚠️ Server error (${response.status}), retrying (${retries} left)…`);
                    await sleep(1500);
                    return fetchWithRetry(url, options, retries - 1);
                }
                console.error(`❌ Max retries exceeded (server error) for ${url}`);
                return response;
            }

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

    // ============================================================
    // --- FLAT LIBRARY SCAN via RenderListDataAsStream ---
    // One recursive call per 2,000 items returns files from every
    // subfolder, with Modified dates. Bypasses the list view
    // threshold via ID-sorted server-side pagination.
    // ============================================================
    async function scanAllFiles(headers) {
        const listUrl = `${SITE_URL}/Documents`;
        const baseUrl = `${SITE_URL}/_api/web/GetList(@a1)/RenderListDataAsStream?@a1='${encodeURIComponent(listUrl)}'`;

        const viewXml =
            `<View Scope='Recursive'>` +
                `<Query>` +
                    `<OrderBy><FieldRef Name='ID' Ascending='TRUE' /></OrderBy>` +
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

        const allFiles = [];
        let nextHref = null;
        let firstPage = true;
        let pageNum = 0;

        while (firstPage || nextHref) {
            firstPage = false;
            pageNum++;

            let url = baseUrl;
            if (nextHref) {
                url += '&' + nextHref.replace(/^\?/, '');
            }

            const response = await fetchWithRetry(url, {
                method: 'POST',
                headers,
                credentials: 'include',
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                console.error(`   ❌ Scan page ${pageNum} failed (status ${response.status})`);
                break;
            }

            const data = await response.json();
            const payload = data.d || data;
            const rows = payload.Row || [];

            for (const r of rows) {
                // Only files, skip folders
                if (String(r.FSObjType) !== "0") continue;
                if (!r.FileRef || !r.FileLeafRef) continue;

                allFiles.push({
                    ServerRelativeUrl: r.FileRef,
                    Name: r.FileLeafRef,
                    UIVersionLabel: r._UIVersionString || '',
                    ModifiedRaw: r["Modified."] || r.Modified || ''
                });
            }

            nextHref = payload.NextHref || null;

            console.log(`   📄 Page ${pageNum}: ${rows.length} rows (${allFiles.length} files so far)`);

            if (nextHref) {
                await sleep(REQUEST_DELAY_MS);
            }
        }

        console.log(`   ✅ Library scan complete: ${allFiles.length} files total`);
        return allFiles;
    }

    // --- Parse SharePoint Modified date to a sortable timestamp ---
    function parseModifiedDate(file) {
        // Prefer the ISO form when present
        const iso = file.ModifiedRaw;
        if (iso && /^\d{4}-\d{2}-\d{2}T/.test(iso)) {
            const t = Date.parse(iso);
            if (!isNaN(t)) return t;
        }
        // Fall back to Date parsing for locale string
        const t2 = Date.parse(iso);
        return isNaN(t2) ? 0 : t2;
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
        if (versions.length <= VERSIONS_TO_KEEP) {
            return; // nothing to do — silent
        }

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
            await sleep(REQUEST_DELAY_MS);
        }
    }

    // --- Process in batches ---
    async function processInBatches(items, batchSize, processFn) {
        for (let i = 0; i < items.length; i += batchSize) {
            const batch = items.slice(i, i + batchSize);
            await Promise.all(batch.map(item => processFn(item)));
            if (i + batchSize < items.length) {
                await sleep(REQUEST_DELAY_MS * 2);
            }
        }
    }

    // --- Main execution handler ---
    async function startCleanup(btn) {
        try {
            resetSessionStats();

            if (!SITE_URL) {
                const detection = detectSiteAndFolder();
                SITE_URL = detection.siteUrl;
                STARTING_FOLDER = detection.startingFolder;
                ACCOUNT_TYPE = detection.accountType;
            }

            console.log("\n🚀 Starting OneDrive version cleanup...");
            console.log(`📌 Account Type: ${ACCOUNT_TYPE}`);
            console.log(`📌 Personal: ${IS_PERSONAL}`);
            console.log(`📌 Site URL: ${SITE_URL}`);
            console.log(`📌 Library root: ${STARTING_FOLDER}`);

            showToast(`🚀 Scanning library…`, 'info', 3000);

            // ---- 1. Flat scan the entire library ----
            const scanHeaders = await getValidHeaders();
            const allFiles = await scanAllFiles(scanHeaders);
            sessionStats.scanned = allFiles.length;

            if (allFiles.length === 0) {
                showToast(`❌ No files found in library`, 'error', 5000);
                return;
            }

            showToast(`📦 Found ${allFiles.length} files — sorting by Modified…`, 'info', 3000);

            // ---- 2. Client-side sort by Modified, newest first ----
            allFiles.sort((a, b) => parseModifiedDate(b) - parseModifiedDate(a));
            console.log(`📊 Sorted ${allFiles.length} files by Modified (newest first)`);

            // ---- 3. Pre-filter by UIVersionString (skip files with ≤ VERSIONS_TO_KEEP) ----
            const filesToScan = [];
            for (const f of allFiles) {
                const fileName = f.Name.toLowerCase();
                if (EXTENSIONS_TO_SKIP.some(ext => fileName.endsWith(ext))) continue;
                const vNum = parseFloat(f.UIVersionLabel);
                if (!isNaN(vNum) && vNum <= VERSIONS_TO_KEEP) continue;
                filesToScan.push(f);
            }

            console.log(`🔥 ${filesToScan.length} files require history cleanup (after version pre-filter)`);
            showToast(`🔥 Cleaning ${filesToScan.length} files…`, 'info', 3500);

            // ---- 4. Process in order ----
            let processed = 0;
            await processInBatches(filesToScan, CONCURRENT_REQUESTS, async (file) => {
                try {
                    await cleanFileVersions(file.ServerRelativeUrl, file.Name, await getValidHeaders());
                } catch (e) {
                    console.error(`   ❌ Error on ${file.Name}:`, e);
                    sessionStats.failed++;
                }
                processed++;
                if (processed % PROGRESS_LOG_EVERY === 0) {
                    console.log(`   ⏱️ Progress: ${processed}/${filesToScan.length} files processed`);
                }
            });

            console.log("\n🎉 Version cleanup complete!");
            showToast(`🎉 Done — ${sessionStats.recycled} recycled${sessionStats.failed ? `, ${sessionStats.failed} failed` : ''}`, sessionStats.failed ? 'warn' : 'success', 5000);
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

        const cleanBtn = document.createElement('button');
        cleanBtn.innerHTML = '🧹 Clean Versions';
        cleanBtn.style.cssText = getBtnStyle('#0078d4');
        cleanBtn.onmouseenter = () => cleanBtn.style.opacity = '0.8';
        cleanBtn.onmouseleave = () => cleanBtn.style.opacity = '1';
        cleanBtn.onclick = async () => {
            cleanBtn.innerHTML = '⏳ Cleaning...';
            cleanBtn.disabled = true;
            cleanBtn.style.backgroundColor = '#666666';
            cleanBtn.style.cursor = 'not-allowed';
            await startCleanup(cleanBtn);
        };

        const nukeBtn = document.createElement('button');
        nukeBtn.innerHTML = '🗑️ Empty Recycle Bin';
        nukeBtn.style.cssText = getBtnStyle('#d13438');
        nukeBtn.onmouseenter = () => nukeBtn.style.opacity = '0.8';
        nukeBtn.onmouseleave = () => nukeBtn.style.opacity = '1';
        nukeBtn.onclick = async () => {
            nukeBtn.innerHTML = '⏳ Nuking...';
            nukeBtn.disabled = true;
            nukeBtn.style.backgroundColor = '#666666';
            nukeBtn.style.cursor = 'not-allowed';
            await nukeRecycleBin(nukeBtn);
        };

        panel.appendChild(cleanBtn);
        panel.appendChild(nukeBtn);
        document.body.appendChild(panel);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        createUI();
    } else {
        window.addEventListener('load', createUI);
    }

    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand("Start Version Cleanup", () => startCleanup(null));
        GM_registerMenuCommand("Empty Recycle Bin (Nuke)", () => nukeRecycleBin(null));
    }
})();
