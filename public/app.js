// ==========================================================================
// MumaLINK Clinician Triage Dashboard Controller
// Multi-Hospital Triage, WhatsApp Surveillance & Real-Time Two-Way Live Chat
// ==========================================================================

const authToken = localStorage.getItem('mumalink_token');
if (!authToken) {
  window.location.href = '/login';
}

let allMothers = [];
let currentFilterTier = 'all';
let searchQuery = '';
let selectedMotherId = null;

// Multi-tenant & Super Admin State
let activeHospitalId = 'all';
let isSuperAdmin = false;
let partnerHospitals = [];

// DOM Elements - Left Column (Inbox)
const mothersListContainer = document.getElementById('mothersListContainer');
const searchInput = document.getElementById('searchInput');
const riskTabs = document.getElementById('riskTabs');
const refreshBtn = document.getElementById('refreshBtn');

// Header & Super Admin Elements
const superAdminPill = document.getElementById('superAdminPill');
const hospitalContextSelector = document.getElementById('hospitalContextSelector');
const openAddHospitalBtn = document.getElementById('openAddHospitalBtn');
const hospitalNameDisplay = document.getElementById('hospitalNameDisplay');

// Counter Badges
const tabCountAll = document.getElementById('tabCountAll');
const tabCountCritical = document.getElementById('tabCountCritical');
const tabCountModerate = document.getElementById('tabCountModerate');
const tabCountNormal = document.getElementById('tabCountNormal');
const sidebarCriticalBadge = document.getElementById('sidebarCriticalBadge');
const sidebarTotalBadge = document.getElementById('sidebarTotalBadge');

// Clinician Profile
const userAvatar = document.getElementById('userAvatar');
const userName = document.getElementById('userName');
const userEmail = document.getElementById('userEmail');
const signOutBtn = document.getElementById('signOutBtn');

// Detail Workspace Elements (Right Column)
const detailPane = document.getElementById('detailPane');
const detailAvatar = document.getElementById('detailAvatar');
const inboxPane = document.querySelector('.inbox-pane');
const mobileBackBtn = document.getElementById('mobileBackBtn');
const drawerPatientName = document.getElementById('drawerPatientName');
const drawerPatientParity = document.getElementById('drawerPatientParity');
const drawerPhone = document.getElementById('drawerPhone');
const drawerDeliveryDate = document.getElementById('drawerDeliveryDate');
const drawerDeliveryType = document.getElementById('drawerDeliveryType');
const drawerRiskBadge = document.getElementById('drawerRiskBadge');
const drawerLatestScore = document.getElementById('drawerLatestScore');
const drawerScoreEvaluation = document.getElementById('drawerScoreEvaluation');
const drawerScoreDescription = document.getElementById('drawerScoreDescription');
const epdsQuestionsGrid = document.getElementById('epdsQuestionsGrid');
const drawerCheckinList = document.getElementById('drawerCheckinList');
const drawerPastNotes = document.getElementById('drawerPastNotes');
const addNoteForm = document.getElementById('addNoteForm');
const resolveCheckboxWrap = document.getElementById('resolveCheckboxWrap');
const triggerWhatsAppBtn = document.getElementById('triggerWhatsAppBtn');

// Workspace View Switchers & Two-Way Live Chat
const tabLiveChat = document.getElementById('tabLiveChat');
const tabClinicalTriage = document.getElementById('tabClinicalTriage');
const liveChatView = document.getElementById('liveChatView');
const clinicalTriageView = document.getElementById('clinicalTriageView');
const chatFeedStream = document.getElementById('chatFeedStream');
const chatComposerForm = document.getElementById('chatComposerForm');
const chatComposerInput = document.getElementById('chatComposerInput');
const chatComposerSubmit = document.getElementById('chatComposerSubmit');

// Modals
const enrollModalOverlay = document.getElementById('enrollModalOverlay');
const openEnrollBtn = document.getElementById('openEnrollBtn');
const closeEnrollModalBtn = document.getElementById('closeEnrollModalBtn');
const cancelEnrollBtn = document.getElementById('cancelEnrollBtn');
const enrollMotherForm = document.getElementById('enrollMotherForm');
const enrollHospitalGroup = document.getElementById('enrollHospitalGroup');
const enrollHospitalSelect = document.getElementById('enrollHospitalSelect');

const simulatorModalOverlay = document.getElementById('simulatorModalOverlay');
const openSimulatorBtn = document.getElementById('openSimulatorBtn');
const closeSimulatorModalBtn = document.getElementById('closeSimulatorModalBtn');
const cancelSimulatorBtn = document.getElementById('cancelSimulatorBtn');
const simulatorForm = document.getElementById('simulatorForm');
const simMotherSelect = document.getElementById('simMotherSelect');

const addHospitalModalOverlay = document.getElementById('addHospitalModalOverlay');
const closeAddHospitalModalBtn = document.getElementById('closeAddHospitalModalBtn');
const cancelAddHospitalBtn = document.getElementById('cancelAddHospitalBtn');
const addHospitalForm = document.getElementById('addHospitalForm');

// Toast Container
const toastContainer = document.getElementById('toastContainer');

// Helper: Render modern Lucide icons with 1.6px hairline stroke
function renderIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons({
      attrs: {
        'stroke-width': 1.6
      }
    });
  }
}

