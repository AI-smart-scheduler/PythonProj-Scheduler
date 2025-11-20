// --- Global variables ---
let calendar; // FullCalendar instance
let scheduleData = { schedule: [], tasks: [], tests: [], generated_plan: [] };

document.addEventListener('DOMContentLoaded', () => {
    // 1. Fetch initial data and then initialize the calendar
    fetchAndInitialize();

    // 2. Chat Input Logic
    const userInput = document.getElementById('user-input');
    if (userInput) {
        userInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        });
    }

    // 3. Setup Modal Listeners
    setupModalListeners();

    // 4. Setup Notification Popup
    document.addEventListener('click', function(event) {
        const popup = document.getElementById('notificationPopup');
        const bellIconContainer = document.querySelector('.notification-icon-container');
        if (popup && popup.style.display === 'block' && !popup.contains(event.target) && bellIconContainer && !bellIconContainer.contains(event.target)) {
            closeNotificationPopup();
        }
    });
});

// === CALENDAR INITIALIZATION LOGIC ===

function calculateCalendarView(preferences) {
    const awakeTimeStr = preferences.awake_time || '07:00';
    const sleepTimeStr = preferences.sleep_time || '23:00';

    // Helper to subtract 1 hour (for min slot)
    function subtractHour(timeStr) {
        let [h, m] = timeStr.split(':').map(Number);
        h = (h - 1 + 24) % 24; // Ensures time loops correctly (e.g., 00:00 -> 23:00)
        return `${String(h).padStart(2, '0')}:00:00`;
    }

    // Helper to determine the slot max time (1 hour after sleep time)
    function determineMaxSlot(timeStr) {
        let [h, m] = timeStr.split(':').map(Number);
        h = (h + 1) % 24;

        // If sleep is 23:00, max slot should be 00:00 of the next day (24:00)
        if (h === 0 && sleepTimeStr === '23:00') {
            return '24:00:00';
        }

        return `${String(h).padStart(2, '0')}:00:00`;
    }

    const slotMinTime = subtractHour(awakeTimeStr);
    const slotMaxTime = determineMaxSlot(sleepTimeStr);

    return { slotMinTime, slotMaxTime };
}

function initializeCalendar(preferences) {
    // 1. Calculate dynamic view times
    const { slotMinTime, slotMaxTime } = calculateCalendarView(preferences);

    // 2. Initialize FullCalendar
    const calendarEl = document.getElementById('calendar');
    calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'timeGridWeek',
        headerToolbar: {
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek,timeGridDay'
        },
        slotMinTime: slotMinTime, // Dynamic start time
        slotMaxTime: slotMaxTime, // Dynamic end time
        allDaySlot: true,
        height: '100%',
        events: fetchCalendarEvents, // Function to fetch data
        eventClick: function(info) {
            alert('Event: ' + info.event.title + '\nTime: ' + info.event.start.toLocaleTimeString());
        }
    });
    calendar.render();
}

async function fetchAndInitialize() {
    // 1. Fetch data once at the beginning
    const clientTimestamp = new Date().toISOString();
    const res = await fetch(`/get_schedule?client_timestamp=${clientTimestamp}`);
    const data = await res.json();

    if (data.error) {
        console.error("Error fetching initial schedule:", data.error);
        return;
    }
    scheduleData = data;

    // 2. Initialize Calendar with preferences
    const prefs = scheduleData.preferences || {};
    initializeCalendar(prefs);

    // 3. Check for onboarding required (CRITICAL FIX)
    const isFirstLogin = !scheduleData.onboarding_complete;

    if (isFirstLogin) {
        openModalOnFirstLogin();
    }

    // 4. Trigger check-in (was in DOMContentLoaded)
    triggerDailyCheckin();
}

function openModalOnFirstLogin() {
    const modal = document.getElementById('personalizationModal');
    if (modal) {
        loadPersonalizationData(); // Load current defaults
        modal.classList.remove('hidden');
    }
}

// --- NEW FUNCTION: Mark onboarding as dismissed ---
async function markOnboardingDismissed() {
    // Only call the API if the modal was mandatory (onboarding_complete is false)
    if (!scheduleData.onboarding_complete) {
        try {
            await fetch('/onboarding_dismiss', { method: 'POST' });
            // Update the local flag immediately
            scheduleData.onboarding_complete = true;
            console.log("Onboarding dismissed and marked complete in DB.");
        } catch (e) {
            console.error("Error marking onboarding dismissed:", e);
        }
    }
}

