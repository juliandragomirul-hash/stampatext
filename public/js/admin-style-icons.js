/**
 * Admin Style Icons — Pan & zoom to crop 100×30px icons for the Style dropdown.
 */
var StyleIcons = {
  _initialized: false,
  config: {},  // { styleName: { zoom: 1, panX: 0, panY: 0 } }
  _cfgRefs: {},  // live cfg references per style key (for Save All)
  STYLES: [
    { key: 'simple', label: 'Plain' },
    { key: 'stitch_line', label: 'Stitch Line' },
    { key: 'stitch_square', label: 'Stitch Square' },
    { key: 'stitch_circle', label: 'Stitch Dot' },
    { key: 'sawtooth', label: 'Sawtooth' },
    { key: 'perforated', label: 'Perforated' },
    { key: 'perforated_spaced', label: 'Spaced Perf.' },
    { key: 'wavy', label: 'Wavy' },
    { key: 'zigzag', label: 'Zigzag' },
    { key: 'torn_edge', label: 'Torn Edge' },
    { key: 'chalk', label: 'Chalk' },
    { key: 'perf_line', label: 'Perf. Line' },
    { key: 'perf_line_spaced', label: 'Perf. Line Spaced' },
    { key: 'saw_line', label: 'Saw Line' }
  ],

  async init() {
    // Load saved config
    try {
      var resp = await fetch('/api/admin/style-icon-config');
      if (resp.ok) this.config = await resp.json();
    } catch (e) { this.config = {}; }

    // Load templates
    var { data: tpls } = await sb.from('templates').select('id, border_type, svg_path, text_zones(*)').eq('is_active', true).eq('fill_type', 'empty').eq('frame_type', 'single');
    var tplMap = {};
    tpls.forEach(function(t) { tplMap[t.border_type || 'simple'] = t; });

    var storageBaseUrl = sb.storage.from('templates').getPublicUrl('').data.publicUrl;
    var grid = document.getElementById('style-icons-grid');
    grid.innerHTML = '';

    // Templates with tiny SVGs (no embedded fonts) need a fat template as base
    // The borderType parameter still triggers the correct border generation
    var SMALL_TPL_STYLES = ['zigzag', 'chalk'];
    var fatTpl = tplMap['simple'];  // plain template: 1.6MB with embedded fonts, NO border data attrs

    // Save All button
    var saveAllBtn = document.createElement('button');
    saveAllBtn.textContent = 'Save All';
    saveAllBtn.style.cssText = 'margin-bottom:1rem;padding:8px 24px;background:#dc2626;color:#fff;border:none;border-radius:4px;font-size:0.9rem;cursor:pointer;';
    saveAllBtn.addEventListener('click', async function() {
      saveAllBtn.disabled = true;
      saveAllBtn.textContent = 'Saving...';
      for (var j = 0; j < StyleIcons.STYLES.length; j++) {
        var sk = StyleIcons.STYLES[j].key;
        var vw = document.getElementById('viewport-wrap-' + sk);
        var c = StyleIcons._cfgRefs[sk] || StyleIcons.config[sk] || { zoom: 1, panX: 0, panY: 0 };
        if (vw) await StyleIcons._saveIcon(sk, vw, c);
      }
      saveAllBtn.disabled = false;
      saveAllBtn.textContent = 'Save All — Done!';
      setTimeout(function() { saveAllBtn.textContent = 'Save All'; }, 2000);
    });
    grid.parentNode.insertBefore(saveAllBtn, grid);

    // Load stamps sequentially to avoid iframe throttling
    for (var i = 0; i < this.STYLES.length; i++) {
      var style = this.STYLES[i];
      var tpl = tplMap[style.key] || tplMap['simple'];
      // Use fat template for styles with tiny SVGs
      var svgTpl = SMALL_TPL_STYLES.indexOf(style.key) >= 0 ? fatTpl : tpl;
      var card = this._buildCard(style, svgTpl, storageBaseUrl);
      grid.appendChild(card);
      // Wait for this stamp to finish loading before starting the next
      var stampContainer = document.getElementById('stamp-img-' + style.key);
      if (stampContainer) {
        await this._loadStamp(style, svgTpl, storageBaseUrl, stampContainer, this.config[style.key] || { zoom: 1, panX: 0, panY: 0 });
      }
    }
  },

  _buildCard(style, tpl, storageBaseUrl) {
    var self = this;
    var cfg = this.config[style.key] || { zoom: 1, panX: 0, panY: 0 };

    var card = document.createElement('div');
    card.style.cssText = 'background:#f9f9f9;border:1px solid #e0e0e0;border-radius:8px;padding:1rem;';

    // Header: style label + current icon + save button
    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:1rem;margin-bottom:0.75rem;';
    header.innerHTML = '<strong style="min-width:140px;">' + style.label + '</strong>' +
      '<img src="/img/style-icons/' + style.key + '.png?t=' + Date.now() + '" width="100" height="30" style="border:1px solid #ccc;background:#fff;" id="icon-preview-' + style.key + '">' +
      '<button class="btn btn-primary" style="padding:4px 12px;font-size:0.8rem;" id="icon-save-' + style.key + '">Save</button>' +
      '<span id="icon-status-' + style.key + '" style="color:#22c55e;font-size:0.8rem;display:none;">Saved!</span>';
    card.appendChild(header);

    // Viewport container: fixed 100×30 window with stamp behind
    var viewportWrap = document.createElement('div');
    viewportWrap.id = 'viewport-wrap-' + style.key;
    viewportWrap.style.cssText = 'position:relative;width:300px;height:120px;border:1px solid #999;overflow:hidden;cursor:grab;background:#fff;';
    self._cfgRefs[style.key] = cfg;

    // The viewport indicator (100×30 fixed rect in center)
    var viewport = document.createElement('div');
    viewport.style.cssText = 'position:absolute;left:100px;top:45px;width:100px;height:30px;border:2px dashed #ff0000;pointer-events:none;z-index:10;box-sizing:border-box;';
    viewportWrap.appendChild(viewport);

    // Semi-transparent overlay outside the viewport
    var overlayTop = document.createElement('div');
    overlayTop.style.cssText = 'position:absolute;left:0;top:0;width:300px;height:45px;background:rgba(0,0,0,0.3);pointer-events:none;z-index:9;';
    viewportWrap.appendChild(overlayTop);
    var overlayBot = document.createElement('div');
    overlayBot.style.cssText = 'position:absolute;left:0;top:75px;width:300px;height:45px;background:rgba(0,0,0,0.3);pointer-events:none;z-index:9;';
    viewportWrap.appendChild(overlayBot);
    var overlayLeft = document.createElement('div');
    overlayLeft.style.cssText = 'position:absolute;left:0;top:45px;width:100px;height:30px;background:rgba(0,0,0,0.3);pointer-events:none;z-index:9;';
    viewportWrap.appendChild(overlayLeft);
    var overlayRight = document.createElement('div');
    overlayRight.style.cssText = 'position:absolute;left:200px;top:45px;width:100px;height:30px;background:rgba(0,0,0,0.3);pointer-events:none;z-index:9;';
    viewportWrap.appendChild(overlayRight);

    // Stamp image (movable/zoomable)
    var stampImg = document.createElement('div');
    stampImg.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;';
    stampImg.id = 'stamp-img-' + style.key;
    viewportWrap.appendChild(stampImg);

    card.appendChild(viewportWrap);

    // Zoom controls
    var controls = document.createElement('div');
    controls.style.cssText = 'display:flex;gap:0.5rem;align-items:center;margin-top:0.5rem;';
    controls.innerHTML = '<button class="btn" style="padding:2px 8px;" id="zoom-out-' + style.key + '">-</button>' +
      '<span id="zoom-label-' + style.key + '" style="font-size:0.8rem;min-width:50px;text-align:center;">' + (cfg.zoom * 100).toFixed(0) + '%</span>' +
      '<button class="btn" style="padding:2px 8px;" id="zoom-in-' + style.key + '">+</button>';
    card.appendChild(controls);

    // Stamp loading is handled sequentially by init() — not here

    // Wire up events after DOM insertion
    setTimeout(function() {
      // Drag
      var isDragging = false, startX = 0, startY = 0, origPanX = 0, origPanY = 0;
      viewportWrap.addEventListener('mousedown', function(e) {
        if (e.button !== 0) return;
        isDragging = true;
        startX = e.clientX; startY = e.clientY;
        origPanX = cfg.panX; origPanY = cfg.panY;
        viewportWrap.style.cursor = 'grabbing';
        e.preventDefault();
      });
      document.addEventListener('mousemove', function(e) {
        if (!isDragging) return;
        cfg.panX = origPanX + (e.clientX - startX);
        cfg.panY = origPanY + (e.clientY - startY);
        self._applyTransform(stampImg, cfg);
      });
      document.addEventListener('mouseup', function() {
        if (isDragging) { isDragging = false; viewportWrap.style.cursor = 'grab'; }
      });

      // Zoom (mouse wheel)
      viewportWrap.addEventListener('wheel', function(e) {
        e.preventDefault();
        var delta = e.deltaY > 0 ? -0.1 : 0.1;
        cfg.zoom = Math.max(0.2, Math.min(5, cfg.zoom + delta));
        self._applyTransform(stampImg, cfg);
        document.getElementById('zoom-label-' + style.key).textContent = (cfg.zoom * 100).toFixed(0) + '%';
      });

      // Zoom buttons
      document.getElementById('zoom-in-' + style.key).addEventListener('click', function() {
        cfg.zoom = Math.min(5, cfg.zoom + 0.1);
        self._applyTransform(stampImg, cfg);
        document.getElementById('zoom-label-' + style.key).textContent = (cfg.zoom * 100).toFixed(0) + '%';
      });
      document.getElementById('zoom-out-' + style.key).addEventListener('click', function() {
        cfg.zoom = Math.max(0.2, cfg.zoom - 0.1);
        self._applyTransform(stampImg, cfg);
        document.getElementById('zoom-label-' + style.key).textContent = (cfg.zoom * 100).toFixed(0) + '%';
      });

      // Save
      document.getElementById('icon-save-' + style.key).addEventListener('click', function() {
        self._saveIcon(style.key, viewportWrap, cfg);
      });
    }, 100);

    return card;
  },

  async _loadStamp(style, tpl, storageBaseUrl, container, cfg) {
    try {
      var svgUrl = storageBaseUrl.replace(/\/$/, '') + '/' + tpl.svg_path;
      var rawSvg = await SvgRenderer.fetchSvg(svgUrl);
      var cleanSvg = SvgRenderer.cleanSvgString ? SvgRenderer.cleanSvgString(rawSvg) : rawSvg;

      // For styles using a fallback template, inject the correct data-* attribute on the outer rect
      var STYLE_DATA_ATTRS = {
        'zigzag': 'data-wavy="zigzag"',
        'chalk': 'data-filter="chalk-12"'
      };
      if (STYLE_DATA_ATTRS[style.key]) {
        // Find the main non-white rect and add the data attribute
        cleanSvg = cleanSvg.replace(
          /(<rect[^>]*fill=["']none["'][^>]*)(\/?>)/i,
          '$1 ' + STYLE_DATA_ATTRS[style.key] + ' $2'
        );
      }

      // Replace text
      var zone = tpl.text_zones && tpl.text_zones[0];
      var idx = zone ? (zone.svg_element_index || 0) : 0;
      var svg = SvgRenderer.replaceTextInString(cleanSvg, idx, 'CONGRATULATIONS');

      // AutoFit
      if (zone && zone.bounding_width) {
        var scaleX = zone.transform_matrix ? parseFloat((zone.transform_matrix.match(/matrix\(\s*([\d.]+)/) || [])[1]) || 1 : 1;
        svg = await SvgRenderer.autoFitTextInString(svg, idx, zone.bounding_width, zone.font_size || 128, scaleX, 'single', 'empty', 'straight', style.key, 'rectangle');
      }

      // Colorize + stroke
      svg = SvgRenderer.colorize(svg, '#CC0000');
      svg = SvgRenderer.applyThinStroke(svg);
      // Skip cropViewBox for wavy/zigzag — their paths may extend beyond the rect
      if (style.key !== 'zigzag') {
        svg = SvgRenderer.cropViewBoxToStamp(svg);
      }

      // Render at 1:1
      console.log('[StyleIcons] ' + style.key + ': SVG length=' + svg.length + ' hasWavy=' + /data-wavy/.test(svg) + ' hasFilter=' + /data-filter/.test(svg) + ' hasPaths=' + (svg.match(/<path/gi) || []).length);
      container.innerHTML = svg.replace(/<svg/, '<svg style="display:block;"');
      this._applyTransform(container, cfg);
    } catch (e) {
      console.error('[StyleIcons] Error loading ' + style.key + ':', e.message, e.stack);
      container.innerHTML = '<span style="color:red;font-size:0.7rem;">Error loading ' + style.key + ': ' + e.message + '</span>';
    }
  },

  _applyTransform(el, cfg) {
    el.style.transform = 'translate(' + cfg.panX + 'px,' + cfg.panY + 'px) scale(' + cfg.zoom + ')';
  },

  async _saveIcon(styleKey, viewportWrap, cfg) {
    try {
      // Capture the 100×30 viewport area using canvas
      var canvas = document.createElement('canvas');
      canvas.width = 100;
      canvas.height = 30;
      var ctx = canvas.getContext('2d');

      // The viewport is at (100, 45) within the 300×120 container
      // Draw the container content offset by the viewport position
      var stampEl = document.getElementById('stamp-img-' + styleKey);
      var svgEl = stampEl.querySelector('svg');
      if (!svgEl) { alert('No SVG to capture'); return; }

      // Serialize SVG to image (keep all white shapes intact — transparency handled at pixel level)
      var svgStr = new XMLSerializer().serializeToString(svgEl);
      var blob = new Blob([svgStr], { type: 'image/svg+xml' });
      var url = URL.createObjectURL(blob);
      var img = new Image();
      await new Promise(function(resolve, reject) { img.onload = resolve; img.onerror = reject; img.src = url; });

      // Draw with the current pan/zoom, offset by viewport position
      ctx.drawImage(img, cfg.panX - 100, cfg.panY - 45, img.width * cfg.zoom, img.height * cfg.zoom);
      URL.revokeObjectURL(url);

      // Make white/near-white pixels transparent (pixel-level, catches all shapes)
      var imageData = ctx.getImageData(0, 0, 100, 30);
      var pixels = imageData.data;
      for (var p = 0; p < pixels.length; p += 4) {
        if (pixels[p] > 240 && pixels[p+1] > 240 && pixels[p+2] > 240) {
          pixels[p+3] = 0; // set alpha to 0
        }
      }
      ctx.putImageData(imageData, 0, 0);

      // Convert to base64 PNG
      var pngBase64 = canvas.toDataURL('image/png').split(',')[1];

      // Upload as JSON
      var resp = await fetch('/api/admin/style-icons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ style: styleKey, pngBase64: pngBase64, zoom: cfg.zoom, panX: cfg.panX, panY: cfg.panY })
      });
      if (!resp.ok) throw new Error('Save failed: ' + resp.status);

      // Update preview
      document.getElementById('icon-preview-' + styleKey).src = '/img/style-icons/' + styleKey + '.png?t=' + Date.now();
      var status = document.getElementById('icon-status-' + styleKey);
      status.style.display = 'inline';
      setTimeout(function() { status.style.display = 'none'; }, 2000);

      // Save config
      this.config[styleKey] = { zoom: cfg.zoom, panX: cfg.panX, panY: cfg.panY };
    } catch (e) {
      alert('Save error: ' + e.message);
    }
  }
};