// ==========================================================================
// Initialization
// ==========================================================================
document.addEventListener('DOMContentLoaded', async () => {
  // Set default delivery date on enrollment form
  const now = new Date();
  const deliveryDateInput = document.getElementById('enrollDeliveryDate');
  if (deliveryDateInput) {
    deliveryDateInput.value = now.toISOString().split('T')[0];
  }

  // Set and live-refresh logged-in clinician profile
  function renderClinicianProfile(clinician) {
    if (!clinician) return;
    if (userName) userName.textContent = clinician.full_name || 'Dr. Clinician';
    if (userEmail) userEmail.textContent = clinician.email || 'doctor@mumalink.com';
    
    const initials = (clinician.full_name || 'WS')
      .split(' ')
      .map(n => n[0])
      .slice(-2)
      .join('')
      .toUpperCase();
    if (userAvatar) userAvatar.textContent = initials || 'WS';

    if (clinician.role === 'Super Admin') {
      isSuperAdmin = true;
    }
  }

  const storedClinician = localStorage.getItem('mumalink_clinician');
  if (storedClinician) {
    try {
      renderClinicianProfile(JSON.parse(storedClinician));
    } catch (e) {
      console.error(e);
    }
  }

  // Live profile synchronization with backend
  try {
    const meRes = await authFetch('/api/auth/me');
    if (meRes.ok) {
      const liveClinician = await meRes.json();
      localStorage.setItem('mumalink_clinician', JSON.stringify(liveClinician));
      renderClinicianProfile(liveClinician);
    }
  } catch (err) {
    console.error('Clinician profile sync notice:', err);
  }

  setupEventListeners();
  await loadHospitalsList();
  await loadDashboardStats();
  await loadMothers();
  renderIcons();
});

