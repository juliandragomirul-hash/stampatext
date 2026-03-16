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
  isShowcase: false,
  selectedColor: null,
  selectedFont: 'Oswald',
  currentFill: 'empty',

  // Palette colors (same as stamp-app.js)
  PALETTE_COLORS: [
    '#000000', '#8B0000', '#CC0000', '#FF0000',
    '#2D572C', '#32CD32',
    '#003366', '#1E90FF',
    '#4B0082', '#FF6600', '#DAA520', '#FF1493'
  ],

  COLOR_NAMES: {
    '#000000': 'Black', '#8B0000': 'Dark Red', '#CC0000': 'Crimson', '#003366': 'Navy',
    '#2D572C': 'Forest Green', '#4B0082': 'Indigo',
    '#FF0000': 'Red', '#FF6600': 'Orange', '#DAA520': 'Goldenrod', '#1E90FF': 'Dodger Blue',
    '#FF1493': 'Hot Pink', '#32CD32': 'Lime Green'
  },

  getColorName(hex) {
    return this.COLOR_NAMES[(hex || '').toUpperCase()] || hex;
  },

  BORDER_LABELS: {
    wavy: 'wavy', zigzag: 'zigzag', brushstroke: 'brushstroke',
    stitch_line: 'stitch line', stitch_square: 'stitch square', stitch_circle: 'stitch dot',
    torn_edge: 'torn edge', perforated_spaced: 'spaced perforated',
    perforated: 'perforated', sawtooth: 'sawtooth', chalk: 'chalk'
  },

  // Border style family grouping (mirrors admin-templates.js)
  BORDER_STYLE_FAMILIES: {
    simple:            { family: 1, sub: 1 },
    stitch_line:       { family: 2, sub: 1 },
    stitch_square:     { family: 2, sub: 2 },
    stitch_circle:     { family: 2, sub: 3 },
    sawtooth:          { family: 3, sub: 1 },
    perforated:        { family: 3, sub: 2 },
    perforated_spaced: { family: 3, sub: 3 },
    wavy:              { family: 3, sub: 4 },
    zigzag:            { family: 3, sub: 5 },
    brushstroke:       { family: 4, sub: 1 },
    torn_edge:         { family: 4, sub: 2 },
    chalk:             { family: 4, sub: 3 }
  },

  FAMILY_NAMES: {
    1: 'Plain border',
    2: 'Stitch border',
    3: 'Zigzag / Perforated border',
    4: 'Irregular border'
  },

  CORNER_ORDER: { straight: 1, soft_round: 2, medium_round: 3, strong_round: 4,
    mixed_top_straight: 5, mixed_top_round: 6, mixed_diag_down: 7, mixed_diag_up: 8 },

  FRAME_ORDER: ['single', 'double', 'split'],

  // Which border counts are valid per border style (tested in in-frame-preview.html)
  FRAME_COMPAT: {
    simple:            ['single', 'double', 'split'],
    stitch_line:       ['single', 'double', 'split'],
    stitch_square:     ['single', 'double', 'split'],
    stitch_circle:     ['single', 'double', 'split'],
    sawtooth:          ['single', 'double'],
    perforated:        ['single', 'double'],
    perforated_spaced: ['single', 'double'],
    wavy:              ['single', 'split'],
    zigzag:            ['single', 'split'],
    brushstroke:       ['single', 'double'],
    torn_edge:         ['single', 'double', 'split'],
    chalk:             ['single', 'double', 'split']
  },

  buildDescription(text, colorName, borderType, fillType, cornerType, objectType, appliedTilt, appliedTexture, appliedFrame, svgString, fontKey) {
    var border = this.BORDER_LABELS[borderType] || 'plain';
    // Fill is now a product-page toggle; gallery always shows outlined
    var fill = 'outlined';
    var texture = '';
    if (appliedTexture) {
      var resolved = SvgRenderer._textureAliases[appliedTexture] || appliedTexture;
      var preset = SvgRenderer._texturePresets[resolved];
      texture = preset ? preset.label.toLowerCase() : '';
    }
    var tilt = (appliedTilt && appliedTilt !== 0) ? 'tilted' : '';
    var frame = 'single border';
    if (appliedFrame === 'double') frame = 'double border';
    else if (appliedFrame === 'split') frame = 'split border';
    var shape = '';
    if (svgString) {
      // Check for lined shape (data-lined="1" marker on path)
      if (/data-lined="1"/.test(svgString)) {
        shape = 'lined';
      } else {
        var vbM = svgString.match(/viewBox=["']\s*[\d.\-]+\s+[\d.\-]+\s+([\d.\-]+)\s+([\d.\-]+)/);
        if (vbM) {
          var ratio = parseFloat(vbM[1]) / parseFloat(vbM[2]);
          shape = (ratio >= 0.85 && ratio <= 1.15) ? 'square' : 'rectangle';
        }
      }
    }
    var obj = ((shape || 'rectangle') + ' ' + (objectType || 'stamp')).replace(/_/g, ' ');
    var corners = '';
    if (shape !== 'lined') {
      corners = 'straight corners';
      if (cornerType === 'strong_round') corners = 'strong round corners';
      else if (cornerType === 'medium_round') corners = 'medium round corners';
      else if (cornerType === 'soft_round') corners = 'soft round corners';
      else if (cornerType === 'mixed_top_straight') corners = 'mixed corners (top straight)';
      else if (cornerType === 'mixed_top_round') corners = 'mixed corners (top round)';
      else if (cornerType === 'mixed_diag_down') corners = 'mixed corners (diagonal down)';
      else if (cornerType === 'mixed_diag_up') corners = 'mixed corners (diagonal up)';
    }
    // Build: "TEXT" written on [color] [tilt?] [border style?] [frame?] [filled/outlined] [shape] [objectType] with [corners] [and texture?]. FONT: [name]
    var adjectives = [tilt, border, frame].filter(Boolean).join(' ');
    var objPhrase = (adjectives ? adjectives + ' ' : '') + fill + ' ' + obj;
    var withParts = [corners, texture ? texture + ' texture' : ''].filter(Boolean);
    var withClause = withParts.length ? ' with ' + withParts.join(' and ') : '';
    var desc = '\u201C' + this.escapeHtml(text) + '\u201D written on ' +
      colorName.toLowerCase() + ' ' + objPhrase + withClause + '.';
    if (fontKey) desc += ' FONT: ' + fontKey;
    return desc;
  },

  /**
   * Fetch all active templates with their text zones from Supabase.
   * @returns {Promise<Array>}
   */
  async fetchTemplates() {
    const { data, error } = await sb
      .from('templates')
      .select('*, text_zones(*)')
      .eq('is_active', true)
      .eq('fill_type', 'empty');

    if (error) throw new Error('Failed to fetch templates: ' + error.message);
    return data || [];
  },

  /**
   * Show showcase stamps on virgin homepage (before user stamps anything).
   * All models in red with "Your text here".
   */
  async showShowcase() {
    this.isShowcase = true;
    document.getElementById('stamp-results').style.display = 'block';
    document.getElementById('results-batches').innerHTML =
      '<div class="stamp-loading">Loading stamp models...</div>';
    await this.processAll('Your text here');
    await this.showInitialRandom();
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

    // Ensure font config is loaded before rendering
    if (!SvgRenderer._fontConfig) await SvgRenderer.loadFontConfig();

    const templates = await this.fetchTemplates();
    if (templates.length === 0) {
      this.renderEmpty('No templates available yet.');
      return;
    }

    const storageBaseUrl = sb.storage.from('templates').getPublicUrl('').data.publicUrl;

    // Prefetch all SVGs in parallel (browser handles connection limits)
    var svgPromises = templates.map(function(tpl) {
      var svgUrl = storageBaseUrl.replace(/\/$/, '') + '/' + tpl.svg_path;
      return SvgRenderer.fetchSvg(svgUrl).catch(function() { return null; });
    });
    var svgs = await Promise.all(svgPromises);

    // Progress indicator element
    var progressEl = document.querySelector('.stamp-loading');

    // Font cycling: each template gets the next font for visual testing (wraps at 10)
    var FONT_CYCLE = [
      { key: 'Oswald',       weight: '500' },
      { key: 'CourierPrime',  weight: '400' },
      { key: 'Montserrat',    weight: '700' },
      { key: 'Yomogi',        weight: '400' },
      { key: 'BlackOpsOne',   weight: '400' },
      { key: 'Nunito',        weight: '900' },
      { key: 'Exo2',          weight: '700' },
      { key: 'Bitter',        weight: '500' },
      { key: 'Comfortaa',     weight: '700' },
      { key: 'FuzzyBubbles',  weight: '700' },
      { key: 'BebasNeue',    weight: '400' }
    ];
    var fontCycleIdx = 0;

    // Sort templates+SVGs by display order (family → sub → corner → fill)
    // so font cycling matches what the user sees
    var self = this;
    var paired = templates.map(function(tpl, i) { return { tpl: tpl, svg: svgs[i] }; });
    paired.sort(function(a, b) {
      var fa = self.BORDER_STYLE_FAMILIES[a.tpl.border_type || 'simple'] || { family: 99, sub: 99 };
      var fb = self.BORDER_STYLE_FAMILIES[b.tpl.border_type || 'simple'] || { family: 99, sub: 99 };
      if (fa.family !== fb.family) return fa.family - fb.family;
      if (fa.sub !== fb.sub) return fa.sub - fb.sub;
      var ca = self.CORNER_ORDER[a.tpl.corner_type || 'straight'] || 99;
      var cb = self.CORNER_ORDER[b.tpl.corner_type || 'straight'] || 99;
      return ca - cb;
    });

    // Process auto-fit sequentially (each creates an iframe for measurement)
    for (var i = 0; i < paired.length; i++) {
      var tpl = paired[i].tpl;
      if (!paired[i].svg) continue; // skip failed fetches

      if (progressEl) progressEl.textContent = 'Processing templates... (' + (i + 1) + '/' + paired.length + ')';

      try {
        var cleanedSvg = SvgRenderer.cleanSvgString(paired[i].svg);
        cleanedSvg = SvgRenderer.uniquifySvgIds(cleanedSvg);

        // Gallery font: use selected font from filter bar
        var fontKey = this.selectedFont || 'Oswald';
        var fontWeights = {
          'Oswald': '500', 'CourierPrime': '400', 'Montserrat': '700',
          'Yomogi': '400', 'BlackOpsOne': '400', 'Nunito': '900',
          'Exo2': '700', 'Bitter': '500', 'Comfortaa': '700',
          'FuzzyBubbles': '700', 'BebasNeue': '400'
        };
        var cycleFont = { key: fontKey, weight: fontWeights[fontKey] || '500' };
        cleanedSvg = cleanedSvg.replace(/font-family=["']'?[^"']*'?["']/g,
          "font-family=\"'" + cycleFont.key + "'\"");
        cleanedSvg = cleanedSvg.replace(/font-weight=["'][^"']*["']/g,
          'font-weight="' + cycleFont.weight + '"');

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
        var preAutoFitSvg = null;
        var autoFitZoneInfo = null;
        for (const zone of editableZones) {
          const idx = zone.svg_element_index || 0;
          cleanedSvg = SvgRenderer.replaceTextInString(cleanedSvg, idx, userText);

          // Auto-fit if bounding_width is set
          if (zone.bounding_width) {
            const originalScaleX = zone.transform_matrix
              ? parseFloat(zone.transform_matrix.match(/matrix\(\s*([\d.]+)/)?.[1]) || 1
              : 1;
            preAutoFitSvg = cleanedSvg;
            autoFitZoneInfo = { idx: idx, boundingWidth: zone.bounding_width, fontSize: zone.font_size, originalScaleX: originalScaleX };
            cleanedSvg = await SvgRenderer.autoFitTextInString(
              cleanedSvg,
              idx,
              zone.bounding_width,
              zone.font_size,
              originalScaleX,
              'single',
              tpl.fill_type || 'full',
              tpl.corner_type || 'straight',
              tpl.border_type || null
            );
            didAutoFit = true;
          }
        }

        // Category 2 (Fixed Frame): always auto-fit using container rect from SVG
        if (!didAutoFit && /<image[\s>]/i.test(cleanedSvg)) {
          cleanedSvg = await SvgRenderer.autoFitTextInString(cleanedSvg, 0, 1, 128, 1);
        }

        // Store measurements for per-variant re-sizing (avoids re-creating iframes)
        var autoFitMeasurements = SvgRenderer._autoFitMeasureCache
          ? { key: SvgRenderer._autoFitMeasureCache.key, measuredWidth: SvgRenderer._autoFitMeasureCache.measuredWidth, bbox: SvgRenderer._autoFitMeasureCache.bbox, numTspans: SvgRenderer._autoFitMeasureCache.numTspans, canvasAscent: SvgRenderer._autoFitMeasureCache.canvasAscent, canvasDescent: SvgRenderer._autoFitMeasureCache.canvasDescent, canvasRefAscent: SvgRenderer._autoFitMeasureCache.canvasRefAscent, canvasRefDescent: SvgRenderer._autoFitMeasureCache.canvasRefDescent, canvasMeasureFontSize: SvgRenderer._autoFitMeasureCache.canvasMeasureFontSize, canvasInkLeft: SvgRenderer._autoFitMeasureCache.canvasInkLeft, canvasInkRight: SvgRenderer._autoFitMeasureCache.canvasInkRight, canvasAdvanceWidth: SvgRenderer._autoFitMeasureCache.canvasAdvanceWidth }
          : null;

        this.baseResults.push({
          templateId: tpl.id,
          svgString: cleanedSvg,
          preAutoFitSvg: preAutoFitSvg,
          autoFitZoneInfo: autoFitZoneInfo,
          autoFitMeasurements: autoFitMeasurements,
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
          displayText: displayText,
          fontKey: cycleFont.key
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
    // Preserve filter bar before clearing (it may have been moved inside container)
    var filterBar = document.getElementById('stamp-filter-bar');
    if (filterBar && filterBar.parentNode === container) {
      container.parentNode.appendChild(filterBar);
    }
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
      return ca - cb;
    });

    // Build family groups keyed by shape prefix + familyId (e.g. 'R1', 'L2')
    // Rectangle groups (R*) render first, then Lined groups (L*)
    var familyGroups = {};
    var allResults = [];

    for (var i = 0; i < singles.length; i++) {
      var base = singles[i];
      var familyInfo = this.BORDER_STYLE_FAMILIES[base.borderType || 'simple'] || { family: 1, sub: 1 };
      var familyId = familyInfo.family;

      // Detect border info once per template (needed for double + split)
      var bi = SvgRenderer.detectBorderType(base.svgString);
      SvgRenderer.supplementBorderInfo(bi, { border_type: base.borderType, fill_type: base.fillType });

      // Generate shape × border count variants
      var allowedFrames = this.FRAME_COMPAT[base.borderType || 'simple'] || this.FRAME_ORDER;
      var shapes = ['rectangle', 'lined'];

      for (var s = 0; s < shapes.length; s++) {
        var stampShape = shapes[s];

        // Lined: skip non-straight corners (round/mixed have no meaning without vertical sides)
        if (stampShape === 'lined' && base.cornerType && base.cornerType !== 'straight') continue;

        var groupKey = stampShape === 'lined' ? 'L' : 'R';
        if (!familyGroups[groupKey]) {
          var shapeLabel = stampShape === 'lined' ? 'Lined' : 'Rectangle';
          familyGroups[groupKey] = {
            name: shapeLabel + ' stamps',
            numericFamily: 1,
            results: []
          };
        }

        for (var f = 0; f < allowedFrames.length; f++) {
          var frameMode = allowedFrames[f];
          // Skip double frame for filled stitch — too visually dense / redundant with single
          if (frameMode === 'double' && bi.stitch && base.fillType === 'full') continue;
          // Skip double frame for outlined torn edge — poor visual result
          if (frameMode === 'double' && bi.filter && base.fillType !== 'full') continue;

          // Selected color > default red
          var color = this.selectedColor || '#dc2626';

          // Per-variant font sizing: re-apply autoFit with frame-specific interior via computeTextZone
          var variantSvg = base.svgString;
          var hasRoundedCorners = base.cornerType && base.cornerType !== 'straight';
          if (base.autoFitZoneInfo && base.autoFitMeasurements && (frameMode !== 'single' || hasRoundedCorners || stampShape === 'lined')) {
            try {
              variantSvg = SvgRenderer._applyAutoFitSizing(
                base.preAutoFitSvg,
                base.autoFitZoneInfo.idx,
                base.autoFitZoneInfo.boundingWidth,
                base.autoFitZoneInfo.fontSize,
                base.autoFitZoneInfo.originalScaleX,
                frameMode,
                base.autoFitMeasurements,
                base.fillType,
                base.cornerType,
                base.borderType,
                null,
                stampShape
              );
            } catch (err) {
              console.warn('Per-variant sizing failed for', base.name, frameMode, err);
            }
          }

          var colorized, cropped;
          try {
            colorized = SvgRenderer.colorize(variantSvg, color);
            colorized = SvgRenderer.applyThinStroke(colorized);
            colorized = SvgRenderer.cropViewBoxToStamp(colorized);
            // Lined: convert rect to 2 horizontal lines, skip corner radius
            if (stampShape === 'lined') {
              colorized = SvgRenderer.convertToLined(colorized);
            } else {
              colorized = SvgRenderer.applyCornerRadius(colorized, base.cornerType);
            }
            cropped = await SvgRenderer.cropViewBoxFixedFrame(colorized);
          } catch (err) {
            console.warn('Failed to process template:', base.name, err);
            cropped = SvgRenderer.colorize(variantSvg, color);
          }

          var framed = cropped;
          try {
            if (frameMode === 'double') {
              framed = SvgRenderer.addDoubleFrame(cropped, bi, color, 'double');
            } else if (frameMode === 'split') {
              framed = SvgRenderer.addSplitBorder(cropped, bi);
            }
          } catch (err) {
            console.warn('Failed to apply frame "' + frameMode + '" to:', base.name, err);
            framed = cropped;
          }

          var result = {
            templateId: base.templateId,
            svgString: SvgRenderer.addWatermark(framed),
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
            fontKey: base.fontKey,
            appliedColor: color,
            appliedFrame: frameMode,
            appliedShape: stampShape,
            appliedTilt: 0,
            appliedTexture: null
          };

          familyGroups[groupKey].results.push(result);
          allResults.push(result);
        }
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
        var cornerMatch = filters.corners.indexOf(cornerVal) !== -1 ||
          (filters.corners.indexOf('round') !== -1 && cornerVal.indexOf('_round') !== -1) ||
          (filters.corners.indexOf('mixed') !== -1 && cornerVal.indexOf('mixed') === 0);
        if (!cornerMatch) return false;
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

      // Compute border info once per template (needed for double/split/single-decorative)
      var bi = SvgRenderer.detectBorderType(base.svgString);
      SvgRenderer.supplementBorderInfo(bi, { border_type: base.borderType, fill_type: base.fillType });

      // Frame loop OUTSIDE color loop — frame affects text sizing via computeTextZone
      for (var f = 0; f < frameRenderings.length; f++) {
        var frameMode = frameRenderings[f];
        // Skip double frame for filled stitch — too visually dense
        if (frameMode === 'double' && bi.stitch && base.fillType === 'full') continue;
        // Skip double frame for outlined torn edge — poor visual result
        if (frameMode === 'double' && bi.filter && base.fillType !== 'full') continue;

        // Per-variant font sizing: re-apply autoFit with frame-specific interior
        var variantSvg = base.svgString;
        var hasRoundedCorners = base.cornerType && base.cornerType !== 'straight';
        if (base.autoFitZoneInfo && base.autoFitMeasurements &&
            (frameMode !== 'single' || hasRoundedCorners)) {
          try {
            variantSvg = SvgRenderer._applyAutoFitSizing(
              base.preAutoFitSvg,
              base.autoFitZoneInfo.idx, base.autoFitZoneInfo.boundingWidth,
              base.autoFitZoneInfo.fontSize, base.autoFitZoneInfo.originalScaleX,
              frameMode === 'none' ? 'single' : frameMode,
              base.autoFitMeasurements, base.fillType, base.cornerType,
              base.borderType
            );
          } catch (err) { variantSvg = base.svgString; }
        }

        for (var j = 0; j < colorsToApply.length; j++) {
          var color = colorsToApply[j];
          var colorized = SvgRenderer.colorize(variantSvg, color);
          colorized = SvgRenderer.applyThinStroke(colorized);
          colorized = SvgRenderer.cropViewBoxToStamp(colorized);
          colorized = SvgRenderer.applyCornerRadius(colorized, base.cornerType);
          var cropped = await SvgRenderer.cropViewBoxFixedFrame(colorized);

          var framed = cropped;
          if (frameMode === 'double') {
            framed = SvgRenderer.addDoubleFrame(cropped, bi, color, 'double');
          } else if (frameMode === 'split') {
            framed = SvgRenderer.addSplitBorder(cropped, bi);
          }

          for (var k = 0; k < tiltsToApply.length; k++) {
            var tilt = tiltsToApply[k];
            for (var t = 0; t < texturesToApply.length; t++) {
              var textureId = texturesToApply[t];
              try {
                // Texture + watermark before tilt so they're sized to stamp viewBox
                var textured = textureId ? await SvgRenderer.applyTexture(framed, textureId) : framed;
                if (!textured || textured.indexOf('<svg') === -1) {
                  textured = framed;
                }
                textured = SvgRenderer.addWatermark(textured);
                if (tilt !== 0) textured = SvgRenderer.applyTilt(textured, tilt);
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
                  fontKey: base.fontKey,
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
                  fontKey: base.fontKey,
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
      var productUrl = '/product.html?id=' + encodeURIComponent(r.templateId) +
        '&text=' + encodeURIComponent(self.currentText) +
        '&color=' + encodeURIComponent((r.appliedColor || '').replace('#', '')) +
        '&frame=' + encodeURIComponent(r.appliedFrame || r.frameType || 'single') +
        '&tilt=' + encodeURIComponent(r.appliedTilt || 0) +
        (r.appliedTexture ? '&texture=' + encodeURIComponent(r.appliedTexture) : '') +
        '&font=' + encodeURIComponent(r.fontKey || '');

      var previewLink = document.createElement('a');
      previewLink.className = 'stamp-card-preview';
      previewLink.href = productUrl;
      var img = SvgRenderer.createSvgImage(r.svgString);
      previewLink.appendChild(img);

      var colorName = self.getColorName(r.appliedColor);
      var description = self.buildDescription(
        r.displayText || self.currentText, colorName,
        r.borderType, r.fillType, r.cornerType,
        r.objectType, r.appliedTilt, r.appliedTexture,
        r.appliedFrame, r.svgString, r.fontKey
      );

      var actionsDiv = document.createElement('a');
      actionsDiv.className = 'stamp-card-actions';
      actionsDiv.href = productUrl;
      actionsDiv.innerHTML = '<span class="stamp-card-name">' + description + '</span>';

      card.appendChild(previewLink);
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
    if (!this.isShowcase) {
      var timeLabel = isRestore ? 'Restored at' : 'Generated at';
      headerTitle.innerHTML = '<span class="stamp-results-timestamp">' + timeLabel + ' ' + this.formatTime() + '</span>';
      headerSection.appendChild(headerTitle);
    }
    container.appendChild(headerSection);

    // Move filter bar into position right after the header
    var filterBar = document.getElementById('stamp-filter-bar');
    if (filterBar) {
      container.insertBefore(filterBar, headerSection.nextSibling);
    }
    // Live model count under filter bar
    var countEl = document.getElementById('gallery-count');
    if (!countEl) {
      countEl = document.createElement('div');
      countEl.id = 'gallery-count';
      countEl.className = 'gallery-count';
    }
    countEl.innerHTML = 'Available models = ' + totalCount + ' <span style="color:#999;font-weight:400;">\u2014 Click on the model you like and play with color, border count, font, tilt and texture.</span>';
    var insertAfter = filterBar || headerSection;
    container.insertBefore(countEl, insertAfter.nextSibling);

    // Render each group: R (Rectangle) then L (Lined)
    var familyIds = Object.keys(familyGroups).sort(function(a, b) {
      return a === 'R' ? -1 : 1;
    });
    for (var i = 0; i < familyIds.length; i++) {
      var group = familyGroups[familyIds[i]];

      var section = document.createElement('div');
      section.className = 'stamp-batch-section';
      section.dataset.family = group.numericFamily || 1;
      section.dataset.shapeGroup = familyIds[i] === 'L' ? 'lined' : 'rectangle';

      // Group headers removed — live count under filter bar is sufficient

      // Grid
      var grid = document.createElement('div');
      grid.className = 'stamp-results-grid';

      group.results.forEach(function(r) {
        var card = document.createElement('div');
        card.className = 'stamp-card';
        card.dataset.family = (self.BORDER_STYLE_FAMILIES[r.borderType || 'simple'] || { family: 1 }).family;
        card.dataset.borderType = r.borderType || 'simple';
        card.dataset.frame = r.appliedFrame || 'single';
        card.dataset.corners = r.cornerType || 'straight';
        card.dataset.fill = r.fillType || 'full';
        card.dataset.shape = r.appliedShape || 'rectangle';

        var productUrl = '/product.html?id=' + encodeURIComponent(r.templateId) +
          '&text=' + encodeURIComponent(self.currentText) +
          '&color=' + encodeURIComponent((r.appliedColor || '').replace('#', '')) +
          '&frame=' + encodeURIComponent(r.appliedFrame || r.frameType || 'single') +
          '&fill=empty' +
          '&shape=' + encodeURIComponent(r.appliedShape || 'rectangle') +
          '&tilt=' + encodeURIComponent(r.appliedTilt || 0) +
          (r.appliedTexture ? '&texture=' + encodeURIComponent(r.appliedTexture) : '') +
          '&font=' + encodeURIComponent(r.fontKey || '');

        var previewLink = document.createElement('a');
        previewLink.className = 'stamp-card-preview';
        previewLink.href = productUrl;
        var img = SvgRenderer.createSvgImage(r.svgString);
        previewLink.appendChild(img);

        var actionsDiv = document.createElement('a');
        actionsDiv.className = 'stamp-card-actions';
        actionsDiv.href = productUrl;
        actionsDiv.innerHTML = '<span class="stamp-card-cta">Download options</span>';

        card.appendChild(previewLink);
        card.appendChild(actionsDiv);
        grid.appendChild(card);
      });

      section.appendChild(grid);
      container.appendChild(section);
    }

    // Save variant params to localStorage (skip for showcase)
    if (!this.isShowcase) {
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
            s: r.appliedShape || 'rectangle',
            i: r.appliedTilt || 0,
            x: r.appliedTexture || ''
          };
        });
        localStorage.setItem('stx-gallery-params', JSON.stringify(variantParams));
      } catch (e) {
        console.warn('[Gallery] localStorage save failed:', e.message);
      }
      // Cache to IndexedDB for instant back-navigation
      this.saveToCache(this.currentText).catch(function() {});
    }
  },

  /**
   * Remove action buttons from all batch sections, then add to the last one.
   * @param {string} mode - 'initial' (Show more only) or 'filtered' (Show more + Change preferences)
   */
  updateBatchButtons(mode) {
    // Batch buttons removed — filters above the gallery handle navigation
    document.querySelectorAll('.stamp-batch-actions').forEach(function (el) {
      el.parentNode.removeChild(el);
    });
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
      // Set color dot to match current gallery color
      var dot = document.getElementById('filter-color-dot');
      var activeColor = this.selectedColor || '#dc2626';
      if (dot) dot.style.background = activeColor;
      // Default filters for a cleaner initial gallery
      var shapeSelect = document.getElementById('filter-shape');
      if (shapeSelect) shapeSelect.value = '';  // All shapes
      var frameSelect = document.getElementById('filter-border-count');
      if (frameSelect && !frameSelect.value) frameSelect.value = 'single';
      var fillSelect = document.getElementById('filter-fill');
      if (fillSelect) fillSelect.value = 'empty';
      this.applyFilterBar();
    }
  },

  /**
   * Initialize filter bar event listeners (called once per stamp).
   */
  initFilterBar() {
    var self = this;
    // Font custom dropdown: re-process all templates with new font
    var fontTrigger = document.getElementById('filter-font-trigger');
    var fontList = document.getElementById('filter-font-list');
    var fontLabel = document.getElementById('filter-font-label');
    if (fontTrigger && !fontTrigger.dataset.bound) {
      fontTrigger.dataset.bound = '1';
      fontTrigger.addEventListener('click', function(e) {
        e.stopPropagation();
        var colorGrid = document.getElementById('filter-bar-colors');
        if (colorGrid) colorGrid.classList.remove('open');
        fontList.classList.toggle('open');
      });
      fontList.addEventListener('click', async function(e) {
        e.stopPropagation();
        var item = e.target.closest('.filter-bar-font-item');
        if (!item) return;
        var fontKey = item.dataset.font;
        if (fontKey === self.selectedFont) {
          fontList.classList.remove('open');
          return;
        }
        fontList.querySelectorAll('.filter-bar-font-item').forEach(function(f) { f.classList.remove('active'); });
        item.classList.add('active');
        fontList.insertBefore(item, fontList.firstChild);
        fontLabel.textContent = item.textContent;
        fontLabel.style.fontFamily = item.style.fontFamily;
        self.selectedFont = fontKey;
        fontList.classList.remove('open');
        var countEl = document.getElementById('gallery-count');
        var modelCount = countEl ? (countEl.textContent.match(/\d+/) || [30])[0] : 30;
        var pill = document.createElement('div');
        pill.className = 'stamp-font-loading';
        pill.textContent = 'Loading ' + item.textContent + ' for ' + modelCount + ' models...';
        document.body.appendChild(pill);
        await self.processAll(self.currentText || 'Your text here');
        await self.showInitialRandom();
        if (pill.parentNode) pill.parentNode.removeChild(pill);
      });
    }
    var selects = ['filter-shape', 'filter-border-style', 'filter-border-count'];
    selects.forEach(function(id) {
      var el = document.getElementById(id);
      if (el && !el.dataset.bound) {
        el.dataset.bound = '1';
        el.addEventListener('change', function() { self.applyFilterBar(); });
      }
    });
    // Fill dropdown: convert SVGs on the fly with loading pill
    var fillSelect = document.getElementById('filter-fill');
    if (fillSelect && !fillSelect.dataset.bound) {
      fillSelect.dataset.bound = '1';
      fillSelect.addEventListener('change', function() {
        var targetFill = fillSelect.value || 'empty';
        var fillLabel2 = targetFill === 'full' ? 'Filled' : 'Outlined';
        var countEl2 = document.getElementById('gallery-count');
        var modelCount = countEl2 ? (countEl2.textContent.match(/\d+/) || [30])[0] : 30;
        var pill = document.createElement('div');
        pill.className = 'stamp-font-loading';
        pill.textContent = 'Switching to ' + fillLabel2 + ' for ' + modelCount + ' models...';
        document.body.appendChild(pill);
        setTimeout(function() {
          self.convertFillCards(targetFill);
          if (pill.parentNode) pill.parentNode.removeChild(pill);
        }, 50);
      });
    }
    var resetBtn = document.getElementById('filter-reset');
    if (resetBtn && !resetBtn.dataset.bound) {
      resetBtn.dataset.bound = '1';
      resetBtn.addEventListener('click', function() {
        selects.forEach(function(id) {
          var el = document.getElementById(id);
          if (el) el.value = '';
        });
        // Reset font to Oswald
        if (fontLabel) {
          fontLabel.textContent = 'Oswald';
          fontLabel.style.fontFamily = "'Oswald', sans-serif";
        }
        if (fontList) {
          fontList.querySelectorAll('.filter-bar-font-item').forEach(function(f) { f.classList.remove('active'); });
          var oswaldItem = fontList.querySelector('[data-font="Oswald"]');
          if (oswaldItem) {
            oswaldItem.classList.add('active');
            fontList.insertBefore(oswaldItem, fontList.firstChild);
          }
        }
        if (self.selectedFont !== 'Oswald') {
          self.selectedFont = 'Oswald';
          self.processAll(self.currentText || 'Your text here').then(function() {
            self.showInitialRandom();
          });
        }
        // Reset color selection
        self.selectedColor = null;
        document.querySelectorAll('.filter-bar-swatch').forEach(function(s) { s.classList.remove('active'); });
        var dot = document.getElementById('filter-color-dot');
        if (dot) dot.style.background = 'transparent';
        self.recolorizeCards(null);
        // Reset fill to outlined
        if (fillSelect) fillSelect.value = 'empty';
        self.convertFillCards('empty');
        self.applyFilterBar();
      });
    }

    // Build color swatches (first 4 visible in row, rest in dropdown)
    var colorGrid = document.getElementById('filter-bar-colors');
    if (colorGrid && !colorGrid.dataset.bound) {
      colorGrid.dataset.bound = '1';
      var colorDot = document.getElementById('filter-color-dot');

      // Build all 12 swatches into the single grid
      for (var ci = 0; ci < this.PALETTE_COLORS.length; ci++) {
        (function(hex) {
          var swatch = document.createElement('div');
          swatch.className = 'filter-bar-swatch';
          swatch.style.backgroundColor = hex;
          swatch.dataset.color = hex;
          swatch.addEventListener('click', function(e) {
            e.stopPropagation();
            // Toggle: clicking active swatch deselects
            if (swatch.classList.contains('active')) {
              document.querySelectorAll('.filter-bar-swatch').forEach(function(s) { s.classList.remove('active'); });
              self.selectedColor = null;
              if (colorDot) colorDot.style.background = 'transparent';
              self.recolorizeCards(null);
            } else {
              document.querySelectorAll('.filter-bar-swatch').forEach(function(s) { s.classList.remove('active'); });
              swatch.classList.add('active');
              self.selectedColor = hex;
              if (colorDot) colorDot.style.background = hex;
              self.recolorizeCards(hex);
            }
          });
          colorGrid.appendChild(swatch);
        })(self.PALETTE_COLORS[ci]);
      }

      // Toggle grid on box click
      var toggle = document.getElementById('filter-color-toggle');
      if (toggle) {
        toggle.addEventListener('click', function(e) {
          e.stopPropagation();
          colorGrid.classList.toggle('open');
        });
      }

    }

    // Close all gallery dropdowns on outside click — swallow click if any was open
    if (!this._outsideClickBound) {
      this._outsideClickBound = true;
      document.addEventListener('click', function(e) {
        // Don't swallow clicks inside dropdown elements
        if (e.target.closest('.filter-bar-color-group, .filter-bar-font-group, .filter-bar-swatch, .filter-bar-font-item')) return;
        var colorGrid2 = document.getElementById('filter-bar-colors');
        var fontList2 = document.getElementById('filter-font-list');
        var anyOpen = (colorGrid2 && colorGrid2.classList.contains('open')) ||
                      (fontList2 && fontList2.classList.contains('open'));
        if (anyOpen) {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (colorGrid2) colorGrid2.classList.remove('open');
          if (fontList2) fontList2.classList.remove('open');
        }
      }, true);
    }
  },

  /**
   * Re-colorize all visible gallery cards with a new color.
   * Pass null to restore original variant colors.
   */
  recolorizeCards(newColor) {
    var cards = document.querySelectorAll('#results-batches .stamp-card');
    var self = this;
    cards.forEach(function(card, idx) {
      var preview = card.querySelector('.stamp-card-preview');
      if (!preview) return;
      var oldWrapper = preview.querySelector('div');
      if (!oldWrapper) return;
      if (newColor) {
        var svgEl = oldWrapper.querySelector('svg');
        if (!svgEl) return;
        var recolored = SvgRenderer.colorize(svgEl.outerHTML, newColor);
        var newWrapper = SvgRenderer.createSvgImage(recolored);
        preview.replaceChild(newWrapper, oldWrapper);
      } else {
        var result = self.allResults[idx];
        if (result) {
          var newWrapper = SvgRenderer.createSvgImage(result.svgString);
          preview.replaceChild(newWrapper, oldWrapper);
        }
      }
      // Update product URLs
      var links = card.querySelectorAll('a[href*="product.html"]');
      links.forEach(function(a) {
        if (newColor) {
          a.href = a.href.replace(/color=[^&]*/, 'color=' + newColor.replace('#', ''));
        } else if (self.allResults[idx]) {
          a.href = a.href.replace(/color=[^&]*/, 'color=' + (self.allResults[idx].appliedColor || '').replace('#', ''));
        }
      });
    });
  },

  /**
   * Convert SVG fill between outlined and filled.
   */
  convertFill(svgString, targetFill) {
    var outerRectPattern = /data-wavy|data-border|data-stitch|data-filter|data-brush-border|stroke-width|\bstroke="/;
    if (targetFill === 'full') {
      var textM = svgString.match(/<text[^>]*\bfill=["']#([0-9A-Fa-f]{3,6})["']/);
      var fillColor = textM ? '#' + textM[1] : '#BE1E2D';
      // Fill outer rect: change fill="none" → fill=color on rects with border attrs
      svgString = svgString.replace(/<rect([^>]*)>/gi, function(match, attrs) {
        if (!outerRectPattern.test(attrs)) return match;
        if (!/fill=["']none["']/i.test(attrs)) return match;
        return '<rect' + attrs.replace(/fill=["']none["']/i, 'fill="' + fillColor + '"') + '>';
      });
      // Mixed corners: path with data-mixed-type
      svgString = svgString.replace(/<path([^>]*)>/gi, function(match, attrs) {
        if (!/data-mixed-type/i.test(attrs)) return match;
        if (!/fill=["']none["']/i.test(attrs)) return match;
        return '<path' + attrs.replace(/fill=["']none["']/i, 'fill="' + fillColor + '"') + '>';
      });
      // Inner frame elements: colored stroke → white for contrast on filled background
      svgString = svgString.replace(/<rect([^>]*)>/gi, function(match, attrs) {
        if (!/fill=["']none["']/i.test(attrs)) return match;
        if (!/\bstroke=["']#[0-9A-Fa-f]{3,6}["']/i.test(attrs)) return match;
        return '<rect' + attrs.replace(/(\bstroke=["'])#[0-9A-Fa-f]{3,6}(["'])/i, '$1#FFFFFF$2') + '>';
      });
      svgString = svgString.replace(/<path([^>]*)>/gi, function(match, attrs) {
        if (!/fill=["']none["']/i.test(attrs)) return match;
        if (!/\bstroke=["']#[0-9A-Fa-f]{3,6}["']/i.test(attrs)) return match;
        if (/data-mixed-type/i.test(attrs)) return match;
        return '<path' + attrs.replace(/(\bstroke=["'])#[0-9A-Fa-f]{3,6}(["'])/i, '$1#FFFFFF$2') + '>';
      });
      // Text → white
      svgString = svgString.replace(/(<text[^>]*)(fill=["'])#[0-9A-Fa-f]{3,6}(["'])/, '$1$2#FFFFFF$3');
      // Note: brush stamps are hidden when filled (handled in convertFillCards)
    } else if (targetFill === 'empty') {
      // Find stamp color from outer rect
      var rectColor = null;
      svgString.replace(/<rect([^>]*)>/gi, function(match, attrs) {
        if (rectColor) return match;
        if (!outerRectPattern.test(attrs)) return match;
        var fm = attrs.match(/fill=["']#([0-9A-Fa-f]{6})["']/i);
        if (fm && fm[1].toLowerCase() !== 'ffffff') rectColor = '#' + fm[1];
        return match;
      });
      if (!rectColor) {
        svgString.replace(/<path([^>]*)>/gi, function(match, attrs) {
          if (rectColor) return match;
          if (!/data-mixed-type/i.test(attrs)) return match;
          var fm = attrs.match(/fill=["']#([0-9A-Fa-f]{6})["']/i);
          if (fm && fm[1].toLowerCase() !== 'ffffff') rectColor = '#' + fm[1];
          return match;
        });
      }
      if (rectColor) {
        // Outer rect fill → none
        svgString = svgString.replace(/<rect([^>]*)>/gi, function(match, attrs) {
          if (!outerRectPattern.test(attrs)) return match;
          if (/fill=["']none["']/i.test(attrs)) return match;
          var fm = attrs.match(/fill=["']#([0-9A-Fa-f]{6})["']/i);
          if (!fm || fm[1].toLowerCase() === 'ffffff') return match;
          return '<rect' + attrs.replace(/fill=["']#[0-9A-Fa-f]{6}["']/i, 'fill="none"') + '>';
        });
        // Mixed corner path fill → none
        svgString = svgString.replace(/<path([^>]*)>/gi, function(match, attrs) {
          if (!/data-mixed-type/i.test(attrs)) return match;
          if (/fill=["']none["']/i.test(attrs)) return match;
          return '<path' + attrs.replace(/fill=["']#[0-9A-Fa-f]{6}["']/i, 'fill="none"') + '>';
        });
        // Inner frame: white stroke → stamp color
        svgString = svgString.replace(/<rect([^>]*)>/gi, function(match, attrs) {
          if (!/fill=["']none["']/i.test(attrs)) return match;
          if (!/\bstroke=["']#(?:FFF(?:FFF)?|FFFFFF)["']/i.test(attrs)) return match;
          return '<rect' + attrs.replace(/(\bstroke=["'])#(?:FFF(?:FFF)?|FFFFFF)(["'])/i, '$1' + rectColor + '$2') + '>';
        });
        svgString = svgString.replace(/<path([^>]*)>/gi, function(match, attrs) {
          if (!/fill=["']none["']/i.test(attrs)) return match;
          if (!/\bstroke=["']#(?:FFF(?:FFF)?|FFFFFF)["']/i.test(attrs)) return match;
          if (/data-mixed-type/i.test(attrs)) return match;
          return '<path' + attrs.replace(/(\bstroke=["'])#(?:FFF(?:FFF)?|FFFFFF)(["'])/i, '$1' + rectColor + '$2') + '>';
        });
        // Text white → stamp color
        svgString = svgString.replace(/(<text[^>]*)(fill=["'])#[Ff]{6}(["'])/, '$1$2' + rectColor + '$3');
        svgString = svgString.replace(/(<text[^>]*)(fill=["'])#[Ff]{3}(["'])/, '$1$2' + rectColor + '$3');
        // Note: brush stamps are hidden when filled (handled in convertFillCards)
      }
    }
    return svgString;
  },

  /**
   * Convert fill on all visible gallery cards (outlined ↔ filled).
   */
  convertFillCards(targetFill) {
    if (targetFill === this.currentFill) return;
    this.currentFill = targetFill;
    var cards = document.querySelectorAll('#results-batches .stamp-card');
    var self = this;
    // Disable/enable "Lined" in Shape dropdown (lined has no enclosed area for fill)
    var shapeSelect = document.getElementById('filter-shape');
    if (shapeSelect) {
      var linedOpt = shapeSelect.querySelector('option[value="lined"]');
      if (linedOpt) linedOpt.disabled = (targetFill === 'full');
      // If currently showing lined, reset to All
      if (targetFill === 'full' && shapeSelect.value === 'lined') shapeSelect.value = '';
    }
    cards.forEach(function(card) {
      // Skip lined stamps entirely — not compatible with filled
      if (card.dataset.shape === 'lined') {
        card.style.display = (targetFill === 'full') ? 'none' : '';
        return;
      }
      var preview = card.querySelector('.stamp-card-preview');
      if (!preview) return;
      var oldWrapper = preview.querySelector('div');
      if (!oldWrapper) return;
      // Hide brush border stamps when filled (too complex for client-side conversion)
      if (card.dataset.borderType === 'brushstroke') {
        card.style.display = (targetFill === 'full') ? 'none' : '';
        return;
      }
      var svgEl = oldWrapper.querySelector('svg');
      if (!svgEl) return;
      var converted = self.convertFill(svgEl.outerHTML, targetFill);
      var newWrapper = SvgRenderer.createSvgImage(converted);
      preview.replaceChild(newWrapper, oldWrapper);
      // Update product URLs
      var links = card.querySelectorAll('a[href*="product.html"]');
      links.forEach(function(a) {
        a.href = a.href.replace(/fill=[^&]*/, 'fill=' + targetFill);
      });
    });
    // Re-apply filters to update counts and cascading state
    this.applyFilterBar();
  },

  /**
   * Apply filter bar dropdowns to show/hide cards and family sections.
   */
  applyFilterBar() {
    var shapeVal = document.getElementById('filter-shape') ? document.getElementById('filter-shape').value : '';
    var familyVal = document.getElementById('filter-border-style').value;
    var frameVal = document.getElementById('filter-border-count').value;
    var isFilled = this.currentFill === 'full';
    var cards = document.querySelectorAll('#results-batches .stamp-card');
    var visibleCount = 0;
    cards.forEach(function(card) {
      var show = true;
      // Lined and brush stamps not compatible with filled mode
      if (isFilled && card.dataset.shape === 'lined') show = false;
      if (isFilled && card.dataset.borderType === 'brushstroke') show = false;
      if (shapeVal && card.dataset.shape !== shapeVal) show = false;
      if (familyVal && card.dataset.family !== familyVal) show = false;
      if (frameVal && card.dataset.frame !== frameVal) show = false;
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

    // Update live count under filter bar
    var countEl = document.getElementById('gallery-count');
    if (countEl) countEl.innerHTML = 'Available models = ' + visibleCount + ' <span style="color:#999;font-weight:400;">\u2014 Click on the model you like and play with color, border count, font, tilt and texture.</span>';

    // Cascading filters: disable options that would produce 0 results
    var allCards = Array.from(document.querySelectorAll('#results-batches .stamp-card'));
    var filterIds = ['filter-shape', 'filter-border-style', 'filter-border-count'];
    var dataKeys = ['shape', 'family', 'frame'];

    for (var fi = 0; fi < filterIds.length; fi++) {
      var sel = document.getElementById(filterIds[fi]);
      if (!sel) continue;
      var key = dataKeys[fi];
      // Find values that would have results if ONLY this filter were cleared
      var available = {};
      allCards.forEach(function(c) {
        var ok = true;
        for (var oi = 0; oi < filterIds.length; oi++) {
          if (oi === fi) continue; // skip current filter dimension
          var ov = document.getElementById(filterIds[oi]).value;
          if (!ov) continue;
          var dk = dataKeys[oi];
          if (c.dataset[dk] !== ov) { ok = false; break; }
        }
        if (ok) {
          var val = c.dataset[key] || '';
          available[val] = true;
        }
      });
      // Enable/disable options
      Array.from(sel.options).forEach(function(opt) {
        if (!opt.value) return; // "All" option always enabled
        opt.disabled = !available[opt.value];
      });
    }
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
    overlay.innerHTML = svgString;

    var svgEl = overlay.querySelector('svg');
    if (svgEl) {
      svgEl.removeAttribute('width');
      svgEl.removeAttribute('height');
      svgEl.style.maxWidth = '90vw';
      svgEl.style.maxHeight = '85vh';
      svgEl.style.width = 'auto';
      svgEl.style.height = 'auto';
      svgEl.style.background = '#ffffff';
      svgEl.style.borderRadius = '4px';
    }

    document.body.appendChild(overlay);

    // Close on click anywhere
    overlay.addEventListener('click', function () {
      overlay.remove();
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
        var rbi = SvgRenderer.detectBorderType(base.svgString);
        SvgRenderer.supplementBorderInfo(rbi, { border_type: base.borderType, fill_type: base.fillType });

        // Per-variant font sizing: re-apply autoFit with frame-specific interior via computeTextZone
        var variantSvg = base.svgString;
        var vpShape = vp.s || 'rectangle';
        var hasRoundedCorners = base.cornerType && base.cornerType !== 'straight';
        if (base.autoFitZoneInfo && base.autoFitMeasurements && (vp.f !== 'single' || hasRoundedCorners || vpShape === 'lined')) {
          try {
            variantSvg = SvgRenderer._applyAutoFitSizing(
              base.preAutoFitSvg,
              base.autoFitZoneInfo.idx,
              base.autoFitZoneInfo.boundingWidth,
              base.autoFitZoneInfo.fontSize,
              base.autoFitZoneInfo.originalScaleX,
              vp.f,
              base.autoFitMeasurements,
              base.fillType,
              base.cornerType,
              base.borderType,
              null,
              vpShape
            );
          } catch (err2) {
            console.warn('Per-variant sizing failed (restore):', base.name, vp.f, err2);
          }
        }

        var colorized = SvgRenderer.colorize(variantSvg, vp.c);
        colorized = SvgRenderer.applyThinStroke(colorized);
        colorized = SvgRenderer.cropViewBoxToStamp(colorized);
        // Lined: convert rect to 2 horizontal lines, skip corner radius
        if (vpShape === 'lined') {
          colorized = SvgRenderer.convertToLined(colorized);
        } else {
          colorized = SvgRenderer.applyCornerRadius(colorized, base.cornerType);
        }
        var cropped = await SvgRenderer.cropViewBoxFixedFrame(colorized);
        var framed = cropped;
        if (vp.f === 'double') {
          framed = SvgRenderer.addDoubleFrame(cropped, rbi, vp.c, 'double');
        } else if (vp.f === 'split') {
          framed = SvgRenderer.addSplitBorder(cropped, rbi);
        }
        var textured = vp.x ? await SvgRenderer.applyTexture(framed, vp.x) : framed;
        if (!textured || textured.indexOf('<svg') === -1) textured = framed;
        textured = SvgRenderer.addWatermark(textured);
        var tilted = vp.i !== 0 ? SvgRenderer.applyTilt(textured, vp.i) : textured;

        batch.push({
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
          fontKey: base.fontKey,
          appliedColor: vp.c,
          appliedFrame: vp.f || base.frameType || 'single',
          appliedShape: vp.s || 'rectangle',
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
    // Preserve filter bar before clearing (it may have been moved inside container)
    var filterBar = document.getElementById('stamp-filter-bar');
    if (filterBar && filterBar.parentNode === container) {
      container.parentNode.appendChild(filterBar);
    }
    container.innerHTML = '';
    this.allResults = batch;
    this.displayedCount = 0;

    var familyGroups = {};
    var self = this;
    for (var i = 0; i < batch.length; i++) {
      var r = batch[i];
      var familyInfo = this.BORDER_STYLE_FAMILIES[r.borderType || 'simple'] || { family: 1, sub: 1 };
      var familyId = familyInfo.family;
      var groupKey = r.appliedShape === 'lined' ? 'L' : 'R';
      if (!familyGroups[groupKey]) {
        var shapeLabel = r.appliedShape === 'lined' ? 'Lined' : 'Rectangle';
        familyGroups[groupKey] = {
          name: shapeLabel + ' stamps',
          numericFamily: 1,
          results: []
        };
      }
      familyGroups[groupKey].results.push(r);
    }

    this.appendGroupedBatchSections(familyGroups, batch.length, true);
    this.updateBatchButtons('initial');
    this.showResultsUI();
  },

  // ---- IndexedDB gallery cache (for instant back-navigation) ----
  _dbName: 'stampatext-gallery',
  _dbStore: 'cache',
  _dbVersion: 1,

  _openDB() {
    var self = this;
    return new Promise(function(resolve, reject) {
      var req = indexedDB.open(self._dbName, self._dbVersion);
      req.onupgradeneeded = function(e) {
        e.target.result.createObjectStore(self._dbStore);
      };
      req.onsuccess = function() { resolve(req.result); };
      req.onerror = function() { reject(req.error); };
    });
  },

  async saveToCache(text) {
    var db = await this._openDB();
    var container = document.getElementById('results-batches');
    // Temporarily remove filter bar so it's not duplicated in cached HTML
    var filterBar = document.getElementById('stamp-filter-bar');
    var filterBarParent = filterBar ? filterBar.parentNode : null;
    var filterBarNext = filterBar ? filterBar.nextSibling : null;
    if (filterBar && filterBarParent === container) {
      container.removeChild(filterBar);
    }
    var html = container.innerHTML;
    // Put filter bar back
    if (filterBar && filterBarParent === container) {
      container.insertBefore(filterBar, filterBarNext);
    }
    var data = {
      text: text,
      allResults: this.allResults,
      displayedCount: this.displayedCount,
      selectedColor: this.selectedColor,
      currentFill: this.currentFill,
      html: html,
      timestamp: Date.now()
    };
    return new Promise(function(resolve, reject) {
      var tx = db.transaction('cache', 'readwrite');
      tx.objectStore('cache').put(data, 'gallery');
      tx.oncomplete = function() { db.close(); resolve(); };
      tx.onerror = function() { db.close(); reject(tx.error); };
    });
  },

  async loadFromCache(text) {
    try {
      var db = await this._openDB();
      return new Promise(function(resolve) {
        var tx = db.transaction('cache', 'readonly');
        var req = tx.objectStore('cache').get('gallery');
        req.onsuccess = function() {
          db.close();
          var data = req.result;
          if (!data || data.text !== text) return resolve(null);
          if (Date.now() - data.timestamp > 600000) return resolve(null);
          resolve(data);
        };
        req.onerror = function() { db.close(); resolve(null); };
      });
    } catch (e) { return null; }
  },

  async restoreFromCache(text) {
    var cached = await this.loadFromCache(text);
    if (!cached) return false;

    this.allResults = cached.allResults;
    this.displayedCount = cached.displayedCount;
    this.selectedColor = cached.selectedColor;
    this.currentFill = cached.currentFill;
    this.currentText = text;

    // Restore DOM instantly
    var container = document.getElementById('results-batches');
    container.innerHTML = cached.html;

    // Move the original filter bar into position (after the header section)
    document.getElementById('stamp-results').style.display = 'block';
    var filterBar = document.getElementById('stamp-filter-bar');
    if (filterBar) {
      var headerSection = container.querySelector('.stamp-batch-section');
      if (headerSection) {
        container.insertBefore(filterBar, headerSection.nextSibling);
      }
      filterBar.style.display = 'flex';
      this.initFilterBar();
      var dot = document.getElementById('filter-color-dot');
      if (dot) dot.style.background = this.selectedColor || '#dc2626';
      var fillSelect = document.getElementById('filter-fill');
      if (fillSelect) fillSelect.value = this.currentFill || 'empty';
    }

    return true;
  },

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
};
