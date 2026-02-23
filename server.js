require('dotenv').config();
const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = 3000;

// Supabase server client (service role — bypasses RLS)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Parse JSON bodies for API routes
app.use(express.json());

// Static files (no cache for dev)
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: function(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
}));

// ---- API: Record generation and deduct credit ----
app.post('/api/generations/record', async (req, res) => {
  try {
    // 1. Verify auth token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization token' });
    }
    const token = authHeader.split(' ')[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // 2. Check credits
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('credits')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    if (profile.credits < 1) {
      return res.status(403).json({ error: 'Insufficient credits' });
    }

    // 3. Deduct 1 credit
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ credits: profile.credits - 1 })
      .eq('id', user.id);

    if (updateError) {
      console.error('Credit deduction failed:', updateError);
      return res.status(500).json({ error: 'Failed to deduct credit' });
    }

    // 4. Log the generation
    const { template_id, input_data } = req.body;
    const { error: insertError } = await supabase
      .from('generations')
      .insert({
        user_id: user.id,
        template_id: template_id || null,
        input_data: input_data || {}
      });

    if (insertError) {
      // Non-fatal: credit was already deducted, log but don't fail
      console.error('Generation logging failed:', insertError);
    }

    return res.json({ success: true, credits_remaining: profile.credits - 1 });
  } catch (err) {
    console.error('Generation record error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- HTML routes ----
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app', 'index.html'));
});

app.get('/app/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app', 'profile', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
