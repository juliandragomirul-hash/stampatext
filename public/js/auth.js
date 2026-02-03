async function signUp(email, password) {
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function signOut() {
  const { error } = await sb.auth.signOut();
  if (error) throw error;
  window.location.href = '/';
}

async function getSession() {
  const { data: { session } } = await sb.auth.getSession();
  return session;
}

async function getProfile() {
  const session = await getSession();
  if (!session) return null;
  const { data, error } = await sb
    .from('profiles')
    .select('*')
    .eq('id', session.user.id)
    .single();
  if (error) throw error;
  return data;
}

async function updateProfile(updates) {
  const session = await getSession();
  if (!session) throw new Error('Not authenticated');
  const { data, error } = await sb
    .from('profiles')
    .update(updates)
    .eq('id', session.user.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function changePassword(newPassword) {
  const { data, error } = await sb.auth.updateUser({ password: newPassword });
  if (error) throw error;
  return data;
}

async function resetPassword(email) {
  const { data, error } = await sb.auth.resetPasswordForEmail(email);
  if (error) throw error;
  return data;
}
