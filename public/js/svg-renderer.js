/**
 * SvgRenderer - Core SVG processing engine for StampaText
 * Handles: fetch, parse, detect text, replace text, auto-fit, serialize, export PNG
 *
 * Key design: SVG display always uses the cleaned STRING (not DOM-serialized),
 * because DOMParser+XMLSerializer can mangle embedded fonts (base64 in <style>).
 */
const SvgRenderer = {

  /**
   * Fetch SVG string from a URL (Supabase Storage public URL).
   * @param {string} svgUrl
   * @returns {Promise<string>}
   */
  async fetchSvg(svgUrl) {
    const res = await fetch(svgUrl);
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
      { from: "'Oswald-Medium'", to: "'Oswald'", weight: '500' },
      { from: "'Oswald-Regular'", to: "'Oswald'", weight: '400' },
      { from: "'Oswald-Bold'", to: "'Oswald'", weight: '700' },
      { from: "'Oswald-SemiBold'", to: "'Oswald'", weight: '600' },
      { from: "'Oswald-Light'", to: "'Oswald'", weight: '300' },
      { from: "'Oswald-ExtraLight'", to: "'Oswald'", weight: '200' },
      // Gunplay font (custom, loaded from /fonts/)
      { from: "'Gunplay-Regular'", to: "'Gunplay'", weight: '400' },
      { from: "'Gunplay'", to: "'Gunplay'", weight: '400' },
      // Bebas Neue font (custom, loaded from /fonts/)
      { from: "'BebasNeue-Regular'", to: "'BebasNeue'", weight: '400' },
      { from: "'BebasNeue'", to: "'BebasNeue'", weight: '400' },
      // Army Rust font (custom, loaded from /fonts/)
      { from: "'ARMYRUST'", to: "'ArmyRust'", weight: '400' },
      { from: "'ArmyRust'", to: "'ArmyRust'", weight: '400' },
      { from: "'ARMY RUST'", to: "'ArmyRust'", weight: '400' },
      { from: "'Army Rust'", to: "'ArmyRust'", weight: '400' }
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

    // Replace all fill= and stroke= occurrences of the dominant color (case-insensitive)
    var result = svgString;
    var escapedDominant = dominant.replace('#', '\\#');
    // Replace exact hex matches in fill attributes
    var fillRe = new RegExp('(fill=["\'])' + escapedDominant + '(["\'])', 'gi');
    result = result.replace(fillRe, '$1' + newColor + '$2');
    // Replace exact hex matches in stroke attributes
    var strokeRe = new RegExp('(stroke=["\'])' + escapedDominant + '(["\'])', 'gi');
    result = result.replace(strokeRe, '$1' + newColor + '$2');

    return result;
  },

  /**
   * Get the dominant color from an SVG (most frequent non-white, non-black).
   * @param {string} svgString
   * @returns {string|null} hex color or null
   */
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
   * Get max characters per line based on total text length.
   * Short text gets fewer chars/line so the font stays large.
   * @param {number} len - total text length
   * @returns {number}
   */
  _getMaxCharsPerLine(len) {
    // 1-60 chars: 15 chars per line
    // 61+ chars: 20 chars per line
    return len <= 60 ? 15 : 20;
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
        // Decode XML entities for comparison
        var decoded = originalText.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
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
        var lines = this.splitTextIntoLines(caseAdjusted);

        var content;
        if (lines.length === 1) {
          // Single line — plain text as before
          content = lines[0]
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        } else {
          // Multi-line — use <tspan> elements with PLACEHOLDER dy values.
          // The actual dy values will be calculated in autoFitTextInString
          // after we know the final font size. This avoids double-adjustment.
          var xAttr = ' x="0"';

          content = '';
          for (var li = 0; li < lines.length; li++) {
            var lineEscaped = lines[li]
              .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            // Use placeholder dy="0" - will be recalculated in autoFit
            content += '<tspan' + xAttr + ' dy="0">' + lineEscaped + '</tspan>';
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
    if (!maxWidth || maxWidth <= 0) return svgString;
    originalScaleX = originalScaleX || 1;

    // Create an HTML wrapper with fonts to measure text accurately
    var htmlDoc = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
      '<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@200;300;400;500;600;700&display=swap" rel="stylesheet">' +
      '<style>' +
      '@font-face{font-family:"Gunplay";src:url("/fonts/gunplay-regular.otf") format("opentype");font-weight:normal;}' +
      '@font-face{font-family:"BebasNeue";src:url("/fonts/BebasNeue-Regular.ttf") format("truetype");font-weight:normal;}' +
      '@font-face{font-family:"ArmyRust";src:url("/fonts/army-rust.ttf") format("truetype");font-weight:normal;}' +
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

          // Calculate ratio based on measured width vs max width
          // The scaleX transform is applied separately by the SVG renderer
          if (measuredWidth > 0 && Math.abs(measuredWidth - maxWidth) > 1) {
            var ratio = maxWidth / measuredWidth;

            // Extract rect height from SVG to calculate max font size
            // This ensures text never exceeds the container vertically
            var rectHeight = null;
            var rectMatch = svgString.match(/<rect[^>]*height=["']([\d.]+)["']/i);
            if (rectMatch) {
              rectHeight = parseFloat(rectMatch[1]);
            }

            // Calculate max font size based on rect height
            // For single line: fit within ~55% of rect height
            // For multi-line: use same as single-line max, rects will expand to fit
            var numLines = tspans.length || 1;
            var maxFontFromHeight;
            if (rectHeight) {
              // Use same max font for all line counts - rects expand for multi-line
              maxFontFromHeight = rectHeight * 0.55;
            } else {
              maxFontFromHeight = originalFontSize * 3.0; // fallback
            }

            var minFontSize = originalFontSize * 0.4;
            var newFontSize = originalFontSize * ratio;
            var newScaleX = originalScaleX;

            // Clamp: don't exceed max font size based on rect height
            if (newFontSize > maxFontFromHeight) {
              newFontSize = maxFontFromHeight;
            }

            if (newFontSize < minFontSize) {
              newFontSize = minFontSize;
              // At min font size, calculate horizontal compression
              var fontRatio = minFontSize / originalFontSize;
              var widthAtMinFont = measuredWidth * fontRatio;
              if (widthAtMinFont > maxWidth) {
                newScaleX = originalScaleX * (maxWidth / widthAtMinFont);
              }
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

            // For multi-line text: expand rects if needed, center text in rect
            if (tspans.length > 1) {
              var numLines = tspans.length;
              var newLineHeight = newFontSize * 1.0;

              // Get viewBox dimensions
              var vbMatch = result.match(/viewBox=["']\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*["']/);
              if (!vbMatch) {
                resolve(result);
                return;
              }
              var vbX = parseFloat(vbMatch[1]);
              var vbY = parseFloat(vbMatch[2]);
              var vbW = parseFloat(vbMatch[3]);
              var vbH = parseFloat(vbMatch[4]);

              // Get original rect dimensions (find the main content rect, not background)
              var origRectY = null;
              var origRectHeight = null;
              var rectInfoMatch = result.match(/<rect[^>]*\by=["']([\d.\-]+)["'][^>]*height=["']([\d.]+)["']/i);
              if (!rectInfoMatch) {
                rectInfoMatch = result.match(/<rect[^>]*height=["']([\d.]+)["'][^>]*\by=["']([\d.\-]+)["']/i);
                if (rectInfoMatch) {
                  origRectHeight = parseFloat(rectInfoMatch[1]);
                  origRectY = parseFloat(rectInfoMatch[2]);
                }
              } else {
                origRectY = parseFloat(rectInfoMatch[1]);
                origRectHeight = parseFloat(rectInfoMatch[2]);
              }
              if (!origRectHeight) origRectHeight = vbH * 0.6;
              if (origRectY === null) origRectY = vbY + (vbH - origRectHeight) / 2;

              // Calculate text block height (with padding)
              var totalTextHeight = (numLines - 1) * newLineHeight + newFontSize * 0.7;
              var textPadding = newFontSize * 0.4; // padding above and below text

              // Calculate extra height needed
              var extraHeight = Math.max(0, totalTextHeight + textPadding * 2 - origRectHeight);

              // Expand rects and viewBox if needed
              if (extraHeight > 0) {
                result = result.replace(/<rect([^>]*?)\/>/gi, function (m, attrs) {
                  // Skip background rects
                  if (attrs.match(/fill=["']#FFFFFF["']/i) || attrs.match(/fill=["']white["']/i)) {
                    var wMatch = attrs.match(/width=["']([\d.]+)["']/);
                    if (wMatch && parseFloat(wMatch[1]) > vbW * 0.9) {
                      return m;
                    }
                  }
                  var hM = attrs.match(/height=["']([\d.]+)["']/);
                  var yM = attrs.match(/\by=["']([\d.\-]+)["']/);
                  if (!hM) return m;
                  var newH = parseFloat(hM[1]) + extraHeight;
                  var na = attrs.replace(/height=["'][\d.]+["']/, 'height="' + newH.toFixed(2) + '"');
                  if (yM) {
                    var newY = parseFloat(yM[1]) - extraHeight / 2;
                    na = na.replace(/\by=["'][\d.\-]+["']/, 'y="' + newY.toFixed(2) + '"');
                  }
                  return '<rect' + na + '/>';
                });
                result = result.replace(/<rect([^>]*?)>/gi, function (m, attrs) {
                  if (m.endsWith('/>')) return m;
                  if (attrs.match(/fill=["']#FFFFFF["']/i) || attrs.match(/fill=["']white["']/i)) {
                    var wMatch = attrs.match(/width=["']([\d.]+)["']/);
                    if (wMatch && parseFloat(wMatch[1]) > vbW * 0.9) {
                      return m;
                    }
                  }
                  var hM = attrs.match(/height=["']([\d.]+)["']/);
                  var yM = attrs.match(/\by=["']([\d.\-]+)["']/);
                  if (!hM) return m;
                  var newH = parseFloat(hM[1]) + extraHeight;
                  var na = attrs.replace(/height=["'][\d.]+["']/, 'height="' + newH.toFixed(2) + '"');
                  if (yM) {
                    var newY = parseFloat(yM[1]) - extraHeight / 2;
                    na = na.replace(/\by=["'][\d.\-]+["']/, 'y="' + newY.toFixed(2) + '"');
                  }
                  return '<rect' + na + '>';
                });
                var vbM = result.match(/viewBox=["']\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*["']/);
                if (vbM) {
                  var nvbY = (parseFloat(vbM[2]) - extraHeight / 2).toFixed(2);
                  var nvbH = (parseFloat(vbM[4]) + extraHeight).toFixed(2);
                  var nvb = parseFloat(vbM[1]).toFixed(2) + ' ' + nvbY + ' ' + parseFloat(vbM[3]).toFixed(2) + ' ' + nvbH;
                  result = result.replace(/viewBox=["'][^"']*["']/, 'viewBox="' + nvb + '"');
                }
              }

              // Calculate tspan dy values for vertical centering
              // First line: shift up by half the total span, then down by cap-height offset
              // The 0.45*fontSize accounts for all-caps visual center being above baseline
              // Other lines: shift down by lineHeight
              var totalSpan = (numLines - 1) * newLineHeight;
              var firstDy = -totalSpan / 2 + newFontSize * 0.40;

              var lineIdx = 0;
              result = result.replace(/<tspan([^>]*?)dy=["']([\d.\-]+)["']/gi, function () {
                var before = arguments[1];
                var newDy = (lineIdx === 0) ? firstDy : newLineHeight;
                lineIdx++;
                return '<tspan' + before + 'dy="' + newDy.toFixed(2) + '"';
              });

              // Position text at RECT center (not viewBox center)
              // After expansion, rect Y is shifted up by extraHeight/2
              var finalRectY = origRectY - extraHeight / 2;
              var finalRectHeight = origRectHeight + extraHeight;
              var rectCenterY = finalRectY + finalRectHeight / 2;

              var curTransformMulti = SvgRenderer._getTextAttribute(result, textIndex, 'transform');
              if (curTransformMulti) {
                var mMatchMulti = curTransformMulti.match(/matrix\(\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*\)/);
                if (mMatchMulti) {
                  // Keep horizontal position, set vertical to rect center
                  var newTy = rectCenterY;
                  var newMatMulti = 'matrix(' + mMatchMulti[1] + ' ' + mMatchMulti[2] + ' ' + mMatchMulti[3] + ' ' + mMatchMulti[4] + ' ' + mMatchMulti[5] + ' ' + newTy.toFixed(4) + ')';
                  result = SvgRenderer._setTextAttribute(result, textIndex, 'transform', newMatMulti);
                }
              }
            }

            // ---- FIT VIEWBOX TO CONTENT ----
            // These templates may use <path> elements for stamp frames (not <rect>).
            // Strategy: find all visual content bounds and fit viewBox tightly.

            var hvbMatch = result.match(/viewBox=["']\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*["']/);
            if (hvbMatch) {
              var hvbX = parseFloat(hvbMatch[1]);
              var hvbY = parseFloat(hvbMatch[2]);
              var hvbW = parseFloat(hvbMatch[3]);
              var hvbH = parseFloat(hvbMatch[4]);

              // Get the text transform to calculate text bounds
              var finalTransform = SvgRenderer._getTextAttribute(result, textIndex, 'transform');
              var finalScaleX = 1;
              var textTx = hvbX + hvbW / 2;
              var textTy = hvbY + hvbH / 2;
              if (finalTransform) {
                var matrixMatch = finalTransform.match(/matrix\(\s*([\d.\-]+)\s+[\d.\-]+\s+[\d.\-]+\s+[\d.\-]+\s+([\d.\-]+)\s+([\d.\-]+)\s*\)/);
                if (matrixMatch) {
                  finalScaleX = parseFloat(matrixMatch[1]);
                  textTx = parseFloat(matrixMatch[2]);
                  textTy = parseFloat(matrixMatch[3]);
                }
              }

              // Calculate text bounds
              var fontRatioFinal = newFontSize / originalFontSize;
              var finalTextWidth = measuredWidth * fontRatioFinal * finalScaleX;
              var textLeft = textTx - finalTextWidth / 2;
              var textRight = textTx + finalTextWidth / 2;

              // Find stamp frame bounds from paths with stroke (the visible frame)
              var contentBounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };

              // Check rects (for rect-based templates like buton_straight_corners_gol)
              var rectMatches = result.match(/<rect[^>]*>/gi) || [];
              rectMatches.forEach(function(rectTag) {
                // Skip display:none
                if (rectTag.match(/display\s*[:=]\s*["']?none/i)) return;
                var xMatch = rectTag.match(/\bx=["']([\d.\-]+)["']/);
                var yMatch = rectTag.match(/\by=["']([\d.\-]+)["']/);
                var wMatch = rectTag.match(/\bwidth=["']([\d.]+)["']/);
                var hMatch = rectTag.match(/\bheight=["']([\d.]+)["']/);
                if (wMatch && hMatch) {
                  var rx = xMatch ? parseFloat(xMatch[1]) : 0;
                  var ry = yMatch ? parseFloat(yMatch[1]) : 0;
                  var rw = parseFloat(wMatch[1]);
                  var rh = parseFloat(hMatch[1]);
                  // Skip full-viewBox background rects
                  if (Math.abs(rw - hvbW) < 30 && Math.abs(rh - hvbH) < 30 && rx < 10 && ry < 10) return;
                  if (rx < contentBounds.minX) contentBounds.minX = rx;
                  if (rx + rw > contentBounds.maxX) contentBounds.maxX = rx + rw;
                  if (ry < contentBounds.minY) contentBounds.minY = ry;
                  if (ry + rh > contentBounds.maxY) contentBounds.maxY = ry + rh;
                }
              });

              // If we found content bounds, use them
              if (contentBounds.minX !== Infinity) {
                // Calculate stamp frame dimensions BEFORE modifications
                var frameWidth = contentBounds.maxX - contentBounds.minX;
                var frameHeight = contentBounds.maxY - contentBounds.minY;
                var frameCenterX = (contentBounds.minX + contentBounds.maxX) / 2;
                var frameCenterY = (contentBounds.minY + contentBounds.maxY) / 2;

                // CENTER TEXT at the stamp frame center
                var newFrameCenterX = frameCenterX;
                var curTrans = SvgRenderer._getTextAttribute(result, textIndex, 'transform');
                if (curTrans) {
                  var mm = curTrans.match(/matrix\(\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*\)/);
                  if (mm) {
                    var newTx = newFrameCenterX;
                    var newMat = 'matrix(' + mm[1] + ' ' + mm[2] + ' ' + mm[3] + ' ' + mm[4] + ' ' + newTx.toFixed(4) + ' ' + mm[6] + ')';
                    result = SvgRenderer._setTextAttribute(result, textIndex, 'transform', newMat);
                    textTx = newTx;
                    textLeft = textTx - finalTextWidth / 2;
                    textRight = textTx + finalTextWidth / 2;
                  }
                }

                // Expand contentBounds to include text if text extends beyond frame
                var textPadding = newFontSize * 0.5;
                if (textLeft - textPadding < contentBounds.minX) {
                  contentBounds.minX = textLeft - textPadding;
                }
                if (textRight + textPadding > contentBounds.maxX) {
                  contentBounds.maxX = textRight + textPadding;
                }

                // Add stroke width padding for viewBox
                var strokePadding = 35;
                var fitMinX = contentBounds.minX - strokePadding;
                var fitMaxX = contentBounds.maxX + strokePadding;
                var fitMinY = contentBounds.minY - strokePadding;
                var fitMaxY = contentBounds.maxY + strokePadding;

                // Calculate tight viewBox
                var fitVbX = fitMinX;
                var fitVbY = fitMinY;
                var fitVbW = fitMaxX - fitMinX;
                var fitVbH = fitMaxY - fitMinY;

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
          console.warn('autoFitText measurement failed:', e);
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
        var newTag = tag.replace(regex, '$1' + newValue + '$3');
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
    wrapper.style.lineHeight = '0';
    wrapper.innerHTML = svgString;

    // Make the inline SVG responsive
    var svgEl = wrapper.querySelector('svg');
    if (svgEl) {
      svgEl.style.width = '100%';
      svgEl.style.height = 'auto';
      svgEl.removeAttribute('width');
      svgEl.removeAttribute('height');
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
  exportPng(svgString, width, height, scale) {
    scale = scale || 2;
    return new Promise(function (resolve, reject) {
      // Create a hidden iframe that loads the SVG with Google Fonts
      var iframe = document.createElement('iframe');
      iframe.style.position = 'absolute';
      iframe.style.left = '-9999px';
      iframe.style.top = '-9999px';
      iframe.style.width = width + 'px';
      iframe.style.height = height + 'px';
      iframe.style.visibility = 'hidden';
      document.body.appendChild(iframe);

      var htmlDoc = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
        '<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@200;300;400;500;600;700&display=swap" rel="stylesheet">' +
        '<style>' +
        '@font-face{font-family:"Gunplay";src:url("/fonts/gunplay-regular.otf") format("opentype");font-weight:normal;}' +
        '@font-face{font-family:"BebasNeue";src:url("/fonts/BebasNeue-Regular.ttf") format("truetype");font-weight:normal;}' +
        '@font-face{font-family:"ArmyRust";src:url("/fonts/army-rust.ttf") format("truetype");font-weight:normal;}' +
        '*{margin:0;padding:0;}body{overflow:hidden;width:' + width + 'px;height:' + height + 'px;}' +
        '</style>' +
        '</head><body>' + svgString + '</body></html>';

      var blob = new Blob([htmlDoc], { type: 'text/html;charset=utf-8' });
      var blobUrl = URL.createObjectURL(blob);

      iframe.onload = function () {
        // Wait for fonts to load in the iframe context
        var iframeDoc = iframe.contentDocument || iframe.contentWindow.document;

        function doCapture() {
          try {
            var svgEl = iframeDoc.querySelector('svg');
            if (!svgEl) {
              cleanup();
              reject(new Error('No SVG found in iframe'));
              return;
            }

            // Serialize the rendered SVG (with fonts now resolved)
            var serializer = new XMLSerializer();
            var svgData = serializer.serializeToString(svgEl);

            // For PNG export, we need to inline the font.
            // Use canvas with the SVG as data URL
            var canvas = document.createElement('canvas');
            canvas.width = width * scale;
            canvas.height = height * scale;
            var ctx = canvas.getContext('2d');
            ctx.scale(scale, scale);

            var img = new Image();
            img.onload = function () {
              ctx.drawImage(img, 0, 0, width, height);
              canvas.toBlob(function (pngBlob) {
                cleanup();
                if (pngBlob) resolve(pngBlob);
                else reject(new Error('Canvas toBlob failed'));
              }, 'image/png');
            };
            img.onerror = function () {
              cleanup();
              reject(new Error('Failed to render SVG to image'));
            };

            var svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
            img.src = URL.createObjectURL(svgBlob);
          } catch (e) {
            cleanup();
            reject(e);
          }
        }

        function cleanup() {
          document.body.removeChild(iframe);
          URL.revokeObjectURL(blobUrl);
        }

        // Wait for fonts to load (with timeout fallback)
        if (iframe.contentDocument && iframe.contentDocument.fonts) {
          iframe.contentDocument.fonts.ready.then(function () {
            // Small extra delay for rendering
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
  }
};
