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
  baseResults: [],    // [{templateId, svgString, shape, objectType, frameType, borderType, fillType, cornerType, colors, width, height, name}]

  // Currently displayed/available results (colorized variants)
  allResults: [],       // [{...baseResult, appliedColor, appliedTilt, appliedTexture}]
  filteredResults: [],
  displayedCount: 0,
  isFirstShowMore: true,

  // Palette colors (same as stamp-app.js)
  PALETTE_COLORS: [
    '#000000', '#8B0000', '#003366', '#2D572C', '#4B0082',
    '#FF0000', '#FF6600', '#1E90FF', '#FF1493', '#32CD32'
  ],

  COLOR_NAMES: {
    '#000000': 'Black', '#8B0000': 'Dark Red', '#003366': 'Navy',
    '#2D572C': 'Forest Green', '#4B0082': 'Indigo',
    '#FF0000': 'Red', '#FF6600': 'Orange', '#1E90FF': 'Dodger Blue',
    '#FF1493': 'Hot Pink', '#32CD32': 'Lime Green'
  },

  getColorName(hex) {
    return this.COLOR_NAMES[(hex || '').toUpperCase()] || hex;
  },

  BORDER_LABELS: {
    wavy: 'wavy', brushstroke: 'brushstroke',
    stitch_line: 'stitch line', stitch_square: 'stitch square', stitch_circle: 'stitch dot',
    torn_edge: 'torn edge', perforated_spaced: 'spaced perforated',
    perforated: 'perforated', zigzag: 'zigzag'
  },

  // Border style family grouping (mirrors admin-templates.js)
  BORDER_STYLE_FAMILIES: {
    simple:            { family: 1, sub: 1 },
    stitch_line:       { family: 2, sub: 1 },
    stitch_square:     { family: 2, sub: 2 },
    stitch_circle:     { family: 2, sub: 3 },
    zigzag:            { family: 3, sub: 1 },
    perforated:        { family: 3, sub: 2 },
    perforated_spaced: { family: 3, sub: 3 },
    wavy:              { family: 3, sub: 4 },
    brushstroke:       { family: 4, sub: 1 },
    torn_edge:         { family: 4, sub: 2 }
  },

  FAMILY_NAMES: {
    1: 'Plain border',
    2: 'Stitch border',
    3: 'Zigzag / Perforated border',
    4: 'Irregular border'
  },

  CORNER_ORDER: { straight: 1, soft_round: 2, medium_round: 3, strong_round: 4 },

  FRAME_ORDER: ['single', 'double', 'split'],

  // Which border counts are valid per border style (tested in in-frame-preview.html)
  FRAME_COMPAT: {
    simple:            ['single', 'double', 'split'],
    stitch_line:       ['single', 'double', 'split'],
    stitch_square:     ['single', 'double', 'split'],
    stitch_circle:     ['single', 'double', 'split'],
    zigzag:            ['single', 'double'],
    perforated:        ['single', 'double'],
    perforated_spaced: ['single', 'double'],
    wavy:              ['single', 'split'],
    brushstroke:       ['single', 'double'],
    torn_edge:         ['single', 'double', 'split']
  },

  buildDescription(text, colorName, borderType, fillType, cornerType, objectType, appliedTilt, appliedTexture, appliedFrame, svgString) {
    var border = this.BORDER_LABELS[borderType] || 'plain';
    var fill = (fillType === 'empty') ? 'outlined' : 'filled';
    var texture = (appliedTexture === 'grungy_texture') ? 'grungy' : '';
    var tilt = (appliedTilt && appliedTilt !== 0) ? 'tilted' : '';
    var frame = '';
    if (appliedFrame === 'double') frame = 'double border';
    else if (appliedFrame === 'split') frame = 'split border';
    var shape = '';
    if (svgString) {
      var vbM = svgString.match(/viewBox=["']\s*[\d.\-]+\s+[\d.\-]+\s+([\d.\-]+)\s+([\d.\-]+)/);
      if (vbM) {
        var ratio = parseFloat(vbM[1]) / parseFloat(vbM[2]);
        shape = (ratio >= 0.85 && ratio <= 1.15) ? 'square' : 'rectangle';
      }
    }
    var obj = ((shape || 'rectangle') + ' ' + (objectType || 'stamp')).replace(/_/g, ' ');
    var corners = 'straight corners';
    if (cornerType === 'strong_round') corners = 'strong round corners';
    else if (cornerType === 'medium_round') corners = 'medium round corners';
    else if (cornerType === 'soft_round') corners = 'soft round corners';
    // Build: "TEXT" written on [fill] [color] [texture?] [tilt?] [border style?] [frame?] [shape] [objectType] [with corners?]
    var adjectives = [texture, tilt, border, frame].filter(Boolean).join(' ');
    var objPhrase = (adjectives ? adjectives + ' ' : '') + obj;
    var withParts = [corners].filter(Boolean);
    var withClause = withParts.length ? ' with ' + withParts.join(' and ') : '';
    return '\u201C' + this.escapeHtml(text) + '\u201D written on ' +
      fill + ' ' + colorName.toLowerCase() + ' ' + objPhrase + withClause;
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
        cleanedSvg = SvgRenderer.uniquifySvgIds(cleanedSvg);

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
          frameType: tpl.frame_type || 'single',
          borderType: tpl.border_type || null,
          fillType: tpl.fill_type || 'full',
          cornerType: tpl.corner_type || null,
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
   * Show initial catalog: all templates × 3 border counts, grouped by border style family.
   * Random colors from palette, no tilt, no texture.
   * Order: family → sub-type → corner → border count → fill.
   */
  async showInitialRandom() {
    // Clear all previous batches
    var container = document.getElementById('results-batches');
    container.innerHTML = '';
    this.displayedCount = 0;
    this.allResults = [];

    if (this.baseResults.length === 0) {
      this.renderEmpty('No results to show.');
      return;
    }

    var self = this;

    // Filter to single-frame templates only (double-frame variants generated programmatically)
    var singles = this.baseResults.filter(function(b) { return b.frameType === 'single'; });

    // Sort by family → sub-type → corner → fill (full before empty)
    singles.sort(function(a, b) {
      var fa = self.BORDER_STYLE_FAMILIES[a.borderType || 'simple'] || { family: 99, sub: 99 };
      var fb = self.BORDER_STYLE_FAMILIES[b.borderType || 'simple'] || { family: 99, sub: 99 };
      if (fa.family !== fb.family) return fa.family - fb.family;
      if (fa.sub !== fb.sub) return fa.sub - fb.sub;
      var ca = self.CORNER_ORDER[a.cornerType || 'straight'] || 99;
      var cb = self.CORNER_ORDER[b.cornerType || 'straight'] || 99;
      if (ca !== cb) return ca - cb;
      // Full before empty
      var filla = a.fillType === 'full' ? 0 : 1;
      var fillb = b.fillType === 'full' ? 0 : 1;
      return filla - fillb;
    });

    // Build family groups: { familyId: { name, results[] } }
    var familyGroups = {};
    var allResults = [];

    for (var i = 0; i < singles.length; i++) {
      var base = singles[i];
      var familyInfo = this.BORDER_STYLE_FAMILIES[base.borderType || 'simple'] || { family: 1, sub: 1 };
      var familyId = familyInfo.family;

      if (!familyGroups[familyId]) {
        var shapeLabel = (base.shape || 'rectangle').replace(/_/g, '/');
        familyGroups[familyId] = {
          name: this.FAMILY_NAMES[familyId] + ' ' + shapeLabel + ' stamps',
          results: []
        };
      }

      // Detect border info once per template (needed for double + split)
      var bi = SvgRenderer.detectBorderType(base.svgString);
      SvgRenderer.supplementBorderInfo(bi, { border_type: base.borderType, fill_type: base.fillType });

      // Generate border count variants (filtered by compatibility)
      var allowedFrames = this.FRAME_COMPAT[base.borderType || 'simple'] || this.FRAME_ORDER;
      for (var f = 0; f < allowedFrames.length; f++) {
        var frameMode = allowedFrames[f];

        // Random color per variant
        var color = this.PALETTE_COLORS[Math.floor(Math.random() * this.PALETTE_COLORS.length)];

        var colorized, cropped;
        try {
          colorized = SvgRenderer.colorize(base.svgString, color);
          colorized = SvgRenderer.applyCornerRadius(colorized, base.cornerType);
          cropped = await SvgRenderer.cropViewBoxFixedFrame(colorized);
        } catch (err) {
          console.warn('Failed to process template:', base.name, err);
          cropped = SvgRenderer.colorize(base.svgString, color);
        }

        var framed = cropped;
        try {
          if (frameMode === 'double') {
            framed = SvgRenderer.addDoubleFrame(cropped, bi, color);
          } else if (frameMode === 'split') {
            framed = SvgRenderer.addSplitBorder(cropped, bi);
          }
        } catch (err) {
          console.warn('Failed to apply frame "' + frameMode + '" to:', base.name, err);
          framed = cropped;
        }

        var result = {
          templateId: base.templateId,
          svgString: framed,
          shape: base.shape,
          objectType: base.objectType,
          frameType: base.frameType,
          borderType: base.borderType,
          fillType: base.fillType,
          cornerType: base.cornerType,
          colors: base.colors,
          width: base.width,
          height: base.height,
          name: base.name,
          displayText: base.displayText,
          appliedColor: color,
          appliedFrame: frameMode,
          appliedTilt: 0,
          appliedTexture: null
        };

        familyGroups[familyId].results.push(result);
        allResults.push(result);
      }
    }

    this.allResults = allResults;

    // Render grouped sections
    this.appendGroupedBatchSections(familyGroups, allResults.length);
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
      if (filters.shapes && filters.shapes.length > 0) {
        if (filters.shapes.indexOf(r.shape) === -1) return false;
      }
      if (filters.objects && filters.objects.length > 0) {
        if (filters.objects.indexOf(r.objectType) === -1) return false;
      }
      if (filters.frames && filters.frames.length > 0) {
        // 'split' is a rendering of single templates, so match 'single' frame_type
        var matchesFrame = filters.frames.indexOf(r.frameType) !== -1;
        if (!matchesFrame && r.frameType === 'single' && filters.frames.indexOf('split') !== -1) {
          matchesFrame = true;
        }
        if (!matchesFrame) return false;
      }
      if (filters.borders && filters.borders.length > 0) {
        var borderVal = r.borderType || 'simple';
        if (filters.borders.indexOf(borderVal) === -1) return false;
      }
      if (filters.corners && filters.corners.length > 0) {
        var cornerVal = r.cornerType || 'straight';
        if (filters.corners.indexOf(cornerVal) === -1) return false;
      }
      if (filters.fills && filters.fills.length > 0) {
        if (filters.fills.indexOf(r.fillType) === -1) return false;
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

    // Determine which frame renderings are selected
    var selectedFrames = filters.frames && filters.frames.length > 0 ? filters.frames : [];

    // Generate variants: template × color × frame × tilt × texture
    var variants = [];
    for (var i = 0; i < matchingBases.length; i++) {
      var base = matchingBases[i];

      // Determine which frame renderings apply to this template
      var frameRenderings = [];
      if (selectedFrames.length === 0) {
        // No frame filter = show template as-is
        frameRenderings = ['none'];
      } else {
        if (base.frameType === 'single' && selectedFrames.indexOf('single') !== -1) frameRenderings.push('single');
        if (base.frameType === 'double' && selectedFrames.indexOf('double') !== -1) frameRenderings.push('double');
        if (base.frameType === 'single' && selectedFrames.indexOf('split') !== -1) frameRenderings.push('split');
      }
      if (frameRenderings.length === 0) continue;

      // Compute border info once per template (needed for split)
      var bi = null;
      if (frameRenderings.indexOf('split') !== -1) {
        bi = SvgRenderer.detectBorderType(base.svgString);
        SvgRenderer.supplementBorderInfo(bi, { border_type: base.borderType, fill_type: base.fillType });
      }

      for (var j = 0; j < colorsToApply.length; j++) {
        var color = colorsToApply[j];
        var colorized = SvgRenderer.colorize(base.svgString, color);
        var cropped = await SvgRenderer.cropViewBoxFixedFrame(colorized);

        for (var f = 0; f < frameRenderings.length; f++) {
          var frameMode = frameRenderings[f];
          var framed = cropped;
          if (frameMode === 'split') {
            framed = SvgRenderer.addSplitBorder(cropped, bi);
          }

          for (var k = 0; k < tiltsToApply.length; k++) {
            var tilt = tiltsToApply[k];
            var tilted = tilt !== 0 ? SvgRenderer.applyTilt(framed, tilt) : framed;
            for (var t = 0; t < texturesToApply.length; t++) {
              var textureId = texturesToApply[t];
              try {
                var textured = textureId ? await SvgRenderer.applyTexture(tilted, textureId) : tilted;
                if (!textured || textured.indexOf('<svg') === -1) {
                  textured = tilted;
                }
                variants.push({
                  templateId: base.templateId,
                  svgString: textured,
                  shape: base.shape,
                  objectType: base.objectType,
                  frameType: base.frameType,
                  borderType: base.borderType,
                  fillType: base.fillType,
                  cornerType: base.cornerType,
                  colors: base.colors,
                  width: base.width,
                  height: base.height,
                  name: base.name,
                  displayText: base.displayText,
                  appliedColor: color,
                  appliedFrame: frameMode === 'none' ? base.frameType : frameMode,
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
                  frameType: base.frameType,
                  borderType: base.borderType,
                  fillType: base.fillType,
                  cornerType: base.cornerType,
                  colors: base.colors,
                  width: base.width,
                  height: base.height,
                  name: base.name,
                  displayText: base.displayText,
                  appliedColor: color,
                  appliedFrame: frameMode === 'none' ? base.frameType : frameMode,
                  appliedTilt: tilt,
                  appliedTexture: null
                });
              }
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
        '&frame=' + encodeURIComponent(r.appliedFrame || r.frameType || 'single') +
        '&tilt=' + encodeURIComponent(r.appliedTilt || 0) +
        (r.appliedTexture ? '&texture=' + encodeURIComponent(r.appliedTexture) : '');

      var colorName = self.getColorName(r.appliedColor);
      var description = self.buildDescription(
        r.displayText || self.currentText, colorName,
        r.borderType, r.fillType, r.cornerType,
        r.objectType, r.appliedTilt, r.appliedTexture,
        r.appliedFrame, r.svgString
      );

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
          f: r.appliedFrame || r.frameType || 'single',
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
   * Render grouped batch sections by border style family.
   * Each family gets its own header + grid.
   */
  appendGroupedBatchSections(familyGroups, totalCount, isRestore) {
    var container = document.getElementById('results-batches');
    var self = this;
    var userText = document.getElementById('stamp-input').value.trim();

    // Overall header
    var headerSection = document.createElement('div');
    headerSection.className = 'stamp-batch-section';
    var headerTitle = document.createElement('div');
    headerTitle.className = 'stamp-results-title';
    var timeLabel = isRestore ? 'Restored at' : 'Generated at';
    var headerMsg = isRestore
      ? 'Showing <strong>' + totalCount + '</strong> results for <strong>\u201C' + this.escapeHtml(userText) + '\u201D</strong>. Use the filters to narrow down.'
      : 'Showing <strong>' + totalCount + '</strong> results for <strong>\u201C' + this.escapeHtml(userText) + '\u201D</strong> with random colors. Use the filters to narrow down. Click on the image you like and play with color, font, tilt and texture.';
    headerTitle.innerHTML = headerMsg + '<br><span class="stamp-results-timestamp">' + timeLabel + ' ' + this.formatTime() + '</span>';
    headerSection.appendChild(headerTitle);
    container.appendChild(headerSection);

    // Move filter bar into position right after the header
    var filterBar = document.getElementById('stamp-filter-bar');
    if (filterBar) {
      container.insertBefore(filterBar, headerSection.nextSibling);
    }

    // Render each family group in order
    var familyIds = Object.keys(familyGroups).sort(function(a, b) { return parseInt(a) - parseInt(b); });
    for (var i = 0; i < familyIds.length; i++) {
      var group = familyGroups[familyIds[i]];

      var section = document.createElement('div');
      section.className = 'stamp-batch-section';
      section.dataset.family = familyIds[i];

      // Family header
      var familyHeader = document.createElement('div');
      familyHeader.className = 'stamp-family-header';
      familyHeader.textContent = group.name;
      section.appendChild(familyHeader);

      // Grid
      var grid = document.createElement('div');
      grid.className = 'stamp-results-grid';

      group.results.forEach(function(r) {
        var card = document.createElement('div');
        card.className = 'stamp-card';
        card.dataset.family = (self.BORDER_STYLE_FAMILIES[r.borderType || 'simple'] || { family: 1 }).family;
        card.dataset.frame = r.appliedFrame || 'single';
        card.dataset.corners = r.cornerType || 'straight';
        card.dataset.fill = r.fillType || 'full';

        var previewDiv = document.createElement('div');
        previewDiv.className = 'stamp-card-preview';
        var img = SvgRenderer.createSvgImage(r.svgString);
        previewDiv.appendChild(img);

        var productUrl = '/product.html?id=' + encodeURIComponent(r.templateId) +
          '&text=' + encodeURIComponent(self.currentText) +
          '&color=' + encodeURIComponent((r.appliedColor || '').replace('#', '')) +
          '&frame=' + encodeURIComponent(r.appliedFrame || r.frameType || 'single') +
          '&tilt=' + encodeURIComponent(r.appliedTilt || 0) +
          (r.appliedTexture ? '&texture=' + encodeURIComponent(r.appliedTexture) : '');

        var colorName = self.getColorName(r.appliedColor);
        var description = self.buildDescription(
          r.displayText || self.currentText, colorName,
          r.borderType, r.fillType, r.cornerType,
          r.objectType, r.appliedTilt, r.appliedTexture,
          r.appliedFrame, r.svgString
        );

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
    }

    // Save variant params to localStorage
    var allResults = [];
    for (var j = 0; j < familyIds.length; j++) {
      allResults = allResults.concat(familyGroups[familyIds[j]].results);
    }
    try {
      localStorage.setItem('stx-gallery-text', this.currentText);
      var variantParams = allResults.map(function(r) {
        return {
          t: r.templateId,
          c: r.appliedColor || '',
          f: r.appliedFrame || r.frameType || 'single',
          i: r.appliedTilt || 0,
          x: r.appliedTexture || ''
        };
      });
      localStorage.setItem('stx-gallery-params', JSON.stringify(variantParams));
    } catch (e) {
      console.warn('[Gallery] localStorage save failed:', e.message);
    }
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
    var filterBar = document.getElementById('stamp-filter-bar');
    if (filterBar) {
      filterBar.style.display = 'flex';
      this.initFilterBar();
    }
  },

  /**
   * Initialize filter bar event listeners (called once per stamp).
   */
  initFilterBar() {
    var self = this;
    var selects = ['filter-border-style', 'filter-border-count', 'filter-corners', 'filter-fill'];
    selects.forEach(function(id) {
      var el = document.getElementById(id);
      if (el && !el.dataset.bound) {
        el.dataset.bound = '1';
        el.addEventListener('change', function() { self.applyFilterBar(); });
      }
    });
    var resetBtn = document.getElementById('filter-reset');
    if (resetBtn && !resetBtn.dataset.bound) {
      resetBtn.dataset.bound = '1';
      resetBtn.addEventListener('click', function() {
        selects.forEach(function(id) {
          var el = document.getElementById(id);
          if (el) el.value = '';
        });
        self.applyFilterBar();
      });
    }
  },

  /**
   * Apply filter bar dropdowns to show/hide cards and family sections.
   */
  applyFilterBar() {
    var familyVal = document.getElementById('filter-border-style').value;
    var frameVal = document.getElementById('filter-border-count').value;
    var cornersVal = document.getElementById('filter-corners').value;
    var fillVal = document.getElementById('filter-fill').value;

    var cards = document.querySelectorAll('#results-batches .stamp-card');
    var visibleCount = 0;
    cards.forEach(function(card) {
      var show = true;
      if (familyVal && card.dataset.family !== familyVal) show = false;
      if (frameVal && card.dataset.frame !== frameVal) show = false;
      if (cornersVal && card.dataset.corners !== cornersVal) show = false;
      if (fillVal && card.dataset.fill !== fillVal) show = false;
      card.style.display = show ? '' : 'none';
      if (show) visibleCount++;
    });

    // Hide family sections that have zero visible cards
    var sections = document.querySelectorAll('#results-batches .stamp-batch-section[data-family]');
    sections.forEach(function(section) {
      var visibleCards = section.querySelectorAll('.stamp-card:not([style*="display: none"])');
      section.style.display = visibleCards.length > 0 ? '' : 'none';
    });

    // Update count in header
    var titleEl = document.querySelector('#results-batches .stamp-results-title strong');
    if (titleEl) titleEl.textContent = visibleCount;
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
        colorized = SvgRenderer.applyCornerRadius(colorized, base.cornerType);
        var cropped = await SvgRenderer.cropViewBoxFixedFrame(colorized);
        var framed = cropped;
        if (vp.f === 'double' || vp.f === 'split') {
          var rbi = SvgRenderer.detectBorderType(base.svgString);
          SvgRenderer.supplementBorderInfo(rbi, { border_type: base.borderType, fill_type: base.fillType });
          if (vp.f === 'double') {
            framed = SvgRenderer.addDoubleFrame(cropped, rbi, vp.c);
          } else {
            framed = SvgRenderer.addSplitBorder(cropped, rbi);
          }
        }
        var tilted = vp.i !== 0 ? SvgRenderer.applyTilt(framed, vp.i) : framed;
        var textured = vp.x ? await SvgRenderer.applyTexture(tilted, vp.x) : tilted;

        if (!textured || textured.indexOf('<svg') === -1) textured = tilted;

        batch.push({
          templateId: base.templateId,
          svgString: textured,
          shape: base.shape,
          objectType: base.objectType,
          frameType: base.frameType,
          borderType: base.borderType,
          fillType: base.fillType,
          cornerType: base.cornerType,
          colors: base.colors,
          width: base.width,
          height: base.height,
          name: base.name,
          displayText: base.displayText,
          appliedColor: vp.c,
          appliedFrame: vp.f || base.frameType || 'single',
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

    // Clear and render — group by family just like fresh generation
    var container = document.getElementById('results-batches');
    container.innerHTML = '';
    this.allResults = batch;
    this.displayedCount = 0;

    var familyGroups = {};
    var self = this;
    for (var i = 0; i < batch.length; i++) {
      var r = batch[i];
      var familyInfo = this.BORDER_STYLE_FAMILIES[r.borderType || 'simple'] || { family: 1, sub: 1 };
      var familyId = familyInfo.family;
      if (!familyGroups[familyId]) {
        var shapeLabel = (r.shape || 'rectangle').replace(/_/g, '/');
        familyGroups[familyId] = {
          name: this.FAMILY_NAMES[familyId] + ' ' + shapeLabel + ' stamps',
          results: []
        };
      }
      familyGroups[familyId].results.push(r);
    }

    this.appendGroupedBatchSections(familyGroups, batch.length, true);
    this.updateBatchButtons('initial');
    this.showResultsUI();
  },

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
};
