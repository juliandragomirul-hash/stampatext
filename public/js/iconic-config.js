/**
 * iconic-config.js
 *
 * Single source of truth for ranked param values across the stamp engine.
 *
 * Each param value carries a `rank` integer (1 = most iconic, N = least).
 * No iconic boolean, no per-param threshold in the data — consumers apply
 * their own cutoff/weight logic.
 *
 * Three downstream consumers:
 *   - Customizer dropdown:  topN(param, N) for default view, all(param) on "More…"
 *   - Catalog generator:    weightedRandomTopN(param, N)
 *   - Gallery:              weightedRandom(param)  (all values, low-rank-biased)
 *
 * Cutoff numbers (e.g. 5 for fonts, 7 for styles) live in the consumer code,
 * not in this data. Ranks within the iconic short list are carefully chosen;
 * ranks within the "More…" section are best-guess and refinable based on
 * engagement data without restructuring the schema.
 */
(function (global) {
  'use strict';

  // ────────────────────────────────────────────────────────────────────────
  // PARAM RANKINGS
  // ────────────────────────────────────────────────────────────────────────

  const PARAM_RANKINGS = {

    // FONT — 11 values; iconic short list = ranks 1-5
    FONTS: [
      { key: 'BebasNeue',    label: 'Bebas Neue',     rank:  1, weight: 'normal' },
      { key: 'BlackOpsOne',  label: 'Black Ops One',  rank:  2, weight: 'normal' },
      { key: 'Oswald',       label: 'Oswald',         rank:  3, weight: 500       },
      { key: 'CourierPrime', label: 'Courier Prime',  rank:  4, weight: 'normal' },
      { key: 'Bitter',       label: 'Bitter',         rank:  5, weight: 500       },
      { key: 'Montserrat',   label: 'Montserrat',     rank:  6, weight: 700       },
      { key: 'Exo2',         label: 'Exo 2',          rank:  7, weight: 700       },
      { key: 'Nunito',       label: 'Nunito',         rank:  8, weight: 900       },
      { key: 'Comfortaa',    label: 'Comfortaa',      rank:  9, weight: 700       },
      { key: 'Yomogi',       label: 'Yomogi',         rank: 10, weight: 'normal' },
      { key: 'FuzzyBubbles', label: 'Fuzzy Bubbles',  rank: 11, weight: 700       },
    ],

    // COLOR — 12 values; iconic short list = ranks 1-5
    // Custom color picker is handled separately by the UI (not part of this data).
    COLORS: [
      { key: 'red',         label: 'Red',           hex: '#FF0000', rank:  1 },
      { key: 'black',       label: 'Black',         hex: '#000000', rank:  2 },
      { key: 'darkred',     label: 'Dark Red',      hex: '#8B0000', rank:  3 },
      { key: 'navy',        label: 'Navy',          hex: '#003366', rank:  4 },
      { key: 'forest',      label: 'Forest Green',  hex: '#2D572C', rank:  5 },
      { key: 'crimson',     label: 'Crimson',       hex: '#CC0000', rank:  6 },
      { key: 'dodger',      label: 'Dodger Blue',   hex: '#1E90FF', rank:  7 },
      { key: 'indigo',      label: 'Indigo',        hex: '#4B0082', rank:  8 },
      { key: 'orange',      label: 'Orange',        hex: '#FF6600', rank:  9 },
      { key: 'goldenrod',   label: 'Goldenrod',     hex: '#DAA520', rank: 10 },
      { key: 'lime',        label: 'Lime Green',    hex: '#32CD32', rank: 11 },
      { key: 'pink',        label: 'Hot Pink',      hex: '#FF1493', rank: 12 },
    ],

    // STYLE — 14 values; iconic short list = ranks 1-7 (postage-stamp aesthetic)
    STYLES: [
      { key: 'simple',             label: 'Plain',                  rank:  1 },
      { key: 'stitch_line',        label: 'Stitch Line',            rank:  2 },
      { key: 'perf_line_spaced',   label: 'Perforate Line Spaced',  rank:  3 },
      { key: 'sawtooth',           label: 'Sawtooth',               rank:  4 },
      { key: 'perforated_spaced',  label: 'Spaced Perforated',      rank:  5 },
      { key: 'wavy',               label: 'Wavy',                   rank:  6 },
      { key: 'torn_edge',          label: 'Torn Edge',              rank:  7 },
      { key: 'perf_line',          label: 'Perforated Line',        rank:  8 },
      { key: 'perforated',         label: 'Perforated',             rank:  9 },
      { key: 'saw_line',           label: 'Saw Line',               rank: 10 },
      { key: 'stitch_square',      label: 'Stitch Square',          rank: 11 },
      { key: 'stitch_circle',      label: 'Stitch Dot',             rank: 12 },
      { key: 'zigzag',             label: 'Zigzag',                 rank: 13 },
      { key: 'chalk',              label: 'Chalk',                  rank: 14 },
    ],

    // CORNERS — 7 values; iconic short list = ranks 1-3
    // Medium removed 2026-05-05: looked identical to Strong on small stamps due to _cornerRadiusCap().
    // Strong rewritten as STADIUM (rx = height/2, width extended by height) — see svg-renderer.js.
    CORNERS: [
      { key: 'straight',           label: 'Straight',           rx: 0,                                                rank: 1 },
      { key: 'soft_round',         label: 'Soft Rounded',       rx: 35,                                               rank: 2 },
      { key: 'strong_round',       label: 'Strong Rounded',     rx: 'stadium',                                        rank: 3 },
      { key: 'mixed_top_round',    label: 'Mixed Top Round',    mixed: { tl: 35, tr: 35, br:  0, bl:  0 },            rank: 4 },
      { key: 'mixed_top_straight', label: 'Mixed Top Straight', mixed: { tl:  0, tr:  0, br: 35, bl: 35 },            rank: 5 },
      { key: 'mixed_diag_down',    label: 'Mixed Diag Down',    mixed: { tl:  0, tr: 35, br:  0, bl: 35 },            rank: 6 },
      { key: 'mixed_diag_up',      label: 'Mixed Diag Up',      mixed: { tl: 35, tr:  0, br: 35, bl:  0 },            rank: 7 },
    ],
  };

  // ────────────────────────────────────────────────────────────────────────
  // HELPER FUNCTIONS
  // ────────────────────────────────────────────────────────────────────────

  function _getList(paramName) {
    const list = PARAM_RANKINGS[paramName];
    if (!list) throw new Error('IconicConfig: unknown param "' + paramName + '"');
    return list;
  }

  /** All values for a param, sorted ascending by rank. */
  function all(paramName) {
    return _getList(paramName).slice().sort((a, b) => a.rank - b.rank);
  }

  /** Top N values for a param, sorted ascending by rank. */
  function topN(paramName, n) {
    return all(paramName).slice(0, n);
  }

  /**
   * Pick one value by weighted random across ALL values.
   * Weight formula: weight = (MAX_RANK - rank + 1)
   *   → rank 1 has weight N, rank N has weight 1
   *   → low ranks (more iconic) appear more often, but the long tail still shows up
   */
  function weightedRandom(paramName) {
    const values = all(paramName);
    const maxRank = values.length;
    const totalWeight = values.reduce((s, v) => s + (maxRank - v.rank + 1), 0);
    let r = Math.random() * totalWeight;
    for (const v of values) {
      r -= (maxRank - v.rank + 1);
      if (r <= 0) return v;
    }
    return values[0];
  }

  /**
   * Pick one value by weighted random within the top N.
   * Weight formula: weight = (n - rank + 1) — same shape as weightedRandom but
   * within a tighter pool. Used by the catalog generator for high iconic density.
   */
  function weightedRandomTopN(paramName, n) {
    const values = topN(paramName, n);
    const totalWeight = values.reduce((s, v) => s + (n - v.rank + 1), 0);
    let r = Math.random() * totalWeight;
    for (const v of values) {
      r -= (n - v.rank + 1);
      if (r <= 0) return v;
    }
    return values[0];
  }

  /** Look up a single value by key. Returns undefined if not found. */
  function getByKey(paramName, key) {
    return _getList(paramName).find(v => v.key === key);
  }

  // ────────────────────────────────────────────────────────────────────────
  // EXPORT (universal: browser global + Node module)
  // ────────────────────────────────────────────────────────────────────────

  const IconicConfig = {
    PARAM_RANKINGS,
    all,
    topN,
    weightedRandom,
    weightedRandomTopN,
    getByKey,
  };

  global.IconicConfig = IconicConfig;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = IconicConfig;
  }

})(typeof window !== 'undefined' ? window : globalThis);
