/**
 * Gallery - Manages stamp results: processing, colorization, filtering, pagination, rendering.
 *
 * Flow:
 * 1. User types text → Stamp → processAll() fetches templates, replaces text → stores "base" results
 * 2. showInitialRandom(5) picks 5 random templates, each colorized with a random palette color
 * 3. Show more (first time) → opens filter modal → user picks colors + shape + object
 * 4. applyFilters() → creates colorized variants (template × selected color), shows 5
 * 5. Show more → next 5 filtered variants
 *
 * Each batch is rendered as its own section (title + grid) stacked below the previous ones.
 */
const Gallery = {
  // The user's current search text
  currentText: '',

  // Base results: text replaced but NOT colorized
  baseResults: [],    // [{templateId, svgString, shape, objectType, colors, width, height, name}]

  // Currently displayed/available results (colorized variants)
  allResults: [],       // [{templateId, svgString, shape, objectType, colors, width, height, name, appliedColor}]
  filteredResults: [],
  displayedCount: 0,
  isFirstShowMore: true,

  // Palette colors (same as stamp-app.js)
  PALETTE_COLORS: [
    '#000000', '#FF0000', '#8B0000', '#FF1493', '#FF4500',
    '#FF8C00', '#FFD700', '#FFFF00', '#BDB76B', '#9400D3',
    '#4B0082', '#7CFC00', '#32CD32', '#00FF7F', '#008000',
    '#808000', '#556B2F', '#00FFFF', '#00CED1', '#4682B4',
    '#1E90FF', '#4169E1', '#000080', '#8B4513',
    '#C0C0C0', '#A9A9A9'
  ],

  COLOR_NAMES: {
    '#000000': 'Black', '#FF0000': 'Red', '#8B0000': 'Dark Red',
    '#FF1493': 'Deep Pink', '#FF4500': 'Orange Red', '#FF8C00': 'Dark Orange',
    '#FFD700': 'Gold', '#FFFF00': 'Yellow', '#BDB76B': 'Dark Khaki',
    '#9400D3': 'Dark Violet', '#4B0082': 'Indigo', '#7CFC00': 'Lawn Green',
    '#32CD32': 'Lime Green', '#00FF7F': 'Spring Green', '#008000': 'Green',
    '#808000': 'Olive', '#556B2F': 'Dark Olive', '#00FFFF': 'Cyan',
    '#00CED1': 'Dark Turquoise', '#4682B4': 'Steel Blue', '#1E90FF': 'Dodger Blue',
    '#4169E1': 'Royal Blue', '#000080': 'Navy', '#8B4513': 'Saddle Brown',
    '#C0C0C0': 'Silver', '#A9A9A9': 'Dark Gray'
  },

  getColorName(hex) {
    return this.COLOR_NAMES[(hex || '').toUpperCase()] || hex;
  },

  buildDescription(text, colorName, templateName) {
    var n = (templateName || '').toLowerCase();
    // Border style (adjective before "stamp")
    var border = '';
    if (n.indexOf('strong wavy') !== -1) border = 'deep wavy';
    else if (n.indexOf('gentle wavy') !== -1) border = 'wavy';
    else if (n.indexOf('brushstroke') !== -1) border = 'brushstroke';
    else if (n.indexOf('stitch line') !== -1) border = 'stitch line';
    else if (n.indexOf('stitch square') !== -1) border = 'stitch square';
    else if (n.indexOf('stitch circle') !== -1) border = 'stitch dot';
    else if (n.indexOf('ripped paper') !== -1) border = 'torn edge';
    else if (n.indexOf('spaced perforated') !== -1) border = 'spaced perforated';
    else if (n.indexOf('strong perforated') !== -1) border = 'deep perforated';
    else if (n.indexOf('soft perforated') !== -1) border = 'perforated';
    else if (n.indexOf('strong zigzag') !== -1) border = 'deep zigzag';
    else if (n.indexOf('soft zigzag') !== -1) border = 'zigzag';
    // Fill (adjective before "stamp")
    var fill = '';
    if (n.indexOf('empty') !== -1) fill = 'outlined';
    // Corners ("with" clause)
    var corners = '';
    if (n.indexOf('strong round') !== -1) corners = 'rounded corners';
    else if (n.indexOf('soft round') !== -1) corners = 'soft corners';
    // Frame ("with" clause)
    var frame = '';
    if (n.indexOf('double') !== -1) frame = 'double border';
    // Build: "TEXT" written on [color] [border?] [fill?] stamp [with corners? and frame?]
    var adjectives = [border, fill].filter(Boolean).join(' ');
    var stampPhrase = (adjectives ? adjectives + ' ' : '') + 'stamp';
    var withParts = [corners, frame].filter(Boolean);
    var withClause = withParts.length ? ' with ' + withParts.join(' and ') : '';
    return '\u201C' + this.escapeHtml(text) + '\u201D written on ' +
      colorName.toLowerCase() + ' ' + stampPhrase + withClause;
  },

  /**
   * Fetch all active templates with their text zones from Supabase.
   * @returns {Promise<Array>}
   */
  async fetchTemplates() {
    const { data, error } = await sb
      .from('templates')
      .select('*, text_zones(*)')
      .eq('is_active', true);

    if (error) throw new Error('Failed to fetch templates: ' + error.message);
    return data || [];
  },

  /**
   * Process all templates with user text and cache BASE results (no colorization yet).
   * @param {string} userText
   */
  async processAll(userText) {
    this.currentText = userText;
    this.baseResults = [];
    this.allResults = [];
    this.filteredResults = [];
    this.displayedCount = 0;
    this.isFirstShowMore = true;

    const templates = await this.fetchTemplates();
    if (templates.length === 0) {
      this.renderEmpty('No templates available yet.');
      return;
    }

    const storageBaseUrl = sb.storage.from('templates').getPublicUrl('').data.publicUrl;

    for (const tpl of templates) {
      try {
        // Build the full public URL for the SVG
        const svgUrl = storageBaseUrl.replace(/\/$/, '') + '/' + tpl.svg_path;
        const rawSvg = await SvgRenderer.fetchSvg(svgUrl);
        var cleanedSvg = SvgRenderer.cleanSvgString(rawSvg);

        // Detect text case from original SVG
        var displayText = userText;
        var textMatch = cleanedSvg.match(/<text[^>]*>([\s\S]*?)<\/text>/i);
        if (textMatch) {
          var inner = textMatch[1].replace(/<[^>]*>/g, '');
          inner = inner.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
          var letters = inner.replace(/[^a-zA-Z]/g, '');
          if (letters.length > 0) {
            var upper = letters.replace(/[^A-Z]/g, '').length;
            var lower = letters.replace(/[^a-z]/g, '').length;
            if (upper > 0 && lower === 0) displayText = userText.toUpperCase();
            else if (lower > 0 && upper === 0) displayText = userText.toLowerCase();
          }
        }

        // Get editable text zones sorted by sort_order
        const editableZones = (tpl.text_zones || [])
          .filter(z => z.is_editable)
          .sort((a, b) => a.sort_order - b.sort_order);

        // Replace text in each editable zone (string-based, preserves fonts)
        var didAutoFit = false;
        for (const zone of editableZones) {
          const idx = zone.svg_element_index || 0;
          cleanedSvg = SvgRenderer.replaceTextInString(cleanedSvg, idx, userText);

          // Auto-fit if bounding_width is set
          if (zone.bounding_width) {
            const originalScaleX = zone.transform_matrix
              ? parseFloat(zone.transform_matrix.match(/matrix\(\s*([\d.]+)/)?.[1]) || 1
              : 1;
            cleanedSvg = await SvgRenderer.autoFitTextInString(
              cleanedSvg,
              idx,
              zone.bounding_width,
              zone.font_size,
              originalScaleX
            );
            didAutoFit = true;
          }
        }

        // Category 2 (Fixed Frame): always auto-fit using container rect from SVG
        if (!didAutoFit && /<image[\s>]/i.test(cleanedSvg)) {
          cleanedSvg = await SvgRenderer.autoFitTextInString(cleanedSvg, 0, 1, 128, 1);
        }

        this.baseResults.push({
          templateId: tpl.id,
          svgString: cleanedSvg,
          shape: tpl.shape,
          objectType: tpl.object_type,
          colors: tpl.colors || [],
          width: tpl.width,
          height: tpl.height,
          name: tpl.name,
          displayText: displayText
        });
      } catch (err) {
        console.warn('Failed to process template ' + tpl.name + ':', err);
      }
    }
  },

  /**
   * Show initial random results after Stamp click.
   * Each stamp gets a random palette color, random tilt, and random texture applied.
   * Clears all previous batches.
   * @param {number} count
   */
  async showInitialRandom(count) {
    // Clear all previous batches
    var container = document.getElementById('results-batches');
    container.innerHTML = '';
    this.displayedCount = 0;
    this.allResults = [];

    if (this.baseResults.length === 0) {
      this.renderEmpty('No results to show.');
      return;
    }

    // Build `count` stamps, each with a unique random color, random tilt, and random texture.
    var shuffled = [...this.baseResults].sort(function () { return Math.random() - 0.5; });
    var batch = [];
    var usedColors = [];
    var TILTS = [0, -20];
    var TEXTURES = [null, 'grungy_texture']; // null = no texture

    for (var i = 0; i < count; i++) {
      var base = shuffled[i % shuffled.length];
      var available = this.PALETTE_COLORS.filter(function (c) { return usedColors.indexOf(c) === -1; });
      if (available.length === 0) available = this.PALETTE_COLORS;
      var randomColor = available[Math.floor(Math.random() * available.length)];
      usedColors.push(randomColor);

      var randomTilt = TILTS[Math.floor(Math.random() * TILTS.length)];
      var randomTexture = TEXTURES[Math.floor(Math.random() * TEXTURES.length)];

      try {
        var colorized = SvgRenderer.colorize(base.svgString, randomColor);
        var cropped = await SvgRenderer.cropViewBoxFixedFrame(colorized);
        var tilted = randomTilt !== 0 ? SvgRenderer.applyTilt(cropped, randomTilt) : cropped;
        var textured = randomTexture ? await SvgRenderer.applyTexture(tilted, randomTexture) : tilted;

        // Validate we got a non-empty SVG
        if (!textured || textured.indexOf('<svg') === -1) {
          console.warn('Empty SVG result, using colorized version without texture');
          textured = tilted;
        }

        batch.push({
          templateId: base.templateId,
          svgString: textured,
          shape: base.shape,
          objectType: base.objectType,
          colors: base.colors,
          width: base.width,
          height: base.height,
          name: base.name,
          displayText: base.displayText,
          appliedColor: randomColor,
          appliedTilt: randomTilt,
          appliedTexture: randomTexture
        });
      } catch (err) {
        console.warn('Failed to process stamp variant:', err);
        // Fallback: use base SVG with just colorization
        batch.push({
          templateId: base.templateId,
          svgString: SvgRenderer.colorize(base.svgString, randomColor),
          shape: base.shape,
          objectType: base.objectType,
          colors: base.colors,
          width: base.width,
          height: base.height,
          name: base.name,
          displayText: base.displayText,
          appliedColor: randomColor,
          appliedTilt: 0,
          appliedTexture: null
        });
      }
    }

    this.allResults = batch;

    // Render as a batch section
    var userText = document.getElementById('stamp-input').value.trim();
    var title = 'Showing <strong>' + batch.length + '</strong> results for <strong>"' + this.escapeHtml(userText) + '"</strong>. Want to see more? Hit that <strong>Show more</strong> button and select your preferences.<br><span class="stamp-results-timestamp">Generated at ' + this.formatTime() + '</span>';
    this.appendBatchSection(title, batch);
    this.updateBatchButtons('initial');

    this.showResultsUI();
  },

  /**
   * Apply filters and build colorized + tilted + textured variants.
   * Selected colors = output colors to colorize with.
   * Selected tilts = rotation angles (0, -20).
   * Selected textures = texture overlays to apply.
   * Shape/object filters = template attribute filters.
   * Generates: template × color × tilt × texture (with "none" always included).
   * @param {Object} filters - { colors: [], tilts: [], textures: [], shapes: [], objects: [] }
   */
  async applyFilters(filters) {
    // Filter base templates by shape and object type
    var matchingBases = this.baseResults.filter(function (r) {
      if (filters.shapes.length > 0) {
        if (filters.shapes.indexOf(r.shape) === -1) return false;
      }
      if (filters.objects.length > 0) {
        if (filters.objects.indexOf(r.objectType) === -1) return false;
      }
      return true;
    });

    // Determine which colors to use for colorization
    var colorsToApply = filters.colors.length > 0
      ? filters.colors
      : [this.PALETTE_COLORS[Math.floor(Math.random() * this.PALETTE_COLORS.length)]];

    // Determine which tilts to apply (default to straight)
    var tiltsToApply = filters.tilts && filters.tilts.length > 0
      ? filters.tilts
      : [0];

    // Determine which textures to apply
    // "none" maps to null (no texture), other values are texture IDs
    var texturesToApply = [null]; // default if nothing selected
    if (filters.textures && filters.textures.length > 0) {
      texturesToApply = filters.textures.map(function (t) {
        return t === 'none' ? null : t;
      });
    }

    // Generate variants: template × color × tilt × texture
    var variants = [];
    for (var i = 0; i < matchingBases.length; i++) {
      var base = matchingBases[i];
      for (var j = 0; j < colorsToApply.length; j++) {
        var color = colorsToApply[j];
        var colorized = SvgRenderer.colorize(base.svgString, color);
        var cropped = await SvgRenderer.cropViewBoxFixedFrame(colorized);
        for (var k = 0; k < tiltsToApply.length; k++) {
          var tilt = tiltsToApply[k];
          var tilted = tilt !== 0 ? SvgRenderer.applyTilt(cropped, tilt) : cropped;
          for (var t = 0; t < texturesToApply.length; t++) {
            var textureId = texturesToApply[t];
            try {
              var textured = textureId ? await SvgRenderer.applyTexture(tilted, textureId) : tilted;
              // Validate we got a non-empty SVG
              if (!textured || textured.indexOf('<svg') === -1) {
                textured = tilted;
              }
              variants.push({
                templateId: base.templateId,
                svgString: textured,
                shape: base.shape,
                objectType: base.objectType,
                colors: base.colors,
                width: base.width,
                height: base.height,
                name: base.name,
          displayText: base.displayText,
                appliedColor: color,
                appliedTilt: tilt,
                appliedTexture: textureId
              });
            } catch (err) {
              console.warn('Failed to apply texture, using tilted version:', err);
              variants.push({
                templateId: base.templateId,
                svgString: tilted,
                shape: base.shape,
                objectType: base.objectType,
                colors: base.colors,
                width: base.width,
                height: base.height,
                name: base.name,
          displayText: base.displayText,
                appliedColor: color,
                appliedTilt: tilt,
                appliedTexture: null
              });
            }
          }
        }
      }
    }

    // Shuffle variants for variety
    variants.sort(function () { return Math.random() - 0.5; });

    this.filteredResults = variants;
    // Append new variants to allResults so download can find them
    this.allResults = this.allResults.concat(variants);
    this.displayedCount = 0;
    this.isFirstShowMore = false;
  },

  /**
   * Show next page of filtered results as a new batch section.
   * @param {number} count
   */
  showNextPage(count) {
    if (this.displayedCount >= this.filteredResults.length) {
      this.hideLastShowMore();
      return;
    }

    var batch = this.filteredResults.slice(this.displayedCount, this.displayedCount + count);
    this.displayedCount += batch.length;

    // Render as a new batch section
    var userText = document.getElementById('stamp-input').value.trim();
    var title = 'Here are <strong>' + batch.length + '</strong> more results for <strong>"' + this.escapeHtml(userText) + '"</strong> based on your preferences.<br><span class="stamp-results-timestamp">Generated at ' + this.formatTime() + '</span>';
    this.appendBatchSection(title, batch);
    this.updateBatchButtons('filtered');

    if (this.displayedCount >= this.filteredResults.length) {
      this.hideLastShowMore();
    }
  },

  /**
   * Append a new batch section (title + grid) to the results container.
   * @param {string} titleHtml
   * @param {Array} results
   */
  appendBatchSection(titleHtml, results) {
    var container = document.getElementById('results-batches');

    // Create batch wrapper
    var section = document.createElement('div');
    section.className = 'stamp-batch-section';

    // Title
    var titleDiv = document.createElement('div');
    titleDiv.className = 'stamp-results-title';
    titleDiv.innerHTML = titleHtml;
    section.appendChild(titleDiv);

    // Grid
    var grid = document.createElement('div');
    grid.className = 'stamp-results-grid';

    var self = this;
    results.forEach(function (r) {
      var card = document.createElement('div');
      card.className = 'stamp-card';

      // Create preview with inline SVG
      var previewDiv = document.createElement('div');
      previewDiv.className = 'stamp-card-preview';
      var img = SvgRenderer.createSvgImage(r.svgString);
      previewDiv.appendChild(img);

      var productUrl = '/product.html?id=' + encodeURIComponent(r.templateId) +
        '&text=' + encodeURIComponent(self.currentText) +
        '&color=' + encodeURIComponent((r.appliedColor || '').replace('#', '')) +
        '&tilt=' + encodeURIComponent(r.appliedTilt || 0) +
        (r.appliedTexture ? '&texture=' + encodeURIComponent(r.appliedTexture) : '');

      var colorName = self.getColorName(r.appliedColor);
      var description = self.buildDescription(r.displayText || self.currentText, colorName, r.name);

      var actionsDiv = document.createElement('a');
      actionsDiv.className = 'stamp-card-actions';
      actionsDiv.href = productUrl;
      actionsDiv.innerHTML = '<span class="stamp-card-name">' + description + '</span>';

      card.appendChild(previewDiv);
      card.appendChild(actionsDiv);
      grid.appendChild(card);
    });

    section.appendChild(grid);
    container.appendChild(section);

    // Save variant params to localStorage for back-navigation restore
    // (HTML save may fail for large base64 SVGs exceeding 5MB localStorage limit)
    try {
      localStorage.setItem('stx-gallery-text', this.currentText);
      // Save compact variant params (tiny, guaranteed to fit)
      var variantParams = results.map(function(r) {
        return {
          t: r.templateId,
          c: r.appliedColor || '',
          i: r.appliedTilt || 0,
          x: r.appliedTexture || ''
        };
      });
      localStorage.setItem('stx-gallery-params', JSON.stringify(variantParams));
    } catch (e) {
      console.warn('[Gallery] localStorage save failed:', e.message);
    }

    // Scroll to the new batch
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  /**
   * Remove action buttons from all batch sections, then add to the last one.
   * @param {string} mode - 'initial' (Show more only) or 'filtered' (Show more + Change preferences)
   */
  updateBatchButtons(mode) {
    // Remove all existing action buttons
    document.querySelectorAll('.stamp-batch-actions').forEach(function (el) {
      el.parentNode.removeChild(el);
    });

    // Add buttons to the last batch section
    var sections = document.querySelectorAll('.stamp-batch-section');
    if (sections.length === 0) return;
    var last = sections[sections.length - 1];

    var actionsDiv = document.createElement('div');
    actionsDiv.className = 'stamp-results-actions stamp-batch-actions';

    if (mode === 'initial') {
      actionsDiv.innerHTML =
        '<button class="btn btn-primary btn-batch-show-more">Show more</button>';
    } else {
      actionsDiv.innerHTML =
        '<button class="btn btn-primary btn-batch-show-more">Show more</button>' +
        '<button class="btn btn-secondary btn-batch-change-prefs">Change preferences</button>';
    }

    last.appendChild(actionsDiv);
  },

  renderEmpty(message) {
    var container = document.getElementById('results-batches');
    container.innerHTML = '<div class="stamp-empty">' + message + '</div>';
  },

  showResultsUI() {
    document.getElementById('stamp-results').style.display = 'block';
  },

  /**
   * Hide "Show more" button in the last batch section (no more results).
   */
  hideLastShowMore() {
    var actions = document.querySelector('.stamp-batch-actions');
    if (actions) {
      var btn = actions.querySelector('.btn-batch-show-more');
      if (btn) btn.style.display = 'none';
    }
  },

  formatTime() {
    var now = new Date();
    var h = now.getHours();
    var m = now.getMinutes().toString().padStart(2, '0');
    var s = now.getSeconds().toString().padStart(2, '0');
    var ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + m + ':' + s + ' ' + ampm;
  },

  /**
   * Show a zoom overlay with the stamp SVG at 2x the card size.
   * Click overlay or press Escape to close.
   * @param {string} svgString
   */
  showZoomOverlay(svgString) {
    // Remove any existing overlay
    var existing = document.querySelector('.stamp-zoom-overlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.className = 'stamp-zoom-overlay';

    var content = document.createElement('div');
    content.className = 'stamp-zoom-content';
    content.innerHTML = svgString;

    // Make the SVG inside responsive at 2x the card width
    var svgEl = content.querySelector('svg');
    if (svgEl) {
      svgEl.removeAttribute('width');
      svgEl.removeAttribute('height');
      // Cards are ~300px wide in the grid; zoom shows ~600px
      svgEl.style.width = '600px';
      svgEl.style.height = 'auto';
    }

    overlay.appendChild(content);
    document.body.appendChild(overlay);

    // Close on overlay click (not on content click)
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        overlay.remove();
      }
    });

    // Close on Escape
    function onKey(e) {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
      }
    }
    document.addEventListener('keydown', onKey);
  },

  /**
   * Restore gallery from saved variant params (deterministic re-render).
   * Fetches templates, processes text, then applies exact saved color/tilt/texture.
   * @param {string} userText
   * @param {Array} variantParams - [{t: templateId, c: color, i: tilt, x: texture}]
   */
  async restoreVariants(userText, variantParams) {
    this.currentText = userText;

    // Process all templates (fetch SVGs, replace text, auto-fit)
    await this.processAll(userText);

    // Build variants using saved params (deterministic — no randomness)
    var batch = [];
    var self = this;
    for (var i = 0; i < variantParams.length; i++) {
      var vp = variantParams[i];
      var base = this.baseResults.find(function(r) { return String(r.templateId) === String(vp.t); });
      if (!base) continue;

      try {
        var colorized = SvgRenderer.colorize(base.svgString, vp.c);
        var cropped = await SvgRenderer.cropViewBoxFixedFrame(colorized);
        var tilted = vp.i !== 0 ? SvgRenderer.applyTilt(cropped, vp.i) : cropped;
        var textured = vp.x ? await SvgRenderer.applyTexture(tilted, vp.x) : tilted;

        if (!textured || textured.indexOf('<svg') === -1) textured = tilted;

        batch.push({
          templateId: base.templateId,
          svgString: textured,
          shape: base.shape,
          objectType: base.objectType,
          colors: base.colors,
          width: base.width,
          height: base.height,
          name: base.name,
          displayText: base.displayText,
          appliedColor: vp.c,
          appliedTilt: vp.i,
          appliedTexture: vp.x || null
        });
      } catch (err) {
        console.warn('Failed to restore variant:', err);
      }
    }

    if (batch.length === 0) {
      this.renderEmpty('Could not restore gallery. Please try again.');
      return;
    }

    // Clear and render
    var container = document.getElementById('results-batches');
    container.innerHTML = '';
    this.allResults = batch;
    this.displayedCount = 0;

    var title = 'Showing <strong>' + batch.length + '</strong> results for <strong>\u201C' +
      this.escapeHtml(userText) + '\u201D</strong>.<br><span class="stamp-results-timestamp">Restored at ' +
      this.formatTime() + '</span>';
    this.appendBatchSection(title, batch);
    this.updateBatchButtons('initial');
    this.showResultsUI();
  },

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
};
