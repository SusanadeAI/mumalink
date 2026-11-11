// MumaLINK Clinician Authentication Controller
// Ondo State Mother & Child Specialist Hospital Triage Platform

function renderIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons({
      attrs: {
        'stroke-width': 1.6
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  renderIcons();

  // If already authenticated, redirect straight to dashboard
  const existingToken = localStorage.getItem('mumalink_token');
  if (existingToken) {
    window.location.href = '/dashboard';
    return;
  }

  const tabSignIn = document.getElementById('tabSignIn');
  const tabRegister = document.getElementById('tabRegister');
  const signInForm = document.getElementById('signInForm');
  const registerForm = document.getElementById('registerForm');
  const authTitle = document.getElementById('authTitle');
  const authSubtitle = document.getElementById('authSubtitle');
  const authAlert = document.getElementById('authAlert');
  const regHospital = document.getElementById('regHospital');

  const svgEye = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  const svgEyeOff = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
  const svgArrow = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>';

  // Password visibility toggles
  const toggleLoginPassword = document.getElementById('toggleLoginPassword');
  const loginPassword = document.getElementById('loginPassword');
  if (toggleLoginPassword && loginPassword) {
    toggleLoginPassword.addEventListener('click', () => {
      const isPassword = loginPassword.type === 'password';
      loginPassword.type = isPassword ? 'text' : 'password';
      toggleLoginPassword.innerHTML = isPassword ? svgEyeOff : svgEye;
    });
  }

  const toggleRegPassword = document.getElementById('toggleRegPassword');
  const regPassword = document.getElementById('regPassword');
  if (toggleRegPassword && regPassword) {
    toggleRegPassword.addEventListener('click', () => {
      const isPassword = regPassword.type === 'password';
      regPassword.type = isPassword ? 'text' : 'password';
      toggleRegPassword.innerHTML = isPassword ? svgEyeOff : svgEye;
    });
  }

  // Load registered hospitals
  async function loadHospitals() {
    if (!regHospital) return;
    try {
      const res = await fetch('/api/hospitals/public');
      const hospitals = await res.json();
      if (hospitals && hospitals.length > 0) {
        regHospital.innerHTML = `
          <option value="" disabled selected>Select partner facility...</option>
          ${hospitals.map(h => `<option value="${h.id}">${h.name} (${h.state})</option>`).join('')}
        `;
      } else {
        regHospital.innerHTML = `<option value="hosp_ondo_01">Ondo State Mother & Child Specialist Hospital</option>`;
      }
    } catch (e) {
      console.error('Hospital directory fetch error:', e);
      regHospital.innerHTML = `<option value="hosp_ondo_01">Ondo State Mother & Child Specialist Hospital</option>`;
    }
  }
  loadHospitals();

  // Tab Switching
  if (tabSignIn && tabRegister) {
    tabSignIn.addEventListener('click', () => {
      tabSignIn.classList.add('active');
      tabRegister.classList.remove('active');
      signInForm.style.display = 'flex';
      registerForm.style.display = 'none';
      if (authTitle) authTitle.textContent = 'Welcome back.';
      if (authSubtitle) authSubtitle.textContent = 'Sign in to your hospital maternity triage stream and patient register.';
      clearAlert();
    });

    tabRegister.addEventListener('click', () => {
      tabRegister.classList.add('active');
      tabSignIn.classList.remove('active');
      registerForm.style.display = 'flex';
      signInForm.style.display = 'none';
      if (authTitle) authTitle.textContent = 'Join clinical network.';
      if (authSubtitle) authSubtitle.textContent = 'Register as an accredited maternity care provider for your hospital.';
      clearAlert();
    });
  }

  // Sign In Handler
  if (signInForm) {
    signInForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearAlert();

      const email = document.getElementById('loginEmail').value.trim();
      const password = document.getElementById('loginPassword').value;
      const loginBtn = document.getElementById('loginBtn');

      loginBtn.disabled = true;
      loginBtn.innerHTML = '<span>Verifying credentials...</span><span class="btn-icon-box"><i data-lucide="loader"></i></span>';
      renderIcons();

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });

        const data = await res.json();

        if (res.ok && data.token) {
          localStorage.setItem('mumalink_token', data.token);
          localStorage.setItem('mumalink_clinician', JSON.stringify(data.clinician));
          showAlert('Authentication verified. Accessing triage portal...', 'success');
          setTimeout(() => {
            window.location.href = '/dashboard';
          }, 400);
        } else {
          showAlert(data.error || 'Invalid clinician credentials.', 'error');
        }
      } catch (err) {
        console.error('Authentication error:', err);
        showAlert('Unable to connect to clinical authentication service.', 'error');
      } finally {
        loginBtn.disabled = false;
        loginBtn.innerHTML = '<span>Sign In to Triage</span><span class="btn-icon-box">' + svgArrow + '</span>';
      }
    });
  }

  // Register Handler
  if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearAlert();

      const full_name = document.getElementById('regName').value.trim();
      const email = document.getElementById('regEmail').value.trim();
      const role = document.getElementById('regRole').value;
      const hospital_id = regHospital && regHospital.value ? regHospital.value : 'hosp_ondo_01';
      const password = document.getElementById('regPassword').value;
      const regBtn = document.getElementById('regBtn');

      regBtn.disabled = true;
      regBtn.innerHTML = '<span>Registering clinician...</span><span class="btn-icon-box">...</span>';

      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ full_name, email, role, hospital_id, password })
        });

        const data = await res.json();

        if (res.ok && data.token) {
          localStorage.setItem('mumalink_token', data.token);
          localStorage.setItem('mumalink_clinician', JSON.stringify(data.clinician));
          showAlert('Account created. Accessing triage portal...', 'success');
          setTimeout(() => {
            window.location.href = '/dashboard';
          }, 500);
        } else {
          showAlert(data.error || 'Registration failed.', 'error');
        }
      } catch (err) {
        console.error('Registration error:', err);
        showAlert('Network error during clinician onboarding.', 'error');
      } finally {
        regBtn.disabled = false;
        regBtn.innerHTML = '<span>Create Clinician Account</span><span class="btn-icon-box">' + svgArrow + '</span>';
      }
    });
  }

  function showAlert(msg, type) {
    if (!authAlert) return;
    authAlert.textContent = msg;
    authAlert.className = `status-banner ${type}`;
    authAlert.style.display = 'block';
  }

  function clearAlert() {
    if (!authAlert) return;
    authAlert.textContent = '';
    authAlert.className = 'status-banner';
    authAlert.style.display = 'none';
  }
});
