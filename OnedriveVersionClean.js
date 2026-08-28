// ==UserScript==
// @name         Universal OneDrive Cleaner & Nuker
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Cleans old file versions and empties the recycle bin in OneDrive/SharePoint.
// @author       You
// @match        *://*.sharepoint.com/*
// @match        *://onedrive.live.com/*
// @match        *://*.onedrive.com/*
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(function() {
    'use strict';

    // --- CONFIGURATION ---
    const VERSIONS_TO_KEEP = 2;
    const EXTENSIONS_TO_SKIP = [];
    const CONCURRENT_REQUESTS = 5;

    // --- Global Variables (Deferred Initialization) ---
    let SITE_URL = "";
    let STARTING_FOLDER = "";
    let ACCOUNT_TYPE = "";
    let requestDigest = "";
    let tokenFetchTime = 0;

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // --- Auto-detect account type and credentials ---
    function detectAccountType() {
        const url = window.location.href;
        if (url.includes('sharepoint.com') || url.includes('my.sharepoint.com')) return 'business';
        if (url.includes('onedrive.live.com') || url.includes('onedrive.com')) return 'consumer';
        
        const pageContent = document.documentElement.innerHTML;
        if (pageContent.includes('_spPageContextInfo') || pageContent.includes('SharePoint')) return 'business';
        return 'business';
    }

    // --- Auto-detect site URL and starting folder ---
    function detectSiteAndFolder() {
        const origin = window.location.origin;
        const fullUrl = window.location.href;
        let siteUrl = null;
        let startingFolder = null;
        let accountType = detectAccountType();

        console.log(`🔍 Detecting ${accountType} OneDrive account...`);

        const pathMatch = fullUrl.match(/\/personal\/([^\/?&]+)/);
        if (pathMatch) {
            const userPart = pathMatch[1];
            siteUrl = `${origin}/personal/${userPart}`;
            startingFolder = `/personal/${userPart}/Documents`;
            console.log(`✅ Detected: ${siteUrl}`);
            return { siteUrl, startingFolder, accountType };
        }

        // FIX: Changed 'window' to 'unsafeWindow' to bypass the Tampermonkey sandbox
        if (accountType === 'business' && unsafeWindow._spPageContextInfo) {
            const webUrl = unsafeWindow._spPageContextInfo.webServerRelativeUrl;
            if (webUrl && webUrl.startsWith('/personal/')) {
                siteUrl = origin + webUrl;
                startingFolder = webUrl + '/Documents';
                console.log(`✅ Detected business site: ${siteUrl}`);
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
            try {
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
            } catch (e) {
                console.error('❌ Invalid input');
            }
        }
        throw new Error('Could not detect OneDrive site or user cancelled.');
    }

    // --- Get authentication headers based on account type ---
    async function getValidHeaders() {
        const headers = {
            "Accept": "application/json;odata=verbose",
            "Content-Type": "application/json;odata=verbose",
            "X-Requested-With": "XMLHttpRequest"
        };

        if (ACCOUNT_TYPE === 'business') {
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
        } else {
            const cookies = document.cookie.split(';');
            for (const cookie of cookies) {
                const [name, value] = cookie.trim().split('=');
                if (name === 'ODB_AccessToken' || name === 'access_token') {
                    headers['Authorization'] = `Bearer ${decodeURIComponent(value)}`;
                    break;
                }
            }
        }
        return headers;
    }

    // --- Process in batches (concurrent) ---
    async function processInBatches(items, batchSize, processFn) {
        for (let i = 0; i < items.length; i += batchSize) {
            const batch = items.slice(i, i + batchSize);
            await Promise.all(batch.map(item => processFn(item)));
            await sleep(150);
        }
    }

    // --- Get files in folder ---
    async function getFilesInFolder(folderPath, headers) {
        const encodedFolder = encodeURIComponent(folderPath).replace(/'/g, "%27");
        const url = `${SITE_URL}/_api/web/GetFolderByServerRelativeUrl('${encodedFolder}')/Files?$select=ServerRelativeUrl,Name,UIVersionLabel`;
        const response = await fetch(url, { headers, credentials: 'include' });
        if (response.ok) {
            const data = await response.json();
            return data.d ? data.d.results : [];
        }
        return [];
    }

    // --- Get subfolders ---
    async function getSubfolders(folderPath, headers) {
        const encodedFolder = encodeURIComponent(folderPath).replace(/'/g, "%27");
        const url = `${SITE_URL}/_api/web/GetFolderByServerRelativeUrl('${encodedFolder}')/Folders?$select=ServerRelativeUrl,Name`;
        const response = await fetch(url, { headers, credentials: 'include' });
        if (response.ok) {
            const data = await response.json();
            return data.d ? data.d.results : [];
        }
        return [];
    }

    // --- Get versions for a file ---
    async function getFileVersions(filePath, headers) {
        const encodedPath = encodeURIComponent(filePath).replace(/'/g, "%27");
        let url = ACCOUNT_TYPE === 'business'
            ? `${SITE_URL}/_api/web/GetListItemUsingPath(decodedUrl='${encodedPath}')/versions?$select=VersionId,VersionLabel,IsCurrentVersion&$top=5000`
            : `${SITE_URL}/_api/web/GetFileByServerRelativeUrl('${encodedPath}')/Versions?$select=ID,VersionLabel,IsCurrentVersion,Created`;
        
        const response = await fetch(url, { headers, credentials: 'include' });
        if (response.ok) {
            const data = await response.json();
            return data.d ? data.d.results : [];
        }
        return [];
    }

    // --- Delete a version ---
    async function deleteVersion(filePath, version, headers) {
        const encodedPath = encodeURIComponent(filePath).replace(/'/g, "%27");
        if (ACCOUNT_TYPE === 'business') {
            const recycleUrl = `${SITE_URL}/_api/web/GetFileByServerRelativePath(decodedUrl='${encodedPath}')/versions/RecycleByLabel(versionLabel='${version.VersionLabel}')`;
            const response = await fetch(recycleUrl, { method: 'POST', headers, credentials: 'include' });
            return response.ok;
        } else {
            const versionId = version.ID;
            if (versionId) {
                let url = `${SITE_URL}/_api/web/GetFileByServerRelativeUrl('${encodedPath}')/Versions(${versionId})`;
                let response = await fetch(url, { method: 'DELETE', headers, credentials: 'include' });
                if (response.ok) return true;
                
                if (version.VersionLabel) {
                    const recycleUrl = `${SITE_URL}/_api/web/GetFileByServerRelativeUrl('${encodedPath}')/Versions/RecycleByLabel('${version.VersionLabel}')`;
                    response = await fetch(recycleUrl, { method: 'POST', headers, credentials: 'include' });
                    return response.ok;
                }
            }
            return false;
        }
    }

    // --- Clean file versions ---
    async function cleanFileVersions(filePath, fileName, headers) {
        const versions = await getFileVersions(filePath, headers);
        if (versions.length <= VERSIONS_TO_KEEP) return;
        
        console.log(`  📄 ${fileName}: Trimming ${versions.length - VERSIONS_TO_KEEP} old versions...`);
        const sortedVersions = versions.sort((a, b) => {
            const dateA = a.Created ? new Date(a.Created) : new Date(0);
            const dateB = b.Created ? new Date(b.Created) : new Date(0);
            return dateA - dateB;
        });
        
        const nonCurrentVersions = sortedVersions.filter(v => !v.IsCurrentVersion);
        const versionsToDelete = nonCurrentVersions.slice(0, nonCurrentVersions.length - (VERSIONS_TO_KEEP - 1));
        
        for (const v of versionsToDelete) {
            const success = await deleteVersion(filePath, v, headers);
            if (success) {
                console.log(`    ✅ Recycled version ${v.VersionLabel || v.ID}`);
            } else {
                console.log(`    ❌ Failed to recycle version ${v.VersionLabel || v.ID}`);
            }
            await sleep(100);
        }
    }

    // --- Process folder recursively ---
    async function processFolder(folderPath) {
        console.log(`\n📂 Scanning: ${folderPath}`);
        const headers = await getValidHeaders();
        await sleep(200);

        const files = await getFilesInFolder(folderPath, headers);
        const filesToScan = [];

        for (const file of files) {
            const fileName = file.Name.toLowerCase();
            if (EXTENSIONS_TO_SKIP.some(ext => fileName.endsWith(ext))) continue;
            const versionNum = parseFloat(file.UIVersionLabel);
            if (versionNum <= VERSIONS_TO_KEEP) continue;
            filesToScan.push(file);
        }

        if (filesToScan.length > 0) {
            console.log(`   🔥 Found ${filesToScan.length} files requiring history cleanup...`);
            await processInBatches(filesToScan, CONCURRENT_REQUESTS, async (file) => {
                await cleanFileVersions(file.ServerRelativeUrl, file.Name, await getValidHeaders());
            });
        }

        const subfolders = await getSubfolders(folderPath, headers);
        const filteredFolders = subfolders.filter(f => 
            f.Name !== "Forms" && f.Name !== "Attachments" && !f.Name.startsWith("_")
        );

        for (const subfolder of filteredFolders) {
            await processFolder(subfolder.ServerRelativeUrl);
            await sleep(200);
        }
    }

    // --- Main execution handler for Version Cleanup ---
    async function startCleanup(btn) {
        try {
            if (!SITE_URL) {
                const detection = detectSiteAndFolder();
                SITE_URL = detection.siteUrl;
                STARTING_FOLDER = detection.startingFolder;
                ACCOUNT_TYPE = detection.accountType;
            }

            console.log("\n🚀 Starting OneDrive version cleanup...");
            console.log(`📌 Account Type: ${ACCOUNT_TYPE}`);
            console.log(`📌 Starting from: ${STARTING_FOLDER}`);

            await processFolder(STARTING_FOLDER);
            
            console.log("\n🎉 Version cleanup complete!");
            alert("✅ Version Cleanup Complete!");
            
        } catch (error) {
            console.error("❌ Error during cleanup:", error);
            alert("❌ Cleanup failed or cancelled. Check console.");
        } finally {
            if (btn) {
                btn.innerHTML = '🧹 Clean Versions';
                btn.disabled = false;
                btn.style.backgroundColor = '#0078d4';
                btn.style.cursor = 'pointer';
            }
        }
    }

    // --- NEW: Two-Stage Recycle Bin Purge ---
    async function nukeRecycleBin(btn) {
        try {
            if (!SITE_URL) {
                const detection = detectSiteAndFolder();
                SITE_URL = detection.siteUrl;
                ACCOUNT_TYPE = detection.accountType;
            }

            console.log("🗑️ Commencing full Two-Stage Recycle Bin purge...");
            const headers = await getValidHeaders();

            if (ACCOUNT_TYPE === 'business') {
                // 1. Move Stage 1 to Stage 2
                console.log("   📦 Moving all items to Second-Stage...");
                const stage1 = await fetch(`${SITE_URL}/_api/site/getrecyclebinitems(rowLimit='5000',isAscending='false',itemState=1,orderBy=3)/MoveAllToSecondStage`, { method: 'POST', headers, credentials: 'include' });
                if (stage1.ok) {
                    console.log("   ✅ First-stage cleared.");
                } else {
                    console.error("   ❌ Failed to clear First-stage.");
                }

                // 2. Obliterate Stage 2
                console.log("   🔥 Permanently deleting items from Second-Stage...");
                const stage2 = await fetch(`${SITE_URL}/_api/site/getrecyclebinitems(rowLimit='5000',isAscending='false',itemState=2,orderBy=3)/DeleteAllSecondStageItems`, { method: 'POST', headers, credentials: 'include' });
                if (stage2.ok) {
                    console.log("   ✅ Second-stage cleared. Storage space successfully reclaimed!");
                    alert("🗑️ Storage space reclaimed! Recycle Bin is completely empty.");
                } else {
                    console.error("   ❌ Failed to clear Second-stage.");
                }
            } else {
                console.log("   🗑️ Consumer OneDrive detected, trying default recycle bin empty...");
                const res = await fetch(`${SITE_URL}/_api/web/recyclebin/DeleteAll`, { method: 'POST', headers, credentials: 'include' });
                if (res.ok) {
                    console.log("   ✅ Recycle bin cleared!");
                    alert("🗑️ Recycle Bin emptied successfully!");
                } else {
                    console.error("   ❌ Failed to clear consumer recycle bin.");
                    alert("❌ Emptying recycle bin via script is currently only fully supported for Business/School accounts.");
                }
            }
        } catch (error) {
            console.error("❌ Error emptying recycle bin:", error);
            alert("❌ Failed to empty recycle bin. Check console.");
        } finally {
            if (btn) {
                btn.innerHTML = '🗑️ Empty Recycle Bin';
                btn.disabled = false;
                btn.style.backgroundColor = '#d13438';
                btn.style.cursor = 'pointer';
            }
        }
    }

    // --- UI INJECTION (Floating Buttons Panel) ---
    function createUI() {
        if (document.getElementById('onedrive-tools-panel')) return;

        // Container for both buttons
        const panel = document.createElement('div');
        panel.id = 'onedrive-tools-panel';
        panel.style.position = 'fixed';
        panel.style.bottom = '20px';
        panel.style.right = '20px';
        panel.style.display = 'flex';
        panel.style.flexDirection = 'column';
        panel.style.gap = '10px';
        panel.style.zIndex = '999999';

        // Styling template for buttons
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

        // 1. Clean Versions Button
        const cleanBtn = document.createElement('button');
        cleanBtn.innerHTML = '🧹 Clean Versions';
        cleanBtn.style.cssText = getBtnStyle('#0078d4'); // OneDrive Blue
        cleanBtn.onmouseenter = () => cleanBtn.style.opacity = '0.8';
        cleanBtn.onmouseleave = () => cleanBtn.style.opacity = '1';
        
        cleanBtn.onclick = async () => {
            if (!confirm("Are you sure you want to clean old versions?\nKeep Console (F12) open.")) return;
            cleanBtn.innerHTML = '⏳ Cleaning...';
            cleanBtn.disabled = true;
            cleanBtn.style.backgroundColor = '#666666';
            cleanBtn.style.cursor = 'not-allowed';
            await startCleanup(cleanBtn);
        };

        // 2. Nuke Recycle Bin Button
        const nukeBtn = document.createElement('button');
        nukeBtn.innerHTML = '🗑️ Empty Recycle Bin';
        nukeBtn.style.cssText = getBtnStyle('#d13438'); // Microsoft Red
        nukeBtn.onmouseenter = () => nukeBtn.style.opacity = '0.8';
        nukeBtn.onmouseleave = () => nukeBtn.style.opacity = '1';
        
        nukeBtn.onclick = async () => {
            if (!confirm("WARNING: This will PERMANENTLY empty your Recycle Bin (First & Second stage).\n\nProceed?")) return;
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

    // Run UI injection immediately or on load
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        createUI();
    } else {
        window.addEventListener('load', createUI);
    }

    // Register Tampermonkey menu commands
    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand("Start Version Cleanup", () => startCleanup(null));
        GM_registerMenuCommand("Empty Recycle Bin (Nuke)", () => nukeRecycleBin(null));
    }

})();