// ==========================================================================
// Event Listeners
// ==========================================================================
function setupEventListeners() {
  // Mobile Back Button
  if (mobileBackBtn) {
    mobileBackBtn.addEventListener('click', () => {
      if (detailPane) detailPane.classList.remove('mobile-active');
      if (inboxPane) inboxPane.classList.remove('mobile-hidden');
    });
  }

  // Sign Out
  if (signOutBtn) {
    signOutBtn.addEventListener('click', () => {
      localStorage.removeItem('mumalink_token');
      localStorage.removeItem('mumalink_clinician');
      window.location.href = '/login';
    });
  }

  // Hospital Context Switcher (Super Admin)
  if (hospitalContextSelector) {
    hospitalContextSelector.addEventListener('change', (e) => {
      activeHospitalId = e.target.value;
      loadDashboardStats();
      loadMothers();
    });
  }

  // Workspace View Switchers: Live Chat vs Clinical Triage
  if (tabLiveChat && tabClinicalTriage) {
    tabLiveChat.addEventListener('click', () => {
      tabLiveChat.classList.add('active');
      tabClinicalTriage.classList.remove('active');
      if (liveChatView) liveChatView.style.display = 'flex';
      if (clinicalTriageView) clinicalTriageView.style.display = 'none';
      scrollChatToBottom();
    });

    tabClinicalTriage.addEventListener('click', () => {
      tabClinicalTriage.classList.add('active');
      tabLiveChat.classList.remove('active');
      if (liveChatView) liveChatView.style.display = 'none';
      if (clinicalTriageView) clinicalTriageView.style.display = 'block';
    });
  }

  // Quick Clinical Prompt Chips
  document.querySelectorAll('.quick-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      if (chatComposerInput) {
        chatComposerInput.value = chip.dataset.msg || chip.textContent;
        chatComposerInput.focus();
      }
    });
  });

  // Live WhatsApp Composer Form Submission
  if (chatComposerForm) {
    chatComposerForm.addEventListener('submit', handleSendChatMessage);
  }

  // Search filter
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      renderMothersList();
    });
  }

  // Clinical Triage Filter Selectors
  if (riskTabs) {
    riskTabs.addEventListener('click', (e) => {
      const pill = e.target.closest('.filter-pill');
      if (!pill) return;
      riskTabs.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
      pill.classList.add('active');
      currentFilterTier = pill.dataset.tier;
      renderMothersList();
    });
  }

  // Sidebar Navigation & Modals
  const navHome = document.getElementById('navHome');
  const navSurveillance = document.getElementById('navSurveillance');
  const navStaffer = document.getElementById('navStaffer');
  const navNotifications = document.getElementById('navNotifications');
  const navProfile = document.getElementById('navProfile');
  const navHelp = document.getElementById('navHelp');
  const navSettings = document.getElementById('navSettings');

  const clinicalTeamModalOverlay = document.getElementById('clinicalTeamModalOverlay');
  const notificationsModalOverlay = document.getElementById('notificationsModalOverlay');
  const protocolGuideModalOverlay = document.getElementById('protocolGuideModalOverlay');
  const helpPrivacyModalOverlay = document.getElementById('helpPrivacyModalOverlay');
  const hospitalSettingsModalOverlay = document.getElementById('hospitalSettingsModalOverlay');

  if (navHome) {
    navHome.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('.sidebar-nav .nav-item').forEach(el => el.classList.remove('active'));
      navHome.classList.add('active');
      if (searchInput) searchInput.value = '';
      searchQuery = '';
      currentFilterTier = 'all';
      if (riskTabs) {
        riskTabs.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
        const allTab = riskTabs.querySelector('[data-tier="all"]');
        if (allTab) allTab.classList.add('active');
      }
      renderMothersList();
      if (detailPane) detailPane.classList.remove('mobile-active');
      if (inboxPane) inboxPane.classList.remove('mobile-hidden');
    });
  }

  if (navSurveillance) {
    navSurveillance.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('.sidebar-nav .nav-item').forEach(el => el.classList.remove('active'));
      navSurveillance.classList.add('active');
      if (tabLiveChat) tabLiveChat.click();
    });
  }

  if (navStaffer) {
    navStaffer.addEventListener('click', (e) => {
      e.preventDefault();
      openModal(clinicalTeamModalOverlay);
    });
  }
  const closeClinicalTeamModalBtn = document.getElementById('closeClinicalTeamModalBtn');
  const closeClinicalTeamFooterBtn = document.getElementById('closeClinicalTeamFooterBtn');
  if (closeClinicalTeamModalBtn) closeClinicalTeamModalBtn.addEventListener('click', () => closeModal(clinicalTeamModalOverlay));
  if (closeClinicalTeamFooterBtn) closeClinicalTeamFooterBtn.addEventListener('click', () => closeModal(clinicalTeamModalOverlay));

  if (navNotifications) {
    navNotifications.addEventListener('click', (e) => {
      e.preventDefault();
      openModal(notificationsModalOverlay);
    });
  }
  const closeNotificationsModalBtn = document.getElementById('closeNotificationsModalBtn');
  const closeNotificationsFooterBtn = document.getElementById('closeNotificationsFooterBtn');
  const clearNotificationsBtn = document.getElementById('clearNotificationsBtn');
  if (closeNotificationsModalBtn) closeNotificationsModalBtn.addEventListener('click', () => closeModal(notificationsModalOverlay));
  if (closeNotificationsFooterBtn) closeNotificationsFooterBtn.addEventListener('click', () => closeModal(notificationsModalOverlay));
  if (clearNotificationsBtn) {
    clearNotificationsBtn.addEventListener('click', () => {
      const list = document.getElementById('notificationsList');
      if (list) list.innerHTML = `<div class="empty-state" style="padding: 20px; text-align: center; color: var(--text-muted);">All triage notifications cleared.</div>`;
      showToast("Notifications cleared.");
    });
  }

  if (navProfile) {
    navProfile.addEventListener('click', (e) => {
      e.preventDefault();
      openModal(protocolGuideModalOverlay);
    });
  }
  const closeProtocolModalBtn = document.getElementById('closeProtocolModalBtn');
  const closeProtocolFooterBtn = document.getElementById('closeProtocolFooterBtn');
  if (closeProtocolModalBtn) closeProtocolModalBtn.addEventListener('click', () => closeModal(protocolGuideModalOverlay));
  if (closeProtocolFooterBtn) closeProtocolFooterBtn.addEventListener('click', () => closeModal(protocolGuideModalOverlay));

  if (navHelp) {
    navHelp.addEventListener('click', (e) => {
      e.preventDefault();
      openModal(helpPrivacyModalOverlay);
    });
  }
  const closeHelpModalBtn = document.getElementById('closeHelpModalBtn');
  const closeHelpFooterBtn = document.getElementById('closeHelpFooterBtn');
  if (closeHelpModalBtn) closeHelpModalBtn.addEventListener('click', () => closeModal(helpPrivacyModalOverlay));
  if (closeHelpFooterBtn) closeHelpFooterBtn.addEventListener('click', () => closeModal(helpPrivacyModalOverlay));

  if (navSettings) {
    navSettings.addEventListener('click', (e) => {
      e.preventDefault();
      openModal(hospitalSettingsModalOverlay);
    });
  }
  const closeHospitalSettingsModalBtn = document.getElementById('closeHospitalSettingsModalBtn');
  const closeHospitalSettingsFooterBtn = document.getElementById('closeHospitalSettingsFooterBtn');
  if (closeHospitalSettingsModalBtn) closeHospitalSettingsModalBtn.addEventListener('click', () => closeModal(hospitalSettingsModalOverlay));
  if (closeHospitalSettingsFooterBtn) closeHospitalSettingsFooterBtn.addEventListener('click', () => closeModal(hospitalSettingsModalOverlay));

  // Refresh
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadDashboardStats();
      loadMothers();
      if (selectedMotherId) loadWhatsAppChat(selectedMotherId);
      showToast("Triage stream updated from Render PostgreSQL.");
    });
  }

  // Direct WhatsApp Check-in Trigger (SendPulse)
  if (triggerWhatsAppBtn) {
    triggerWhatsAppBtn.addEventListener('click', async () => {
      if (!selectedMotherId) return;
      triggerWhatsAppBtn.disabled = true;
      triggerWhatsAppBtn.innerHTML = '<span>Transmitting...</span>';
      try {
        const res = await authFetch(`/api/mothers/${selectedMotherId}/send-checkin`, {
          method: 'POST'
        });
        const data = await res.json();
        if (data.success) {
          showToast(data.message || 'WhatsApp check-in delivered.');
          loadPatientCase(selectedMotherId);
          loadWhatsAppChat(selectedMotherId);
          loadMothers();
        } else {
          showToast(data.error || 'Failed to trigger check-in.');
        }
      } catch (err) {
        showToast('Error dispatching WhatsApp check-in.');
      } finally {
        triggerWhatsAppBtn.disabled = false;
        triggerWhatsAppBtn.innerHTML = '<i data-lucide="send"></i><span>Send WhatsApp Check-in</span>';
        renderIcons();
      }
    });
  }

  // Enroll Modal Controls
  if (openEnrollBtn) openEnrollBtn.addEventListener('click', () => openModal(enrollModalOverlay));
  if (closeEnrollModalBtn) closeEnrollModalBtn.addEventListener('click', () => closeModal(enrollModalOverlay));
  if (cancelEnrollBtn) cancelEnrollBtn.addEventListener('click', () => closeModal(enrollModalOverlay));
  if (enrollMotherForm) enrollMotherForm.addEventListener('submit', handleEnrollSubmit);

  // Simulator Modal Controls
  if (openSimulatorBtn) {
    openSimulatorBtn.addEventListener('click', () => {
      populateSimulatorDropdown();
      openModal(simulatorModalOverlay);
    });
  }
  if (closeSimulatorModalBtn) closeSimulatorModalBtn.addEventListener('click', () => closeModal(simulatorModalOverlay));
  if (cancelSimulatorBtn) cancelSimulatorBtn.addEventListener('click', () => closeModal(simulatorModalOverlay));
  if (simulatorForm) simulatorForm.addEventListener('submit', handleSimulatorSubmit);

  // Add Partner Hospital Modal Controls (Super Admin)
  if (openAddHospitalBtn) openAddHospitalBtn.addEventListener('click', () => openModal(addHospitalModalOverlay));
  if (closeAddHospitalModalBtn) closeAddHospitalModalBtn.addEventListener('click', () => closeModal(addHospitalModalOverlay));
  if (cancelAddHospitalBtn) cancelAddHospitalBtn.addEventListener('click', () => closeModal(addHospitalModalOverlay));
  if (addHospitalForm) addHospitalForm.addEventListener('submit', handleAddHospitalSubmit);

  // Note submission form
  if (addNoteForm) addNoteForm.addEventListener('submit', handleAddNoteSubmit);
}

