/**
 * admin-test-gallery.js
 *
 * Matrix-sweep designer for engine validation. User checks 1+ values per param,
 * sees live count of cross-product, hits Stamp to render the full batch.
 *
 * Used during Phase 0 to validate each shape (rect → sq → lined → ellipse → circle).
 */
(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────────────────
  // PARAM DEFINITIONS
  // Each param has:
  //   key       — internal name
  //   label     — display label
  //   values    — [{ key, label, iconic: bool }]
  //   getValues — optional function (text) => values  (for ROWS, computed per text)
  // ────────────────────────────────────────────────────────────────────────

  const SHAPES = [
    { key: 'rectangle', label: 'Rect',     iconic: true,  enabled: true  },
    { key: 'square',    label: 'Square',   iconic: false, enabled: false },
    { key: 'lined',     label: 'Lined',    iconic: false, enabled: false },
    { key: 'ellipse',   label: 'Ellipse',  iconic: false, enabled: false },
    { key: 'circle',    label: 'Circle',   iconic: false, enabled: false },
  ];

  const FRAMES = [
    { key: 'single', label: 'A', iconic: true },
    { key: 'double', label: 'B', iconic: true },
    { key: 'split',  label: 'C', iconic: true },
  ];

  const FILLS = [
    { key: 'empty', label: 'No',  iconic: true },
    { key: 'full',  label: 'Yes', iconic: true },
  ];

  const TEXTURES = [
    { key: '',            label: 'No',  iconic: true },
    { key: 'paper-grain', label: 'Yes', iconic: true },
  ];

  const TILTS = [
    { key: 0,   label: 'No',  iconic: true },
    { key: -10, label: 'Yes', iconic: true },
  ];

  // Pull from iconic-config.js. Iconic flag = (rank <= threshold).
  function fromIconic(paramName, iconicThreshold) {
    return IconicConfig.all(paramName).map(v => ({
      key: v.key,
      label: v.label,
      hex: v.hex,         // colors only
      weight: v.weight,   // fonts only
      rx: v.rx,           // corners only
      mixed: v.mixed,     // corners only
      iconic: v.rank <= iconicThreshold,
    }));
  }

  // PARAM CONFIG — order = display order in UI
  const PARAMS = [
    { key: 'SHAPE',   label: 'Shape',   values: SHAPES },
    { key: 'ROWS',    label: 'Rows',    values: [], dynamic: true }, // populated per text
    { key: 'FRAME',   label: 'Frame',   values: FRAMES },
    { key: 'FILL',    label: 'Fill',    values: FILLS },
    { key: 'COLOR',   label: 'Color',   values: fromIconic('COLORS',  5) },
    { key: 'FONT',    label: 'Font',    values: fromIconic('FONTS',   5) },
    { key: 'STYLE',   label: 'Style',   values: fromIconic('STYLES',  7) },
    { key: 'CORNERS', label: 'Corners', values: fromIconic('CORNERS', 3) },
    { key: 'TEXTURE', label: 'Texture', values: TEXTURES },
    { key: 'TILT',    label: 'Tilt',    values: TILTS },
  ];

  // ────────────────────────────────────────────────────────────────────────
  // STATE
  // ────────────────────────────────────────────────────────────────────────

  // checked[paramKey] = Set<string> of checked value keys (as strings for consistency)
  const checked = {};
  PARAMS.forEach(p => { checked[p.key] = new Set(); });

  let templatesByBorder = {}; // border_type → { svg, tpl, zones }
  let isRendering = false;
  let currentSessionId = null;       // groups rejects from one batch render
  let currentBatchText = '';         // text used for the current batch (single mode) — list mode sets per-string
  let currentAdminEmail = null;      // who's clicking reject
  let rejectedCount = 0;             // live count of rejected cells in current batch
  let currentMode = 'single';        // 'single' | 'word_list' | 'multi_list'

  // Default test-string lists (curated from top-300-iconic-stamp-phrases.md, lengths 2-25)
  const DEFAULT_LISTS = {
    word_list: [
      'OK', 'FYI', 'PAID', 'DRAFT', 'URGENT', 'FRAGILE',
      'APPROVED', 'INSPECTED', 'CLASSIFIED', 'CIRCULATING',
      'CONFIDENTIAL', 'CONGRATULATIONS'
    ],
    multi_list: [
      'QC OK', 'SEE ME', 'PAY NOW', 'PAST DUE', 'GREAT JOB',
      'TOP SECRET', 'FIRST CLASS', 'FINAL NOTICE', 'SECOND NOTICE',
      'HAPPY BIRTHDAY', 'MERRY CHRISTMAS', 'HANDLE WITH CARE',
      'SEASONS GREETINGS', 'HAPPY THANKSGIVING', 'PAY TO THE ORDER OF',
      'INSUFFICIENT POSTAGE'
    ],
  };
  const LIST_STORAGE_KEY = 'tg-lists-v1';

  function loadLists() {
    try {
      var raw = localStorage.getItem(LIST_STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        return {
          word_list: Array.isArray(parsed.word_list) ? parsed.word_list : DEFAULT_LISTS.word_list.slice(),
          multi_list: Array.isArray(parsed.multi_list) ? parsed.multi_list : DEFAULT_LISTS.multi_list.slice(),
        };
      }
    } catch (e) { /* fall through */ }
    return { word_list: DEFAULT_LISTS.word_list.slice(), multi_list: DEFAULT_LISTS.multi_list.slice() };
  }
  function saveLists(lists) {
    try { localStorage.setItem(LIST_STORAGE_KEY, JSON.stringify(lists)); } catch (e) {}
  }
  let editedLists = loadLists();

  // Soft / hard count thresholds for the count display color
  const SOFT_THRESHOLD = 200;
  const HARD_THRESHOLD = 1000;

  // Reason chips (admin-style; aligned with v1 plan)
  const REASON_CHIPS = [
    { key: 'text_clipping',       label: 'text clipping' },
    { key: 'border_break',        label: 'border break' },
    { key: 'low_contrast',        label: 'low contrast' },
    { key: 'decoration_intrudes', label: 'decoration intrudes text' },
    { key: 'corner_artifact',     label: 'corner artifact' },
    { key: 'nan',                 label: 'NaN / render error' },
    { key: 'other',               label: 'other (use note)' },
  ];

  // Simple uuid generator (good enough for client-side session id)
  function uuid() {
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // UI BUILDERS
  // ────────────────────────────────────────────────────────────────────────

  function $(id) { return document.getElementById(id); }

  function makeChip(paramKey, valueKey, label, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'tg-chip';
    if (opts.iconic === false) el.classList.add('tg-extra');
    if (opts.disabled) {
      el.style.opacity = '0.4';
      el.style.cursor = 'not-allowed';
      el.title = 'Not yet implemented';
    }
    el.dataset.param = paramKey;
    el.dataset.value = String(valueKey);
    el.textContent = label;
    if (!opts.disabled) {
      el.addEventListener('click', () => toggleChip(paramKey, String(valueKey), el));
    }
    return el;
  }

  function makeMoreBtn(paramKey) {
    const el = document.createElement('div');
    el.className = 'tg-more-btn';
    el.dataset.param = paramKey;
    el.textContent = 'More…';
    el.dataset.expanded = '0';
    el.addEventListener('click', () => {
      const expanded = el.dataset.expanded === '1';
      const row = el.closest('.tg-param-values');
      row.querySelectorAll('.tg-chip.tg-extra').forEach(c => {
        c.classList.toggle('tg-shown', !expanded);
      });
      el.textContent = expanded ? 'More…' : 'Less…';
      el.dataset.expanded = expanded ? '0' : '1';
    });
    return el;
  }

  function makeQuickActions(paramKey) {
    const wrap = document.createElement('span');
    wrap.className = 'tg-quick';
    const all = document.createElement('a');
    all.textContent = 'all';
    all.title = 'Check all (including More…)';
    all.addEventListener('click', () => {
      const row = $('tg-param-' + paramKey);
      row.querySelectorAll('.tg-chip').forEach(c => {
        if (c.style.cursor === 'not-allowed') return;
        if (!c.classList.contains('checked')) c.click();
      });
    });
    const none = document.createElement('a');
    none.textContent = 'none';
    none.title = 'Uncheck all';
    none.addEventListener('click', () => {
      const row = $('tg-param-' + paramKey);
      row.querySelectorAll('.tg-chip.checked').forEach(c => c.click());
    });
    wrap.appendChild(all);
    wrap.appendChild(none);
    return wrap;
  }

  function buildParamRow(param) {
    const row = document.createElement('div');
    row.className = 'tg-param-row';
    row.id = 'tg-param-' + param.key;

    const label = document.createElement('div');
    label.className = 'tg-param-label';
    label.textContent = param.label;
    row.appendChild(label);

    const valuesWrap = document.createElement('div');
    valuesWrap.className = 'tg-param-values';
    row.appendChild(valuesWrap);

    let hasExtras = false;
    for (const v of param.values) {
      const opts = { iconic: v.iconic !== false, disabled: v.enabled === false };
      const chip = makeChip(param.key, v.key, v.label, opts);
      valuesWrap.appendChild(chip);
      if (v.iconic === false) hasExtras = true;
    }
    if (hasExtras) {
      valuesWrap.appendChild(makeMoreBtn(param.key));
    }
    valuesWrap.appendChild(makeQuickActions(param.key));

    return row;
  }

  function buildAllParamRows() {
    const container = $('tg-params');
    container.innerHTML = '';
    for (const p of PARAMS) {
      container.appendChild(buildParamRow(p));
    }
  }

  function pickRowsProbeText() {
    if (currentMode === 'single') {
      return ($('tg-text').value || '').trim() || 'TEXT';
    }
    // List mode: string with most words drives ROWS options (rows are bounded by word
    // count — you can't split a word across rows). Char length is the tiebreaker.
    const strings = (editedLists[currentMode] || []).filter(s => s && s.trim().length > 0);
    if (strings.length === 0) return 'TEXT';
    const wordCount = s => s.trim().split(/\s+/).length;
    return strings.reduce((a, b) => {
      const wa = wordCount(a), wb = wordCount(b);
      if (wb > wa) return b;
      if (wb === wa && b.length > a.length) return b;
      return a;
    }, strings[0]);
  }

  function repopulateRowsForText(text) {
    const rowsParam = PARAMS.find(p => p.key === 'ROWS');
    const probeText = (text != null) ? text : pickRowsProbeText();
    let opts = [];
    try {
      // Use rectangle + Bebas as a probe. ROWS validity is mostly text-length-dependent.
      const probe = SvgRenderer.getValidRowOptions(probeText || 'TEXT', 'rectangle', 'BebasNeue');
      opts = (probe || []).filter(o => o.value !== '0' && o.value !== 0); // skip auto
    } catch (e) {
      console.warn('getValidRowOptions failed:', e);
      opts = [{ value: '1A', label: '1A' }];
    }
    rowsParam.values = opts.map(o => ({ key: o.value, label: o.label || o.value, iconic: true }));
    // Reset checked rows that are no longer valid
    const valid = new Set(rowsParam.values.map(v => String(v.key)));
    for (const k of Array.from(checked.ROWS)) {
      if (!valid.has(k)) checked.ROWS.delete(k);
    }
    // Rebuild ROWS row
    const oldRow = $('tg-param-ROWS');
    const newRow = buildParamRow(rowsParam);
    oldRow.replaceWith(newRow);
    // Re-apply checked state visually
    syncCheckedVisual();
    updateCount();
  }

  function syncCheckedVisual() {
    document.querySelectorAll('.tg-chip').forEach(chip => {
      const p = chip.dataset.param;
      const v = chip.dataset.value;
      if (checked[p] && checked[p].has(v)) chip.classList.add('checked');
      else chip.classList.remove('checked');
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // STATE / COUNT
  // ────────────────────────────────────────────────────────────────────────

  function toggleChip(paramKey, valueKey, el) {
    const set = checked[paramKey];
    if (set.has(valueKey)) {
      set.delete(valueKey);
      el.classList.remove('checked');
    } else {
      set.add(valueKey);
      el.classList.add('checked');
    }
    updateCount();
  }

  function getActiveStrings() {
    if (currentMode === 'single') {
      const t = ($('tg-text').value || '').trim();
      return t ? [t] : [];
    }
    return (editedLists[currentMode] || []).filter(s => s && s.trim().length > 0);
  }

  function calculateCount() {
    // Multiplier from non-ROWS params (all required ≥1 each)
    let nonRows = 1;
    for (const p of PARAMS) {
      if (p.key === 'ROWS') continue;
      const n = checked[p.key].size;
      if (n === 0) return 0;
      nonRows *= n;
    }
    // Single mode: user-checked rows × multiplier
    if (currentMode === 'single') {
      const r = checked.ROWS.size;
      if (r === 0) return 0;
      return nonRows * r;
    }
    // List mode: sum per string (rows depend on text)
    const strings = getActiveStrings();
    if (strings.length === 0) return 0;
    const checkedRowKeys = Array.from(checked.ROWS); // user-checked subset (may be empty meaning none)
    if (checkedRowKeys.length === 0) return 0;
    let total = 0;
    for (const s of strings) {
      let opts = [];
      try { opts = (SvgRenderer.getValidRowOptions(s, 'rectangle', 'BebasNeue') || []).filter(o => o.value !== '0' && o.value !== 0); }
      catch (e) { opts = [{ value: '1' }]; }
      const validKeys = new Set(opts.map(o => String(o.value)));
      const useableRows = checkedRowKeys.filter(k => validKeys.has(String(k)));
      total += nonRows * useableRows.length;
    }
    return total;
  }

  function updateCount() {
    const c = calculateCount();
    const el = $('tg-count');
    el.textContent = 'Count: ' + c.toLocaleString();
    el.classList.remove('warn', 'danger');
    if (c > HARD_THRESHOLD) el.classList.add('danger');
    else if (c > SOFT_THRESHOLD) el.classList.add('warn');
    $('tg-stamp-btn').disabled = (c === 0 || isRendering);
  }

  // ────────────────────────────────────────────────────────────────────────
  // TEMPLATE LOADING (Supabase)
  // ────────────────────────────────────────────────────────────────────────

  async function loadTemplatesIfNeeded() {
    if (Object.keys(templatesByBorder).length > 0) return;
    setStatus('Loading templates…');
    if (!SvgRenderer._fontConfig) await SvgRenderer.loadFontConfig();

    const { data: templates, error } = await sb
      .from('templates')
      .select('*, text_zones(*)')
      .eq('is_active', true)
      .eq('fill_type', 'empty');

    if (error) { setStatus('Failed to load templates: ' + error.message); return; }

    const storageBaseUrl = sb.storage.from('templates').getPublicUrl('').data.publicUrl;
    const svgPromises = templates.map(tpl => {
      const url = storageBaseUrl.replace(/\/$/, '') + '/' + tpl.svg_path;
      return SvgRenderer.fetchSvg(url).catch(() => null);
    });
    const svgs = await Promise.all(svgPromises);

    for (let i = 0; i < templates.length; i++) {
      if (!svgs[i]) continue;
      const tpl = templates[i];
      let cleaned = SvgRenderer.cleanSvgString(svgs[i]);
      cleaned = SvgRenderer.uniquifySvgIds(cleaned);
      const bt = tpl.border_type || 'simple';
      if (!templatesByBorder[bt]) {
        const editZones = (tpl.text_zones || [])
          .filter(z => z.is_editable)
          .sort((a, b) => a.sort_order - b.sort_order);
        templatesByBorder[bt] = { svg: cleaned, tpl: tpl, zones: editZones };
      }
    }
    setStatus('Loaded ' + Object.keys(templatesByBorder).length + ' border templates');
  }

  // ────────────────────────────────────────────────────────────────────────
  // MATRIX ENUMERATION + RENDER
  // ────────────────────────────────────────────────────────────────────────

  function enumerate() {
    const lists = PARAMS.map(p => Array.from(checked[p.key]));
    const combos = [];
    function recur(idx, current) {
      if (idx === PARAMS.length) { combos.push(Object.assign({}, current)); return; }
      for (const v of lists[idx]) {
        current[PARAMS[idx].key] = v;
        recur(idx + 1, current);
      }
    }
    recur(0, {});
    return combos;
  }

  function findValueMeta(paramKey, valueKey) {
    const param = PARAMS.find(p => p.key === paramKey);
    return param.values.find(v => String(v.key) === String(valueKey));
  }

  async function renderOne(text, combo) {
    const styleKey = combo.STYLE;
    let entry = templatesByBorder[styleKey];
    if (!entry) entry = templatesByBorder['simple']; // fallback for missing border templates
    if (!entry) return null;

    const zone = entry.zones && entry.zones[0];
    const idx = zone ? (zone.svg_element_index || 0) : 0;
    const originalScaleX = zone && zone.transform_matrix
      ? parseFloat((zone.transform_matrix.match(/matrix\(\s*([\d.]+)/) || [])[1]) || 1
      : 1;

    const fontMeta  = findValueMeta('FONT',  combo.FONT);
    const colorMeta = findValueMeta('COLOR', combo.COLOR);
    const fontWeight = (fontMeta && fontMeta.weight) ? String(fontMeta.weight) : '400';
    const colorHex  = colorMeta ? colorMeta.hex : '#FF0000';

    try {
      const svg = await SvgRenderer.renderStamp({
        svg: entry.svg,
        text: text.toUpperCase(),
        textZoneIdx: idx,
        boundingWidth: zone ? zone.bounding_width : 1,
        fontSize: zone ? (zone.font_size || 128) : 128,
        originalScaleX: originalScaleX,
        font: combo.FONT,
        fontWeight: fontWeight,
        color: colorHex,
        fill: combo.FILL,
        shape: combo.SHAPE,
        corners: combo.CORNERS,
        frame: combo.FRAME,
        borderStyle: styleKey,
        texture: combo.TEXTURE,
        tilt: parseFloat(combo.TILT) || 0,
        forceLines: combo.ROWS,
        fullMode: false,
        rowVariant: ''
      });
      return svg;
    } catch (err) {
      console.warn('renderStamp failed for combo', combo, err);
      return null;
    }
  }

  function makeMetaText(combo) {
    // Multi-line, readable. Visible when hovering or click-pinned.
    return [
      'shape:    ' + combo.SHAPE,
      'rows:     ' + combo.ROWS,
      'frame:    ' + combo.FRAME,
      'fill:     ' + combo.FILL,
      'color:    ' + combo.COLOR,
      'font:     ' + combo.FONT,
      'style:    ' + combo.STYLE,
      'corners:  ' + combo.CORNERS,
      'texture:  ' + (combo.TEXTURE || 'no'),
      'tilt:     ' + combo.TILT,
    ].join('\n');
  }

  // ────────────────────────────────────────────────────────────────────────
  // CELL DECORATION (action buttons, reject popover, click-to-pin)
  // ────────────────────────────────────────────────────────────────────────

  function makeRejectPopover(cell, combo) {
    const pop = document.createElement('div');
    pop.className = 'tg-reject-popover';
    const title = document.createElement('div');
    title.className = 'tg-reject-popover-title';
    title.textContent = 'Reject reason:';
    pop.appendChild(title);
    let selectedReason = null;
    REASON_CHIPS.forEach(r => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tg-reason-chip';
      chip.textContent = r.label;
      chip.dataset.reasonKey = r.key;
      chip.addEventListener('click', e => {
        e.stopPropagation();
        selectedReason = r.key;
        pop.querySelectorAll('.tg-reason-chip').forEach(c => c.style.background = '#fff7f7');
        chip.style.background = '#ffd0d0';
        confirmBtn.disabled = false;
      });
      pop.appendChild(chip);
    });
    const note = document.createElement('textarea');
    note.placeholder = 'Optional note…';
    // Typing a note auto-selects the "other (use note)" chip so Reject enables
    note.addEventListener('input', () => {
      if (note.value.trim() && !selectedReason) {
        const otherChip = pop.querySelector('.tg-reason-chip[data-reason-key="other"]');
        if (otherChip) otherChip.click();
      }
    });
    pop.appendChild(note);
    const actions = document.createElement('div');
    actions.className = 'tg-reject-popover-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'tg-reject-popover-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', e => { e.stopPropagation(); pop.classList.remove('tg-open'); });
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'tg-reject-popover-confirm';
    confirmBtn.textContent = 'Reject';
    confirmBtn.disabled = true;
    confirmBtn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!selectedReason) return;
      confirmBtn.disabled = true;
      confirmBtn.textContent = '…';
      const ok = await persistRejection(combo, selectedReason, note.value.trim());
      if (ok) {
        markCellRejected(cell, selectedReason);
        pop.classList.remove('tg-open');
        rejectedCount++;
        updateStatusSummary();
      } else {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Retry';
      }
    });
    actions.appendChild(cancel);
    actions.appendChild(confirmBtn);
    pop.appendChild(actions);
    // Stop popover internal clicks from closing the popover via outside-click handler
    pop.addEventListener('click', e => e.stopPropagation());
    return pop;
  }

  function markCellRejected(cell, reasonKey) {
    cell.classList.add('tg-rejected');
    if (!cell.querySelector('.tg-rejected-badge')) {
      const badge = document.createElement('div');
      badge.className = 'tg-rejected-badge';
      badge.textContent = '✗ ' + reasonKey;
      cell.appendChild(badge);
    } else {
      cell.querySelector('.tg-rejected-badge').textContent = '✗ ' + reasonKey;
    }
  }

  function decorateCell(cell, combo) {
    // Action buttons cluster (top-right)
    const actions = document.createElement('div');
    actions.className = 'tg-cell-actions';

    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'tg-action-btn tg-pin-btn';
    pinBtn.title = 'Pin info';
    pinBtn.textContent = 'i';
    pinBtn.addEventListener('click', e => { e.stopPropagation(); cell.classList.toggle('tg-pinned'); });

    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'tg-action-btn tg-reject-btn';
    rejectBtn.title = 'Reject this combo';
    rejectBtn.textContent = '✗';

    actions.appendChild(pinBtn);
    actions.appendChild(rejectBtn);
    cell.appendChild(actions);

    // Reject popover (created lazily on first click)
    let popover = null;
    rejectBtn.addEventListener('click', e => {
      e.stopPropagation();
      // Close any other open popover first
      document.querySelectorAll('.tg-reject-popover.tg-open').forEach(p => { if (p !== popover) p.classList.remove('tg-open'); });
      if (!popover) {
        popover = makeRejectPopover(cell, combo);
        cell.appendChild(popover);
      }
      popover.classList.toggle('tg-open');
    });
  }

  // Close any open reject popovers when clicking outside
  document.addEventListener('click', () => {
    document.querySelectorAll('.tg-reject-popover.tg-open').forEach(p => p.classList.remove('tg-open'));
  });

  // ────────────────────────────────────────────────────────────────────────
  // PERSISTENCE — Supabase `rejections` table
  // ────────────────────────────────────────────────────────────────────────

  async function persistRejection(combo, reasonKey, notes) {
    if (typeof sb === 'undefined' || !sb || !sb.from) {
      alert('Supabase client not loaded — cannot persist rejection.');
      return false;
    }
    try {
      const cellText = (combo && combo._text) ? combo._text : currentBatchText;
      const cleanCombo = Object.assign({}, combo);
      delete cleanCombo._text;
      const { error } = await sb.from('rejections').insert({
        text: cellText,
        combo: cleanCombo,
        reason: reasonKey,
        notes: notes || null,
        session_id: currentSessionId,
        rejected_by: currentAdminEmail || 'unknown',
      });
      if (error) {
        if ((error.code === 'PGRST204' || /relation .* does not exist/i.test(error.message || ''))
          || /Could not find/i.test(error.message || '')) {
          alert('The `rejections` table does not exist yet.\n\nRun this migration first:\n  migrations/rejections-table.sql\n\nIn the Supabase SQL editor.');
        } else {
          alert('Failed to persist rejection: ' + error.message);
          console.error('persistRejection error:', error);
        }
        return false;
      }
      return true;
    } catch (err) {
      console.error('persistRejection threw:', err);
      alert('Persist failed: ' + err.message);
      return false;
    }
  }

  function updateStatusSummary() {
    const total = document.getElementById('tg-results').querySelectorAll('.tg-cell').length;
    const el = document.getElementById('tg-status');
    if (rejectedCount > 0) {
      el.innerHTML = 'Done: <strong>' + total + '</strong> stamps for "' + currentBatchText
        + '" — <span class="tg-rejected-count">' + rejectedCount + ' rejected</span>';
      el.className = 'tg-status tg-status-summary';
    } else {
      el.textContent = 'Done: ' + total + ' stamps for "' + currentBatchText + '"';
      el.className = 'tg-status';
    }
    // Enable Send-to-Claude button when there's at least one rejection
    const sendBtn = document.getElementById('tg-send-claude-btn');
    if (sendBtn) sendBtn.disabled = (rejectedCount === 0);
  }

  // ────────────────────────────────────────────────────────────────────────
  // SEND TO CLAUDE — fetch rejections for current session, format, copy to clipboard
  // ────────────────────────────────────────────────────────────────────────

  function showToast(msg, isError) {
    const el = document.getElementById('tg-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('tg-toast-error', !!isError);
    el.classList.add('tg-toast-show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove('tg-toast-show'), 3500);
  }

  function formatRejectionsForClaude(text, sessionId, rows) {
    const lines = [];
    lines.push('Hey Claude — please look at this batch of rejections from the test gallery.');
    lines.push('');
    lines.push('**Session:** `' + sessionId + '`');
    lines.push('**Text rendered:** "' + text + '"');
    lines.push('**Total rejections:** ' + rows.length);
    lines.push('');
    lines.push('Query: `select * from rejections where session_id = \'' + sessionId + '\'` for full data, or read the table below.');
    lines.push('');
    lines.push('| # | Reason | Style | Corners | Frame | Fill | Color | Font | Tex | Tilt | Rows | Note |');
    lines.push('|---|--------|-------|---------|-------|------|-------|------|-----|------|------|------|');
    rows.forEach((r, i) => {
      const c = r.combo || {};
      lines.push([
        i + 1,
        r.reason,
        c.STYLE || '-',
        c.CORNERS || '-',
        c.FRAME || '-',
        c.FILL || '-',
        c.COLOR || '-',
        c.FONT || '-',
        c.TEXTURE || '-',
        c.TILT || '-',
        c.ROWS || '-',
        (r.notes || '').replace(/\|/g, '\\|').replace(/\n/g, ' '),
      ].map(v => String(v)).join(' | '));
    });
    lines.push('');
    lines.push('Cluster by combo dimension and fix root causes. Then I\'ll regenerate the same batch and compare.');
    return lines.join('\n');
  }

  async function sendToClaude() {
    if (typeof sb === 'undefined' || !sb) {
      showToast('Supabase client not loaded.', true);
      return;
    }
    if (!currentSessionId) {
      showToast('No current session — generate a batch first.', true);
      return;
    }
    const btn = document.getElementById('tg-send-claude-btn');
    if (btn) { btn.disabled = true; btn.textContent = '…fetching…'; }
    try {
      const { data, error } = await sb
        .from('rejections')
        .select('reason, notes, combo, rejected_at')
        .eq('session_id', currentSessionId)
        .order('rejected_at', { ascending: true });
      if (error) {
        showToast('Fetch failed: ' + error.message, true);
        return;
      }
      if (!data || data.length === 0) {
        showToast('No rejections found for this session.', true);
        return;
      }
      const md = formatRejectionsForClaude(currentBatchText, currentSessionId, data);
      try {
        await navigator.clipboard.writeText(md);
        showToast('Copied ' + data.length + ' rejection' + (data.length === 1 ? '' : 's') + ' to clipboard. Paste into Claude chat.');
      } catch (clipErr) {
        // Fallback: show in a prompt for manual copy
        console.warn('Clipboard write failed, falling back to prompt:', clipErr);
        window.prompt('Copy this and paste into Claude chat:', md);
      }
    } catch (err) {
      console.error('sendToClaude error:', err);
      showToast('Send failed: ' + err.message, true);
    } finally {
      if (btn) { btn.disabled = (rejectedCount === 0); btn.textContent = '📤 Send to Claude'; }
    }
  }

  async function generate() {
    if (isRendering) return;
    const strings = getActiveStrings();
    if (strings.length === 0) {
      setStatus(currentMode === 'single' ? 'Type some text first.' : 'List is empty.');
      return;
    }
    isRendering = true;
    rejectedCount = 0;
    currentSessionId = uuid();
    updateCount();

    await loadTemplatesIfNeeded();

    const grid = $('tg-results');
    grid.innerHTML = '';
    const checkedRowKeys = Array.from(checked.ROWS);
    let totalRendered = 0;
    let totalPlanned = calculateCount();
    setStatus('Preparing ' + totalPlanned + ' stamps across ' + strings.length + ' string' + (strings.length === 1 ? '' : 's') + '…');

    const CHUNK = 20;
    for (const s of strings) {
      // Per-string: filter rows to those valid for THIS string
      let opts = [];
      try { opts = (SvgRenderer.getValidRowOptions(s, 'rectangle', 'BebasNeue') || []).filter(o => o.value !== '0' && o.value !== 0); }
      catch (e) { opts = [{ value: '1' }]; }
      const validKeys = new Set(opts.map(o => String(o.value)));
      const stringRows = checkedRowKeys.filter(k => validKeys.has(String(k)));
      if (stringRows.length === 0) continue; // skip strings with no valid rows
      currentBatchText = s; // last-set is what /admin/review session_id refers to as "the batch text"
      const combos = enumerateForRows(stringRows);
      if (combos.length === 0) continue;

      // Section header per string
      const header = document.createElement('div');
      header.className = 'tg-results-section-header';
      header.textContent = '— ' + s + '  (' + combos.length + ' stamp' + (combos.length === 1 ? '' : 's') + ')';
      grid.appendChild(header);

      for (let i = 0; i < combos.length; i += CHUNK) {
        const slice = combos.slice(i, i + CHUNK);
        await Promise.all(slice.map(async combo => {
          const svg = await renderOne(s, combo);
          const cell = document.createElement('div');
          cell.className = 'tg-cell';
          if (svg) cell.innerHTML = svg;
          else { cell.classList.add('tg-broken'); cell.textContent = 'render failed'; }
          const meta = document.createElement('div');
          meta.className = 'tg-meta';
          meta.textContent = 'text:     ' + s + '\n' + makeMetaText(combo);
          const hint = document.createElement('span');
          hint.className = 'tg-meta-pin-hint';
          hint.textContent = '(click "i" to pin)';
          meta.appendChild(hint);
          cell.appendChild(meta);
          // Override combo's text for rejection persistence
          decorateCell(cell, Object.assign({}, combo, { _text: s }));
          grid.appendChild(cell);
        }));
        totalRendered += slice.length;
        setStatus('Rendered ' + totalRendered + ' / ' + totalPlanned);
        await new Promise(r => setTimeout(r, 0));
      }
    }

    if (totalRendered === 0) {
      setStatus('Nothing rendered — check at least one value per param + valid rows.');
    } else {
      currentBatchText = strings.length === 1 ? strings[0] : (strings.length + ' strings');
      updateStatusSummary();
    }
    isRendering = false;
    updateCount();
  }

  // Enumerate cross-product of currently-checked params, but with a custom rows array (for list mode)
  function enumerateForRows(rowKeys) {
    const lists = PARAMS.map(p => p.key === 'ROWS' ? rowKeys.slice() : Array.from(checked[p.key]));
    const combos = [];
    function recur(idx, current) {
      if (idx === PARAMS.length) { combos.push(Object.assign({}, current)); return; }
      for (const v of lists[idx]) {
        current[PARAMS[idx].key] = v;
        recur(idx + 1, current);
      }
    }
    recur(0, {});
    return combos;
  }

  function setStatus(msg) { $('tg-status').textContent = msg; }

  // ────────────────────────────────────────────────────────────────────────
  // INIT
  // ────────────────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', async () => {
    let profile = null;
    // Localhost dev bypass: ?dev=1 skips admin auth so Playwright/local testing works without a session.
    var devBypass = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
                 && new URLSearchParams(location.search).has('dev');
    if (devBypass) {
      profile = { email: 'dev@localhost' };
    } else {
      try { profile = await requireAdmin(); }
      catch (e) { console.error('Admin check failed:', e); window.location.href = '/'; return; }
      if (!profile) return;
    }
    document.body.classList.remove('page-loading');
    document.getElementById('admin-email').textContent = profile.email;
    currentAdminEmail = profile.email;

    buildAllParamRows();
    repopulateRowsForText($('tg-text').value);
    updateCount();

    // Text input — debounce row repopulation
    let textTimer = null;
    $('tg-text').addEventListener('input', () => {
      clearTimeout(textTimer);
      textTimer = setTimeout(() => {
        repopulateRowsForText($('tg-text').value);
      }, 300);
    });

    // Mode radios — toggle single vs list UI, pick correct ROWS probe
    const listArea = $('tg-list-area');
    const singleRow = $('tg-single-row');
    const listTextarea = $('tg-list-textarea');
    const resetBtn = $('tg-list-reset');

    function applyMode(mode) {
      currentMode = mode;
      const isList = (mode !== 'single');
      // Toggle visibility
      if (isList) {
        listArea.classList.add('tg-show');
        // Single-mode text input is hidden in list mode (count + buttons stay visible above textarea)
        $('tg-text').style.display = 'none';
      } else {
        listArea.classList.remove('tg-show');
        $('tg-text').style.display = '';
      }
      // Populate textarea from edited list when entering list mode
      if (isList) {
        listTextarea.value = (editedLists[mode] || []).join('\n');
      }
      repopulateRowsForText(null); // null → use current-mode probe text
      updateCount();
    }

    document.querySelectorAll('input[name="tg-mode"]').forEach(radio => {
      radio.addEventListener('change', e => {
        if (e.target.checked) applyMode(e.target.value);
      });
    });

    // Textarea input — debounced save + row repopulation
    let listTimer = null;
    listTextarea.addEventListener('input', () => {
      clearTimeout(listTimer);
      listTimer = setTimeout(() => {
        const lines = listTextarea.value.split('\n').map(s => s.trim()).filter(Boolean);
        if (currentMode !== 'single') {
          editedLists[currentMode] = lines;
          saveLists(editedLists);
          repopulateRowsForText(null);
          updateCount();
        }
      }, 300);
    });

    // Reset button — restore default for current mode
    resetBtn.addEventListener('click', () => {
      if (currentMode === 'single') return;
      editedLists[currentMode] = DEFAULT_LISTS[currentMode].slice();
      saveLists(editedLists);
      listTextarea.value = editedLists[currentMode].join('\n');
      repopulateRowsForText(null);
      updateCount();
    });

    $('tg-stamp-btn').addEventListener('click', generate);
    const sendBtn = $('tg-send-claude-btn');
    if (sendBtn) sendBtn.addEventListener('click', sendToClaude);
  });

})();
