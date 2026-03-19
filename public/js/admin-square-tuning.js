/**
 * Square Font Tuning Admin
 * Live preview of square stamp layouts with per-font parameter adjustment.
 */
const SquareTuning = {
  config: null,
  savedConfig: null,
  templateSvg: null,
  templateZone: null,
  currentTemplate: null,
  _initialized: false,

  FONT_ORDER: [
    'Oswald', 'CourierPrime', 'Montserrat', 'Yomogi', 'BlackOpsOne',
    'Nunito', 'Exo2', 'Bitter', 'Comfortaa', 'FuzzyBubbles', 'BebasNeue'
  ],

  FONT_WEIGHTS: {
    Oswald: 500, CourierPrime: 400, Montserrat: 700, Yomogi: 400,
    BlackOpsOne: 400, Nunito: 900, Exo2: 700, Bitter: 500,
    Comfortaa: 700, FuzzyBubbles: 700, BebasNeue: 400
  },

  FONT_LABELS: {
    Oswald: 'Oswald', CourierPrime: 'Courier Prime', Montserrat: 'Montserrat',
    Yomogi: 'Yomogi', BlackOpsOne: 'Black Ops One', Nunito: 'Nunito',
    Exo2: 'Exo 2', Bitter: 'Bitter', Comfortaa: 'Comfortaa',
    FuzzyBubbles: 'Fuzzy Bubbles', BebasNeue: 'Bebas Neue'
  },

  // Preview cases: test different row modes with different text
  PREVIEW_CASES: [
    { key: 'hero2up',   label: '2↑ Hero Top',    text: 'BACK TO SCHOOL', rowMode: '2up' },
    { key: 'hero2down', label: '2↓ Hero Bottom',  text: 'BACK TO SCHOOL', rowMode: '2down' },
    { key: 'equal3',    label: '3 Equal Rows',     text: 'YOUR TEXT HERE',  rowMode: '3' }
  ],

  // Tunable parameters per case — NO CAPPING, free experimentation
  PARAMS: [
    { key: 'heroStroke',   label: 'H Stroke',  step: 0.5,  decimals: 1, defaultVal: 8.0 },
    { key: 'heroSpacing',  label: 'H Space',   step: 0.5,  decimals: 1, defaultVal: 2.0 },
    { key: 'heroScaleY',   label: 'H ScaleY',  step: 0.05, decimals: 2, defaultVal: 1.10 },
    { key: 'heroScaleX',   label: 'H ScaleX',  step: 0.05, decimals: 2, defaultVal: 1.0 },
    { key: 'heroDx',       label: 'H DX',      step: 10,   decimals: 0, defaultVal: 0 },
    { key: 'heroDy',       label: 'H DY',      step: 10,   decimals: 0, defaultVal: 0 },
    { key: 'smallStroke',  label: 'S Stroke',  step: 0.5,  decimals: 1, defaultVal: 5.0 },
    { key: 'smallSpacing', label: 'S Space',   step: 0.5,  decimals: 1, defaultVal: 2.0 },
    { key: 'smallScaleY',  label: 'S ScaleY',  step: 0.05, decimals: 2, defaultVal: 1.0 },
    { key: 'smallScaleX',  label: 'S ScaleX',  step: 0.05, decimals: 2, defaultVal: 1.0 },
    { key: 'smallDx',      label: 'S DX',      step: 10,   decimals: 0, defaultVal: 0 },
    { key: 'smallDy',      label: 'S DY',      step: 10,   decimals: 0, defaultVal: 0 },
    { key: 'rowGap',       label: 'Line Sp',   step: 2,    decimals: 0, defaultVal: 0 }
  ],

  async init() {
    try {
      console.log('[SQ-ADMIN] init starting...');
      var resp = await fetch('/api/admin/square-config');
      this.config = await resp.json();
      this.savedConfig = JSON.parse(JSON.stringify(this.config));
      console.log('[SQ-ADMIN] config loaded:', Object.keys(this.config).length, 'fonts');

      // Push to SvgRenderer for live preview
      SvgRenderer._squareConfig = this.config;

      await this.loadPreviewTemplate();
      console.log('[SQ-ADMIN] template loaded:', !!this.templateSvg, 'zone:', !!this.templateZone);

      this.buildGrid();
      console.log('[SQ-ADMIN] grid built');

      // Render all previews
      for (var i = 0; i < this.FONT_ORDER.length; i++) {
        for (var c = 0; c < this.PREVIEW_CASES.length; c++) {
          try {
            await this.renderPreview(this.FONT_ORDER[i], c);
          } catch (previewErr) {
            console.error('[SQ-ADMIN] preview failed:', this.FONT_ORDER[i], c, previewErr);
          }
        }
      }
      console.log('[SQ-ADMIN] all previews rendered');
    } catch (err) {
      console.error('[SQ-ADMIN] init failed:', err);
      var grid = document.getElementById('square-tuning-grid');
      if (grid) grid.innerHTML = '<p style="color:red;padding:1rem;">Init failed: ' + err.message + '</p>';
    }
  },

  async loadPreviewTemplate() {
    // Use same template loading as FontTuning — find a plain outlined template
    if (typeof sb === 'undefined') {
      console.error('[SQ-ADMIN] No supabase client (sb)! Check if supabase-client.js is loaded.');
      return;
    }

    // Get any active outlined template for preview
    var { data, error } = await sb
      .from('templates')
      .select('*, text_zones(*)')
      .eq('is_active', true)
      .eq('fill_type', 'empty')
      .eq('corner_type', 'straight')
      .is('border_type', null)
      .eq('frame_type', 'single')
      .limit(1);
    console.log('[SQ-ADMIN] template query result:', data ? data.length : 0, 'error:', error);

    if (!data || data.length === 0) {
      // Nuclear fallback: any active template
      var fallback = await sb
        .from('templates')
        .select('*, text_zones(*)')
        .eq('is_active', true)
        .limit(1);
      data = fallback.data;
      console.log('[SQ-ADMIN] fallback result:', data ? data.length : 0);
    }

    if (data && data.length > 0) {
      var tpl = data[0];
      this.currentTemplate = tpl;
      var storageBaseUrl = sb.storage.from('templates').getPublicUrl('').data.publicUrl;
      var svgUrl = storageBaseUrl.replace(/\/$/, '') + '/' + tpl.svg_path;
      var rawSvg = await SvgRenderer.fetchSvg(svgUrl);
      this.templateSvg = SvgRenderer.cleanSvgString ? SvgRenderer.cleanSvgString(rawSvg) : rawSvg;
      this.templateZone = tpl.text_zones && tpl.text_zones[0] ? tpl.text_zones[0] : null;
    }
  },

  buildGrid() {
    var grid = document.getElementById('square-tuning-grid');
    if (!grid) return;
    grid.innerHTML = '';
    var self = this;

    for (var i = 0; i < this.FONT_ORDER.length; i++) {
      var fontKey = this.FONT_ORDER[i];
      var card = document.createElement('div');
      card.className = 'font-tune-card';

      // Font title
      var title = document.createElement('div');
      title.className = 'font-tune-title';
      title.innerHTML = '<span class="font-tune-name">' + (this.FONT_LABELS[fontKey] || fontKey) + '</span>';
      card.appendChild(title);

      // Cases
      for (var c = 0; c < this.PREVIEW_CASES.length; c++) {
        var cs = this.PREVIEW_CASES[c];
        var caseConfig = (this.config[fontKey] && this.config[fontKey][cs.key]) || {};

        // Header with controls
        var header = document.createElement('div');
        header.className = 'font-tune-header';
        header.innerHTML = '<span style="font-weight:600;font-size:0.7rem;min-width:80px;">' + cs.label + '</span>';

        var controls = document.createElement('div');
        controls.className = 'font-tune-controls';

        for (var p = 0; p < this.PARAMS.length; p++) {
          var param = this.PARAMS[p];
          var val = caseConfig[param.key] !== undefined ? caseConfig[param.key] : (param.defaultVal !== undefined ? param.defaultVal : 0);

          var row = document.createElement('div');
          row.className = 'font-tune-row';
          row.innerHTML =
            '<span class="font-tune-label">' + param.label + '</span>' +
            '<button class="font-tune-btn" data-font="' + fontKey + '" data-case="' + c + '" data-param="' + param.key + '" data-dir="-1">−</button>' +
            '<span class="font-tune-value" id="sqval-' + fontKey + '-' + c + '-' + param.key + '">' + val.toFixed(param.decimals) + '</span>' +
            '<button class="font-tune-btn" data-font="' + fontKey + '" data-case="' + c + '" data-param="' + param.key + '" data-dir="1">+</button>';
          controls.appendChild(row);
        }

        header.appendChild(controls);
        card.appendChild(header);

        // Preview area
        var preview = document.createElement('div');
        preview.className = 'font-tune-preview';
        preview.id = 'sqpreview-' + fontKey + '-' + c;
        preview.style.minHeight = '200px';
        card.appendChild(preview);
      }

      grid.appendChild(card);
    }

    // Event delegation for +/- buttons
    grid.addEventListener('click', function(e) {
      var btn = e.target.closest('.font-tune-btn');
      if (btn) {
        self.adjustParam(btn.dataset.font, parseInt(btn.dataset.case), btn.dataset.param, parseInt(btn.dataset.dir));
      }
      var prev = e.target.closest('.font-tune-preview');
      if (prev) {
        self.zoomPreview(prev);
      }
    });
  },

  adjustParam(fontKey, caseIdx, paramKey, dir) {
    var cs = this.PREVIEW_CASES[caseIdx];
    if (!this.config[fontKey]) this.config[fontKey] = {};
    if (!this.config[fontKey][cs.key]) this.config[fontKey][cs.key] = {};
    var cfg = this.config[fontKey][cs.key];

    var paramDef = this.PARAMS.find(function(p) { return p.key === paramKey; });
    if (!paramDef) return;

    var defVal = paramDef.defaultVal !== undefined ? paramDef.defaultVal : 0;
    var val = cfg[paramKey] !== undefined ? cfg[paramKey] : defVal;
    val += dir * paramDef.step;
    // No capping — free experimentation
    val = Math.round(val * 1000) / 1000;
    cfg[paramKey] = val;

    // Update display
    var valEl = document.getElementById('sqval-' + fontKey + '-' + caseIdx + '-' + paramKey);
    if (valEl) valEl.textContent = val.toFixed(paramDef.decimals);

    // Update SvgRenderer config
    SvgRenderer._sqConfig = this.config;

    // Debounced re-render
    this.debouncedRender(fontKey, caseIdx);
  },

  _renderTimers: {},
  debouncedRender(fontKey, caseIdx) {
    var timerKey = fontKey + '-' + caseIdx;
    clearTimeout(this._renderTimers[timerKey]);
    var self = this;
    this._renderTimers[timerKey] = setTimeout(function() {
      self.renderPreview(fontKey, caseIdx);
    }, 150);
  },

  async renderPreview(fontKey, caseIdx) {
    if (!this.templateSvg || !this.templateZone) return;

    var cs = this.PREVIEW_CASES[caseIdx];
    var previewEl = document.getElementById('sqpreview-' + fontKey + '-' + caseIdx);
    if (!previewEl) return;

    try {
      // Set sqConfig so svg-renderer reads our tuned values
      SvgRenderer._sqConfig = this.config;
      var weight = this.FONT_WEIGHTS[fontKey] || 400;
      var svg = this.templateSvg;

      // Uniquify IDs
      if (SvgRenderer.uniquifySvgIds) svg = SvgRenderer.uniquifySvgIds(svg);

      // Replace font
      svg = svg.replace(/font-family=["']'?[^"']*'?["']/g, "font-family=\"'" + fontKey + "'\"");
      svg = svg.replace(/font-weight=["'][^"']*["']/g, 'font-weight="' + weight + '"');

      // Replace text
      var zone = this.templateZone;
      svg = SvgRenderer.replaceTextInString(svg, zone.svg_element_index || 0, cs.text);

      // Inject rowMode for square inline split
      svg = svg.replace(/<svg/, '<svg data-sq-rowmode="' + cs.rowMode + '"');

      // Auto-fit — first as rectangle to get base sizing, then apply square enforcement
      if (zone && zone.bounding_width) {
        var origSx = zone.transform_matrix
          ? parseFloat(zone.transform_matrix.match(/matrix\(\s*([\d.]+)/)?.[1]) || 1 : 1;
        try {
          svg = await SvgRenderer.autoFitTextInString(
            svg, zone.svg_element_index || 0,
            zone.bounding_width, zone.font_size, origSx,
            'single', 'empty', 'straight', null, 'square'
          );
        } catch (fitErr) {
          console.warn('[SQ-ADMIN] autoFit failed, trying without square:', fitErr.message);
          // Fallback: render as rectangle
          svg = await SvgRenderer.autoFitTextInString(
            svg, zone.svg_element_index || 0,
            zone.bounding_width, zone.font_size, origSx,
            'single', 'empty', 'strong', null
          );
        }
      }

      // Colorize red, stroke, crop, corners
      svg = SvgRenderer.colorize(svg, '#dc2626');
      svg = SvgRenderer.applyThinStroke(svg);
      svg = SvgRenderer.cropViewBoxToStamp(svg);
      // Straight corners — no applyCornerRadius call

      // Add red debug rect showing the text zone (inner area where text should fit)
      // Parse the outer rect and viewBox to draw the text zone
      var outerRectMatch = svg.match(/<rect[^>]*\bstroke=["'][^"']+["'][^>]*>/i);
      if (outerRectMatch) {
        var orx = parseFloat((outerRectMatch[0].match(/\bx=["']([^"']+)["']/)||[])[1])||0;
        var ory = parseFloat((outerRectMatch[0].match(/\by=["']([^"']+)["']/)||[])[1])||0;
        var orw = parseFloat((outerRectMatch[0].match(/\bwidth=["']([^"']+)["']/)||[])[1])||0;
        var orh = parseFloat((outerRectMatch[0].match(/\bheight=["']([^"']+)["']/)||[])[1])||0;
        var orsw = parseFloat((outerRectMatch[0].match(/stroke-width=["']([^"']+)["']/)||[])[1])||0;
        // Text zone = inner area with 5% padding from outer rect inner edge
        var inset = orsw / 2;
        var pad = orw * 0.05;
        var tzx = orx + inset + pad;
        var tzy = ory + inset + pad;
        var tzw = orw - 2 * (inset + pad);
        var tzh = orh - 2 * (inset + pad);
        var debugRect = '<rect x="' + tzx.toFixed(1) + '" y="' + tzy.toFixed(1) + '" width="' + tzw.toFixed(1) + '" height="' + tzh.toFixed(1) + '" fill="none" stroke="red" stroke-width="3" stroke-dasharray="10,5" opacity="0.5"/>';
        svg = svg.replace(/<\/svg>/, debugRect + '</svg>');
      }

      // Display
      previewEl.innerHTML = '';
      var wrapper = SvgRenderer.createSvgImage ? SvgRenderer.createSvgImage(svg) : null;
      if (wrapper) {
        previewEl.appendChild(wrapper);
      } else {
        var div = document.createElement('div');
        div.innerHTML = svg;
        previewEl.appendChild(div);
      }
    } catch (err) {
      previewEl.innerHTML = '<span style="color:red;font-size:0.7rem;">Error: ' + err.message + '</span>';
      console.error('[SQ-ADMIN] preview error:', fontKey, cs.key, err);
    }
  },

  zoomPreview(previewEl) {
    var overlay = document.getElementById('font-zoom-overlay');
    if (!overlay) return;
    var svg = previewEl.querySelector('svg');
    if (!svg) return;
    overlay.innerHTML = '';
    var clone = svg.cloneNode(true);
    clone.style.maxWidth = '90vw';
    clone.style.maxHeight = '90vh';
    clone.style.width = 'auto';
    clone.style.height = 'auto';
    clone.style.background = 'white';
    clone.style.borderRadius = '8px';
    overlay.appendChild(clone);
    overlay.style.display = 'flex';
    var close = function() { overlay.style.display = 'none'; };
    overlay.onclick = close;
    document.addEventListener('keydown', function handler(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', handler); }
    });
  },

  async saveAll() {
    var statusEl = document.getElementById('square-save-status');
    try {
      var resp = await fetch('/api/admin/square-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.config)
      });
      var result = await resp.json();
      if (result.success) {
        this.savedConfig = JSON.parse(JSON.stringify(this.config));
        if (statusEl) {
          statusEl.textContent = 'Saved!';
          statusEl.style.display = '';
          setTimeout(function() { statusEl.style.display = 'none'; }, 3000);
        }
      }
    } catch (err) {
      console.error('Save failed:', err);
      if (statusEl) {
        statusEl.textContent = 'Save failed!';
        statusEl.style.color = '#ef4444';
        statusEl.style.display = '';
        setTimeout(function() { statusEl.style.display = 'none'; statusEl.style.color = '#22c55e'; }, 3000);
      }
    }
  }
};