// Authenticated fetch wrapper
async function authFetch(url, options = {}) {
  const token = localStorage.getItem('mumalink_token');
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
    'Authorization': `Bearer ${token}`
  };

  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    localStorage.removeItem('mumalink_token');
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  return res;
}

// ==========================================================================
// Hospital Management & Data Fetching
// ==========================================================================
async function loadHospitalsList() {
  try {
    const res = await fetch('/api/hospitals/public');
    if (res.ok) {
      partnerHospitals = await res.json();
      
      // Populate context switch dropdown
      if (hospitalContextSelector) {
        let optionsHtml = '<option value="all">Network Overview (All Hospitals)</option>';
        partnerHospitals.forEach(h => {
          optionsHtml += `<option value="${h.id}">${escapeHtml(h.name)} (${escapeHtml(h.state)})</option>`;
        });
        hospitalContextSelector.innerHTML = optionsHtml;
        hospitalContextSelector.value = activeHospitalId;
      }

      // Populate hospital select inside enroll modal
      if (enrollHospitalSelect) {
        enrollHospitalSelect.innerHTML = partnerHospitals.map(h => 
          `<option value="${h.id}">${escapeHtml(h.name)}</option>`
        ).join('');
      }
    }
  } catch (err) {
    console.error("Failed to load partner hospitals:", err);
  }
}

async function loadDashboardStats() {
  try {
    const query = activeHospitalId ? `?hospital_id=${encodeURIComponent(activeHospitalId)}` : '';
    const res = await authFetch(`/api/stats${query}`);
    const data = await res.json();

    if (data.is_super_admin) {
      isSuperAdmin = true;
      if (superAdminPill) superAdminPill.style.display = 'inline-block';
      if (openAddHospitalBtn) openAddHospitalBtn.style.display = 'inline-flex';
      if (hospitalContextSelector) hospitalContextSelector.style.display = 'inline-block';
      if (enrollHospitalGroup) enrollHospitalGroup.style.display = 'block';
    } else {
      isSuperAdmin = false;
      if (superAdminPill) superAdminPill.style.display = 'none';
      if (openAddHospitalBtn) openAddHospitalBtn.style.display = 'none';
      if (hospitalContextSelector) hospitalContextSelector.style.display = 'none';
      if (enrollHospitalGroup) enrollHospitalGroup.style.display = 'none';
    }

    if (hospitalNameDisplay) {
      hospitalNameDisplay.textContent = data.pilot_hospital || 'Network Overview';
    }

    if (tabCountAll) tabCountAll.textContent = data.total_mothers || 0;
    if (tabCountCritical) tabCountCritical.textContent = data.critical_count || 0;
    if (tabCountModerate) tabCountModerate.textContent = data.moderate_count || 0;
    if (tabCountNormal) tabCountNormal.textContent = data.normal_count || 0;

    if (sidebarCriticalBadge) sidebarCriticalBadge.textContent = data.critical_count || 0;
    if (sidebarTotalBadge) sidebarTotalBadge.textContent = data.total_mothers || 0;
  } catch (err) {
    console.error("Error loading stats from PostgreSQL:", err);
  }
}

async function loadMothers(isQuiet = false) {
  try {
    const query = activeHospitalId ? `?hospital_id=${encodeURIComponent(activeHospitalId)}` : '';
    const res = await authFetch(`/api/mothers${query}`);
    allMothers = await res.json();
    renderMothersList();

    // Default to the first critical patient or first patient if none selected
    if (!selectedMotherId && allMothers.length > 0) {
      const topCritical = allMothers.find(m => m.current_risk_tier === 'critical');
      loadPatientCase(topCritical ? topCritical.id : allMothers[0].id);
    } else if (selectedMotherId && allMothers.length > 0) {
      const stillExists = allMothers.some(m => m.id === selectedMotherId);
      if (stillExists) {
        if (isQuiet) {
          loadPatientCase(selectedMotherId, true);
          loadWhatsAppChat(selectedMotherId, true);
        }
      } else {
        loadPatientCase(allMothers[0].id);
      }
    } else if (allMothers.length === 0) {
      clearDetailPane();
    }
  } catch (err) {
    if (!isQuiet) {
      console.error("Error loading mothers from PostgreSQL:", err);
      mothersListContainer.innerHTML = `<div class="empty-state">Unable to load patient records from PostgreSQL.</div>`;
    }
  }
}

