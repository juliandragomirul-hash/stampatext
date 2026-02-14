async function requireAuth() {
  const session = await getSession();
  if (!session) {
    window.location.href = '/?redirect=' + encodeURIComponent(window.location.pathname);
    return null;
  }
  return session;
}

async function requireAdmin() {
  const session = await getSession();
  if (!session) {
    window.location.href = '/?redirect=' + encodeURIComponent(window.location.pathname);
    return null;
  }
  const profile = await getProfile();
  if (!profile || profile.role !== 'admin') {
    window.location.href = '/app';
    return null;
  }
  return profile;
}

function showPage() {
  document.body.classList.remove('page-loading');
}
