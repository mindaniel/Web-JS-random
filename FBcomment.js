(async function () {
function wait(ms) {
return new Promise(resolve => setTimeout(resolve, ms));
}

function parseReactions(raw) {
    if (!raw) return 0;
    raw = raw.replace(",", "."); // "3,5K" → "3.5K"
    const num = parseFloat(raw);
    if (raw.includes("K")) return Math.round(num * 1000);
    if (raw.includes("M")) return Math.round(num * 1000000);
    if (raw.includes("E")) return Math.round(num * 1000);
    return Math.round(num);
}

async function clickAllLoadMoreButtons(maxRounds = 30, delay = 1000) {
    let round = 0;
    while (round < maxRounds) {
        const buttons = Array.from(document.querySelectorAll('div[role="button"]')).filter(btn => {
            const span = btn.querySelector('span span');
            return span?.innerText?.trim() === "Xem thêm bình luận";
        });

        if (!buttons.length) {
            console.log(`✅ No more buttons to click. Finished after ${round} rounds.`);
            break;
        }

        console.log(`🔁 Round ${round + 1}: Clicking ${buttons.length} buttons...`);
        buttons.forEach(btn => btn.click());

        const comments = document.querySelectorAll('div[role="article"]');
        const last = comments[comments.length - 1];
        if (last) last.scrollIntoView({ behavior: "smooth", block: "end" });

        await wait(delay);
        round++;
    }

    console.log("✅ Done loading comments.");
}

// STEP 1: Load all top-level comments
await clickAllLoadMoreButtons(200, 1200);

// STEP 2: Extract comments
const comments = [];
const commentBlocks = document.querySelectorAll('div[role="article"]');

commentBlocks.forEach(block => {
    try {
        const name = block.querySelector('a span[dir="auto"]')?.innerText.trim() || "N/A";

        // Get the comment and remove user tag and emoji
        const commentDiv = block.querySelector('div[dir="auto"]');
        let commentText = "N/A";

        if (commentDiv) {
            const clone = commentDiv.cloneNode(true);
            // Remove <a> tags (user tags) and <img> tags (emojis)
            clone.querySelectorAll('a, img').forEach(el => el.remove());

            commentText = clone.innerText.trim();
        }

        const reactionSpan = [...block.querySelectorAll('span')]
            .find(span => span.innerText.match(/^\d+[,.]?\d*\s?[KME]?$/));
        const reactions = parseReactions(reactionSpan?.innerText.trim());

        comments.push({ name, commentText, reactions });
    } catch (err) {
        console.warn("⚠️ Skipped a block due to an error:", err);
    }
});

const csv = [
    ["Name", "Comment", "Reactions"],
    ...comments.map(c => [
        `"${c.name.replace(/"/g, '""')}"`,
        `"${c.commentText.replace(/"/g, '""')}"`,
        `${c.reactions}`
    ])
].map(row => row.join(",")).join("\n");

// STEP 3: Trigger download as CSV file
const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
const link = document.createElement("a");
link.href = URL.createObjectURL(blob);
link.download = "facebook_comments.csv";
document.body.appendChild(link);
link.click();
document.body.removeChild(link);

console.log(`✅ Downloaded ${comments.length} comments as 'facebook_comments.csv'.`);
})();
