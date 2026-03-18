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

  // Tunable parameters per case
  PARAMS: [
    { key: 'heroCapH',     label: 'Cap H',     min: 0.40, max: 1.00, step: 0.02, decimals: 2 },
    { key: 'heroDescent',  label: 'Descent',   min: 0.00, max: 0.20, step: 0.01, decimals: 2 },
    { key: 'rowGap',       label: 'Row Gap',   min: -20,  max: 40,   step: 2,    decimals: 0 },
    { key: 'heroStroke',   label: 'H Stroke',  min: 0,    max: 20,   step: 0.5,  decimals: 1 },
    { key: 'heroSpacing',  label: 'H Space',   min: 0,    max: 15,   step: 0.5,  decimals: 1 },
    { key: 'heroScaleY',   label: 'H ScaleY',  min: 0.8,  max: 1.5,  step: 0.05, decimals: 2 },
    { key: 'smallCapH',    label: 'S Cap H',   min: 0.40, max: 1.00, step: 0.02, decimals: 2 },
    { key: 'smallStroke',  label: 'S Stroke',  min: 0,    max: 15,   step: 0.5,  decimals: 1 },
    { key: 'smallSpacing', label: 'S Space',   min: 0,    max: 15,   step: 0.5,  decimals: 1 }
  ],

  async init() {
    try {
      var resp = await fetch('/api/admin/square-config');
      this.config = await resp.json();
      this.savedConfig = JSON.parse(JSON.stringify(this.config));

      // Push to SvgRenderer for live preview
      SvgRenderer._squareConfig = this.config;

      await this.loadPreviewTemplate();
      this.buildGrid();

      // Render all previews
      for (var i = 0; i < this.FONT_ORDER.length; i++) {
        for (var c = 0; c < this.PREVIEW_CASES.length; c++) {
          await this.renderPreview(this.FONT_ORDER[i], c);
        }
      }
    } catch (err) {
      console.error('SquareTuning init failed:', err);
    }
  },

  async loadPreviewTemplate() {
    // Use same template loading as FontTuning — find a plain outlined template
    var supabase = window.__supabaseClient;
    if (!supabase) return;

    var { data } = await supabase
      .from('templates')
      .select('*, text_zones(*)')
      .eq('is_active', true)
      .is('border_type', null)
      .eq('fill_type', 'empty')
      .eq('frame_type', 'single')
      .eq('corner_type', 'straight')
      .limit(1);

    if (!data || data.length === 0) {
      var fallback = await supabase
        .from('templates')
        .select('*, text_zones(*)')
        .eq('is_active', true)
        .eq('fill_type', 'empty')
        .limit(1);
      data = fallback.data;
    }

    if (data && data.length > 0) {
      var tpl = data[0];
      this.currentTemplate = tpl;
      var svgUrl = 'https://rtxbuywxzcmlufwumcrg.supabase.co/storage/v1/object/public/templates/' + tpl.svg_path;
      var svgResp = await fetch(svgUrl);
      this.templateSvg = await svgResp.text();
      var zones = (tpl.text_zones || []).filter(z => z.is_editable).sort((a, b) => a.sort_order - b.sort_order);
      this.templateZone = zones[0] || null;
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
          var val = caseConfig[param.key] !== undefined ? caseConfig[param.key] : 0;

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

    var val = cfg[paramKey] !== undefined ? cfg[paramKey] : 0;
    val += dir * paramDef.step;
    val = Math.max(paramDef.min, Math.min(paramDef.max, val));
    val = Math.round(val * 1000) / 1000;
    cfg[paramKey] = val;

    // Update display
    var valEl = document.getElementById('sqval-' + fontKey + '-' + caseIdx + '-' + paramKey);
    if (valEl) valEl.textContent = val.toFixed(paramDef.decimals);

    // Update SvgRenderer config
    SvgRenderer._squareConfig = this.config;

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
      // Clone template and replace font
      var svg = this.templateSvg;
      var fontFamily = (this.FONT_LABELS[fontKey] || fontKey);
      var fontWeight = this.FONT_WEIGHTS[fontKey] || 400;
      svg = svg.replace(/font-family="[^"]*"/gi, 'font-family="' + fontFamily + '"');
      svg = svg.replace(/font-weight="[^"]*"/gi, 'font-weight="' + fontWeight + '"');

      // Replace text with the test string (multi-line via \n for square split)
      var zone = this.templateZone;
      svg = SvgRenderer.replaceTextInString(svg, zone.svg_element_index || 0, cs.text);

      // Auto-fit with square shape
      var origScaleX = zone.transform_matrix
        ? parseFloat(zone.transform_matrix.match(/matrix\(\s*([\d.]+)/)?.[1]) || 1 : 1;

      // Inject rowMode so inline split picks it up
      svg = svg.replace(/<svg/, '<svg data-sq-rowmode="' + cs.rowMode + '"');

      svg = await SvgRenderer.autoFitTextInString(
        svg, zone.svg_element_index || 0,
        zone.bounding_width, zone.font_size, origScaleX,
        'single', 'empty', 'straight', null, 'square'
      );

      // Colorize and crop
      svg = SvgRenderer.colorize(svg, '#dc2626');
      svg = SvgRenderer.applyThinStroke(svg);
      svg = SvgRenderer.cropViewBoxToStamp(svg);
      svg = SvgRenderer.applyCornerRadius(svg, 'straight');

      previewEl.innerHTML = '';
      var wrapper = document.createElement('div');
      wrapper.innerHTML = svg;
      var svgEl = wrapper.querySelector('svg');
      if (svgEl) {
        svgEl.style.maxWidth = '100%';
        svgEl.style.maxHeight = '300px';
        svgEl.style.width = 'auto';
        svgEl.style.height = 'auto';
      }
      previewEl.appendChild(wrapper);
    } catch (err) {
      previewEl.innerHTML = '<span style="color:red;font-size:0.7rem;">Error: ' + err.message + '</span>';
      console.error('Square preview error:', fontKey, cs.key, err);
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
