// PASTE THIS INTO THE CONSOLE AND PRESS ENTER
(function createRecorderUI() {
  // --- Prevent duplicate UI ---
  if (document.getElementById('transcript-recorder-box')) {
    alert('Recorder is already running!');
    return;
  }

  // --- Helper to create elements safely (no innerHTML) ---
  function createEl(tag, styles = {}, attrs = {}, text = '') {
    const el = document.createElement(tag);
    if (styles) Object.assign(el.style, styles);
    if (attrs) Object.keys(attrs).forEach(key => el.setAttribute(key, attrs[key]));
    if (text) el.textContent = text;
    return el;
  }

  // --- Build the UI safely ---
  const box = createEl('div', {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    width: '280px',
    background: '#1e1e1e',
    color: '#fff',
    fontFamily: 'Segoe UI, Tahoma, sans-serif',
    fontSize: '14px',
    borderRadius: '12px',
    padding: '16px 18px',
    boxShadow: '0 8px 30px rgba(0,0,0,0.6)',
    zIndex: '999999',
    border: '1px solid #444',
    userSelect: 'none',
    pointerEvents: 'auto'
  }, { id: 'transcript-recorder-box' });

  // --- Header Row ---
  const headerRow = createEl('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' });
  const title = createEl('span', { fontWeight: '600', fontSize: '15px' }, {}, '📝 Transcript Recorder');
  const statusEl = createEl('span', { background: '#555', padding: '2px 10px', borderRadius: '20px', fontSize: '12px' }, { id: 'recorder-status' }, 'Stopped');
  headerRow.appendChild(title);
  headerRow.appendChild(statusEl);
  box.appendChild(headerRow);

  // --- Info Row ---
  const infoRow = createEl('div', { marginBottom: '10px' });
  const msgLabel = createEl('span', {}, {}, 'Messages: ');
  const countEl = createEl('span', { fontWeight: 'bold' }, { id: 'recorder-count' }, '0');
  const stateLabel = createEl('span', { marginLeft: '15px' }, {}, 'State: ');
  const stateTextEl = createEl('span', { fontWeight: 'bold', color: '#aaa' }, { id: 'recorder-state-text' }, 'Idle');
  infoRow.appendChild(msgLabel);
  infoRow.appendChild(countEl);
  infoRow.appendChild(stateLabel);
  infoRow.appendChild(stateTextEl);
  box.appendChild(infoRow);

  // --- Buttons Row ---
  const btnRow = createEl('div', { display: 'flex', gap: '10px' });
  const startBtn = createEl('button', { flex: '1', padding: '8px 0', border: 'none', borderRadius: '6px', background: '#2b7bff', color: '#fff', fontWeight: '600', cursor: 'pointer' }, { id: 'recorder-start-btn' }, '▶ Start Recording');
  const stopBtn = createEl('button', { flex: '1', padding: '8px 0', border: 'none', borderRadius: '6px', background: '#555', color: '#aaa', fontWeight: '600', cursor: 'not-allowed' }, { id: 'recorder-stop-btn', disabled: true }, '⏹ Stop & Download');
  btnRow.appendChild(startBtn);
  btnRow.appendChild(stopBtn);
  box.appendChild(btnRow);

  // --- Footer ---
  const footer = createEl('div', { marginTop: '8px', fontSize: '11px', color: '#888', textAlign: 'center' }, {}, '(Will auto‑scroll to capture everything)');
  box.appendChild(footer);

  document.body.appendChild(box);

  // --- DOM Refs (same as before) ---
  const statusElRef = document.getElementById('recorder-status');
  const countElRef = document.getElementById('recorder-count');
  const stateTextElRef = document.getElementById('recorder-state-text');
  const startBtnRef = document.getElementById('recorder-start-btn');
  const stopBtnRef = document.getElementById('recorder-stop-btn');

  // --- State ---
  let isRecording = false;
  let isLive = false;
  let capturedMessages = [];
  let capturedHashes = new Set();
  let liveInterval = null;

  // --- Helpers (same logic) ---
  function getMsgKey(el) {
    const compact = el.closest('.fui-ChatMessageCompact');
    if (!compact) return `unknown|${el.textContent.trim()}`;
    const author = compact.querySelector('[data-tid="transcript-item-author"]')?.textContent.trim() || '';
    const text = el.textContent.trim();
    return `${author}|${text}`;
  }

  function captureCurrentVisible() {
    const items = document.querySelectorAll('[data-tid="call-transcript-panel-message"]');
    let newCount = 0;
    items.forEach(el => {
      const key = getMsgKey(el);
      if (!capturedHashes.has(key)) {
        const compact = el.closest('.fui-ChatMessageCompact');
        const author = compact?.querySelector('[data-tid="transcript-item-author"]')?.textContent.trim() || '';
        const timestamp = compact?.querySelector('.fui-ChatMessageCompact__timestamp')?.textContent.trim() || '';
        const text = el.textContent.trim();
        if (text) {
          capturedHashes.add(key);
          capturedMessages.push({ author, timestamp, text });
          newCount++;
        }
      }
    });
    if (newCount > 0) {
      countElRef.textContent = capturedMessages.length;
      stateTextElRef.textContent = isLive ? 'Live monitoring...' : 'Scanning history...';
    }
    return newCount;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // --- Core Logic ---
  async function startRecording() {
    if (isRecording) return;
    isRecording = true;
    isLive = false;
    startBtnRef.disabled = true;
    startBtnRef.style.opacity = '0.6';
    stopBtnRef.disabled = true;
    stopBtnRef.style.background = '#555';
    stopBtnRef.style.color = '#aaa';
    stopBtnRef.style.cursor = 'not-allowed';
    statusElRef.textContent = 'Scanning';
    statusElRef.style.background = '#ff8c00';
    stateTextElRef.textContent = 'Scrolling to top...';

    const container = document.querySelector('[data-tid="call-transcript-panel-viewport"]') || document.scrollingElement;
    if (!container) {
      alert('Could not find transcript container. Open the transcript panel first.');
      isRecording = false;
      startBtnRef.disabled = false;
      startBtnRef.style.opacity = '1';
      statusElRef.textContent = 'Error';
      statusElRef.style.background = '#d32f2f';
      return;
    }

    container.scrollTo({ top: 0, behavior: 'smooth' });
    await sleep(1500);
    stateTextElRef.textContent = 'Capturing existing messages...';

    let lastScrollTop = -1;
    let stableCount = 0;
    while (true) {
      captureCurrentVisible();
      const currentScroll = container.scrollTop;
      const maxScroll = container.scrollHeight - container.clientHeight;
      container.scrollTo({ top: Math.min(currentScroll + 500, maxScroll), behavior: 'smooth' });
      await sleep(600);

      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 15) {
        await sleep(500);
        captureCurrentVisible();
        break;
      }

      if (container.scrollTop === lastScrollTop) {
        stableCount++;
        if (stableCount > 3) break;
      } else {
        stableCount = 0;
      }
      lastScrollTop = container.scrollTop;
    }

    // Switch to live
    isLive = true;
    statusElRef.textContent = 'Live';
    statusElRef.style.background = '#2e7d32';
    stateTextElRef.textContent = 'Live monitoring...';
    stopBtnRef.disabled = false;
    stopBtnRef.style.background = '#d32f2f';
    stopBtnRef.style.color = '#fff';
    stopBtnRef.style.cursor = 'pointer';

    liveInterval = setInterval(() => {
      if (!isRecording) return;
      captureCurrentVisible();
    }, 1500);
  }

  function stopAndDownload() {
    if (!isRecording) return;
    isRecording = false;
    isLive = false;

    if (liveInterval) {
      clearInterval(liveInterval);
      liveInterval = null;
    }

    statusElRef.textContent = 'Stopped';
    statusElRef.style.background = '#555';
    stateTextElRef.textContent = 'Preparing file...';
    startBtnRef.disabled = false;
    startBtnRef.style.opacity = '1';
    stopBtnRef.disabled = true;
    stopBtnRef.style.background = '#555';
    stopBtnRef.style.color = '#aaa';
    stopBtnRef.style.cursor = 'not-allowed';

    let output = '=== Full Transcript (Live Recorded) ===\n\n';
    capturedMessages.forEach(msg => {
      if (msg.author) {
        output += `[${msg.author}${msg.timestamp ? ' @ ' + msg.timestamp : ''}] ${msg.text}\n\n`;
      } else {
        output += `  ${msg.text}\n\n`;
      }
    });

    const blob = new Blob([output], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript_${new Date().toISOString().slice(0,10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    stateTextElRef.textContent = `Done! ${capturedMessages.length} messages`;
    countElRef.textContent = capturedMessages.length;
  }

  startBtnRef.addEventListener('click', startRecording);
  stopBtnRef.addEventListener('click', stopAndDownload);

  console.log('✅ Transcript Recorder UI added. Click "Start Recording" to begin.');
})();
