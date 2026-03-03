/**
 * Admin Font Tuning — Live preview + parameter editing for all fonts.
 * Each font has 4 text cases with independent parameters:
 *   single, singleDiacrit, multi, multiDiacrit
 * Loads config from /data/font-config.json, renders stamps per font per case,
 * saves back via PUT /api/admin/font-config.
 */
const FontTuning = {
  config: null,       // Current editable config (object keyed by font name → case → params)
  savedConfig: null,  // Last saved config (for reset)
  templateSvg: null,  // Raw template SVG string for preview
  templateZone: null, // text_zone data for the template

  // Font display order (matches product page roster)
  FONT_ORDER: [
    'Oswald', 'CourierPrime', 'Montserrat', 'Yomogi', 'BlackOpsOne',
    'Nunito', 'Exo2', 'Bitter', 'Comfortaa', 'FuzzyBubbles'
  ],

  // 4 preview cases per font
  PREVIEW_CASES: [
    { key: 'single',        label: '1-line',         text: 'COMING SOON' },
    { key: 'singleDiacrit', label: '1-line diacrit',  text: 'A\u0102 FI MO\u021A' },
    { key: 'multi',         label: 'Multi-line',      text: 'AONGRATULATIONA\nRETIREE' },
    { key: 'multiDiacrit',  label: 'Multi diacrit',   text: '\u00CENREGIS\u021AR\u0102T\u00CE\n\u00C2FI\u021AI\u0102LA' }
  ],

  // Font weights (must match product.html FONT_WEIGHTS)
  FONT_WEIGHTS: {
    'Oswald': '500', 'CourierPrime': '400', 'Montserrat': '700', 'Yomogi': '400',
    'BlackOpsOne': '400', 'Nunito': '900',
    'Exo2': '700', 'Bitter': '500', 'Comfortaa': '700', 'FuzzyBubbles': '700'
  },

  // Font display names
  FONT_LABELS: {
    'Oswald': 'Oswald', 'CourierPrime': 'Courier Prime', 'Montserrat': 'Montserrat',
    'Yomogi': 'Yomogi', 'BlackOpsOne': 'Black Ops One',
    'Nunito': 'Nunito', 'Exo2': 'Exo 2',
    'Bitter': 'Bitter', 'Comfortaa': 'Comfortaa', 'FuzzyBubbles': 'Fuzzy Bubbles'
  },

  // Parameter definitions: key, label, min, max, step, decimals
  PARAMS: [
    { key: 'scaleY',        label: 'Scale Y',  min: 0.8,  max: 2.0,  step: 0.05, decimals: 2 },
    { key: 'letterSpacing',  label: 'Spacing',  min: 0,    max: 30,   step: 1,    decimals: 0 },
    { key: 'dx',             label: 'dx',       min: -0.15, max: 0.15, step: 0.005, decimals: 3 },
    { key: 'dy',             label: 'dy',       min: -0.15, max: 0.15, step: 0.005, decimals: 3 },
    { key: 'wb',             label: 'wb',       min: 0.60,  max: 1.30, step: 0.01,  decimals: 2 },
    { key: 'hb',             label: 'hb',       min: 0.80,  max: 1.50, step: 0.01,  decimals: 2 },
    { key: 'stroke',          label: 'Stroke',   min: -8,    max: 8,    step: 0.5,   decimals: 1 },
    { key: 'lineSpacing',     label: 'Line Sp',  min: 0.60,  max: 1.80, step: 0.05,  decimals: 2 }
  ],

  async init() {
    // Load font config
    try {
      var res = await fetch('/api/admin/font-config');
      this.config = await res.json();
    } catch (e) {
      console.error('Failed to load font config:', e);
      return;
    }
    this.savedConfig = JSON.parse(JSON.stringify(this.config));

    // Also push to SvgRenderer so previews use it
    SvgRenderer._fontConfig = this.config;

    // Fetch a simple template for preview (plain, double, filled, soft round)
    await this.loadPreviewTemplate();

    // Build UI
    this.buildGrid();

    // Save button
    document.getElementById('font-save-all').addEventListener('click', () => this.saveAll());

    // Render all previews (all 4 cases per font)
    for (var i = 0; i < this.FONT_ORDER.length; i++) {
      for (var c = 0; c < this.PREVIEW_CASES.length; c++) {
        await this.renderPreview(this.FONT_ORDER[i], c);
      }
    }
  },

  async loadPreviewTemplate() {
    try {
      // Fetch templates, pick a simple one (plain border, filled, soft round, double frame)
      var { data: templates, error } = await sb
        .from('templates')
        .select('*, text_zones(*)')
        .eq('is_active', true)
        .is('border_type', null)
        .eq('fill_type', 'full')
        .eq('frame_type', 'double')
        .eq('corner_type', 'soft_round')
        .limit(1);

      if (error || !templates || templates.length === 0) {
        // Fallback: just pick any active template
        var { data: fallback } = await sb
          .from('templates')
          .select('*, text_zones(*)')
          .eq('is_active', true)
          .limit(1);
        templates = fallback;
      }

      if (!templates || templates.length === 0) {
        console.error('No templates found for font tuning preview');
        return;
      }

      var tpl = templates[0];
      this.templateZone = tpl.text_zones && tpl.text_zones[0] ? tpl.text_zones[0] : null;

      var storageBaseUrl = sb.storage.from('templates').getPublicUrl('').data.publicUrl;
      var svgUrl = storageBaseUrl.replace(/\/$/, '') + '/' + tpl.svg_path;
      var rawSvg = await SvgRenderer.fetchSvg(svgUrl);
      this.templateSvg = SvgRenderer.cleanSvgString(rawSvg);
    } catch (e) {
      console.error('Failed to load preview template:', e);
    }
  },

  buildGrid() {
    var grid = document.getElementById('font-tuning-grid');
    grid.innerHTML = '';

    for (var i = 0; i < this.FONT_ORDER.length; i++) {
      var fontKey = this.FONT_ORDER[i];
      var fontConfig = this.config[fontKey] || {};
      var card = document.createElement('div');
      card.className = 'font-tune-card';
      card.id = 'font-card-' + fontKey;

      // Font name header (spans all 4 case rows)
      var fontTitle = document.createElement('div');
      fontTitle.className = 'font-tune-title';
      fontTitle.innerHTML = '<span class="font-tune-name">' + (this.FONT_LABELS[fontKey] || fontKey) + '</span>';
      card.appendChild(fontTitle);

      // 4 case rows
      for (var c = 0; c < this.PREVIEW_CASES.length; c++) {
        var cs = this.PREVIEW_CASES[c];
        var fc = fontConfig[cs.key] || {};

        // Case header: case label + controls + save
        var header = document.createElement('div');
        header.className = 'font-tune-header';

        var caseLabel = document.createElement('span');
        caseLabel.className = 'font-tune-case-label';
        caseLabel.textContent = cs.label;
        header.appendChild(caseLabel);

        // Controls (inline in header)
        var controls = document.createElement('div');
        controls.className = 'font-tune-controls';

        // Numeric params
        for (var j = 0; j < this.PARAMS.length; j++) {
          var p = this.PARAMS[j];
          var val = fc[p.key];
          if (val === undefined || val === null) {
            var paramDefaults = { scaleY: 1.20, letterSpacing: 0, dx: 0, dy: 0, wb: 1.0, hb: 1.0, stroke: 0, lineSpacing: 1.0, ws: 0 };
            val = paramDefaults[p.key] || 0;
          }
          var row = document.createElement('div');
          row.className = 'font-tune-row';
          row.innerHTML =
            '<button class="font-tune-btn" data-font="' + fontKey + '" data-case="' + cs.key + '" data-param="' + p.key + '" data-dir="-1">-</button>' +
            '<span class="font-tune-label">' + p.label + '<br><span class="font-tune-value" id="val-' + fontKey + '-' + cs.key + '-' + p.key + '">' + val.toFixed(p.decimals) + '</span></span>' +
            '<button class="font-tune-btn" data-font="' + fontKey + '" data-case="' + cs.key + '" data-param="' + p.key + '" data-dir="1">+</button>';
          controls.appendChild(row);
        }

        header.appendChild(controls);

        var saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-small font-tune-save';
        saveBtn.textContent = 'Save';
        header.appendChild(saveBtn);

        card.appendChild(header);

        // Preview for this case
        var preview = document.createElement('div');
        preview.className = 'font-tune-preview';
        preview.id = 'font-preview-' + fontKey + '-' + cs.key;
        preview.title = 'Click to zoom';
        preview.addEventListener('click', this.zoomPreview.bind(this, fontKey, cs.key));
        card.appendChild(preview);
      }

      grid.appendChild(card);
    }

    // Event delegation for +/- buttons
    grid.addEventListener('click', (e) => {
      var btn = e.target.closest('.font-tune-btn');
      if (!btn) return;
      this.adjustParam(btn.dataset.font, btn.dataset.case, btn.dataset.param, parseInt(btn.dataset.dir, 10));
    });

    // Event delegation for save buttons
    grid.addEventListener('click', (e) => {
      var btn = e.target.closest('.font-tune-save');
      if (!btn) return;
      this.saveAll();
    });
  },

  adjustParam(fontKey, caseKey, paramKey, dir) {
    var p = this.PARAMS.find(function(x) { return x.key === paramKey; });
    if (!p) return;
    var fc = this.config[fontKey] && this.config[fontKey][caseKey];
    if (!fc) return;

    var val = (fc[p.key] || 0) + dir * p.step;
    val = Math.round(val * 1000) / 1000; // avoid float drift
    val = Math.max(p.min, Math.min(p.max, val));
    fc[p.key] = val;

    // Update displayed value
    var valEl = document.getElementById('val-' + fontKey + '-' + caseKey + '-' + paramKey);
    if (valEl) valEl.textContent = val.toFixed(p.decimals);

    // Push updated config to renderer and re-render only this case
    SvgRenderer._fontConfig = this.config;
    var caseIndex = this.PREVIEW_CASES.findIndex(function(c) { return c.key === caseKey; });
    this.debouncedRender(fontKey, caseIndex);
  },

  _renderTimers: {},
  debouncedRender(fontKey, caseIndex) {
    var timerKey = fontKey + '-' + caseIndex;
    clearTimeout(this._renderTimers[timerKey]);
    this._renderTimers[timerKey] = setTimeout(() => {
      this.renderPreview(fontKey, caseIndex);
    }, 150);
  },

  async renderPreview(fontKey, caseIndex) {
    if (!this.templateSvg) return;
    var cs = this.PREVIEW_CASES[caseIndex];
    var previewEl = document.getElementById('font-preview-' + fontKey + '-' + cs.key);
    if (!previewEl) return;

    try {
      var weight = this.FONT_WEIGHTS[fontKey] || '400';
      var svg = this.templateSvg;

      // Clear measurement cache for fresh sizing
      SvgRenderer._autoFitMeasureCache = null;

      // Replace font
      svg = svg.replace(/font-family=["']'?[^"']*'?["']/g,
        "font-family=\"'" + fontKey + "'\"");
      svg = svg.replace(/font-weight=["'][^"']*["']/g,
        'font-weight="' + weight + '"');

      // Replace text
      svg = SvgRenderer.replaceTextInString(svg, 0, cs.text);

      // Auto-fit
      if (this.templateZone && this.templateZone.bounding_width) {
        var origSx = this.templateZone.transform_matrix
          ? parseFloat(this.templateZone.transform_matrix.match(/matrix\(\s*([\d.]+)/)?.[1]) || 1 : 1;
        svg = await SvgRenderer.autoFitTextInString(
          svg, 0, this.templateZone.bounding_width,
          this.templateZone.font_size, origSx, 'single', 'full', 'soft_round', null
        );
      }

      // Colorize (dodger blue)
      svg = SvgRenderer.colorize(svg, '#1E90FF');

      // Apply stroke
      svg = SvgRenderer.applyThinStroke(svg);

      // Crop viewBox
      svg = SvgRenderer.cropViewBoxToStamp(svg);

      // Corner radius
      svg = SvgRenderer.applyCornerRadius(svg, 'soft_round');

      // Double frame
      svg = SvgRenderer.addDoubleFrame(svg);

      // Display
      previewEl.innerHTML = '';
      var wrapper = SvgRenderer.createSvgImage(svg);
      previewEl.appendChild(wrapper);
    } catch (err) {
      console.error('Font preview render error (' + fontKey + '/' + cs.key + '):', err);
      previewEl.innerHTML = '<span style="color:red;font-size:0.75rem;">Render error</span>';
    }
  },

  zoomPreview(fontKey, caseKey) {
    var previewEl = document.getElementById('font-preview-' + fontKey + '-' + caseKey);
    if (!previewEl) return;
    var svgEl = previewEl.querySelector('svg');
    if (!svgEl) return;

    var overlay = document.getElementById('font-zoom-overlay');
    overlay.innerHTML = '';
    overlay.appendChild(svgEl.cloneNode(true));
    overlay.style.display = 'flex';

    function close() {
      overlay.style.display = 'none';
      overlay.innerHTML = '';
      document.removeEventListener('keydown', onEsc);
    }
    function onEsc(e) { if (e.key === 'Escape') close(); }

    overlay.onclick = close;
    document.addEventListener('keydown', onEsc);
  },

  async saveAll() {
    var statusEl = document.getElementById('font-save-status');
    try {
      var res = await fetch('/api/admin/font-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.config)
      });
      var result = await res.json();
      if (result.success) {
        this.savedConfig = JSON.parse(JSON.stringify(this.config));
        statusEl.textContent = 'Saved!';
        statusEl.style.color = '#22c55e';
      } else {
        statusEl.textContent = 'Error: ' + (result.error || 'Unknown');
        statusEl.style.color = '#ef4444';
      }
    } catch (e) {
      statusEl.textContent = 'Save failed: ' + e.message;
      statusEl.style.color = '#ef4444';
    }
    statusEl.style.display = 'inline';
    setTimeout(function() { statusEl.style.display = 'none'; }, 3000);
  }
};
