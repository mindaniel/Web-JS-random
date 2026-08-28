(async function() {
    console.clear();
    console.log("🚀 STARTING SMART DOWNLOADER...");
    console.log("Will stop automatically when the 'Scroll to Bottom' arrow disappears.");

    let downloadedCount = 0;
    const downloadedIds = new Set();
    const scrollContainer = document.querySelector('.MessageList, .messages-layout, #messages-container, .bubbles-inner');

    async function startBatch() {
        // 1. CHECK IF WE SHOULD CONTINUE
        // We look for your specific arrow icon class
        const bottomArrow = document.querySelector('i.icon-arrow-down');
        
        if (!bottomArrow) {
            console.log("🏁 DONE! The arrow disappeared, reaching the newest messages.");
            console.log(`📊 Final Total: ${downloadedCount} items saved.`);
            return; // EXIT SCRIPT
        }

        // 2. FIND AND DOWNLOAD ICONS
        const icons = document.querySelectorAll('i.icon.icon-download');
        
        for (const icon of icons) {
            const parentMessage = icon.closest('.bubble, .message, .message-list-item');
            const msgId = parentMessage ? (parentMessage.getAttribute('data-mid') || parentMessage.innerText.slice(0, 30)) : Math.random();

            if (!downloadedIds.has(msgId)) {
                downloadedIds.add(msgId);
                downloadedCount++;
                
                icon.click();
                if (icon.parentElement.tagName === "BUTTON") icon.parentElement.click();

                console.log(`✅ [${downloadedCount}] Saved: ${msgId}`);
                await new Promise(r => setTimeout(r, 1000)); 
            }
        }

        // 3. MOVE DOWN
        if (scrollContainer) {
            scrollContainer.scrollBy(0, 600);
        } else {
            window.scrollBy(0, 600);
        }

        // 4. REPEAT
        setTimeout(startBatch, 2500);
    }

    startBatch();
})();
