// =================================================================
// 🎾 TENNIS BOT V21: OUTLOOK INVITE FORMATTER & EMAIL CONFIG
// =================================================================

// 1. CONFIGURATION
const API_BASE = "https://l-xn-hub-ext.st-andrews.ac.uk/LhWeb/en/api";
const YOUR_PID = "49322"; 
window.CURRENT_ACTIVITY = "Tennis"; 
window.CURRENT_DATE = null; 
window.BOOKED_SLOTS = []; 

// 2. AUTH HELPER
function getFreshToken() {
    const storageKey = "oidc.user:https://l-xn-hub-ext.st-andrews.ac.uk/lhweb/identity:LhWebJs";
    const rawData = sessionStorage.getItem(storageKey);
    if (rawData) {
        try {
            return "Bearer " + JSON.parse(rawData).access_token;
        } catch (e) { console.error("Token error", e); }
    }
    return null;
}

// 3. GUI BUILDER
function initGUI() {
    const existing = document.getElementById('tennis-sniper-gui');
    if (existing) existing.remove();

    const gui = document.createElement('div');
    gui.id = 'tennis-sniper-gui';
    gui.style.cssText = `
        position: fixed; top: 20px; right: 20px; width: 560px; max-height: 85vh;
        background: #1e1e1e; color: #fff; z-index: 999999;
        border-radius: 8px; box-shadow: 0 10px 25px rgba(0,0,0,0.8);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; 
        overflow-y: auto; padding: 15px; border: 1px solid #333;
    `;

    const headerRow = document.createElement('div');
    headerRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 1px solid #444; padding-bottom: 10px;';

    const header = document.createElement('h3');
    header.innerHTML = '🎯 Sniper V21';
    header.style.cssText = 'margin: 0; color: #2ecc71; white-space: nowrap;';
    
    const controlsContainer = document.createElement('div');
    controlsContainer.style.cssText = 'display: flex; gap: 8px; align-items: center;';

    // Activity Dropdown
    const activitySelect = document.createElement('select');
    activitySelect.style.cssText = `
        background: #333; color: white; border: 1px solid #555; 
        padding: 6px 10px; border-radius: 4px; font-weight: bold; outline: none; cursor: pointer;
    `;
    
    ['Tennis', 'Table Tennis', 'Badminton'].forEach(sport => {
        const opt = document.createElement('option');
        opt.value = sport;
        opt.innerText = sport;
        if(sport === window.CURRENT_ACTIVITY) opt.selected = true;
        activitySelect.appendChild(opt);
    });

    activitySelect.onchange = (e) => {
        window.CURRENT_ACTIVITY = e.target.value;
        const resultsDiv = document.getElementById('sniper-results');
        
        if (window.CURRENT_DATE) {
            fetchScheduleForGUI(window.CURRENT_DATE);
        } else {
            resultsDiv.innerHTML = `<p style="color: #aaa; text-align: center;">Select a day to scan for ${window.CURRENT_ACTIVITY}.</p>`;
        }
    };

    // Email Input
    const emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.id = 'sniper-email';
    emailInput.value = 'yf43@st-andrews.ac.uk';
    emailInput.style.cssText = `
        background: #2a2a2a; color: #fff; border: 1px solid #555; 
        padding: 6px 10px; border-radius: 4px; width: 160px; outline: none;
    `;

    // Export Button
    const exportBtn = document.createElement('button');
    exportBtn.id = 'export-ics-btn';
    exportBtn.innerText = '📥 Export (0)';
    exportBtn.style.cssText = `
        background: #3498db; color: white; border: none; padding: 6px 10px; 
        border-radius: 4px; cursor: pointer; font-weight: bold; transition: 0.2s; white-space: nowrap;
    `;
    exportBtn.onmouseover = () => exportBtn.style.background = '#2980b9';
    exportBtn.onmouseout = () => exportBtn.style.background = '#3498db';
    exportBtn.onclick = generateICSFile;

    controlsContainer.appendChild(activitySelect);
    controlsContainer.appendChild(emailInput);
    controlsContainer.appendChild(exportBtn);

    headerRow.appendChild(header);
    headerRow.appendChild(controlsContainer);
    gui.appendChild(headerRow);

    const dateTabs = document.createElement('div');
    dateTabs.style.cssText = 'display: flex; overflow-x: auto; gap: 5px; margin-bottom: 15px; padding-bottom: 5px;';
    
    const today = new Date();
    for(let i = 0; i <= 7; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);
        
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const dateStr = `${y}/${m}/${day}`;
        
        const shortDate = (i === 0) ? "Today" : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });

        const btn = document.createElement('button');
        btn.innerText = shortDate;
        btn.style.cssText = `
            padding: 6px 12px; background: #333; color: white; border: none; 
            border-radius: 4px; cursor: pointer; flex-shrink: 0; font-weight: bold; transition: 0.2s;
        `;
        
        btn.onclick = () => {
            window.CURRENT_DATE = dateStr;
            Array.from(dateTabs.children).forEach(c => c.style.background = '#333');
            btn.style.background = '#27ae60';
            fetchScheduleForGUI(dateStr);
        };
        dateTabs.appendChild(btn);
    }
    gui.appendChild(dateTabs);

    const results = document.createElement('div');
    results.id = 'sniper-results';
    results.innerHTML = `<p style="color: #aaa; text-align: center;">Select a day to scan for ${window.CURRENT_ACTIVITY}.</p>`;
    gui.appendChild(results);

    document.body.appendChild(gui);
}