// 3. Daily Check-in Logic
function triggerDailyCheckin() {
    const today = new Date().toLocaleDateString();
    const lastCheckin = localStorage.getItem('lastDailyCheckin');

    // Only run if calendar is rendered and we haven't checked in today
    if (calendar && lastCheckin !== today) {
        const clientTimestamp = new Date().toISOString();

        fetch("/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: "trigger:daily_checkin",
                year: new Date().getFullYear().toString(),
                client_timestamp: clientTimestamp // Pass full ISO string
            })
        })
        .then(res => res.json())
        .then(data => {
            handleChatResponse(data);
        })
        .catch(err => console.error("Error triggering check-in:", err));
        localStorage.setItem('lastDailyCheckin', today);
    }
}


// === CORE DATA FETCHING (Now only for refetching) ===
async function fetchCalendarEvents(fetchInfo, successCallback, failureCallback) {
  try {
    const clientTimestamp = new Date().toISOString();
    const res = await fetch(`/get_schedule?client_timestamp=${clientTimestamp}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    // IMPORTANT: If preferences changed, we must re-initialize the calendar view
    const oldPrefs = scheduleData.preferences;
    scheduleData = data;

    if (JSON.stringify(oldPrefs) !== JSON.stringify(data.preferences)) {
        // Preferences have changed (e.g., user saved new sleep/wake times)
        // We must destroy and recreate the calendar to apply new slotMin/MaxTime
        if (calendar) calendar.destroy();
        initializeCalendar(data.preferences);
    }

    let events = [];

    // A. Map Generated Study Plan (Blue Blocks)
    if (data.generated_plan) {
      data.generated_plan.forEach(item => {
        events.push({
          title: item.task,
          start: `${item.date}T${item.start_time}:00`,
          end: `${item.date}T${item.end_time}:00`,
          color: '#3788d8', // Blue
          extendedProps: { type: 'plan' }
        });
      });
    }

    // B. Map Tasks/Tests Deadlines (Red/Orange All-Day Events)
    if (data.tasks) {
      data.tasks.forEach(item => {
        if (item.deadline) {
           events.push({
             title: `DUE: ${item.name}`,
             start: item.deadline.split('T')[0],
             color: '#e74c3c', // Red
             allDay: true
           });
        }
      });
    }
    if (data.tests) {
        data.tests.forEach(item => {
          if (item.date) {
             events.push({
               title: `TEST: ${item.name}`,
               start: item.date,
               color: '#d35400', // Orange
               allDay: true
             });
          }
        });
    }

    // C. Map Classes (Gray Recurring) - Logic remains correct
    if (data.schedule) {
        const dayMap = { "Sunday": 0, "Monday": 1, "Tuesday": 2, "Wednesday": 3, "Thursday": 4, "Friday": 5, "Saturday": 6 };

        let currentStart = new Date(fetchInfo.start);

        for (let d = 0; d < 7; d++) {
            let loopDate = new Date(currentStart);
            loopDate.setDate(loopDate.getDate() + d);
            let dayNameIndex = loopDate.getDay();

            data.schedule.forEach(cls => {
                if (dayMap[cls.day] === dayNameIndex) {
                    let dateStr = loopDate.toISOString().split('T')[0];
                    events.push({
                        title: cls.subject,
                        start: `${dateStr}T${cls.start_time}:00`,
                        end: `${dateStr}T${cls.end_time}:00`,
                        color: '#7f8c8d' // Gray
                    });
                }
            });
        }
    }

    successCallback(events);
    updateNotificationList(); // Update popup content
  } catch (e) {
    console.error("Error fetching schedule:", e);
    failureCallback(e);
  }
}

// === SEND MESSAGE (Time Aware) ===
async function sendMessage(messageOverride = null) {
  const input = document.getElementById("user-input");
  const chatBox = document.getElementById("chat-box");
  const userMessage = messageOverride || input.value.trim();

  if (!userMessage || !chatBox || !input) return;

  if (!messageOverride) {
    chatBox.innerHTML += `<div class="message user-message">${userMessage}</div>`;
  } else {
    chatBox.innerHTML += `<div class="message user-message"><em>(Selected priority: ${userMessage.split(": ")[1]})</em></div>`;
  }

  input.value = "";
  setTimeout(() => { chatBox.scrollTop = chatBox.scrollHeight; }, 0);

  // CRITICAL: Show the thinking indicator before fetch
  showThinkingIndicator();

  const clientTimestamp = new Date().toISOString();

  try {
      const res = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMessage,
          year: new Date().getFullYear().toString(),
          client_timestamp: clientTimestamp
        })
      });

      removeThinkingIndicator();

      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const data = await res.json();

      handleChatResponse(data);
      if (calendar) calendar.refetchEvents(); // Refresh FullCalendar after chat
  } catch (error) {
       console.error("Error sending message:", error);
       removeThinkingIndicator();
       chatBox.innerHTML += `<div class="message bot-message" style="color: red;">Error: Could not get reply from server.</div>`;
  }
}

// === UX/MODAL HELPERS ===

function showThinkingIndicator() {
    const chatBox = document.getElementById("chat-box");
    if (document.getElementById("bot-thinking-indicator")) return;

    const thinkingDiv = document.createElement('div');
    thinkingDiv.id = "bot-thinking-indicator";
    thinkingDiv.className = "message bot-message";
    thinkingDiv.innerHTML = "<em>Thinking...</em>";
    chatBox.appendChild(thinkingDiv);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function removeThinkingIndicator() {
    const indicator = document.getElementById("bot-thinking-indicator");
    if (indicator) {
        indicator.remove();
    }
}

function handleChatResponse(data) {
    const chatBox = document.getElementById("chat-box");
    if (!data || !data.reply) {
        chatBox.innerHTML += `<div class="message bot-message" style="color: red;">Error: Received an invalid response.</div>`;
        return;
    }
    let formattedReply = data.reply.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');

    chatBox.innerHTML += `<div class="message bot-message">${formattedReply.replace(/\n/g, '<br>')}</div>`;
    setTimeout(() => { chatBox.scrollTop = chatBox.scrollHeight; }, 0);

    if (data.action === 'show_priority_modal' && data.options) {
        openPriorityModal(data.options);
    }
}

function openPriorityModal(options) {
    const modal = document.getElementById('priorityConflictModal');
    const content = document.getElementById('priority-modal-body-content');
    const buttons = document.getElementById('priority-modal-footer-buttons');

    if (!modal) return;

    buttons.innerHTML = '';
    content.innerHTML = '<p>The AI planner found two tasks with the same deadline and priority. Which one should it work on first?</p>';

    options.forEach(optionName => {
        const button = document.createElement('button');
        button.className = 'modal-button-primary';
        button.textContent = `Prioritize: ${optionName}`;
        button.addEventListener('click', () => {
            sendMessage(`User priority choice: ${optionName}`);
            modal.classList.add('hidden');
        });
        buttons.appendChild(button);
    });

    const autoButton = document.createElement('button');
    autoButton.className = 'modal-button-secondary';
    autoButton.textContent = 'Decide for Me (Auto)';
    autoButton.addEventListener('click', () => {
        sendMessage('User priority choice: Auto');
        modal.classList.add('hidden');
    });
    buttons.appendChild(autoButton);
    modal.classList.remove('hidden');
}

// Custom Close Modal Function that handles dismissal logic
const closeModal = () => {
    const modal = document.getElementById('personalizationModal');
    if (modal) {
        // If the modal was forced (onboarding) and the user closes it, mark it as acknowledged
        if (!scheduleData.onboarding_complete) {
            markOnboardingDismissed();
        }
        modal.classList.add('hidden');
    }
};

function setupModalListeners() {
  const modal = document.getElementById('personalizationModal');
  const settingsButton = document.getElementById('settings-button');
  const closeButton = document.getElementById('modal-close-button');
  const cancelButton = document.getElementById('modal-cancel-button');
  const saveButton = document.getElementById('modal-save-button');
  const addWindowButton = document.getElementById('add-window-button');

  const openModal = () => { modal.classList.remove('hidden'); loadPersonalizationData(); }

  if(settingsButton) settingsButton.addEventListener('click', openModal);

  // Use the custom closeModal function for all close triggers:
  if(closeButton) closeButton.addEventListener('click', closeModal);
  if(cancelButton) cancelButton.addEventListener('click', closeModal);

  if(addWindowButton) addWindowButton.addEventListener('click', () => createStudyWindowRow());
  if(saveButton) saveButton.addEventListener('click', savePersonalization);
}

const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function createStudyWindowRow(data = {}) {
    const windowsContainer = document.getElementById('study-windows-container');
    const row = document.createElement('div');
    row.className = 'study-window-row';
    const uiDayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const dayVal = data.day || 'Monday';

    row.innerHTML = `
      <select class="day-select modal-input">
        ${uiDayNames.map(day => `<option value="${day}" ${day === dayVal ? 'selected' : ''}>${day}</option>`).join('')}
      </select>
      <input type="time" class="time-select start-time modal-input" value="${data.start_time || '09:00'}">
      <input type="time" class="time-select end-time modal-input" value="${data.end_time || '10:00'}">
      <select class="focus-select modal-input">
        <option value="high" ${data.focus_level === 'high' ? 'selected' : ''}>High Focus</option>
        <option value="medium" ${data.focus_level === 'medium' || !data.focus_level ? 'selected' : ''}>Medium Focus</option>
        <option value="low" ${data.focus_level === 'low' ? 'selected' : ''}>Low Focus</option>
      </select>
      <button type="button" class="window-delete-button">&times;</button>
    `;
    row.querySelector('.window-delete-button').addEventListener('click', () => row.remove());
    windowsContainer.appendChild(row);
}

async function loadPersonalizationData() {
    await fetchCalendarEvents({}, () => {}, () => {});

    const windowsContainer = document.getElementById('study-windows-container');
    try {
        if(scheduleData.preferences) {
            document.getElementById('awake-time').value = scheduleData.preferences.awake_time || '07:00';
            document.getElementById('sleep-time').value = scheduleData.preferences.sleep_time || '23:00';
        }
        windowsContainer.innerHTML = '';
        if (scheduleData.study_windows && scheduleData.study_windows.length > 0) {
            scheduleData.study_windows.forEach(window => createStudyWindowRow(window));
        } else { createStudyWindowRow(); }
    } catch (e) { console.error(e); }
}

async function savePersonalization() {
    const awakeTime = document.getElementById('awake-time').value;
    const sleepTime = document.getElementById('sleep-time').value;
    const windows = [];
    document.querySelectorAll('.study-window-row').forEach(row => {
      windows.push({
        day: row.querySelector('.day-select').value,
        start_time: row.querySelector('.start-time').value,
        end_time: row.querySelector('.end-time').value,
        focus_level: row.querySelector('.focus-select').value
      });
    });

    const clientTimestamp = new Date().toISOString();

    try {
      const res = await fetch('/save_personalization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            preferences: { awake_time: awakeTime, sleep_time: sleepTime },
            study_windows: windows,
            client_timestamp: clientTimestamp
        })
      });
      const result = await res.json();
      handleChatResponse(result);
      document.getElementById('personalizationModal').classList.add('hidden');

      // IMPORTANT: Re-fetch events to update the calendar view times
      if (calendar) calendar.refetchEvents();

    } catch (e) { console.error(e); }
}

// === NOTIFICATIONS ===
function toggleNotificationPopup() {
    const popup = document.getElementById('notificationPopup');
    popup.style.display = (popup.style.display === 'block') ? 'none' : 'block';
}
function closeNotificationPopup() { document.getElementById('notificationPopup').style.display = 'none'; }

function updateNotificationList() {
    const listDiv = document.getElementById('notification-list');
    listDiv.innerHTML = '';
    const now = new Date();
    let hasItems = false;

    const sortedTasks = (scheduleData.tasks || [])
        .slice()
        .sort((a, b) => new Date(a.deadline) - new Date(b.deadline));

    if (sortedTasks.length > 0) {
        sortedTasks.forEach(task => {
            if(task.deadline) {
                const d = new Date(task.deadline);
                if (d > now) {
                    hasItems = true;
                    listDiv.innerHTML += `<p><b>${task.name}</b> - Due ${d.toLocaleDateString()} at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>`;
                }
            }
        });
    }
    if(!hasItems) listDiv.innerHTML = '<p>No pending tasks found.</p>';
}