function clearDetailPane() {
  selectedMotherId = null;
  drawerPatientName.textContent = "No Enrolled Mothers Yet";
  drawerPatientParity.textContent = "Hospital Maternity Register";
  drawerDeliveryDate.textContent = "--";
  drawerDeliveryType.textContent = "--";
  drawerPhone.textContent = "--";
  detailAvatar.textContent = "ML";
  const badgeEl = document.getElementById('drawerRiskBadge');
  if (badgeEl) badgeEl.outerHTML = `<span id="drawerRiskBadge" class="badge">Awaiting Patients</span>`;
  drawerLatestScore.textContent = "0";
  drawerScoreEvaluation.textContent = "No Active Cases";
  drawerScoreEvaluation.style.color = "var(--text-muted)";
  drawerScoreDescription.textContent = "Mothers enrolled in person or via WhatsApp will automatically populate here in real time.";
  epdsQuestionsGrid.innerHTML = `<div style="grid-column: span 2; text-align: center; color: var(--text-muted); font-size: 13px; padding: 24px;">No clinical screenings recorded yet.</div>`;
  drawerCheckinList.innerHTML = `<div class="empty-state">No WhatsApp surveillance activity recorded yet.</div>`;
  drawerPastNotes.innerHTML = `<div class="empty-state">No doctor notes yet.</div>`;
  if (chatFeedStream) {
    chatFeedStream.innerHTML = `<div class="chat-empty-state"><p>Select a patient from the left column to view live WhatsApp messages.</p></div>`;
  }
}

// ==========================================================================
// Patient Triage Inbox Stream
// ==========================================================================
function renderMothersList() {
  const filtered = allMothers.filter(m => {
    const matchesTier = currentFilterTier === 'all' || m.current_risk_tier === currentFilterTier;
    const matchesSearch = !searchQuery || 
      m.full_name.toLowerCase().includes(searchQuery) || 
      m.phone_number.includes(searchQuery);
    return matchesTier && matchesSearch;
  });

  if (filtered.length === 0) {
    mothersListContainer.innerHTML = `
      <div class="empty-state">
        No mothers matching the selected criteria.
      </div>
    `;
    return;
  }

  // Group by priority
  const criticalGroup = filtered.filter(m => m.current_risk_tier === 'critical');
  const moderateGroup = filtered.filter(m => m.current_risk_tier === 'moderate');
  const normalGroup = filtered.filter(m => m.current_risk_tier === 'normal');

  let html = '';

  if (criticalGroup.length > 0) {
    html += `
      <div class="group-section-header">
        <span>Immediate Attention (${criticalGroup.length})</span>
        <i data-lucide="chevron-down" class="group-chevron"></i>
      </div>
    `;
    html += criticalGroup.map(m => renderPatientItem(m)).join('');
  }

  if (moderateGroup.length > 0) {
    html += `
      <div class="group-section-header" style="margin-top: 10px;">
        <span>Moderate Monitoring (${moderateGroup.length})</span>
        <i data-lucide="chevron-down" class="group-chevron"></i>
      </div>
    `;
    html += moderateGroup.map(m => renderPatientItem(m)).join('');
  }

  if (normalGroup.length > 0) {
    html += `
      <div class="group-section-header" style="margin-top: 10px;">
        <span>Stable / Healthy Recovery (${normalGroup.length})</span>
        <i data-lucide="chevron-down" class="group-chevron"></i>
      </div>
    `;
    html += normalGroup.map(m => renderPatientItem(m)).join('');
  }

  mothersListContainer.innerHTML = html;
  renderIcons();
}

function renderPatientItem(m) {
  const isSelected = m.id === selectedMotherId;
  const initials = (m.full_name || 'M')
    .split(' ')
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const daysSinceDelivery = calculatePostpartumDays(m.delivery_date);
  const timeLabel = formatRelativeTime(m.last_checkin_date);

  let snippet = m.mother_notes || "WhatsApp check-in scheduled...";
  if (m.current_risk_tier === 'critical') {
    snippet = "Elevated EPDS Score (Alert dispatched to care team)";
  } else if (m.current_risk_tier === 'moderate') {
    snippet = "Reported fatigue and emotional adjustment stress";
  } else {
    snippet = "Resting well, baby feeding calmly";
  }

  const tierClass = `score-${m.current_risk_tier}`;
  const avatarClass = `avatar-${m.current_risk_tier}`;

  return `
    <div class="patient-item ${isSelected ? 'selected' : ''}" onclick="loadPatientCase('${m.id}')">
      <div class="item-avatar-wrap">
        <div class="item-avatar ${avatarClass}">${initials}</div>
      </div>
      <div class="item-details">
        <div class="item-top-row">
          <span class="item-name">${escapeHtml(m.full_name)}</span>
          <span class="item-time">${timeLabel}</span>
        </div>
        <span class="item-message-preview">${escapeHtml(snippet)}</span>
        <div class="item-score-pill ${tierClass}">
          <span>EPDS ${m.last_score || 0}/30</span>
          <span>• ${daysSinceDelivery}</span>
        </div>
      </div>
    </div>
  `;
}