// 4. FETCH AND POPULATE GUI
async function fetchScheduleForGUI(inputDate) {
    const resultsDiv = document.getElementById('sniper-results');
    resultsDiv.innerHTML = `<p style="color: orange; text-align: center;">📡 Scanning ${window.CURRENT_ACTIVITY} for ${inputDate}...</p>`;

    const encodedDate = encodeURIComponent(`${inputDate} 00:00:00.000`);
    const scheduleUrl = `${API_BASE}/Sites/1/Timetables/ActivityBookings?date=${encodedDate}&pid=${YOUR_PID}`;

    try {
        const res = await fetch(scheduleUrl, {
            headers: { "Accept": "application/json", "Authorization": getFreshToken() }
        });
        
        if (!res.ok) throw new Error(`API Error: ${res.status}`);
        
        const allItems = await res.json();
        
        const slots = allItems
            .filter(item => {
                if (window.CURRENT_ACTIVITY === "Tennis") {
                    return item.DisplayName.includes("Tennis") && !item.DisplayName.includes("Table");
                }
                return item.DisplayName.includes(window.CURRENT_ACTIVITY);
            })
            .filter(item => item.AvailablePlaces > 0) 
            .sort((a,b) => a.StartTime.localeCompare(b.StartTime));

        if (slots.length === 0) { 
            resultsDiv.innerHTML = '<p style="color: #e74c3c; text-align: center;">❌ No courts available.</p>'; 
            window.AVAILABLE_SLOTS = []; 
            return; 
        }

        window.AVAILABLE_SLOTS = slots;
        resultsDiv.innerHTML = `<p style="color: #2ecc71; margin-bottom: 10px; font-weight: bold;">✅ ${slots.length} Slots Found</p>`;

        slots.forEach((s, index) => {
            const startTime = s.StartTime.split('T')[1].substring(0,5);
            const st = new Date(s.StartTime);
            const et = new Date(s.EndTime);
            const durationMins = (et - st) / 60000;
            
            let durationText = "";
            if (durationMins >= 60) {
                const hrs = durationMins / 60;
                durationText = Number.isInteger(hrs) ? `${hrs} Hour` : `${hrs.toFixed(1)} Hrs`;
                if (hrs > 1) durationText += "s"; 
            } else {
                durationText = `${durationMins} Mins`;
            }
            
            const slotCard = document.createElement('div');
            slotCard.style.cssText = `
                background: #2a2a2a; padding: 12px; margin-bottom: 8px; 
                border-radius: 6px; display: flex; justify-content: space-between; align-items: center;
                border-left: 4px solid #2980b9;
            `;

            const info = document.createElement('div');
            info.innerHTML = `
                <div style="font-size: 16px; font-weight: bold; margin-bottom: 4px;">
                    ${startTime} 
                    <span style="font-size: 11px; background: #34495e; color: #ecf0f1; padding: 2px 6px; border-radius: 4px; margin-left: 6px; font-weight: normal;">
                        ⏱️ ${durationText}
                    </span>
                </div>
                <div style="font-size: 12px; color: #ccc;">${s.LocationDescription}</div>
                <div style="font-size: 11px; color: #888; margin-top: 4px;">Spots Open: ${s.AvailablePlaces}</div>
            `;

            const bookBtn = document.createElement('button');
            bookBtn.innerText = 'Snipe';
            bookBtn.style.cssText = `
                background: #e67e22; color: white; border: none; padding: 8px 16px; 
                border-radius: 4px; cursor: pointer; font-weight: bold; transition: 0.2s;
            `;
            
            bookBtn.onclick = function() {
                window.triggerInstantBooking(index, this);
            };

            slotCard.appendChild(info);
            slotCard.appendChild(bookBtn);
            resultsDiv.appendChild(slotCard);
        });

    } catch (err) { 
        console.error("Error:", err); 
        resultsDiv.innerHTML = `<p style="color: #e74c3c;">❌ Error loading data.</p>`;
    }
}

