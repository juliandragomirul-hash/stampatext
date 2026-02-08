/**
 * StampApp - Landing page orchestrator
 * Handles: stamp button, show more, filters modal, download auth gate.
 */
(function () {
  // ---- Constants ----
  var INITIAL_COUNT = 9;
  var DEFAULT_PAGE_SIZE = 9;

  // ---- Custom color palette ----
  var PALETTE_COLORS = [
    '#000000', '#FF0000', '#8B0000', '#FF1493', '#FF4500',
    '#FF8C00', '#FFD700', '#FFFF00', '#BDB76B', '#9400D3',
    '#4B0082', '#7CFC00', '#32CD32', '#00FF7F', '#008000',
    '#808000', '#556B2F', '#00FFFF', '#00CED1', '#4682B4',
    '#1E90FF', '#4169E1', '#000080', '#8B4513', '#FFFFFF',
    '#C0C0C0', '#A9A9A9'
  ];

  // ---- State ----
  var currentFilters = { colors: [], tilts: [], textures: [], shapes: [], objects: [] };
  var currentPageSize = DEFAULT_PAGE_SIZE;
  var isProcessing = false;

  // ---- Init ----
  document.addEventListener('DOMContentLoaded', function () {
    // Stamp button
    document.getElementById('stamp-btn').addEventListener('click', handleStamp);

    // Also stamp on Enter key
    document.getElementById('stamp-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') handleStamp();
    });

    // Delegated: Show more + Change preferences buttons (inside batch sections)
    document.addEventListener('click', function (e) {
      if (e.target.closest('.btn-batch-show-more')) {
        handleShowMore();
      }
      if (e.target.closest('.btn-batch-change-prefs')) {
        openFiltersModal();
      }
    });

    // Apply filters button
    document.getElementById('btn-apply-filters').addEventListener('click', handleApplyFilters);

    // Close filters modal
    document.getElementById('filters-modal-close').addEventListener('click', closeFiltersModal);

    // Click outside modal to close
    document.getElementById('filters-modal').addEventListener('click', function (e) {
      if (e.target === this) closeFiltersModal();
    });

    // Build color palette
    buildColorPalette();

    // Delegated zoom handler for stamp card previews (works after sessionStorage restore too)
    document.getElementById('results-batches').addEventListener('click', function(e) {
      var preview = e.target.closest('.stamp-card-preview');
      if (!preview) return;
      var svgEl = preview.querySelector('svg');
      if (svgEl) {
        Gallery.showZoomOverlay(svgEl.outerHTML);
      }
    });

    // Restore search from URL param (for back navigation / shared links)
    var urlParams = new URLSearchParams(window.location.search);
    var textParam = urlParams.get('text');
    if (textParam) {
      document.getElementById('stamp-input').value = textParam;

      if (window.__galleryVariantParams) {
        // Deterministic restore from saved variant params
        restoreFromParams(textParam, window.__galleryVariantParams);
      } else {
        handleStamp();
      }
    }

    // Select all toggles in preferences modal
    document.querySelectorAll('.filter-select-all').forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        var targetId = this.dataset.target;
        var container = document.getElementById(targetId);
        if (!container) return;

        if (targetId === 'color-palette') {
          // Toggle color swatches
          var swatches = container.querySelectorAll('.color-swatch');
          var allSelected = Array.prototype.every.call(swatches, function (s) { return s.classList.contains('selected'); });
          swatches.forEach(function (s) {
            if (allSelected) {
              s.classList.remove('selected');
            } else {
              s.classList.add('selected');
            }
          });
          this.textContent = allSelected ? 'Select all' : 'Deselect all';
        } else {
          // Toggle checkboxes
          var checkboxes = container.querySelectorAll('input[type="checkbox"]');
          var allChecked = Array.prototype.every.call(checkboxes, function (cb) { return cb.checked; });
          checkboxes.forEach(function (cb) {
            cb.checked = !allChecked;
          });
          this.textContent = allChecked ? 'Select all' : 'Deselect all';
        }
      });
    });

    // Auth state - show/hide header buttons
    initAuthState();
  });

  // ---- Stamp handler ----
  async function handleStamp() {
    var input = document.getElementById('stamp-input');
    var text = input.value.trim();
    if (!text || isProcessing) return;

    isProcessing = true;
    var btn = document.getElementById('stamp-btn');
    btn.disabled = true;
    btn.textContent = 'Stamping...';

    // Show results area with loading
    document.getElementById('stamp-results').style.display = 'block';
    document.getElementById('results-batches').innerHTML =
      '<div class="stamp-loading">Processing templates...</div>';

    try {
      await Gallery.processAll(text);
      await Gallery.showInitialRandom(INITIAL_COUNT);

      // Update URL so back navigation restores search
      var newUrl = '/?text=' + encodeURIComponent(text);
      if (window.location.search !== '?text=' + encodeURIComponent(text)) {
        history.replaceState(null, '', newUrl);
      }
    } catch (err) {
      console.error('Stamp error:', err);
      document.getElementById('results-batches').innerHTML =
        '<div class="stamp-empty">Something went wrong. Please try again.</div>';
    } finally {
      isProcessing = false;
      btn.disabled = false;
      btn.textContent = 'Stamp';
    }
  }

  // ---- Restore from saved variant params ----
  async function restoreFromParams(text, params) {
    if (isProcessing) return;
    isProcessing = true;
    var btn = document.getElementById('stamp-btn');
    btn.disabled = true;
    btn.textContent = 'Restoring...';

    document.getElementById('stamp-results').style.display = 'block';
    document.getElementById('results-batches').innerHTML =
      '<div class="stamp-loading">Restoring your gallery...</div>';

    try {
      await Gallery.restoreVariants(text, params);

      var newUrl = '/?text=' + encodeURIComponent(text);
      if (window.location.search !== '?text=' + encodeURIComponent(text)) {
        history.replaceState(null, '', newUrl);
      }
    } catch (err) {
      console.error('Restore error, falling back to fresh generation:', err);
      // Fall back to fresh random generation
      try {
        await Gallery.processAll(text);
        await Gallery.showInitialRandom(INITIAL_COUNT);
      } catch (err2) {
        document.getElementById('results-batches').innerHTML =
          '<div class="stamp-empty">Something went wrong. Please try again.</div>';
      }
    } finally {
      isProcessing = false;
      btn.disabled = false;
      btn.textContent = 'Stamp';
    }
  }

  // ---- Show more handler ----
  function handleShowMore() {
    if (Gallery.isFirstShowMore) {
      // First time: open filters modal
      openFiltersModal();
    } else {
      // Subsequent: load next page
      Gallery.showNextPage(currentPageSize);
    }
  }

  // ---- Filters ----
  function isColorDark(hex) {
    var c = hex.replace('#', '');
    var r = parseInt(c.substring(0, 2), 16);
    var g = parseInt(c.substring(2, 4), 16);
    var b = parseInt(c.substring(4, 6), 16);
    return (r * 0.299 + g * 0.587 + b * 0.114) < 150;
  }

  function buildColorPalette() {
    var palette = document.getElementById('color-palette');
    PALETTE_COLORS.forEach(function (color) {
      var swatch = document.createElement('div');
      swatch.className = 'color-swatch';
      if (isColorDark(color)) swatch.classList.add('swatch-dark');
      swatch.style.backgroundColor = color;
      swatch.dataset.color = color;
      if (color === '#FFFFFF') {
        swatch.style.border = '2px solid #d4d4d4';
      }
      swatch.addEventListener('click', function () {
        this.classList.toggle('selected');
      });
      palette.appendChild(swatch);
    });
  }

  function openFiltersModal() {
    document.getElementById('filters-modal').classList.add('active');
  }

  function closeFiltersModal() {
    document.getElementById('filters-modal').classList.remove('active');
  }

  async function handleApplyFilters() {
    // Read selected colors
    var selectedColors = [];
    document.querySelectorAll('#color-palette .color-swatch.selected').forEach(function (el) {
      selectedColors.push(el.dataset.color);
    });

    // Read selected tilts
    var selectedTilts = [];
    document.querySelectorAll('#tilt-filters input:checked').forEach(function (el) {
      selectedTilts.push(parseInt(el.value, 10));
    });

    // Read selected textures
    var selectedTextures = [];
    document.querySelectorAll('#texture-filters input:checked').forEach(function (el) {
      selectedTextures.push(el.value);
    });

    // Read selected shapes
    var selectedShapes = [];
    document.querySelectorAll('#shape-filters input:checked').forEach(function (el) {
      selectedShapes.push(el.value);
    });

    // Read selected objects
    var selectedObjects = [];
    document.querySelectorAll('#object-filters input:checked').forEach(function (el) {
      selectedObjects.push(el.value);
    });

    // Read selected quantity
    var quantityRadio = document.querySelector('#quantity-filters input[name="quantity"]:checked');
    if (quantityRadio) {
      currentPageSize = parseInt(quantityRadio.value, 10);
    }

    currentFilters = {
      colors: selectedColors,
      tilts: selectedTilts,
      textures: selectedTextures,
      shapes: selectedShapes,
      objects: selectedObjects
    };

    // Apply filters (async due to texture loading)
    await Gallery.applyFilters(currentFilters);

    // Close modal
    closeFiltersModal();

    // Show filtered results as a new batch section (stacks below previous)
    Gallery.showNextPage(currentPageSize);
  }

  // ---- Download handler (delegated) ----
  document.addEventListener('click', async function (e) {
    var btn = e.target.closest('.btn-download');
    if (!btn) return;

    e.preventDefault();

    // Check auth
    var session = await getSession();
    if (!session) {
      openModal('login');
      return;
    }

    // Check credits
    var profile = await getProfile();
    if (!profile || profile.credits < 1) {
      alert('You need at least 1 credit to download. Please purchase credits.');
      return;
    }

    // Find the SVG string for this template + color variant
    var templateId = btn.dataset.templateId;
    var appliedColor = btn.dataset.appliedColor || '';
    var result = Gallery.allResults.find(function (r) {
      return r.templateId === templateId && (r.appliedColor || '') === appliedColor;
    });
    if (!result) return;

    btn.disabled = true;
    btn.textContent = 'Preparing...';

    try {
      // Export PNG
      var pngBlob = await SvgRenderer.exportPng(
        result.svgString,
        result.width,
        result.height
      );

      // Deduct credit via API
      var token = session.access_token;
      var res = await fetch('/api/generations/record', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({
          template_id: templateId,
          input_data: { text: document.getElementById('stamp-input').value.trim() }
        })
      });

      if (!res.ok) {
        var errData = await res.json().catch(function () { return {}; });
        throw new Error(errData.error || 'Failed to record generation');
      }

      // Download
      SvgRenderer.downloadBlob(pngBlob, 'stampatext-' + Date.now() + '.png');

      // Update credits display
      var updatedProfile = await getProfile();
      if (updatedProfile) {
        var creditsEl = document.getElementById('user-credits');
        if (creditsEl) creditsEl.textContent = updatedProfile.credits + ' credits';
      }
    } catch (err) {
      console.error('Download error:', err);
      alert('Download failed: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Download PNG';
    }
  });

  // ---- Auth state for header ----
  async function initAuthState() {
    var session = await getSession();
    if (session) {
      document.getElementById('btn-login').style.display = 'none';
      document.getElementById('btn-signup').style.display = 'none';
      var goApp = document.getElementById('btn-go-app');
      if (goApp) goApp.style.display = 'inline-block';

      // Show credits in header if logged in
      var profile = await getProfile();
      if (profile) {
        var creditsEl = document.getElementById('user-credits');
        if (creditsEl) {
          creditsEl.textContent = profile.credits + ' credits';
          creditsEl.style.display = 'inline-block';
        }
      }
    }
  }
})();
