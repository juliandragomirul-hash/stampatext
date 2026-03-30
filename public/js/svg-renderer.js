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

  // In-memory cache of fetched SVG strings (keyed by base URL without cache-buster).
  // Prevents re-downloading the same SVGs when user presses Stamp multiple times.
  _svgFetchCache: {},

  // Per-font tuning config loaded from /data/font-config.json
  _fontConfig: null,
  _sqConfig: null,  // Square tuning config, set by admin or loaded from square-config.json

  // Load font config from server (called once at page init)
  loadFontConfig: function() {
    var controller = new AbortController();
    var timeoutId = setTimeout(function() { controller.abort(); }, 5000);
    return fetch('/data/font-config.json?_v=' + this._svgVersion, { signal: controller.signal })
      .then(function(r) { clearTimeout(timeoutId); return r.json(); })
      .then(function(data) { SvgRenderer._fontConfig = data; return data; })
      .catch(function(err) { clearTimeout(timeoutId); console.warn('Font config load failed, using defaults:', err); });
  },

  // Detect text case from SVG string: single/singleDiacrit/multi/multiDiacrit
  _detectTextCase: function(svgString) {
    var tspans = (svgString.match(/<tspan/gi) || []).length;
    var isMulti = tspans > 1;
    // Extract text content from tspans (or <text> if no tspans)
    var textContent = (svgString.match(/<tspan[^>]*>([^<]*)<\/tspan>/gi) || []).join('');
    if (!textContent) textContent = (svgString.match(/<text[^>]*>([^<]*)<\/text>/gi) || []).join('');
    var hasDiacrit = /[ăâîșțĂÂÎȘȚéèêëàáüöñÉÈÊËÀÁÜÖÑ]/i.test(textContent);
    if (isMulti && hasDiacrit) return 'multiDiacrit';
    if (isMulti) return 'multi';
    if (hasDiacrit) return 'singleDiacrit';
    return 'single';
  },

  // Get config for a specific font + text case (with hardcoded fallback)
  _getFontConfig: function(fontName, textCase) {
    var defaults = { scaleY: 1.20, letterSpacing: 0, dx: 0, dy: 0, wb: 1.0, hb: 1.0, ws: 0, stroke: 0 };
    if (!this._fontConfig || !this._fontConfig[fontName]) return defaults;
    var fontEntry = this._fontConfig[fontName];
    // New structure: fontEntry has sub-objects (single, singleDiacrit, multi, multiDiacrit)
    if (fontEntry.single) {
      var tc = textCase || 'single';
      var cfg = fontEntry[tc] || fontEntry.single || defaults;
      // Diacrit modes inherit wb from their non-diacrit parent.
      // Measurement already accounts for diacrit glyph widths, so wb should match.
      if (tc === 'singleDiacrit' && cfg.wb === undefined && fontEntry.single) {
        cfg = Object.assign({}, cfg, { wb: fontEntry.single.wb });
      } else if (tc === 'multiDiacrit' && cfg.wb === undefined && fontEntry.multi) {
        cfg = Object.assign({}, cfg, { wb: fontEntry.multi.wb });
      }
      return cfg;
    }
    // Legacy flat structure fallback
    return fontEntry;
  },

  // Proportional stroke: scales with font size so all stamps look equally punchy
  _computeProportionalStroke: function(strokeFactor, fontSize) {
    if (strokeFactor === 0) return 0;
    var raw = strokeFactor * (fontSize / 100); // at 100px, stroke === strokeFactor
    var min = strokeFactor <= 1 ? 0 : Math.max(1, Math.round(strokeFactor * 0.3));
    var max = strokeFactor * 3;
    return Math.round(Math.max(min, Math.min(max, raw)));
  },

  _getSquareConfig: function(fontName, rowMode) {
    var defaults = {
      heroStroke: 8.0, heroSpacing: 2.0, heroScaleY: 1.10, heroScaleX: 1.0,
      heroDx: 0, heroDy: 0,
      smallStroke: 5.0, smallSpacing: 2.0, smallScaleY: 1.0, smallScaleX: 1.0,
      smallDx: 0, smallDy: 0,
      rowGap: 0
    };
    if (!this._sqConfig || !this._sqConfig[fontName]) return defaults;
    var fontEntry = this._sqConfig[fontName];
    // Map rowMode to case key: '2up' → 'hero2up', '2down' → 'hero2down', '3' → 'equal3'
    var caseKey = rowMode === '2up' ? 'hero2up' : rowMode === '2down' ? 'hero2down' : 'equal3';
    var cfg = fontEntry[caseKey] || {};
    // Merge with defaults
    var result = {};
    for (var k in defaults) {
      result[k] = cfg[k] !== undefined ? cfg[k] : defaults[k];
    }
    return result;
  },

  // Map of font names to local font files and their format
  _fontMap: {
    'Oswald':          { url: '/fonts/Oswald-Medium.ttf',                    format: 'truetype' },
    'Montserrat':      { url: '/fonts/Montserrat-Bold.ttf',                  format: 'truetype' },
    'Nunito':          { url: '/fonts/Nunito-Black.ttf',                      format: 'truetype' },
    'BlackOpsOne':     { url: '/fonts/BlackOpsOne-Regular.ttf',              format: 'truetype' },
    'CourierPrime':    { url: '/fonts/CourierPrime-Regular.ttf',           format: 'truetype' },
    'Yomogi':          { url: '/fonts/Yomogi-Regular.ttf',                  format: 'truetype' },
    'Bitter':          { url: '/fonts/Bitter-Medium.ttf',                    format: 'truetype' },
    'Exo2':            { url: '/fonts/Exo2-Bold.ttf',                        format: 'truetype' },
    'Comfortaa':       { url: '/fonts/Comfortaa-Bold.ttf',                   format: 'truetype' },
    'FuzzyBubbles':    { url: '/fonts/FuzzyBubbles-Bold.ttf',               format: 'truetype' },
    'BebasNeue':       { url: '/fonts/BebasNeue-Regular.ttf',              format: 'truetype' },
    // Legacy (kept for backward compat with saved designs)
    'RobotoBlack':     { url: '/fonts/Roboto-Bold.ttf',                      format: 'truetype' },
    'PlayfairDisplay': { url: '/fonts/PlayfairDisplay-Bold.ttf',             format: 'truetype' },
    'Merriweather':    { url: '/fonts/Merriweather-Black.ttf',               format: 'truetype' },
    'Raleway':         { url: '/fonts/Raleway-Bold.ttf',                     format: 'truetype' }
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
  // SVG template version — bump this when you upload new/changed templates to Supabase.
  // Lets browser + CDN cache SVGs across sessions (no more Date.now() per-request busting).
  _svgVersion: 4,

  async fetchSvg(svgUrl) {
    // Return from in-memory cache if available (same session, same URL)
    if (this._svgFetchCache[svgUrl]) return this._svgFetchCache[svgUrl];

    var bustUrl = svgUrl + (svgUrl.indexOf('?') === -1 ? '?' : '&') + '_v=' + this._svgVersion;
    var controller = new AbortController();
    var timeoutId = setTimeout(function() { controller.abort(); }, 10000);
    const res = await fetch(bustUrl, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error('Failed to fetch SVG: ' + res.status);
    var text = await res.text();
    this._svgFetchCache[svgUrl] = text;
    return text;
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
    // Resolve <use href="#id"/> references by inlining <defs> content.
    // Brush SVGs use <defs><g id="bbp">...paths...</g></defs> + <use href="#bbp"/>.
    // <use> shadow clones don't reflect fill changes from string manipulation,
    // so we inline BEFORE color replacement to ensure fills are directly hit.
    var useRefMatch = svgString.match(/<use[^>]*href=["']#([^"']+)["'][^>]*\/?\s*>/i);
    if (useRefMatch) {
      var refId = useRefMatch[1];
      // Match the <defs> block containing the referenced group (greedy inner match for nested </g>)
      var defsRe = new RegExp('<defs>\\s*<g\\s+id=["\']' + refId + '["\']>([\\s\\S]*?)</g>\\s*</defs>', 'i');
      var defsMatch = svgString.match(defsRe);
      if (defsMatch) {
        var inlinedContent = defsMatch[1].trim();
        // Replace all <use> refs with inline content
        var useRe = new RegExp('<use[^>]*href=["\']#' + refId + '["\'][^>]*/?>\\s*', 'gi');
        svgString = svgString.replace(useRe, inlinedContent);
        // Remove the resolved <defs> block
        svgString = svgString.replace(defsRe, '');
      }
    }

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

    // Category 1: replace ALL non-white/non-black fill/stroke with newColor.
    // Stamps are monochromatic — secondary colors (e.g. brushstroke paths in <defs>) must also recolor.
    // Brute-force: replace ANY hex color (6-digit or 3-digit) that isn't white/black.
    var result = svgString;
    function _isProtected(hex) {
      var u = hex.toUpperCase();
      // Expand 3-digit: #RGB → #RRGGBB
      if (u.length === 4) u = '#' + u[1]+u[1] + u[2]+u[2] + u[3]+u[3];
      return u === '#FFFFFF' || u === '#000000';
    }
    result = result.replace(/(fill=["'])(#[0-9A-Fa-f]{3,6})(["'])/gi, function(_m, pre, hex, post) {
      if (_isProtected(hex)) return _m;
      return pre + newColor + post;
    });
    result = result.replace(/(stroke=["'])(#[0-9A-Fa-f]{3,6})(["'])/gi, function(_m, pre, hex, post) {
      if (_isProtected(hex)) return _m;
      return pre + newColor + post;
    });

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
   * Apply a background-colored stroke on text glyphs for specific fonts (e.g. BlackOpsOne)
   * to visually thin heavy letterforms. Must be called AFTER colorize() so the stroke
   * isn't overwritten by the contrast-color block.
   * @param {string} svgString - SVG with text already colorized
   * @returns {string} SVG with thinning stroke applied (or unchanged if not applicable)
   */
  applyThinStroke: function(svgString) {
    var fontMatch = svgString.match(/font-family=["']'?([^"']+)'?["']/);
    var fontName = fontMatch ? fontMatch[1] : '';

    // Extract font size for proportional stroke
    var fsMatcher = svgString.match(/<text[^>]*font-size=["']([\d.]+)["']/i);
    var fontSize = fsMatcher ? parseFloat(fsMatcher[1]) : 100;

    // Per-font stroke from font-config.json: positive = thick (text-colored), negative = thin (bg-colored)
    var textCase = SvgRenderer._detectTextCase(svgString);
    var fc = SvgRenderer._getFontConfig(fontName, textCase);
    var strokeVal = fc.stroke || 0;
    if (strokeVal === 0) {
      // Check if this is an outlined variant (no colored rect fill)
      var allRects2 = svgString.match(/<rect[^>]*>/gi) || [];
      var hasColoredFill = false;
      for (var i = 0; i < allRects2.length; i++) {
        var fillM2 = allRects2[i].match(/\sfill=["']([^"']+)["']/i);
        if (!fillM2) continue;
        var f2 = fillM2[1].toLowerCase();
        if (f2 === '#ffffff' || f2 === '#fff' || f2 === 'white' || f2 === 'none') continue;
        hasColoredFill = true;
        break;
      }
      if (!hasColoredFill) {
        // Outlined variant: +2 thickening stroke compensates irradiation illusion
        strokeVal = 2;
      } else {
        // Filled variant: clean baseline (no stroke)
        return svgString.replace(/<text([^>]*)>/gi, function(match, attrs) {
          attrs = attrs.replace(/\s*stroke=["'][^"']*["']/gi, '');
          attrs = attrs.replace(/\s*stroke-width=["'][^"']*["']/gi, '');
          return '<text' + attrs + '>';
        });
      }
    }
    var propWidth = SvgRenderer._computeProportionalStroke(Math.abs(strokeVal), fontSize);
    var strokeConfig = { mode: strokeVal > 0 ? 'thick' : 'thin', width: propWidth };

    var strokeColor;
    if (strokeConfig.mode === 'thin') {
      // Thinning: stroke matches the background behind the text
      var allRects = svgString.match(/<rect[^>]*>/gi) || [];
      var stampRectFill = null;
      for (var i = 0; i < allRects.length; i++) {
        var fillM = allRects[i].match(/\sfill=["']([^"']+)["']/i);
        if (!fillM) continue;
        var f = fillM[1].toLowerCase();
        if (f === '#ffffff' || f === 'white' || f === 'none') continue;
        stampRectFill = fillM[1];
        break;
      }
      strokeColor = stampRectFill || '#FFFFFF';
    } else {
      // Thickening: stroke matches the text fill color
      var textFillMatch = svgString.match(/<text[^>]*[\s]fill=["']([^"']+)["']/i);
      strokeColor = textFillMatch ? textFillMatch[1] : '#000000';
      // Ensure text has paint-order so stroke renders behind fill (prevents hollow appearance)
      if (!textFillMatch) {
        // No fill found — extract from tspan or default to stroke color
        var tspanFillMatch = svgString.match(/<tspan[^>]*[\s]fill=["']([^"']+)["']/i);
        if (tspanFillMatch) strokeColor = tspanFillMatch[1];
      }
    }

    // Apply stroke + stroke-width + paint-order to <text> element
    var result = svgString.replace(/<text([^>]*)>/gi, function(match, attrs) {
      if (/stroke=["'][^"']*["']/i.test(attrs)) {
        attrs = attrs.replace(/stroke=["'][^"']*["']/i, 'stroke="' + strokeColor + '"');
      } else {
        attrs += ' stroke="' + strokeColor + '"';
      }
      if (/stroke-width=["'][^"']*["']/i.test(attrs)) {
        attrs = attrs.replace(/stroke-width=["'][^"']*["']/i, 'stroke-width="' + strokeConfig.width + '"');
      } else {
        attrs += ' stroke-width="' + strokeConfig.width + '"';
      }
      // paint-order: stroke renders behind fill, preventing hollow text
      if (!/paint-order/i.test(attrs)) {
        attrs += ' paint-order="stroke"';
      }
      return '<text' + attrs + '>';
    });

    return result;
  },

  /**
   * Crop the SVG viewBox to tightly fit the stamp rect (outer frame).
   * This ensures every font fills the viewBox equally, regardless of how big
   * or small the computed rect is. Must run AFTER autoFit and applyThinStroke.
   * @param {string} svgString - SVG with rects already sized by autoFit
   * @returns {string} SVG with viewBox cropped to stamp bounds
   */
  cropViewBoxToStamp: function(svgString) {
    // Find the outer stamp rect (largest non-white rect; fill="none" allowed for outlined stamps)
    var allRects = svgString.match(/<rect[^>]*>/gi) || [];
    var outerRect = null;
    var outerW = 0;
    for (var i = 0; i < allRects.length; i++) {
      var tag = allRects[i];
      var fillM = tag.match(/\sfill=["']([^"']+)["']/i);
      if (fillM) {
        var f = fillM[1].toLowerCase();
        if (f === '#ffffff' || f === 'white') continue; // allow fill="none" (outlined stitch frames)
      }
      var wM = tag.match(/\swidth=["']([\d.]+)["']/);
      if (wM && parseFloat(wM[1]) > outerW) {
        outerW = parseFloat(wM[1]);
        outerRect = tag;
      }
    }
    if (!outerRect) return svgString; // no stamp rect found

    // Extract rect geometry
    var xM = outerRect.match(/\bx=["']([\d.\-]+)["']/);
    var yM = outerRect.match(/\by=["']([\d.\-]+)["']/);
    var wM = outerRect.match(/\swidth=["']([\d.]+)["']/);
    var hM = outerRect.match(/\sheight=["']([\d.]+)["']/);
    var swM = outerRect.match(/stroke-width=["']([\d.]+)["']/);
    var rX = xM ? parseFloat(xM[1]) : 0;
    var rY = yM ? parseFloat(yM[1]) : 0;
    var rW = wM ? parseFloat(wM[1]) : 0;
    var rH = hM ? parseFloat(hM[1]) : 0;
    var sw = swM ? parseFloat(swM[1]) : 0;

    // Decorative border intrusion (same values as autoFit)
    var decoMargin = 0;
    if (/data-brush-border=/i.test(svgString)) {
      decoMargin = 30;
    } else if (/data-filter=["']ripped/i.test(svgString)) {
      var fMatch = svgString.match(/data-filter=["']ripped-(\d+)["']/i);
      decoMargin = fMatch ? parseFloat(fMatch[1]) : 20;
    } else if (/data-filter=["']chalk/i.test(svgString)) {
      var fMatch2 = svgString.match(/data-filter=["']chalk-(\d+)["']/i);
      decoMargin = fMatch2 ? Math.ceil(parseFloat(fMatch2[1]) / 2) : 10;
    } else if (/data-wavy-gen=["']zigzag["']/i.test(svgString)) {
      decoMargin = 60; // zigzag: depth 20 + strokeW/2 (30) + breathing
    } else if (/data-wavy-gen=["']strong["']/i.test(svgString)) {
      decoMargin = 50; // strong wavy: depth 20 + strokeW/2 (20) + breathing
    } else if (/data-wavy-gen=/i.test(svgString)) {
      decoMargin = 40; // gentle wavy: depth 7 + strokeW/2 (20) + breathing
    } else if (/data-border=/i.test(svgString)) {
      var bMatch = svgString.match(/data-border=["']\w+-(\d+)/i);
      decoMargin = bMatch ? Math.max(0, parseFloat(bMatch[1])) : 10;
    } else if (/data-stitch-gen=/i.test(svgString)) {
      var stitchSzM = svgString.match(/data-stitch-size="([\d.]+)"/);
      var stitchSz = stitchSzM ? parseFloat(stitchSzM[1]) : 50;
      decoMargin = Math.ceil(stitchSz * 0.75 + stitchSz / 2 + 5); // sOffset + half shape + breathing
    }

    // Compute cropped viewBox: rect bounds + stroke/2 + decorative + breathing margin
    var margin = 10; // breathing room
    var strokeMargin = sw / 2;
    var totalMargin = margin + strokeMargin + decoMargin;
    var newVbX = rX - totalMargin;
    var newVbY = rY - totalMargin;
    var newVbW = rW + totalMargin * 2;
    var newVbH = rH + totalMargin * 2;

    // Replace viewBox attribute
    svgString = svgString.replace(/viewBox=["'][^"']+["']/, 'viewBox="' + newVbX.toFixed(2) + ' ' + newVbY.toFixed(2) + ' ' + newVbW.toFixed(2) + ' ' + newVbH.toFixed(2) + '"');

    return svgString;
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
  _generateBorderShapes: function(x, y, w, h, shapeType, radius, spacingMult, shape, cornerType) {
    var shapes = '';
    var spacing = radius * (spacingMult || 2.5);
    var trace = SvgRenderer._generateTrace(x, y, w, h, cornerType || 'straight');
    // innerEdge: distance from rect edge to inner rect placement in double frame
    var innerEdge = 25;

    if (shape === 'lined') {
      // Lined: top + bottom only
      var numH = Math.max(1, Math.round(w / spacing));
      var hSpacing = w / numH;
      for (var i = 0; i <= numH; i++) {
        var cx = x + i * hSpacing;
        shapes += this._borderShape(shapeType, cx, y, radius);
        shapes += this._borderShape(shapeType, cx, y + h, radius);
      }
      return { svg: shapes, innerEdge: innerEdge };
    }

    // Region-based: draw equal corners first, then fill edges
    var regions = SvgRenderer._splitTraceRegions(trace);

    // 4 corner regions — shapes follow the necklace path (tangent-inclined on arcs)
    for (var ci = 0; ci < regions.corners.length; ci++) {
      var pts = SvgRenderer._walkRegion(regions.corners[ci], spacing);
      for (var pi = 0; pi < pts.length; pi++) {
        shapes += this._borderShape(shapeType, pts[pi].x, pts[pi].y, radius, pts[pi].rotDeg);
      }
    }
    // 4 edge regions — evenly spaced on remaining straight segments
    for (var ei = 0; ei < regions.edges.length; ei++) {
      var pts = SvgRenderer._walkRegion(regions.edges[ei], spacing);
      for (var pi = 0; pi < pts.length; pi++) {
        shapes += this._borderShape(shapeType, pts[pi].x, pts[pi].y, radius, pts[pi].rotDeg);
      }
    }

    return { svg: shapes, innerEdge: innerEdge };
  },

  _borderShape: function(type, cx, cy, r, rotDeg) {
    if (type === 'circle') {
      return '<circle cx="' + cx.toFixed(2) + '" cy="' + cy.toFixed(2) + '" r="' + r + '" fill="#FFFFFF"/>';
    }
    // diamond: 4 points of a 45° rotated square
    var top = (cy - r).toFixed(2);
    var bot = (cy + r).toFixed(2);
    var lft = (cx - r).toFixed(2);
    var rgt = (cx + r).toFixed(2);
    var poly = '<polygon points="' + cx.toFixed(2) + ',' + top + ' ' + rgt + ',' + cy.toFixed(2) + ' ' + cx.toFixed(2) + ',' + bot + ' ' + lft + ',' + cy.toFixed(2) + '" fill="#FFFFFF"';
    if (rotDeg) poly += ' transform="rotate(' + rotDeg.toFixed(1) + ',' + cx.toFixed(2) + ',' + cy.toFixed(2) + ')"';
    return poly + '/>';
  },

  /**
   * Generate a wavy border path as a single closed SVG <path>.
   * Uses odd arc counts for smooth corners (~5° tangent change vs ~100° with even).
   * @param {string} variant - "gentle" (d=7) or "strong" (d=12)
   * @param {boolean} filled - if true, path has fill (for full-frame templates)
   */
  _generateWavyBorder: function(x, y, w, h, color, strokeW, variant, filled, shape) {
    var F = function(n) { return n.toFixed(2); };
    var scWidth = (variant === 'strong') ? 80 : 35;
    var depth = (variant === 'strong') ? 20 : 7;
    strokeW = strokeW || 40;

    var numH = Math.max(3, Math.round(w / scWidth));
    if (numH % 2 === 0) numH++;   // force ODD for smooth corners
    var segW = w / numH;

    // Lined: two separate open paths (top + bottom only)
    if (shape === 'lined') {
      var dTop = 'M ' + F(x) + ',' + F(y);
      for (var i = 0; i < numH; i++) { var fl = (i % 2 === 0) ? 1 : -1; var sx = x + i * segW;
        dTop += ' C '+F(sx+segW*0.3)+','+F(y-fl*depth)+' '+F(sx+segW*0.7)+','+F(y-fl*depth)+' '+F(sx+segW)+','+F(y); }
      var dBot = 'M ' + F(x) + ',' + F(y + h);
      for (var i = 0; i < numH; i++) { var fl = (i % 2 === 0) ? 1 : -1; var sx = x + i * segW;
        dBot += ' C '+F(sx+segW*0.3)+','+F(y+h+fl*depth)+' '+F(sx+segW*0.7)+','+F(y+h+fl*depth)+' '+F(sx+segW)+','+F(y+h); }
      return { svg: '<path d="' + dTop + '" fill="none" stroke="' + color + '" stroke-width="' + strokeW + '" stroke-linejoin="round" stroke-linecap="round"/>' +
        '<path d="' + dBot + '" fill="none" stroke="' + color + '" stroke-width="' + strokeW + '" stroke-linejoin="round" stroke-linecap="round"/>', innerEdge: depth + strokeW / 2 };
    }

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
    var innerEdge = depth + strokeW / 2;
    return { svg: '<path d="' + d + '" fill="' + fillAttr + '" stroke="' + color + '" stroke-width="' + strokeW + '" stroke-linejoin="round"/>', innerEdge: innerEdge };
  },

  // True zigzag border: like wavy but with straight V-shaped segments.
  // Single closed path around all 4 edges, peaks only (no corner points).
  _generateZigzagBorder: function(x, y, w, h, color, strokeW, filled, shape) {
    var F = function(n) { return n.toFixed(2); };
    var scWidth = 60;   // segment width target (wider = fewer teeth)
    var depth = 20;
    strokeW = strokeW || 22;

    var numH = Math.max(3, Math.round(w / scWidth));
    if (numH % 2 === 0) numH++;
    var segW = w / numH;

    // Lined: two separate open zigzag paths (top + bottom only)
    if (shape === 'lined') {
      var topPts = [];
      topPts.push(F(x) + ',' + F(y));
      for (var i = 0; i < numH; i++) {
        var mid = x + (i + 0.5) * segW;
        var d = (i % 2 === 0) ? -depth : depth;
        topPts.push(F(mid) + ',' + F(y + d));
      }
      topPts.push(F(x + w) + ',' + F(y));
      var botPts = [];
      botPts.push(F(x) + ',' + F(y + h));
      for (var i = 0; i < numH; i++) {
        var mid = x + (i + 0.5) * segW;
        var d = (i % 2 === 0) ? depth : -depth;
        botPts.push(F(mid) + ',' + F(y + h + d));
      }
      botPts.push(F(x + w) + ',' + F(y + h));
      var topD = 'M' + topPts[0]; for (var i = 1; i < topPts.length; i++) topD += ' L' + topPts[i];
      var botD = 'M' + botPts[0]; for (var i = 1; i < botPts.length; i++) botD += ' L' + botPts[i];
      return { svg: '<path d="' + topD + '" fill="none" stroke="' + color + '" stroke-width="' + strokeW + '" stroke-linejoin="miter" stroke-linecap="square"/>' +
        '<path d="' + botD + '" fill="none" stroke="' + color + '" stroke-width="' + strokeW + '" stroke-linejoin="miter" stroke-linecap="square"/>', innerEdge: depth + strokeW / 2 };
    }

    var numV = Math.max(3, Math.round(h / segW));
    if (numV % 2 === 0) numV++;
    var segH = h / numV;
    var vD = depth * segH / segW;  // aspect-compensated depth for vertical edges

    var points = [];

    // Top edge: left to right
    for (var i = 0; i < numH; i++) {
      var mid = x + (i + 0.5) * segW;
      var d = (i % 2 === 0) ? -depth : depth;
      points.push(F(mid) + ',' + F(y + d));
    }
    // Right edge: top to bottom
    for (var i = 0; i < numV; i++) {
      var mid = y + (i + 0.5) * segH;
      var d = (i % 2 === 0) ? vD : -vD;
      points.push(F(x + w + d) + ',' + F(mid));
    }
    // Bottom edge: right to left
    for (var i = numH - 1; i >= 0; i--) {
      var mid = x + (i + 0.5) * segW;
      var d = (i % 2 === 0) ? depth : -depth;
      points.push(F(mid) + ',' + F(y + h + d));
    }
    // Left edge: bottom to top
    for (var i = numV - 1; i >= 0; i--) {
      var mid = y + (i + 0.5) * segH;
      var d = (i % 2 === 0) ? -vD : vD;
      points.push(F(x + d) + ',' + F(mid));
    }

    var pathD = 'M' + points[0];
    for (var i = 1; i < points.length; i++) {
      pathD += ' L' + points[i];
    }
    pathD += ' Z';

    var fillAttr = filled ? color : 'none';
    var innerEdge = depth + strokeW / 2;
    return { svg: '<path d="' + pathD + '" fill="' + fillAttr + '" stroke="' + color + '" stroke-width="' + strokeW + '" stroke-linejoin="miter"/>', innerEdge: innerEdge };
  },

  // Programmatic brush border for lined stamps: dashed lines + turbulence filter.
  // Dashes create paint-gap effect, filter adds rough organic edges.
  _generateBrushBorder: function(x, y, w, h, color, strokeW, filled, shape) {
    if (shape !== 'lined') return '';
    var F = function(n) { return n.toFixed(2); };
    // Scale factor: dash/filter values relative to stamp width
    var s = w / 100; // e.g. w=1200 → s=12, so dash "4" becomes 48
    // SVG filter for rough/displaced edges — filterUnits=userSpaceOnUse for absolute coords
    var fId = 'brush-lined-f';
    var disp = Math.max(8, Math.round(strokeW * 0.25)); // displacement proportional to stroke
    var freq = (0.5 / w).toFixed(6); // low frequency relative to stamp width
    var filterDef = '<filter id="' + fId + '" x="-10%" y="-50%" width="120%" height="200%">' +
      '<feTurbulence type="turbulence" baseFrequency="' + freq + ',0.002" numOctaves="3" seed="2"/>' +
      '<feDisplacementMap in="SourceGraphic" scale="' + disp + '" xChannelSelector="R" yChannelSelector="G"/>' +
      '</filter>';
    // Dash patterns scaled to stamp size: long dashes with short gaps
    var dash1 = F(s*4.5)+','+F(s*0.8)+','+F(s*3)+','+F(s*1.2)+','+F(s*5.5)+','+F(s*0.6)+','+F(s*2)+','+F(s*1)+','+F(s*6)+','+F(s*0.7);
    var dash2 = F(s*3.5)+','+F(s*1)+','+F(s*5)+','+F(s*0.7)+','+F(s*2.5)+','+F(s*1.2)+','+F(s*4)+','+F(s*0.9)+','+F(s*5.5)+','+F(s*0.6);
    var paths = '';
    var edges = [y, y + h];
    for (var e = 0; e < 2; e++) {
      var edgeY = edges[e];
      var off = strokeW * 0.15 * (e === 0 ? -1 : 1);
      // Main stroke
      paths += '<path d="M' + F(x) + ',' + F(edgeY) + ' H' + F(x + w) +
        '" fill="none" stroke="' + color + '" stroke-width="' + F(strokeW * 0.7) +
        '" stroke-dasharray="' + dash1 +
        '" stroke-linecap="round" filter="url(#' + fId + ')"/>';
      // Accent stroke (offset, thinner, different dash phase)
      paths += '<path d="M' + F(x) + ',' + F(edgeY + off) + ' H' + F(x + w) +
        '" fill="none" stroke="' + color + '" stroke-width="' + F(strokeW * 0.35) +
        '" stroke-dasharray="' + dash2 +
        '" stroke-dashoffset="' + F(s * 2) + '" stroke-linecap="round" filter="url(#' + fId + ')"/>';
    }
    return filterDef + paths;
  },

  _generateStitchShapes: function(x, y, w, h, shapeType, size, spacing, color, shape, cornerType, rxOffset) {
    var shapes = '';
    var half = size / 2;
    // Stitch shapes sit on expanded rect (outward from original rect).
    // Negative innerEdge pulls double-frame inner rect closer to stitch shapes.
    var innerEdge = -10;
    var dashLen = (shapeType === 'line') ? size * 3.5 : size;
    var step = spacing + dashLen;
    var isLined = (shape === 'lined');

    // Build trace from corner type, with rxOffset for parallel curves
    var trace = SvgRenderer._generateTrace(x, y, w, h, cornerType || 'straight', rxOffset || 0);

    function addShape(cx, cy, angle, rotDeg) {
      if (shapeType === 'circle') {
        shapes += '<circle cx="' + cx.toFixed(2) + '" cy="' + cy.toFixed(2) + '" r="' + half + '" fill="' + color + '"/>';
      } else if (shapeType === 'square') {
        var rot = rotDeg || 0;
        var sq = '<rect x="' + (cx - half).toFixed(2) + '" y="' + (cy - half).toFixed(2) + '" width="' + size + '" height="' + size + '" fill="' + color + '"';
        if (rot !== 0) sq += ' transform="rotate(' + rot.toFixed(1) + ',' + cx.toFixed(2) + ',' + cy.toFixed(2) + ')"';
        shapes += sq + '/>';
      } else { // line — always draw horizontal, rotate if needed
        var rot = rotDeg || 0;
        var ln = '<rect x="' + (cx - dashLen / 2).toFixed(2) + '" y="' + (cy - half).toFixed(2) + '" width="' + dashLen + '" height="' + size + '" fill="' + color + '"';
        var totalRot = (angle === 1 ? 90 : 0) + rot;
        if (totalRot !== 0) ln += ' transform="rotate(' + totalRot.toFixed(1) + ',' + cx.toFixed(2) + ',' + cy.toFixed(2) + ')"';
        shapes += ln + '/>';
      }
    }

    if (isLined) {
      // Lined: top + bottom edges only, no corners
      var numH = Math.max(1, Math.round(w / step));
      var hStep = w / numH;
      for (var i = 1; i < numH; i++) addShape(x + i * hStep, y, 0);
      for (var i = 1; i < numH; i++) addShape(x + i * hStep, y + h, 0);
      return { svg: shapes, innerEdge: innerEdge };
    }

    // Region-based: draw equal corners first, then fill edges
    var regions = SvgRenderer._splitTraceRegions(trace);

    // Resolve a distance along a region to a point {x, y, rotDeg}
    function pointAtDist(region, dist) {
      var cumDist = 0;
      for (var si = 0; si < region.segments.length; si++) {
        var seg = region.segments[si];
        if (cumDist + seg.len >= dist || si === region.segments.length - 1) {
          var t = seg.len > 0 ? Math.max(0, Math.min(1, (dist - cumDist) / seg.len)) : 0;
          if (seg.type === 'h' || seg.type === 'v') {
            return { x: seg.sx + (seg.ex - seg.sx) * t, y: seg.sy + (seg.ey - seg.sy) * t, rotDeg: 0 };
          }
          var a = seg.startAngle + (seg.endAngle - seg.startAngle) * t;
          return { x: seg.cx + seg.r * Math.cos(a), y: seg.cy + seg.r * Math.sin(a),
                   rotDeg: (a + Math.PI / 2) * (180 / Math.PI) };
        }
        cumDist += seg.len;
      }
      return null;
    }

    // Stitch line: squares at corners, lines on edges — unified gap
    if (shapeType === 'line') {
      var F = function(n) { return n.toFixed(2); };
      var sqSize = size;
      var sqHalf = sqSize / 2;
      var gap = spacing;
      var stride = sqSize + gap;
      var cornerStep = sqSize * 1.15; // tighter spacing in corner regions

      // ---- CORNERS: squares from vertex outward, dynamic count ----
      for (var ci = 0; ci < regions.corners.length; ci++) {
        var cReg = regions.corners[ci];
        if (cReg.totalLength <= 0) continue;
        var armLen = cReg.totalLength / 2;
        var mid = armLen;
        var nSq = (armLen < sqHalf) ? 1 : Math.max(2, Math.floor((armLen - sqHalf) / cornerStep) + 1);
        var cornerStride = (nSq > 1) ? (armLen - sqHalf) / (nSq - 1) : 0;
        for (var ai = 0; ai < nSq; ai++) {
          var d1 = mid - ai * cornerStride;
          var pt = pointAtDist(cReg, d1);
          if (pt) {
            var rot = pt.rotDeg || 0;
            shapes += '<rect x="' + F(pt.x - sqHalf) + '" y="' + F(pt.y - sqHalf) + '" width="' + F(sqSize) + '" height="' + F(sqSize) + '" fill="' + color + '"' +
              (rot !== 0 ? ' transform="rotate(' + rot.toFixed(1) + ',' + F(pt.x) + ',' + F(pt.y) + ')"' : '') + '/>';
          }
          if (ai > 0) {
            var d2 = mid + ai * cornerStride;
            var pt2 = pointAtDist(cReg, d2);
            if (pt2) {
              var rot2 = pt2.rotDeg || 0;
              shapes += '<rect x="' + F(pt2.x - sqHalf) + '" y="' + F(pt2.y - sqHalf) + '" width="' + F(sqSize) + '" height="' + F(sqSize) + '" fill="' + color + '"' +
                (rot2 !== 0 ? ' transform="rotate(' + rot2.toFixed(1) + ',' + F(pt2.x) + ',' + F(pt2.y) + ')"' : '') + '/>';
            }
          }
        }
      }

      // ---- EDGES: stitch lines, gap at both ends matching corner squares ----
      for (var ei = 0; ei < regions.edges.length; ei++) {
        var edgeReg = regions.edges[ei];
        var edgeLen = edgeReg.totalLength;
        if (edgeLen <= 0 || !edgeReg.segments.length) continue;
        var seg = edgeReg.segments[0];
        var isVert = (seg.type === 'v');
        var available = edgeLen - 2 * gap;
        if (available <= 0) continue;
        var targetW = dashLen * 0.6;
        var nStitch = Math.max(1, Math.round((available + gap) / (targetW + gap)));
        var stitchW = (available - (nStitch - 1) * gap) / nStitch;
        while (stitchW < sqSize && nStitch > 1) {
          nStitch--;
          stitchW = (available - (nStitch - 1) * gap) / nStitch;
        }
        if (stitchW <= 0) continue;
        var dx = seg.ex - seg.sx, dy = seg.ey - seg.sy;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        var ux = dx / len, uy = dy / len;
        for (var si = 0; si < nStitch; si++) {
          var center = gap + stitchW / 2 + si * (stitchW + gap);
          var cx = seg.sx + ux * center, cy = seg.sy + uy * center;
          var rot = isVert ? 90 : 0;
          var ln = '<rect x="' + F(cx - stitchW / 2) + '" y="' + F(cy - half) + '" width="' + F(stitchW) + '" height="' + size + '" fill="' + color + '"';
          if (rot !== 0) ln += ' transform="rotate(' + rot + ',' + F(cx) + ',' + F(cy) + ')"';
          shapes += ln + '/>';
        }
      }
      return { svg: shapes, innerEdge: innerEdge };
    }

    // Stitch square: unified corners + manual edge placement
    if (shapeType === 'square') {
      var sqSize = size;
      var sqHalf = sqSize / 2;
      var gap = spacing;
      var stride = sqSize + gap;
      var cornerStep = sqSize * 1.15; // tighter spacing in corner regions

      // ---- CORNERS: squares from vertex outward, dynamic count ----
      for (var ci = 0; ci < regions.corners.length; ci++) {
        var cReg = regions.corners[ci];
        if (cReg.totalLength <= 0) continue;
        var armLen = cReg.totalLength / 2;
        var mid = armLen;
        var nSq = (armLen < sqHalf) ? 1 : Math.max(2, Math.floor((armLen - sqHalf) / cornerStep) + 1);
        var cornerStride = (nSq > 1) ? (armLen - sqHalf) / (nSq - 1) : 0;
        for (var ai = 0; ai < nSq; ai++) {
          var d1 = mid - ai * cornerStride;
          var pt = pointAtDist(cReg, d1);
          if (pt) addShape(pt.x, pt.y, pt.angle, pt.rotDeg);
          if (ai > 0) {
            var d2 = mid + ai * cornerStride;
            var pt2 = pointAtDist(cReg, d2);
            if (pt2) addShape(pt2.x, pt2.y, pt2.angle, pt2.rotDeg);
          }
        }
      }
      // ---- EDGES: squares with gap at both ends ----
      for (var ei = 0; ei < regions.edges.length; ei++) {
        var edgeReg = regions.edges[ei];
        var edgeLen = edgeReg.totalLength;
        if (edgeLen <= 0 || !edgeReg.segments.length) continue;
        var available = edgeLen - 2 * gap;
        if (available <= 0) continue;
        var nEdgeSq = Math.max(1, Math.round((available + gap) / stride));
        var edgeStride = (nEdgeSq > 1) ? (available - sqSize) / (nEdgeSq - 1) : 0;
        var startOff = (nEdgeSq === 1) ? gap + available / 2 : gap + sqHalf;
        for (var si = 0; si < nEdgeSq; si++) {
          var dist = startOff + si * edgeStride;
          var pt = pointAtDist(edgeReg, dist);
          if (pt) addShape(pt.x, pt.y, pt.angle, pt.rotDeg);
        }
      }
    } else {
      // Stitch circle: same unified corner + edge approach as square
      var sqSize = size;
      var sqHalf = sqSize / 2;
      var gap = spacing;
      var stride = sqSize + gap;
      var cornerStep = sqSize * 1.15; // tighter spacing in corner regions

      // ---- CORNERS: circles from vertex outward, dynamic count ----
      for (var ci = 0; ci < regions.corners.length; ci++) {
        var cReg = regions.corners[ci];
        if (cReg.totalLength <= 0) continue;
        var armLen = cReg.totalLength / 2;
        var mid = armLen;
        var nSq = (armLen < sqHalf) ? 1 : Math.max(2, Math.floor((armLen - sqHalf) / cornerStep) + 1);
        var cornerStride = (nSq > 1) ? (armLen - sqHalf) / (nSq - 1) : 0;
        for (var ai = 0; ai < nSq; ai++) {
          var d1 = mid - ai * cornerStride;
          var pt = pointAtDist(cReg, d1);
          if (pt) addShape(pt.x, pt.y, pt.angle, pt.rotDeg);
          if (ai > 0) {
            var d2 = mid + ai * cornerStride;
            var pt2 = pointAtDist(cReg, d2);
            if (pt2) addShape(pt2.x, pt2.y, pt2.angle, pt2.rotDeg);
          }
        }
      }
      // ---- EDGES: circles with gap at both ends ----
      for (var ei = 0; ei < regions.edges.length; ei++) {
        var edgeReg = regions.edges[ei];
        var edgeLen = edgeReg.totalLength;
        if (edgeLen <= 0 || !edgeReg.segments.length) continue;
        var available = edgeLen - 2 * gap;
        if (available <= 0) continue;
        var nEdgeSq = Math.max(1, Math.round((available + gap) / stride));
        var edgeStride = (nEdgeSq > 1) ? (available - sqSize) / (nEdgeSq - 1) : 0;
        var startOff = (nEdgeSq === 1) ? gap + available / 2 : gap + sqHalf;
        for (var si = 0; si < nEdgeSq; si++) {
          var dist = startOff + si * edgeStride;
          var pt = pointAtDist(edgeReg, dist);
          if (pt) addShape(pt.x, pt.y, pt.angle, pt.rotDeg);
        }
      }
    }
    return { svg: shapes, innerEdge: innerEdge };
  },

  convertFill(svgString, targetFill) {
    if (targetFill === 'empty') {
      var rectM = svgString.match(/<rect[^>]*\bfill=["']#([0-9A-Fa-f]{6})["'][^>]*(?:data-wavy|data-border|data-stitch|data-filter|data-brush|stroke-width)/);
      if (!rectM) rectM = svgString.match(/<rect[^>]*(?:data-wavy|data-border|data-stitch|data-filter|data-brush|stroke-width)[^>]*\bfill=["']#([0-9A-Fa-f]{6})["']/);
      if (rectM) {
        var rectColor = '#' + rectM[1];
        svgString = svgString.replace(/(<rect[^>]*)(fill=["'])#[0-9A-Fa-f]{6}(["'])([^>]*(?:data-wavy|data-border|data-stitch|data-filter|data-brush|stroke-width))/, '$1$2none$3$4');
        svgString = svgString.replace(/(<rect[^>]*(?:data-wavy|data-border|data-stitch|data-filter|data-brush|stroke-width)[^>]*)(fill=["'])#[0-9A-Fa-f]{6}(["'])/, '$1$2none$3');
        svgString = svgString.replace(/(<text[^>]*)(fill=["'])#[Ff]{6}(["'])/, '$1$2' + rectColor + '$3');
        svgString = svgString.replace(/(<text[^>]*)(fill=["'])#[Ff]{3}(["'])/, '$1$2' + rectColor + '$3');
      }
    } else if (targetFill === 'full') {
      var textM = svgString.match(/<text[^>]*\bfill=["']#([0-9A-Fa-f]{3,6})["']/);
      var fillColor = textM ? '#' + textM[1] : '#BE1E2D';
      svgString = svgString.replace(/(<rect[^>]*)(fill=["'])none(["'])([^>]*(?:data-wavy|data-border|data-stitch|data-filter|data-brush|stroke-width))/, '$1$2' + fillColor + '$3$4');
      svgString = svgString.replace(/(<rect[^>]*(?:data-wavy|data-border|data-stitch|data-filter|data-brush|stroke-width)[^>]*)(fill=["'])none(["'])/, '$1$2' + fillColor + '$3');
      svgString = svgString.replace(/(<text[^>]*)(fill=["'])#[0-9A-Fa-f]{3,6}(["'])/, '$1$2#FFFFFF$3');
    }
    return svgString;
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
    // 1-60 chars: 25 chars per line
    // 61+ chars: 30 chars per line
    return len <= 60 ? 25 : 30;
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
  splitTextIntoLines(text, forceLines) {
    // Respect explicit newlines (from multi-line input)
    if (text.indexOf('\n') !== -1) {
      var explicitLines = text.split('\n');
      var result = [];
      for (var ei = 0; ei < explicitLines.length; ei++) {
        var subLines = this.splitTextIntoLines(explicitLines[ei], forceLines);
        for (var si = 0; si < subLines.length; si++) result.push(subLines[si]);
      }
      return result;
    }

    // Rows=1: never break
    if (forceLines === 1) return [text];

    var words = text.split(' ');
    var isSingleWord = words.length === 1;

    // Single word: never break (syllable splitting removed for rectangles)
    if (isSingleWord) {
      return [text];
    }

    // Multi-word: distribute words evenly across forced row count
    if (forceLines && forceLines > 1) {
      var effectiveLines = Math.min(forceLines, words.length);
      // Even word-count distribution: floor words per line, remainder goes to last rows
      var base = Math.floor(words.length / effectiveLines);
      var extra = words.length % effectiveLines;
      var lines = [];
      var wi = 0;
      for (var li = 0; li < effectiveLines; li++) {
        // Give extra word to LAST rows so early rows are shorter (visually balanced)
        var count = base + (li >= effectiveLines - extra ? 1 : 0);
        lines.push(words.slice(wi, wi + count).join(' '));
        wi += count;
      }
      return lines;
    }

    // Multi-word natural wrapping (16/20 char limit)
    var max = this._getMaxCharsPerLine(text.length);
    if (text.length <= max && !forceLines) return [text];

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
   * Split a word into syllables using a simple English heuristic.
   * No external library — handles common patterns.
   * @param {string} word - single word (no spaces)
   * @returns {string[]} - array of syllables
   */
  _splitSyllables(word) {
    if (word.length <= 2) return [word];

    // Heuristic: vowel-consonant + vowel-vowel splitting (Romanian + Latin scripts)
    function heuristicSplit(w) {
      var vowels = 'aeiouyăâîàáâãäåèéêëìíîïòóôõöùúûüýÿ';
      var syllables = [];
      var current = '';
      var lower = w.toLowerCase();
      for (var i = 0; i < lower.length; i++) {
        current += w[i];
        if (current.length < 2 || lower.length - i - 1 < 2) continue;
        var isV = vowels.indexOf(lower[i]) >= 0;
        var nextIsV = (i + 1 < lower.length) && vowels.indexOf(lower[i + 1]) >= 0;
        var nextIsC = (i + 1 < lower.length) && !nextIsV;
        var shouldBreak = false;
        if (isV && nextIsC) {
          // V-CV: break after vowel before consonant (if vowel follows later)
          for (var j = i + 1; j < lower.length; j++) {
            if (vowels.indexOf(lower[j]) >= 0) { shouldBreak = true; break; }
          }
        } else if (isV && nextIsV) {
          // V-V: break between adjacent vowels (handles Romanian ia, ea splits)
          shouldBreak = true;
        }
        if (shouldBreak) { syllables.push(current); current = ''; }
      }
      if (current) {
        if (syllables.length > 0 && current.length < 2) syllables[syllables.length - 1] += current;
        else syllables.push(current);
      }
      return syllables.length > 0 ? syllables : [w];
    }

    // Try Hypher (accurate for EN/FR/DE/ES/IT/PT)
    var hypherResult = null;
    if (typeof HypherSplit === 'function') {
      hypherResult = HypherSplit(word);
      // Merge very short fragments
      var merged = [];
      for (var k = 0; k < hypherResult.length; k++) {
        if (merged.length > 0 && hypherResult[k].length < 2) merged[merged.length - 1] += hypherResult[k];
        else merged.push(hypherResult[k]);
      }
      hypherResult = merged.length > 0 ? merged : [word];
    }

    // Try heuristic (better for Romanian and unsupported languages)
    var heurResult = heuristicSplit(word);

    // Return the split with more syllables (gives user more Rows options)
    if (hypherResult && hypherResult.length >= heurResult.length) return hypherResult;
    return heurResult;
  },

  /**
   * Split text into lines optimized for a square stamp.
   * Multi-word: try different row counts, pick closest to square.
   * Single-word: split by syllable.
   * @param {string} text - user text (already uppercased)
   * @returns {string[]} - array of lines
   */
  /**
   * Add horizontal filler lines to 3-row square stamps.
   * Lines extend from text edges to rect border with 10px gaps.
   * @param {string} svgString - processed SVG
   * @param {string} rowMode - '3' for equal rows (only mode that gets lines)
   * @returns {string} SVG with filler lines injected
   */
  addSquareFillerLines(svgString, rowMode) {
    if (rowMode !== '3') return svgString;

    // Find the outer rect (largest rect with stroke)
    var rectMatch = svgString.match(/<rect[^>]*\bwidth=["']([\d.]+)["'][^>]*\bheight=["']([\d.]+)["'][^>]*>/i);
    if (!rectMatch) return svgString;

    // Parse rect bounds
    var rAttrs = rectMatch[0];
    var rX = parseFloat((rAttrs.match(/\bx=["']([\d.\-]+)["']/) || [0, 0])[1]);
    var rY = parseFloat((rAttrs.match(/\by=["']([\d.\-]+)["']/) || [0, 0])[1]);
    var rW = parseFloat(rectMatch[1]);
    var rH = parseFloat(rectMatch[2]);
    var rSw = parseFloat((rAttrs.match(/stroke-width=["']([\d.]+)["']/) || [0, 50])[1]);

    // Find text transform to get text center position
    var textTransMatch = svgString.match(/transform=["']translate\(([\d.\-]+)[,\s]+([\d.\-]+)\)/);
    if (!textTransMatch) return svgString;
    var textCX = parseFloat(textTransMatch[1]);
    var textCY = parseFloat(textTransMatch[2]);

    // Find all tspan dy values and font-sizes to compute baseline Y positions
    var tspans = [];
    var tspanRegex = /<tspan[^>]*dy=["']([\d.\-]+)["'][^>]*(?:font-size=["']([\d.]+)["'])?[^>]*>([^<]*)<\/tspan>/gi;
    var tm;
    while ((tm = tspanRegex.exec(svgString)) !== null) {
      var fs = tm[2] ? parseFloat(tm[2]) : null;
      tspans.push({ dy: parseFloat(tm[1]), fontSize: fs, text: tm[3] });
    }
    if (tspans.length < 2) return svgString;

    // If font-size not on tspan, get from text element
    var textFsMatch = svgString.match(/<text[^>]*font-size=["']([\d.]+)["']/);
    var baseFontSize = textFsMatch ? parseFloat(textFsMatch[1]) : 100;
    tspans.forEach(function(t) { if (!t.fontSize) t.fontSize = baseFontSize; });

    // Compute absolute Y positions of baselines
    var baselines = [];
    var cumY = 0;
    for (var i = 0; i < tspans.length; i++) {
      cumY += tspans[i].dy;
      baselines.push(textCY + cumY);
    }

    // Get stroke color from the rect
    var strokeColor = (rAttrs.match(/\bstroke=["']([^"']+)["']/) || [0, '#dc2626'])[1];
    var lineStroke = rSw * 0.4; // filler line thickness = 40% of rect stroke
    if (lineStroke < 3) lineStroke = 3;

    // Left and right edges of rect (inside stroke)
    var leftEdge = rX + rSw / 2;
    var rightEdge = rX + rW - rSw / 2;
    var gap = 10; // gap between line and text/border

    // Estimate text width per row using character count ratio
    var maxChars = 0;
    tspans.forEach(function(t) { if (t.text.length > maxChars) maxChars = t.text.length; });

    var linesHtml = '';
    for (var i = 0; i < tspans.length; i++) {
      var fs = tspans[i].fontSize;
      // Estimate text width: chars × fontSize × 0.6 (average char width ratio)
      var estTextWidth = tspans[i].text.length * fs * 0.55;
      var textLeft = textCX - estTextWidth / 2;
      var textRight = textCX + estTextWidth / 2;

      // Baseline Y for the line
      var lineY = baselines[i] - fs * 0.35; // vertically center on cap height

      // Left filler: from leftEdge+gap to textLeft-gap
      var lx1 = leftEdge + gap;
      var lx2 = textLeft - gap;
      if (lx2 > lx1 + 2) { // only draw if there's meaningful space
        linesHtml += '<line x1="' + lx1.toFixed(1) + '" y1="' + lineY.toFixed(1) +
          '" x2="' + lx2.toFixed(1) + '" y2="' + lineY.toFixed(1) +
          '" stroke="' + strokeColor + '" stroke-width="' + lineStroke.toFixed(1) + '" />';
      }

      // Right filler: from textRight+gap to rightEdge-gap
      var rx1 = textRight + gap;
      var rx2 = rightEdge - gap;
      if (rx2 > rx1 + 2) {
        linesHtml += '<line x1="' + rx1.toFixed(1) + '" y1="' + lineY.toFixed(1) +
          '" x2="' + rx2.toFixed(1) + '" y2="' + lineY.toFixed(1) +
          '" stroke="' + strokeColor + '" stroke-width="' + lineStroke.toFixed(1) + '" />';
      }
    }

    if (linesHtml) {
      svgString = svgString.replace('</svg>', linesHtml + '</svg>');
    }
    return svgString;
  },

  // Stop words that should never stand alone on a row
  _STOP_WORDS: ['the','a','an','to','at','in','on','of','for','and','or','but',
                'is','it','my','no','so','by','up','do','be','we','us','if','as'],

  /**
   * Split text for square stamp layout.
   * @param {string} text - uppercased user text
   * @param {string} rowMode - '2up' (hero top), '2down' (hero bottom), '3' (equal 3-row)
   * @returns {{ lines: string[], fontScales: number[], rowMode: string }}
   */
  _splitForSquare(text, rowMode) {
    console.log('[SPLIT-SQ] called! text="' + text + '" rowMode=' + rowMode);
    var words = text.trim().split(/\s+/);
    rowMode = rowMode || '3'; // default to 3-row equal

    // Single word — split by syllable
    if (words.length === 1) {
      var syllables = this._splitSyllables(words[0]);
      if (syllables.length <= 1) return { lines: [text], fontScales: [1], rowMode: rowMode };

      if (rowMode === '3') {
        // Try 3-row syllable split
        if (syllables.length >= 3) {
          var lines3 = this._distributeSyllables(syllables, 3);
          return { lines: lines3, fontScales: [1, 1, 1], rowMode: '3' };
        }
        var lines2 = this._distributeSyllables(syllables, 2);
        return { lines: lines2, fontScales: [1, 1], rowMode: '3' };
      }
      // 2up/2down: split syllables into 2 rows with hero scaling
      var lines2 = this._distributeSyllables(syllables, 2);
      if (rowMode === '2up') {
        return { lines: lines2, fontScales: [3.0, 1.0], rowMode: '2up' };
      } else {
        return { lines: lines2, fontScales: [1.0, 3.0], rowMode: '2down' };
      }
    }

    // Multi-word: group stop words with direction based on rowMode
    var direction = (rowMode === '2down') ? 'backward' : 'forward';
    var chunks = this._groupStopWords(words, direction);
    if (chunks.length <= 1) {
      // All words in one chunk — fall back to word-level split
      if (words.length >= 2) {
        chunks = words.slice(); // each word is its own chunk
      } else {
        return { lines: [text], fontScales: [1], rowMode: rowMode };
      }
    }

    if (rowMode === '3') {
      return this._splitSquare3Row(chunks, words);
    }

    return this._splitSquare2Row(chunks, rowMode);
  },

  /**
   * 2-row hero split: hero row gets 2x font, other gets 1x.
   * rowMode '2up' = hero on top, '2down' = hero on bottom.
   */
  /**
   * Deterministic 2-row hero split.
   * 2up: first chunk = hero (2x), rest = small (1x)
   * 2down: last chunk = hero (2x), rest = small (1x)
   */
  _splitSquare2Row(chunks, rowMode) {
    if (chunks.length < 2) {
      // Can't split into 2 — return as single line
      return { lines: [chunks.join(' ')], fontScales: [1], rowMode: rowMode };
    }

    var line1, line2, scales;
    if (rowMode === '2up') {
      // Hero = first chunk, small = rest joined
      line1 = chunks[0];
      line2 = chunks.slice(1).join(' ');
      scales = [3.0, 1.0];
    } else {
      // Hero = last chunk, small = rest joined
      line1 = chunks.slice(0, -1).join(' ');
      line2 = chunks[chunks.length - 1];
      scales = [1.0, 3.0];
    }

    return { lines: [line1, line2], fontScales: scales, rowMode: rowMode };
  },

  /**
   * 3-row equal-font split. All rows get scale 1.0.
   * Tries to balance row lengths from chunks; falls back to word-level split.
   */
  _splitSquare3Row(chunks, words) {
    // If we have exactly 3 chunks, use them directly
    if (chunks.length === 3) {
      return { lines: [chunks[0], chunks[1], chunks[2]], fontScales: [1, 1, 1], rowMode: '3' };
    }

    // If 2 chunks, split the longer one by words to get 3 rows
    if (chunks.length === 2) {
      // Try splitting each chunk
      var best = null;
      var bestDiff = Infinity;
      for (var c = 0; c < 2; c++) {
        var cWords = chunks[c].split(/\s+/);
        if (cWords.length >= 2) {
          for (var w = 1; w < cWords.length; w++) {
            var part1 = cWords.slice(0, w).join(' ');
            var part2 = cWords.slice(w).join(' ');
            var lines = c === 0 ? [part1, part2, chunks[1]] : [chunks[0], part1, part2];
            var maxL = Math.max(lines[0].length, lines[1].length, lines[2].length);
            var minL = Math.min(lines[0].length, lines[1].length, lines[2].length);
            var diff = maxL - minL;
            if (diff < bestDiff) {
              bestDiff = diff;
              best = lines;
            }
          }
        }
      }
      if (best) return { lines: best, fontScales: [1, 1, 1], rowMode: '3' };
      // Can't split into 3 — use 2 rows with equal scaling
      return { lines: [chunks[0], chunks[1]], fontScales: [1, 1], rowMode: '3' };
    }

    // 4+ chunks: distribute into 3 groups
    var bestResult = null;
    var bestDiff = Infinity;
    for (var i = 1; i < chunks.length - 1; i++) {
      for (var j = i + 1; j < chunks.length; j++) {
        var lines = [
          chunks.slice(0, i).join(' '),
          chunks.slice(i, j).join(' '),
          chunks.slice(j).join(' ')
        ];
        var maxL = Math.max(lines[0].length, lines[1].length, lines[2].length);
        var minL = Math.min(lines[0].length, lines[1].length, lines[2].length);
        var diff = maxL - minL;
        if (diff < bestDiff) {
          bestDiff = diff;
          bestResult = { lines: lines, fontScales: [1, 1, 1], rowMode: '3' };
        }
      }
    }
    if (bestResult) return bestResult;

    // Final fallback: word-level distribution into 3
    if (words.length >= 3) {
      var lines = this._distributeSyllables(words, 3);
      return { lines: lines.map(function(l) { return l; }), fontScales: [1, 1, 1], rowMode: '3' };
    }
    return { lines: [words.join(' ')], fontScales: [1], rowMode: '3' };
  },

  /**
   * Group stop words with their nearest content word.
   * Stop words attach to the NEXT content word; trailing stop words attach to previous chunk.
   * Returns array of chunk strings.
   */
  /**
   * Group stop words with content words.
   * @param {string[]} words
   * @param {string} direction - 'forward' (stop→next content) or 'backward' (stop→prev content)
   */
  _groupStopWords(words, direction) {
    var stopSet = {};
    for (var i = 0; i < this._STOP_WORDS.length; i++) {
      stopSet[this._STOP_WORDS[i]] = true;
    }

    if (direction === 'backward') {
      // Backward: stop words attach to PREVIOUS content word
      var chunks = [];
      for (var i = 0; i < words.length; i++) {
        if (stopSet[words[i].toLowerCase()]) {
          // Attach to previous chunk if exists, otherwise start new pending
          if (chunks.length > 0) {
            chunks[chunks.length - 1] += ' ' + words[i];
          } else {
            chunks.push(words[i]); // leading stop word, will merge later
          }
        } else {
          chunks.push(words[i]);
        }
      }
      return chunks;
    }

    // Forward (default): stop words attach to NEXT content word
    var chunks = [];
    var pending = [];

    for (var i = 0; i < words.length; i++) {
      if (stopSet[words[i].toLowerCase()]) {
        pending.push(words[i]);
      } else {
        pending.push(words[i]);
        chunks.push(pending.join(' '));
        pending = [];
      }
    }

    // Trailing stop words: attach to last chunk
    if (pending.length > 0) {
      if (chunks.length > 0) {
        chunks[chunks.length - 1] += ' ' + pending.join(' ');
      } else {
        chunks.push(pending.join(' '));
      }
    }

    return chunks;
  },

  /**
   * Score a line grouping for square-ness with hero-word scaling.
   * Hero row (most characters) gets scale 2.0, others get 1.0.
   * If all rows are similar length (<20% difference), equal sizing.
   * Returns { lines, fontScales, score }.
   */
  _scoreSquareLayout(lines) {
    var maxChars = 0;
    var minChars = Infinity;
    lines.forEach(function(l) {
      if (l.length > maxChars) maxChars = l.length;
      if (l.length < minChars) minChars = l.length;
    });
    if (maxChars === 0) return { lines: lines, fontScales: lines.map(function() { return 1; }), score: Infinity };

    // If all rows are similar length (within 20%), use equal sizing
    var charRatio = minChars / maxChars;
    var useHero = charRatio < 0.8;

    var heroScale = useHero ? 2.0 : 1.0;
    var fontScales = lines.map(function(l) {
      return (useHero && l.length === maxChars) ? heroScale : 1.0;
    });

    // Total height: sum of row heights (scale × base line height factor)
    var totalHeight = 0;
    for (var i = 0; i < fontScales.length; i++) {
      totalHeight += fontScales[i] * 0.85;
    }
    var width = maxChars;

    // Aspect ratio — target ~1.4 for typical font proportions
    var aspect = width / totalHeight;
    var targetAspect = 1.4;
    var score = Math.abs(aspect - targetAspect);

    return { lines: lines, fontScales: fontScales, score: score };
  },

  /**
   * Distribute syllables across N rows, balancing line lengths.
   */
  _distributeSyllables(syllables, rows) {
    var totalLen = syllables.reduce(function(s, syl) { return s + syl.length; }, 0);
    var targetPerRow = totalLen / rows;
    var lines = [];
    var currentLine = '';
    var lineIdx = 0;

    for (var i = 0; i < syllables.length; i++) {
      var remaining = rows - lineIdx - 1;
      var syllablesLeft = syllables.length - i;
      // Force split if we need to save syllables for remaining rows
      if (remaining > 0 && syllablesLeft <= remaining) {
        if (currentLine) lines.push(currentLine);
        currentLine = syllables[i];
        lineIdx++;
        continue;
      }
      var newLine = currentLine + syllables[i];
      if (currentLine.length >= targetPerRow && lineIdx < rows - 1) {
        lines.push(currentLine);
        currentLine = syllables[i];
        lineIdx++;
      } else {
        currentLine = newLine;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
  },

  /**
   * Distribute words across N rows, balancing line lengths.
   */
  _distributeWords(words, rows) {
    var totalLen = words.reduce(function(s, w) { return s + w.length; }, 0) + words.length - 1;
    var targetPerRow = totalLen / rows;
    var lines = [];
    var currentLine = '';
    var lineIdx = 0;

    for (var i = 0; i < words.length; i++) {
      var remaining = rows - lineIdx - 1;
      var wordsLeft = words.length - i;
      if (remaining > 0 && wordsLeft <= remaining) {
        if (currentLine) lines.push(currentLine);
        currentLine = words[i];
        lineIdx++;
        continue;
      }
      var newLine = currentLine ? currentLine + ' ' + words[i] : words[i];
      if (currentLine.length >= targetPerRow && lineIdx < rows - 1) {
        lines.push(currentLine);
        currentLine = words[i];
        lineIdx++;
      } else {
        currentLine = newLine;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
  },

  /**
   * @param {string} svgString - cleaned SVG string
   * @param {number} textIndex - 0-based index of <text> element
   * @param {string} newText - replacement text
   * @returns {string} - modified SVG string
   */
  replaceTextInString(svgString, textIndex, newText, forceLines) {
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
          : this.splitTextIntoLines(caseAdjusted, forceLines);

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
          var fontWeightMatch = originalAttrs.match(/font-weight=["'][^"']*["']/);
          if (fillMatch) tspanStyle += ' ' + fillMatch[0];
          if (fontFamilyMatch) tspanStyle += ' font-family="' + fontFamilyMatch[1] + '"';
          // NOTE: font-size deliberately NOT copied to tspans — tspans must inherit
          // from the <text> element so that _setTextAttribute(font-size) works correctly.
          // Copying font-size here would override the autoFit-computed size.
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
  // Measurement cache: avoids re-creating iframe for same template with different frameMode
  _autoFitMeasureCache: null,

  async autoFitTextInString(svgString, textIndex, maxWidth, originalFontSize, originalScaleX, frameMode, fillType, cornerType, borderType, stampShape, rowsMode) {
    originalScaleX = originalScaleX || 1;
    frameMode = frameMode || 'single';

    // ============================================================
    // CATEGORY DETECTION: Check if this is a Fixed Frame template
    // Category 2 = has <image> element (illustrated background)
    // Category 1 = no image (simple rect-based frame)
    // ============================================================
    var hasImage = /<image[^>]*>/i.test(svgString);
    var isFixedFrame = hasImage;

    if (isFixedFrame) {
      // Category 2: always auto-fit using container rect from SVG (no bounding_width needed)
      return this._autoFitTextFixedFrame(svgString, textIndex, maxWidth, originalFontSize, originalScaleX);
    }

    // Category 1 requires bounding_width from database
    if (!maxWidth || maxWidth <= 0) return svgString;

    // Check measurement cache — reuse if same SVG (avoids iframe for variant calls)
    // Key includes: font-family + actual tspan text content (prevents stale hits across different user texts)
    var cacheFont = (svgString.match(/font-family=["']'?([^"']+)'?["']/) || [])[1] || '';
    var cacheTextContent = '';
    var cacheTextMatches = svgString.match(/<tspan[^>]*>([^<]*)<\/tspan>/gi);
    if (cacheTextMatches) {
      for (var ci = 0; ci < cacheTextMatches.length; ci++) {
        cacheTextContent += cacheTextMatches[ci].replace(/<[^>]+>/g, '');
      }
    }
    var cacheKey = svgString.length + '_' + textIndex + '_' + cacheFont + '_' + cacheTextContent.substring(0, 40) + '_' + svgString.slice(0, 80);
    if (this._autoFitMeasureCache && this._autoFitMeasureCache.key === cacheKey) {
      return this._applyAutoFitSizing(svgString, textIndex, maxWidth, originalFontSize, originalScaleX, frameMode, this._autoFitMeasureCache, fillType, cornerType, borderType, null, stampShape, rowsMode);
    }

    // Category 1: Dynamic Frame - TEXT-FIRST approach
    // Create an HTML wrapper with fonts to measure text accurately.
    // IMPORTANT: Use absolute URLs for @font-face src — blob documents cannot resolve
    // root-relative URLs like "/fonts/...". Without absolute URLs, only Oswald loads
    // (via Google Fonts CDN link) and all other fonts fall back to browser defaults,
    // producing identical (wrong) measurements across different fonts.
    var _fontBase = window.location.origin;
    var htmlDoc = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
      '<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@200;300;400;500;600;700&display=swap" rel="stylesheet">' +
      '<style>' +
      '@font-face{font-family:"Oswald";src:url("' + _fontBase + '/fonts/Oswald-Medium.ttf") format("truetype");font-weight:500;}' +
      '@font-face{font-family:"Montserrat";src:url("' + _fontBase + '/fonts/Montserrat-Bold.ttf") format("truetype");font-weight:700;}' +
      '@font-face{font-family:"Nunito";src:url("' + _fontBase + '/fonts/Nunito-Black.ttf") format("truetype");font-weight:900;}' +
      '@font-face{font-family:"BlackOpsOne";src:url("' + _fontBase + '/fonts/BlackOpsOne-Regular.ttf") format("truetype");font-weight:400;}' +
      '@font-face{font-family:"CourierPrime";src:url("' + _fontBase + '/fonts/CourierPrime-Regular.ttf") format("truetype");font-weight:400;}' +
      '@font-face{font-family:"Yomogi";src:url("' + _fontBase + '/fonts/Yomogi-Regular.ttf") format("truetype");font-weight:400;}' +
      '@font-face{font-family:"Bitter";src:url("' + _fontBase + '/fonts/Bitter-Medium.ttf") format("truetype");font-weight:500;}' +
      '@font-face{font-family:"Exo2";src:url("' + _fontBase + '/fonts/Exo2-Bold.ttf") format("truetype");font-weight:700;}' +
      '@font-face{font-family:"Comfortaa";src:url("' + _fontBase + '/fonts/Comfortaa-Bold.ttf") format("truetype");font-weight:700;}' +
      '@font-face{font-family:"FuzzyBubbles";src:url("' + _fontBase + '/fonts/FuzzyBubbles-Bold.ttf") format("truetype");font-weight:700;}' +
      '@font-face{font-family:"BebasNeue";src:url("' + _fontBase + '/fonts/BebasNeue-Regular.ttf") format("truetype");font-weight:400;}' +
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
      var resolved = false;
      function safeResolve(val) {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        resolve(val);
      }

      // Safety timeout: if iframe/fonts never load, resolve with original SVG after 10s
      var timeoutId = setTimeout(function () {
        console.warn('autoFitTextInString timed out after 10s — returning original SVG');
        try { document.body.removeChild(iframe); } catch (e) {}
        URL.revokeObjectURL(url);
        safeResolve(svgString);
      }, 10000);

      iframe.onerror = function () {
        console.warn('autoFitTextInString iframe failed to load');
        try { document.body.removeChild(iframe); } catch (e) {}
        URL.revokeObjectURL(url);
        safeResolve(svgString);
      };

      iframe.onload = function () {
        // Wait for fonts to load before measuring
        function doMeasure() {
        try {
          var svgDoc = iframe.contentDocument;
          var textEls = svgDoc.querySelectorAll('text');
          var textEl = textEls[textIndex];

          if (!textEl) {
            safeResolve(svgString);
            return;
          }

          // For multi-line text (<tspan> children), measure the longest line
          var tspans = textEl.querySelectorAll('tspan');
          var measuredWidth;
          var perTspanWidths = []; // per-row widths for 2full mode
          if (tspans.length > 1) {
            measuredWidth = 0;
            for (var ti = 0; ti < tspans.length; ti++) {
              var tw = tspans[ti].getComputedTextLength();
              perTspanWidths.push(tw);
              if (tw > measuredWidth) measuredWidth = tw;
            }
          } else {
            measuredWidth = textEl.getComputedTextLength();
          }

          // Measure actual ink bounding box for precise height and centering
          var bbox = textEl.getBBox();

          // Canvas measureText for actual ink bounds (per-font, per-text accurate)
          var canvasAscent = 0;
          var canvasDescent = 0;
          var canvasMeasureFontSize = 0;
          var canvasInkLeft = 0;
          var canvasInkRight = 0;
          var canvasAdvanceWidth = 0;
          try {
            var cs = iframe.contentWindow.getComputedStyle(textEl);
            var ff = (cs.fontFamily || textEl.getAttribute('font-family') || 'sans-serif')
                     .replace(/^['"]|['"]$/g, '');
            var fw = cs.fontWeight || textEl.getAttribute('font-weight') || '400';
            var fsPx = parseFloat(cs.fontSize) || parseFloat(textEl.getAttribute('font-size')) || 100;
            canvasMeasureFontSize = fsPx;

            // Measure each tspan (or full text) — take max ascent/descent across lines
            var tspanEls = textEl.querySelectorAll('tspan');
            var texts = [];
            if (tspanEls.length > 0) {
              for (var ci = 0; ci < tspanEls.length; ci++) texts.push(tspanEls[ci].textContent || '');
            } else {
              texts.push(textEl.textContent || '');
            }

            var canvas = svgDoc.createElement('canvas');
            canvas.width = 1; canvas.height = 1;
            var ctx = canvas.getContext('2d');
            ctx.font = fw + ' ' + fsPx + 'px ' + ff;

            for (var mi = 0; mi < texts.length; mi++) {
              var lt = texts[mi].trim();
              if (!lt) continue;
              var met = ctx.measureText(lt);
              if (typeof met.actualBoundingBoxAscent === 'number') {
                canvasAscent = Math.max(canvasAscent, met.actualBoundingBoxAscent);
                canvasDescent = Math.max(canvasDescent, met.actualBoundingBoxDescent);
              }
              // Horizontal ink bounds for centering correction (use widest line)
              if (typeof met.actualBoundingBoxLeft === 'number' && met.width > canvasAdvanceWidth) {
                canvasInkLeft = met.actualBoundingBoxLeft;
                canvasInkRight = met.actualBoundingBoxRight;
                canvasAdvanceWidth = met.width;
              }
            }
            // Measure reference "H" for diacritic symmetrization
            // (base cap metrics without diacritics, used to mirror diacritic space equally above/below)
            var refMet = ctx.measureText('H');
            var canvasRefAscent = (typeof refMet.actualBoundingBoxAscent === 'number') ? refMet.actualBoundingBoxAscent : canvasAscent;
            var canvasRefDescent = (typeof refMet.actualBoundingBoxDescent === 'number') ? refMet.actualBoundingBoxDescent : canvasDescent;
          } catch (canvasErr) {
            console.warn('Canvas measureText failed, will use fontSize fallback:', canvasErr);
          }

          // Cache measurements for reuse with different frameMode values
          SvgRenderer._autoFitMeasureCache = {
            key: cacheKey,
            measuredWidth: measuredWidth,
            bbox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
            numTspans: tspans.length,
            canvasAscent: canvasAscent,
            canvasDescent: canvasDescent,
            canvasRefAscent: canvasRefAscent,
            canvasRefDescent: canvasRefDescent,
            canvasMeasureFontSize: canvasMeasureFontSize,
            canvasInkLeft: canvasInkLeft,
            canvasInkRight: canvasInkRight,
            canvasAdvanceWidth: canvasAdvanceWidth,
            perTspanWidths: perTspanWidths
          };

          // remeasureFn: re-measure text at any font size while iframe is still alive.
          // This gives exact rendered width at the TARGET size, eliminating estimation error.
          var remeasureFn = null;
          try {
            var rmTextEl = svgDoc.querySelectorAll('text')[textIndex];
            if (rmTextEl) {
              remeasureFn = function(targetFontSize, targetLetterSpacing) {
                try {
                  rmTextEl.setAttribute('font-size', targetFontSize);
                  // Also set font-size on tspans (tspan font-size overrides text element)
                  var rmTspans = rmTextEl.querySelectorAll('tspan');
                  for (var ti = 0; ti < rmTspans.length; ti++) {
                    rmTspans[ti].setAttribute('font-size', targetFontSize);
                  }
                  if (targetLetterSpacing > 0) {
                    rmTextEl.setAttribute('letter-spacing', targetLetterSpacing);
                  } else {
                    rmTextEl.removeAttribute('letter-spacing');
                  }
                  var w;
                  if (rmTspans.length > 1) {
                    w = 0;
                    for (var ri = 0; ri < rmTspans.length; ri++) {
                      w = Math.max(w, rmTspans[ri].getComputedTextLength());
                    }
                  } else {
                    w = rmTextEl.getComputedTextLength();
                  }
                  // getBBox captures glyph visual overshoot beyond advance width
                  // (decorative fonts like BlackOpsOne extend past their advance cells)
                  try {
                    var bbox = rmTextEl.getBBox();
                    if (bbox && bbox.width > w) w = bbox.width;
                  } catch(e2) {}
                  return { width: w };
                } catch (e) { return null; }
              };
            }
          } catch (e) {}

          safeResolve(SvgRenderer._applyAutoFitSizing(svgString, textIndex, maxWidth, originalFontSize, originalScaleX, frameMode, SvgRenderer._autoFitMeasureCache, fillType, cornerType, borderType, remeasureFn, stampShape, rowsMode));
          return;

        } catch (e) {
          console.error('autoFitText measurement failed:', e, e.stack);
          safeResolve(svgString);
        } finally {
          document.body.removeChild(iframe);
          URL.revokeObjectURL(url);
        }
        } // end doMeasure

        // Explicitly load the specific font face before relying on generic fonts.ready
        // (fonts.ready can resolve before all font faces are actually available)
        var explicitFontLoad = Promise.resolve();
        try {
          var svgDoc2 = iframe.contentDocument;
          var te = svgDoc2.querySelector('text');
          if (te && svgDoc2.fonts && svgDoc2.fonts.load) {
            var tcs = iframe.contentWindow.getComputedStyle(te);
            var tff = (tcs.fontFamily || te.getAttribute('font-family') || '').replace(/['"]/g, '');
            var tfw = tcs.fontWeight || te.getAttribute('font-weight') || '400';
            if (tff) explicitFontLoad = svgDoc2.fonts.load(tfw + ' 100px "' + tff + '"').catch(function(){});
          }
        } catch(e) {}

        // Wait for fonts before measuring (3s timeout prevents hanging on stuck font loads)
        var fontsReady = (iframe.contentDocument && iframe.contentDocument.fonts)
          ? iframe.contentDocument.fonts.ready
          : Promise.resolve();
        fontsReady = explicitFontLoad.then(function() { return fontsReady; });
        Promise.race([fontsReady, new Promise(function(r) { setTimeout(r, 3000); })])
          .then(function() { setTimeout(doMeasure, 50); })
          .catch(function() { setTimeout(doMeasure, 50); });
      };

      iframe.src = url;
    });
  },

  /**
   * Compute per-side inset from outer rect edge to the clear text interior.
   * Single source of truth — uses same geometry as addDoubleFrame / addSplitBorder / border generators.
   * @param {number} sw - outer stroke width
   * @param {Object} borderFlags - {stitch, wavy, wavyStrong, border, brush, filter, borderRadius, filterDisplacement}
   * @param {string} frameMode - 'single', 'double', or 'split'
   * @param {string} cornerType - 'straight', 'soft_round', etc.
   * @param {string} fillType - 'full' or 'empty'
   * @returns {number} per-side inset in SVG units
   */
  computeTextZone: function(sw, borderFlags, frameMode, cornerType, fillType) {
    var isFull = fillType === 'full';
    var totalInset;

    if (frameMode === 'double') {
      // Unified formula — mirrors addDoubleFrame's inset calculation exactly
      var innerSw = Math.max(6, Math.round(sw * 0.36));
      // Predict innerEdge (same values border generators store as data-border-inner-edge)
      var predictedInnerEdge;
      if (borderFlags.stitch) predictedInnerEdge = -10;           // shapes sit on rect edge, pull inner rect closer
      else if (borderFlags.wavy) {
        var depth = (borderFlags.wavyStrong || borderFlags.wavyZigzag) ? 20 : 7;
        predictedInnerEdge = depth + 20;                          // depth + wavySw/2 (wavySw~40)
      } else if (borderFlags.border) {
        predictedInnerEdge = Math.max(15, sw / 2.8);                         // undo 1.4x scaling to match plain-equivalent
      } else {
        predictedInnerEdge = sw / 2;                              // plain, filter, perfLine
      }
      var whiteGap = isFull ? 2 : innerSw;
      // Filled stamps: ensure minimum predicted inset matches addDoubleFrame
      if (isFull) predictedInnerEdge = Math.max(predictedInnerEdge, sw * 0.3);
      // inset to inner rect center + innerSw/2 for text inside inner stroke
      totalInset = predictedInnerEdge + whiteGap + innerSw * 0.5;

    } else {
      // --- Single frame + split (split adds thin white stroke inside outer border,
      //     decorative elements stay in same positions — text zone is identical) ---
      if (borderFlags.wavy) {
        var wavySw = 40; // base stroke for both wavy and zigzag
        var depth = (borderFlags.wavyStrong || borderFlags.wavyZigzag) ? 20 : 7;
        totalInset = depth + wavySw / 2;
      } else if (borderFlags.brush) {
        // Brush templates have sw=0 (brush <g> is the border, not rect stroke)
        // Brush strokes intrude ~35px visually from rect edge
        totalInset = Math.max(35, sw * 1.5);
      } else if (borderFlags.filter) {
        // Filter displacement creates ragged edges; chalk needs more interior clearance
        var fDisp = borderFlags.filterDisplacement || 20;
        totalInset = borderFlags.filterChalk ? fDisp * 1.2 : fDisp * 0.5;
      } else if (borderFlags.border) {
        totalInset = Math.max(sw / 2, borderFlags.borderRadius || 10);
      } else if (borderFlags.stitch) {
        // Stitch shapes extend OUTWARD from rect edge; rect stroke is set to "none".
        // But visually the shapes crowd the interior — need some breathing room.
        totalInset = 15;
      } else {
        totalInset = sw / 2; // plain border
      }
      // Filled single: stroke merges with fill (same color), so the visual border
      // is less prominent — text can extend closer to the edge.
      if (isFull) {
        totalInset *= 0.25;
      }
      // Stitch shapes crowd visually regardless of fill — enforce minimum
      if (borderFlags.stitch) {
        totalInset = Math.max(totalInset, 15);
      }
    }

    // Corner compensation: rounded corners eat into rectangular space
    if (cornerType && cornerType !== 'straight') {
      var CORNER_RX = {
        soft_round: 35, medium_round: 80, strong_round: 120,
        mixed_top_straight: 120, mixed_top_round: 120,
        mixed_diag_down: 120, mixed_diag_up: 120
      };
      var outerRx = CORNER_RX[cornerType] || 0;
      var innerRx = Math.max(0, outerRx - totalInset);
      totalInset += Math.max(0, innerRx * 0.30);
    }

    return totalInset;
  },

  /**
   * Apply font sizing and rect wrapping using cached measurements.
   * Separated from autoFitTextInString so it can be called per frame variant
   * without re-running the expensive iframe measurement.
   * @param {string} svgString
   * @param {number} textIndex
   * @param {number} maxWidth - bounding_width from database
   * @param {number} originalFontSize
   * @param {number} originalScaleX
   * @param {string} frameMode - 'single', 'double', or 'split'
   * @param {Object} measurements - cached {measuredWidth, bbox, numTspans}
   * @param {string} fillType - 'full' (filled) or 'empty' (outlined)
   * @param {string} cornerType - corner radius type
   * @param {Function|null} remeasureFn - optional closure to re-measure text at target font size (iframe must be alive)
   * @returns {string} modified SVG string
   */
  _applyAutoFitSizing: function(svgString, textIndex, maxWidth, originalFontSize, originalScaleX, frameMode, measurements, fillType, cornerType, borderType, remeasureFn, stampShape, rowsMode) {
    var measuredWidth = measurements.measuredWidth;
    var bbox = measurements.bbox;
    // Use actual tspan count from SVG (not cached) — cache may be stale after row changes
    var numTspans = (svgString.match(/<tspan/gi) || []).length || 1;
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

    // Detect border type from SVG attributes (single source of truth)
    var borderFlags = {
      stitch: /data-stitch=/i.test(svgString),
      wavy: /data-wavy=/i.test(svgString),
      wavyStrong: /data-wavy=["']strong["']/i.test(svgString),
      wavyZigzag: /data-wavy=["']zigzag["']/i.test(svgString),
      border: /data-border=/i.test(svgString),
      brush: /data-brush-border=/i.test(svgString),
      filter: /data-filter=/i.test(svgString)
    };
    if (borderFlags.border) {
      var bm = svgString.match(/data-border=["']\w+-(\d+)/i);
      borderFlags.borderRadius = bm ? parseFloat(bm[1]) : 10;
    }
    if (borderFlags.filter) {
      var fm = svgString.match(/data-filter=["'](?:ripped|chalk)-(\d+)["']/i);
      borderFlags.filterDisplacement = fm ? parseFloat(fm[1]) : 20;
      borderFlags.filterChalk = /data-filter=["']chalk/i.test(svgString);
    }
    // Supplement borderFlags from database metadata (SVG may lack data attributes)
    if (!borderFlags.brush && borderType === 'brushstroke') borderFlags.brush = true;
    if (!borderFlags.filter && borderType === 'torn_edge') {
      borderFlags.filter = true;
      borderFlags.filterDisplacement = 20;
    }
    if (!borderFlags.wavy && borderType === 'wavy') {
      borderFlags.wavy = true;
    }
    if (!borderFlags.wavy && borderType === 'zigzag') {
      borderFlags.wavy = true;
      borderFlags.wavyZigzag = true;
    }
    if (!borderFlags.border && (borderType === 'perforated' || borderType === 'perforated_spaced' || borderType === 'sawtooth')) {
      borderFlags.border = true;
      borderFlags.borderRadius = borderType === 'perforated_spaced' ? 25 : 20;
    }
    if (!borderFlags.stitch && borderType && borderType.indexOf('stitch_') === 0) {
      borderFlags.stitch = true;
    }
    // Perforation line styles (mid-stroke circles/diamonds on plain stroke)
    if (borderType === 'perf_line') borderFlags.perfLine = 'circle-20-2.5';
    if (borderType === 'perf_line_spaced') borderFlags.perfLine = 'circle-25-4';
    if (borderType === 'saw_line') borderFlags.perfLine = 'diamond-20-2';
    frameMode = frameMode || 'single';

    // Per-font adjustments from config (loaded from /data/font-config.json)
    var fontFamilyMatch = svgString.match(/font-family=["']'?([^"']+)'?["']/);
    var detectedFont = fontFamilyMatch ? fontFamilyMatch[1] : '';
    var textCase = SvgRenderer._detectTextCase(svgString);
    var fc = SvgRenderer._getFontConfig(detectedFont, textCase);
    var fontScaleY = fc.scaleY;
    var fontLetterSpacing = fc.letterSpacing;
    // Square stamps: read per-font tuning from square config
    var sqCfg = null;
    if (stampShape === 'square') {
      var sqRowModeMatch = svgString.match(/data-sq-rowmode=["']([^"']+)["']/);
      var sqRowMode = sqRowModeMatch ? sqRowModeMatch[1] : 'hero2up';
      sqCfg = SvgRenderer._getSquareConfig(detectedFont, sqRowMode);
      fontLetterSpacing = sqCfg.heroSpacing;
    }
    var fontTune = { dx: fc.dx, dy: fc.dy, wb: fc.wb, hb: fc.hb, ws: fc.ws || 0, lineSpacing: fc.lineSpacing || 1.0, stroke: fc.stroke || 0 };
    // Letter-spacing is absolute in SVG (doesn't scale with font size).
    // Track it separately so the ratio calculation only scales char widths.
    var lsExtra = 0;
    if (fontLetterSpacing > 0 && measuredWidth > 0) {
      var tspanTexts = svgString.match(/<tspan[^>]*>([^<]*)<\/tspan>/gi) || [];
      var maxChars = 0;
      tspanTexts.forEach(function(t) {
        var inner = t.replace(/<[^>]+>/g, '');
        if (inner.length > maxChars) maxChars = inner.length;
      });
      if (maxChars === 0) {
        var textContentM = svgString.match(/<text[^>]*>([^<]*)<\/text>/i);
        if (textContentM) maxChars = textContentM[1].length;
      }
      if (maxChars > 1) {
        lsExtra = fontLetterSpacing * (maxChars - 1);
      }
    }

    // Compute text target width using computeTextZone (reference stroke, capped at 30 for plain)
    var swExtract = svgString.match(/<rect[^>]*stroke-width=["']([\d.]+)["']/i);
    var estStrokeW = swExtract ? parseFloat(swExtract[1]) : 0;
    var isPlainBorder = !borderFlags.stitch && !borderFlags.wavy && !borderFlags.border &&
                        !borderFlags.brush && !borderFlags.filter;
    // Cap stroke for plain borders; filter only in single frame (double frame needs full sw for inner rect)
    var capStroke = isPlainBorder || (borderFlags.filter && frameMode === 'single');
    var refSw = capStroke ? Math.min(estStrokeW, 30) : estStrokeW;
    // Zigzag: ensure minimum sw for initial sizing (Supabase SVGs may lack stroke-width)
    if (borderFlags.border && refSw < 30) refSw = 30;
    var refInnerGap = 10; // base breathing room for effectiveMaxWidth computation
    var refInset = SvgRenderer.computeTextZone(refSw, borderFlags, frameMode, cornerType, fillType || 'full');
    var effectiveMaxWidth = actualRectWidth - 2 * (refInset + refInnerGap);

    // Calculate ratio based on measured width vs effective max width
    // Subtract absolute letter-spacing from available width (LS doesn't scale with font)
    if (measuredWidth > 0) {
      var charAvailWidth = Math.max(10, effectiveMaxWidth - lsExtra);
      var ratio = charAvailWidth / measuredWidth;

      var minFontSize = originalFontSize * 0.4;
      var maxFontSize = originalFontSize * 3;  // cap at 3x original to prevent runaway sizing
      var newFontSize = Math.min(originalFontSize * ratio, maxFontSize);

      // Height constraint: stamp shouldn't be taller than wide
      var heightAtNewFont = bbox.height * (newFontSize / originalFontSize);
      if (heightAtNewFont > effectiveMaxWidth) {
        newFontSize = newFontSize * (effectiveMaxWidth / heightAtNewFont);
      }
      var newScaleX = originalScaleX;

      if (newFontSize < minFontSize) {
        newFontSize = minFontSize;
        // At min font size, calculate horizontal compression
        var widthAtMinFont;
        if (remeasureFn) {
          var rmMin = remeasureFn(minFontSize, fontLetterSpacing);
          widthAtMinFont = (rmMin && rmMin.width > 0) ? rmMin.width : measuredWidth * (minFontSize / originalFontSize) + lsExtra;
        } else {
          widthAtMinFont = measuredWidth * (minFontSize / originalFontSize) + lsExtra;
        }
        if (widthAtMinFont > effectiveMaxWidth) {
          newScaleX = originalScaleX * (effectiveMaxWidth / widthAtMinFont);
        }
      }


      // Proportional stroke: thick for short text (small stamp), thin for long text (large stamp)
      // Short text → high fontRatio (font scales up) → thick border (visual weight on compact stamp)
      // Long text → low fontRatio (font stays small) → thin border (doesn't overwhelm wide stamp)
      var fontRatioForProportional = newFontSize / originalFontSize;  // 0.4 to 3.0
      var rowBoost = 1 + (Math.max(1, numTspans) - 1) * 0.4; // more rows = bigger stamp = thicker border
      var proportionalSw = fontRatioForProportional * 20 * rowBoost;  // unclamped; per-family min/max below
      // Square stamps: 2.85x thicker border (compensates lower base to match original 30*1.9)
      if (stampShape === 'square') proportionalSw *= 2.85;

      // Apply font-size change in the string
      var result = svgString;
      result = SvgRenderer._setTextAttribute(result, textIndex, 'font-size', newFontSize.toFixed(2));
      // Strip font-size from tspans so they inherit from <text> element.
      // Without this, tspans with their own font-size override the autoFit-computed size,
      // causing text to render wider than measured → right-side clipping.
      result = result.replace(/<tspan([^>]*)\s+font-size=["'][^"']*["']/gi, '<tspan$1');

      // Apply transform scaleX change if needed
      if (newScaleX !== originalScaleX || fontScaleY !== 1) {
        var currentTransform = SvgRenderer._getTextAttribute(result, textIndex, 'transform');
        if (currentTransform && /matrix\(/.test(currentTransform)) {
          var newTransform = currentTransform.replace(
            /matrix\(\s*[\d.]+/,
            'matrix(' + newScaleX.toFixed(4)
          );
          result = SvgRenderer._setTextAttribute(result, textIndex, 'transform', newTransform);
        } else {
          // No existing matrix transform — create one with scaleX + scaleY
          result = SvgRenderer._setTextAttribute(result, textIndex, 'transform',
            'matrix(' + newScaleX.toFixed(4) + ' 0 0 ' + fontScaleY.toFixed(4) + ' 0 0)');
        }
      }

      // ============================================================
      // TEXT-FIRST APPROACH: Position text at viewBox center, then
      // resize/reposition rects to wrap around the text
      // ============================================================

      // Get viewBox dimensions - this is our reference frame
      var vbMatch = result.match(/viewBox=["']\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*["']/);
      if (!vbMatch) {
        return result;
      }
      var vbX = parseFloat(vbMatch[1]);
      var vbY = parseFloat(vbMatch[2]);
      var vbW = parseFloat(vbMatch[3]);
      var vbH = parseFloat(vbMatch[4]);

      // STEP 1: Calculate text dimensions
      var numLines = numTspans > 1 ? numTspans : 1;
      // Line height: use actual ink bounds (ascent+descent) when available,
      // so diacritics (cedilla ș/ț, accents) don't overlap between rows
      var lineHeight;
      if (measurements.canvasAscent > 0 && measurements.canvasMeasureFontSize > 0) {
        var lhScale = newFontSize / measurements.canvasMeasureFontSize;
        var inkLineHeight = (measurements.canvasAscent + measurements.canvasDescent) * lhScale * 1.05;
        lineHeight = Math.max(inkLineHeight, newFontSize * 1.15);
      } else {
        lineHeight = newFontSize * 1.15;
      }
      lineHeight *= fontTune.lineSpacing;
      var fontRatioCalc = newFontSize / originalFontSize;
      // STEP 1b: textBlockHeight from canvas ink measurements (accurate per-font, per-text)
      var hasCanvasMetrics = measurements.canvasAscent > 0 && measurements.canvasMeasureFontSize > 0;

      // Symmetrize diacritic space: when diacritics extend in only one direction
      // (e.g. cedilla below but nothing above), mirror the extension to both sides
      // so the base text stays visually centered regardless of diacritic direction.
      var symAscent = measurements.canvasAscent;
      var symDescent = measurements.canvasDescent;
      if (hasCanvasMetrics && measurements.canvasRefAscent > 0) {
        var diacUp = Math.max(0, measurements.canvasAscent - measurements.canvasRefAscent);
        var diacDown = Math.max(0, measurements.canvasDescent - measurements.canvasRefDescent);
        var maxDiac = Math.max(diacUp, diacDown);
        symAscent = measurements.canvasRefAscent + maxDiac;
        symDescent = measurements.canvasRefDescent + maxDiac;
      }

      var textBlockHeight;
      if (numLines === 1) {
        if (hasCanvasMetrics) {
          var canvasScale = newFontSize / measurements.canvasMeasureFontSize;
          textBlockHeight = (symAscent + symDescent) * canvasScale;
        } else {
          // Fallback: generous fontSize ratio
          textBlockHeight = newFontSize * 0.85;
        }
      } else {
        if (hasCanvasMetrics) {
          var canvasScale = newFontSize / measurements.canvasMeasureFontSize;
          var singleH = (symAscent + symDescent) * canvasScale;
          textBlockHeight = (numLines - 1) * lineHeight + singleH;
        } else {
          textBlockHeight = (numLines - 1) * lineHeight + newFontSize * 0.85;
        }
      }
      // Exact text width via remeasureFn (measures at target font size in live iframe)
      // Falls back to linear estimation when iframe is gone (gallery variants)
      var exactWidth = null;
      if (remeasureFn) {
        var rm = remeasureFn(newFontSize, fontLetterSpacing);
        if (rm && rm.width > 0) exactWidth = rm.width;
      }
      // Gallery variant fallback: use cached re-measurement scaled linearly
      if (exactWidth === null && measurements.remeasuredWidth > 0) {
        exactWidth = measurements.remeasuredWidth * (newFontSize / measurements.remeasuredFontSize);
      }

      var textBlockWidth;
      var estimatedWidth = (measuredWidth * fontRatioCalc + lsExtra) * newScaleX;
      if (exactWidth !== null) {
        // Exact: remeasured width already includes letter-spacing
        textBlockWidth = exactWidth * newScaleX;
        // Cache for gallery variant reuse
        measurements.remeasuredWidth = exactWidth;
        measurements.remeasuredFontSize = newFontSize;
      } else {
        // Estimation fallback (no iframe, no cached re-measurement)
        textBlockWidth = estimatedWidth;
      }
      // wb: breathing room multiplier (per-font, calibrated via admin tuning).
      // No floor — each font's wb is trusted as-is for full admin control.
      textBlockWidth *= fontTune.wb;

      // Per-font word-spacing: count spaces in longest line, adjust block width
      var wordSpacingPx = 0;
      if (fontTune.ws !== 0) {
        wordSpacingPx = fontTune.ws * newFontSize;
        var longestText = '';
        var wsTexts = svgString.match(/<tspan[^>]*>([^<]*)<\/tspan>/gi) || [];
        wsTexts.forEach(function(t) {
          var inner = t.replace(/<[^>]+>/g, '');
          if (inner.length > longestText.length) longestText = inner;
        });
        if (!longestText) {
          var wsM = svgString.match(/<text[^>]*>([^<]*)<\/text>/i);
          if (wsM) longestText = wsM[1];
        }
        var numSpaces = (longestText.match(/ /g) || []).length;
        textBlockWidth += numSpaces * wordSpacingPx;
      }
      textBlockHeight *= fontScaleY * fontTune.hb;  // stretch rect for vertically scaled fonts + per-font height bias

      // Text stroke extends visually beyond glyph bounds by strokeWidth/2 per side.
      // Thick stroke (positive) expands text; thin stroke (negative) contracts — no compensation needed.
      // Outlined variants with stroke=0 get auto +2 from applyThinStroke.
      var effectiveStroke = SvgRenderer._computeProportionalStroke(fontTune.stroke, newFontSize);
      if (effectiveStroke === 0 && fillType === 'empty') effectiveStroke = 2;
      if (effectiveStroke > 0) {
        textBlockWidth += effectiveStroke;
        textBlockHeight += effectiveStroke;
      }

      // STEP 2: Inside-out rect wrapping
      // Inner gap: proportional breathing room — larger font (short text) gets more gap
      // Square stamps use minimal padding for tight, punchy look
      // Square + single: tight gap (1) for punchy look. Square + double: standard gap (10)
      // because the inner rect stroke needs breathing room around text.
      var baseGap = (stampShape === 'square' && frameMode !== 'double') ? 1 : (stampShape === 'square' ? 20 : 10);
      var hInnerGap = stampShape === 'square' ? baseGap : Math.max(baseGap, Math.round(fontRatioForProportional * 10));
      var vInnerGap = stampShape === 'square' ? baseGap : Math.max(baseGap, Math.round(fontRatioForProportional * 10));

      // Recompute text zone with actual stroke for rect padding (clamped per-family)
      var swMin = (stampShape === 'square') ? 20 : Math.round(20 * rowBoost);
      var swMax = (stampShape === 'square') ? 80 : Math.round(60 * rowBoost);
      var actualSw = capStroke ? Math.max(swMin, Math.min(swMax, proportionalSw)) : estStrokeW;
      // Border (sawtooth/perforated): match actual outerRectSw formula
      var bFloor2 = stampShape === 'square' ? 60 : Math.round(35 * rowBoost);
      if (borderFlags.border) actualSw = Math.max(bFloor2, Math.min(swMax, proportionalSw * 1.4));
      // Perf_line: match its outerRectSw formula
      var plFloor2 = stampShape === 'square' ? 60 : Math.round(35 * rowBoost);
      if (borderFlags.perfLine) actualSw = Math.max(plFloor2, Math.min(swMax, proportionalSw * 1.5));
      var actualInset;
      if (frameMode === 'double') {
        // Inline double-frame inset: mirrors addDoubleFrame exactly using clampedPropSw
        // (same value addDoubleFrame reads from data-prop-sw), eliminating prediction errors
        var isFull = fillType === 'full';
        var dfSw = Math.max(swMin, Math.min(swMax, proportionalSw));
        var dfInnerSw = Math.max(6, Math.round(dfSw * (isFull ? 0.24 : 0.36)));
        var dfWhiteGap = isFull ? 2 : dfInnerSw;
        var dfInnerEdge;
        if (borderFlags.stitch) dfInnerEdge = -10;
        else if (borderFlags.wavy) {
          var wDepth = (borderFlags.wavyStrong || borderFlags.wavyZigzag) ? 20 : 7;
          dfInnerEdge = wDepth + 20; // depth + wavySw/2 (~40/2)
        } else if (borderFlags.border) {
          dfInnerEdge = 25; // perforated/sawtooth inner-to-outer rect gap
        } else {
          dfInnerEdge = dfSw / 2; // plain, filter, perfLine — matches addDoubleFrame fallback
        }
        if (isFull) dfInnerEdge = Math.max(dfInnerEdge, dfSw * 0.3);
        actualInset = dfInnerEdge + dfWhiteGap + dfInnerSw * 0.5;
      } else {
        // Single/split: use computeTextZone prediction (already accurate for Frame A)
        actualInset = SvgRenderer.computeTextZone(actualSw, borderFlags, frameMode, cornerType, fillType || 'full');
        // Multi-row filter borders: displacement is more visible on taller stamps
        if (borderFlags.filter && numTspans > 1) {
          actualInset *= 1 + (numTspans - 1) * 1.0;
        }
      }
      // Per-border text gap override for square + double
      var textGap = hInnerGap;
      if (stampShape === 'square' && frameMode === 'double') {
        textGap = 30; // default for square+double (plain, perf line, zigzag, torn edge, chalk)
        if (borderFlags.wavy && !borderFlags.wavyZigzag) textGap = 35; // wavy gentle/strong
        if (borderFlags.border) textGap = 35; // perforated, sawtooth
        if (borderFlags.stitch) textGap = 20; // stitch stays tight
      }
      var hPadding = textGap + actualInset;
      var vPadding = textGap + actualInset;
      // For multi-line: cap vertical padding to match visible inter-line whitespace.
      // lineHeight includes ink, so the visible gap between lines ≈ lineHeight * 0.5.
      // Skip cap for "2 Full" — rows are tall, needs full padding like single-line.
      if (numLines > 1 && rowsMode !== '2full') {
        var maxVPad = lineHeight * 0.5;
        if (vPadding > maxVPad) {
          vInnerGap = Math.max(0, maxVPad - actualInset);
          vPadding = vInnerGap + actualInset;
        }
      }
      // 1-row square: boost horizontal padding so text doesn't touch edges
      if (stampShape === 'square' && numLines <= 1 && rowsMode !== 'full') {
        hPadding = Math.max(hPadding, textBlockWidth * 0.06);
      }
      var newRectWidth = textBlockWidth + hPadding * 2;
      var newRectHeight = textBlockHeight + vPadding * 2;

      // Square shape enforcement: if text is still single-line, split it now
      // Skip when rowsMode='1' (explicit 1 row) or 'full' with forceLines=1 (Full + 1 row = Hi-style, not split)
      var sqSkipSplit = (rowsMode === '1') || (rowsMode === 'full' && numLines <= 1);
      if (stampShape === 'square' && numLines <= 1 && !sqSkipSplit) {
        console.log('[SQ-INLINE-ENTER] numLines=' + numLines + ' numTspans=' + numTspans);
        // Read rowMode from data attribute (set by gallery.js), default to '2up'
        var rmMatch = result.match(/data-sq-rowmode="([^"]+)"/);
        var sqRowMode = rmMatch ? rmMatch[1] : '2up';
        // Extract current text from tspans or text element
        var sqTextMatch = result.match(/<tspan[^>]*>([^<]*)<\/tspan>/i);
        var sqRawText = sqTextMatch ? sqTextMatch[1] : '';
        if (!sqRawText) {
          // Try bare text content
          var bareMatch = result.match(/<text[^>]*>([^<]+)<\/text>/i);
          sqRawText = bareMatch ? bareMatch[1] : '';
        }
        sqRawText = sqRawText.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        console.log('[SQ-INLINE-TEXT] extracted="' + sqRawText + '" len=' + sqRawText.trim().length);
        if (sqRawText.trim().length > 1) {
          var sqSplitResult = SvgRenderer._splitForSquare(sqRawText.trim(), sqRowMode);
          if (sqSplitResult.lines.length > 1) {
            // Rebuild text element with multi-line tspans
            var sqNewContent = '';
            for (var sli = 0; sli < sqSplitResult.lines.length; sli++) {
              var sqLineEsc = sqSplitResult.lines[sli].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
              sqNewContent += '<tspan x="0" dy="0">' + sqLineEsc + '</tspan>';
            }
            // Replace text content (between <text...> and </text>)
            result = result.replace(/(<text[^>]*>)([\s\S]*?)(<\/text>)/i, '$1' + sqNewContent + '$3');
            // Add data attributes for scales
            if (!result.match(/data-sq-scales=/)) {
              result = result.replace(/<svg/, '<svg data-sq-scales="' + sqSplitResult.fontScales.join(',') + '"');
            }
            // Recount lines and tspans
            numLines = sqSplitResult.lines.length;
            numTspans = sqSplitResult.lines.length;
            console.log('[SQ-SPLIT-INLINE] split "' + sqRawText + '" into ' + numLines + ' lines, mode=' + sqRowMode);
          }
        }
      }

      // Full Hi scale: 2x vertical stretch for 1-row full mode (square or rect 1A)
      var _sqFullHiScale = 1;

      // Square shape enforcement (old gallery path): only for gallery-injected sq-scales
      // Product page uses the Hero block in the 2Full section instead
      var _sqComputedFontSizes = null;
      var _sqHeroIdx = 0;
      if (stampShape === 'square' && numLines > 1 && result.match(/data-sq-scales=/)) {
        // Extract per-row text
        var sqTspanTexts = [];
        result.replace(/<tspan[^>]*>([^<]*)<\/tspan>/gi, function(m, t) {
          sqTspanTexts.push(t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
        });

        // Find hero row from scales
        var sqScalesMatch = result.match(/data-sq-scales="([^"]+)"/);
        var sqScales = sqScalesMatch ? sqScalesMatch[1].split(',').map(Number) : null;
        var maxScale = 1;
        if (sqScales) {
          for (var si = 0; si < sqScales.length; si++) {
            if (sqScales[si] > maxScale) { maxScale = sqScales[si]; _sqHeroIdx = si; }
          }
        }
        var smallIdx = (_sqHeroIdx === 0) ? 1 : 0;

        // Admin config values (visual transforms only — don't affect layout math)
        var _hScY = sqCfg ? sqCfg.heroScaleY : 1.10;
        var _hScX = sqCfg ? (sqCfg.heroScaleX || 1.0) : 1.0;
        var _sScY = sqCfg ? (sqCfg.smallScaleY || 1.0) : 1.0;
        var _sScX = sqCfg ? (sqCfg.smallScaleX || 1.0) : 1.0;
        var _lineSp = sqCfg ? sqCfg.rowGap : 0;

        // Character width estimation from measured single-line width
        var allChars = sqTspanTexts.join('');
        var avgCharWidth = measuredWidth / (allChars.length || 1);
        var smallChars = sqTspanTexts[smallIdx] ? sqTspanTexts[smallIdx].length : 1;
        var heroChars = sqTspanTexts[_sqHeroIdx] ? sqTspanTexts[_sqHeroIdx].length : 1;

        // Square side = max of current rect dimensions
        var squareSide = Math.max(newRectWidth, newRectHeight);
        var capH = 0.72; // base cap height for layout math (no scaleY!)
        var pad = squareSide * 0.01; // 1% padding each side
        var innerSize = squareSide - pad * 2; // available inner space (both W and H)

        // === HERO IS MASTER ===
        // Step 1: Size hero to fill available height
        // Hero gets 40% of inner height at default (user scales up with scaleY)
        var heroFontSize = (innerSize * 0.40) / capH;
        var heroBaseWidth = heroChars * avgCharWidth * (heroFontSize / newFontSize);
        var heroVisH = heroFontSize * capH; // layout height (no scaleY!)

        // Step 2: Small row matches hero's visual width
        // small font = heroVisualWidth / (smallChars × avgCharWidth) × newFontSize
        var heroVisualWidth = heroBaseWidth; // hero width at heroFontSize
        var smallFontSize = (heroVisualWidth / (smallChars * avgCharWidth)) * newFontSize;
        smallFontSize = Math.max(smallFontSize, heroFontSize * 0.1); // min 10%
        var smallVisH = smallFontSize * capH; // layout height (no scaleY!)

        // Step 3: Line gap
        var lineGap = _lineSp;

        // Step 4: Total block height (layout only, no scaleY)
        var totalBlockH = heroVisH + lineGap + smallVisH;

        // Step 5: If block too tall, shrink hero proportionally
        if (totalBlockH > innerSize) {
          var shrink = innerSize / totalBlockH;
          heroFontSize *= shrink;
          heroVisH = heroFontSize * capH;
          heroBaseWidth = heroChars * avgCharWidth * (heroFontSize / newFontSize);
          heroVisualWidth = heroBaseWidth;
          smallFontSize = (heroVisualWidth / (smallChars * avgCharWidth)) * newFontSize;
          smallFontSize = Math.max(smallFontSize, heroFontSize * 0.1);
          smallVisH = smallFontSize * capH;
          totalBlockH = heroVisH + lineGap + smallVisH;
        }

        // Step 6: Build font sizes array
        _sqComputedFontSizes = [];
        for (var si = 0; si < numLines; si++) {
          _sqComputedFontSizes.push(si === _sqHeroIdx ? heroFontSize : smallFontSize);
        }
        // Store for dy section
        var _sqTotalBlockH = totalBlockH;
        var _sqHeroVisH = heroVisH;
        var _sqSmallVisH = smallVisH;
        var _sqLineGap = lineGap;

        newRectWidth = squareSide;
        newRectHeight = squareSide;
        newFontSize = heroFontSize;
        textBlockWidth = innerWidth;
        textBlockHeight = totalBlockH;
        lineHeight = heroFontSize * 1.15;

        // Apply per-tspan font-size, stroke-width, letter-spacing
        // Apply per-tspan: font-size × scaleY, stroke, spacing, scaleX via textLength
        // ScaleY multiplied into font-size (makes text taller)
        // Stroke scaled inversely so it doesn't thicken with font size
        var _propStroke = SvgRenderer._computeProportionalStroke(fc.stroke || 0, newFontSize);
        var _hSpace = sqCfg ? sqCfg.heroSpacing : 2;
        var _sSpace = sqCfg ? sqCfg.smallSpacing : 2;
        var tspanFontIdx = 0;
        result = result.replace(/<tspan([^>]*)>/gi, function(match, attrs) {
          if (tspanFontIdx < _sqComputedFontSizes.length) {
            var fs = _sqComputedFontSizes[tspanFontIdx];
            var isHero = (tspanFontIdx === _sqHeroIdx);
            tspanFontIdx++;
            attrs = attrs.replace(/\s*font-size=["'][^"']*["']/gi, '');
            attrs = attrs.replace(/\s*stroke-width=["'][^"']*["']/gi, '');
            attrs = attrs.replace(/\s*letter-spacing=["'][^"']*["']/gi, '');
            attrs = attrs.replace(/\s*stroke=["'][^"']*["']/gi, '');
            attrs = attrs.replace(/\s*textLength=["'][^"']*["']/gi, '');
            attrs = attrs.replace(/\s*lengthAdjust=["'][^"']*["']/gi, '');
            var scX = isHero ? _hScX : _sScX;
            var scY = isHero ? _hScY : _sScY;
            var strokeW = _propStroke;
            var spacing = isHero ? _hSpace : _sSpace;
            // ScaleY: multiply into font-size (taller text)
            var effectiveFs = fs * scY;
            // ScaleX: use textLength to stretch/compress horizontally
            var rowText = sqTspanTexts[isHero ? _sqHeroIdx : smallIdx] || '';
            var naturalWidth = rowText.length * avgCharWidth * (fs / newFontSize);
            var stretchedWidth = naturalWidth * scX;
            var extra = '';
            if (scX !== 1.0) {
              extra += ' textLength="' + stretchedWidth.toFixed(1) + '" lengthAdjust="spacingAndGlyphs"';
            }
            if (strokeW > 0) {
              extra += ' stroke-width="' + strokeW.toFixed(1) + '"';
            }
            if (spacing !== 0) {
              extra += ' letter-spacing="' + spacing.toFixed(1) + '"';
            }
            return '<tspan' + attrs + ' font-size="' + effectiveFs.toFixed(2) + '"' + extra + '>';
          }
          return match;
        });

        result = SvgRenderer._setTextAttribute(result, textIndex, 'font-size', heroFontSize.toFixed(2));
      } else if (stampShape === 'square') {
        // Single line square: force square rect
        var squareSide = Math.max(newRectWidth, newRectHeight);
        newRectWidth = squareSide;
        newRectHeight = squareSide;
        // Full + 1 row: Hi-style — extra scaleY for taller text, textLength fills width
        if (rowsMode === 'full' && numLines <= 1) {
          var sqInner = squareSide - Math.max(hPadding + squareSide * 0.02, squareSide * 0.08) * 2;
          // Dynamic scaleY: fill available inner height, cap at 2.0
          var currentTextH = textBlockHeight * (fontScaleY || 1);
          _sqFullHiScale = currentTextH > 0 ? Math.min(sqInner / currentTextH, 2.0) : 2.0;
          // textLength forces width to fill square
          result = result.replace(/<tspan([^>]*)>/gi, function(match, attrs) {
            attrs = attrs.replace(/\s*textLength=["'][^"']*["']/gi, '');
            attrs = attrs.replace(/\s*lengthAdjust=["'][^"']*["']/gi, '');
            return '<tspan' + attrs + ' textLength="' + sqInner.toFixed(2) + '" lengthAdjust="spacingAndGlyphs">';
          });
        }
        // Stamp square layout for decorative lines
        if (numLines <= 1) {
          var vis1H = textBlockHeight * (fontScaleY || 1) * (_sqFullHiScale || 1);
          var sq1Pad = Math.max(hPadding + squareSide * 0.02, squareSide * 0.08);
          result = result.replace(/<svg/, '<svg data-sq-pad="' + sq1Pad.toFixed(1) + '" data-sq-vis-h="' + vis1H.toFixed(1) + '" data-sq-side="' + squareSide.toFixed(1) + '"');
        }
      }

      // Rectangle 1A: double text height via scaleY (same concept as square Hi-style)
      if (stampShape !== 'square' && rowsMode === 'full' && numLines <= 1) {
        _sqFullHiScale = 2.0;
        newRectHeight = textBlockHeight * 2 + vPadding * 2;
      }

      // Square hero: ALWAYS equalize row widths via per-row font sizes
      var _2fullFontSizes = null;
      if (stampShape === 'square' && numLines >= 2) {
        // Part A: compute per-row font sizes (always for square)
        var perWidths = measurements.perTspanWidths;
        var heroWidths = [];
        var heroTotalChars = 0;
        var fullTspanTexts = [];
        result.replace(/<tspan[^>]*>([^<]*)<\/tspan>/gi, function(m, t) {
          fullTspanTexts.push(t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
        });
        for (var hi = 0; hi < numLines; hi++) heroTotalChars += (fullTspanTexts[hi] || '').length;
        var avgCW = heroTotalChars > 0 ? measuredWidth / heroTotalChars : 1;

        var heroMaxW = 0;
        for (var hi = 0; hi < numLines; hi++) {
          var hw = (perWidths && perWidths[hi] > 0) ? perWidths[hi] : ((fullTspanTexts[hi] || '').length * avgCW);
          heroWidths.push(hw);
          if (hw > heroMaxW) heroMaxW = hw;
        }

        var inkRatio = 0.72;
        if (measurements.canvasAscent > 0 && measurements.canvasMeasureFontSize > 0) {
          inkRatio = (symAscent + symDescent) / measurements.canvasMeasureFontSize;
        }
        var squareSide = Math.max(newRectWidth, newRectHeight);
        var sqPad = Math.max(hPadding + squareSide * 0.02, squareSide * 0.08);
        // Split inner dimensions: independent h/v control for asymmetric border intrusion
        // 3-row: tighter vertical padding to give more room for short row
        var vSqPad = (numLines >= 2 && rowsMode !== 'full') ? sqPad * 0.7 : sqPad;
        var innerH = squareSide - vSqPad * 2;
        var hSqPadAdj = 0;
        var innerW = squareSide - (sqPad + hSqPadAdj) * 2;
        var sqGapFactor = 0.04;
        var measureFs = measurements.canvasMeasureFontSize || newFontSize;

        // Stroke overhead for height calculations
        var propStroke = SvgRenderer._computeProportionalStroke(fontTune.stroke, newFontSize);
        var strokeAdd = propStroke * 2; // stroke extends both up and down
        var _sq3RowHalfH = 0; // stored for dy positioning (pre-scaleY half-height)

        // Per-row font sizing: longest-first cascade
        // 1. Sort lines by width (longest first)
        // 2. Longest fills square width → determines its font size
        // 3. Deduct ink height from available vertical space
        // 4. Next line: font size = min(fill-width, fit-remaining-height)
        // 5. Repeat for all lines
        _2fullFontSizes = [];
        var _sqShortIdx = -1;
        var targetH = innerH / (fontScaleY || 1); // pre-compensate for scaleY

        // Build sorted index array (longest width first)
        var sortedIndices = [];
        for (var hi = 0; hi < numLines; hi++) sortedIndices.push(hi);
        sortedIndices.sort(function(a, b) { return heroWidths[b] - heroWidths[a]; });
        // Track shortest row for textLength skip
        _sqShortIdx = sortedIndices[sortedIndices.length - 1];

        // Initialize font sizes array
        for (var hi = 0; hi < numLines; hi++) _2fullFontSizes.push(0);

        // Check if all rows are similar width (within 20%) → equal sizing instead of cascade
        var widthRatio = heroWidths[sortedIndices[0]] > 0
          ? heroWidths[sortedIndices[sortedIndices.length - 1]] / heroWidths[sortedIndices[0]] : 1;
        var equalMode = (widthRatio > 0.8);

        if (equalMode) {
          // Equal sizing: all rows get same font size, constrained by height
          // totalH = numLines * (fs * inkRatio + strokeAdd) + (numLines-1) * fs * sqGapFactor
          //        = fs * (numLines * inkRatio + (numLines-1) * sqGapFactor) + numLines * strokeAdd
          var equalFs = (targetH - numLines * strokeAdd) / (numLines * inkRatio + (numLines - 1) * sqGapFactor);
          for (var hi = 0; hi < numLines; hi++) {
            // Also cap by width
            var fsByW = measureFs * (innerW / (heroWidths[hi] || 1));
            _2fullFontSizes[hi] = Math.min(equalFs, fsByW);
          }
        } else {
          // Cascade: longest first, each constrained by remaining height
          var remainingH = targetH;
          var remainingRows = numLines;
          for (var si = 0; si < sortedIndices.length; si++) {
            var idx = sortedIndices[si];
            var rowW = heroWidths[idx] || 1;
            var fsByWidth = measureFs * (innerW / rowW);
            // Height constraint: this row gets its fair share of remaining space
            var gapH = remainingRows > 1 ? fsByWidth * sqGapFactor : 0;
            var maxHForRow = remainingH / remainingRows;
            var fsByHeight = Math.max((maxHForRow - strokeAdd - gapH) / inkRatio, measureFs * 0.1);
            var finalFs = Math.min(fsByWidth, fsByHeight);
            _2fullFontSizes[idx] = finalFs;
            var consumedH = finalFs * inkRatio + strokeAdd + (remainingRows > 1 ? finalFs * sqGapFactor : 0);
            remainingH -= consumedH;
            remainingRows--;
          }
        }

        if (numLines === 3) {
          _sq3RowHalfH = innerH / (2 * (fontScaleY || 1));
        }

        // Height constraint: shrink if total exceeds available
        function heroBlockHeight(sizes) {
          var h = 0, maxFs = 0;
          for (var i = 0; i < sizes.length; i++) {
            h += sizes[i] * inkRatio + strokeAdd;
            if (sizes[i] > maxFs) maxFs = sizes[i];
          }
          h += maxFs * sqGapFactor * (sizes.length - 1);
          return h;
        }
        var heroH = heroBlockHeight(_2fullFontSizes);
        var visualH = heroH * (fontScaleY || 1);
        if (visualH > innerH && visualH > 0) {
          var shrink = innerH / visualH;
          for (var hi = 0; hi < _2fullFontSizes.length; hi++) {
            _2fullFontSizes[hi] *= shrink;
          }
          heroH = heroBlockHeight(_2fullFontSizes);
        }

        textBlockHeight = heroH;
        newRectWidth = squareSide;
        newRectHeight = squareSide;

        // Part B: Full compensation
        if (rowsMode === 'full') {
          // Scale hero font sizes to fill square height + capped textLength fills width
          var visualH2 = heroBlockHeight(_2fullFontSizes) * (fontScaleY || 1);
          if (visualH2 > 0 && Math.abs(visualH2 - innerH) > 1) {
            var scaleFactor = innerH / visualH2;
            for (var hi = 0; hi < _2fullFontSizes.length; hi++) {
              _2fullFontSizes[hi] *= scaleFactor;
            }
            heroH = heroBlockHeight(_2fullFontSizes);
            textBlockHeight = heroH;
          }
          // Calculated scaleY boost: textLength fills width exactly to innerW,
          // but font-size fills height only to inkRatio precision (systematic underestimation).
          // Boost scaleY by inverse of ink coverage ratio to match textLength's exact fill.
          var rawInkH = 0;
          for (var hi = 0; hi < _2fullFontSizes.length; hi++) {
            rawInkH += _2fullFontSizes[hi] * inkRatio;
          }
          rawInkH *= (fontScaleY || 1);
          if (rawInkH > 0) {
            _sqFullHiScale = (innerH / rawInkH) * 0.92; // 8% breathing room
          }
        }

        // Stamp text block height for decorative lines (visual height including scaleY)
        var visualBlockH = textBlockHeight * (fontScaleY || 1) * (_sqFullHiScale || 1);
        result = result.replace(/<svg/, '<svg data-sq-pad="' + vSqPad.toFixed(1) + '" data-sq-vis-h="' + visualBlockH.toFixed(1) + '" data-sq-side="' + squareSide.toFixed(1) + '"');

        // Apply per-tspan font-size (always)
        var tspanIdx2f = 0;
        var maxStretchRatio = numLines >= 4 ? 1.5 : (numLines >= 3 ? 2.0 : 2.5);
        result = result.replace(/<tspan([^>]*)>/gi, function(match, attrs) {
          if (tspanIdx2f < _2fullFontSizes.length) {
            var fs = _2fullFontSizes[tspanIdx2f];
            var ci = tspanIdx2f++;
            attrs = attrs.replace(/\s*font-size=["'][^"']*["']/gi, '');
            attrs = attrs.replace(/\s*textLength=["'][^"']*["']/gi, '');
            attrs = attrs.replace(/\s*lengthAdjust=["'][^"']*["']/gi, '');
            // Full: add textLength to fill square width (capped)
            // Apply textLength in full mode. Skip short row only for 3+ rows (stays natural width).
            var tlAttr = '';
            if (rowsMode === 'full' && (numLines <= 2 || ci !== _sqShortIdx)) {
              var naturalW = heroWidths[ci] * (fs / measureFs);
              var stretchRatio = naturalW > 0 ? innerW / naturalW : 1;
              var cappedTL = Math.min(stretchRatio, maxStretchRatio) * naturalW;
              tlAttr = ' textLength="' + cappedTL.toFixed(2) + '" lengthAdjust="spacingAndGlyphs"';
            }
            return '<tspan' + attrs + ' font-size="' + fs.toFixed(2) + '"' + tlAttr + '>';
          }
          return match;
        });
      }

      // "Fat" mode: stretch shorter rows horizontally to match longest row width.
      // Same font-size for all rows — only textLength changes (letters look wider/fatter).
      var _fatMode = (rowsMode === 'full' && numLines >= 2 && stampShape !== 'square');
      if (_fatMode) {
        var perWidths = measurements.perTspanWidths;
        if (perWidths && perWidths.length >= numLines && measurements.canvasMeasureFontSize > 0) {
          // Find longest row width (at measured font size), scale to target font size
          var fatScale = newFontSize / measurements.canvasMeasureFontSize;
          var fatWidths = [];
          var fatMaxW = 0;
          for (var fi = 0; fi < numLines; fi++) {
            var fw = (perWidths[fi] || 0) * fatScale;
            fatWidths.push(fw);
            if (fw > fatMaxW) fatMaxW = fw;
          }
          // Apply textLength to each tspan, capping stretch at 2.5×
          var fatIdx = 0;
          result = result.replace(/<tspan([^>]*)>/gi, function(match, attrs) {
            var ci = fatIdx++;
            if (ci < fatWidths.length && fatMaxW > 0) {
              var ratio = fatMaxW / (fatWidths[ci] || fatMaxW);
              if (ratio > 1.05) { // only stretch if meaningfully shorter
                if (ratio > 2.5) ratio = 2.5; // cap distortion
                var tl = (fatWidths[ci] * ratio).toFixed(2);
                // Strip any existing textLength/lengthAdjust
                attrs = attrs.replace(/\s*textLength=["'][^"']*["']/gi, '');
                attrs = attrs.replace(/\s*lengthAdjust=["'][^"']*["']/gi, '');
                return '<tspan' + attrs + ' textLength="' + tl + '" lengthAdjust="spacingAndGlyphs">';
              }
            }
            return match;
          });
          // Rect width based on longest row (textBlockWidth stays as-is from normal sizing)
        }
      }

      // Aspect ratio enforcement: compress wide one-liners horizontally
      // to produce less squat stamps. Without this, wide fonts (Montserrat,
      // Comfortaa) produce extreme landscape ratios that appear tiny in the
      // fixed-ratio card. Max 15% compression.
      var aspectCompressX = 1;
      if (numLines <= 1) {
        var stampAspect = newRectHeight / newRectWidth;
        var minAspect = 0.22;
        if (stampAspect < minAspect) {
          var targetRectW = newRectHeight / minAspect;
          var targetTextW = targetRectW - hPadding * 2;
          if (targetTextW > 0 && textBlockWidth > 0) {
            aspectCompressX = targetTextW / textBlockWidth;
            aspectCompressX = Math.max(aspectCompressX, 0.85); // cap at 15%
            textBlockWidth *= aspectCompressX;
            newRectWidth = textBlockWidth + hPadding * 2;
          }
        }
      }

      // STEP 3: Position text at viewBox center (FIXED reference point)
      var viewBoxCenterX = vbX + vbW / 2;
      var viewBoxCenterY = vbY + vbH / 2;

      // For multi-line text with tspans
      if (numTspans > 1) {
        if (_sqComputedFontSizes && _sqComputedFontSizes.length > 1) {
          // Square: center the 2-row block as a whole
          // Layout uses base capH=0.72 — NO scaleY (scaleY is visual only)
          var sqCapH = 0.72;
          var sqBlockH = _sqTotalBlockH; // already computed without scaleY

          // First row cap height in px (layout, no scaleY)
          var firstCapPx = _sqComputedFontSizes[0] * sqCapH;

          // Center: first baseline dy = -(totalBlockH/2) + firstCapH
          var sqFirstDy = -(sqBlockH / 2) + firstCapPx;

          // Second row dy = baseline-to-baseline distance
          var firstDescPx = _sqComputedFontSizes[0] * 0.05;
          var secondCapPx = _sqComputedFontSizes[1] * sqCapH;
          var sqSecondDy = firstDescPx + (_sqLineGap || 0) + secondCapPx;

          // Apply admin dX/dY offsets per row
          var _heroDx = sqCfg ? (sqCfg.heroDx || 0) : 0;
          var _heroDy = sqCfg ? (sqCfg.heroDy || 0) : 0;
          var _smallDx = sqCfg ? (sqCfg.smallDx || 0) : 0;
          var _smallDy = sqCfg ? (sqCfg.smallDy || 0) : 0;

          var sqLineIdx = 0;
          result = result.replace(/<tspan([^>]*?)dy=["']([\d.\-]+)["']/gi, function () {
            var before = arguments[1];
            var isHeroRow = (sqLineIdx === _sqHeroIdx);
            var dyOffset = isHeroRow ? _heroDy : _smallDy;
            var dyVal = ((sqLineIdx === 0) ? sqFirstDy : sqSecondDy) + dyOffset;
            sqLineIdx++;
            return '<tspan' + before + 'dy="' + dyVal.toFixed(2) + '"';
          });

          // Apply dX offsets to tspan x attributes
          if (_heroDx !== 0 || _smallDx !== 0) {
            var sqXIdx = 0;
            result = result.replace(/<tspan([^>]*?)\bx=["']([\d.\-]+)["']/gi, function (_match, before, xVal) {
              var isHeroRow = (sqXIdx === _sqHeroIdx);
              var dxOffset = isHeroRow ? _heroDx : _smallDx;
              sqXIdx++;
              return '<tspan' + before + 'x="' + (parseFloat(xVal) + dxOffset).toFixed(2) + '"';
            });
          }
        } else if (_2fullFontSizes && _2fullFontSizes.length >= 2) {
          // Hero mode: N rows with per-row font sizes, center the block vertically
          var inkR = 0.72;
          if (measurements.canvasAscent > 0 && measurements.canvasMeasureFontSize > 0) {
            inkR = (symAscent + symDescent) / measurements.canvasMeasureFontSize;
          }
          var ascentR = hasCanvasMetrics ? symAscent / measurements.canvasMeasureFontSize : inkR * 0.9;
          var descentR = hasCanvasMetrics ? symDescent / measurements.canvasMeasureFontSize : inkR * 0.1;
          // Compute total block height: sum of ink heights + gaps
          var heroMaxFs = 0;
          for (var hi = 0; hi < _2fullFontSizes.length; hi++) {
            if (_2fullFontSizes[hi] > heroMaxFs) heroMaxFs = _2fullFontSizes[hi];
          }
          var gap2f = heroMaxFs * (stampShape === 'square' ? 0.04 : 0.08);
          var total2f = 0;
          for (var hi = 0; hi < _2fullFontSizes.length; hi++) {
            total2f += _2fullFontSizes[hi] * inkR;
            if (hi < _2fullFontSizes.length - 1) total2f += gap2f;
          }
          // Compute per-row dy values: first row positions block, subsequent rows are baseline-to-baseline
          // Account for fontScaleY: visual block height = total2f * fontScaleY
          // dy is in pre-transform space, so offset = visualTotal / (2 * fontScaleY) = total2f / 2
          // But the matrix ty is at viewBoxCenterY (not adjusted for scaleY), so we need:
          var heroDyVals = [];
          if (_sq3RowHalfH > 0 && _2fullFontSizes.length === 3) {
            // 3-row spread: BACK at top, SCHOOL at bottom, TO centered between
            var halfH = _sq3RowHalfH;
            var bl0 = -halfH + _2fullFontSizes[0] * ascentR; // first baseline: cap top at inner top
            var bl2 = halfH - _2fullFontSizes[2] * descentR; // last baseline: descent bottom at inner bottom
            // Center TO's ink in the gap between BACK's bottom and SCHOOL's top
            var gapTop = bl0 + _2fullFontSizes[0] * descentR; // bottom of BACK
            var gapBot = bl2 - _2fullFontSizes[2] * ascentR; // top of SCHOOL
            var bl1 = (gapTop + gapBot) / 2 + _2fullFontSizes[1] * (ascentR - descentR) / 2; // center TO's ink
            heroDyVals.push(bl0);
            heroDyVals.push(bl1 - bl0);
            heroDyVals.push(bl2 - bl1);
          } else {
            // 2-row: center the block
            heroDyVals.push(-(total2f / 2) + _2fullFontSizes[0] * ascentR);
            for (var hi = 1; hi < _2fullFontSizes.length; hi++) {
              heroDyVals.push(_2fullFontSizes[hi - 1] * descentR + gap2f + _2fullFontSizes[hi] * ascentR);
            }
          }

          var lineIdx2f = 0;
          result = result.replace(/<tspan([^>]*?)dy=["']([\d.\-]+)["']/gi, function () {
            var before = arguments[1];
            var dyVal = lineIdx2f < heroDyVals.length ? heroDyVals[lineIdx2f] : 0;
            lineIdx2f++;
            return '<tspan' + before + 'dy="' + dyVal.toFixed(2) + '"';
          });
        } else {
          // Standard uniform dy for rectangles/lined
          var totalSpan = (numLines - 1) * lineHeight;
          var firstDy = -totalSpan / 2 + newFontSize * 0.39;

          var lineIdx = 0;
          result = result.replace(/<tspan([^>]*?)dy=["']([\d.\-]+)["']/gi, function () {
            var before = arguments[1];
            var dyVal = (lineIdx === 0) ? firstDy : lineHeight;
            lineIdx++;
            return '<tspan' + before + 'dy="' + dyVal.toFixed(2) + '"';
          });
        }

        // Set tspan x="0" - in the transformed coordinate system, x=0 is the center
        result = result.replace(/<tspan([^>]*?)\bx=["'][\d.\-]+["']/gi, function (_match, before) {
          return '<tspan' + before + 'x="0"';
        });
      }

      // STEP 4: Position text at viewBox center
      var curTransform = SvgRenderer._getTextAttribute(result, textIndex, 'transform');
      if (curTransform) {
        var mMatch = curTransform.match(/matrix\(\s*([\d.\-]+)[,\s]+([\d.\-]+)[,\s]+([\d.\-]+)[,\s]+([\d.\-]+)[,\s]+([\d.\-]+)[,\s]+([\d.\-]+)\s*\)/);
        if (mMatch) {
          // Canvas-based baseline offset: place baseline so ink center = viewBoxCenterY
          var baselineOffset;
          if (numTspans <= 1) {
            if (hasCanvasMetrics) {
              var canvasScale = newFontSize / measurements.canvasMeasureFontSize;
              // Use ACTUAL ascent/descent (not symmetric) so the ink center aligns with rect center.
              // symAscent/symDescent are symmetric (maxDiac added to both sides), which cancels out
              // in the subtraction and ignores diacritic direction. Using actual measurements means:
              //   only-above diacritics → shifts text down to center ink
              //   only-below diacritics → shifts text up to center ink
              //   both directions → roughly same as before
              var scaledAscent = measurements.canvasAscent * canvasScale;
              var scaledDescent = measurements.canvasDescent * canvasScale;
              baselineOffset = (scaledAscent - scaledDescent) / 2;
            } else {
              baselineOffset = newFontSize * 0.36;  // fallback: assume caps-like center
            }
          } else {
            baselineOffset = 0;
          }
          // Horizontal ink centering: text-anchor="middle" centers ADVANCE width,
          // but ink bounds may be asymmetric (e.g. "A" has more right sidebearing).
          // Correct so the ink center aligns with viewBox center.
          var inkHorizCorrection = 0;
          if (hasCanvasMetrics && measurements.canvasAdvanceWidth > 0) {
            var canvasScale = newFontSize / measurements.canvasMeasureFontSize;
            // Offset = how far ink center is LEFT of advance center (positive = shift right)
            var inkOffset = (measurements.canvasAdvanceWidth + measurements.canvasInkLeft - measurements.canvasInkRight) / 2;
            var matrixScaleX = parseFloat(mMatch[1]) || 1;
            inkHorizCorrection = inkOffset * canvasScale * matrixScaleX * aspectCompressX;
          }
          // Square Full: textLength handles width exactly, skip ink/dx corrections that shift text off-center
          var hNudge = (_2fullFontSizes && stampShape === 'square' && rowsMode === 'full') ? 0 : inkHorizCorrection + fontTune.dx * newFontSize;
          var newTx = viewBoxCenterX + hNudge;
          // Square hero: dy positioning is self-centering, skip fontTune.dy nudge
          var dyNudge = (_2fullFontSizes && stampShape === 'square') ? 0 : fontTune.dy * newFontSize;
          var effectiveSy = fontScaleY * (_sqFullHiScale || 1);
          var newTy = viewBoxCenterY + baselineOffset * effectiveSy + dyNudge;
          var finalSx = (parseFloat(mMatch[1]) * aspectCompressX).toFixed(4);
          var effectiveScaleY = fontScaleY * (_sqFullHiScale || 1);
          var sy = effectiveScaleY !== 1 ? effectiveScaleY.toFixed(4) : mMatch[4];
          var newMat = 'matrix(' + finalSx + ' ' + mMatch[2] + ' ' + mMatch[3] + ' ' + sy + ' ' + newTx.toFixed(4) + ' ' + newTy.toFixed(4) + ')';
          result = SvgRenderer._setTextAttribute(result, textIndex, 'transform', newMat);
        }
      }

      // Stamp row center Y positions for decorative flanking lines
      if (_2fullFontSizes && heroDyVals && heroDyVals.length >= 2) {
        var rcSy = fontScaleY * (_sqFullHiScale || 1);
        var rcTy = (typeof newTy !== 'undefined') ? newTy : viewBoxCenterY;
        var rowCenters = [];
        var cumDyRC = 0;
        for (var rci = 0; rci < heroDyVals.length; rci++) {
          cumDyRC += heroDyVals[rci];
          var baselineY = rcTy + cumDyRC * rcSy;
          var inkCenterY = baselineY - _2fullFontSizes[rci] * 0.35 * rcSy;
          rowCenters.push(inkCenterY);
        }
        // Stamp effective row widths (textLength if applied, else natural scaled width)
        var rowWidths = [];
        var _tlWidths = []; // populated during tspan rewrite above
        result.replace(/<tspan[^>]*?textLength=["']([\d.]+)["']/gi, function(m, tl) {
          _tlWidths.push(parseFloat(tl));
        });
        for (var rwi = 0; rwi < _2fullFontSizes.length; rwi++) {
          var rw = (_tlWidths[rwi] > 0) ? _tlWidths[rwi] : (heroWidths[rwi] || 0) * (_2fullFontSizes[rwi] / measureFs);
          rowWidths.push(rw);
        }
        result = result.replace(/<svg/, '<svg data-row-centers="' + rowCenters.map(function(v){return v.toFixed(1)}).join(',') + '" data-row-widths="' + rowWidths.map(function(v){return v.toFixed(1)}).join(',') + '"');
      }

      // Set text-anchor for horizontal centering
      result = SvgRenderer._setTextAttribute(result, textIndex, 'text-anchor', 'middle');

      // Per-font letter-spacing — reduce when Full textLength stretches text (avoids huge gaps)
      var effectiveLS = fontLetterSpacing;
      if (rowsMode === 'full' && stampShape === 'square' && effectiveLS > 0) {
        effectiveLS = 0; // textLength handles spacing, extra LS makes gaps too wide
      }
      if (effectiveLS > 0) {
        result = SvgRenderer._setTextAttribute(result, textIndex, 'letter-spacing', String(effectiveLS));
      } else if (fontLetterSpacing > 0) {
        result = SvgRenderer._setTextAttribute(result, textIndex, 'letter-spacing', '0');
      }
      // Per-font word-spacing
      if (wordSpacingPx !== 0) {
        result = SvgRenderer._setTextAttribute(result, textIndex, 'word-spacing', wordSpacingPx.toFixed(1));
      }

      // STEP 5: Resize/reposition rects to wrap around text (centered on viewBox center)
      var newRectX = viewBoxCenterX - newRectWidth / 2;
      var newRectY = viewBoxCenterY - newRectHeight / 2;

      // Debug text zone tracking (set during rect loop, drawn after)
      var debugZoneX, debugZoneY, debugZoneW, debugZoneH;

      // First pass: find the largest rect width (outer frame) to classify rects
      var rectInfos = [];
      var hasDecorativeBorder = false;
      (result.match(/<rect[^>]*>/gi) || []).forEach(function(rectTag) {
        if (rectTag.match(/fill=["']#FFFFFF["']/i) || rectTag.match(/fill=["']white["']/i)) return;
        var wm = rectTag.match(/\swidth=["']([\d.]+)["']/);
        var swm = rectTag.match(/stroke-width=["']([\d.]+)["']/);
        if (wm) rectInfos.push({ w: parseFloat(wm[1]), sw: swm ? parseFloat(swm[1]) : 0 });
        if (/data-(?:border|stitch|wavy|filter|brush-border)=/.test(rectTag)) hasDecorativeBorder = true;
      });
      rectInfos.sort(function(a, b) { return b.w - a.w; });
      var rectWidths = rectInfos.map(function(r) { return r.w; });
      var outerRectOrigW = rectWidths[0] || vbW;
      var rawOuterSw = rectInfos.length > 0 ? rectInfos[0].sw : 0;
      // Default stroke for templates without stroke-width in SVG but with border type from DB
      if (rawOuterSw === 0 && (borderFlags.border || borderFlags.filter || borderFlags.stitch)) {
        rawOuterSw = 50;
      }
      // Supplement hasDecorativeBorder from borderFlags (DB may provide border type not in SVG)
      if (!hasDecorativeBorder && (borderFlags.border || borderFlags.stitch || borderFlags.wavy || borderFlags.brush || borderFlags.filter || borderFlags.perfLine)) {
        hasDecorativeBorder = true;
      }
      // Per-family stroke scaling (table-based ranges)
      //   Plain:     outerRectSw 30-75   (stroke IS the border)
      //   Torn edge: outerRectSw 30-75   (stroke under filter scales, fScale stays 20)
      //   Zigzag:    outerRectSw 30-75   (stroke band for shapes)
      //   Stitch:    outerRectSw raw     (shapes handle visual weight)
      //   Wavy:      outerRectSw raw     (wavy path handles visual weight)
      //   Brush:     outerRectSw raw     (brush group handles visual weight)
      var outerRectSw;
      var rectRowBoost = stampShape === 'square' ? 1 : rowBoost;
      var swMin = stampShape === 'square' ? 20 : Math.round(20 * rectRowBoost);
      var swMax = stampShape === 'square' ? 80 : Math.round(60 * rectRowBoost);
      if (borderFlags.perfLine) {
        // Perf_line: stroke must contain perforations, higher minimum
        var plFloor = stampShape === 'square' ? 65 : Math.round(35 * rectRowBoost);
        outerRectSw = rawOuterSw > 0 ? Math.max(plFloor, Math.min(swMax, proportionalSw * 1.5)) : 0;
      } else if (!hasDecorativeBorder || borderFlags.filter) {
        // Plain + Torn edge
        outerRectSw = rawOuterSw > 0 ? Math.max(swMin, Math.min(swMax, proportionalSw)) : 0;
      } else if (borderFlags.border) {
        // Sawtooth/perforated: thicker stroke to contain white shapes
        var bFloor = stampShape === 'square' ? 60 : Math.round(35 * rectRowBoost);
        outerRectSw = rawOuterSw > 0 ? Math.max(bFloor, Math.min(swMax, proportionalSw * 1.4)) : 0;
      } else {
        // Stitch, wavy, brush: keep raw stroke, boost with row count for rectangles
        outerRectSw = rawOuterSw * rectRowBoost;
      }
      // Weight ratio for decorative element sizing (clamped 0.5-1.3 for brush; others clamp per-item)
      var decorWeightRatio = rawOuterSw > 0
        ? Math.max(0.5, Math.min(1.3, proportionalSw / rawOuterSw))
        : 1;
      // Multi-row rectangles: stamp grows with more rows, decorative elements
      // must not shrink. Guarantee at least 1.0 (template-designed size).
      if (numTspans > 1 && stampShape !== 'square') {
        decorWeightRatio = Math.max(1.0, decorWeightRatio);
      }
      var mainRectThreshold = outerRectOrigW * 0.7;
      var decorScale = newRectWidth / outerRectOrigW;
      var innerPaddingX = outerRectSw > 0 ? outerRectSw * 0.22 : 11;
      var innerPaddingY = outerRectSw > 0 ? outerRectSw * 0.20 : 10;
      var borderShapeData = null;
      var borderFilterData = null;
      var stitchData = null;
      var wavyData = null;
      var wavyGenTag = null;

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
            // Use borderFlags (available before rect loop) not borderShapeData (set during loop)
            var shapeExtra = borderFlags.border ? outerRectSw * 0.8 : 0;
            // Stitch shapes sit outward but need inner clearance to match dot variant
            var stitchExtra = stitchData ? outerRectSw * 0.12 : 0;
            var iPadX = innerPaddingX + filterExtra + shapeExtra + stitchExtra;
            var iPadY = innerPaddingY + filterExtra + shapeExtra + stitchExtra;
            na = na.replace(/(\s)width=["'][\d.]+["']/, '$1width="' + (newRectWidth - iPadX * 2).toFixed(2) + '"');
            na = na.replace(/(\s)height=["'][\d.]+["']/, '$1height="' + (newRectHeight - iPadY * 2).toFixed(2) + '"');
            if (hasX) na = na.replace(/\bx=["'][\d.\-]+["']/, 'x="' + (newRectX + iPadX).toFixed(2) + '"');
            if (hasY) na = na.replace(/\by=["'][\d.\-]+["']/, 'y="' + (newRectY + iPadY).toFixed(2) + '"');
            // Capture inner rect as debug text zone (double frame only — split uses outer)
            if (frameMode === 'double') {
              debugZoneX = newRectX + iPadX;
              debugZoneY = newRectY + iPadY;
              debugZoneW = newRectWidth - iPadX * 2;
              debugZoneH = newRectHeight - iPadY * 2;
            }
          } else {
            na = na.replace(/(\s)width=["'][\d.]+["']/, '$1width="' + newRectWidth.toFixed(2) + '"');
            na = na.replace(/(\s)height=["'][\d.]+["']/, '$1height="' + newRectHeight.toFixed(2) + '"');
            if (hasX) na = na.replace(/\bx=["'][\d.\-]+["']/, 'x="' + newRectX.toFixed(2) + '"');
            if (hasY) na = na.replace(/\by=["'][\d.\-]+["']/, 'y="' + newRectY.toFixed(2) + '"');
            // Set proportional stroke-width on outer rect (plain + torn edge + zigzag)
            if (!hasDecorativeBorder || borderFlags.filter || borderFlags.border || borderFlags.perfLine) {
              na = na.replace(/stroke-width=["'][\d.]+["']/, 'stroke-width="' + outerRectSw + '"');
            }
            // Capture border shape data from outer rect
            var borderAttr = attrs.match(/data-border=["']([^"']+)["']/);
            if (borderAttr) {
              // Use proportional outerRectSw (not original template value) for shape positioning
              var halfStroke = outerRectSw / 2;
              // Override legacy SVG attribute values with tuned params
              var borderType = borderAttr[1];
              if (borderType === 'circle-30-3') borderType = 'circle-25-4';
              if (borderType === 'circle-20') borderType = 'circle-20-2';
              borderShapeData = {
                type: borderType,
                x: newRectX - halfStroke,
                y: newRectY - halfStroke,
                w: newRectWidth + halfStroke * 2,
                h: newRectHeight + halfStroke * 2,
                sw: outerRectSw
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
              // Tag SVG so cropViewBoxToStamp can add wavy margin
              wavyGenTag = wavyAttr[1]; // "gentle" or "strong"
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

      // ---- Compute corner radius for decorative borders ----
      var DECO_CORNER_RX = {
        soft_round: 35, medium_round: 80, strong_round: 120
      };
      var decoCornerRx = 0;
      if (cornerType && cornerType !== 'straight') {
        if (cornerType.indexOf('mixed_') === 0) {
          // Per-corner radii for mixed corners
          var mixedCorners = SvgRenderer._getMixedCorners(cornerType);
          if (mixedCorners) decoCornerRx = mixedCorners; // {tl, tr, br, bl}
        } else {
          decoCornerRx = DECO_CORNER_RX[cornerType] || 0;
        }
      }

      // ---- BORDER SHAPES (winding/zigzag) ----
      if (borderShapeData) {
        var bParts = borderShapeData.type.split('-');
        var bShape = bParts[0];
        // Zigzag shapes: scale with decorWeightRatio, clamped per outerRectSw 15-45
        var bRadius = Math.max(5, Math.round((parseFloat(bParts[1]) || 15) * decorWeightRatio));
        // Scale diamond to fit within stroke (halfStroke = outerRectSw/2)
        if (bShape === 'diamond') {
          var halfSw = borderShapeData.sw ? borderShapeData.sw / 2 : bRadius * 1.25;
          bRadius = Math.min(bRadius * 1.5, halfSw);
        }
        // Diamonds: spacing = 2r for tangent side corners; circles keep 2.5r gap
        var bSpacingMult = bParts[2] ? parseFloat(bParts[2]) : (bShape === 'diamond' ? 2 : 2.5);
        var shapesResult = SvgRenderer._generateBorderShapes(
          borderShapeData.x, borderShapeData.y,
          borderShapeData.w, borderShapeData.h,
          bShape, bRadius, bSpacingMult, stampShape, cornerType
        );
        var shapesHtml = shapesResult.svg;
        var borderInnerEdge = shapesResult.innerEdge;
        result = result.replace(/<\/svg>/, shapesHtml + '</svg>');
        result = result.replace(/<svg /, '<svg data-border-inner-edge="' + borderInnerEdge.toFixed(1) + '" ');
      }

      // ---- STITCH BORDER (line/square/circle shapes) ----
      if (stitchData) {
        var sType = stitchData.type;
        // Stitch: 20-50 range, scaled by decorWeightRatio (≥1.0 for multi-row rects)
        var sSize = Math.max(20, Math.min(50, Math.round(((sType === 'circle') ? 50 : 40) * decorWeightRatio)));
        var sSpacing = Math.max(10, Math.min(50, Math.round(((sType === 'circle') ? 20 : (sType === 'line') ? 50 : 20) * decorWeightRatio)));
        // Offset shapes outward so they're clearly outside the fill
        var sOffset = sSize * 0.75;
        var stitchResult = SvgRenderer._generateStitchShapes(
          stitchData.x - sOffset, stitchData.y - sOffset,
          stitchData.w + sOffset * 2, stitchData.h + sOffset * 2,
          sType, sSize, sSpacing, stitchData.color, stampShape, cornerType, sOffset
        );
        var stitchHtml = stitchResult.svg;
        var borderInnerEdge = stitchResult.innerEdge;
        result = result.replace(/<\/svg>/, stitchHtml + '</svg>');
        result = result.replace(/<svg /, '<svg data-border-inner-edge="' + borderInnerEdge.toFixed(1) + '" ');
        // Tag SVG so cropViewBoxToStamp can add stitch margin
        var stitchRx = stitchData.x - sOffset, stitchRy = stitchData.y - sOffset;
        var stitchRw = stitchData.w + sOffset * 2, stitchRh = stitchData.h + sOffset * 2;
        result = result.replace(/<svg /, '<svg data-stitch-gen="' + sType + '" data-stitch-rect="' +
          stitchRx.toFixed(1) + ',' + stitchRy.toFixed(1) + ',' + stitchRw.toFixed(1) + ',' + stitchRh.toFixed(1) +
          '" data-stitch-size="' + sSize + '" data-stitch-corner="' + (cornerType || 'straight') +
          '" data-stitch-offset="' + sOffset.toFixed(1) + '" ');
      }

      // ---- WAVY / ZIGZAG BORDER ----
      if (wavyData) {
        var wavyHtml;
        if (wavyData.variant === 'zigzag') {
          // True zigzag: 30-60 stroke range (same as wavy)
          var scaledZzSw = Math.max(30, Math.min(60, Math.round(40 * decorWeightRatio)));
          var wavyResult = SvgRenderer._generateZigzagBorder(
            wavyData.x, wavyData.y, wavyData.w, wavyData.h,
            wavyData.color, scaledZzSw, wavyData.filled, stampShape
          );
          wavyHtml = wavyResult.svg;
          var borderInnerEdge = wavyResult.innerEdge;
        } else {
          // Wavy curves: 30-60 range
          var scaledWavySw = Math.max(30, Math.min(60, Math.round(46 * decorWeightRatio)));
          var wavyResult = SvgRenderer._generateWavyBorder(
            wavyData.x, wavyData.y, wavyData.w, wavyData.h,
            wavyData.color, scaledWavySw, wavyData.variant, wavyData.filled, stampShape
          );
          wavyHtml = wavyResult.svg;
          var borderInnerEdge = wavyResult.innerEdge;
        }
        result = result.replace(/<text/, wavyHtml + '<text');
        result = result.replace(/<svg /, '<svg data-border-inner-edge="' + borderInnerEdge.toFixed(1) + '" ');
      }
      // Tag SVG so cropViewBoxToStamp can add wavy margin
      if (wavyGenTag) {
        result = result.replace(/<svg /, '<svg data-wavy-gen="' + wavyGenTag + '" ');
      }

      // Store proportional stroke for consistent innerSw in addDoubleFrame
      var clampedPropSw = Math.max(swMin, Math.min(swMax, proportionalSw));
      result = result.replace(/<svg /, '<svg data-prop-sw="' + clampedPropSw.toFixed(1) + '" ');

      // Stamp exact decorative line Y positions for square stamps
      if (stampShape === 'square') {
        var sqInnerStrokeTop = newRectY + outerRectSw / 2; // inner face of top stroke
        var sqInnerStrokeBot = newRectY + newRectHeight - outerRectSw / 2;
        var sqTextVisH = textBlockHeight * (fontScaleY || 1) * (_sqFullHiScale || 1) * 0.92;
        var sqTextTop = viewBoxCenterY - sqTextVisH / 2;
        var sqTextBot = viewBoxCenterY + sqTextVisH / 2;
        var sqVoidTop = sqTextTop - sqInnerStrokeTop; // void between inner stroke and text
        var sqVoidBot = sqInnerStrokeBot - sqTextBot;
        var sqLineTopY = sqInnerStrokeTop + sqVoidTop / 2; // centered in top void
        var sqLineBotY = sqInnerStrokeBot - sqVoidBot / 2; // centered in bottom void
        result = result.replace(/<svg /, '<svg data-deco-line-top="' + sqLineTopY.toFixed(1) + '" data-deco-line-bot="' + sqLineBotY.toFixed(1) + '" data-deco-void="' + Math.min(sqVoidTop, sqVoidBot).toFixed(1) + '" ');
      }

      // ---- PERFORATION LINE STYLES (mid-stroke perforation on plain rect) ----
      if (borderFlags.perfLine) {
        var plParts = borderFlags.perfLine.split('-');
        var plShape = plParts[0];
        var plBaseRadius = parseFloat(plParts[1]) || 15;
        var plSpacingMult = parseFloat(plParts[2]) || 2.5;
        var plRadius = Math.max(5, Math.round(plBaseRadius * decorWeightRatio));
        if (plShape === 'diamond') plRadius = Math.min(plRadius * 1.5, outerRectSw / 2);
        var plSpacing = plRadius * plSpacingMult;
        var plCornerType = cornerType || 'straight';
        var plTrace = SvgRenderer._generateTrace(newRectX, newRectY, newRectWidth, newRectHeight, plCornerType);
        var plRegions = SvgRenderer._splitTraceRegions(plTrace);
        var plHtml = '';

        function plPointAtDist(region, dist) {
          var cumDist = 0;
          for (var si = 0; si < region.segments.length; si++) {
            var seg = region.segments[si];
            if (cumDist + seg.len >= dist || si === region.segments.length - 1) {
              var t = seg.len > 0 ? Math.max(0, Math.min(1, (dist - cumDist) / seg.len)) : 0;
              if (seg.type === 'h' || seg.type === 'v') {
                return { x: seg.sx + (seg.ex - seg.sx) * t, y: seg.sy + (seg.ey - seg.sy) * t, rotDeg: 0 };
              }
              var a = seg.startAngle + (seg.endAngle - seg.startAngle) * t;
              return { x: seg.cx + seg.r * Math.cos(a), y: seg.cy + seg.r * Math.sin(a),
                       rotDeg: (a + Math.PI / 2) * (180 / Math.PI) };
            }
            cumDist += seg.len;
          }
          return null;
        }

        // Corner regions: vertex-centered, dynamic count, full plRadius
        for (var pci = 0; pci < plRegions.corners.length; pci++) {
          var cReg = plRegions.corners[pci];
          if (cReg.totalLength <= 0) continue;
          var armLen = cReg.totalLength / 2;
          var mid = armLen;
          var nSq = (armLen < plRadius) ? 1 : Math.max(2, Math.round((armLen - plRadius) / plSpacing) + 1);
          var cornerStride = (nSq > 1) ? (armLen - plRadius) / (nSq - 1) : 0;
          for (var ai = 0; ai < nSq; ai++) {
            var d1 = mid - ai * cornerStride;
            var pt = plPointAtDist(cReg, d1);
            if (pt) plHtml += SvgRenderer._borderShape(plShape, pt.x, pt.y, plRadius, pt.rotDeg);
            if (ai > 0) {
              var d2 = mid + ai * cornerStride;
              var pt2 = plPointAtDist(cReg, d2);
              if (pt2) plHtml += SvgRenderer._borderShape(plShape, pt2.x, pt2.y, plRadius, pt2.rotDeg);
            }
          }
        }

        // Edge regions: full-size shapes, gap at both ends, uniform stride from widest edge
        var plGap = Math.max(0, plSpacing - plRadius * 2);
        var refStride = plSpacing;
        for (var pei = 0; pei < plRegions.edges.length; pei++) {
          var el = plRegions.edges[pei].totalLength;
          if (el <= 0) continue;
          var av = el - 2 * plGap;
          if (av <= plRadius * 2) continue;
          var rn = Math.max(2, Math.round((av + plGap) / plSpacing));
          refStride = (av - plRadius * 2) / (rn - 1);
          break;
        }
        for (var pei = 0; pei < plRegions.edges.length; pei++) {
          var edgeReg = plRegions.edges[pei];
          var edgeLen = edgeReg.totalLength;
          if (edgeLen <= 0 || !edgeReg.segments.length) continue;
          var available = edgeLen - 2 * plGap;
          if (available <= 0) continue;
          var nEdge = Math.max(1, Math.round((available - plRadius * 2) / refStride) + 1);
          var edgeStride = (nEdge > 1) ? (available - plRadius * 2) / (nEdge - 1) : 0;
          var startOff = (nEdge === 1) ? plGap + available / 2 : plGap + plRadius;
          for (var si = 0; si < nEdge; si++) {
            var dist = startOff + si * edgeStride;
            var pt = plPointAtDist(edgeReg, dist);
            if (pt) plHtml += SvgRenderer._borderShape(plShape, pt.x, pt.y, plRadius, pt.rotDeg);
          }
        }

        if (plHtml) result = result.replace(/<\/svg>/, plHtml + '</svg>');
        result = result.replace(/<svg /, '<svg data-perf-line="1" data-border-inner-edge="' + (outerRectSw / 2).toFixed(1) + '" ');
      }

      // ---- BORDER FILTER (ripped paper etc.) ----
      if (borderFilterData) {
        var fParts = borderFilterData.split('-');
        var fType = fParts[0];
        var fScale = parseFloat(fParts[1]) || 20;
        if (fType === 'ripped') {
          // Torn edge: scale displacement with decorWeightRatio (floor 12, below that looks plain)
          fScale = Math.max(12, Math.round(fScale * decorWeightRatio));
          var fId = 'border-rip-' + Date.now() + '-' + Math.round(Math.random() * 9999);
          var freq = fScale <= 10 ? '0.04' : fScale <= 20 ? '0.035' : '0.025';
          var octaves = fScale <= 20 ? 4 : 3;
          var fMargin = Math.ceil(fScale / 3);
          var filterDef = '<defs><filter id="' + fId + '" x="-' + fMargin + '%" y="-' + fMargin + '%" width="' + (100 + fMargin * 2) + '%" height="' + (100 + fMargin * 2) + '%">' +
            '<feTurbulence type="fractalNoise" baseFrequency="' + freq + ' ' + freq + '" numOctaves="' + octaves + '" seed="1"/>' +
            '<feDisplacementMap in="SourceGraphic" scale="' + fScale + '" xChannelSelector="R" yChannelSelector="R"/>' +
            '</filter></defs>';
          result = result.replace(/(<svg[^>]*>)/i, '$1' + filterDef);
          var filterRectRe = new RegExp('(<rect[^>]*width="' + newRectWidth.toFixed(2) + '"[^>]*)(\/?>)');
          result = result.replace(filterRectRe, '$1 filter="url(#' + fId + ')"$2');
        } else if (fType === 'chalk') {
          // Chalk border: rough, grainy edge like chalk on a blackboard
          fScale = Math.max(8, Math.round(fScale * decorWeightRatio));
          var fId = 'border-chalk-' + Date.now() + '-' + Math.round(Math.random() * 9999);
          var fMargin = Math.ceil(fScale / 2);
          // Two-layer filter: displacement for wobbly edges + coarse noise punches holes
          var filterDef = '<defs><filter id="' + fId + '" x="-' + fMargin + '%" y="-' + fMargin + '%" width="' + (100 + fMargin * 2) + '%" height="' + (100 + fMargin * 2) + '%">' +
            '<feTurbulence type="fractalNoise" baseFrequency="0.03 0.05" numOctaves="4" seed="7" result="warp"/>' +
            '<feDisplacementMap in="SourceGraphic" in2="warp" scale="' + fScale + '" xChannelSelector="R" yChannelSelector="G" result="displaced"/>' +
            '<feTurbulence type="fractalNoise" baseFrequency="0.25 0.25" numOctaves="3" seed="3" result="grain"/>' +
            '<feColorMatrix in="grain" type="saturate" values="0" result="grainBW"/>' +
            '<feComponentTransfer in="grainBW" result="grainThresh"><feFuncA type="discrete" tableValues="0 0 0 0.2 0.75 1 1 1"/></feComponentTransfer>' +
            '<feComposite in="displaced" in2="grainThresh" operator="in"/>' +
            '</filter></defs>';
          result = result.replace(/(<svg[^>]*>)/i, '$1' + filterDef);
          var filterRectRe = new RegExp('(<rect[^>]*width="' + newRectWidth.toFixed(2) + '"[^>]*)(\/?>)');
          result = result.replace(filterRectRe, '$1 filter="url(#' + fId + ')"$2');
        }
      }

      // ---- BRUSH BORDER ----
      var brushMatch = result.match(/data-brush-border=["']([^"']+)["']/);
      if (brushMatch && stampShape === 'lined') {
        // Lined: remove template brush groups, generate programmatic brush strokes
        result = result.replace(/<g[^>]*data-brush-border[^>]*>[\s\S]*?<\/g>/g, '');
        // Use a placeholder color that colorize() will replace (NOT #000000 — that's protected)
        var brushColor = '#010101';
        var brushSw = Math.max(30, Math.min(75, Math.round(outerRectSw)));
        var brushHtml = SvgRenderer._generateBrushBorder(
          newRectX, newRectY, newRectWidth, newRectHeight,
          brushColor, brushSw, false, 'lined'
        );
        if (brushHtml) {
          // Separate filter def from path elements
          var bfEnd = brushHtml.indexOf('</filter>') + '</filter>'.length;
          var brushFilter = brushHtml.substring(0, bfEnd);
          var brushPaths = brushHtml.substring(bfEnd);
          if (/<defs[^>]*>/i.test(result)) {
            result = result.replace(/<defs[^>]*>/i, '$&' + brushFilter);
          } else {
            result = result.replace(/<svg([^>]*)>/, '<svg$1><defs>' + brushFilter + '</defs>');
          }
          result = result.replace(/<text/, brushPaths + '<text');
        }
        // Set a thin stroke on outer rect so convertToLined produces a subtle base line
        var thinSw = Math.max(3, Math.round(brushSw * 0.1));
        result = result.replace(
          new RegExp('(<rect[^>]*width="' + newRectWidth.toFixed(2) + '"[^>]*)(/?>)', 'i'),
          function(m, pre, end) {
            if (/stroke-width=["']/.test(pre)) {
              pre = pre.replace(/stroke-width=["'][^"']*["']/, 'stroke-width="' + thinSw + '"');
            } else {
              pre += ' stroke-width="' + thinSw + '"';
            }
            return pre + end;
          }
        );
      } else if (brushMatch) {
        // Rectangle: scale template brush groups as before
        var bbParts = brushMatch[1].split(',');
        var origBX = parseFloat(bbParts[0]);
        var origBY = parseFloat(bbParts[1]);
        var origBW = parseFloat(bbParts[2]);
        var origBH = parseFloat(bbParts[3]);
        var origBCX = origBX + origBW / 2;
        var origBCY = origBY + origBH / 2;
        var overScale = 1.0;
        var bsx = (newRectWidth / origBW) * overScale * decorWeightRatio;
        var bsy = (newRectHeight / origBH) * overScale * decorWeightRatio;
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
          // Skip tiny generated shape rects (fill-only, no stroke, both dimensions small)
          // But keep stitch dashes (one dimension is large) and brushstroke main rects
          if (!rectTag.match(/\bstroke=/i)) {
            var swCheck = rectTag.match(/\swidth=["']([\d.]+)["']/);
            var shCheck = rectTag.match(/\sheight=["']([\d.]+)["']/);
            var maxDim = Math.max(
              swCheck ? parseFloat(swCheck[1]) : 0,
              shCheck ? parseFloat(shCheck[1]) : 0
            );
            if (maxDim < 100) return;
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
          // Zigzag/perforated: shapes carved into stroke, just need stroke edge + margin
          if (borderShapeData) {
            var bpHalfSw = (borderShapeData.sw || 50) / 2;
            strokePadding = Math.max(strokePadding, bpHalfSw + 8);
          }
          // Stitch line dashes (140px) are in contentBounds — minimal padding.
          // Square/circle shapes (40px) are NOT in contentBounds — need full padding.
          if (stitchData) {
            var stitchPad = (stitchData.type === 'line') ? 25 : 70;
            strokePadding = Math.max(strokePadding, stitchPad);
          }
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

      // DEBUG: red rect showing actual text zone (REMOVE AFTER CALIBRATION)
      // Fallback for single-frame stamps (no inner rect found)
      if (debugZoneW === undefined) {
        var halfSw = outerRectSw / 2;
        debugZoneX = newRectX + halfSw;
        debugZoneY = newRectY + halfSw;
        debugZoneW = newRectWidth - outerRectSw;
        debugZoneH = newRectHeight - outerRectSw;
      }
      // Debug red rect disabled — re-enable for admin text-space tuning
      // if (debugZoneW > 0 && debugZoneH > 0) {
      //   var debugTextRect = '<rect x="' + debugZoneX.toFixed(2) +
      //     '" y="' + debugZoneY.toFixed(2) +
      //     '" width="' + debugZoneW.toFixed(2) +
      //     '" height="' + debugZoneH.toFixed(2) +
      //     '" fill="rgba(255,0,0,0.15)" stroke="red" stroke-width="2" />';
      //   result = result.replace('</svg>', debugTextRect + '</svg>');
      // }

      return result;
    } else {
      return svgString;
    }
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

    // Add breathing room so rotated stamp isn't clipped at edges
    var pad = Math.max(newW, newH) * 0.05;
    newW += pad * 2;
    newH += pad * 2;

    // Shrink post-rotation viewBox to make tilted stamps appear larger.
    var isFixedFrame = svgString.indexOf('<image') !== -1;
    if (isFixedFrame) {
      // Category 2 (background image): clipping background edges is acceptable
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

    // White background rect covering the expanded viewBox so corners aren't transparent
    var bgRect = '<rect x="' + newVbX.toFixed(2) + '" y="' + newVbY.toFixed(2) +
      '" width="' + newW.toFixed(2) + '" height="' + newH.toFixed(2) + '" fill="#ffffff"/>';

    return before +
      bgRect +
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

    // Make the inline SVG responsive — iOS WebKit needs explicit width to derive height from viewBox
    var svgEl = wrapper.querySelector('svg');
    if (svgEl) {
      svgEl.setAttribute('width', '100%');
      svgEl.removeAttribute('height');
    }
    return wrapper;
  },

  /**
   * Add decorative horizontal lines to fill white void in square stamps.
   * @param {string} svgString - The SVG string
   * @param {string} rowVariant - 'A' or 'B'
   * @param {number} numRows - 1, 2, or 3
   * @returns {string} SVG with decorative lines added
   *
   * Modes:
   *   1A/1B: horizontal line above and below text
   *   2A: horizontal line above row1 and below row2
   *   3B: horizontal lines flanking the short middle row ("── TO ──")
   *   2B, 3A: no lines (already fill space)
   */
  addDecorativeLines(svgString, rowVariant, numRows) {
    // Draw lines: 1-row = top/bottom horizontal, 2+ rows = per-row lateral flanking
    var needsLines = (numRows === 1) || (numRows >= 2);
    if (!needsLines) return svgString;

    // Parse viewBox
    var vbMatch = svgString.match(/viewBox=["']\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)/);
    if (!vbMatch) return svgString;
    var vbX = parseFloat(vbMatch[1]), vbY = parseFloat(vbMatch[2]);
    var vbW = parseFloat(vbMatch[3]), vbH = parseFloat(vbMatch[4]);
    var cx = vbX + vbW / 2; // horizontal center
    var vcY = vbY + vbH / 2; // vertical center

    // Find outer rect stroke-width and color
    var rectMatch = svgString.match(/<rect[^>]*stroke-width=["']([\d.]+)["'][^>]*>/i);
    var outerSw = rectMatch ? parseFloat(rectMatch[1]) : 50;
    var colorMatch = svgString.match(/<rect[^>]*stroke=["']([^"']+)["']/i);
    var stampColor = colorMatch ? colorMatch[1] : '#000000';

    // Line specs: stroke = outerSw/2
    var lineSw = outerSw / 2;
    // Inner edges from viewBox (rect fills viewBox after crop)
    var innerLeft = vbX + outerSw;
    var innerRight = vbX + vbW - outerSw;
    // Line length = 50% of viewBox width (= stamp width)
    var lineLen = vbW * 0.5;
    var lineX1 = cx - lineLen / 2;
    var lineX2 = cx + lineLen / 2;

    // Read exact line positions from autoFit (stamped as data attributes)
    var decoTopMatch = svgString.match(/data-deco-line-top=["']([\d.\-]+)["']/);
    var decoBotMatch = svgString.match(/data-deco-line-bot=["']([\d.\-]+)["']/);
    var decoVoidMatch = svgString.match(/data-deco-void=["']([\d.\-]+)["']/);

    var lineTopY = decoTopMatch ? parseFloat(decoTopMatch[1]) : (vbY + vbH * 0.2);
    var lineBotY = decoBotMatch ? parseFloat(decoBotMatch[1]) : (vbY + vbH * 0.8);
    var minVoidSize = decoVoidMatch ? parseFloat(decoVoidMatch[1]) : 0;
    lineSw = Math.min(outerSw / 2, minVoidSize * 0.25);

    var lines = '';

    if (numRows >= 2) {
      // 2+ rows: detect void type and draw appropriate lines
      // Horizontal void → lateral flanking per row (centered on row text)
      // Vertical void → top/bottom horizontal lines
      var allTspanTexts = [];
      svgString.replace(/<tspan[^>]*>([^<]*)<\/tspan>/gi, function(m, t) {
        allTspanTexts.push(t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
      });
      var tspanFsArr = [];
      svgString.replace(/<tspan[^>]*?font-size=["']([\d.]+)["']/gi, function(m, fs) {
        tspanFsArr.push(parseFloat(fs));
      });
      var textFsMatch = svgString.match(/<text[^>]*font-size=["']([\d.]+)["']/i);
      var defFs = textFsMatch ? parseFloat(textFsMatch[1]) : 100;

      // Rect geometry
      var sqSideAttr = svgString.match(/data-sq-side=["']([\d.]+)["']/);
      var sqSideVal = sqSideAttr ? parseFloat(sqSideAttr[1]) : vbW;
      var rectLeft = cx - sqSideVal / 2;
      var innerStrokeLeft = rectLeft + outerSw / 2;
      var innerStrokeRight = rectLeft + sqSideVal - outerSw / 2;

      // Row center Y positions and widths (stamped by _applyAutoFitSizing)
      var rowCentersAttr = svgString.match(/data-row-centers=["']([^"']+)["']/);
      var rowCenters = rowCentersAttr ? rowCentersAttr[1].split(',').map(parseFloat) : null;
      var rowWidthsAttr = svgString.match(/data-row-widths=["']([^"']+)["']/);
      var rowWidths = rowWidthsAttr ? rowWidthsAttr[1].split(',').map(parseFloat) : null;

      // First pass: check if any row has horizontal void (>5% per side)
      var hasHorizontalVoid = false;
      var innerW = sqSideVal - outerSw;
      if (rowWidths) {
        for (var ri = 0; ri < Math.min(rowWidths.length, numRows); ri++) {
          var hVoid = (innerW - rowWidths[ri]) / 2;
          if (hVoid >= innerW * 0.05) { hasHorizontalVoid = true; break; }
        }
      }

      if (hasHorizontalVoid && rowCenters && rowWidths) {
        // HORIZONTAL VOID: lateral flanking lines per row
        for (var ri = 0; ri < Math.min(numRows, rowCenters.length); ri++) {
          var rowCenterY = rowCenters[ri];
          var rowW = rowWidths[ri] || innerW;
          var rowLeft = cx - rowW / 2;
          var rowRight = cx + rowW / 2;

          var hVoid = rowLeft - innerStrokeLeft;
          if (hVoid < 10) continue;
          // Proportional gaps: 15% each for edge and text, 70% for line
          var borderGap = Math.max(hVoid * 0.15, 4);
          var textGap = Math.max(hVoid * 0.15, 4);
          var flankLen = hVoid - textGap - borderGap;
          if (flankLen < 8) continue;
          var rowLineSw = Math.min(outerSw * 0.75, Math.max(3, flankLen * 0.3));

          if (rowLineSw > 0.5) {
            var lx1 = innerStrokeLeft + borderGap;
            var lx2 = rowLeft - textGap;
            lines += '<line x1="' + lx1.toFixed(1) + '" y1="' + rowCenterY.toFixed(1) + '" x2="' + lx2.toFixed(1) + '" y2="' + rowCenterY.toFixed(1) + '" stroke="' + stampColor + '" stroke-width="' + rowLineSw.toFixed(1) + '" stroke-linecap="round"/>';
            var rx1 = rowRight + textGap;
            var rx2 = innerStrokeRight - borderGap;
            lines += '<line x1="' + rx1.toFixed(1) + '" y1="' + rowCenterY.toFixed(1) + '" x2="' + rx2.toFixed(1) + '" y2="' + rowCenterY.toFixed(1) + '" stroke="' + stampColor + '" stroke-width="' + rowLineSw.toFixed(1) + '" stroke-linecap="round"/>';
          }
        }
      } else if (!hasHorizontalVoid) {
        // VERTICAL VOID: top/bottom horizontal lines
        if (minVoidSize > vbH * 0.10 && lineSw > 1) {
          lines += '<line x1="' + lineX1.toFixed(1) + '" y1="' + lineTopY.toFixed(1) + '" x2="' + lineX2.toFixed(1) + '" y2="' + lineTopY.toFixed(1) + '" stroke="' + stampColor + '" stroke-width="' + lineSw.toFixed(1) + '" stroke-linecap="round"/>';
          lines += '<line x1="' + lineX1.toFixed(1) + '" y1="' + lineBotY.toFixed(1) + '" x2="' + lineX2.toFixed(1) + '" y2="' + lineBotY.toFixed(1) + '" stroke="' + stampColor + '" stroke-width="' + lineSw.toFixed(1) + '" stroke-linecap="round"/>';
        }
      }
    } else {
      // 1-row: horizontal lines centered in void above and below text
      // Only draw when void is at least 15% of stamp height
      if (minVoidSize > vbH * 0.15 && lineSw > 1) {
        lines += '<line x1="' + lineX1.toFixed(1) + '" y1="' + lineTopY.toFixed(1) + '" x2="' + lineX2.toFixed(1) + '" y2="' + lineTopY.toFixed(1) + '" stroke="' + stampColor + '" stroke-width="' + lineSw.toFixed(1) + '" stroke-linecap="round"/>';
        lines += '<line x1="' + lineX1.toFixed(1) + '" y1="' + lineBotY.toFixed(1) + '" x2="' + lineX2.toFixed(1) + '" y2="' + lineBotY.toFixed(1) + '" stroke="' + stampColor + '" stroke-width="' + lineSw.toFixed(1) + '" stroke-linecap="round"/>';
      }
    }

    if (!lines) return svgString;
    // Insert lines before </svg>
    return svgString.replace(/<\/svg>\s*$/i, lines + '</svg>');
  },

  /**
   * Add a diagonal "stampatext" watermark overlay to an SVG string.
   * Used for previews only — never for paid exports.
   */
  addWatermark(svgString) {
    var vbMatch = svgString.match(/viewBox=["']\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)/);
    if (!vbMatch) return svgString;
    var vbX = parseFloat(vbMatch[1]), vbY = parseFloat(vbMatch[2]);
    var vbW = parseFloat(vbMatch[3]), vbH = parseFloat(vbMatch[4]);

    // Full viewBox coverage — no inset
    var clipX = vbX;
    var clipY = vbY;
    var clipW = vbW;
    var clipH = vbH;

    // Logo watermark — dual layer (dark shadow + white logo) for universal visibility
    var logoW = Math.min(clipW, clipH) * 0.6;
    var logoH = logoW / 4.3;
    var spacingX = logoW * 1.3;
    var spacingY = logoH * 2.2;
    var wmId = 'wm-' + Math.random().toString(36).slice(2, 8);

    var watermark = '<svg x="' + clipX.toFixed(2) + '" y="' + clipY.toFixed(2) + '" ' +
      'width="' + clipW.toFixed(2) + '" height="' + clipH.toFixed(2) + '" ' +
      'overflow="hidden" pointer-events="none">';

    // Filter: force uniform grey regardless of input color (neutralizes colored [a] in logo)
    watermark += '<defs>' +
      '<filter id="' + wmId + '-g"><feColorMatrix type="matrix" values="0 0 0 0 0.45  0 0 0 0 0.45  0 0 0 0 0.45  0 0 0 1 0"/></filter>' +
      '</defs>';

    var cx = clipW / 2, cy = clipH / 2;
    var cols = Math.ceil(clipW / spacingX) + 4;
    var rows = Math.ceil(clipH / spacingY) + 4;
    var startX = cx - (cols / 2) * spacingX;
    var startY = cy - (rows / 2) * spacingY;

    var tiles = '';
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var x = startX + c * spacingX + (r % 2 === 1 ? spacingX * 0.5 : 0);
        var y = startY + r * spacingY;
        tiles += '<image href="/logo.png" x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" ' +
          'width="' + logoW.toFixed(2) + '" height="' + logoH.toFixed(2) + '"/>';
      }
    }

    // Single grey layer — visible on both light and dark stamps
    watermark += '<g transform="rotate(-25 ' + cx.toFixed(2) + ' ' + cy.toFixed(2) + ')" ' +
      'opacity="0.4" filter="url(#' + wmId + '-g)">' + tiles + '</g>';

    watermark += '</svg>';

    return svgString.replace(/<\/svg>\s*$/, watermark + '</svg>');
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

      var _fontBase2 = window.location.origin;
      var htmlDoc = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
        '<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@200;300;400;500;600;700&display=swap" rel="stylesheet">' +
        '<style>' +
        '@font-face{font-family:"Oswald";src:url("' + _fontBase2 + '/fonts/Oswald-Medium.ttf") format("truetype");font-weight:500;}' +
        '@font-face{font-family:"Montserrat";src:url("' + _fontBase2 + '/fonts/Montserrat-Bold.ttf") format("truetype");font-weight:700;}' +
        '@font-face{font-family:"Nunito";src:url("' + _fontBase2 + '/fonts/Nunito-Black.ttf") format("truetype");font-weight:900;}' +
        '@font-face{font-family:"BlackOpsOne";src:url("' + _fontBase2 + '/fonts/BlackOpsOne-Regular.ttf") format("truetype");font-weight:400;}' +
        '@font-face{font-family:"CourierPrime";src:url("' + _fontBase2 + '/fonts/CourierPrime-Regular.ttf") format("truetype");font-weight:400;}' +
        '@font-face{font-family:"Yomogi";src:url("' + _fontBase2 + '/fonts/Yomogi-Regular.ttf") format("truetype");font-weight:400;}' +
        '@font-face{font-family:"Bitter";src:url("' + _fontBase2 + '/fonts/Bitter-Medium.ttf") format("truetype");font-weight:500;}' +
        '@font-face{font-family:"Exo2";src:url("' + _fontBase2 + '/fonts/Exo2-Bold.ttf") format("truetype");font-weight:700;}' +
        '@font-face{font-family:"Comfortaa";src:url("' + _fontBase2 + '/fonts/Comfortaa-Bold.ttf") format("truetype");font-weight:700;}' +
        '@font-face{font-family:"FuzzyBubbles";src:url("' + _fontBase2 + '/fonts/FuzzyBubbles-Bold.ttf") format("truetype");font-weight:700;}' +
        '@font-face{font-family:"BebasNeue";src:url("' + _fontBase2 + '/fonts/BebasNeue-Regular.ttf") format("truetype");font-weight:400;}' +
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
   * Programmatic texture presets using SVG feTurbulence + feColorMatrix filters.
   * Each preset produces white marks over the stamp via thresholded noise.
   * RGB always white (1,1,1). Alpha = alphaSlope * noiseValue + alphaIntercept.
   */
  _texturePresets: {
    'grungy':   { label: 'Grungy',   type: 'fractalNoise', baseFrequency: '0.04',      numOctaves: 4, alphaSlope: -10, alphaIntercept: 3.2 },
    'worn':     { label: 'Worn',     type: 'turbulence',   baseFrequency: '0.012',     numOctaves: 3, alphaSlope: -6,  alphaIntercept: 0.75 },
    'scratched':{ label: 'Scratched',type: 'fractalNoise', baseFrequency: '0.002 0.15',numOctaves: 2, alphaSlope: -12, alphaIntercept: 3.9 },
    'speckled': { label: 'Speckled', type: 'fractalNoise', baseFrequency: '0.08',      numOctaves: 2, alphaSlope: -15, alphaIntercept: 4.5 },
    'noise':    { label: 'Noise',    type: 'fractalNoise', baseFrequency: '0.15',      numOctaves: 1, alphaSlope: -8,  alphaIntercept: 2.9 }
  },

  /** Backward compatibility: map old texture IDs to new preset keys. */
  _textureAliases: {
    'grungy_texture': 'grungy',
    'grungy_texture_2': 'grungy',
    'grungy_texture_3_light': 'grungy'
  },

  /**
   * Apply a texture overlay on top of an SVG stamp using SVG filters.
   * Generates feTurbulence noise thresholded to white marks.
   * Random seed per call ensures infinite visual variety.
   * @param {string} svgString - the stamp SVG string
   * @param {string} textureId - texture preset key (e.g. 'grungy', 'worn')
   * @returns {string} - SVG string with texture overlay
   */
  applyTexture(svgString, textureId) {
    if (!textureId) return svgString;

    // Resolve aliases for backward compatibility
    var resolvedId = this._textureAliases[textureId] || textureId;
    var preset = this._texturePresets[resolvedId];
    if (!preset) return svgString;

    // Parse viewBox
    var vbMatch = svgString.match(/viewBox=["']\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*["']/);
    if (!vbMatch) return svgString;

    var vbX = parseFloat(vbMatch[1]);
    var vbY = parseFloat(vbMatch[2]);
    var vbW = parseFloat(vbMatch[3]);
    var vbH = parseFloat(vbMatch[4]);

    // Random seed for variety (replaces old random rotation)
    var seed = Math.floor(Math.random() * 99999) + 1;
    var filterId = 'tex-' + resolvedId + '-' + seed;

    // Build SVG filter: feTurbulence → feColorMatrix (white output, thresholded alpha)
    var filterDef = '<defs><filter id="' + filterId + '" ' +
      'x="0" y="0" width="100%" height="100%" ' +
      'color-interpolation-filters="sRGB">' +
      '<feTurbulence type="' + preset.type + '" ' +
      'baseFrequency="' + preset.baseFrequency + '" ' +
      'numOctaves="' + preset.numOctaves + '" ' +
      'seed="' + seed + '"/>' +
      '<feColorMatrix type="matrix" values="' +
      '0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  ' +
      '0 0 0 ' + preset.alphaSlope + ' ' + preset.alphaIntercept + '"/>' +
      '</filter></defs>';

    // Overlay rect covering full viewBox, filtered to show white texture marks.
    // Scratched texture: rotate overlay at random angle for varied scratch directions.
    var texRotate = '';
    if (resolvedId === 'scratched') {
      var texAngle = -25; // bottom-left to top-right
      var texCx = (vbX + vbW / 2).toFixed(2);
      var texCy = (vbY + vbH / 2).toFixed(2);
      texRotate = ' transform="rotate(' + texAngle + ' ' + texCx + ' ' + texCy + ')"';
    }
    // Scale up rect by sqrt(2) to ensure full coverage when rotated
    var texPad = texRotate ? Math.max(vbW, vbH) * 0.22 : 0;
    var overlayRect = '<rect x="' + (vbX - texPad).toFixed(2) + '" y="' + (vbY - texPad).toFixed(2) + '" ' +
      'width="' + (vbW + texPad * 2).toFixed(2) + '" height="' + (vbH + texPad * 2).toFixed(2) + '" ' +
      'fill="white" filter="url(#' + filterId + ')"' + texRotate + '/>';

    // Inject filter def after <svg> tag, overlay rect before </svg>
    var result = svgString.replace(/(<svg[^>]*>)/i, '$1' + filterDef);
    var svgCloseIdx = result.lastIndexOf('</svg>');
    if (svgCloseIdx === -1) return result;

    return result.substring(0, svgCloseIdx) + overlayRect + result.substring(svgCloseIdx);
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
    if (tpl.border_type === 'perforated_spaced') bi.border = 'circle-25-4';
    if (tpl.border_type === 'perforated') bi.border = 'circle-20-2';
    // Sawtooth (formerly "zigzag" in DB — diamond shapes along border)
    if (!bi.border && tpl.border_type === 'sawtooth') bi.border = 'diamond-20';
    if (!bi.filter && tpl.border_type === 'torn_edge') bi.filter = 'ripped-20';
    if (!bi.filter && tpl.border_type === 'chalk') { bi.filter = 'chalk-12'; bi.filterChalk = true; }
    if (!bi.wavy && tpl.border_type === 'wavy') bi.wavy = 'gentle';
    // New true zigzag (wavy-style closed path with straight angles)
    if (!bi.wavy && tpl.border_type === 'zigzag') bi.wavy = 'zigzag';
    // Perforation line styles (mid-stroke perforation — circles/diamonds through plain stroke)
    if (tpl.border_type === 'perf_line') bi.perfLine = 'circle-20-2.5';
    if (tpl.border_type === 'perf_line_spaced') bi.perfLine = 'circle-25-4';
    if (tpl.border_type === 'saw_line') bi.perfLine = 'diamond-20-2';
    bi.fillType = tpl.fill_type || null;
    return bi;
  },

  /**
   * Per-corner radius definitions for mixed corner types.
   * Returns {tl, tr, br, bl} or null if not a mixed type.
   */
  _getMixedCorners(cornerType) {
    var MIXED = {
      mixed_top_straight: { tl: 0, tr: 0, br: 120, bl: 120 },
      mixed_top_round:    { tl: 120, tr: 120, br: 0, bl: 0 },
      mixed_diag_down:    { tl: 0, tr: 120, br: 0, bl: 120 },
      mixed_diag_up:      { tl: 120, tr: 0, br: 120, bl: 0 }
    };
    return MIXED[cornerType] || null;
  },

  /**
   * Build an SVG <path> d-attribute that draws a rectangle with per-corner radii.
   * tl/tr/br/bl = top-left, top-right, bottom-right, bottom-left corner radius.
   * When a radius is 0, a sharp corner is drawn (no arc).
   */
  /**
   * Generate a trace object for a rounded rect — the foundation for all border generators.
   * Returns { d, rxTL, rxTR, rxBR, rxBL, x, y, w, h, segments[] }
   * @param {string} cornerType - 'straight', 'soft_round', 'medium_round', 'strong_round', 'mixed_*'
   */
  _generateTrace: function(x, y, w, h, cornerType, rxOffset) {
    var CORNER_RX = {
      soft_round: 35, medium_round: 80, strong_round: 120
    };
    var rxTL = 0, rxTR = 0, rxBR = 0, rxBL = 0;

    if (cornerType && cornerType !== 'straight') {
      if (cornerType.indexOf('mixed_') === 0) {
        var mixed = this._getMixedCorners(cornerType);
        if (mixed) { rxTL = mixed.tl; rxTR = mixed.tr; rxBR = mixed.br; rxBL = mixed.bl; }
      } else {
        var uniform = CORNER_RX[cornerType] || 0;
        rxTL = rxTR = rxBR = rxBL = uniform;
      }
    }

    // Apply rxOffset for parallel curves (e.g., stitch offset outward needs larger rx)
    if (rxOffset) {
      if (rxTL > 0) rxTL = Math.max(0, rxTL + rxOffset);
      if (rxTR > 0) rxTR = Math.max(0, rxTR + rxOffset);
      if (rxBR > 0) rxBR = Math.max(0, rxBR + rxOffset);
      if (rxBL > 0) rxBL = Math.max(0, rxBL + rxOffset);
    }

    // Clamp rx values to half the rect dimension
    var maxRx = Math.min(w / 2, h / 2);
    rxTL = Math.min(rxTL, maxRx); rxTR = Math.min(rxTR, maxRx);
    rxBR = Math.min(rxBR, maxRx); rxBL = Math.min(rxBL, maxRx);

    // Generate path d
    var d = this._rectToPath(x, y, w, h, rxTL, rxTR, rxBR, rxBL);

    // Build segments for perimeter-walking generators
    var arcLenTR = rxTR * Math.PI / 2;
    var arcLenBR = rxBR * Math.PI / 2;
    var arcLenBL = rxBL * Math.PI / 2;
    var arcLenTL = rxTL * Math.PI / 2;
    var segments = [
      {type:'h', len: w - rxTL - rxTR, sx: x + rxTL, sy: y, ex: x + w - rxTR, ey: y},
      {type:'arc', len: arcLenTR, cx: x + w - rxTR, cy: y + rxTR, startAngle: -Math.PI/2, endAngle: 0, r: rxTR},
      {type:'v', len: h - rxTR - rxBR, sx: x + w, sy: y + rxTR, ex: x + w, ey: y + h - rxBR},
      {type:'arc', len: arcLenBR, cx: x + w - rxBR, cy: y + h - rxBR, startAngle: 0, endAngle: Math.PI/2, r: rxBR},
      {type:'h', len: w - rxBR - rxBL, sx: x + w - rxBR, sy: y + h, ex: x + rxBL, ey: y + h},
      {type:'arc', len: arcLenBL, cx: x + rxBL, cy: y + h - rxBL, startAngle: Math.PI/2, endAngle: Math.PI, r: rxBL},
      {type:'v', len: h - rxBL - rxTL, sx: x, sy: y + h - rxBL, ex: x, ey: y + rxTL},
      {type:'arc', len: arcLenTL, cx: x + rxTL, cy: y + rxTL, startAngle: Math.PI, endAngle: Math.PI * 1.5, r: rxTL}
    ];

    var perimeter = 0;
    for (var i = 0; i < segments.length; i++) perimeter += segments[i].len;

    return {
      d: d, x: x, y: y, w: w, h: h,
      rxTL: rxTL, rxTR: rxTR, rxBR: rxBR, rxBL: rxBL,
      segments: segments, perimeter: perimeter,
      hasRounding: (rxTL + rxTR + rxBR + rxBL) > 0
    };
  },

  /**
   * Walk a trace's perimeter and return evenly spaced points with tangent angles.
   * @param {object} trace - from _generateTrace
   * @param {number} step - distance between points
   * @returns {Array} [{x, y, angle, rotDeg}]
   */
  _walkTrace: function(trace, step) {
    var points = [];
    var numPoints = Math.max(4, Math.round(trace.perimeter / step));
    var ptStep = trace.perimeter / numPoints;

    function getPointOnSegment(seg, t) {
      if (seg.type === 'h' || seg.type === 'v') {
        return {
          x: seg.sx + (seg.ex - seg.sx) * t,
          y: seg.sy + (seg.ey - seg.sy) * t,
          angle: seg.type === 'h' ? 0 : 1,
          rotDeg: 0
        };
      } else {
        var a = seg.startAngle + (seg.endAngle - seg.startAngle) * t;
        var tangentDeg = (a + Math.PI / 2) * (180 / Math.PI);
        return {
          x: seg.cx + seg.r * Math.cos(a),
          y: seg.cy + seg.r * Math.sin(a),
          angle: 0,
          rotDeg: tangentDeg
        };
      }
    }

    for (var pi = 0; pi < numPoints; pi++) {
      var targetDist = pi * ptStep;
      var cumDist = 0;
      for (var si = 0; si < trace.segments.length; si++) {
        if (cumDist + trace.segments[si].len >= targetDist || si === trace.segments.length - 1) {
          var localT = trace.segments[si].len > 0 ? (targetDist - cumDist) / trace.segments[si].len : 0;
          localT = Math.max(0, Math.min(1, localT));
          points.push(getPointOnSegment(trace.segments[si], localT));
          break;
        }
        cumDist += trace.segments[si].len;
      }
    }
    return points;
  },

  /**
   * Split a segment at parameter boundaries [startT, endT] ∈ [0,1].
   * Returns a sub-segment (h/v/arc) covering that portion, or null if degenerate.
   */
  _splitSegment: function(seg, startT, endT) {
    if (startT >= endT || seg.len === 0) return null;
    if (seg.type === 'h' || seg.type === 'v') {
      return {
        type: seg.type,
        sx: seg.sx + (seg.ex - seg.sx) * startT,
        sy: seg.sy + (seg.ey - seg.sy) * startT,
        ex: seg.sx + (seg.ex - seg.sx) * endT,
        ey: seg.sy + (seg.ey - seg.sy) * endT,
        len: seg.len * (endT - startT)
      };
    }
    // arc: interpolate angle range
    return {
      type: 'arc',
      cx: seg.cx, cy: seg.cy, r: seg.r,
      startAngle: seg.startAngle + (seg.endAngle - seg.startAngle) * startT,
      endAngle:   seg.startAngle + (seg.endAngle - seg.startAngle) * endT,
      len: seg.len * (endT - startT)
    };
  },

  /**
   * Split a trace into 4 corner regions + 4 edge regions.
   * Every corner gets a fixed-length region = D-type arc (~188.5 units),
   * ensuring consistent edge lengths regardless of corner type.
   *
   * Segment order in trace: [0]=top-h, [1]=TR-arc, [2]=right-v, [3]=BR-arc,
   *                          [4]=bottom-h, [5]=BL-arc, [6]=left-v, [7]=TL-arc
   *
   * Returns { corners: [{segments, totalLength}] (TR,BR,BL,TL),
   *           edges:   [{segments, totalLength}] (top,right,bottom,left) }
   */
  _splitTraceRegions: function(trace) {
    var CRL = Math.PI * 120 * 0.6; // corner region length (~226, 1.2× D-type arc)
    var segs = trace.segments;

    // Corner definitions: arcIdx, prevEdgeIdx (edge before arc), nextEdgeIdx (edge after arc)
    // TR: end-of-top + TR-arc + start-of-right
    // BR: end-of-right + BR-arc + start-of-bottom
    // BL: end-of-bottom + BL-arc + start-of-left
    // TL: end-of-left + TL-arc + start-of-top
    var cDefs = [
      { arcIdx: 1, prevIdx: 0, nextIdx: 2 },
      { arcIdx: 3, prevIdx: 2, nextIdx: 4 },
      { arcIdx: 5, prevIdx: 4, nextIdx: 6 },
      { arcIdx: 7, prevIdx: 6, nextIdx: 0 }
    ];

    // Per-corner extension into adjacent edges
    var exts = [];
    for (var ci = 0; ci < 4; ci++) {
      var arcLen = segs[cDefs[ci].arcIdx].len;
      var ext = Math.max(0, (CRL - arcLen) / 2);
      exts.push({ prev: ext, next: ext });
    }

    // Each edge is shared between two corners — clamp if combined > edge length.
    // Edge map: segIdx → which corner takes from start, which from end
    //   top(0):    start=TL(3).next,  end=TR(0).prev
    //   right(2):  start=TR(0).next,  end=BR(1).prev
    //   bottom(4): start=BR(1).next,  end=BL(2).prev
    //   left(6):   start=BL(2).next,  end=TL(3).prev
    var eMap = [
      { segIdx: 0, sCorner: 3, sField: 'next', eCorner: 0, eField: 'prev' },
      { segIdx: 2, sCorner: 0, sField: 'next', eCorner: 1, eField: 'prev' },
      { segIdx: 4, sCorner: 1, sField: 'next', eCorner: 2, eField: 'prev' },
      { segIdx: 6, sCorner: 2, sField: 'next', eCorner: 3, eField: 'prev' }
    ];

    for (var ei = 0; ei < eMap.length; ei++) {
      var em = eMap[ei];
      var edgeLen = segs[em.segIdx].len;
      var sExt = exts[em.sCorner][em.sField];
      var eExt = exts[em.eCorner][em.eField];
      var total = sExt + eExt;
      if (total > edgeLen && total > 0) {
        var ratio = edgeLen / total;
        exts[em.sCorner][em.sField] = sExt * ratio;
        exts[em.eCorner][em.eField] = eExt * ratio;
      }
    }

    // Build 4 corner regions
    var cornerRegions = [];
    for (var ci = 0; ci < 4; ci++) {
      var cd = cDefs[ci];
      var prevSeg = segs[cd.prevIdx];
      var arcSeg  = segs[cd.arcIdx];
      var nextSeg = segs[cd.nextIdx];
      var prevExt = exts[ci].prev;
      var nextExt = exts[ci].next;
      var cSegs = [], cLen = 0;

      // Tail of previous edge
      if (prevExt > 0 && prevSeg.len > 0) {
        var sub = SvgRenderer._splitSegment(prevSeg, 1 - prevExt / prevSeg.len, 1);
        if (sub) { cSegs.push(sub); cLen += sub.len; }
      }
      // Full arc (may be zero-length for straight corners)
      if (arcSeg.len > 0) { cSegs.push(arcSeg); cLen += arcSeg.len; }
      // Head of next edge
      if (nextExt > 0 && nextSeg.len > 0) {
        var sub = SvgRenderer._splitSegment(nextSeg, 0, nextExt / nextSeg.len);
        if (sub) { cSegs.push(sub); cLen += sub.len; }
      }
      cornerRegions.push({ segments: cSegs, totalLength: cLen });
    }

    // Build 4 edge regions (center remainder of each edge)
    var edgeRegions = [];
    for (var ei = 0; ei < eMap.length; ei++) {
      var em = eMap[ei];
      var seg = segs[em.segIdx];
      var sExt = exts[em.sCorner][em.sField];
      var eExt = exts[em.eCorner][em.eField];
      var startT = seg.len > 0 ? sExt / seg.len : 0;
      var endT   = seg.len > 0 ? 1 - eExt / seg.len : 0;

      if (endT > startT + 0.001 && seg.len > 0) {
        var sub = SvgRenderer._splitSegment(seg, startT, endT);
        if (sub) {
          edgeRegions.push({ segments: [sub], totalLength: sub.len });
          continue;
        }
      }
      edgeRegions.push({ segments: [], totalLength: 0 });
    }

    return { corners: cornerRegions, edges: edgeRegions };
  },

  /**
   * Walk a single region (corner or edge) and return evenly-spaced points
   * with tangent info. Same output format as _walkTrace.
   * @param {object} region - { segments, totalLength } from _splitTraceRegions
   * @param {number} step - desired distance between points
   * @returns {Array} [{x, y, angle, rotDeg}]
   */
  _walkRegion: function(region, step) {
    if (!region || region.totalLength <= 0 || !region.segments.length) return [];
    var points = [];
    var numPoints = Math.max(1, Math.round(region.totalLength / step));
    var ptStep = region.totalLength / numPoints;

    function getPointOnSeg(seg, t) {
      if (seg.type === 'h' || seg.type === 'v') {
        return {
          x: seg.sx + (seg.ex - seg.sx) * t,
          y: seg.sy + (seg.ey - seg.sy) * t,
          angle: seg.type === 'h' ? 0 : 1,
          rotDeg: 0
        };
      }
      var a = seg.startAngle + (seg.endAngle - seg.startAngle) * t;
      return {
        x: seg.cx + seg.r * Math.cos(a),
        y: seg.cy + seg.r * Math.sin(a),
        angle: 0,
        rotDeg: (a + Math.PI / 2) * (180 / Math.PI)
      };
    }

    for (var pi = 0; pi <= numPoints; pi++) {
      var targetDist = Math.min(pi * ptStep, region.totalLength);
      var cumDist = 0;
      for (var si = 0; si < region.segments.length; si++) {
        var segLen = region.segments[si].len;
        if (cumDist + segLen >= targetDist || si === region.segments.length - 1) {
          var localT = segLen > 0 ? (targetDist - cumDist) / segLen : 0;
          localT = Math.max(0, Math.min(1, localT));
          points.push(getPointOnSeg(region.segments[si], localT));
          break;
        }
        cumDist += segLen;
      }
    }
    return points;
  },

  _rectToPath(x, y, w, h, tl, tr, br, bl) {
    var d = 'M' + (x + tl).toFixed(2) + ' ' + y.toFixed(2);
    d += ' L' + (x + w - tr).toFixed(2) + ' ' + y.toFixed(2);
    if (tr > 0) {
      d += ' A' + tr.toFixed(2) + ' ' + tr.toFixed(2) + ' 0 0 1 ' + (x + w).toFixed(2) + ' ' + (y + tr).toFixed(2);
    }
    d += ' L' + (x + w).toFixed(2) + ' ' + (y + h - br).toFixed(2);
    if (br > 0) {
      d += ' A' + br.toFixed(2) + ' ' + br.toFixed(2) + ' 0 0 1 ' + (x + w - br).toFixed(2) + ' ' + (y + h).toFixed(2);
    }
    d += ' L' + (x + bl).toFixed(2) + ' ' + (y + h).toFixed(2);
    if (bl > 0) {
      d += ' A' + bl.toFixed(2) + ' ' + bl.toFixed(2) + ' 0 0 1 ' + x.toFixed(2) + ' ' + (y + h - bl).toFixed(2);
    }
    d += ' L' + x.toFixed(2) + ' ' + (y + tl).toFixed(2);
    if (tl > 0) {
      d += ' A' + tl.toFixed(2) + ' ' + tl.toFixed(2) + ' 0 0 1 ' + (x + tl).toFixed(2) + ' ' + y.toFixed(2);
    }
    d += ' Z';
    return d;
  },

  /**
   * Build a <path> tag from per-corner radii, carrying over extra attributes (fill, stroke, etc).
   * Also stamps data-rect-x/y/w/h and data-mixed-type for downstream functions.
   */
  _buildMixedPath(x, y, w, h, tl, tr, br, bl, extraAttrs, cornerType) {
    var d = this._rectToPath(x, y, w, h, tl, tr, br, bl);
    return '<path d="' + d + '"' + extraAttrs +
      ' data-rect-x="' + x + '" data-rect-y="' + y +
      '" data-rect-w="' + w + '" data-rect-h="' + h +
      '" data-mixed-type="' + cornerType + '"/>';
  },

  /**
   * Override rx/ry on the main border rect based on corner_type.
   * Gives programmatic control over corner radius independent of SVG template values.
   * For mixed types, converts the <rect> to a <path> with per-corner arcs.
   */
  applyCornerRadius(svgStr, cornerType) {
    if (!cornerType || cornerType === 'straight') return svgStr;

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

    var hM = outer.attrs.match(/\sheight=["']([\d.]+)["']/);
    var rectH = hM ? parseFloat(hM[1]) : 0;

    // === Mixed corners: convert rect to path with per-corner radii ===
    var mc = this._getMixedCorners(cornerType);
    if (mc) {
      var xM = outer.attrs.match(/\bx=["']([\d.\-]+)["']/);
      var yM = outer.attrs.match(/\by=["']([\d.\-]+)["']/);
      var wMatch = outer.attrs.match(/\swidth=["']([\d.]+)["']/);
      var rectX = xM ? parseFloat(xM[1]) : 0;
      var rectY = yM ? parseFloat(yM[1]) : 0;
      var rectW = wMatch ? parseFloat(wMatch[1]) : 0;
      // Cap each radius: no larger than half the short side minus a safety margin
      var maxR = Math.max(0, (Math.min(rectW, rectH) - 10) / 2);
      var tl = Math.min(mc.tl, maxR);
      var tr = Math.min(mc.tr, maxR);
      var br = Math.min(mc.br, maxR);
      var bl = Math.min(mc.bl, maxR);
      // Strip geometry attrs from original rect, keep everything else (fill, stroke, data-*, etc.)
      // Use \s+ (not \b) to avoid matching compound attrs like stroke-width when stripping width
      var extraAttrs = outer.attrs
        .replace(/\s+x=["'][^"']*["']/g, '')
        .replace(/\s+y=["'][^"']*["']/g, '')
        .replace(/\s+width=["'][^"']*["']/g, '')
        .replace(/\s+height=["'][^"']*["']/g, '')
        .replace(/\s+rx=["'][^"']*["']/g, '')
        .replace(/\s+ry=["'][^"']*["']/g, '')
        .replace(/\s*\/?$/, ''); // strip trailing / from self-closing tag
      var pathTag = this._buildMixedPath(rectX, rectY, rectW, rectH, tl, tr, br, bl, extraAttrs, cornerType);
      return svgStr.slice(0, outer.index) + pathTag + svgStr.slice(outer.index + outer.full.length);
    }

    // === Uniform corners: set rx/ry on the rect ===
    // Offset path: inner_rx = rx - inset, outer inner edge = rx - sw/2. Stroke capped to 30 in autoFit.
    var CORNER_RX = { soft_round: 35, medium_round: 80, strong_round: 120 };
    var targetRx = CORNER_RX[cornerType];
    if (!targetRx) return svgStr;
    // Cap rx to prevent capsule/pill shape on wide stamps:
    // ensure at least a short straight segment on each short side
    var rx = rectH > 0 ? Math.min(targetRx, (rectH - 10) / 2) : targetRx;
    rx = Math.max(rx, 0);
    // Replace or add rx/ry on the outer rect
    var newAttrs = outer.full;
    if (/\brx=["'][\d.]+["']/.test(newAttrs)) {
      newAttrs = newAttrs.replace(/\brx=["'][\d.]+["']/, 'rx="' + rx + '"');
    } else {
      newAttrs = newAttrs.replace(/<rect /, '<rect rx="' + rx + '" ');
    }
    if (/\bry=["'][\d.]+["']/.test(newAttrs)) {
      newAttrs = newAttrs.replace(/\bry=["'][\d.]+["']/, 'ry="' + rx + '"');
    } else {
      newAttrs = newAttrs.replace(/<rect /, '<rect ry="' + rx + '" ');
    }
    return svgStr.slice(0, outer.index) + newAttrs + svgStr.slice(outer.index + outer.full.length);
  },

  /**
   * Add regular double frame: a plain inner rect (or wavy path) inside the border.
   * For full fills, inner color is contrast (white/black). For empty, inner color matches stroke.
   * Skips Cat 2 (image) templates unless they have a Cat1-style border.
   */
  addDoubleFrame(svgStr, bi, appliedColor, frameMode) {
    bi = bi || {};
    var isCat1Border = bi.wavy || bi.brush || bi.stitch || bi.border || bi.filter;
    if (!isCat1Border && /<image[\s>]/i.test(svgStr)) return svgStr;

    // ---- LINED PATH: inner frame is also 2 horizontal lines ----
    var linedPathM = svgStr.match(/<path([^>]*data-lined="1"[^>]*)\/>/);
    if (linedPathM) {
      var la = linedPathM[1];
      var ldM = la.match(/\bd="([^"]+)"/);
      if (!ldM) return svgStr;
      // Parse: M ox,oy H ox+ow M ox,oy+oh H ox+ow
      var lParts = ldM[1].match(/M([\d.\-]+),([\d.\-]+)\s*H([\d.\-]+)\s*M([\d.\-]+),([\d.\-]+)\s*H([\d.\-]+)/);
      if (!lParts) return svgStr;
      var lox = parseFloat(lParts[1]), loy = parseFloat(lParts[2]), lx2 = parseFloat(lParts[3]);
      var lby = parseFloat(lParts[5]);
      var swML = la.match(/stroke-width=["']([\d.]+)["']/);
      var losw = swML ? parseFloat(swML[1]) : 20;
      var stML = la.match(/\bstroke=["']([^"']+)["']/);
      var loStroke = stML ? stML[1] : '#000000';
      var innerSw = Math.max(6, Math.round(losw * 0.36));
      var borderIntrusion = losw * 0.5;
      if (bi.stitch) borderIntrusion = losw * 0.5 + losw * 0.12;
      else if (bi.border) borderIntrusion = losw * 0.5 + losw * 0.25;
      else if (bi.filter) borderIntrusion = losw * 0.55;
      var whiteGap = innerSw;
      var inset = borderIntrusion + whiteGap + innerSw * 0.5;
      var innerColor = appliedColor || loStroke;
      var iPathD = 'M' + (lox + inset).toFixed(2) + ',' + (loy + inset).toFixed(2) +
        ' H' + (lx2 - inset).toFixed(2) +
        ' M' + (lox + inset).toFixed(2) + ',' + (lby - inset).toFixed(2) +
        ' H' + (lx2 - inset).toFixed(2);
      var innerPath = '<path d="' + iPathD + '" fill="none" stroke="' + innerColor +
        '" stroke-width="' + innerSw + '" stroke-linecap="square"/>';
      var textPos = svgStr.search(/<text[\s>]/i);
      if (textPos !== -1) return svgStr.slice(0, textPos) + innerPath + svgStr.slice(textPos);
      return svgStr.replace(/<\/svg>/, innerPath + '</svg>');
    }

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
    // Also detect mixed-corner path (outer rect converted by applyCornerRadius)
    var mixedType = null;
    var mixedPathM = svgStr.match(/<path([^>]*data-mixed-type="([^"]+)"[^>]*)\/?>/);
    if (mixedPathM) {
      mixedType = mixedPathM[2];
      var mAttrs = mixedPathM[1];
      var mxM = mAttrs.match(/data-rect-x="([\d.\-]+)"/);
      var myM = mAttrs.match(/data-rect-y="([\d.\-]+)"/);
      var mwM = mAttrs.match(/data-rect-w="([\d.]+)"/);
      var mhM = mAttrs.match(/data-rect-h="([\d.]+)"/);
      rects.push({
        full: mixedPathM[0], attrs: mAttrs,
        w: mwM ? parseFloat(mwM[1]) : 0, h: mhM ? parseFloat(mhM[1]) : 0,
        index: svgStr.indexOf(mixedPathM[0]),
        mixedX: mxM ? parseFloat(mxM[1]) : 0, mixedY: myM ? parseFloat(myM[1]) : 0
      });
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
    // Extract geometry: mixed path uses data-rect-* attrs, rect uses standard attrs
    var ox, oy, ow, oh, orx, ory;
    ow = outer.w; oh = outer.h;
    if (outer.mixedX !== undefined) {
      ox = outer.mixedX; oy = outer.mixedY;
      orx = 0; ory = 0;
    } else {
      mixedType = null; // outer is a rect, not mixed
      var xM = outer.attrs.match(/\bx=["']([\d.\-]+)["']/);
      var yM = outer.attrs.match(/\by=["']([\d.\-]+)["']/);
      var rxM = outer.attrs.match(/\brx=["']([\d.]+)["']/);
      var ryM = outer.attrs.match(/\bry=["']([\d.]+)["']/);
      ox = xM ? parseFloat(xM[1]) : 0;
      oy = yM ? parseFloat(yM[1]) : 0;
      orx = rxM ? parseFloat(rxM[1]) : 0;
      ory = ryM ? parseFloat(ryM[1]) : 0;
    }
    var swM = outer.attrs.match(/stroke-width=["']([\d.]+)["']/);
    var osw = swM ? parseFloat(swM[1]) : (bi.origStrokeWidth || 20);
    if (osw === 0 && bi.origStrokeWidth) osw = bi.origStrokeWidth;
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
    // Read wavy/zigzag path stroke-width for inset calculation
    var wavySw = 0;
    if (bi.wavy) {
      var wavyPathM = svgStr.match(/<path[^>]*stroke-linejoin="(?:round|miter)"[^>]*>/i);
      if (wavyPathM) {
        var wswM = wavyPathM[0].match(/stroke-width="([\d.]+)"/);
        if (wswM) wavySw = parseFloat(wswM[1]);
      }
    }
    // Multi-pass inner frame: use measured innerEdge from border generators
    // Use proportional stroke (stored by autoFit) for consistent innerSw across all styles
    var propSwAttr = svgStr.match(/data-prop-sw="([\d.]+)"/);
    var effectiveOsw = propSwAttr ? parseFloat(propSwAttr[1]) : osw;
    var innerSw = Math.max(6, Math.round(effectiveOsw * (isFull ? 0.24 : 0.36)));
    // Unified inner edge: read from data attribute (set by border generators), fallback to half stroke
    var edgeAttr = svgStr.match(/data-border-inner-edge="(-?[\d.]+)"/);
    var measuredInnerEdge = edgeAttr ? parseFloat(edgeAttr[1]) : effectiveOsw / 2;
    // White gap: outlined = innerSw (visual rhythm), filled = minimal (no white band needed)
    var whiteGap = isFull ? 2 : innerSw;
    // Filled stamps: ensure minimum inset so inner rect is visible
    if (isFull) measuredInnerEdge = Math.max(measuredInnerEdge, effectiveOsw * 0.3);
    var inset = measuredInnerEdge + whiteGap + innerSw * 0.5;
    var ix = ox + inset, iy = oy + inset;
    var iw = ow - inset * 2, ih = oh - inset * 2;

    // Helper: build inner shape (path for mixed corners, rect for uniform)
    var self = this;
    var _shape = function(sx, sy, sw2, sh2, fill, stroke, strokeW, shapeInset) {
      if (mixedType) {
        var mc = self._getMixedCorners(mixedType);
        var maxR = Math.max(0, (Math.min(ow, oh) - 10) / 2);
        var stl = Math.max(0, Math.min(mc.tl, maxR) - shapeInset);
        var str = Math.max(0, Math.min(mc.tr, maxR) - shapeInset);
        var sbr = Math.max(0, Math.min(mc.br, maxR) - shapeInset);
        var sbl = Math.max(0, Math.min(mc.bl, maxR) - shapeInset);
        var d = self._rectToPath(sx, sy, sw2, sh2, stl, str, sbr, sbl);
        var tag = '<path d="' + d + '" fill="' + fill + '" stroke="' + stroke + '"';
        if (strokeW > 0) tag += ' stroke-width="' + strokeW + '" stroke-miterlimit="10"';
        return tag + '/>';
      }
      var srx = Math.max(0, orx - shapeInset);
      var sry = Math.max(0, ory - shapeInset);
      var tag = '<rect x="' + sx.toFixed(2) + '" y="' + sy.toFixed(2) +
        '" width="' + sw2.toFixed(2) + '" height="' + sh2.toFixed(2) +
        '" fill="' + fill + '" stroke="' + stroke + '"';
      if (strokeW > 0) tag += ' stroke-width="' + strokeW + '" stroke-miterlimit="10"';
      if (srx > 0) tag += ' rx="' + srx.toFixed(1) + '"';
      if (sry > 0) tag += ' ry="' + sry.toFixed(1) + '"';
      return tag + '/>';
    };

    var innerRect = _shape(ix, iy, iw, ih, 'none', innerColor, innerSw, inset);
    // Outlined sawtooth/perforated: white gap + colored inner rect
    if (bi.border && !isFull) {
      var whiteGapSw = Math.max(8, Math.round(osw * 0.15)); // proportional white gap
      var whiteRect = _shape(ix, iy, iw, ih, 'none', '#FFFFFF', whiteGapSw, inset);
      var colorInset = inset + whiteGapSw;
      var cix = ox + colorInset, ciy = oy + colorInset;
      var ciw = ow - colorInset * 2, cih = oh - colorInset * 2;
      var colorRect = _shape(cix, ciy, ciw, cih, 'none', innerColor, innerSw, colorInset);
      if (frameMode === 'double') {
        innerRect = whiteRect + colorRect;
      } else {
        innerRect = _shape(ix, iy, iw, ih, '#FFFFFF', 'none', 0, inset);
      }
    }
    var textPos = svgStr.search(/<text[\s>]/i);
    if (textPos !== -1) return svgStr.slice(0, textPos) + innerRect + svgStr.slice(textPos);
    return svgStr.replace(/<\/svg>/, innerRect + '</svg>');
  },

  /**
   * Add split border effect: carve a white stroke through the thick border,
   * splitting it into two thinner strokes with white between them.
   * Supports: wavy (clone path), stitch (hollow shapes), simple/rounded rect, ripped paper.
   * Skips: perforated, sawtooth, brushstroke, Cat 2 (image) templates.
   */
  addSplitBorder(svgStr, bi) {
    bi = bi || {};
    // Skip brushstroke
    if (bi.brush) return svgStr;
    var isCat1Border = bi.wavy || bi.stitch || bi.filter;
    if (!isCat1Border && /<image[\s>]/i.test(svgStr)) return svgStr;
    // Detect filled stamps
    var isFull = bi.fillType === 'full';

    // ---- LINED PATH: split with white thin stroke ----
    var linedPathM = svgStr.match(/<path([^>]*data-lined="1"[^>]*)\/>/);
    if (linedPathM) {
      var la = linedPathM[1];
      var ldM = la.match(/\bd="([^"]+)"/);
      var swML = la.match(/stroke-width=["']([\d.]+)["']/);
      var losw = swML ? parseFloat(swML[1]) : 20;
      var whiteSw = Math.max(4, Math.round(losw * 0.24));
      if (ldM) {
        var splitPath = '<path d="' + ldM[1] + '" fill="none" stroke="#FFFFFF" stroke-width="' + whiteSw + '" stroke-linecap="square"/>';
        var textPos = svgStr.search(/<text[\s>]/i);
        if (textPos !== -1) return svgStr.slice(0, textPos) + splitPath + svgStr.slice(textPos);
        return svgStr.replace(/<\/svg>/, splitPath + '</svg>');
      }
      return svgStr;
    }

    var innerHtml = '';

    // ==== WAVY / ZIGZAG: clone the path with white thin stroke ====
    if (bi.wavy) {
      var wavyRe = /<path[^>]*stroke-linejoin="(?:round|miter)"[^>]*\/?>/gi;
      var wavyAll = svgStr.match(wavyRe);
      if (wavyAll) {
        // For lined mode there may be 2 separate paths (top + bottom) — handle all
        var wavySwM = wavyAll[0].match(/stroke-width="([\d.]+)"/);
        var wavyOsw = wavySwM ? parseFloat(wavySwM[1]) : (bi.origStrokeWidth || 50);
        var wavyWhiteSw = Math.max(4, Math.round(wavyOsw * 0.24));
        innerHtml = '';
        for (var wi = 0; wi < wavyAll.length; wi++) {
          innerHtml += wavyAll[wi]
            .replace(/fill="[^"]*"/, 'fill="none"')
            .replace(/stroke="[^"]*"/, 'stroke="#FFFFFF"')
            .replace(/stroke-width="[^"]*"/, 'stroke-width="' + wavyWhiteSw + '"');
        }
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
      // Also detect mixed-corner path
      var mixedType = null;
      var mixedPathM = svgStr.match(/<path([^>]*data-mixed-type="([^"]+)"[^>]*)\/?>/);
      if (mixedPathM) {
        mixedType = mixedPathM[2];
        var mAttrs = mixedPathM[1];
        var mwM = mAttrs.match(/data-rect-w="([\d.]+)"/);
        var mhM = mAttrs.match(/data-rect-h="([\d.]+)"/);
        var mxM = mAttrs.match(/data-rect-x="([\d.\-]+)"/);
        var myM = mAttrs.match(/data-rect-y="([\d.\-]+)"/);
        rects.push({
          full: mixedPathM[0], attrs: mAttrs,
          w: mwM ? parseFloat(mwM[1]) : 0, h: mhM ? parseFloat(mhM[1]) : 0,
          mixedX: mxM ? parseFloat(mxM[1]) : 0, mixedY: myM ? parseFloat(myM[1]) : 0
        });
      }
      if (rects.length === 0) return svgStr;
      rects.sort(function(a, b) { return b.w - a.w; });
      var outer = rects[0];

      var ox, oy, ow, oh, orx, ory;
      ow = outer.w; oh = outer.h;
      if (outer.mixedX !== undefined) {
        ox = outer.mixedX; oy = outer.mixedY;
        orx = 0; ory = 0;
      } else {
        mixedType = null;
        var xM = outer.attrs.match(/\bx=["']([\d.\-]+)["']/);
        var yM = outer.attrs.match(/\by=["']([\d.\-]+)["']/);
        var rxM = outer.attrs.match(/\brx=["']([\d.]+)["']/);
        var ryM = outer.attrs.match(/\bry=["']([\d.]+)["']/);
        ox = xM ? parseFloat(xM[1]) : 0;
        oy = yM ? parseFloat(yM[1]) : 0;
        orx = rxM ? parseFloat(rxM[1]) : 0;
        ory = ryM ? parseFloat(ryM[1]) : 0;
      }
      var swM2 = outer.attrs.match(/stroke-width=["']([\d.]+)["']/);
      var osw2 = swM2 ? parseFloat(swM2[1]) : (bi.origStrokeWidth || 50);
      var whiteSw = Math.max(3, Math.round(osw2 * (bi.border ? 0.20 : bi.perfLine ? 0.15 : 0.30)));

      // Copy filter from outer rect (e.g. ripped paper)
      var filterAttr = outer.attrs.match(/filter="([^"]*)"/);

      // Stitch: white thread trace path "cuts through" all stitch shapes
      if (bi.stitch) {
        var stitchRectM = svgStr.match(/data-stitch-rect="([^"]+)"/);
        var stitchSizeM = svgStr.match(/data-stitch-size="([\d.]+)"/);
        var stitchCornerM = svgStr.match(/data-stitch-corner="([^"]+)"/);
        var stitchOffsetM = svgStr.match(/data-stitch-offset="([\d.]+)"/);
        if (stitchRectM && stitchSizeM) {
          var srParts = stitchRectM[1].split(',');
          var srx = parseFloat(srParts[0]), sry = parseFloat(srParts[1]);
          var srw = parseFloat(srParts[2]), srh = parseFloat(srParts[3]);
          var sSize = parseFloat(stitchSizeM[1]);
          var sCorner = stitchCornerM ? stitchCornerM[1] : 'straight';
          var sOff = stitchOffsetM ? parseFloat(stitchOffsetM[1]) : 0;
          var threadSw = Math.max(3, Math.round(sSize * 0.23));
          // Use _generateTrace to follow the exact stitch perimeter path (including corner arcs)
          var trace = this._generateTrace(srx, sry, srw, srh, sCorner, sOff);
          var threadPath = '<path d="' + trace.d + '" fill="none" stroke="#FFFFFF" stroke-width="' + threadSw + '"/>';
          svgStr = svgStr.replace(/<\/svg>/, threadPath + '</svg>');
        }
        innerHtml = '';
      }
      // Perforated/sawtooth: shrink rect inward so thread pierces through shapes
      if (bi.border) {
        var borderInset = Math.round(osw2 * (isFull ? 0.25 : 0.15));
        ox += borderInset; oy += borderInset; ow -= borderInset * 2; oh -= borderInset * 2;
      }
      // All other types: clone shape with white thin stroke
      if (mixedType) {
        var mc = this._getMixedCorners(mixedType);
        var maxR = Math.max(0, (Math.min(ow, oh) - 10) / 2);
        var stl = Math.min(mc.tl, maxR), str = Math.min(mc.tr, maxR);
        var sbr = Math.min(mc.br, maxR), sbl = Math.min(mc.bl, maxR);
        var d = this._rectToPath(ox, oy, ow, oh, stl, str, sbr, sbl);
        innerHtml = '<path d="' + d + '" fill="none" stroke="#FFFFFF" stroke-width="' + whiteSw + '"';
        if (filterAttr) innerHtml += ' filter="' + filterAttr[1] + '"';
        innerHtml += '/>';
      }
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
  },

  /**
   * Convert a rectangle-based stamp to "lined" shape: only top + bottom horizontal strokes.
   * Finds the outer rect (largest non-white rect with stroke) and replaces it with a
   * <path> containing two horizontal line segments. All attributes (stroke, data-*, filter)
   * are preserved on the new path element.
   */
  convertToLined: function(svgString) {
    // Find all rects, pick the outer (largest width)
    var rects = [];
    var re = /<rect([^>]*)\/?>/gi;
    var m;
    while ((m = re.exec(svgString)) !== null) {
      var attrs = m[1];
      // Skip white background rects without colored stroke
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
    if (rects.length === 0) return svgString;
    rects.sort(function(a, b) { return b.w - a.w; });
    var outer = rects[0];
    var a = outer.attrs;

    // Extract geometry
    var xM = a.match(/\bx=["']([\d.\-]+)["']/);
    var yM = a.match(/\by=["']([\d.\-]+)["']/);
    var ox = xM ? parseFloat(xM[1]) : 0;
    var oy = yM ? parseFloat(yM[1]) : 0;
    var ow = outer.w, oh = outer.h;

    // Build attributes string: keep stroke, stroke-width, data-*, filter, stroke-miterlimit
    // but drop x, y, width, height, fill, rx, ry
    var keepAttrs = '';
    var swM2 = a.match(/stroke-width=["']([\d.]+)["']/);
    var stM = a.match(/\bstroke=["']([^"']+)["']/);
    var sw = swM2 ? parseFloat(swM2[1]) : 0;
    var strokeColor = stM ? stM[1] : '#000000';

    // Collect data-* attributes
    var dataAttrs = a.match(/data-[a-z\-]+=["'][^"']*["']/gi) || [];
    keepAttrs = dataAttrs.join(' ');
    // Collect filter attribute
    var filterM = a.match(/filter=["'][^"']*["']/);
    if (filterM) keepAttrs += ' ' + filterM[0];
    // stroke-miterlimit
    var miterM = a.match(/stroke-miterlimit=["'][^"']*["']/);
    if (miterM) keepAttrs += ' ' + miterM[0];

    // Two horizontal lines: top (ox,oy → ox+ow,oy) and bottom (ox,oy+oh → ox+ow,oy+oh)
    var pathD = 'M' + ox.toFixed(2) + ',' + oy.toFixed(2) +
      ' H' + (ox + ow).toFixed(2) +
      ' M' + ox.toFixed(2) + ',' + (oy + oh).toFixed(2) +
      ' H' + (ox + ow).toFixed(2);

    var linedPath = '<path d="' + pathD + '" fill="none" stroke="' + strokeColor + '"';
    if (sw > 0) linedPath += ' stroke-width="' + sw.toFixed(2) + '"';
    linedPath += ' stroke-linecap="square" data-lined="1"';
    if (keepAttrs) linedPath += ' ' + keepAttrs;
    linedPath += '/>';

    // Replace the outer rect with the lined path
    return svgString.replace(outer.full, linedPath);
  }
};
