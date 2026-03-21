/**
 * StampApp - Landing page orchestrator
 * Handles: stamp button, show more, filters modal, download auth gate.
 */
(function () {
  // ---- Constants ----
  var DEFAULT_PAGE_SIZE = 30;

  // ---- Custom color palette ----
  var PALETTE_COLORS = [
    '#000000', '#8B0000', '#003366', '#2D572C', '#4B0082',
    '#FF0000', '#FF6600', '#1E90FF', '#FF1493', '#32CD32'
  ];

  // ---- State ----
  var currentFilters = { colors: [], tilts: [], textures: [], shapes: [], objects: [], frames: [], borders: [], corners: [], fills: [] };
  var currentPageSize = DEFAULT_PAGE_SIZE;
  var isProcessing = false;

  // ---- Typewriter placeholder animation ----
  (function() {
    var input = document.getElementById('stamp-input');
    if (!input) return;
    var text = 'TYPE YOUR TEXT...';
    var charIndex = 0;
    var typingTimer = null;
    var cycleTimer = null;
    var isTyping = false;
    var isFocused = false;

    function typeNext() {
      if (isFocused || input.value) return;
      charIndex++;
      input.placeholder = text.substring(0, charIndex);
      if (charIndex < text.length) {
        typingTimer = setTimeout(typeNext, 3000 / text.length);
      } else {
        // Pause 10s then restart
        cycleTimer = setTimeout(startTyping, 3000);
      }
    }

    function startTyping() {
      charIndex = 0;
      input.placeholder = '';
      typingTimer = setTimeout(typeNext, 500);
    }

    input.addEventListener('focus', function() {
      isFocused = true;
      clearTimeout(typingTimer);
      clearTimeout(cycleTimer);
      if (!input.value) input.placeholder = '';
    });

    input.addEventListener('blur', function() {
      isFocused = false;
      if (!input.value) startTyping();
    });

    startTyping();
  })();

  // ---- Save scroll position before unload ----
  window.addEventListener('beforeunload', function () {
    sessionStorage.setItem('stampScrollY', window.scrollY);
  });

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

    // Delegated click handler for stamp cards
    document.getElementById('results-batches').addEventListener('click', function(e) {
      // Showcase mode: show inline input pill near click
      if (Gallery.isShowcase) {
        var card = e.target.closest('.stamp-card-preview, .stamp-card-actions');
        if (card) {
          e.preventDefault();
          var pill = document.getElementById('stamp-input-pill');
          if (pill) {
            // Position pill near the click
            var rect = card.getBoundingClientRect();
            pill.style.left = (rect.left + rect.width / 2) + 'px';
            pill.style.top = (rect.bottom + window.scrollY + 8) + 'px';
            pill.style.display = 'flex';
            var pillInput = document.getElementById('pill-input');
            if (pillInput) {
              pillInput.value = '';
              setTimeout(function() { pillInput.focus(); }, 50);
            }
          }
          return;
        }
      }
      // Normal mode: no zoom (cards are links now)
    });

    // Pill stamp button handler
    var pillBtn = document.getElementById('pill-btn');
    if (pillBtn) {
      pillBtn.addEventListener('click', function() {
        var pillInput = document.getElementById('pill-input');
        var text = pillInput ? pillInput.value.trim() : '';
        if (!text) return;
        // Copy text to main input and trigger stamp
        document.getElementById('stamp-input').value = text;
        document.getElementById('stamp-input-pill').style.display = 'none';
        handleStamp();
      });
    }
    // Pill input Enter key
    var pillInput = document.getElementById('pill-input');
    if (pillInput) {
      pillInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          pillBtn.click();
        }
      });
    }
    // Close pill on outside click
    document.addEventListener('click', function(e) {
      var pill = document.getElementById('stamp-input-pill');
      if (pill && pill.style.display !== 'none' && !pill.contains(e.target) && !e.target.closest('.stamp-card-preview')) {
        pill.style.display = 'none';
      }
    });

    // Restore search from URL param (for back navigation / shared links)
    var urlParams = new URLSearchParams(window.location.search);
    var shapeParam = urlParams.get('shape');
    if (shapeParam) Gallery.activeShape = shapeParam;
    var rowsParam = urlParams.get('rows');
    if (rowsParam) Gallery.activeRows = rowsParam;
    var textParam = urlParams.get('text');
    if (textParam) {
      document.getElementById('stamp-input').value = textParam;

      if (window.__galleryVariantParams) {
        // Deterministic restore from saved variant params
        restoreFromParams(textParam, window.__galleryVariantParams);
      } else {
        handleStamp();
      }
    } else {
      // No text param — clean homepage, no pregenerated gallery
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
          // Toggle checkboxes (skip disabled coming-soon items)
          var checkboxes = container.querySelectorAll('input[type="checkbox"]:not(:disabled)');
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
    Gallery.isShowcase = false;
    var input = document.getElementById('stamp-input');
    var text = input.value.trim();
    if (!text || isProcessing) return;

    isProcessing = true;
    var btn = document.getElementById('stamp-btn');
    btn.disabled = true;
    btn.textContent = 'Stamping...';
    // Safety: re-enable button after 30s in case finally block doesn't run
    var safetyTimer = setTimeout(function() {
      isProcessing = false;
      btn.disabled = false;
      btn.textContent = 'Stamp';
    }, 30000);

    // Show loading pill
    var loadPill = document.getElementById('loading-pill');
    if (!loadPill) {
      loadPill = document.createElement('div');
      loadPill.id = 'loading-pill';
      loadPill.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#222;color:#fff;padding:12px 28px;border-radius:24px;font-size:15px;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.3);';
      document.body.appendChild(loadPill);
    }
    loadPill.textContent = 'Loading models...';
    loadPill.style.display = '';

    // Show results area (no inline loading text — pill handles it)
    document.getElementById('stamp-results').style.display = 'block';
    var filterBar = document.getElementById('stamp-filter-bar');
    if (filterBar) filterBar.style.display = 'none';
    document.getElementById('results-batches').innerHTML = '';

    try {
      await Gallery.processAll(text);
      await Gallery.showInitialRandom();

      // Update URL so back navigation restores search (include active shape + rows)
      var activeShape = Gallery.activeShape || 'rectangle';
      var newUrl = '/?text=' + encodeURIComponent(text) + '&shape=' + activeShape;
      var rowsSelect = document.getElementById('filter-rows');
      if (rowsSelect && rowsSelect.value && activeShape === 'square') {
        newUrl += '&rows=' + rowsSelect.value;
      }
      history.replaceState(null, '', newUrl);
    } catch (err) {
      console.error('Stamp error:', err);
      document.getElementById('results-batches').innerHTML =
        '<div class="stamp-empty">Something went wrong. Please try again.</div>';
    } finally {
      clearTimeout(safetyTimer);
      isProcessing = false;
      btn.disabled = false;
      var lp = document.getElementById('loading-pill');
      if (lp) lp.style.display = 'none';
      btn.textContent = 'Stamp';
    }
  }

  // ---- Restore from saved variant params ----
  async function restoreFromParams(text, params) {
    if (isProcessing) return;
    isProcessing = true;
    var btn = document.getElementById('stamp-btn');
    btn.disabled = true;

    try {
      // Try instant restore from IndexedDB cache first
      var restored = await Gallery.restoreFromCache(text);
      if (restored) {
        // Restore scroll position
        var savedY = sessionStorage.getItem('stampScrollY');
        if (savedY) {
          sessionStorage.removeItem('stampScrollY');
          var y = parseInt(savedY, 10);
          requestAnimationFrame(function () {
            requestAnimationFrame(function () {
              window.scrollTo(0, y);
            });
          });
        }
        var restoreShape = Gallery.activeShape || 'rectangle';
        var newUrl = '/?text=' + encodeURIComponent(text) + '&shape=' + restoreShape;
        history.replaceState(null, '', newUrl);
        isProcessing = false;
        btn.disabled = false;
        btn.textContent = 'Stamp';
        return;
      }
    } catch (e) {
      // IndexedDB failed, fall through to full restore
    }

    // Cache miss — full restore from variant params
    // Show loading pill
    var loadPill2 = document.getElementById('loading-pill');
    if (!loadPill2) {
      loadPill2 = document.createElement('div');
      loadPill2.id = 'loading-pill';
      loadPill2.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#222;color:#fff;padding:12px 28px;border-radius:24px;font-size:15px;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.3);';
      document.body.appendChild(loadPill2);
    }
    loadPill2.textContent = 'Loading models...';
    loadPill2.style.display = '';
    btn.textContent = 'Restoring...';

    document.getElementById('stamp-results').style.display = 'block';
    var filterBar2 = document.getElementById('stamp-filter-bar');
    if (filterBar2) filterBar2.style.display = 'none';
    document.getElementById('results-batches').innerHTML = '';

    try {
      await Gallery.restoreVariants(text, params);

      // Restore scroll position after browser paints the gallery
      var savedY = sessionStorage.getItem('stampScrollY');
      if (savedY) {
        sessionStorage.removeItem('stampScrollY');
        var y = parseInt(savedY, 10);
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            window.scrollTo(0, y);
          });
        });
      }

      var restoreShape2 = Gallery.activeShape || 'rectangle';
      var newUrl = '/?text=' + encodeURIComponent(text) + '&shape=' + restoreShape2;
      history.replaceState(null, '', newUrl);
    } catch (err) {
      console.error('Restore error, falling back to fresh generation:', err);
      // Fall back to fresh random generation
      try {
        await Gallery.processAll(text);
        await Gallery.showInitialRandom();
      } catch (err2) {
        document.getElementById('results-batches').innerHTML =
          '<div class="stamp-empty">Something went wrong. Please try again.</div>';
      }
    } finally {
      isProcessing = false;
      btn.disabled = false;
      btn.textContent = 'Stamp';
      var lp2 = document.getElementById('loading-pill');
      if (lp2) lp2.style.display = 'none';
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

    // Read selected frames
    var selectedFrames = [];
    document.querySelectorAll('#frame-filters input:checked').forEach(function (el) {
      selectedFrames.push(el.value);
    });

    // Read selected borders
    var selectedBorders = [];
    document.querySelectorAll('#border-filters input:checked').forEach(function (el) {
      selectedBorders.push(el.value);
    });

    // Read selected corners
    var selectedCorners = [];
    document.querySelectorAll('#corner-filters input:checked').forEach(function (el) {
      selectedCorners.push(el.value);
    });

    // Read selected fills
    var selectedFills = [];
    document.querySelectorAll('#fill-filters input:checked').forEach(function (el) {
      selectedFills.push(el.value);
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
      objects: selectedObjects,
      frames: selectedFrames,
      borders: selectedBorders,
      corners: selectedCorners,
      fills: selectedFills
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
      openBuyCreditsModal();
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
  function initAuthState() {
    // Use onAuthStateChange — fires reliably once session is restored from localStorage
    sb.auth.onAuthStateChange(function (event, session) {
      if (session) {
        document.getElementById('btn-login').style.display = 'none';
        document.getElementById('btn-signup').style.display = 'none';
        var hamburger = document.getElementById('hamburger-wrapper');
        if (hamburger) hamburger.style.display = '';
        var buyBtn = document.getElementById('btn-buy-credits');
        if (buyBtn) buyBtn.style.display = 'inline-block';

        // Defer profile fetch — calling getSession() inside onAuthStateChange
        // can deadlock the Supabase client's internal session lock, blocking all queries
        setTimeout(async function() {
          try {
            var profile = await getProfile();
            if (profile) {
              var creditsEl = document.getElementById('user-credits');
              if (creditsEl) {
                creditsEl.textContent = profile.credits + ' credits';
                creditsEl.style.display = 'inline-block';
              }
              var adminLink = document.getElementById('menu-admin');
              if (adminLink && profile.role === 'admin') adminLink.style.display = '';
            }
          } catch (e) {
            console.error('Failed to load profile:', e);
          }
        }, 0);
      } else {
        // Signed out — reset header
        document.getElementById('btn-login').style.display = '';
        document.getElementById('btn-signup').style.display = '';
        var hamburger = document.getElementById('hamburger-wrapper');
        if (hamburger) hamburger.style.display = 'none';
        var creditsEl = document.getElementById('user-credits');
        if (creditsEl) creditsEl.style.display = 'none';
        var buyBtn = document.getElementById('btn-buy-credits');
        if (buyBtn) buyBtn.style.display = 'none';
      }
    });
  }
})();