// 5. UPDATE EXPORT BUTTON UI
function updateExportButton() {
    const btn = document.getElementById('export-ics-btn');
    if (btn) {
        btn.innerText = `📥 Export (${window.BOOKED_SLOTS.length})`;
        const originalColor = btn.style.background;
        btn.style.background = '#27ae60';
        setTimeout(() => { btn.style.background = originalColor; }, 500);
    }
}

// 6. ICS GENERATOR (AS MEETING INVITE)
function generateICSFile() {
    if (window.BOOKED_SLOTS.length === 0) {
        alert("⚠️ You haven't successfully booked any slots yet!");
        return;
    }

    const emailField = document.getElementById('sniper-email');
    const userEmail = emailField ? emailField.value.trim() : "yf43@st-andrews.ac.uk";

    // METHOD:REQUEST prompts Outlook to treat this as an invite you can "Accept"
    let icsContent = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Tennis Sniper V21//EN\nMETHOD:REQUEST\n";
    
    window.BOOKED_SLOTS.forEach((slot, idx) => {
        const dtStart = slot.StartTime.replace(/[-:]/g, '');
        const dtEnd = slot.EndTime.replace(/[-:]/g, '');

        icsContent += "BEGIN:VEVENT\n";
        icsContent += `UID:tennis-sniper-${dtStart}-${idx}@standrews-bot\n`;
        icsContent += "SEQUENCE:0\n";
        icsContent += `DTSTART:${dtStart}\n`;
        icsContent += `DTEND:${dtEnd}\n`;
        
        // Add Organizer and Attendee for the invite format
        icsContent += `ORGANIZER;CN="Booking Bot":mailto:${userEmail}\n`;
        icsContent += `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN="${userEmail}":mailto:${userEmail}\n`;
        
        icsContent += `SUMMARY:✅ Booked: ${slot.DisplayName}\n`;
        icsContent += `DESCRIPTION:Location: ${slot.LocationDescription}\\nBooking Confirmed via Bot.\n`;
        icsContent += "END:VEVENT\n";
    });

    icsContent += "END:VCALENDAR";

    const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `Confirmed_Invites_${new Date().toISOString().split('T')[0]}.ics`;
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// 7. INSTANT BOOKING LOGIC
window.triggerInstantBooking = async function(index, btnElement) {
    btnElement.innerText = "⏳ Booking...";
    btnElement.style.background = "#f39c12"; 
    btnElement.disabled = true;

    const slot1 = window.AVAILABLE_SLOTS[index];
    
    const slot2 = window.AVAILABLE_SLOTS.find(s => 
        s.StartTime === slot1.EndTime && 
        s.LocationCode.trim() === slot1.LocationCode.trim() &&
        s.ActivityCode === slot1.ActivityCode
    );

    let s1_result = false;
    let s2_result = false;

    const target1 = await prepareTarget(slot1, "1st Booking");
    if (target1) s1_result = await executeShotgun(target1);

    if (slot2) {
        const target2 = await prepareTarget(slot2, "2nd Booking");
        if (target2) s2_result = await executeShotgun(target2);
    }

    if (s1_result) {
        window.BOOKED_SLOTS.push(slot1); 
        
        if (slot2) {
            if (s2_result) {
                window.BOOKED_SLOTS.push(slot2); 
                btnElement.innerText = "✅ Chained Slots!";
            } else {
                btnElement.innerText = "✅ 1st Slot Only";
            }
        } else {
            btnElement.innerText = "✅ Booked!";
        }
        
        btnElement.style.background = "#27ae60"; 
        updateExportButton(); 
        
    } else {
        btnElement.innerText = "❌ Failed";
        btnElement.style.background = "#c0392b"; 
    }
};

// 8. COLLECT CANDIDATE COURTS
async function prepareTarget(slot, label) {    
    const token = getFreshToken();
    const url = `${API_BASE}/Bookings/SubLocationGroups?siteId=${slot.SiteId}&activityCode=${slot.ActivityCode}&locationCode=${slot.LocationCode.trim()}&startDateTime=${slot.StartTime}&endDateTime=${slot.EndTime}`;
    
    let candidateList = [];

    try {
        const res = await fetch(url, { headers: { "Authorization": token } });
        const courts = await res.json();
        
        if (courts && courts.length > 0) {
            candidateList = courts.map(c => ({
                id: c.SubLocationGroupId || c.Id,
                name: c.SubLocationNames || c.Description || "Court " + (c.SubLocationGroupId || c.Id)
            }));
        } else {
            return null;
        }
    } catch (e) { return null; }

    const basePayload = {
        "Id": 0,
        "BasketId": "00000000-0000-0000-0000-000000000000",
        "Description": slot.DisplayName,
        "UntranslatedDescription": null,
        "IncomeKey": null,
        "IncomeCode": null,
        "GrossAmount": 0,
        "VATCode": "S",
        "VATAmount": 0,
        "Type": "Xn.Booking",
        "DisplayOrder": 1,
        "SiteId": slot.SiteId,
        "BasketItemMetadata": {
            "ActivityCode": slot.ActivityCode,
            "LocationCode": slot.LocationCode.trim(),
            "LocationTypeSingular": "Court",
            "ActivityGroupId": slot.ActivityGroupId,
            "SubLocationDescription": "", 
            "SendEmailReminder": "false",
            "SendSMSReminder": "false",
            "DurationDescription": slot.DurationDescription || "30 mins",
            "LocationDescription": slot.LocationDescription,
            "StartTime": slot.StartTime,
            "EndTime": slot.EndTime,
            "SiteName": "University of St Andrews"
        },
        "DurationDescription": null,
        "FormattedGrossAmount": null,
        "Quantity": 0,
        "ItemOwnerPersonFK": YOUR_PID
    };

    return { label, basePayload, candidates: candidateList };
}

// 9. FIRE SHOTGUN
async function executeShotgun(target) {
    const token = getFreshToken();
    if (!token) return false;

    for (const court of target.candidates) {
        const finalPayload = JSON.parse(JSON.stringify(target.basePayload));
        finalPayload.BasketItemMetadata.SubLocationGroup = court.id;
        finalPayload.BasketItemMetadata.SubLocationDescription = court.name;

        try {
            const res = await fetch(`${API_BASE}/Payment/OneClick/Foc`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "X-Requested-With": "XMLHttpRequest",
                    "Authorization": token
                },
                body: JSON.stringify(finalPayload)
            });

            if (res.ok) return true; 
        } catch (err) {
            console.error(err);
        }
    }
    return false; 
}

// START THE UI
initGUI();
