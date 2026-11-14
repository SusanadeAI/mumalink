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

  const signInForm = document.getElementById('signInForm');
  const authTitle = document.getElementById('authTitle');
  const authSubtitle = document.getElementById('authSubtitle');
  const authAlert = document.getElementById('authAlert');
  const visualTopIsland = document.getElementById('visualTopIsland');

  let activeTenantHospital = null;
  let activeTenantSubdomain = new URLSearchParams(window.location.search).get('hospital') || '';

  const svgEye = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  const svgEyeOff = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
  const svgArrow = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>';

  // Password visibility toggle
  const toggleLoginPassword = document.getElementById('toggleLoginPassword');
  const loginPassword = document.getElementById('loginPassword');
  if (toggleLoginPassword && loginPassword) {
    toggleLoginPassword.addEventListener('click', () => {
      const isPassword = loginPassword.type === 'password';
      loginPassword.type = isPassword ? 'text' : 'password';
      toggleLoginPassword.innerHTML = isPassword ? svgEyeOff : svgEye;
    });
  }

  // Load subdomain / tenant portal context
  async function loadTenantContext() {
    try {
      const q = activeTenantSubdomain ? `?hospital=${encodeURIComponent(activeTenantSubdomain)}` : '';
      const res = await fetch(`/api/tenant${q}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.hospital) {
        activeTenantHospital = data.hospital;
        activeTenantSubdomain = data.hospital.subdomain || activeTenantSubdomain;
        if (visualTopIsland) {
          visualTopIsland.textContent = `${data.hospital.name} • Maternal Portal`;
        }
        if (authTitle) {
          authTitle.textContent = `Sign in to ${data.hospital.name}`;
        }
        if (authSubtitle) {
          authSubtitle.textContent = `Authorized personnel portal for ${data.hospital.name}.`;
        }
        document.title = `${data.hospital.name} • MumaLINK Clinician Sign In`;
      } else if (data && data.subdomain && !data.hospital) {
        if (visualTopIsland) {
          visualTopIsland.textContent = `${data.subdomain}.mumalink.com`;
        }
        showAlert(`No clinic workspace is registered for ${data.subdomain}.mumalink.com.`, 'error');
      }
    } catch (e) {
      console.error('Tenant context notice:', e);
    }
  }
  loadTenantContext();

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
          body: JSON.stringify({ email, password, subdomain: activeTenantSubdomain || undefined })
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
