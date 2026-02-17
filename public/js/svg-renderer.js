/**
 * SvgRenderer - Core SVG processing engine for StampaText
 * Handles: fetch, parse, detect text, replace text, auto-fit, serialize, export PNG
 *
 * Key design: SVG display always uses the cleaned STRING (not DOM-serialized),
 * because DOMParser+XMLSerializer can mangle embedded fonts (base64 in <style>).
 */
const SvgRenderer = {

  // Font data cache for embedding in exported SVGs (base64 @font-face rules)
  _fontDataCache: {},

  // Counter for unique SVG IDs (prevents cross-template <use> reference conflicts
  // when multiple inline SVGs share the same page)
  _svgIdCounter: 0,

  // Map of font names to local font files and their format
  _fontMap: {
    'Oswald':          { url: '/fonts/Oswald-Medium.ttf',         format: 'truetype' },
    'Montserrat':      { url: '/fonts/Montserrat-Black.ttf',      format: 'truetype' },
    'Nunito':          { url: '/fonts/Nunito-Black.ttf',           format: 'truetype' },
    'RobotoBlack':     { url: '/fonts/Roboto-Black.ttf',          format: 'truetype' },
    'PlayfairDisplay': { url: '/fonts/PlayfairDisplay-Bold.ttf',  format: 'truetype' },
    'Merriweather':    { url: '/fonts/Merriweather-Black.ttf',    format: 'truetype' },
    'Bitter':          { url: '/fonts/Bitter-Bold.ttf',            format: 'truetype' },
    'Exo2':            { url: '/fonts/Exo2-Black.ttf',            format: 'truetype' },
    'Comfortaa':       { url: '/fonts/Comfortaa-Bold.ttf',        format: 'truetype' },
    'Raleway':         { url: '/fonts/Raleway-Black.ttf',         format: 'truetype' }
  },

  /**
   * Fetch a font file and return it as a base64 @font-face CSS rule.
   * Results are cached to avoid re-fetching.
   * @param {string} fontName
   * @returns {Promise<string|null>} CSS @font-face rule or null
   */
  async _getFontRule(fontName) {
    if (this._fontDataCache[fontName]) return this._fontDataCache[fontName];
    var fontInfo = this._fontMap[fontName];
    if (!fontInfo) return null;
    try {
      var resp = await fetch(fontInfo.url);
      var buf = await resp.arrayBuffer();
      var bytes = new Uint8Array(buf);
      var binary = '';
      for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      var base64 = btoa(binary);
      var rule = '@font-face{font-family:"' + fontName + '";src:url(data:font/' +
        fontInfo.format + ';base64,' + base64 + ');}';
      this._fontDataCache[fontName] = rule;
      return rule;
    } catch (e) {
      console.warn('Failed to fetch font:', fontName, e);
      return null;
    }
  },

  /**
   * Embed @font-face rules (with base64 data) into an SVG string.
   * This makes the SVG self-contained for canvas rendering.
   * @param {string} svgString
   * @returns {Promise<string>}
   */
  async _embedFontsInSvg(svgString) {
    var rules = [];
    for (var fontName in this._fontMap) {
      if (svgString.indexOf(fontName) !== -1) {
        var rule = await this._getFontRule(fontName);
        if (rule) rules.push(rule);
      }
    }
    if (rules.length === 0) return svgString;
    var styleTag = '<defs><style>' + rules.join('') + '</style></defs>';
    return svgString.replace(/(<svg[^>]*>)/, '$1' + styleTag);
  },

  /**
   * Fetch SVG string from a URL (Supabase Storage public URL).
   * @param {string} svgUrl
   * @returns {Promise<string>}
   */
  async fetchSvg(svgUrl) {
    var bustUrl = svgUrl + (svgUrl.indexOf('?') === -1 ? '?' : '&') + '_cb=' + Date.now();
    const res = await fetch(bustUrl);
    if (!res.ok) throw new Error('Failed to fetch SVG: ' + res.status);
    return await res.text();
  },

  /**
   * Clean raw SVG string from Illustrator cruft.
   * Returns a clean SVG string that browsers can render (with fonts intact).
   * @param {string} svgString - raw SVG from file
   * @returns {string} - cleaned SVG string
   */
  cleanSvgString(svgString) {
    // Extract from <svg onwards
    var svgStart = svgString.indexOf('<svg');
    if (svgStart === -1) throw new Error('No <svg> tag found');
    var cleaned = svgString.substring(svgStart);

    // Remove foreignObject blocks (Illustrator metadata, can be huge)
    var foStart, foEnd;
    while ((foStart = cleaned.indexOf('<foreignObject')) !== -1) {
      foEnd = cleaned.indexOf('</foreignObject>', foStart);
      if (foEnd === -1) {
        cleaned = cleaned.substring(0, foStart);
        break;
      }
      cleaned = cleaned.substring(0, foStart) + cleaned.substring(foEnd + '</foreignObject>'.length);
    }

    // Remove namespace declarations for Adobe prefixes (but keep xmlns= and xmlns:xlink=)
    cleaned = cleaned.replace(/\s+xmlns:(x|i|graph|sfw|vars|imrep|custom|adobe_xpath)=["'][^"']*["']/gi, '');

    // Remove attributes with Adobe namespace prefixes (i:extraneous, x:anything, etc.)
    // But preserve xml:space, xlink:href, enable-background
    cleaned = cleaned.replace(/\s+(i|x|graph|sfw|vars|imrep|custom):[a-z][\w-]*=["'][^"']*["']/gi, '');

    // Remove elements with namespace prefixes (<i:pgfRef>, etc.)
    cleaned = cleaned.replace(/<(i|x|graph|sfw|vars|imrep|custom):[^>]*\/>/gi, '');
    cleaned = cleaned.replace(/<(i|x|graph|sfw|vars|imrep|custom):[^>]*>[\s\S]*?<\/(i|x|graph|sfw|vars|imrep|custom):[^>]+>/gi, '');

    // Remove remaining entity references (but not &amp; &lt; &gt; &quot; &apos;)
    cleaned = cleaned.replace(/&ns_\w+;/g, '');

    // Remove the entire <style> block (Illustrator embeds fonts in a format
    // browsers can't use). We load fonts externally via Google Fonts instead.
    cleaned = cleaned.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

    // Map Adobe Illustrator font-family names to Google Fonts equivalents.
    // Adobe uses 'Oswald-Medium', 'Oswald-Regular', etc. but Google Fonts
    // uses 'Oswald' with font-weight to select the variant.
    var fontMappings = [
      // Oswald variants (from Adobe/SVG exports)
      { from: "'Oswald-Medium'", to: "'Oswald'", weight: '500' },
      { from: "'Oswald-Regular'", to: "'Oswald'", weight: '400' },
      { from: "'Oswald-Bold'", to: "'Oswald'", weight: '700' },
      { from: "'Oswald-SemiBold'", to: "'Oswald'", weight: '600' },
      { from: "'Oswald-Light'", to: "'Oswald'", weight: '300' },
      { from: "'Oswald-ExtraLight'", to: "'Oswald'", weight: '200' },
      // Montserrat
      { from: "'Montserrat-Black'", to: "'Montserrat'", weight: '900' },
      { from: "'Montserrat'", to: "'Montserrat'", weight: '900' },
      // Nunito
      { from: "'Nunito-Black'", to: "'Nunito'", weight: '900' },
      { from: "'Nunito'", to: "'Nunito'", weight: '900' },
      // Roboto Black
      { from: "'Roboto-Black'", to: "'RobotoBlack'", weight: '900' },
      { from: "'RobotoBlack'", to: "'RobotoBlack'", weight: '900' },
      // Playfair Display
      { from: "'PlayfairDisplay-Bold'", to: "'PlayfairDisplay'", weight: '700' },
      { from: "'Playfair Display'", to: "'PlayfairDisplay'", weight: '700' },
      { from: "'PlayfairDisplay'", to: "'PlayfairDisplay'", weight: '700' },
      // Merriweather
      { from: "'Merriweather-Black'", to: "'Merriweather'", weight: '900' },
      { from: "'Merriweather'", to: "'Merriweather'", weight: '900' },
      // Bitter
      { from: "'Bitter-Bold'", to: "'Bitter'", weight: '700' },
      { from: "'Bitter'", to: "'Bitter'", weight: '700' },
      // Exo 2
      { from: "'Exo2-Black'", to: "'Exo2'", weight: '900' },
      { from: "'Exo 2'", to: "'Exo2'", weight: '900' },
      { from: "'Exo2'", to: "'Exo2'", weight: '900' },
      // Comfortaa
      { from: "'Comfortaa-Bold'", to: "'Comfortaa'", weight: '700' },
      { from: "'Comfortaa'", to: "'Comfortaa'", weight: '700' },
      // Raleway
      { from: "'Raleway-Black'", to: "'Raleway'", weight: '900' },
      { from: "'Raleway'", to: "'Raleway'", weight: '900' }
    ];
    fontMappings.forEach(function(m) {
      // Replace font-family attribute - only add font-weight if not already present
      var escapedFrom = m.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match font-family that's NOT immediately followed by existing font-weight
      var regex = new RegExp('font-family="' + escapedFrom + '"(?! font-weight)', 'g');
      cleaned = cleaned.replace(regex, 'font-family="' + m.to + '" font-weight="' + m.weight + '"');
      // Also handle case where font-weight already exists (just replace font-family)
      var regexWithWeight = new RegExp('font-family="' + escapedFrom + '"( font-weight="[^"]*")', 'g');
      cleaned = cleaned.replace(regexWithWeight, 'font-family="' + m.to + '"$1');
    });

    // Ensure xmlns is present
    if (cleaned.indexOf('xmlns="') === -1) {
      cleaned = cleaned.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    }

    return cleaned;
  },

  /**
   * Make all id="..." attributes unique by appending a counter suffix.
   * Prevents cross-SVG <use href="#id"> conflicts when multiple inline SVGs
   * share the same HTML page (e.g. gallery grid).
   * Updates id definitions, href/xlink:href references, and url(#...) references.
   */
  uniquifySvgIds(svgString) {
    var suffix = '_s' + (++this._svgIdCounter);

    // Collect all id="..." values
    var ids = [];
    var idRe = /\bid=["']([^"']+)["']/g;
    var m;
    while ((m = idRe.exec(svgString)) !== null) {
      if (ids.indexOf(m[1]) === -1) ids.push(m[1]);
    }
    if (ids.length === 0) return svgString;

    var result = svgString;
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var newId = id + suffix;
      // Replace id definitions
      result = result.replace(new RegExp('\\bid="' + escaped + '"', 'g'), 'id="' + newId + '"');
      // Replace href="#id" and xlink:href="#id" references
      result = result.replace(new RegExp('href="#' + escaped + '"', 'g'), 'href="#' + newId + '"');
      // Replace url(#id) references (filter, clip-path, mask)
      result = result.replace(new RegExp('url\\(#' + escaped + '\\)', 'g'), 'url(#' + newId + ')');
    }

    return result;
  },

  /**
   * Parse SVG string into a DOM Document (for text detection and manipulation).
   * @param {string} svgString - raw or cleaned SVG string
   * @returns {Document}
   */
  parseSvg(svgString) {
    var cleaned = this.cleanSvgString(svgString);

    // For DOMParser, we need to also strip CDATA sections in style (they cause issues)
    // But we keep the original cleaned string for display purposes
    var forParsing = cleaned;

    // Remove CDATA wrappers (keep content) for XML parser compatibility
    forParsing = forParsing.replace(/<!\[CDATA\[/g, '');
    forParsing = forParsing.replace(/\]\]>/g, '');

    // Remove the @font-face block entirely for parsing (we don't need it for DOM operations)
    // This avoids base64 data confusing the XML parser
    forParsing = forParsing.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

    const parser = new DOMParser();
    const doc = parser.parseFromString(forParsing, 'image/svg+xml');

    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      throw new Error('SVG parse error: ' + parseError.textContent.substring(0, 200));
    }
    return doc;
  },

  /**
   * Auto-detect container elements (ct-1, ct-2, etc.) in an SVG.
   * These are typically <g> groups or <rect> elements with id="ct-*".
   * @param {Document} svgDoc
   * @returns {Object} - Map of container number to {id, width, height, x, y}
   */
  detectContainers(svgDoc) {
    const containers = {};

    // Find all elements with id starting with "ct-" (case-insensitive)
    const allElements = svgDoc.querySelectorAll('[id]');
    allElements.forEach(el => {
      const id = el.getAttribute('id') || '';
      // Match ct-1, ct_1, ct-1_8_, etc. (Illustrator adds suffixes like _8_)
      const match = id.match(/^ct[_-]?(\d+)/i);
      if (!match) return;

      const num = match[1];
      let width = 0, height = 0, x = 0, y = 0;

      // If it's a rect, get dimensions directly
      if (el.tagName.toLowerCase() === 'rect') {
        width = parseFloat(el.getAttribute('width')) || 0;
        height = parseFloat(el.getAttribute('height')) || 0;
        x = parseFloat(el.getAttribute('x')) || 0;
        y = parseFloat(el.getAttribute('y')) || 0;
      } else if (el.tagName.toLowerCase() === 'g') {
        // If it's a group, look for a rect inside
        const rect = el.querySelector('rect');
        if (rect) {
          width = parseFloat(rect.getAttribute('width')) || 0;
          height = parseFloat(rect.getAttribute('height')) || 0;
          x = parseFloat(rect.getAttribute('x')) || 0;
          y = parseFloat(rect.getAttribute('y')) || 0;
        }
      }

      // Apply group transform if present (extract translate)
      const transform = el.getAttribute('transform') || '';
      const translateMatch = transform.match(/translate\(\s*([\d.\-]+)[\s,]+([\d.\-]+)\s*\)/);
      if (translateMatch) {
        x += parseFloat(translateMatch[1]) || 0;
        y += parseFloat(translateMatch[2]) || 0;
      }

      containers[num] = { id, width, height, x, y };
    });

    return containers;
  },

  /**
   * Auto-detect all <text> elements in an SVG Document.
   * Also identifies dt-* (dynamic text) layer names.
   * @param {Document} svgDoc
   * @returns {Array<Object>}
   */
  detectTextElements(svgDoc) {
    const textEls = svgDoc.querySelectorAll('text');
    const results = [];

    textEls.forEach((el, index) => {
      let parentId = null;
      let dtNumber = null;  // Dynamic text number (dt-1 → "1")
      let parent = el.parentElement;
      while (parent && parent.tagName !== 'svg') {
        if (parent.id) {
          parentId = parent.id;
          // Check if this is a dt-* layer (allow trailing suffixes like dt-1_7_)
          const dtMatch = parent.id.match(/^dt[_-]?(\d+)/i);
          if (dtMatch) {
            dtNumber = dtMatch[1];
          }
          break;
        }
        parent = parent.parentElement;
      }

      const transform = el.getAttribute('transform') || '';

      results.push({
        index: index,
        textContent: el.textContent,
        fontFamily: el.getAttribute('font-family') || '',
        fontSize: parseFloat(el.getAttribute('font-size')) || 0,
        fill: el.getAttribute('fill') || '',
        stroke: el.getAttribute('stroke') || '',
        strokeWidth: parseFloat(el.getAttribute('stroke-width')) || 0,
        strokeMiterlimit: el.getAttribute('stroke-miterlimit') || '',
        transform: transform,
        parentId: parentId,
        dtNumber: dtNumber,  // New: the number from dt-* layer name
        element: el
      });
    });

    return results;
  },

  /**
   * Detect dominant colors from an SVG string.
   * Scans fill= and stroke= attributes, ignores 'none', 'transparent',
   * and returns unique hex colors sorted by frequency.
   * @param {string} svgString - cleaned SVG string
   * @returns {Array<{color: string, count: number, roles: string[]}>}
   */
  detectColors(svgString) {
    var colorMap = {};
    var ignore = ['none', 'transparent', 'inherit', 'currentColor', ''];

    // Scan fill attributes
    var fillRegex = /fill=["']([^"']+)["']/gi;
    var match;
    while ((match = fillRegex.exec(svgString)) !== null) {
      var c = match[1].trim();
      if (ignore.indexOf(c.toLowerCase()) !== -1) continue;
      var hex = SvgRenderer._normalizeColor(c);
      if (!hex) continue;
      if (!colorMap[hex]) colorMap[hex] = { color: hex, count: 0, roles: [] };
      colorMap[hex].count++;
      if (colorMap[hex].roles.indexOf('fill') === -1) colorMap[hex].roles.push('fill');
    }

    // Scan stroke attributes
    var strokeRegex = /stroke=["']([^"']+)["']/gi;
    while ((match = strokeRegex.exec(svgString)) !== null) {
      var c2 = match[1].trim();
      if (ignore.indexOf(c2.toLowerCase()) !== -1) continue;
      var hex2 = SvgRenderer._normalizeColor(c2);
      if (!hex2) continue;
      if (!colorMap[hex2]) colorMap[hex2] = { color: hex2, count: 0, roles: [] };
      colorMap[hex2].count++;
      if (colorMap[hex2].roles.indexOf('stroke') === -1) colorMap[hex2].roles.push('stroke');
    }

    // Sort by frequency (most used first)
    var results = Object.values(colorMap);
    results.sort(function (a, b) { return b.count - a.count; });
    return results;
  },

  /**
   * Normalize a color value to uppercase hex (#RRGGBB).
   * Handles hex shorthand (#RGB) and named colors (basic set).
   * @private
   */
  _normalizeColor(color) {
    if (!color) return null;
    color = color.trim();

    // Already hex
    if (color.match(/^#[0-9a-fA-F]{6}$/)) return color.toUpperCase();
    if (color.match(/^#[0-9a-fA-F]{3}$/)) {
      // Expand shorthand #RGB → #RRGGBB
      var r = color[1], g = color[2], b = color[3];
      return ('#' + r + r + g + g + b + b).toUpperCase();
    }

    // Basic named colors
    var named = {
      'white': '#FFFFFF', 'black': '#000000', 'red': '#FF0000',
      'green': '#008000', 'blue': '#0000FF', 'yellow': '#FFFF00',
      'cyan': '#00FFFF', 'magenta': '#FF00FF', 'gray': '#808080',
      'grey': '#808080', 'orange': '#FFA500', 'purple': '#800080',
      'pink': '#FFC0CB', 'brown': '#A52A2A'
    };
    var lower = color.toLowerCase();
    if (named[lower]) return named[lower];

    // rgb() format
    var rgbMatch = color.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
    if (rgbMatch) {
      var rr = parseInt(rgbMatch[1]).toString(16).padStart(2, '0');
      var gg = parseInt(rgbMatch[2]).toString(16).padStart(2, '0');
      var bb = parseInt(rgbMatch[3]).toString(16).padStart(2, '0');
      return ('#' + rr + gg + bb).toUpperCase();
    }

    return null;
  },

  /**
   * Colorize an SVG by replacing its dominant color with a new one.
   * The dominant color is the most frequent non-white, non-black fill/stroke.
   * All occurrences of that color (in fill= and stroke= attributes) are replaced.
   * @param {string} svgString - cleaned SVG string
   * @param {string} newColor - hex color to apply (e.g. '#FF0000')
   * @returns {string} - colorized SVG string
   */
  colorize(svgString, newColor) {
    var detected = this.detectColors(svgString);
    if (detected.length === 0) return svgString;

    // Find the dominant color that isn't white or black
    var dominant = null;
    for (var i = 0; i < detected.length; i++) {
      var c = detected[i].color;
      if (c !== '#FFFFFF' && c !== '#000000') {
        dominant = c;
        break;
      }
    }
    if (!dominant) return svgString; // only black/white, nothing to colorize

    var isCategory2 = /<image[\s>]/i.test(svgString);

    if (isCategory2) {
      // Category 2: two-pronged approach for exact color match:
      // 1. Text: direct fill/stroke replacement (exact target color)
      // 2. Image: feFlood + feComposite filter (flat silhouette in exact target color)
      var result = svgString;

      // Replace fill/stroke on text elements (same as Category 1)
      var escapedDom = dominant.replace('#', '\\#');
      var fillRe2 = new RegExp('(fill=["\'])' + escapedDom + '(["\'])', 'gi');
      result = result.replace(fillRe2, '$1' + newColor + '$2');
      var strokeRe2 = new RegExp('(stroke=["\'])' + escapedDom + '(["\'])', 'gi');
      result = result.replace(strokeRe2, '$1' + newColor + '$2');

      // Add feFlood filter for the raster image — makes every non-transparent pixel
      // the exact target color (flat silhouette), guaranteeing text/artwork match
      var filterId = 'recolor-' + newColor.replace('#', '');
      var filterDef = '<defs><filter id="' + filterId + '" color-interpolation-filters="sRGB">' +
        '<feFlood flood-color="' + newColor + '" result="targetColor"/>' +
        '<feComposite in="targetColor" in2="SourceAlpha" operator="in"/>' +
        '</filter></defs>';

      // Insert filter def after <svg> tag
      result = result.replace(/(<svg[^>]*>)/i, '$1' + filterDef);

      // Apply filter to the <image> element
      result = result.replace(/(<image\b)([^>]*)(\/?>)/i, '$1$2 filter="url(#' + filterId + ')"$3');

      return result;
    }

    // Category 1: replace fill/stroke attributes directly (no raster image)
    var result = svgString;
    var escapedDominant = dominant.replace('#', '\\#');
    var fillRe = new RegExp('(fill=["\'])' + escapedDominant + '(["\'])', 'gi');
    result = result.replace(fillRe, '$1' + newColor + '$2');
    var strokeRe = new RegExp('(stroke=["\'])' + escapedDominant + '(["\'])', 'gi');
    result = result.replace(strokeRe, '$1' + newColor + '$2');

    // "Full" template detection: text color differs from dominant (text is white/black
    // while frame/background uses the dominant color). Adjust text contrast automatically.
    var textMatch = svgString.match(/<text[^>]*fill=["']([^"']+)["']/i);
    var origTextColor = textMatch ? textMatch[1].toUpperCase() : null;
    if (origTextColor && origTextColor !== dominant.toUpperCase() &&
        (origTextColor === '#FFFFFF' || origTextColor === '#000000')) {
      var contrastColor = this._getContrastTextColor(newColor);
      // Replace fill/stroke only inside <text> and <tspan> elements
      result = result.replace(/<text([^>]*)>/gi, function(match, attrs) {
        return '<text' + attrs.replace(/fill=["'][^"']*["']/i, 'fill="' + contrastColor + '"')
                              .replace(/stroke=["'][^"']*["']/i, 'stroke="' + contrastColor + '"') + '>';
      });
      result = result.replace(/<tspan([^>]*)>/gi, function(match, attrs) {
        if (attrs.match(/fill=/i)) {
          return '<tspan' + attrs.replace(/fill=["'][^"']*["']/i, 'fill="' + contrastColor + '"')
                                  .replace(/stroke=["'][^"']*["']/i, 'stroke="' + contrastColor + '"') + '>';
        }
        return match;
      });
      // Also update inner decorative rects (fill="none" with white/black stroke)
      result = result.replace(/<rect([^>]*fill=["']none["'][^>]*)>/gi, function(match, attrs) {
        if (/stroke=["']#(?:FFFFFF|000000)["']/i.test(attrs)) {
          return '<rect' + attrs.replace(/stroke=["']#(?:FFFFFF|000000)["']/i, 'stroke="' + contrastColor + '"') + '>';
        }
        return match;
      });
    }

    return result;
  },

  /**
   * Get the dominant color from an SVG (most frequent non-white, non-black).
   * @param {string} svgString
   * @returns {string|null} hex color or null
   */
  /**
   * Return white or black text color for best contrast against a background color.
   * Uses relative luminance: dark backgrounds → white text, light backgrounds → black text.
   */
  _getContrastTextColor(hexColor) {
    var hex = hexColor.replace('#', '');
    var r = parseInt(hex.substring(0, 2), 16);
    var g = parseInt(hex.substring(2, 4), 16);
    var b = parseInt(hex.substring(4, 6), 16);
    // Perceived brightness (ITU-R BT.601)
    var luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    return luminance > 160 ? '#000000' : '#FFFFFF';
  },

  /**
   * Generate white border shapes (circles or diamonds) along all 4 edges of a rect.
   * Used for "winding" (scalloped) and "zig-zag" (saw-tooth) border effects.
   */
  _generateBorderShapes: function(x, y, w, h, shapeType, radius, spacingMult) {
    var shapes = '';
    var spacing = radius * (spacingMult || 2.5);

    // Horizontal edges (top + bottom)
    var numH = Math.max(1, Math.round(w / spacing));
    var hSpacing = w / numH;
    for (var i = 0; i <= numH; i++) {
      var cx = x + i * hSpacing;
      shapes += this._borderShape(shapeType, cx, y, radius);
      shapes += this._borderShape(shapeType, cx, y + h, radius);
    }

    // Vertical edges (left + right), skip corners (already covered by horizontal)
    var numV = Math.max(1, Math.round(h / spacing));
    var vSpacing = h / numV;
    for (var i = 1; i < numV; i++) {
      var cy = y + i * vSpacing;
      shapes += this._borderShape(shapeType, x, cy, radius);
      shapes += this._borderShape(shapeType, x + w, cy, radius);
    }

    return shapes;
  },

  _borderShape: function(type, cx, cy, r) {
    if (type === 'circle') {
      return '<circle cx="' + cx.toFixed(2) + '" cy="' + cy.toFixed(2) + '" r="' + r + '" fill="#FFFFFF"/>';
    }
    // diamond: 4 points of a 45° rotated square
    var top = (cy - r).toFixed(2);
    var bot = (cy + r).toFixed(2);
    var lft = (cx - r).toFixed(2);
    var rgt = (cx + r).toFixed(2);
    return '<polygon points="' + cx.toFixed(2) + ',' + top + ' ' + rgt + ',' + cy.toFixed(2) + ' ' + cx.toFixed(2) + ',' + bot + ' ' + lft + ',' + cy.toFixed(2) + '" fill="#FFFFFF"/>';
  },

  /**
   * Generate a wavy border path as a single closed SVG <path>.
   * Uses odd arc counts for smooth corners (~5° tangent change vs ~100° with even).
   * @param {string} variant - "gentle" (d=7) or "strong" (d=12)
   * @param {boolean} filled - if true, path has fill (for full-frame templates)
   */
  _generateWavyBorder: function(x, y, w, h, color, strokeW, variant, filled) {
    var F = function(n) { return n.toFixed(2); };
    var scWidth = (variant === 'strong') ? 80 : 35;
    var depth = (variant === 'strong') ? 20 : 7;
    strokeW = 40;

    var numH = Math.max(3, Math.round(w / scWidth));
    if (numH % 2 === 0) numH++;   // force ODD for smooth corners
    var segW = w / numH;
    var numV = Math.max(3, Math.round(h / segW));
    if (numV % 2 === 0) numV++;   // force ODD
    var segH = h / numV;
    var vD = depth * segH / segW;

    var d = 'M ' + F(x) + ',' + F(y);
    // Top (L→R)
    for (var i = 0; i < numH; i++) { var fl = (i % 2 === 0) ? 1 : -1; var sx = x + i * segW;
      d += ' C '+F(sx+segW*0.3)+','+F(y-fl*depth)+' '+F(sx+segW*0.7)+','+F(y-fl*depth)+' '+F(sx+segW)+','+F(y); }
    // Right (T→B)
    for (var i = 0; i < numV; i++) { var fl = (i % 2 === 0) ? 1 : -1; var sy = y + i * segH;
      d += ' C '+F(x+w+fl*vD)+','+F(sy+segH*0.3)+' '+F(x+w+fl*vD)+','+F(sy+segH*0.7)+' '+F(x+w)+','+F(sy+segH); }
    // Bottom (R→L)
    for (var i = 0; i < numH; i++) { var fl = (i % 2 === 0) ? 1 : -1; var sx = x + w - i * segW;
      d += ' C '+F(sx-segW*0.3)+','+F(y+h+fl*depth)+' '+F(sx-segW*0.7)+','+F(y+h+fl*depth)+' '+F(sx-segW)+','+F(y+h); }
    // Left (B→T)
    for (var i = 0; i < numV; i++) { var fl = (i % 2 === 0) ? 1 : -1; var sy = y + h - i * segH;
      d += ' C '+F(x-fl*vD)+','+F(sy-segH*0.3)+' '+F(x-fl*vD)+','+F(sy-segH*0.7)+' '+F(x)+','+F(sy-segH); }
    d += ' Z';

    var fillAttr = filled ? color : 'none';
    return '<path d="' + d + '" fill="' + fillAttr + '" stroke="' + color + '" stroke-width="' + strokeW + '" stroke-linejoin="round"/>';
  },

  _generateStitchShapes: function(x, y, w, h, shapeType, size, spacing, color) {
    var shapes = '';
    var half = size / 2;
    var dashLen = (shapeType === 'line') ? size * 2 : size;
    var step = spacing + dashLen;

    function addShape(cx, cy, angle) {
      if (shapeType === 'circle') {
        shapes += '<circle cx="' + cx.toFixed(2) + '" cy="' + cy.toFixed(2) + '" r="' + half + '" fill="' + color + '"/>';
      } else if (shapeType === 'square') {
        shapes += '<rect x="' + (cx - half).toFixed(2) + '" y="' + (cy - half).toFixed(2) + '" width="' + size + '" height="' + size + '" fill="' + color + '"/>';
      } else { // line
        if (angle === 0) {
          shapes += '<rect x="' + (cx - dashLen / 2).toFixed(2) + '" y="' + (cy - half).toFixed(2) + '" width="' + dashLen + '" height="' + size + '" fill="' + color + '"/>';
        } else {
          shapes += '<rect x="' + (cx - half).toFixed(2) + '" y="' + (cy - dashLen / 2).toFixed(2) + '" width="' + size + '" height="' + dashLen + '" fill="' + color + '"/>';
        }
      }
    }

    // Corners
    if (shapeType === 'line') {
      var arm = dashLen * 0.6;
      // Top-left
      shapes += '<rect x="' + (x - half).toFixed(2) + '" y="' + (y - half).toFixed(2) + '" width="' + (arm + half).toFixed(2) + '" height="' + size + '" fill="' + color + '"/>';
      shapes += '<rect x="' + (x - half).toFixed(2) + '" y="' + (y - half).toFixed(2) + '" width="' + size + '" height="' + (arm + half).toFixed(2) + '" fill="' + color + '"/>';
      // Top-right
      shapes += '<rect x="' + (x + w - arm).toFixed(2) + '" y="' + (y - half).toFixed(2) + '" width="' + (arm + half).toFixed(2) + '" height="' + size + '" fill="' + color + '"/>';
      shapes += '<rect x="' + (x + w - half).toFixed(2) + '" y="' + (y - half).toFixed(2) + '" width="' + size + '" height="' + (arm + half).toFixed(2) + '" fill="' + color + '"/>';
      // Bottom-left
      shapes += '<rect x="' + (x - half).toFixed(2) + '" y="' + (y + h - half).toFixed(2) + '" width="' + (arm + half).toFixed(2) + '" height="' + size + '" fill="' + color + '"/>';
      shapes += '<rect x="' + (x - half).toFixed(2) + '" y="' + (y + h - arm).toFixed(2) + '" width="' + size + '" height="' + (arm + half).toFixed(2) + '" fill="' + color + '"/>';
      // Bottom-right
      shapes += '<rect x="' + (x + w - arm).toFixed(2) + '" y="' + (y + h - half).toFixed(2) + '" width="' + (arm + half).toFixed(2) + '" height="' + size + '" fill="' + color + '"/>';
      shapes += '<rect x="' + (x + w - half).toFixed(2) + '" y="' + (y + h - arm).toFixed(2) + '" width="' + size + '" height="' + (arm + half).toFixed(2) + '" fill="' + color + '"/>';
    } else {
      addShape(x, y, 0);
      addShape(x + w, y, 0);
      addShape(x, y + h, 0);
      addShape(x + w, y + h, 0);
    }

    // Top edge
    var numH = Math.max(1, Math.round(w / step));
    var hStep = w / numH;
    for (var i = 1; i < numH; i++) addShape(x + i * hStep, y, 0);
    // Bottom edge
    for (var i = 1; i < numH; i++) addShape(x + i * hStep, y + h, 0);
    // Left edge
    var numV = Math.max(1, Math.round(h / step));
    var vStep = h / numV;
    for (var i = 1; i < numV; i++) addShape(x, y + i * vStep, 1);
    // Right edge
    for (var i = 1; i < numV; i++) addShape(x + w, y + i * vStep, 1);

    return shapes;
  },

  getDominantColor(svgString) {
    var detected = this.detectColors(svgString);
    for (var i = 0; i < detected.length; i++) {
      var c = detected[i].color;
      if (c !== '#FFFFFF' && c !== '#000000') return c;
    }
    return null;
  },

  /**
   * Max lines for multi-line text wrapping.
   */
  MAX_LINES: 6,

  /**
   * Fixed Frame constraints (Category 2 templates with background images)
   */
  FIXED_FRAME_MAX_LINES: 3,
  FIXED_FRAME_MAX_CHARS_PER_LINE: 7,

  /**
   * Get max characters per line based on total text length.
   * Short text gets fewer chars/line so the font stays large.
   * @param {number} len - total text length
   * @returns {number}
   */
  _getMaxCharsPerLine(len) {
    // 1-60 chars: 12 chars per line
    // 61+ chars: 20 chars per line
    return len <= 60 ? 12 : 20;
  },

  /**
   * Split text into lines for Fixed Frame templates.
   * Enforces max 13 chars/line and max 3 lines.
   * @param {string} text
   * @returns {string[]}
   */
  splitTextIntoLinesFixedFrame(text) {
    var maxChars = this.FIXED_FRAME_MAX_CHARS_PER_LINE;
    var maxLines = this.FIXED_FRAME_MAX_LINES;

    if (text.length <= maxChars) return [text];

    var words = text.split(' ');
    var lines = [];
    var currentLine = '';

    // Helper to split a long word across lines EVENLY
    function splitLongWord(word, maxLen, existingLines, maxLinesLimit) {
      var availableLines = maxLinesLimit - existingLines.length;
      if (availableLines <= 0) return [];

      // Calculate how many lines we need
      var numLinesNeeded = Math.ceil(word.length / maxLen);
      var numLines = Math.min(numLinesNeeded, availableLines);

      // Distribute characters evenly across lines
      var charsPerLine = Math.ceil(word.length / numLines);
      // Make sure we don't exceed maxLen
      if (charsPerLine > maxLen) charsPerLine = maxLen;

      var chunks = [];
      for (var i = 0; i < word.length && chunks.length < numLines; i += charsPerLine) {
        chunks.push(word.substring(i, Math.min(i + charsPerLine, word.length)));
      }
      return chunks;
    }

    for (var i = 0; i < words.length; i++) {
      var word = words[i];

      if (currentLine.length === 0) {
        // First word on this line
        if (word.length > maxChars) {
          // Word too long - split it across lines
          var chunks = splitLongWord(word, maxChars, lines, maxLines);
          for (var ci = 0; ci < chunks.length; ci++) {
            if (ci < chunks.length - 1) {
              lines.push(chunks[ci]);
              if (lines.length >= maxLines) break;
            } else {
              currentLine = chunks[ci];
            }
          }
          if (lines.length >= maxLines) break;
        } else {
          currentLine = word;
        }
      } else if (currentLine.length + 1 + word.length <= maxChars) {
        // Fits on current line
        currentLine += ' ' + word;
      } else {
        // Doesn't fit - start new line
        lines.push(currentLine);
        if (lines.length >= maxLines) {
          break;
        }
        if (word.length > maxChars) {
          // Word too long - split it across lines
          var chunks = splitLongWord(word, maxChars, lines, maxLines);
          for (var ci = 0; ci < chunks.length; ci++) {
            if (ci < chunks.length - 1) {
              lines.push(chunks[ci]);
              if (lines.length >= maxLines) break;
            } else {
              currentLine = chunks[ci];
            }
          }
          if (lines.length >= maxLines) break;
        } else {
          currentLine = word;
        }
      }
    }

    // Add the last line if we haven't hit max
    if (currentLine.length > 0 && lines.length < maxLines) {
      lines.push(currentLine);
    }

    // Balance lines if we have 2-3 lines
    if (lines.length >= 2 && lines.length <= 3) {
      var allText = lines.join(' ');
      var allWords = allText.split(' ');

      if (lines.length === 2 && allWords.length >= 2) {
        // Try to balance 2 lines
        var bestDiff = Math.abs(lines[0].length - lines[1].length);
        var bestSplit = lines;

        for (var splitAt = 1; splitAt < allWords.length; splitAt++) {
          var line1 = allWords.slice(0, splitAt).join(' ');
          var line2 = allWords.slice(splitAt).join(' ');
          if (line1.length <= maxChars && line2.length <= maxChars) {
            var diff = Math.abs(line1.length - line2.length);
            if (diff < bestDiff) {
              bestDiff = diff;
              bestSplit = [line1, line2];
            }
          }
        }
        lines = bestSplit;
      }
    }

    return lines;
  },

  /**
   * Estimate text block dimensions based on font metrics.
   * Uses approximate character width for Oswald all-caps.
   * @param {string[]} lines - array of text lines
   * @param {number} fontSize - font size in SVG units
   * @param {number} lineHeight - line height in SVG units
   * @returns {{width: number, height: number}}
   */
  _estimateTextBounds(lines, fontSize, lineHeight) {
    // Oswald all-caps: average char width ≈ 0.55 × fontSize
    var charWidthFactor = 0.55;
    var maxLineChars = 0;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].length > maxLineChars) {
        maxLineChars = lines[i].length;
      }
    }
    var width = maxLineChars * fontSize * charWidthFactor;
    // Height: (n-1) line gaps + approximate cap height (0.7 × fontSize)
    var height = (lines.length - 1) * lineHeight + fontSize * 0.7;
    return { width: width, height: height };
  },

  /**
   * Split text into lines with a dynamic chars-per-line limit.
   * Breaks at word boundaries when possible; forces a break mid-word
   * only if a single word exceeds the limit.
   * @param {string} text
   * @returns {string[]}
   */
  splitTextIntoLines(text) {
    var max = this._getMaxCharsPerLine(text.length);
    if (text.length <= max) return [text];

    var words = text.split(' ');

    // Helper: split a single word into equal-length parts
    function splitWordEvenly(word, maxLen) {
      if (word.length <= maxLen) return [word];
      // Calculate number of lines needed
      var numParts = Math.ceil(word.length / maxLen);
      // Calculate chars per part for even distribution
      var charsPerPart = Math.ceil(word.length / numParts);
      var parts = [];
      for (var i = 0; i < word.length; i += charsPerPart) {
        parts.push(word.substring(i, Math.min(i + charsPerPart, word.length)));
      }
      return parts;
    }

    var lines = [];
    var currentLine = '';

    for (var i = 0; i < words.length; i++) {
      var word = words[i];
      if (currentLine.length === 0) {
        // First word on this line
        if (word.length > max) {
          // Word itself exceeds limit — split evenly
          var parts = splitWordEvenly(word, max);
          for (var pi = 0; pi < parts.length - 1; pi++) {
            lines.push(parts[pi]);
          }
          currentLine = parts[parts.length - 1];
        } else {
          currentLine = word;
        }
      } else if (currentLine.length + 1 + word.length <= max) {
        // Fits on current line
        currentLine += ' ' + word;
      } else {
        // Doesn't fit — start new line
        lines.push(currentLine);
        if (word.length > max) {
          var parts = splitWordEvenly(word, max);
          for (var pi = 0; pi < parts.length - 1; pi++) {
            lines.push(parts[pi]);
          }
          currentLine = parts[parts.length - 1];
        } else {
          currentLine = word;
        }
      }
    }
    if (currentLine.length > 0) lines.push(currentLine);

    // Balance lines: find the split that minimizes the difference between
    // the longest and shortest line. Try all valid ways to distribute
    // words across the same number of lines.
    // Skip if single word was force-split (allWords.length < lines.length)
    var allWords = text.split(' ');
    if (lines.length > 1 && allWords.length >= lines.length) {
      var numLines = lines.length;

      // Build word lengths including the space before each word
      // wordLens[i] = length of word i; joining words i..j gives
      // sum of wordLens + (j-i) spaces
      function lineLen(from, to) {
        var len = 0;
        for (var k = from; k < to; k++) {
          if (k > from) len += 1; // space
          len += allWords[k].length;
        }
        return len;
      }

      // For numLines lines we need (numLines-1) split points among
      // (allWords.length-1) positions. For small word counts this is fast.
      var bestSplit = null;
      var bestDiff = Infinity;

      function tryPartitions(lineIdx, startWord, splits) {
        if (lineIdx === numLines - 1) {
          // Last line gets remaining words
          var ll = lineLen(startWord, allWords.length);
          if (ll === 0) return; // empty last line
          var lengths = splits.slice();
          lengths.push(ll);
          var mx = Math.max.apply(null, lengths);
          var mn = Math.min.apply(null, lengths);
          var diff = mx - mn;
          if (diff < bestDiff) {
            bestDiff = diff;
            bestSplit = lengths.slice();
            // Store actual split points
            bestSplit._words = splits._words ? splits._words.slice() : [];
            bestSplit._words.push(startWord);
          }
          return;
        }
        // Try different numbers of words for this line
        var remainingLines = numLines - lineIdx;
        var remainingWords = allWords.length - startWord;
        // Each remaining line needs at least 1 word
        var maxWordsThisLine = remainingWords - (remainingLines - 1);
        for (var w = 1; w <= maxWordsThisLine; w++) {
          var ll = lineLen(startWord, startWord + w);
          var newSplits = splits.slice();
          newSplits.push(ll);
          if (!newSplits._words) newSplits._words = [];
          else newSplits._words = splits._words.slice();
          newSplits._words.push(startWord);
          tryPartitions(lineIdx + 1, startWord + w, newSplits);
        }
      }

      if (allWords.length <= 20) { // safety limit for recursion
        tryPartitions(0, 0, []);
      }

      if (bestSplit && bestSplit._words) {
        var balanced = [];
        var wordStarts = bestSplit._words;
        for (var bi = 0; bi < wordStarts.length; bi++) {
          var from = wordStarts[bi];
          var to = (bi + 1 < wordStarts.length) ? wordStarts[bi + 1] : allWords.length;
          balanced.push(allWords.slice(from, to).join(' '));
        }
        if (balanced.length === numLines && balanced.every(function(l) { return l.length <= max + 5; })) {
          lines = balanced;
        }
      }
    }

    // No line limit - unlimited rows

    return lines;
  },

  /**
   * Replace text in the SVG string directly (preserves fonts and styles).
   * Finds the nth <text> element, replaces its content, and centers it
   * horizontally within the SVG viewBox.
   * For text longer than MAX_CHARS_PER_LINE, splits into multiple <tspan> lines.
   * @param {string} svgString - cleaned SVG string
   * @param {number} textIndex - 0-based index of <text> element
   * @param {string} newText - replacement text
   * @returns {string} - modified SVG string
   */
  replaceTextInString(svgString, textIndex, newText) {
    // Escape special XML characters in the new text
    var escaped = newText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    // Get the SVG viewBox center for horizontal centering
    var centerX = null;
    var vbMatch = svgString.match(/viewBox=["']\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    if (vbMatch) {
      var vbX = parseFloat(vbMatch[1]);
      var vbW = parseFloat(vbMatch[3]);
      centerX = vbX + vbW / 2;
    }

    // Find all <text ...>...</text> occurrences
    var count = 0;
    var searchStart = 0;
    while (count <= textIndex) {
      var tagStart = svgString.indexOf('<text', searchStart);
      if (tagStart === -1) throw new Error('Text element index ' + textIndex + ' not found');

      // Find the end of the opening tag
      var tagEnd = svgString.indexOf('>', tagStart);
      if (tagEnd === -1) throw new Error('Malformed <text> tag');

      // Check if self-closing
      if (svgString[tagEnd - 1] === '/') {
        searchStart = tagEnd + 1;
        count++;
        continue;
      }

      // Find closing </text>
      var closeTag = svgString.indexOf('</text>', tagEnd);
      if (closeTag === -1) throw new Error('No closing </text> found');

      if (count === textIndex) {
        var tag = svgString.substring(tagStart, tagEnd + 1);

        // Match the case style of the original text
        var originalText = svgString.substring(tagEnd + 1, closeTag);
        // Strip tags first (tspan attributes contain lowercase letters that break case detection)
        var stripped = originalText.replace(/<[^>]*>/g, '');
        // Decode XML entities for comparison
        var decoded = stripped.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
        var letters = decoded.replace(/[^a-zA-Z]/g, '');
        if (letters.length > 0) {
          var upperCount = letters.replace(/[^A-Z]/g, '').length;
          var lowerCount = letters.replace(/[^a-z]/g, '').length;
          if (upperCount > 0 && lowerCount === 0) {
            // Original is ALL CAPS
            escaped = escaped.toUpperCase();
          } else if (lowerCount > 0 && upperCount === 0) {
            // Original is all lowercase
            escaped = escaped.toLowerCase();
          }
        }

        // Add text-anchor="middle" (or replace existing)
        if (tag.match(/text-anchor=/)) {
          tag = tag.replace(/text-anchor=["'][^"']*["']/, 'text-anchor="middle"');
        } else {
          tag = tag.replace('<text', '<text text-anchor="middle"');
        }

        // DON'T shift transform - keep text at original position
        // The viewBox expansion in autoFitTextInString will handle overflow

        // Split text into lines for multi-line support
        // Use the un-escaped text for splitting, then re-escape each line
        var caseAdjusted = escaped
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

        // Check if this is a Category 2 (Fixed Frame) template - has <image> element
        var isFixedFrame = /<image[\s>]/i.test(svgString);
        var lines = isFixedFrame
          ? this.splitTextIntoLinesFixedFrame(caseAdjusted)
          : this.splitTextIntoLines(caseAdjusted);

        // Extract styling attributes from original tspans (if any)
        // These include: fill, font-family, font-size, font-weight, etc.
        var tspanStyle = '';
        var originalTspanMatch = originalText.match(/<tspan([^>]*)>/i);
        if (originalTspanMatch) {
          var originalAttrs = originalTspanMatch[1];
          // Extract styling attributes (exclude x, y, dy which we'll set ourselves)
          // Note: font-family uses a special regex because the value can contain nested quotes
          // e.g., font-family="'Montserrat'" - the [^"']* would stop at the inner single quote
          var fillMatch = originalAttrs.match(/fill=["'][^"']*["']/);
          var fontFamilyMatch = originalAttrs.match(/font-family="([^"]*)"/);  // Match double-quoted value only
          if (!fontFamilyMatch) {
            fontFamilyMatch = originalAttrs.match(/font-family='([^']*)'/);  // Try single-quoted
          }
          var fontSizeMatch = originalAttrs.match(/font-size=["'][^"']*["']/);
          var fontWeightMatch = originalAttrs.match(/font-weight=["'][^"']*["']/);
          if (fillMatch) tspanStyle += ' ' + fillMatch[0];
          if (fontFamilyMatch) tspanStyle += ' font-family="' + fontFamilyMatch[1] + '"';
          if (fontSizeMatch) tspanStyle += ' ' + fontSizeMatch[0];
          if (fontWeightMatch) tspanStyle += ' ' + fontWeightMatch[0];
        }

        // Check if original used y= (absolute) or dy= (relative) positioning
        var usesAbsoluteY = originalText.match(/<tspan[^>]*\by=["']/i) && !originalText.match(/<tspan[^>]*\bdy=["']/i);

        var content;
        if (lines.length === 1) {
          // Single line — use tspan with preserved styling if available
          var lineContent = lines[0]
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          if (tspanStyle) {
            // Wrap in tspan to preserve styling
            // Use y="0" for Fixed Frame templates (absolute), dy="0" for Dynamic Frame (relative)
            var yAttr = usesAbsoluteY ? ' y="0"' : ' dy="0"';
            content = '<tspan x="0"' + yAttr + tspanStyle + '>' + lineContent + '</tspan>';
          } else {
            content = lineContent;
          }
        } else {
          // Multi-line — use <tspan> elements with positioning values.
          // For Fixed Frame (y=), use y values; for Dynamic Frame (dy=), use dy values
          var xAttr = ' x="0"';

          content = '';
          for (var li = 0; li < lines.length; li++) {
            var lineEscaped = lines[li]
              .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            // Use y="0" for first line if original used absolute positioning
            // Otherwise use dy="0" placeholder - will be recalculated in autoFit
            var yAttr = usesAbsoluteY ? ' y="0"' : ' dy="0"';
            content += '<tspan' + xAttr + yAttr + tspanStyle + '>' + lineEscaped + '</tspan>';
          }
        }

        // Replace the tag and content
        var result = svgString.substring(0, tagStart) + tag + content + svgString.substring(closeTag);

        // NOTE: We do NOT expand rects here anymore. All rect expansion and
        // vertical positioning is now done in autoFitTextInString after
        // the final font size is determined. This prevents double-adjustment.

        return result;
      }

      searchStart = closeTag + '</text>'.length;
      count++;
    }
    throw new Error('Text element index ' + textIndex + ' not found');
  },

  /**
   * Expand SVG rect heights and viewBox to accommodate multi-line text.
   * Increases all <rect> element heights and adjusts y positions to keep
   * the template vertically centered.
   * @param {string} svgString
   * @param {number} numLines - total number of text lines
   * @param {number} lineHeight - height per line in SVG units
   * @returns {string}
   * @private
   */
  _expandSvgForLines(svgString, numLines, lineHeight) {
    var extraHeight = (numLines - 1) * lineHeight;
    if (extraHeight <= 0) return svgString;

    // Expand all <rect> elements: increase height, shift y up by half
    var result = svgString.replace(/<rect([^>]*?)\/>/gi, function (match, attrs) {
      var hMatch = attrs.match(/height=["']([\d.]+)["']/);
      var yMatch = attrs.match(/\by=["']([\d.\-]+)["']/);
      if (!hMatch) return match;

      var oldH = parseFloat(hMatch[1]);
      var newH = oldH + extraHeight;
      var newAttrs = attrs.replace(/height=["'][\d.]+["']/, 'height="' + newH.toFixed(2) + '"');

      if (yMatch) {
        var oldY = parseFloat(yMatch[1]);
        var newY = oldY - extraHeight / 2;
        newAttrs = newAttrs.replace(/\by=["'][\d.\-]+["']/, 'y="' + newY.toFixed(2) + '"');
      }

      return '<rect' + newAttrs + '/>';
    });

    // Also handle non-self-closing <rect ...>...</rect>
    result = result.replace(/<rect([^>]*?)>/gi, function (match, attrs) {
      // Skip if already processed (self-closing handled above)
      if (match.endsWith('/>')) return match;

      var hMatch = attrs.match(/height=["']([\d.]+)["']/);
      var yMatch = attrs.match(/\by=["']([\d.\-]+)["']/);
      if (!hMatch) return match;

      var oldH = parseFloat(hMatch[1]);
      var newH = oldH + extraHeight;
      var newAttrs = attrs.replace(/height=["'][\d.]+["']/, 'height="' + newH.toFixed(2) + '"');

      if (yMatch) {
        var oldY = parseFloat(yMatch[1]);
        var newY = oldY - extraHeight / 2;
        newAttrs = newAttrs.replace(/\by=["'][\d.\-]+["']/, 'y="' + newY.toFixed(2) + '"');
      }

      return '<rect' + newAttrs + '>';
    });

    // Expand viewBox height and shift y up
    var vbMatch = result.match(/viewBox=["']\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*["']/);
    if (vbMatch) {
      var vbX = parseFloat(vbMatch[1]);
      var vbY = parseFloat(vbMatch[2]);
      var vbW = parseFloat(vbMatch[3]);
      var vbH = parseFloat(vbMatch[4]);
      var newVbY = vbY - extraHeight / 2;
      var newVbH = vbH + extraHeight;
      var newViewBox = vbX.toFixed(2) + ' ' + newVbY.toFixed(2) + ' ' + vbW.toFixed(2) + ' ' + newVbH.toFixed(2);
      result = result.replace(/viewBox=["'][^"']*["']/, 'viewBox="' + newViewBox + '"');
    }

    return result;
  },

  /**
   * Adjust font-size and/or horizontal scale in the SVG string for auto-fit.
   * Works on the nth <text> element's attributes.
   * @param {string} svgString - cleaned SVG string
   * @param {number} textIndex - 0-based index of <text> element
   * @param {number} maxWidth - max allowed width
   * @param {number} originalFontSize - original font size
   * @param {number} originalScaleX - original horizontal scale from matrix
   * @returns {Promise<string>} - modified SVG string
   */
  async autoFitTextInString(svgString, textIndex, maxWidth, originalFontSize, originalScaleX) {
    originalScaleX = originalScaleX || 1;

    // ============================================================
    // CATEGORY DETECTION: Check if this is a Fixed Frame template
    // Category 2 = has <image> element (illustrated background)
    // Category 1 = no image (simple rect-based frame)
    // ============================================================
    var hasImage = /<image[^>]*>/i.test(svgString);
    var isFixedFrame = hasImage;

    if (isFixedFrame) {
      // Category 2: always auto-fit using container rect from SVG (no bounding_width needed)
      console.log('Category 2 (Fixed Frame) template detected');
      return this._autoFitTextFixedFrame(svgString, textIndex, maxWidth, originalFontSize, originalScaleX);
    }

    // Category 1 requires bounding_width from database
    if (!maxWidth || maxWidth <= 0) return svgString;

    // Category 1: Dynamic Frame - TEXT-FIRST approach
    // Create an HTML wrapper with fonts to measure text accurately
    var htmlDoc = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
      '<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@200;300;400;500;600;700&display=swap" rel="stylesheet">' +
      '<style>' +
      '@font-face{font-family:"Oswald";src:url("/fonts/Oswald-Medium.ttf") format("truetype");font-weight:500;}' +
      '@font-face{font-family:"Montserrat";src:url("/fonts/Montserrat-Black.ttf") format("truetype");font-weight:900;}' +
      '@font-face{font-family:"Nunito";src:url("/fonts/Nunito-Black.ttf") format("truetype");font-weight:900;}' +
      '@font-face{font-family:"RobotoBlack";src:url("/fonts/Roboto-Black.ttf") format("truetype");font-weight:900;}' +
      '@font-face{font-family:"PlayfairDisplay";src:url("/fonts/PlayfairDisplay-Bold.ttf") format("truetype");font-weight:700;}' +
      '@font-face{font-family:"Merriweather";src:url("/fonts/Merriweather-Black.ttf") format("truetype");font-weight:900;}' +
      '@font-face{font-family:"Bitter";src:url("/fonts/Bitter-Bold.ttf") format("truetype");font-weight:700;}' +
      '@font-face{font-family:"Exo2";src:url("/fonts/Exo2-Black.ttf") format("truetype");font-weight:900;}' +
      '@font-face{font-family:"Comfortaa";src:url("/fonts/Comfortaa-Bold.ttf") format("truetype");font-weight:700;}' +
      '@font-face{font-family:"Raleway";src:url("/fonts/Raleway-Black.ttf") format("truetype");font-weight:900;}' +
      '*{margin:0;padding:0;}' +
      '</style>' +
      '</head><body>' + svgString + '</body></html>';
    var blob = new Blob([htmlDoc], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);

    // Use an iframe to render with Google Fonts loaded
    var iframe = document.createElement('iframe');
    iframe.style.position = 'absolute';
    iframe.style.left = '-9999px';
    iframe.style.top = '-9999px';
    iframe.style.width = '2000px';
    iframe.style.height = '1000px';
    iframe.style.visibility = 'hidden';
    document.body.appendChild(iframe);

    return new Promise(function (resolve) {
      iframe.onload = function () {
        // Wait for fonts to load before measuring
        function doMeasure() {
        try {
          var svgDoc = iframe.contentDocument;
          var textEls = svgDoc.querySelectorAll('text');
          var textEl = textEls[textIndex];

          if (!textEl) {
            resolve(svgString);
            return;
          }

          // For multi-line text (<tspan> children), measure the longest line
          var tspans = textEl.querySelectorAll('tspan');
          var measuredWidth;
          if (tspans.length > 1) {
            measuredWidth = 0;
            for (var ti = 0; ti < tspans.length; ti++) {
              var tw = tspans[ti].getComputedTextLength();
              if (tw > measuredWidth) measuredWidth = tw;
            }
          } else {
            measuredWidth = textEl.getComputedTextLength();
          }

          // Get actual rect width from SVG (more reliable than maxWidth from DB)
          var actualRectWidth = maxWidth;
          var rectWidthMatch = svgString.match(/<rect[^>]*\swidth=["']([\d.]+)["']/i);
          if (rectWidthMatch) {
            var foundWidth = parseFloat(rectWidthMatch[1]);
            // Use the rect width if it's reasonable (not a huge background rect)
            var vbWidthMatch = svgString.match(/viewBox=["'][^"']*\s([\d.]+)\s[\d.]+["']/);
            var vbWidth = vbWidthMatch ? parseFloat(vbWidthMatch[1]) : 1000;
            if (foundWidth < vbWidth * 0.95) {
              actualRectWidth = foundWidth;
            }
          }

          // Use smaller of DB maxWidth and actual rect width, with padding
          var effectiveMaxWidth = Math.min(maxWidth, actualRectWidth * 0.85);

          // Calculate ratio based on measured width vs effective max width
          if (measuredWidth > 0) {
            var ratio = effectiveMaxWidth / measuredWidth;

            // NEVER increase font size - only decrease if text is too wide
            if (ratio > 1.0) {
              ratio = 1.0;
            }

            var minFontSize = originalFontSize * 0.4;
            var newFontSize = originalFontSize * ratio;
            var newScaleX = originalScaleX;

            if (newFontSize < minFontSize) {
              newFontSize = minFontSize;
              // At min font size, calculate horizontal compression
              var fontRatio = minFontSize / originalFontSize;
              var widthAtMinFont = measuredWidth * fontRatio;
              if (widthAtMinFont > effectiveMaxWidth) {
                newScaleX = originalScaleX * (effectiveMaxWidth / widthAtMinFont);
              }
            }

            // Stitch shapes extend far outside the rect — scale up text+rect to compensate
            if (/data-stitch=/i.test(svgString)) {
              newFontSize *= 1.15;
            }

            // Apply font-size change in the string
            var result = svgString;
            result = SvgRenderer._setTextAttribute(result, textIndex, 'font-size', newFontSize.toFixed(2));

            // Apply transform scaleX change if needed
            if (newScaleX !== originalScaleX) {
              var currentTransform = SvgRenderer._getTextAttribute(result, textIndex, 'transform');
              if (currentTransform) {
                var newTransform = currentTransform.replace(
                  /matrix\(\s*[\d.]+/,
                  'matrix(' + newScaleX.toFixed(4)
                );
                result = SvgRenderer._setTextAttribute(result, textIndex, 'transform', newTransform);
              }
            }

            // ============================================================
            // TEXT-FIRST APPROACH: Position text at viewBox center, then
            // resize/reposition rects to wrap around the text
            // ============================================================

            // Get viewBox dimensions - this is our reference frame
            var vbMatch = result.match(/viewBox=["']\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*["']/);
            if (!vbMatch) {
              resolve(result);
              return;
            }
            var vbX = parseFloat(vbMatch[1]);
            var vbY = parseFloat(vbMatch[2]);
            var vbW = parseFloat(vbMatch[3]);
            var vbH = parseFloat(vbMatch[4]);

            // STEP 1: Calculate text dimensions
            var numLines = tspans.length > 1 ? tspans.length : 1;
            var lineHeight = newFontSize * 1.1; // 10% extra spacing between lines
            var textBlockHeight = (numLines - 1) * lineHeight + newFontSize * 0.8;
            var fontRatioCalc = newFontSize / originalFontSize;
            var textBlockWidth = measuredWidth * fontRatioCalc * newScaleX;

            // STEP 2: Calculate rect dimensions to wrap around text
            var rectPadding = newFontSize * 0.5;
            var newRectWidth = textBlockWidth + rectPadding * 2;
            var newRectHeight = textBlockHeight + rectPadding * 2;

            // STEP 3: Position text at viewBox center (FIXED reference point)
            var viewBoxCenterX = vbX + vbW / 2;
            var viewBoxCenterY = vbY + vbH / 2;

            // For multi-line text with tspans
            if (tspans.length > 1) {
              // Calculate tspan dy values for vertical centering around the text position
              var totalSpan = (numLines - 1) * lineHeight;
              var firstDy = -totalSpan / 2 + newFontSize * 0.39;

              var lineIdx = 0;
              result = result.replace(/<tspan([^>]*?)dy=["']([\d.\-]+)["']/gi, function () {
                var before = arguments[1];
                var dyVal = (lineIdx === 0) ? firstDy : lineHeight;
                lineIdx++;
                return '<tspan' + before + 'dy="' + dyVal.toFixed(2) + '"';
              });

              // Set tspan x="0" - in the transformed coordinate system, x=0 is the center
              // (because the text transform positions at viewBoxCenterX)
              result = result.replace(/<tspan([^>]*?)\bx=["'][\d.\-]+["']/gi, function (_match, before) {
                return '<tspan' + before + 'x="0"';
              });
            }

            // STEP 4: Position text at viewBox center
            var curTransform = SvgRenderer._getTextAttribute(result, textIndex, 'transform');
            if (curTransform) {
              var mMatch = curTransform.match(/matrix\(\s*([\d.\-]+)[,\s]+([\d.\-]+)[,\s]+([\d.\-]+)[,\s]+([\d.\-]+)[,\s]+([\d.\-]+)[,\s]+([\d.\-]+)\s*\)/);
              if (mMatch) {
                // For single-line, add baseline offset; for multi-line, tspan dy handles it
                var baselineOffset = (tspans.length <= 1) ? newFontSize * 0.39 : 0;
                var newTx = viewBoxCenterX;
                var newTy = viewBoxCenterY + baselineOffset;
                var newMat = 'matrix(' + mMatch[1] + ' ' + mMatch[2] + ' ' + mMatch[3] + ' ' + mMatch[4] + ' ' + newTx.toFixed(4) + ' ' + newTy.toFixed(4) + ')';
                result = SvgRenderer._setTextAttribute(result, textIndex, 'transform', newMat);
              }
            }

            // Set text-anchor for horizontal centering
            result = SvgRenderer._setTextAttribute(result, textIndex, 'text-anchor', 'middle');

            // STEP 5: Resize/reposition rects to wrap around text (centered on viewBox center)
            var newRectX = viewBoxCenterX - newRectWidth / 2;
            var newRectY = viewBoxCenterY - newRectHeight / 2;

            // First pass: find the largest rect width (outer frame) to classify rects
            var rectInfos = [];
            (result.match(/<rect[^>]*>/gi) || []).forEach(function(rectTag) {
              if (rectTag.match(/fill=["']#FFFFFF["']/i) || rectTag.match(/fill=["']white["']/i)) return;
              var wm = rectTag.match(/\swidth=["']([\d.]+)["']/);
              var swm = rectTag.match(/stroke-width=["']([\d.]+)["']/);
              if (wm) rectInfos.push({ w: parseFloat(wm[1]), sw: swm ? parseFloat(swm[1]) : 0 });
            });
            rectInfos.sort(function(a, b) { return b.w - a.w; });
            var rectWidths = rectInfos.map(function(r) { return r.w; });
            var outerRectOrigW = rectWidths[0] || vbW;
            var outerRectSw = rectInfos.length > 0 ? rectInfos[0].sw : 0;
            var mainRectThreshold = outerRectOrigW * 0.7;
            var decorScale = newRectWidth / outerRectOrigW;
            var innerPaddingX = outerRectSw > 0 ? outerRectSw * 0.22 : 11;
            var innerPaddingY = outerRectSw > 0 ? outerRectSw * 0.20 : 10;
            var borderShapeData = null;
            var borderFilterData = null;
            var stitchData = null;
            var wavyData = null;

            // Second pass: resize rects
            result = result.replace(/<rect([^>]*?)(\/?)>/gi, function (m, attrs, selfClose) {
              // Skip background rects (white fill at origin or very large)
              if (attrs.match(/fill=["']#FFFFFF["']/i) || attrs.match(/fill=["']white["']/i)) {
                var wMatch = attrs.match(/\swidth=["']([\d.]+)["']/);
                var xMatch = attrs.match(/\bx=["']([\d.\-]+)["']/);
                var xVal = xMatch ? parseFloat(xMatch[1]) : 0;
                if ((wMatch && parseFloat(wMatch[1]) > vbW * 0.9) || xVal < 10) {
                  return m; // Skip background
                }
              }

              var hasX = attrs.match(/\bx=["']/);
              var hasY = attrs.match(/\by=["']/);
              var hasW = attrs.match(/\swidth=["']/);
              var hasH = attrs.match(/\sheight=["']/);
              if (!hasW || !hasH) return m;

              var origW = parseFloat(attrs.match(/\swidth=["']([\d.]+)["']/)[1]);
              var origH = parseFloat(attrs.match(/\sheight=["']([\d.]+)["']/)[1]);
              var na = attrs;

              if (origW >= mainRectThreshold) {
                // Main frame rect: resize to wrap text
                var isInnerRect = origW < outerRectOrigW * 0.99;
                if (isInnerRect) {
                  // Extra inset when filter border active (ripped paper displaces edges)
                  var filterExtra = borderFilterData ? parseFloat(borderFilterData.split('-')[1]) || 0 : 0;
                  // Extra inset when border shapes intrude past stroke edge
                  var shapeExtra = 0;
                  if (borderShapeData) {
                    var bRad = parseFloat(borderShapeData.type.split('-')[1]) || 0;
                    shapeExtra = Math.max(0, bRad - 15);
                  }
                  var iPadX = innerPaddingX + filterExtra + shapeExtra;
                  var iPadY = innerPaddingY + filterExtra + shapeExtra;
                  na = na.replace(/(\s)width=["'][\d.]+["']/, '$1width="' + (newRectWidth - iPadX * 2).toFixed(2) + '"');
                  na = na.replace(/(\s)height=["'][\d.]+["']/, '$1height="' + (newRectHeight - iPadY * 2).toFixed(2) + '"');
                  if (hasX) na = na.replace(/\bx=["'][\d.\-]+["']/, 'x="' + (newRectX + iPadX).toFixed(2) + '"');
                  if (hasY) na = na.replace(/\by=["'][\d.\-]+["']/, 'y="' + (newRectY + iPadY).toFixed(2) + '"');
                } else {
                  na = na.replace(/(\s)width=["'][\d.]+["']/, '$1width="' + newRectWidth.toFixed(2) + '"');
                  na = na.replace(/(\s)height=["'][\d.]+["']/, '$1height="' + newRectHeight.toFixed(2) + '"');
                  if (hasX) na = na.replace(/\bx=["'][\d.\-]+["']/, 'x="' + newRectX.toFixed(2) + '"');
                  if (hasY) na = na.replace(/\by=["'][\d.\-]+["']/, 'y="' + newRectY.toFixed(2) + '"');
                  // Capture border shape data from outer rect
                  var borderAttr = attrs.match(/data-border=["']([^"']+)["']/);
                  if (borderAttr) {
                    var swMatch = attrs.match(/stroke-width=["']([\d.]+)["']/);
                    var halfStroke = swMatch ? parseFloat(swMatch[1]) / 2 : 0;
                    borderShapeData = {
                      type: borderAttr[1],
                      x: newRectX - halfStroke,
                      y: newRectY - halfStroke,
                      w: newRectWidth + halfStroke * 2,
                      h: newRectHeight + halfStroke * 2
                    };
                    na = na.replace(/\s*data-border=["'][^"']+["']/, '');
                  }
                  // Capture filter data from outer rect
                  var filterAttr = attrs.match(/data-filter=["']([^"']+)["']/);
                  if (filterAttr) {
                    borderFilterData = filterAttr[1];
                    na = na.replace(/\s*data-filter=["'][^"']+["']/, '');
                  }
                  // Capture stitch data from outer rect
                  var stitchAttr = attrs.match(/data-stitch=["']([^"']+)["']/);
                  if (stitchAttr) {
                    // Extract color from fill or stroke
                    var stitchColorMatch = attrs.match(/(?:fill|stroke)=["'](#[0-9A-Fa-f]{6})["']/);
                    stitchData = {
                      type: stitchAttr[1],
                      x: newRectX,
                      y: newRectY,
                      w: newRectWidth,
                      h: newRectHeight,
                      color: stitchColorMatch ? stitchColorMatch[1] : '#000000'
                    };
                    na = na.replace(/\s*data-stitch=["'][^"']+["']/, '');
                    // Hide stroke — stitch shapes ARE the border (keep attr for viewBox bounds scan)
                    na = na.replace(/stroke=["'][^"']*["']/, 'stroke="none"');
                    na = na.replace(/\s*stroke-width=["'][^"']*["']/, '');
                    na = na.replace(/\s*stroke-miterlimit=["'][^"']*["']/, '');
                  }
                  // Capture wavy data from outer rect
                  var wavyAttr = attrs.match(/data-wavy=["']([^"']+)["']/);
                  if (wavyAttr) {
                    var wavyColorMatch = attrs.match(/(?:fill|stroke)=["'](#[0-9A-Fa-f]{6})["']/);
                    var wavySwMatch = attrs.match(/stroke-width=["']([\d.]+)["']/);
                    var wavyFilled = !!attrs.match(/fill=["']#[0-9A-Fa-f]{6}["']/);
                    wavyData = {
                      variant: wavyAttr[1],
                      x: newRectX,
                      y: newRectY,
                      w: newRectWidth,
                      h: newRectHeight,
                      color: wavyColorMatch ? wavyColorMatch[1] : '#000000',
                      strokeW: wavySwMatch ? parseFloat(wavySwMatch[1]) : 20,
                      filled: wavyFilled
                    };
                    na = na.replace(/\s*data-wavy=["'][^"']+["']/, '');
                    // Hide the rect — wavy path replaces it entirely (handles fill + stroke)
                    na = na.replace(/stroke=["'][^"']*["']/, 'stroke="none"');
                    na = na.replace(/stroke-width=["'][^"']*["']/, 'stroke-width="0"');
                    na = na.replace(/fill=["'][^"']*["']/, 'fill="none"');
                  }
                }
              } else {
                // Decorative rect (bars, accents): scale proportionally
                var origRectX = hasX ? parseFloat(attrs.match(/\bx=["']([\d.\-]+)["']/)[1]) : 0;
                var origRectY = hasY ? parseFloat(attrs.match(/\by=["']([\d.\-]+)["']/)[1]) : 0;
                var origCX = vbX + vbW / 2;
                var origCY = vbY + vbH / 2;
                var dNewW = origW * decorScale;
                var dNewH = origH * decorScale;
                var dNewX = viewBoxCenterX + (origRectX - origCX) * decorScale;
                var dNewY = viewBoxCenterY + (origRectY - origCY) * decorScale;
                na = na.replace(/(\s)width=["'][\d.]+["']/, '$1width="' + dNewW.toFixed(2) + '"');
                na = na.replace(/(\s)height=["'][\d.]+["']/, '$1height="' + dNewH.toFixed(2) + '"');
                if (hasX) na = na.replace(/\bx=["'][\d.\-]+["']/, 'x="' + dNewX.toFixed(2) + '"');
                if (hasY) na = na.replace(/\by=["'][\d.\-]+["']/, 'y="' + dNewY.toFixed(2) + '"');
              }

              return '<rect' + na + (selfClose || '') + '>';
            });

            // ---- BORDER SHAPES (winding/zigzag) ----
            if (borderShapeData) {
              var bParts = borderShapeData.type.split('-');
              var bShape = bParts[0];
              var bRadius = parseFloat(bParts[1]) || 15;
              // Double diamond size for zigzag only (don't affect circle/perforated)
              if (bShape === 'diamond') bRadius = bRadius * 1.5;
              var bSpacingMult = bParts[2] ? parseFloat(bParts[2]) : 2.5;
              var shapesHtml = SvgRenderer._generateBorderShapes(
                borderShapeData.x, borderShapeData.y,
                borderShapeData.w, borderShapeData.h,
                bShape, bRadius, bSpacingMult
              );
              result = result.replace(/<\/svg>/, shapesHtml + '</svg>');
            }

            // ---- STITCH BORDER (line/square/circle shapes) ----
            if (stitchData) {
              var sType = stitchData.type;
              var sSize = (sType === 'circle') ? 50 : 40;
              var sSpacing = (sType === 'circle') ? 20 : (sType === 'line') ? 30 : 20;
              // Offset shapes outward so they're clearly outside the fill
              var sOffset = sSize * 0.75;
              var stitchHtml = SvgRenderer._generateStitchShapes(
                stitchData.x - sOffset, stitchData.y - sOffset,
                stitchData.w + sOffset * 2, stitchData.h + sOffset * 2,
                sType, sSize, sSpacing, stitchData.color
              );
              result = result.replace(/<\/svg>/, stitchHtml + '</svg>');
            }

            // ---- WAVY BORDER ----
            if (wavyData) {
              var wavyHtml = SvgRenderer._generateWavyBorder(
                wavyData.x, wavyData.y, wavyData.w, wavyData.h,
                wavyData.color, wavyData.strokeW, wavyData.variant, wavyData.filled
              );
              result = result.replace(/<text/, wavyHtml + '<text');
            }

            // ---- BORDER FILTER (ripped paper etc.) ----
            if (borderFilterData) {
              var fParts = borderFilterData.split('-');
              var fType = fParts[0];
              var fScale = parseFloat(fParts[1]) || 20;
              if (fType === 'ripped') {
                var fId = 'border-rip-' + Date.now() + '-' + Math.round(Math.random() * 9999);
                var freq = fScale <= 10 ? '0.04' : fScale <= 20 ? '0.035' : '0.025';
                var octaves = fScale <= 20 ? 4 : 3;
                var fMargin = Math.ceil(fScale / 3);
                var filterDef = '<defs><filter id="' + fId + '" x="-' + fMargin + '%" y="-' + fMargin + '%" width="' + (100 + fMargin * 2) + '%" height="' + (100 + fMargin * 2) + '%">' +
                  '<feTurbulence type="fractalNoise" baseFrequency="' + freq + ' ' + freq + '" numOctaves="' + octaves + '" seed="1"/>' +
                  '<feDisplacementMap in="SourceGraphic" scale="' + fScale + '" xChannelSelector="R" yChannelSelector="R"/>' +
                  '</filter></defs>';
                result = result.replace(/(<svg[^>]*>)/i, '$1' + filterDef);
                // Apply filter to the outer rect (first non-white rect with matching dimensions)
                var filterRectRe = new RegExp('(<rect[^>]*width="' + newRectWidth.toFixed(2) + '"[^>]*)(\/?>)');
                result = result.replace(filterRectRe, '$1 filter="url(#' + fId + ')"$2');
              }
            }

            // ---- BRUSH BORDER SCALING ----
            var brushMatch = result.match(/data-brush-border=["']([^"']+)["']/);
            if (brushMatch) {
              var bbParts = brushMatch[1].split(',');
              var origBX = parseFloat(bbParts[0]);
              var origBY = parseFloat(bbParts[1]);
              var origBW = parseFloat(bbParts[2]);
              var origBH = parseFloat(bbParts[3]);
              var origBCX = origBX + origBW / 2;
              var origBCY = origBY + origBH / 2;
              var overScale = 1.0;
              var bsx = (newRectWidth / origBW) * overScale;
              var bsy = (newRectHeight / origBH) * overScale;
              var newBCX = newRectX + newRectWidth / 2;
              var newBCY = newRectY + newRectHeight / 2;
              var brushTransform = 'translate(' + newBCX.toFixed(2) + ',' + newBCY.toFixed(2) + ') scale(' + bsx.toFixed(4) + ',' + bsy.toFixed(4) + ') translate(' + (-origBCX).toFixed(2) + ',' + (-origBCY).toFixed(2) + ')';
              result = result.replace(/(<g[^>]*data-brush-border=["'][^"']*["'])([^>]*>)/, '$1 transform="' + brushTransform + '"$2');
              // Duplicate brush group for denser/stronger strokes
              var brushGroupMatch = result.match(/<g[^>]*data-brush-border=["'][^"']*["'][^>]*>([\s\S]*?)<\/g>/);
              if (brushGroupMatch) {
                var dupeGroup = '<g transform="' + brushTransform + '">' + brushGroupMatch[1].trim() + '</g>';
                result = result.replace(/<g[^>]*data-brush-border=["'][^"']*["'][^>]*>[\s\S]*?<\/g>/, '$&' + dupeGroup + dupeGroup);
              }
              // Shrink the colored rect so brush strokes are exposed at edges
              var shrink = 70;
              var shrunkX = (newRectX + shrink).toFixed(2);
              var shrunkY = (newRectY + shrink).toFixed(2);
              var shrunkW = (newRectWidth - shrink * 2).toFixed(2);
              var shrunkH = (newRectHeight - shrink * 2).toFixed(2);
              // Find and resize the colored rect
              var colorRectRe = /<rect([^>]*fill=["']#[A-Fa-f0-9]{6}["'][^>]*)\/?\>/i;
              var crMatch = result.match(colorRectRe);
              if (crMatch && !/fill=["']#FFF/i.test(crMatch[1]) && !/fill=["']white/i.test(crMatch[1])) {
                var oldRect = crMatch[0];
                var newRect = oldRect
                  .replace(/\bx=["'][^"']*["']/, 'x="' + shrunkX + '"')
                  .replace(/\by=["'][^"']*["']/, 'y="' + shrunkY + '"')
                  .replace(/\bwidth=["'][^"']*["']/, 'width="' + shrunkW + '"')
                  .replace(/\bheight=["'][^"']*["']/, 'height="' + shrunkH + '"');
                result = result.replace(oldRect, newRect);
              }

              // Hide vertical brush group — rotated horizontal paths don't produce natural verticals
              result = result.replace(/<g[^>]*data-brush-border-v=["'][^"']*["'][^>]*>[\s\S]*?<\/g>/, '');
            }

            // ---- FIT VIEWBOX TO CONTENT ----
            // These templates may use <path> elements for stamp frames (not <rect>).
            // Strategy: find all visual content bounds and fit viewBox tightly.

            var hvbMatch = result.match(/viewBox=["']\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*["']/);
            if (hvbMatch) {
              // Find stamp frame bounds from rects (the visible frame)
              var contentBounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };

              // Check rects (for rect-based templates)
              var rectMatches = result.match(/<rect[^>]*>/gi) || [];
              rectMatches.forEach(function(rectTag) {
                // Skip display:none
                if (rectTag.match(/display\s*[:=]\s*["']?none/i)) return;
                // Skip small generated stitch shape rects (fill-only, no stroke)
                // But keep large fill-only rects (e.g. brushstroke main rect)
                if (!rectTag.match(/\bstroke=/i)) {
                  var swCheck = rectTag.match(/\swidth=["']([\d.]+)["']/);
                  if (!swCheck || parseFloat(swCheck[1]) < 100) return;
                }
                // Skip background rects (white fill at origin)
                var isWhiteFill = rectTag.match(/fill=["']#FFFFFF["']/i) || rectTag.match(/fill=["']white["']/i);
                var xMatch = rectTag.match(/\bx=["']([\d.\-]+)["']/);
                var yMatch = rectTag.match(/\by=["']([\d.\-]+)["']/);
                var rx = xMatch ? parseFloat(xMatch[1]) : 0;
                var ry = yMatch ? parseFloat(yMatch[1]) : 0;
                if (isWhiteFill && rx < 10 && ry < 10) return; // Background rect
                var wMatch = rectTag.match(/\swidth=["']([\d.]+)["']/);
                var hMatch = rectTag.match(/\sheight=["']([\d.]+)["']/);
                if (wMatch && hMatch) {
                  var rw = parseFloat(wMatch[1]);
                  var rh = parseFloat(hMatch[1]);
                  if (rx < contentBounds.minX) contentBounds.minX = rx;
                  if (rx + rw > contentBounds.maxX) contentBounds.maxX = rx + rw;
                  if (ry < contentBounds.minY) contentBounds.minY = ry;
                  if (ry + rh > contentBounds.maxY) contentBounds.maxY = ry + rh;
                }
              });

              // If we found content bounds, use them
              if (contentBounds.minX !== Infinity) {
                // Find max stroke-width from visible rects for accurate padding
                var maxStrokeWidth = 0;
                rectMatches.forEach(function(rectTag) {
                  if (rectTag.match(/fill=["']#FFFFFF["']/i) || rectTag.match(/fill=["']white["']/i)) return;
                  var swMatch = rectTag.match(/stroke-width=["']([\d.]+)["']/);
                  if (swMatch) maxStrokeWidth = Math.max(maxStrokeWidth, parseFloat(swMatch[1]));
                });
                var strokePadding = maxStrokeWidth / 2 + 15;
                // Brush border paths extend further — padding scales with overScale
                if (brushMatch) {
                  var brushExtent = (overScale - 1) * Math.max(origBW, origBH) / 2 + 30;
                  strokePadding = Math.max(strokePadding, brushExtent);
                }
                // Stitch shapes extend beyond rect edge (offset + size/2)
                if (stitchData) strokePadding = Math.max(strokePadding, 70);
                // Wavy border arcs extend beyond rect edge (depth + strokeW/2)
                if (wavyData) strokePadding = Math.max(strokePadding, 35);

                var fitVbX = contentBounds.minX - strokePadding;
                var fitVbY = contentBounds.minY - strokePadding;
                var fitVbW = (contentBounds.maxX - contentBounds.minX) + strokePadding * 2;
                var fitVbH = (contentBounds.maxY - contentBounds.minY) + strokePadding * 2;

                // Apply the tight viewBox
                result = result.replace(/viewBox=["'][^"']*["']/, 'viewBox="' + fitVbX.toFixed(2) + ' ' + fitVbY.toFixed(2) + ' ' + fitVbW.toFixed(2) + ' ' + fitVbH.toFixed(2) + '"');

                // Update width/height attributes to match
                result = result.replace(/(<svg[^>]*)\bwidth=["'][\d.]+[a-z]*["']/, '$1width="' + fitVbW.toFixed(2) + '"');
                result = result.replace(/(<svg[^>]*)\bheight=["'][\d.]+[a-z]*["']/, '$1height="' + fitVbH.toFixed(2) + '"');
              }
            }

            resolve(result);
          } else {
            resolve(svgString);
          }
        } catch (e) {
          console.error('autoFitText measurement failed:', e, e.stack);
          resolve(svgString);
        } finally {
          document.body.removeChild(iframe);
          URL.revokeObjectURL(url);
        }
        } // end doMeasure

        // Wait for fonts before measuring
        if (iframe.contentDocument && iframe.contentDocument.fonts) {
          iframe.contentDocument.fonts.ready.then(function () {
            setTimeout(doMeasure, 50);
          }).catch(function () {
            setTimeout(doMeasure, 500);
          });
        } else {
          setTimeout(doMeasure, 500);
        }
      };

      iframe.src = url;
    });
  },

  /**
   * Category 2: Fixed Frame text fitting.
   * Calculates OPTIMAL font size to fill container.
   * KEEPS original text transform position - only adjusts font size and y values.
   * Does NOT modify rects, viewBox, or background.
   * @private
   */
  async _autoFitTextFixedFrame(svgString, textIndex, maxWidth, originalFontSize, originalScaleX) {
    // Fixed container dimensions for Leonardo template (Category 2)
    var containerX = 0;
    var containerY = 0;
    var containerWidth = 1338;
    var containerHeight = 693;

    // Try to extract from SVG (rect with fill="none")
    var rectMatches = svgString.match(/<rect[^>]+>/gi) || [];
    for (var ri = 0; ri < rectMatches.length; ri++) {
      var rect = rectMatches[ri];
      if (rect.match(/fill=["']none["']/i)) {
        var xMatch = rect.match(/\bx=["']([\d.\-]+)["']/i);
        var yMatch = rect.match(/\by=["']([\d.\-]+)["']/i);
        var wMatch = rect.match(/\swidth=["']([\d.]+)["']/i);
        var hMatch = rect.match(/\sheight=["']([\d.]+)["']/i);
        if (wMatch && hMatch) {
          containerX = xMatch ? parseFloat(xMatch[1]) : 0;
          containerY = yMatch ? parseFloat(yMatch[1]) : 0;
          containerWidth = parseFloat(wMatch[1]);
          containerHeight = parseFloat(hMatch[1]);
          console.log('Fixed Frame: Found container rect at (' + containerX + ',' + containerY + ') size:', containerWidth, 'x', containerHeight);
          break;
        }
      }
    }

    // Get current text content to calculate lines
    var textContentMatch = svgString.match(/<text[^>]*>([\s\S]*?)<\/text>/i);
    var currentText = '';
    if (textContentMatch) {
      // Extract text from tspans
      var tspanTexts = textContentMatch[1].match(/<tspan[^>]*>([^<]*)<\/tspan>/gi);
      if (tspanTexts) {
        var texts = [];
        tspanTexts.forEach(function(t) {
          var m = t.match(/<tspan[^>]*>([^<]*)<\/tspan>/i);
          if (m && m[1]) texts.push(m[1]);
        });
        currentText = texts.join(' ');
      }
    }

    // Extract horizontal scale from text transform matrix
    var textTransformMatch = svgString.match(/<text[^>]*transform=["']matrix\(([^)]+)\)["']/i);
    var textScaleX = 1;
    if (textTransformMatch) {
      var txParts = textTransformMatch[1].trim().split(/[\s,]+/);
      if (txParts.length >= 1) textScaleX = parseFloat(txParts[0]) || 1;
    }
    console.log('Fixed Frame: text scaleX =', textScaleX);

    // Detect font from SVG to use appropriate charWidthFactor
    var detectedFont = '';
    var fontDetectMatch = svgString.match(/font-family="([^"]*)"/i);
    if (!fontDetectMatch) fontDetectMatch = svgString.match(/font-family='([^']*)'/i);
    if (fontDetectMatch) detectedFont = fontDetectMatch[1].replace(/'/g, '').toLowerCase();

    var charWidthFactor;
    if (detectedFont.indexOf('oswald') !== -1) {
      charWidthFactor = 0.42;  // Oswald (condensed)
    } else if (detectedFont.indexOf('roboto') !== -1) {
      charWidthFactor = 0.53;  // Roboto Black uppercase
    } else {
      charWidthFactor = 0.50;  // Standard width (default)
    }
    console.log('Fixed Frame: font="' + detectedFont + '", charWidthFactor=' + charWidthFactor);

    var horizontalPadding = 0.98;
    var verticalPadding = 1.0;
    var availableWidth = containerWidth * horizontalPadding / textScaleX;
    var availableHeight = containerHeight * verticalPadding;
    var maxLinesLimit = 6;  // safety cap (algorithm picks optimal count)

    // --- Optimal line splitting: try ALL valid word-boundary splits ---
    var words = currentText.split(' ').filter(function(w) { return w.length > 0; });

    // lineHeightFactor per line count — tighter spacing for more lines
    var LINE_HEIGHT_FACTORS = [0, 1.0, 1.05, 0.95, 0.72, 0.66, 0.62];

    // Helper: calculate optimal font size for a line configuration
    function calcFontSize(lines) {
      var n = lines.length;
      var longest = 0;
      for (var i = 0; i < n; i++) {
        if (lines[i].length > longest) longest = lines[i].length;
      }
      if (longest === 0) return 0;
      var byWidth = availableWidth / (longest * charWidthFactor);
      var lhf = n < LINE_HEIGHT_FACTORS.length ? LINE_HEIGHT_FACTORS[n] : 0.60;
      var byHeight = availableHeight / (n * lhf);
      return Math.min(byWidth, byHeight);
    }

    var bestLines = [currentText];
    var bestFontSize = 0;

    // Recursively try all ways to split words into exactly n lines at word boundaries
    function trySplits(remainingWords, linesLeft, prefix) {
      if (linesLeft === 1) {
        var candidate = prefix.concat([remainingWords.join(' ')]);
        var fs = calcFontSize(candidate);
        if (fs > bestFontSize) {
          bestFontSize = fs;
          bestLines = candidate;
        }
        return;
      }
      // Try each possible split point for the first line
      var maxFirst = remainingWords.length - (linesLeft - 1);  // leave at least 1 word per remaining line
      for (var k = 1; k <= maxFirst; k++) {
        var firstLine = remainingWords.slice(0, k).join(' ');
        trySplits(remainingWords.slice(k), linesLeft - 1, prefix.concat([firstLine]));
      }
    }

    var maxN = Math.min(maxLinesLimit, words.length);
    for (var tryN = 1; tryN <= maxN; tryN++) {
      trySplits(words, tryN, []);
    }

    var lines = bestLines;
    var numLines = lines.length;
    var longestLine = '';
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].length > longestLine.length) longestLine = lines[i];
    }

    var optimalFontSize = bestFontSize;
    var maxCap = (numLines === 1) ? 650 : 500;
    if (optimalFontSize > maxCap) optimalFontSize = maxCap;

    var lineHeightFactor = numLines < LINE_HEIGHT_FACTORS.length ? LINE_HEIGHT_FACTORS[numLines] : 0.60;

    console.log('Fixed Frame: Best=' + numLines + ' lines, fontSize=' + optimalFontSize.toFixed(2), lines);

    // Extract styling from original tspans
    var tspanStyle = '';
    var originalTspanMatch = svgString.match(/<tspan([^>]*)>/i);
    if (originalTspanMatch) {
      var originalAttrs = originalTspanMatch[1];
      var fillMatch = originalAttrs.match(/fill=["'][^"']*["']/);
      var fontFamilyMatch = originalAttrs.match(/font-family="([^"]*)"/);
      if (!fontFamilyMatch) fontFamilyMatch = originalAttrs.match(/font-family='([^']*)'/);
      var fontWeightMatch = originalAttrs.match(/font-weight=["'][^"']*["']/);
      if (fillMatch) {
        tspanStyle += ' ' + fillMatch[0];
        // Add matching stroke to thicken text (helps with horizontal scaling)
        var fillVal = fillMatch[0].match(/fill=["']([^"']*)["']/);
        if (fillVal) tspanStyle += ' stroke="' + fillVal[1] + '" stroke-width="2"';
      }
      if (fontFamilyMatch) tspanStyle += ' font-family="' + fontFamilyMatch[1] + '"';
      if (fontWeightMatch) tspanStyle += ' ' + fontWeightMatch[0];
    }

    // Build tspans with proper vertical centering
    // y values are relative to text element's transform position
    var lineHeight = optimalFontSize * lineHeightFactor;
    var totalTextHeight = (numLines - 1) * lineHeight;
    // Center point is y=0 in text coordinates, so offset by half height up, plus baseline adjustment
    var firstLineY = -totalTextHeight / 2 + optimalFontSize * 0.38;

    var newContent = '';
    for (var li = 0; li < lines.length; li++) {
      var lineText = lines[li]
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      var yVal = firstLineY + li * lineHeight;
      newContent += '<tspan x="0" y="' + yVal.toFixed(2) + '" font-size="' + optimalFontSize.toFixed(2) + '"' + tspanStyle + '>' + lineText + '</tspan>';
    }

    // Replace the text content, keeping the original <text> tag with its transform
    var result = svgString.replace(
      /(<text[^>]*>)([\s\S]*?)(<\/text>)/i,
      '$1' + newContent + '$3'
    );

    // Ensure text-anchor="middle" for horizontal centering
    if (!result.match(/<text[^>]*text-anchor=/i)) {
      result = result.replace(/(<text)([^>]*>)/i, '$1 text-anchor="middle"$2');
    } else {
      result = result.replace(/(<text[^>]*)text-anchor=["'][^"']*["']/i, '$1text-anchor="middle"');
    }

    // Override the text transform position to center text within the container rect.
    // Original template text positions may be at arbitrary locations (e.g. left-aligned),
    // so we force centering on the container rect's center point.
    var textCenterX = containerX + containerWidth * 0.46;
    var textCenterY = containerY + containerHeight * 0.47;
    result = result.replace(
      /(<text[^>]*transform=["'])matrix\(([^)]+)\)(["'])/i,
      function(match, before, matrixContent, after) {
        var parts = matrixContent.trim().split(/[\s,]+/);
        if (parts.length >= 6) {
          var newMatrix = parts[0] + ' ' + parts[1] + ' ' + parts[2] + ' ' + parts[3] + ' ' + textCenterX.toFixed(2) + ' ' + textCenterY.toFixed(2);
          return before + 'matrix(' + newMatrix + ')' + after;
        }
        return match;
      }
    );

    console.log('Fixed Frame: Generated', numLines, 'lines at font size', optimalFontSize.toFixed(2), '| text center:', textCenterX.toFixed(2), textCenterY.toFixed(2));

    return result;
  },

  /**
   * Get an attribute value from the nth <text> element in an SVG string.
   * @private
   */
  _getTextAttribute(svgString, textIndex, attrName) {
    var count = 0;
    var searchStart = 0;
    while (count <= textIndex) {
      var tagStart = svgString.indexOf('<text', searchStart);
      if (tagStart === -1) return null;
      var tagEnd = svgString.indexOf('>', tagStart);
      if (tagEnd === -1) return null;

      if (count === textIndex) {
        var tag = svgString.substring(tagStart, tagEnd + 1);
        var match = tag.match(new RegExp(attrName + '=["\'](.*?)["\']'));
        return match ? match[1] : null;
      }

      var closeTag = svgString.indexOf('</text>', tagEnd);
      searchStart = closeTag !== -1 ? closeTag + 7 : tagEnd + 1;
      count++;
    }
    return null;
  },

  /**
   * Set an attribute value on the nth <text> element in an SVG string.
   * @private
   */
  _setTextAttribute(svgString, textIndex, attrName, newValue) {
    var count = 0;
    var searchStart = 0;
    while (count <= textIndex) {
      var tagStart = svgString.indexOf('<text', searchStart);
      if (tagStart === -1) return svgString;
      var tagEnd = svgString.indexOf('>', tagStart);
      if (tagEnd === -1) return svgString;

      if (count === textIndex) {
        var tag = svgString.substring(tagStart, tagEnd + 1);
        var regex = new RegExp('(' + attrName + '=["\'])([^"\']*?)(["\'])');
        var newTag;
        if (regex.test(tag)) {
          // Attribute exists - replace it
          newTag = tag.replace(regex, '$1' + newValue + '$3');
        } else {
          // Attribute doesn't exist - add it before the closing >
          newTag = tag.replace(/>$/, ' ' + attrName + '="' + newValue + '">');
        }
        return svgString.substring(0, tagStart) + newTag + svgString.substring(tagEnd + 1);
      }

      var closeTag = svgString.indexOf('</text>', tagEnd);
      searchStart = closeTag !== -1 ? closeTag + 7 : tagEnd + 1;
      count++;
    }
    return svgString;
  },

  /**
   * Parse a CSS/SVG transform matrix string into components.
   * @param {string} transformStr
   * @returns {Object|null}
   */
  parseMatrix(transformStr) {
    const match = transformStr.match(/matrix\(\s*([^)]+)\)/);
    if (!match) return null;
    const values = match[1].trim().split(/[\s,]+/).map(Number);
    if (values.length < 6) return null;
    return {
      scaleX: values[0], skewY: values[1], skewX: values[2],
      scaleY: values[3], translateX: values[4], translateY: values[5]
    };
  },

  // Cache for detected image dominant color (keyed by image data prefix)
  _imageDominantColorCache: {},

  /**
   * Detect the dominant non-white, non-transparent color in a raster image.
   * Samples center region of the image for speed.
   * @param {string} svgString - SVG string containing base64 <image>
   * @returns {Promise<string|null>} hex color like '#FF0000' or null
   */
  async _detectImageDominantColor(svgString) {
    var imgMatch = svgString.match(/xlink:href=["'](data:image\/[^;]+;base64,([^"']+))["']/i);
    if (!imgMatch) return null;

    var cacheKey = imgMatch[2].substring(0, 100);
    if (this._imageDominantColorCache[cacheKey]) {
      return this._imageDominantColorCache[cacheKey];
    }

    var self = this;
    var dataUri = imgMatch[1];
    return new Promise(function(resolve) {
      var img = new Image();
      img.onload = function() {
        try {
          var scanSize = 200;
          var canvas = document.createElement('canvas');
          canvas.width = scanSize;
          canvas.height = scanSize;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, scanSize, scanSize);

          var pixels = ctx.getImageData(0, 0, scanSize, scanSize).data;
          var colorCounts = {};

          for (var i = 0; i < pixels.length; i += 4) {
            var r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
            // Skip transparent and near-white pixels
            if (a < 128) continue;
            if (r > 240 && g > 240 && b > 240) continue;
            // Skip near-black pixels
            if (r < 15 && g < 15 && b < 15) continue;
            // Quantize to reduce noise (round to nearest 8)
            var qr = (r >> 3) << 3;
            var qg = (g >> 3) << 3;
            var qb = (b >> 3) << 3;
            var key = qr + ',' + qg + ',' + qb;
            colorCounts[key] = (colorCounts[key] || 0) + 1;
          }

          // Find most common color
          var bestKey = null, bestCount = 0;
          for (var k in colorCounts) {
            if (colorCounts[k] > bestCount) {
              bestCount = colorCounts[k];
              bestKey = k;
            }
          }

          if (bestKey) {
            var parts = bestKey.split(',');
            var hex = '#' +
              parseInt(parts[0]).toString(16).padStart(2, '0') +
              parseInt(parts[1]).toString(16).padStart(2, '0') +
              parseInt(parts[2]).toString(16).padStart(2, '0');
            hex = hex.toUpperCase();
            console.log('Image dominant color detected:', hex, '(count=' + bestCount + ')');
            self._imageDominantColorCache[cacheKey] = hex;
            resolve(hex);
          } else {
            resolve(null);
          }
        } catch (e) {
          console.warn('Image color detection failed:', e);
          resolve(null);
        }
      };
      img.onerror = function() { resolve(null); };
      img.src = dataUri;
    });
  },

  // Cache for detected artwork bounds (keyed by image data prefix)
  _artworkBoundsCache: {},

  /**
   * Detect the actual artwork bounding box in a Category 2 template's background image.
   * Decodes the embedded base64 image, draws to offscreen canvas, scans for non-white pixels.
   * @param {string} svgString
   * @returns {Promise<{cropX: number, cropY: number, cropW: number, cropH: number}|null>}
   */
  async _detectArtworkBounds(svgString) {
    // Extract base64 image data
    var imgMatch = svgString.match(/xlink:href=["'](data:image\/[^;]+;base64,([^"']+))["']/i);
    if (!imgMatch) return null;

    // Cache key: first 100 chars of base64 data (unique per template image)
    var cacheKey = imgMatch[2].substring(0, 100);
    if (this._artworkBoundsCache[cacheKey]) {
      return this._artworkBoundsCache[cacheKey];
    }

    // Get image dimensions from SVG attributes
    var imgWidthMatch = svgString.match(/<image[^>]*\swidth=["']([\d.]+)["']/i);
    var imgHeightMatch = svgString.match(/<image[^>]*\sheight=["']([\d.]+)["']/i);
    if (!imgWidthMatch || !imgHeightMatch) return null;
    var svgImgW = parseFloat(imgWidthMatch[1]);
    var svgImgH = parseFloat(imgHeightMatch[1]);

    var self = this;
    return new Promise(function(resolve) {
      var img = new Image();
      img.onload = function() {
        try {
          // Scale down for fast scanning
          var scanSize = 400;
          var canvas = document.createElement('canvas');
          canvas.width = scanSize;
          canvas.height = scanSize;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, scanSize, scanSize);

          var imageData = ctx.getImageData(0, 0, scanSize, scanSize);
          var pixels = imageData.data;

          // Scan for non-white pixel bounds (white threshold: RGB all > 248)
          var threshold = 248;
          var minX = scanSize, minY = scanSize, maxX = 0, maxY = 0;

          for (var y = 0; y < scanSize; y++) {
            for (var x = 0; x < scanSize; x++) {
              var idx = (y * scanSize + x) * 4;
              var r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
              if (r < threshold || g < threshold || b < threshold) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
          }

          if (maxX <= minX || maxY <= minY) {
            resolve(null);
            return;
          }

          // Scale from scan coordinates back to SVG coordinates
          var scaleX = svgImgW / scanSize;
          var scaleY = svgImgH / scanSize;

          // Negative padding — crop slightly into bounds to maximize display size
          var padX = (maxX - minX) * -0.03;
          var padY = (maxY - minY) * -0.03;

          var bounds = {
            cropX: Math.max(0, (minX - padX) * scaleX),
            cropY: Math.max(0, (minY - padY) * scaleY),
            cropW: Math.min(svgImgW, (maxX - minX + 2 * padX) * scaleX),
            cropH: Math.min(svgImgH, (maxY - minY + 2 * padY) * scaleY)
          };

          console.log('ArtworkBounds: detected (' + bounds.cropX.toFixed(0) + ',' + bounds.cropY.toFixed(0) +
            ') ' + bounds.cropW.toFixed(0) + 'x' + bounds.cropH.toFixed(0) +
            ' (from ' + svgImgW + 'x' + svgImgH + ')');

          self._artworkBoundsCache[cacheKey] = bounds;
          resolve(bounds);
        } catch (e) {
          console.warn('ArtworkBounds detection failed:', e);
          resolve(null);
        }
      };
      img.onerror = function() {
        resolve(null);
      };
      img.src = imgMatch[1];
    });
  },

  /**
   * Crop the viewBox of a Fixed Frame (Category 2) SVG to tightly fit the artwork.
   * Uses canvas-based pixel detection to find actual artwork bounds.
   * This should be called BEFORE applyTilt so the rotation is based on tighter bounds.
   * @param {string} svgString
   * @returns {Promise<string>}
   */
  async cropViewBoxFixedFrame(svgString) {
    // Only apply to Category 2 templates (has <image> element)
    if (!/<image[\s>]/i.test(svgString)) return svgString;

    // Parse original viewBox
    var vbMatch = svgString.match(/viewBox=["']\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*["']/);
    if (!vbMatch) return svgString;
    var origW = parseFloat(vbMatch[3]);
    var origH = parseFloat(vbMatch[4]);

    // Try canvas-based artwork detection
    var bounds = await this._detectArtworkBounds(svgString);

    var cropX, cropY, cropW, cropH;
    if (bounds) {
      cropX = bounds.cropX;
      cropY = bounds.cropY;
      cropW = bounds.cropW;
      cropH = bounds.cropH;
    } else {
      // Fallback: 10% crop from each edge
      var cropPercent = 0.10;
      cropX = origW * cropPercent;
      cropY = origH * cropPercent;
      cropW = origW * (1 - 2 * cropPercent);
      cropH = origH * (1 - 2 * cropPercent);
    }

    console.log('CropViewBox: crop to (' + cropX.toFixed(0) + ',' + cropY.toFixed(0) + ',' + cropW.toFixed(0) + ',' + cropH.toFixed(0) + ')');

    // Update viewBox
    var newViewBox = cropX.toFixed(2) + ' ' + cropY.toFixed(2) + ' ' + cropW.toFixed(2) + ' ' + cropH.toFixed(2);
    return svgString.replace(/viewBox=["'][^"']*["']/, 'viewBox="' + newViewBox + '"');
  },

  /**
   * Apply tilt rotation inside the SVG itself.
   * Wraps all SVG children in a rotated <g> group and adjusts the viewBox
   * so the rotated content fits naturally (card grows taller).
   * @param {string} svgString - cleaned SVG string
   * @param {number} angleDeg - rotation angle in degrees (negative = counter-clockwise)
   * @returns {string} - tilted SVG string with adjusted viewBox
   */
  applyTilt(svgString, angleDeg) {
    if (!angleDeg || angleDeg === 0) return svgString;

    // Parse viewBox
    var vbMatch = svgString.match(/viewBox=["']\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*["']/);
    if (!vbMatch) return svgString; // can't tilt without a viewBox

    var vbX = parseFloat(vbMatch[1]);
    var vbY = parseFloat(vbMatch[2]);
    var vbW = parseFloat(vbMatch[3]);
    var vbH = parseFloat(vbMatch[4]);

    // Center of rotation
    var cx = vbX + vbW / 2;
    var cy = vbY + vbH / 2;

    // Calculate new bounding box after rotation
    var rad = Math.abs(angleDeg) * Math.PI / 180;
    var cosA = Math.cos(rad);
    var sinA = Math.sin(rad);
    var newW = vbW * cosA + vbH * sinA;
    var newH = vbW * sinA + vbH * cosA;

    // Shrink post-rotation viewBox to make tilted stamps appear larger.
    // Only for Category 2 (background image): clipping background edges is acceptable.
    // Category 1 (frame-based): no shrink — frame borders are the content, can't clip them.
    var isFixedFrame = svgString.indexOf('<image') !== -1;
    if (isFixedFrame) {
      var aspect = Math.max(vbW, vbH) / Math.min(vbW, vbH);
      var shrink = Math.min(1.0, 0.80 + (aspect - 1) * 0.13);
      newW *= shrink;
      newH *= shrink;
    }

    // New viewBox centered on the same center point
    var newVbX = cx - newW / 2;
    var newVbY = cy - newH / 2;
    var newViewBox = newVbX.toFixed(2) + ' ' + newVbY.toFixed(2) + ' ' + newW.toFixed(2) + ' ' + newH.toFixed(2);

    // Replace viewBox
    var result = svgString.replace(/viewBox=["'][^"']*["']/, 'viewBox="' + newViewBox + '"');

    // Wrap all children of <svg> in a <g transform="rotate(...)">
    // Find the end of the opening <svg> tag
    var svgTagEnd = result.indexOf('>', result.indexOf('<svg'));
    if (svgTagEnd === -1) return svgString;

    // Find the closing </svg> tag
    var svgCloseIdx = result.lastIndexOf('</svg>');
    if (svgCloseIdx === -1) return svgString;

    var before = result.substring(0, svgTagEnd + 1);
    var content = result.substring(svgTagEnd + 1, svgCloseIdx);
    var after = result.substring(svgCloseIdx);

    return before +
      '<g transform="rotate(' + angleDeg + ' ' + cx.toFixed(2) + ' ' + cy.toFixed(2) + ')">' +
      content +
      '</g>' +
      after;
  },

  /**
   * Create an element to display SVG inline in the page DOM.
   * Since the parent page loads Google Fonts, inline SVG can use them directly.
   * No iframe needed (we stripped Adobe's broken embedded fonts already).
   * @param {string} svgString
   * @returns {HTMLDivElement}
   */
  createSvgImage(svgString) {
    var wrapper = document.createElement('div');
    wrapper.style.width = '100%';
    wrapper.style.height = '100%';
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.justifyContent = 'center';
    wrapper.style.lineHeight = '0';
    wrapper.innerHTML = svgString;

    // Make the inline SVG responsive and contained within parent
    var svgEl = wrapper.querySelector('svg');
    if (svgEl) {
      svgEl.removeAttribute('width');
      svgEl.removeAttribute('height');
      // Let CSS handle sizing via max-width/max-height
    }
    return wrapper;
  },

  /**
   * Render SVG string to PNG Blob.
   * Uses a hidden iframe with Google Fonts loaded, waits for fonts,
   * then uses html2canvas-style rendering via foreignObject or
   * falls back to canvas drawImage.
   * @param {string} svgString
   * @param {number} width
   * @param {number} height
   * @param {number} [scale=2]
   * @returns {Promise<Blob>}
   */
  /**
   * Remove white/near-white background rects from SVG for transparent export.
   * Targets rects that span most of the viewBox and have white-ish fill.
   */
  stripSvgBackground(svgString) {
    // Parse viewBox to know the SVG dimensions
    var vbMatch = svgString.match(/viewBox=["']([^"']+)["']/);
    var svgW = 1000, svgH = 1000;
    if (vbMatch) {
      var parts = vbMatch[1].trim().split(/[\s,]+/);
      svgW = parseFloat(parts[2]) || 1000;
      svgH = parseFloat(parts[3]) || 1000;
    }

    // White-ish colors to consider as background
    var whiteFills = ['#ffffff', '#fff', 'white', '#fefefe', '#fdfdfd', '#fcfcfc', '#fbfbfb', '#fafafa', '#f9f9f9', '#f8f8f8'];

    // Find all rect elements and remove ones that look like backgrounds
    var result = svgString.replace(/<rect\b([^>]*)\/?>/gi, function(fullMatch, attrs) {
      // Extract fill
      var fillMatch = attrs.match(/fill=["']([^"']+)["']/i);
      if (!fillMatch) return fullMatch; // no fill, keep it

      var fill = fillMatch[1].trim().toLowerCase();
      if (whiteFills.indexOf(fill) === -1) return fullMatch; // not white, keep it

      // Extract dimensions
      var w = parseFloat((attrs.match(/width=["']([^"']+)["']/i) || [])[1]) || 0;
      var h = parseFloat((attrs.match(/height=["']([^"']+)["']/i) || [])[1]) || 0;

      // If rect covers at least 80% of the viewBox in both dimensions, it's a background
      if (w >= svgW * 0.8 && h >= svgH * 0.8) {
        return ''; // strip it
      }

      return fullMatch; // keep smaller rects
    });

    // Also handle style="fill:white" or style="fill:#ffffff" on rects
    result = result.replace(/<rect\b([^>]*style=["'][^"']*fill:\s*(white|#fff(?:fff)?)\b[^"']*["'][^>]*)\/?>/gi, function(fullMatch, attrs) {
      var w = parseFloat((attrs.match(/width=["']([^"']+)["']/i) || [])[1]) || 0;
      var h = parseFloat((attrs.match(/height=["']([^"']+)["']/i) || [])[1]) || 0;
      if (w >= svgW * 0.8 && h >= svgH * 0.8) {
        return '';
      }
      return fullMatch;
    });

    return result;
  },

  exportImage(svgString, maxSize, _unused, scale, format) {
    scale = scale || 2;
    format = format || 'png';

    // For transparent PNG: strip white background rects from SVG
    if (format === 'png') {
      svgString = SvgRenderer.stripSvgBackground(svgString);
    }

    // Auto-detect aspect ratio from SVG viewBox
    var width = maxSize, height = maxSize;
    var vbMatch = svgString.match(/viewBox=["']([^"']+)["']/);
    if (vbMatch) {
      var parts = vbMatch[1].trim().split(/[\s,]+/);
      var vbW = parseFloat(parts[2]) || maxSize;
      var vbH = parseFloat(parts[3]) || maxSize;
      var aspect = vbW / vbH;
      if (aspect >= 1) {
        width = maxSize;
        height = Math.round(maxSize / aspect);
      } else {
        height = maxSize;
        width = Math.round(maxSize * aspect);
      }
    }

    // Compute full pixel dimensions (base * scale)
    var fullW = width * scale;
    var fullH = height * scale;

    // Strip explicit width/height from SVG and set to full pixel size
    svgString = svgString.replace(/<svg([^>]*)>/, function(match, attrs) {
      attrs = attrs.replace(/\s+width=["'][^"']*["']/gi, '');
      attrs = attrs.replace(/\s+height=["'][^"']*["']/gi, '');
      return '<svg' + attrs + ' width="' + fullW + '" height="' + fullH + '">';
    });

    return new Promise(function (resolve, reject) {
      var iframe = document.createElement('iframe');
      iframe.style.position = 'absolute';
      iframe.style.left = '-9999px';
      iframe.style.top = '-9999px';
      iframe.style.width = fullW + 'px';
      iframe.style.height = fullH + 'px';
      iframe.style.visibility = 'hidden';
      document.body.appendChild(iframe);

      var htmlDoc = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
        '<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@200;300;400;500;600;700&display=swap" rel="stylesheet">' +
        '<style>' +
        '@font-face{font-family:"Oswald";src:url("/fonts/Oswald-Medium.ttf") format("truetype");font-weight:500;}' +
        '@font-face{font-family:"Montserrat";src:url("/fonts/Montserrat-Black.ttf") format("truetype");font-weight:900;}' +
        '@font-face{font-family:"Nunito";src:url("/fonts/Nunito-Black.ttf") format("truetype");font-weight:900;}' +
        '@font-face{font-family:"RobotoBlack";src:url("/fonts/Roboto-Black.ttf") format("truetype");font-weight:900;}' +
        '@font-face{font-family:"PlayfairDisplay";src:url("/fonts/PlayfairDisplay-Bold.ttf") format("truetype");font-weight:700;}' +
        '@font-face{font-family:"Merriweather";src:url("/fonts/Merriweather-Black.ttf") format("truetype");font-weight:900;}' +
        '@font-face{font-family:"Bitter";src:url("/fonts/Bitter-Bold.ttf") format("truetype");font-weight:700;}' +
        '@font-face{font-family:"Exo2";src:url("/fonts/Exo2-Black.ttf") format("truetype");font-weight:900;}' +
        '@font-face{font-family:"Comfortaa";src:url("/fonts/Comfortaa-Bold.ttf") format("truetype");font-weight:700;}' +
        '@font-face{font-family:"Raleway";src:url("/fonts/Raleway-Black.ttf") format("truetype");font-weight:900;}' +
        '*{margin:0;padding:0;}body{overflow:hidden;width:' + fullW + 'px;height:' + fullH + 'px;}' +
        '</style>' +
        '</head><body>' + svgString + '</body></html>';

      var blob = new Blob([htmlDoc], { type: 'text/html;charset=utf-8' });
      var blobUrl = URL.createObjectURL(blob);

      iframe.onload = function () {
        var iframeDoc = iframe.contentDocument || iframe.contentWindow.document;

        async function doCapture() {
          try {
            var svgEl = iframeDoc.querySelector('svg');
            if (!svgEl) {
              cleanup();
              reject(new Error('No SVG found in iframe'));
              return;
            }

            var serializer = new XMLSerializer();
            var svgData = serializer.serializeToString(svgEl);

            // Embed fonts as base64 @font-face so the standalone SVG blob renders them
            svgData = await SvgRenderer._embedFontsInSvg(svgData);

            var canvas = document.createElement('canvas');
            canvas.width = fullW;
            canvas.height = fullH;
            var ctx = canvas.getContext('2d');

            // For JPEG: fill white background (JPEG has no transparency)
            if (format === 'jpeg') {
              ctx.fillStyle = '#FFFFFF';
              ctx.fillRect(0, 0, fullW, fullH);
            }

            var svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
            var svgObjUrl = URL.createObjectURL(svgBlob);

            if (format === 'png') {
              // Two-pass alpha recovery: render on white then black, reconstruct true alpha
              var imgW = new Image();
              var imgB = new Image();
              var loaded = 0;

              function onBothLoaded() {
                // Render on white
                var cW = document.createElement('canvas');
                cW.width = fullW; cW.height = fullH;
                var ctxW = cW.getContext('2d');
                ctxW.fillStyle = '#FFFFFF';
                ctxW.fillRect(0, 0, fullW, fullH);
                ctxW.drawImage(imgW, 0, 0, fullW, fullH);
                var dataW = ctxW.getImageData(0, 0, fullW, fullH).data;

                // Render on black
                var cB = document.createElement('canvas');
                cB.width = fullW; cB.height = fullH;
                var ctxB = cB.getContext('2d');
                ctxB.fillStyle = '#000000';
                ctxB.fillRect(0, 0, fullW, fullH);
                ctxB.drawImage(imgB, 0, 0, fullW, fullH);
                var dataB = ctxB.getImageData(0, 0, fullW, fullH).data;

                // Reconstruct true alpha and color
                var out = ctx.createImageData(fullW, fullH);
                var d = out.data;
                for (var p = 0; p < d.length; p += 4) {
                  var rw = dataW[p], gw = dataW[p+1], bw = dataW[p+2];
                  var rb = dataB[p], gb = dataB[p+1], bb = dataB[p+2];
                  // a = 1 - (white - black) / 255
                  var a = Math.round((
                    (255 - (rw - rb)) +
                    (255 - (gw - gb)) +
                    (255 - (bw - bb))
                  ) / 3);
                  if (a <= 0) {
                    d[p] = d[p+1] = d[p+2] = d[p+3] = 0;
                  } else {
                    if (a > 255) a = 255;
                    d[p]   = Math.min(255, Math.round(rb * 255 / a));
                    d[p+1] = Math.min(255, Math.round(gb * 255 / a));
                    d[p+2] = Math.min(255, Math.round(bb * 255 / a));
                    d[p+3] = a;
                  }
                }

                // Clean up opaque white pixels (background, raster white areas)
                // Only targets fully opaque pixels — semi-transparent shadows from
                // two-pass recovery (alpha < 254) are left untouched
                for (var p = 0; p < d.length; p += 4) {
                  if (d[p+3] < 254) continue; // skip semi-transparent (shadows etc.)
                  var minCh = Math.min(d[p], d[p+1], d[p+2]);
                  if (minCh >= 253) {
                    d[p+3] = 0; // pure white: fully transparent
                  } else if (minCh >= 248) {
                    // narrow anti-alias gradient for smooth edges
                    var t = (minCh - 248) / (253 - 248);
                    d[p+3] = Math.round(255 * (1 - t));
                  }
                }

                ctx.putImageData(out, 0, 0);
                URL.revokeObjectURL(svgObjUrl);

                canvas.toBlob(function (resultBlob) {
                  cleanup();
                  if (resultBlob) resolve(resultBlob);
                  else reject(new Error('Canvas toBlob failed'));
                }, 'image/png');
              }

              function onLoad() {
                loaded++;
                if (loaded === 2) onBothLoaded();
              }
              imgW.onload = onLoad;
              imgB.onload = onLoad;
              imgW.onerror = imgB.onerror = function () {
                cleanup();
                reject(new Error('Failed to render SVG to image'));
              };
              imgW.src = svgObjUrl;
              imgB.src = svgObjUrl;
            } else {
              // JPEG: single render on white
              var img = new Image();
              img.onload = function () {
                ctx.drawImage(img, 0, 0, fullW, fullH);
                URL.revokeObjectURL(svgObjUrl);
                canvas.toBlob(function (resultBlob) {
                  cleanup();
                  if (resultBlob) resolve(resultBlob);
                  else reject(new Error('Canvas toBlob failed'));
                }, 'image/jpeg', 0.92);
              };
              img.onerror = function () {
                cleanup();
                reject(new Error('Failed to render SVG to image'));
              };
              img.src = svgObjUrl;
            }
          } catch (e) {
            cleanup();
            reject(e);
          }
        }

        function cleanup() {
          document.body.removeChild(iframe);
          URL.revokeObjectURL(blobUrl);
        }

        if (iframe.contentDocument && iframe.contentDocument.fonts) {
          iframe.contentDocument.fonts.ready.then(function () {
            setTimeout(doCapture, 100);
          }).catch(function () {
            setTimeout(doCapture, 500);
          });
        } else {
          setTimeout(doCapture, 1000);
        }
      };

      iframe.src = blobUrl;
    });
  },

  exportPng(svgString, width, height, scale) {
    return this.exportImage(svgString, width, height, scale || 2, 'png');
  },

  // ---- Texture support ----

  /**
   * Cache for loaded texture SVG content (keyed by textureId).
   * @private
   */
  _textureCache: {},

  /**
   * Apply a grungy texture overlay on top of an SVG stamp.
   * Fetches the texture SVG, extracts its path/polygon elements,
   * scales them to fit the stamp's viewBox, and injects them
   * as white paths on top of the stamp content.
   * @param {string} svgString - the stamp SVG string
   * @param {string} textureId - texture identifier (e.g. 'grungy_texture_1')
   * @returns {Promise<string>} - SVG string with texture overlay
   */
  /**
   * Map of texture group IDs to their individual texture file IDs.
   * When a group is selected, one variant is picked at random.
   */
  _textureGroups: {
    'grungy_texture': ['grungy_texture_2', 'grungy_texture_3_light']
  },

  async applyTexture(svgString, textureId) {
    if (!textureId) return svgString;

    // If textureId is a group, randomly pick one of its variants
    if (this._textureGroups[textureId]) {
      var variants = this._textureGroups[textureId];
      textureId = variants[Math.floor(Math.random() * variants.length)];
    }

    // Fetch and cache texture content
    if (!this._textureCache[textureId]) {
      var textureUrl = '/textures/' + textureId + '.svg';
      var textureSvg = await this.fetchSvg(textureUrl);

      // Extract only path and polygon elements from the texture group
      // (skip the background rect)
      var paths = [];
      var pathRegex = /<(path|polygon)\s[^>]*?\/>/gi;
      var match;
      while ((match = pathRegex.exec(textureSvg)) !== null) {
        paths.push(match[0]);
      }

      this._textureCache[textureId] = {
        paths: paths.join('\n'),
        // Texture original dimensions (1441.201 x 1441.201)
        width: 1441.201,
        height: 1441.201
      };
    }

    var texture = this._textureCache[textureId];
    if (!texture.paths) return svgString;

    // Parse the stamp's viewBox to know how to scale the texture
    var vbMatch = svgString.match(/viewBox=["']\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*["']/);
    if (!vbMatch) return svgString;

    var vbX = parseFloat(vbMatch[1]);
    var vbY = parseFloat(vbMatch[2]);
    var vbW = parseFloat(vbMatch[3]);
    var vbH = parseFloat(vbMatch[4]);

    // Scale texture to fit the stamp viewBox, oversized by √2 so rotation
    // never leaves uncovered edges (worst case at 45° needs 1.414x)
    var oversize = 1.42;
    var scaleX = (vbW * oversize) / texture.width;
    var scaleY = (vbH * oversize) / texture.height;
    // Offset to keep the oversized texture centered on the stamp
    var offsetX = vbX - (vbW * (oversize - 1) / 2);
    var offsetY = vbY - (vbH * (oversize - 1) / 2);

    // Random rotation (1–359 degrees) so each textured stamp looks unique
    var texRotation = Math.floor(Math.random() * 359) + 1;
    var texCx = (texture.width / 2).toFixed(4);
    var texCy = (texture.height / 2).toFixed(4);

    // Build a group that scales and positions the texture over the stamp,
    // with a random rotation applied to the texture paths inside
    var textureGroup = '<g transform="translate(' + offsetX.toFixed(4) + ',' + offsetY.toFixed(4) + ') scale(' + scaleX.toFixed(6) + ',' + scaleY.toFixed(6) + ')">' +
      '<g transform="rotate(' + texRotation + ' ' + texCx + ' ' + texCy + ')">' +
      texture.paths +
      '</g></g>';

    // Inject before </svg>
    var svgCloseIdx = svgString.lastIndexOf('</svg>');
    if (svgCloseIdx === -1) return svgString;

    return svgString.substring(0, svgCloseIdx) + textureGroup + svgString.substring(svgCloseIdx);
  },

  /**
   * Trigger a file download in the browser.
   * @param {Blob} blob
   * @param {string} filename
   */
  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /**
   * Detect border type from SVG data attributes on the outer rect.
   * Returns an object with: wavy, border, stitch, brush, filter, origFill, origStroke, origStrokeWidth.
   * Note: autoFit strips data-* attributes, so callers should supplement from DB fields.
   */
  detectBorderType(svgStr) {
    var rects = [];
    var re = /<rect([^>]*)\/?>/gi;
    var m;
    while ((m = re.exec(svgStr)) !== null) {
      var attrs = m[1];
      if (/fill=["'](?:#FFF(?:FFF)?|white)["']/i.test(attrs)) {
        var hasColoredStroke = /stroke=["'](?!none|#FFF|#FFFFFF|white)#?[A-Fa-f0-9]+["']/i.test(attrs);
        if (!hasColoredStroke) continue;
      }
      var wM = attrs.match(/\swidth=["']([\d.]+)["']/);
      if (!wM) continue;
      rects.push({ attrs: attrs, w: parseFloat(wM[1]) });
    }
    rects.sort(function(a, b) { return b.w - a.w; });
    var origFill = null, origStroke = null, origStrokeWidth = null;
    if (rects.length > 0) {
      var outerAttrs = rects[0].attrs;
      var fM = outerAttrs.match(/\bfill=["']([^"']+)["']/);
      var sM = outerAttrs.match(/\bstroke=["']([^"']+)["']/);
      var swM = outerAttrs.match(/stroke-width=["']([\d.]+)["']/);
      origFill = fM ? fM[1] : null;
      origStroke = sM ? sM[1] : null;
      origStrokeWidth = swM ? parseFloat(swM[1]) : null;
    }
    var wavyM = svgStr.match(/data-wavy=["']([^"']+)["']/);
    var borderM = svgStr.match(/data-border=["']([^"']+)["']/);
    var stitchM = svgStr.match(/data-stitch=["']([^"']+)["']/);
    var brushM = svgStr.match(/data-brush-border=["']([^"']+)["']/);
    var filterM = svgStr.match(/data-filter=["']([^"']+)["']/);
    var brushCoords = null, brushContent = null;
    if (brushM) {
      brushCoords = brushM[1].split(',').map(Number);
      var bgM = svgStr.match(/<g[^>]*data-brush-border=["'][^"']*["'][^>]*>([\s\S]*?)<\/g>/);
      if (bgM) brushContent = bgM[1].trim();
    }
    return {
      wavy: wavyM ? wavyM[1] : null,
      border: borderM ? borderM[1] : null,
      stitch: stitchM ? stitchM[1] : null,
      brush: !!brushM,
      brushCoords: brushCoords,
      brushContent: brushContent,
      filter: filterM ? filterM[1] : null,
      origFill: origFill,
      origStroke: origStroke,
      origStrokeWidth: origStrokeWidth
    };
  },

  /**
   * Supplement border info from DB fields (autoFit strips data-* attributes).
   * Mutates bi in place and returns it.
   */
  supplementBorderInfo(bi, tpl) {
    if (!bi.stitch && tpl.border_type && tpl.border_type.indexOf('stitch_') === 0) {
      bi.stitch = tpl.border_type.replace('stitch_', '');
    }
    if (!bi.border && tpl.border_type === 'perforated_spaced') bi.border = 'circle-10';
    if (!bi.border && tpl.border_type === 'perforated') bi.border = 'circle-8-2';
    if (!bi.border && tpl.border_type === 'zigzag') bi.border = 'diamond-20';
    if (!bi.filter && tpl.border_type === 'torn_edge') bi.filter = 'ripped-20';
    if (!bi.wavy && tpl.border_type === 'wavy') bi.wavy = 'gentle';
    bi.fillType = tpl.fill_type || null;
    return bi;
  },

  /**
   * Override rx/ry on the main border rect based on corner_type.
   * Gives programmatic control over corner radius independent of SVG template values.
   */
  applyCornerRadius(svgStr, cornerType) {
    if (!cornerType || cornerType === 'straight') return svgStr;
    // Must account for both stroke inner edge (rx - osw/2) AND double frame offset path (rx - inset).
    // With osw=50, inset≈43: soft inner_rect_rx=70-43=27, medium=100-43=57, strong=160-43=117
    var CORNER_RX = { soft_round: 70, medium_round: 100, strong_round: 160 };
    var targetRx = CORNER_RX[cornerType];
    if (!targetRx) return svgStr;
    // Find the main border rect (largest by width, skip white background rects)
    var rects = [];
    var re = /<rect([^>]*)\/?>/gi;
    var m;
    while ((m = re.exec(svgStr)) !== null) {
      var attrs = m[1];
      if (/fill=["'](?:#FFF(?:FFF)?|white)["']/i.test(attrs)) {
        var hasColoredStroke = /stroke=["'](?!none|#FFF|#FFFFFF|white)#?[A-Fa-f0-9]+["']/i.test(attrs);
        if (!hasColoredStroke) continue;
      }
      var wM = attrs.match(/\swidth=["']([\d.]+)["']/);
      if (!wM) continue;
      rects.push({ full: m[0], attrs: attrs, w: parseFloat(wM[1]), index: m.index });
    }
    if (rects.length === 0) return svgStr;
    rects.sort(function(a, b) { return b.w - a.w; });
    var outer = rects[0];
    // Replace or add rx/ry on the outer rect
    var newAttrs = outer.full;
    if (/\brx=["'][\d.]+["']/.test(newAttrs)) {
      newAttrs = newAttrs.replace(/\brx=["'][\d.]+["']/, 'rx="' + targetRx + '"');
    } else {
      newAttrs = newAttrs.replace(/<rect /, '<rect rx="' + targetRx + '" ');
    }
    if (/\bry=["'][\d.]+["']/.test(newAttrs)) {
      newAttrs = newAttrs.replace(/\bry=["'][\d.]+["']/, 'ry="' + targetRx + '"');
    } else {
      newAttrs = newAttrs.replace(/<rect /, '<rect ry="' + targetRx + '" ');
    }
    return svgStr.slice(0, outer.index) + newAttrs + svgStr.slice(outer.index + outer.full.length);
  },

  /**
   * Add regular double frame: a plain inner rect (or wavy path) inside the border.
   * For full fills, inner color is contrast (white/black). For empty, inner color matches stroke.
   * Skips Cat 2 (image) templates unless they have a Cat1-style border.
   */
  addDoubleFrame(svgStr, bi, appliedColor) {
    bi = bi || {};
    var isCat1Border = bi.wavy || bi.brush || bi.stitch || bi.border || bi.filter;
    if (!isCat1Border && /<image[\s>]/i.test(svgStr)) return svgStr;
    var rects = [];
    var re = /<rect([^>]*)\/?>/gi;
    var m;
    while ((m = re.exec(svgStr)) !== null) {
      var attrs = m[1];
      if (/fill=["'](?:#FFF(?:FFF)?|white)["']/i.test(attrs)) {
        var hasColoredStroke = /stroke=["'](?!none|#FFF|#FFFFFF|white)#?[A-Fa-f0-9]+["']/i.test(attrs);
        if (!hasColoredStroke) continue;
      }
      if (/display=["']none["']/i.test(attrs)) continue;
      var wM = attrs.match(/\swidth=["']([\d.]+)["']/);
      var hM = attrs.match(/\sheight=["']([\d.]+)["']/);
      if (!wM || !hM) continue;
      rects.push({ full: m[0], attrs: attrs, w: parseFloat(wM[1]), h: parseFloat(hM[1]), index: m.index });
    }
    if (rects.length === 0) return svgStr;
    rects.sort(function(a, b) { return b.w - a.w; });
    var outer = rects[0];
    if (rects.length > 1 && rects[1].w > outer.w * 0.9) {
      var second = rects[1];
      if (/fill=["']none["']/i.test(second.attrs) && /stroke=["']#(?:FFF(?:FFF)?|FFFFFF)["']/i.test(second.attrs)) {
        return svgStr;
      }
    }
    var xM = outer.attrs.match(/\bx=["']([\d.\-]+)["']/);
    var yM = outer.attrs.match(/\by=["']([\d.\-]+)["']/);
    var swM = outer.attrs.match(/stroke-width=["']([\d.]+)["']/);
    var rxM = outer.attrs.match(/\brx=["']([\d.]+)["']/);
    var ryM = outer.attrs.match(/\bry=["']([\d.]+)["']/);
    var ox = xM ? parseFloat(xM[1]) : 0;
    var oy = yM ? parseFloat(yM[1]) : 0;
    var ow = outer.w, oh = outer.h;
    var osw = swM ? parseFloat(swM[1]) : (bi.origStrokeWidth || 20);
    if (osw === 0 && bi.origStrokeWidth) osw = bi.origStrokeWidth;
    var orx = rxM ? parseFloat(rxM[1]) : 0;
    var ory = ryM ? parseFloat(ryM[1]) : 0;
    var fillM2 = outer.attrs.match(/\bfill=["']([^"']+)["']/);
    var outerFill = fillM2 ? fillM2[1] : 'none';
    var strokeM2 = outer.attrs.match(/\bstroke=["']([^"']+)["']/);
    var outerStroke = strokeM2 ? strokeM2[1] : '#000000';
    if (outerFill === 'none' && bi.wavy && bi.origFill && bi.origFill !== 'none') outerFill = bi.origFill;
    if ((!strokeM2 || outerStroke === 'none') && bi.origStroke) outerStroke = bi.origStroke;
    var isFull = outerFill !== 'none' && !/^#(?:FFF(?:FFF)?|FFFFFF)$/i.test(outerFill);
    if (!isFull && bi.fillType === 'full') isFull = true;
    var innerColor;
    if (isFull) {
      var colorHex = (appliedColor || outerFill || '#000000').replace('#', '');
      if (colorHex.length === 3) colorHex = colorHex[0]+colorHex[0]+colorHex[1]+colorHex[1]+colorHex[2]+colorHex[2];
      var r2 = parseInt(colorHex.substring(0, 2), 16);
      var g2 = parseInt(colorHex.substring(2, 4), 16);
      var b2 = parseInt(colorHex.substring(4, 6), 16);
      var lum = 0.299 * r2 + 0.587 * g2 + 0.114 * b2;
      innerColor = lum > 160 ? '#000000' : '#FFFFFF';
    } else {
      innerColor = appliedColor || outerStroke;
      if (!innerColor || innerColor === 'none' || /^#(?:FFF(?:FFF)?|FFFFFF)$/i.test(innerColor)) {
        innerColor = outerStroke && outerStroke !== 'none' ? outerStroke : '#000000';
      }
    }
    // Read wavy path stroke-width for inset calculation
    var wavySw = 0;
    if (bi.wavy) {
      var wavyPathM = svgStr.match(/<path[^>]*stroke-linejoin="round"[^>]*>/i);
      if (wavyPathM) {
        var wswM = wavyPathM[0].match(/stroke-width="([\d.]+)"/);
        if (wswM) wavySw = parseFloat(wswM[1]);
      }
    }
    var innerSw = Math.max(4, Math.round(osw * 0.24));
    if (bi.brush) innerSw = Math.max(6, Math.round(osw * 0.5));
    if (bi.stitch && isFull) innerSw = Math.max(6, Math.round(osw * 0.5));
    if (bi.stitch && !isFull) innerSw = Math.max(6, Math.round(osw * 0.7));
    var inset;
    if (!bi.stitch && isFull) {
      // Filled (all families except stitch): inner rect flush against outer stroke's inner edge
      inset = osw / 2 + innerSw / 2;
    } else {
      inset = osw / 2 + innerSw * 1.5;
    }
    if (bi.stitch) inset = osw + innerSw;
    if (bi.brush) inset = Math.max(inset, Math.min(ow, oh) * 0.12);
    if (bi.filter && !isFull) inset = Math.max(inset, osw * 0.95);
    if (bi.wavy) inset = Math.max(inset, wavySw * 1.15 + innerSw / 2);
    var ix = ox + inset, iy = oy + inset;
    var iw = ow - inset * 2, ih = oh - inset * 2;
    // Offset Path logic: inner rx = outer rx - inset distance (same as Illustrator's Offset Path)
    var irx = Math.max(0, orx - inset);
    var iry = Math.max(0, ory - inset);
    var innerRect = '<rect x="' + ix.toFixed(2) + '" y="' + iy.toFixed(2) +
      '" width="' + iw.toFixed(2) + '" height="' + ih.toFixed(2) +
      '" fill="none" stroke="' + innerColor + '" stroke-width="' + innerSw +
      '" stroke-miterlimit="10"';
    if (irx > 0) innerRect += ' rx="' + irx.toFixed(1) + '"';
    if (iry > 0) innerRect += ' ry="' + iry.toFixed(1) + '"';
    innerRect += '/>';
    var textPos = svgStr.search(/<text[\s>]/i);
    if (textPos !== -1) return svgStr.slice(0, textPos) + innerRect + svgStr.slice(textPos);
    return svgStr.replace(/<\/svg>/, innerRect + '</svg>');
  },

  /**
   * Add split border effect: carve a white stroke through the thick border,
   * splitting it into two thinner strokes with white between them.
   * Supports: wavy (clone path), stitch (hollow shapes), simple/rounded rect, ripped paper.
   * Skips: perforated, zigzag, brushstroke, Cat 2 (image) templates.
   */
  addSplitBorder(svgStr, bi) {
    bi = bi || {};
    // Skip perforated/zigzag
    if (bi.border) return svgStr;
    // Skip brushstroke
    if (bi.brush) return svgStr;
    var isCat1Border = bi.wavy || bi.stitch || bi.filter;
    if (!isCat1Border && /<image[\s>]/i.test(svgStr)) return svgStr;

    var innerHtml = '';

    // ==== WAVY: clone the wavy <path> with white thin stroke ====
    if (bi.wavy) {
      var wavyRe = /<path[^>]*stroke-linejoin="round"[^>]*\/?>/gi;
      var wavyAll = svgStr.match(wavyRe);
      if (wavyAll) {
        var wavyPath = wavyAll[wavyAll.length - 1];
        var wavySwM = wavyPath.match(/stroke-width="([\d.]+)"/);
        var wavyOsw = wavySwM ? parseFloat(wavySwM[1]) : (bi.origStrokeWidth || 50);
        var wavyWhiteSw = Math.max(4, Math.round(wavyOsw * 0.24));
        innerHtml = wavyPath
          .replace(/fill="[^"]*"/, 'fill="none"')
          .replace(/stroke="[^"]*"/, 'stroke="#FFFFFF"')
          .replace(/stroke-width="[^"]*"/, 'stroke-width="' + wavyWhiteSw + '"');
      }
    }

    // ==== ALL OTHER TYPES ====
    else {
      var rects = [];
      var re = /<rect([^>]*)\/?>/gi;
      var m;
      while ((m = re.exec(svgStr)) !== null) {
        var attrs = m[1];
        if (/fill=["'](?:#FFF(?:FFF)?|white)["']/i.test(attrs)) {
          var hasColoredStroke = /stroke=["'](?!none|#FFF|#FFFFFF|white)#?[A-Fa-f0-9]+["']/i.test(attrs);
          if (!hasColoredStroke) continue;
        }
        if (/display=["']none["']/i.test(attrs)) continue;
        var wM = attrs.match(/\swidth=["']([\d.]+)["']/);
        var hM = attrs.match(/\sheight=["']([\d.]+)["']/);
        if (!wM || !hM) continue;
        rects.push({ full: m[0], attrs: attrs, w: parseFloat(wM[1]), h: parseFloat(hM[1]) });
      }
      if (rects.length === 0) return svgStr;
      rects.sort(function(a, b) { return b.w - a.w; });
      var outer = rects[0];

      var xM = outer.attrs.match(/\bx=["']([\d.\-]+)["']/);
      var yM = outer.attrs.match(/\by=["']([\d.\-]+)["']/);
      var swM2 = outer.attrs.match(/stroke-width=["']([\d.]+)["']/);
      var rxM = outer.attrs.match(/\brx=["']([\d.]+)["']/);
      var ryM = outer.attrs.match(/\bry=["']([\d.]+)["']/);
      var ox = xM ? parseFloat(xM[1]) : 0;
      var oy = yM ? parseFloat(yM[1]) : 0;
      var ow = outer.w, oh = outer.h;
      var osw2 = swM2 ? parseFloat(swM2[1]) : (bi.origStrokeWidth || 50);
      var orx = rxM ? parseFloat(rxM[1]) : 0;
      var ory = ryM ? parseFloat(ryM[1]) : 0;
      var whiteSw = Math.max(4, Math.round(osw2 * 0.24));

      // Copy filter from outer rect (e.g. ripped paper)
      var filterAttr = outer.attrs.match(/filter="([^"]*)"/);

      // Stitch shapes: overlay white shapes to create hollow effect
      if (bi.stitch) {
        var ringHtml = '';
        if (bi.stitch === 'circle') {
          var circleRe = /<circle\s+cx="([\d.\-]+)"\s+cy="([\d.\-]+)"\s+r="([\d.]+)"\s+fill="(?!#FFF|#FFFFFF|white|none)([^"]+)"\s*\/>/gi;
          var cm;
          while ((cm = circleRe.exec(svgStr)) !== null) {
            var ccx = cm[1], ccy = cm[2], cr = parseFloat(cm[3]);
            ringHtml += '<circle cx="' + ccx + '" cy="' + ccy + '" r="' + (cr * 0.55).toFixed(2) + '" fill="#FFFFFF"/>';
          }
        } else {
          var stitchRectRe = /<rect\s+x="([\d.\-]+)"\s+y="([\d.\-]+)"\s+width="([\d.]+)"\s+height="([\d.]+)"\s+fill="(?!#FFF|#FFFFFF|white|none)([^"]+)"\s*\/>/gi;
          var srm;
          while ((srm = stitchRectRe.exec(svgStr)) !== null) {
            var sx = parseFloat(srm[1]), sy = parseFloat(srm[2]);
            var sw = parseFloat(srm[3]), sh = parseFloat(srm[4]);
            if (sw > 200 || sh > 200) continue;
            var insetX = sw * 0.225, insetY = sh * 0.225;
            ringHtml += '<rect x="' + (sx + insetX).toFixed(2) + '" y="' + (sy + insetY).toFixed(2) +
              '" width="' + Math.max(1, sw - 2 * insetX).toFixed(2) +
              '" height="' + Math.max(1, sh - 2 * insetY).toFixed(2) + '" fill="#FFFFFF"/>';
          }
        }
        if (ringHtml) {
          svgStr = svgStr.replace(/<\/svg>/, ringHtml + '</svg>');
        }
        innerHtml = '';
      }
      // All other types: clone rect with white thin stroke
      else {
        innerHtml = '<rect x="' + ox.toFixed(2) + '" y="' + oy.toFixed(2) +
          '" width="' + ow.toFixed(2) + '" height="' + oh.toFixed(2) +
          '" fill="none" stroke="#FFFFFF" stroke-width="' + whiteSw + '"';
        if (orx > 0) innerHtml += ' rx="' + orx.toFixed(1) + '"';
        if (ory > 0) innerHtml += ' ry="' + ory.toFixed(1) + '"';
        if (filterAttr) innerHtml += ' filter="' + filterAttr[1] + '"';
        innerHtml += '/>';
      }
    }

    if (!innerHtml) return svgStr;

    var textPos = svgStr.search(/<text[\s>]/i);
    if (textPos !== -1) return svgStr.slice(0, textPos) + innerHtml + svgStr.slice(textPos);
    return svgStr.replace(/<\/svg>/, innerHtml + '</svg>');
  }
};
