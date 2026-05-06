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
app.use(express.json({ limit: '5mb' }));

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
    // Validate credits_cost (1, 2, or 3)
    const creditsCost = [1, 2, 3].includes(req.body.credits_cost) ? req.body.credits_cost : 1;

    if (profile.credits < creditsCost) {
      return res.status(403).json({ error: 'Insufficient credits' });
    }

    // 3. Deduct credits
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ credits: profile.credits - creditsCost })
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

    return res.json({ success: true, credits_remaining: profile.credits - creditsCost });
  } catch (err) {
    console.error('Generation record error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- Credit Packages (hardcoded for MVP) ----
const CREDIT_PACKAGES = {
  pack_10:  { credits: 10,  price: '19.00', name: '10 Credits' },
  pack_50:  { credits: 50,  price: '59.00', name: '50 Credits' },
  pack_100: { credits: 100, price: '99.00', name: '100 Credits' }
};

// ---- PayPal Helpers ----
async function getPayPalAccessToken() {
  const auth = Buffer.from(
    process.env.PAYPAL_CLIENT_ID + ':' + process.env.PAYPAL_CLIENT_SECRET
  ).toString('base64');

  const res = await fetch(process.env.PAYPAL_API_BASE + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + auth,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!res.ok) throw new Error('PayPal auth failed: ' + await res.text());
  return (await res.json()).access_token;
}

async function authenticateRequest(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const { data: { user }, error } = await supabase.auth.getUser(authHeader.split(' ')[1]);
  if (error || !user) return null;
  return user;
}

// ---- API: Create PayPal Order ----
app.post('/api/payments/paypal-create-order', async (req, res) => {
  try {
    const user = await authenticateRequest(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    const pkg = CREDIT_PACKAGES[req.body.package_id];
    if (!pkg) return res.status(400).json({ error: 'Invalid package' });

    const accessToken = await getPayPalAccessToken();
    const orderRes = await fetch(process.env.PAYPAL_API_BASE + '/v2/checkout/orders', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: { currency_code: 'USD', value: pkg.price },
          description: pkg.name + ' - StampaText',
          custom_id: user.id + '|' + req.body.package_id
        }]
      })
    });

    if (!orderRes.ok) {
      console.error('PayPal create order failed:', await orderRes.text());
      return res.status(500).json({ error: 'Failed to create PayPal order' });
    }

    const order = await orderRes.json();
    return res.json({ order_id: order.id });
  } catch (err) {
    console.error('PayPal create order error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- API: Capture PayPal Order ----
app.post('/api/payments/paypal-capture-order', async (req, res) => {
  try {
    const user = await authenticateRequest(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

    // Idempotency: check if already captured
    const { data: existingTx } = await supabase
      .from('credit_transactions')
      .select('id')
      .eq('reference_id', order_id)
      .eq('reason', 'paypal_purchase')
      .limit(1);

    if (existingTx && existingTx.length > 0) {
      const { data: profile } = await supabase
        .from('profiles').select('credits').eq('id', user.id).single();
      return res.json({
        success: true, credits_added: 0,
        new_balance: profile ? profile.credits : 0,
        message: 'Order already captured'
      });
    }

    // Capture payment
    const accessToken = await getPayPalAccessToken();
    const captureRes = await fetch(
      process.env.PAYPAL_API_BASE + '/v2/checkout/orders/' + order_id + '/capture',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!captureRes.ok) {
      console.error('PayPal capture failed:', await captureRes.text());
      return res.status(500).json({ error: 'Payment capture failed' });
    }

    const captureData = await captureRes.json();
    if (captureData.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Payment not completed: ' + captureData.status });
    }

    // Verify user + package from custom_id
    const purchaseUnit = captureData.purchase_units[0];
    const capture = purchaseUnit.payments.captures[0];
    const customId = capture.custom_id || purchaseUnit.custom_id || '';
    const [capturedUserId, capturedPackageId] = customId.split('|');

    if (capturedUserId !== user.id) {
      console.error('User mismatch: token=' + user.id + ', order=' + capturedUserId);
      return res.status(403).json({ error: 'User mismatch' });
    }

    const pkg = CREDIT_PACKAGES[capturedPackageId];
    if (!pkg) return res.status(400).json({ error: 'Invalid package in order' });

    if (capture.amount.value !== pkg.price) {
      console.error('Amount mismatch: expected=' + pkg.price + ', captured=' + capture.amount.value);
      return res.status(400).json({ error: 'Amount mismatch' });
    }

    // Grant credits
    const { data: profile, error: profileError } = await supabase
      .from('profiles').select('credits').eq('id', user.id).single();

    if (profileError || !profile) {
      console.error('MANUAL RESOLUTION NEEDED: order_id=' + order_id +
        ', user_id=' + user.id + ', credits=' + pkg.credits);
      return res.status(500).json({ error: 'Credits could not be granted. Contact support.' });
    }

    const newBalance = profile.credits + pkg.credits;
    const { error: updateError } = await supabase
      .from('profiles').update({ credits: newBalance }).eq('id', user.id);

    if (updateError) {
      console.error('MANUAL RESOLUTION NEEDED: order_id=' + order_id +
        ', user_id=' + user.id + ', credits=' + pkg.credits);
      return res.status(500).json({ error: 'Credits could not be granted. Contact support.' });
    }

    // Log transaction
    await supabase.from('credit_transactions').insert({
      user_id: user.id,
      amount: pkg.credits,
      reason: 'paypal_purchase',
      reference_id: order_id
    });

    return res.json({ success: true, credits_added: pkg.credits, new_balance: newBalance });
  } catch (err) {
    console.error('PayPal capture error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- API: Font Config (admin) ----
const fs = require('fs');
const FONT_CONFIG_PATH = path.join(__dirname, 'public', 'data', 'font-config.json');

app.get('/api/admin/font-config', (req, res) => {
  try {
    const data = fs.readFileSync(FONT_CONFIG_PATH, 'utf8');
    res.json(JSON.parse(data));
  } catch (err) {
    console.error('Failed to read font config:', err);
    res.status(500).json({ error: 'Failed to read font config' });
  }
});

app.put('/api/admin/font-config', (req, res) => {
  try {
    const config = req.body;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return res.status(400).json({ error: 'Invalid config format' });
    }
    fs.writeFileSync(FONT_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to write font config:', err);
    res.status(500).json({ error: 'Failed to write font config' });
  }
});

const PARAM_COMPAT_PATH = path.join(__dirname, 'public', 'data', 'param-compat.json');

// Style Icon Cropping API
const STYLE_ICON_CONFIG_PATH = path.join(__dirname, 'public', 'data', 'style-icon-config.json');

app.get('/api/admin/style-icon-config', (req, res) => {
  try {
    if (!fs.existsSync(STYLE_ICON_CONFIG_PATH)) return res.json({});
    res.json(JSON.parse(fs.readFileSync(STYLE_ICON_CONFIG_PATH, 'utf8')));
  } catch (e) { res.json({}); }
});

app.post('/api/admin/style-icons', express.json({ limit: '1mb' }), (req, res) => {
  try {
    var { style, pngBase64, zoom, panX, panY } = req.body;
    if (!style || !pngBase64) return res.status(400).json({ error: 'Missing style or pngBase64' });
    // Save PNG
    var pngBuffer = Buffer.from(pngBase64, 'base64');
    var iconPath = path.join(__dirname, 'public', 'img', 'style-icons', style + '.png');
    fs.writeFileSync(iconPath, pngBuffer);
    // Save config
    var config = {};
    try { config = JSON.parse(fs.readFileSync(STYLE_ICON_CONFIG_PATH, 'utf8')); } catch (e) {}
    config[style] = { zoom: zoom, panX: panX, panY: panY };
    fs.writeFileSync(STYLE_ICON_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
    res.json({ success: true });
  } catch (e) {
    console.error('Style icon save error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Param compatibility API
app.get('/api/admin/param-compat', (req, res) => {
  try {
    const data = fs.readFileSync(PARAM_COMPAT_PATH, 'utf8');
    res.json(JSON.parse(data));
  } catch (err) {
    res.json({ incompatible: [] });
  }
});

app.post('/api/admin/param-compat', (req, res) => {
  try {
    const combo = req.body;
    if (!combo || !combo.style) return res.status(400).json({ error: 'Invalid combo' });
    let data;
    try { data = JSON.parse(fs.readFileSync(PARAM_COMPAT_PATH, 'utf8')); } catch (e) { data = { incompatible: [] }; }
    // Check for duplicate
    const exists = data.incompatible.some(c => c.style === combo.style && c.corners === combo.corners && c.frames === combo.frames && c.fill === combo.fill);
    if (!exists) {
      data.incompatible.push(combo);
      fs.writeFileSync(PARAM_COMPAT_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
    }
    res.json({ success: true, count: data.incompatible.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save' });
  }
});

app.delete('/api/admin/param-compat', (req, res) => {
  try {
    const combo = req.body;
    let data;
    try { data = JSON.parse(fs.readFileSync(PARAM_COMPAT_PATH, 'utf8')); } catch (e) { data = { incompatible: [] }; }
    data.incompatible = data.incompatible.filter(c => !(c.style === combo.style && c.corners === combo.corners && c.frames === combo.frames && c.fill === combo.fill));
    fs.writeFileSync(PARAM_COMPAT_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
    res.json({ success: true, count: data.incompatible.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// ---- API: Saved designs ----
// Helper: verify auth token and return user
async function verifyAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

// POST /api/saves — Save a combo
app.post('/api/saves', async (req, res) => {
  try {
    const user = await verifyAuth(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { params, description, thumbnail } = req.body;
    if (!params) return res.status(400).json({ error: 'Missing params' });
    const { data, error } = await supabase
      .from('saved_designs')
      .insert({ user_id: user.id, params, description: description || '', thumbnail: thumbnail || null })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save' });
  }
});

// GET /api/saves — List user's saves
app.get('/api/saves', async (req, res) => {
  try {
    const user = await verifyAuth(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { data, error } = await supabase
      .from('saved_designs')
      .select('id, params, description, thumbnail, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch saves' });
  }
});

// DELETE /api/saves/:id — Delete a save
app.delete('/api/saves/:id', async (req, res) => {
  try {
    const user = await verifyAuth(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { error } = await supabase
      .from('saved_designs')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// GET /api/downloads — List user's download history
app.get('/api/downloads', async (req, res) => {
  try {
    const user = await verifyAuth(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { data, error } = await supabase
      .from('generations')
      .select('id, template_id, input_data, created_at, templates(svg_path)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch downloads' });
  }
});

// ---- HTML routes ----
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app', 'index.html'));
});

app.get('/app/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app', 'profile', 'index.html'));
});

app.get('/app/saves', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app', 'saves', 'index.html'));
});

app.get('/app/downloads', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app', 'downloads', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

app.get('/admin/test-gallery', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'test-gallery.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
