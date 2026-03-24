/**
 * One-time script: captures 100x30px top-edge crops as PNG from real rendered stamps.
 * Saves PNGs to public/img/style-icons/ for embedding in product.html.
 *
 * Usage: node capture-style-icons.js
 * Requires: server running on localhost:3000, puppeteer installed
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const STYLES = [
  'simple', 'stitch_line', 'stitch_square', 'stitch_circle',
  'sawtooth', 'perforated', 'perforated_spaced',
  'wavy', 'zigzag', 'torn_edge', 'chalk'
];

const OUT_DIR = path.join(__dirname, 'public', 'img', 'style-icons');

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  // Load product page with "congratulations"
  var url = 'http://localhost:3000/product.html?id=a10132be-db5f-4db4-861c-4c08cce4e4b6&text=congratulations&color=4B0082&font=Yomogi&frame=single&fill=empty&shape=rectangle&tilt=0';
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('#product-preview svg', { timeout: 30000 });
  await new Promise(r => setTimeout(r, 4000));

  // Force all backgrounds transparent so omitBackground captures true alpha
  await page.evaluate(function() {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    // Clear any container backgrounds
    var containers = document.querySelectorAll('.product-details, .product-preview-section, .product-preview-wrapper, #product-preview, section, main, .product-left');
    containers.forEach(function(el) { el.style.background = 'transparent'; });
  });

  for (var i = 0; i < STYLES.length; i++) {
    var style = STYLES[i];
    console.log('Processing: ' + style + ' (' + (i+1) + '/' + STYLES.length + ')');

    // Click the style dropdown toggle
    await page.evaluate(function() {
      var toggle = document.getElementById('product-border-toggle');
      if (toggle) toggle.click();
    });
    await new Promise(r => setTimeout(r, 500));

    // Click the specific style item
    await page.evaluate(function(s) {
      var items = document.querySelectorAll('#product-border-list .filter-bar-dropdown-item');
      items.forEach(function(item) {
        if (item.dataset.value === s) item.click();
      });
    }, style);

    // Wait for render
    await new Promise(r => setTimeout(r, 3000));

    // Close any open dropdown and strip white backgrounds from SVG
    await page.evaluate(function() {
      document.querySelectorAll('.filter-bar-dropdown-list').forEach(function(l) {
        l.style.display = 'none';
      });
      // Remove only the large background rect, keep decorative white shapes
      var svg = document.querySelector('#product-preview svg');
      if (svg) {
        var vbAttr = svg.getAttribute('viewBox') || '';
        var vbParts = vbAttr.trim().split(/[\s,]+/);
        var svgW = parseFloat(vbParts[2]) || 1000;
        var svgH = parseFloat(vbParts[3]) || 1000;
        svg.querySelectorAll('rect').forEach(function(r) {
          var fill = (r.getAttribute('fill') || '').toLowerCase();
          if (fill === 'white' || fill === '#fff' || fill === '#ffffff') {
            var w = parseFloat(r.getAttribute('width')) || 0;
            var h = parseFloat(r.getAttribute('height')) || 0;
            if (w >= svgW * 0.8 && h >= svgH * 0.8) {
              r.setAttribute('fill', 'none');
            }
          }
        });
      }
    });

    // Get the SVG element's bounding box
    var box = await page.evaluate(function() {
      var svg = document.querySelector('#product-preview svg');
      if (!svg) return null;
      var rect = svg.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });

    if (!box) {
      console.log('  FAILED: no SVG found');
      continue;
    }

    // Find the actual top border line position using the outer rect's Y in the SVG
    var borderCenter = await page.evaluate(function() {
      var svg = document.querySelector('#product-preview svg');
      if (!svg) return null;
      var svgRect = svg.getBoundingClientRect();
      var svgStr = svg.outerHTML;
      // Get viewBox
      var vbM = svgStr.match(/viewBox=["']([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)["']/);
      if (!vbM) return null;
      var vx = parseFloat(vbM[1]), vy = parseFloat(vbM[2]);
      var vw = parseFloat(vbM[3]), vh = parseFloat(vbM[4]);
      // Find the outer rect (largest by width, with stroke)
      var rects = svgStr.match(/<rect[^>]*>/gi) || [];
      var outerY = null, outerSw = 0;
      for (var i = 0; i < rects.length; i++) {
        var r = rects[i];
        var swM = r.match(/stroke-width=["']([^"']+)["']/);
        if (!swM) continue;
        var yM = r.match(/\by=["']([^"']+)["']/);
        if (!yM) continue;
        var sw = parseFloat(swM[1]);
        if (sw > outerSw) { outerSw = sw; outerY = parseFloat(yM[1]); }
      }
      if (outerY === null) return null;
      // Convert outerY from viewBox coords to screen pixels
      var scaleY = svgRect.height / vh;
      var screenY = svgRect.y + (outerY - vy) * scaleY;
      var scaleX = svgRect.width / vw;
      return { y: screenY, scaleX: scaleX, scaleY: scaleY, svgX: svgRect.x, svgW: svgRect.width };
    });

    // Per-style crop width
    var zoomInStyles = ['stitch_line','stitch_square','stitch_circle','sawtooth','perforated','perforated_spaced'];
    var cropW = zoomInStyles.indexOf(style) >= 0 ? 200 : 300;
    var cropH = 50;
    var cropX = box.x + (box.width - cropW) / 2;
    // Center crop vertically on the actual border line
    var cropY = borderCenter ? Math.round(borderCenter.y - cropH / 2) : box.y;

    await page.screenshot({
      path: path.join(OUT_DIR, style + '.png'),
      clip: { x: Math.round(cropX), y: Math.round(cropY), width: cropW, height: cropH },
      omitBackground: true
    });

    console.log('  Saved: ' + style + '.png (crop at ' + Math.round(cropX) + ',' + Math.round(cropY) + ')');
  }

  await browser.close();
  console.log('\nDone! Icons saved to: ' + OUT_DIR);
  console.log('\nEmbed in product.html as:');
  console.log('<img src="/img/style-icons/simple.png" width="100" height="30" />');
})().catch(function(e) {
  console.error('Error:', e.message);
  process.exit(1);
});
