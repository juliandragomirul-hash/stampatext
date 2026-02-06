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

        // Get editable text zones sorted by sort_order
        const editableZones = (tpl.text_zones || [])
          .filter(z => z.is_editable)
          .sort((a, b) => a.sort_order - b.sort_order);

        // Replace text in each editable zone (string-based, preserves fonts)
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
          }
        }

        this.baseResults.push({
          templateId: tpl.id,
          svgString: cleanedSvg,
          shape: tpl.shape,
          objectType: tpl.object_type,
          colors: tpl.colors || [],
          width: tpl.width,
          height: tpl.height,
          name: tpl.name
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
      img.style.width = '100%';
      img.style.height = 'auto';
      previewDiv.appendChild(img);

      // Zoom on click — show stamp at 2x size in overlay
      (function (svgStr) {
        previewDiv.addEventListener('click', function () {
          Gallery.showZoomOverlay(svgStr);
        });
      })(r.svgString);

      var actionsDiv = document.createElement('div');
      actionsDiv.className = 'stamp-card-actions';
      actionsDiv.innerHTML =
          '<span class="stamp-card-name">' + self.escapeHtml(r.name) + '</span>' +
          '<a class="btn-download-link" href="#" ' +
            'data-template-id="' + r.templateId + '"' +
            'data-applied-color="' + (r.appliedColor || '') + '">' +
            'Download' +
          '</a>';

      card.appendChild(previewDiv);
      card.appendChild(actionsDiv);
      grid.appendChild(card);
    });

    section.appendChild(grid);
    container.appendChild(section);

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

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
};