// ==========================================================================
// Right Column: Load Active Patient Case & Live WhatsApp Stream
// ==========================================================================
async function loadPatientCase(motherId, isQuiet = false) {
  selectedMotherId = motherId;
  renderMothersList(); // Update selected class

  // Mobile responsiveness: Show case workstation on small screens
  if (detailPane) detailPane.classList.add('mobile-active');
  if (inboxPane) inboxPane.classList.add('mobile-hidden');

  if (!isQuiet) {
    drawerPatientName.textContent = "Loading clinical file...";
    epdsQuestionsGrid.innerHTML = `<div class="loading-state">Fetching EPDS clinical metrics...</div>`;
    drawerCheckinList.innerHTML = `<div class="loading-state">Loading WhatsApp surveillance stream...</div>`;
    drawerPastNotes.innerHTML = `<div class="loading-state">Loading intervention records...</div>`;
  }

  // Load live WhatsApp chat simultaneously
  loadWhatsAppChat(motherId, isQuiet);

  try {
    const res = await authFetch(`/api/mothers/${motherId}`);
    const data = await res.json();
    const { mother, checkins, notes } = data;

    // Header Details
    drawerPatientName.textContent = mother.full_name;
    drawerPatientParity.textContent = mother.parity;
    drawerDeliveryDate.textContent = `Delivered ${mother.delivery_date ? mother.delivery_date.split('T')[0] : '--'}`;
    drawerDeliveryType.textContent = mother.delivery_type;
    drawerPhone.textContent = mother.phone_number;

    const initials = (mother.full_name || 'M')
      .split(' ')
      .map(w => w[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
    detailAvatar.textContent = initials;

    // Risk badge & score
    drawerRiskBadge.outerHTML = getRiskBadge(mother.current_risk_tier);
    drawerLatestScore.textContent = mother.last_score || 0;

    if (mother.current_risk_tier === 'critical') {
      drawerScoreEvaluation.textContent = "High Risk of Postpartum Depression";
      drawerScoreEvaluation.style.color = "#DC2626";
      drawerScoreDescription.textContent = "EPDS score is 13 or greater. Protocol advises priority telephonic or clinical outreach.";
      resolveCheckboxWrap.style.display = 'flex';
    } else if (mother.current_risk_tier === 'moderate') {
      drawerScoreEvaluation.textContent = "Moderate Emotional Distress / Adjustment Difficulty";
      drawerScoreEvaluation.style.color = "#D97706";
      drawerScoreDescription.textContent = "EPDS score is 10 to 12. Closer check-in cadence active with family support monitoring.";
      resolveCheckboxWrap.style.display = 'none';
    } else {
      drawerScoreEvaluation.textContent = "Healthy Range / Low Risk";
      drawerScoreEvaluation.style.color = "#059669";
      drawerScoreDescription.textContent = "Patient scores within standard recovery bounds. Routine WhatsApp surveillance active.";
      resolveCheckboxWrap.style.display = 'none';
    }

    // Populate EPDS Questions Grid from latest checkin
    const latestCheckin = checkins && checkins[0];
    if (latestCheckin && (latestCheckin.q1_laugh !== null && latestCheckin.q1_laugh !== undefined)) {
      epdsQuestionsGrid.innerHTML = `
        <div class="epds-grid-item"><span>1. Ability to Laugh / Humor:</span> <strong>${latestCheckin.q1_laugh}/3</strong></div>
        <div class="epds-grid-item"><span>2. Looking Forward / Enjoyment:</span> <strong>${latestCheckin.q2_enjoyment}/3</strong></div>
        <div class="epds-grid-item"><span>3. Unnecessary Self-Blame:</span> <strong>${latestCheckin.q3_blame}/3</strong></div>
        <div class="epds-grid-item"><span>4. Anxiety & Worry:</span> <strong>${latestCheckin.q4_anxious}/3</strong></div>
        <div class="epds-grid-item"><span>5. Panic or Fear:</span> <strong>${latestCheckin.q5_scared}/3</strong></div>
        <div class="epds-grid-item"><span>6. Coping Stress:</span> <strong>${latestCheckin.q6_cope}/3</strong></div>
        <div class="epds-grid-item"><span>7. Difficulty Sleeping:</span> <strong>${latestCheckin.q7_sleep}/3</strong></div>
        <div class="epds-grid-item"><span>8. Sadness & Misery:</span> <strong>${latestCheckin.q8_sad}/3</strong></div>
        <div class="epds-grid-item"><span>9. Crying Spells:</span> <strong>${latestCheckin.q9_cry}/3</strong></div>
        <div class="epds-grid-item ${latestCheckin.q10_selfharm > 0 ? 'risk-alert' : ''}">
          <span>10. Self-Harm Thoughts:</span> 
          <strong>${latestCheckin.q10_selfharm}/3 ${latestCheckin.q10_selfharm > 0 ? '[CRITICAL ALERT]' : ''}</strong>
        </div>
      `;
    } else {
      epdsQuestionsGrid.innerHTML = `
        <div style="grid-column: span 2; text-align: center; color: var(--text-muted); font-size: 12px; padding: 12px;">
          Initial mood check-in recorded. Complete 10-question EPDS screening will render here upon completion.
        </div>
      `;
    }

    // Populate WhatsApp Surveillance Stream
    if (!checkins || checkins.length === 0) {
      drawerCheckinList.innerHTML = `<div class="empty-state">No check-in responses recorded yet in PostgreSQL.</div>`;
    } else {
      drawerCheckinList.innerHTML = checkins.map(c => `
        <div class="chat-bubble-container">
          <div class="chat-bubble-header">
            <span>${escapeHtml(c.checkin_day_label)} • Score: <strong>${c.epds_score}/30</strong></span>
            <span>${formatDateTime(c.created_at)}</span>
          </div>
          <div class="chat-bubble">
            ${escapeHtml(c.mother_notes || "Check-in completed via WhatsApp.")}
          </div>
        </div>
      `).join('');
    }

    // Populate Notes
    if (!notes || notes.length === 0) {
      drawerPastNotes.innerHTML = `<div class="empty-state">No clinical notes recorded yet for this patient.</div>`;
    } else {
      drawerPastNotes.innerHTML = notes.map(n => `
        <div class="note-bubble">
          <div class="note-bubble-meta">
            <span class="note-bubble-author">${escapeHtml(n.clinician_name)} (${formatActionType(n.action_type)})</span>
            <span>${formatDateTime(n.created_at)}</span>
          </div>
          <p class="note-bubble-text">${escapeHtml(n.note)}</p>
        </div>
      `).join('');
    }

    renderIcons();
  } catch (err) {
    console.error("Error loading patient case:", err);
    showToast("Error retrieving patient records.");
  }
}

function getDisplayDateLabel(dateStr) {
  if (!dateStr) return 'Today';
  const d = new Date(dateStr);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ==========================================================================
// Two-Way WhatsApp Live Chat Engine (SendPulse Meta-Approved Bot Stream)
// ==========================================================================
let lastRenderedChatJson = '';

async function loadWhatsAppChat(motherId, isQuiet = false) {
  if (!motherId || !chatFeedStream) return;

  if (!isQuiet && (!chatFeedStream.innerHTML || chatFeedStream.innerHTML.includes('loading-state'))) {
    chatFeedStream.innerHTML = `<div class="loading-state">Connecting to WhatsApp live stream...</div>`;
  }

  try {
    const res = await authFetch(`/api/mothers/${motherId}/messages`);
    const data = await res.json();
    const messages = data.messages || [];

    // Avoid unnecessary DOM re-renders if chat has not changed
    const currentJson = JSON.stringify(messages);
    if (currentJson === lastRenderedChatJson && isQuiet) {
      return;
    }
    lastRenderedChatJson = currentJson;

    if (messages.length === 0) {
      chatFeedStream.innerHTML = `
        <div class="chat-empty-state">
          <i data-lucide="message-square-dashed"></i>
          <h4>No WhatsApp messages yet</h4>
          <p>Send an initial message below to start two-way clinical communication on WhatsApp.</p>
        </div>
      `;
      renderIcons();
      return;
    }

    // Group consecutive messages by sender to eliminate blank gaps
    const groups = [];
    messages.forEach(msg => {
      const isInbound = msg.direction === 'inbound';
      const isBot = msg.sender_type === 'bot';
      const isClinician = msg.sender_type === 'clinician';

      let senderClass = 'mother';
      let senderName = msg.sender_name || 'Mother';

      if (isBot) {
        senderClass = 'bot';
        senderName = 'MumaLINK Bot';
      } else if (isClinician) {
        senderClass = 'clinician';
        senderName = msg.sender_name || 'Doctor';
      }

      const timeFormatted = formatMessageTime(msg.created_at);
      const dateFormatted = msg.created_at ? new Date(msg.created_at).toLocaleDateString() : '';

      const lastGroup = groups[groups.length - 1];
      if (lastGroup && 
          lastGroup.isInbound === isInbound && 
          lastGroup.senderClass === senderClass &&
          lastGroup.dateFormatted === dateFormatted) {
        lastGroup.messages.push(msg);
        lastGroup.timeFormatted = timeFormatted;
      } else {
        groups.push({
          isInbound,
          isBot,
          isClinician,
          senderClass,
          senderName,
          timeFormatted,
          dateFormatted,
          messages: [msg]
        });
      }
    });

    let html = '';
    let lastDate = '';

    groups.forEach(group => {
      if (group.dateFormatted && group.dateFormatted !== lastDate) {
        lastDate = group.dateFormatted;
        const displayDate = getDisplayDateLabel(group.messages[0].created_at);
        html += `<div class="chat-date-divider"><span>${displayDate}</span></div>`;
      }

      const totalInGroup = group.messages.length;

      html += `
        <div class="chat-msg-group ${group.isInbound ? 'inbound' : 'outbound'} ${group.senderClass}">
          <div class="chat-group-meta">
            <span class="sender-pill ${group.senderClass}">${escapeHtml(group.senderName)}</span>
            <span>•</span>
            <span>${group.timeFormatted}</span>
            ${!group.isInbound ? '<span class="delivery-status" title="Delivered to WhatsApp">✓✓</span>' : ''}
          </div>
          <div class="chat-group-bubbles">
            ${group.messages.map((m, idx) => {
              const isFirst = idx === 0 ? 'first' : '';
              const isLast = idx === totalInGroup - 1 ? 'last' : '';
              return `
                <div class="chat-bubble-card ${isFirst} ${isLast}">
                  ${escapeHtml(m.message)}
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    });

    chatFeedStream.innerHTML = html;
    scrollChatToBottom();
    renderIcons();

  } catch (err) {
    if (!isQuiet) {
      console.error("Error loading chat messages:", err);
      chatFeedStream.innerHTML = `<div class="chat-empty-state"><p>Unable to connect to WhatsApp chat stream.</p></div>`;
    }
  }
}

async function handleSendChatMessage(e) {
  e.preventDefault();
  if (!selectedMotherId || !chatComposerInput) return;

  const messageText = chatComposerInput.value.trim();
  if (!messageText) return;

  chatComposerInput.disabled = true;
  chatComposerSubmit.disabled = true;
  chatComposerSubmit.innerHTML = '<span>Sending...</span>';

  try {
    const res = await authFetch(`/api/mothers/${selectedMotherId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message: messageText })
    });

    const data = await res.json();
    if (data.success) {
      chatComposerInput.value = '';
      showToast("WhatsApp message dispatched.");
      await loadWhatsAppChat(selectedMotherId, false);
      scrollChatToBottom();
      loadMothers(true);
    } else {
      showToast(data.error || "Failed to deliver WhatsApp message.");
    }
  } catch (err) {
    console.error("Send message error:", err);
    showToast("Network error transmitting message to WhatsApp.");
  } finally {
    chatComposerInput.disabled = false;
    chatComposerSubmit.disabled = false;
    chatComposerSubmit.innerHTML = '<i data-lucide="send"></i><span>Send</span>';
    chatComposerInput.focus();
    renderIcons();
  }
}

function scrollChatToBottom() {
  if (chatFeedStream) {
    setTimeout(() => {
      chatFeedStream.scrollTop = chatFeedStream.scrollHeight;
    }, 60);
  }
}

function formatMessageTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getRiskBadge(tier) {
  if (tier === 'critical') {
    return `<span class="badge badge-critical" id="drawerRiskBadge"><span class="pill-dot dot-critical"></span>Critical Triage</span>`;
  } else if (tier === 'moderate') {
    return `<span class="badge badge-moderate" id="drawerRiskBadge"><span class="pill-dot dot-moderate"></span>Moderate Risk</span>`;
  }
  return `<span class="badge badge-normal" id="drawerRiskBadge"><span class="pill-dot dot-normal"></span>Stable Recovery</span>`;
}

function calculatePostpartumDays(deliveryDateStr) {
  if (!deliveryDateStr) return 'Day 1';
  const delivery = new Date(deliveryDateStr);
  const today = new Date();
  const diffTime = Math.abs(today - delivery);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return `Day ${diffDays} Postpartum`;
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return 'Just now';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMinutes = Math.floor((now - d) / (1000 * 60));
  if (diffMinutes < 60) return `${Math.max(1, diffMinutes)}m`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}

function formatDateTime(dateStr) {
  if (!dateStr) return 'Pending First Check-in';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatActionType(type) {
  if (type === 'phone_call') return 'Phone Call';
  if (type === 'in_person_consult') return 'Clinic Consult';
  if (type === 'home_visit') return 'Home Visit';
  return 'Observation';
}

// ==========================================================================
// Form Submissions
// ==========================================================================
async function handleAddNoteSubmit(e) {
  e.preventDefault();
  if (!selectedMotherId) return;

  const action_type = document.getElementById('actionTypeSelect').value;
  const note = document.getElementById('noteTextInput').value;
  const resolved_alert = document.getElementById('resolveAlertCheckbox').checked;

  try {
    const res = await authFetch(`/api/mothers/${selectedMotherId}/notes`, {
      method: 'POST',
      body: JSON.stringify({
        action_type,
        note,
        resolved_alert
      })
    });

    const data = await res.json();
    if (data.success) {
      document.getElementById('noteTextInput').value = '';
      document.getElementById('resolveAlertCheckbox').checked = false;
      showToast("Clinical note committed to PostgreSQL.");
      
      loadPatientCase(selectedMotherId);
      loadDashboardStats();
      loadMothers();
    }
  } catch (err) {
    console.error("Error adding note:", err);
    showToast("Failed to save note.");
  }
}

async function handleEnrollSubmit(e) {
  e.preventDefault();

  const full_name = document.getElementById('enrollName').value;
  const phone_number = document.getElementById('enrollPhone').value;
  const delivery_date = document.getElementById('enrollDeliveryDate').value;
  const delivery_type = document.getElementById('enrollDeliveryType').value;
  const parity = document.getElementById('enrollParity').value;
  const hospital_id = (isSuperAdmin && enrollHospitalSelect) ? enrollHospitalSelect.value : undefined;

  try {
    const res = await authFetch('/api/mothers', {
      method: 'POST',
      body: JSON.stringify({
        full_name,
        phone_number,
        delivery_date,
        delivery_type,
        parity,
        hospital_id
      })
    });

    const data = await res.json();
    if (data.success) {
      closeModal(enrollModalOverlay);
      enrollMotherForm.reset();
      showToast(`Mother ${full_name} enrolled into PostgreSQL.`);
      loadDashboardStats();
      await loadMothers();
      loadPatientCase(data.mother_id);
    } else {
      showToast(data.error || "Enrollment failed.");
    }
  } catch (err) {
    console.error("Error enrolling mother:", err);
    showToast("Server error during enrollment.");
  }
}

async function handleAddHospitalSubmit(e) {
  e.preventDefault();

  const name = document.getElementById('newHospitalName').value;
  const state = document.getElementById('newHospitalState').value;
  const phone = document.getElementById('newHospitalPhone').value;
  const contact_email = document.getElementById('newHospitalEmail').value;

  try {
    const res = await authFetch('/api/hospitals', {
      method: 'POST',
      body: JSON.stringify({ name, state, phone, contact_email })
    });

    const data = await res.json();
    if (data.success) {
      closeModal(addHospitalModalOverlay);
      addHospitalForm.reset();
      showToast(`Partner facility "${name}" onboarded.`);
      await loadHospitalsList();
      activeHospitalId = data.hospital.id;
      if (hospitalContextSelector) hospitalContextSelector.value = activeHospitalId;
      loadDashboardStats();
      loadMothers();
    } else {
      showToast(data.error || "Failed to add partner hospital.");
    }
  } catch (err) {
    console.error("Error adding hospital:", err);
    showToast("Network error registering facility.");
  }
}

function populateSimulatorDropdown() {
  simMotherSelect.innerHTML = allMothers.map(m => `
    <option value="${m.id}">${escapeHtml(m.full_name)} (${m.phone_number}) - Current: ${m.current_risk_tier.toUpperCase()}</option>
  `).join('');
}

async function handleSimulatorSubmit(e) {
  e.preventDefault();

  const mother_id = simMotherSelect.value;
  const scenario = document.querySelector('input[name="simScenario"]:checked').value;

  try {
    const res = await authFetch('/api/simulate-checkin', {
      method: 'POST',
      body: JSON.stringify({ mother_id, scenario })
    });

    const data = await res.json();
    if (data.success) {
      closeModal(simulatorModalOverlay);
      showToast(`WhatsApp webhook processed! Score: ${data.score}/30 (${data.risk_tier.toUpperCase()})`);
      
      loadDashboardStats();
      await loadMothers();
      loadPatientCase(mother_id);
      loadWhatsAppChat(mother_id);
    }
  } catch (err) {
    console.error("Error running simulator:", err);
    showToast("Simulation failed.");
  }
}

// Modal Helpers
function openModal(modalEl) {
  if (modalEl) modalEl.classList.add('active');
}

function closeModal(modalEl) {
  if (modalEl) modalEl.classList.remove('active');
}

// Toast Helper
function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<i data-lucide="info"></i><span>${escapeHtml(message)}</span>`;
  toastContainer.appendChild(toast);
  renderIcons();

  setTimeout(() => {
    toast.remove();
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Live Background Sync (Fetches real-time WhatsApp check-ins and active chat every 4 seconds)
setInterval(() => {
  loadDashboardStats();
  loadMothers(true);
  if (selectedMotherId) {
    loadWhatsAppChat(selectedMotherId, true);
  }
}, 4000);
