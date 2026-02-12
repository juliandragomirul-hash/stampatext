/**
 * Admin Templates - Upload SVG, auto-parse text layers, save metadata.
 */
(function () {
  var pendingTemplate = null;

  // ---- Init ----
  document.addEventListener('DOMContentLoaded', function () {
    // Sidebar navigation
    document.querySelectorAll('.admin-nav-item').forEach(function (item) {
      item.addEventListener('click', function (e) {
        e.preventDefault();
        var target = this.getAttribute('href').replace('#', '');
        showSection(target);
      });
    });

    // Upload form
    var uploadForm = document.getElementById('form-upload-template');
    if (uploadForm) {
      uploadForm.addEventListener('submit', handleTemplateUpload);
    }

    // Save button
    var saveBtn = document.getElementById('btn-save-template');
    if (saveBtn) {
      saveBtn.addEventListener('click', handleSaveTemplate);
    }

    // Build admin color palette
    buildAdminColorPalette();

    // Load template list
    loadTemplateList();
  });

  // ---- Section switching ----
  function showSection(name) {
    document.querySelectorAll('.admin-nav-item').forEach(function (el) {
      el.classList.remove('active');
    });
    document.querySelector('.admin-nav-item[href="#' + name + '"]').classList.add('active');

    document.getElementById('section-dashboard').style.display = name === 'dashboard' ? 'block' : 'none';
    document.getElementById('section-templates').style.display = name === 'templates' ? 'block' : 'none';
    var texturesSection = document.getElementById('section-textures');
    if (texturesSection) {
      texturesSection.style.display = name === 'textures' ? 'block' : 'none';
      if (name === 'textures') loadTextureList();
    }
  }

  // ---- Custom color palette ----
  var PALETTE_COLORS = [
    '#000000', '#FF0000', '#8B0000', '#FF1493', '#FF4500',
    '#FF8C00', '#FFD700', '#FFFF00', '#BDB76B', '#9400D3',
    '#4B0082', '#7CFC00', '#32CD32', '#00FF7F', '#008000',
    '#808000', '#556B2F', '#00FFFF', '#00CED1', '#4682B4',
    '#1E90FF', '#4169E1', '#000080', '#8B4513', '#FFFFFF',
    '#C0C0C0', '#A9A9A9'
  ];

  function buildAdminColorPalette() {
    var palette = document.getElementById('admin-color-palette');
    if (!palette) return;
    PALETTE_COLORS.forEach(function (color) {
      var swatch = document.createElement('div');
      swatch.className = 'color-swatch';
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

  function getSelectedColors() {
    var colors = [];
    document.querySelectorAll('#admin-color-palette .color-swatch.selected').forEach(function (el) {
      colors.push(el.dataset.color);
    });
    return colors;
  }

  // ---- Upload & Parse ----
  async function handleTemplateUpload(e) {
    e.preventDefault();
    var fileInput = document.getElementById('tpl-svg');
    var nameInput = document.getElementById('tpl-name');

    var file = fileInput.files[0];
    if (!file) return;

    var name = nameInput.value.trim();
    if (!name) {
      alert('Please enter a template name.');
      return;
    }

    try {
      var svgString = await file.text();
      var cleanedSvg = SvgRenderer.cleanSvgString(svgString);
      var svgDoc = SvgRenderer.parseSvg(svgString);
      var textElements = SvgRenderer.detectTextElements(svgDoc);
      var containers = SvgRenderer.detectContainers(svgDoc);

      // Get dimensions from cleaned SVG string
      var widthMatch = cleanedSvg.match(/width=["']([\d.]+)/);
      var heightMatch = cleanedSvg.match(/height=["']([\d.]+)/);
      var width = widthMatch ? parseFloat(widthMatch[1]) : 0;
      var height = heightMatch ? parseFloat(heightMatch[1]) : 0;

      // If no width/height, try viewBox
      if (!width || !height) {
        var vbMatch = cleanedSvg.match(/viewBox=["']([\d.\s,]+)["']/);
        if (vbMatch) {
          var parts = vbMatch[1].split(/[\s,]+/);
          width = parseFloat(parts[2]) || 0;
          height = parseFloat(parts[3]) || 0;
        }
      }

      // Show preview using img blob URL (preserves embedded fonts)
      var previewDiv = document.getElementById('svg-preview');
      previewDiv.innerHTML = '';
      var previewImg = SvgRenderer.createSvgImage(cleanedSvg);
      previewImg.style.width = '100%';
      previewImg.style.height = 'auto';
      previewImg.style.maxHeight = '300px';
      previewDiv.appendChild(previewImg);

      // Show detected containers info
      var containerCount = Object.keys(containers).length;
      var containerInfo = '';
      if (containerCount > 0) {
        containerInfo = '<div style="margin-bottom:1rem;padding:0.75rem;background:#e0f2fe;border-radius:6px;font-size:0.85rem;">' +
          '<strong>Auto-detected ' + containerCount + ' container(s):</strong> ' +
          Object.keys(containers).map(function(num) {
            var c = containers[num];
            return 'ct-' + num + ' (' + Math.round(c.width) + '×' + Math.round(c.height) + ')';
          }).join(', ') +
          '</div>';
      }

      // Show detected text layers
      var layersDiv = document.getElementById('detected-layers');
      if (textElements.length === 0) {
        layersDiv.innerHTML = containerInfo + '<p style="color:#888;">No text elements found in this SVG.</p>';
      } else {
        layersDiv.innerHTML = containerInfo + textElements.map(function (el, i) {
          // Auto-match with container based on dt-* number
          var matchedContainer = null;
          var autoMaxWidth = Math.round(width * 0.7);  // Default fallback
          var matchInfo = '';

          if (el.dtNumber && containers[el.dtNumber]) {
            matchedContainer = containers[el.dtNumber];
            autoMaxWidth = Math.round(matchedContainer.width);
            matchInfo = '<span style="color:#059669;font-weight:600;"> → matched with ct-' + el.dtNumber + ' (width: ' + autoMaxWidth + ')</span>';
          }

          return '<div class="profile-section" style="padding:1rem; margin-bottom:0.75rem;">' +
            '<div style="margin-bottom:0.5rem;">' +
              '<strong>Text ' + (i + 1) + ':</strong> "' + escapeHtml(el.textContent) + '"' +
              (el.dtNumber ? ' <span style="background:#dbeafe;padding:2px 6px;border-radius:4px;font-size:0.75rem;">dt-' + el.dtNumber + '</span>' : '') +
              matchInfo +
            '</div>' +
            '<div style="font-size:0.8rem; color:#888; margin-bottom:0.75rem;">' +
              'Font: ' + el.fontFamily + ' | Size: ' + el.fontSize + 'px | ' +
              'Color: ' + el.fill + ' | Stroke: ' + el.stroke + ' (' + el.strokeWidth + 'px) | ' +
              'Layer: ' + (el.parentId || 'none') + ' | Transform: ' + el.transform +
            '</div>' +
            '<div class="form-row">' +
              '<div class="form-group">' +
                '<label class="form-label">Label</label>' +
                '<input class="form-input zone-label" value="' + (el.dtNumber ? 'Text ' + el.dtNumber : 'Text ' + (i + 1)) + '" data-index="' + i + '">' +
              '</div>' +
              '<div class="form-group">' +
                '<label class="form-label">Max Width (px)' + (matchedContainer ? ' <span style="color:#059669;">✓ auto</span>' : '') + '</label>' +
                '<input class="form-input zone-maxwidth" type="number" value="' + autoMaxWidth + '" data-index="' + i + '">' +
              '</div>' +
            '</div>' +
            '<label style="font-size:0.85rem; color:#555; cursor:pointer;">' +
              '<input type="checkbox" class="zone-editable" data-index="' + i + '" checked> ' +
              'Editable by users' +
            '</label>' +
          '</div>';
        }).join('');
      }

      // Auto-detect colors from SVG and pre-select matching palette swatches
      var detectedColors = SvgRenderer.detectColors(cleanedSvg);
      document.querySelectorAll('#admin-color-palette .color-swatch').forEach(function (el) {
        el.classList.remove('selected');
      });
      detectedColors.forEach(function (dc) {
        var swatch = document.querySelector('#admin-color-palette .color-swatch[data-color="' + dc.color + '"]');
        if (swatch) swatch.classList.add('selected');
      });
      // Show detected colors info
      if (detectedColors.length > 0) {
        var colorInfo = detectedColors.map(function (dc) {
          return '<span style="display:inline-flex;align-items:center;gap:4px;margin-right:8px;">' +
            '<span style="width:14px;height:14px;border-radius:3px;display:inline-block;background:' + dc.color + ';border:1px solid #ccc;"></span>' +
            '<span style="font-size:0.8rem;">' + dc.color + ' (' + dc.roles.join(', ') + ')</span>' +
          '</span>';
        }).join('');
        var colorInfoDiv = document.createElement('div');
        colorInfoDiv.style.cssText = 'margin-bottom:0.75rem;padding:0.5rem;background:#f0f9ff;border-radius:6px;';
        colorInfoDiv.innerHTML = '<span style="font-size:0.8rem;color:#555;font-weight:600;">Auto-detected: </span>' + colorInfo;
        var paletteEl = document.getElementById('admin-color-palette');
        paletteEl.parentNode.insertBefore(colorInfoDiv, paletteEl);
      }

      // Store for save step
      pendingTemplate = {
        name: name,
        svgString: svgString,
        textElements: textElements,
        width: width,
        height: height
      };

      document.getElementById('parse-results').style.display = 'block';
    } catch (err) {
      console.error('Parse error:', err);
      alert('Failed to parse SVG: ' + err.message);
    }
  }

  // ---- Save Template ----
  async function handleSaveTemplate() {
    if (!pendingTemplate) {
      alert('No template to save. Please upload an SVG first.');
      return;
    }

    var saveBtn = document.getElementById('btn-save-template');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      var shape = document.getElementById('tpl-shape').value;
      var objectType = document.getElementById('tpl-object').value;
      var colors = getSelectedColors();
      var t = pendingTemplate;

      // 1. Upload SVG to Supabase Storage
      var filePath = 'svgs/' + Date.now() + '_' + t.name.replace(/[^a-zA-Z0-9]/g, '_') + '.svg';
      var svgBlob = new Blob([t.svgString], { type: 'image/svg+xml' });

      var uploadResult = await sb.storage.from('templates').upload(filePath, svgBlob);
      if (uploadResult.error) throw new Error('Storage upload failed: ' + uploadResult.error.message);

      // 2. Insert template row
      var insertResult = await sb.from('templates').insert({
        name: t.name,
        svg_path: filePath,
        width: t.width,
        height: t.height,
        shape: shape,
        object_type: objectType,
        colors: colors,
        is_active: true
      }).select().single();

      if (insertResult.error) throw new Error('Template insert failed: ' + insertResult.error.message);
      var template = insertResult.data;

      // 3. Insert text zones
      var zones = [];
      t.textElements.forEach(function (el, i) {
        var labelInput = document.querySelector('.zone-label[data-index="' + i + '"]');
        var maxWidthInput = document.querySelector('.zone-maxwidth[data-index="' + i + '"]');
        var editableInput = document.querySelector('.zone-editable[data-index="' + i + '"]');

        zones.push({
          template_id: template.id,
          label: labelInput ? labelInput.value : 'Text ' + (i + 1),
          svg_element_index: i,
          font_family: el.fontFamily,
          font_size: el.fontSize,
          font_color: el.fill,
          stroke: el.stroke,
          stroke_width: el.strokeWidth,
          transform_matrix: el.transform,
          bounding_width: maxWidthInput ? parseFloat(maxWidthInput.value) : null,
          is_editable: editableInput ? editableInput.checked : true,
          sort_order: i
        });
      });

      if (zones.length > 0) {
        var zonesResult = await sb.from('text_zones').insert(zones);
        if (zonesResult.error) throw new Error('Text zones insert failed: ' + zonesResult.error.message);
      }

      // 4. Reset form
      alert('Template "' + t.name + '" saved successfully!');
      pendingTemplate = null;
      document.getElementById('form-upload-template').reset();
      document.getElementById('parse-results').style.display = 'none';
      document.querySelectorAll('#admin-color-palette .color-swatch.selected').forEach(function (el) {
        el.classList.remove('selected');
      });

      // Refresh list
      loadTemplateList();

    } catch (err) {
      console.error('Save error:', err);
      alert('Save failed: ' + err.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Template';
    }
  }

  // ---- Template List ----
  async function loadTemplateList() {
    var listDiv = document.getElementById('template-list');
    if (!listDiv) return;

    listDiv.innerHTML = '<p style="color:#888;">Loading...</p>';

    try {
      var result = await sb.from('templates')
        .select('id, name, svg_path, shape, object_type, is_active, created_at')
        .order('created_at', { ascending: false });

      if (result.error) throw result.error;
      var templates = result.data || [];

      if (templates.length === 0) {
        listDiv.innerHTML = '<p style="color:#888;">No templates uploaded yet.</p>';
        return;
      }

      listDiv.innerHTML = templates.map(function (tpl) {
        var publicUrl = tpl.svg_path ? sb.storage.from('templates').getPublicUrl(tpl.svg_path).data.publicUrl : '';
        return '<div style="display:flex; align-items:center; justify-content:space-between; padding:0.75rem 0; border-bottom:1px solid #f0f0f0;">' +
          '<div class="tpl-name-hover" style="position:relative;cursor:pointer;" data-svg-url="' + escapeHtml(publicUrl) + '" data-tpl-id="' + tpl.id + '">' +
            '<strong style="color:#4f46e5;text-decoration:underline;">' + escapeHtml(tpl.name) + '</strong> ' +
            '<span style="font-size:0.75rem; color:#888;">(' + (tpl.shape || '?') + ' / ' + (tpl.object_type || '?') + ')</span>' +
          '</div>' +
          '<div style="display:flex; gap:0.5rem; align-items:center;">' +
            '<span style="font-size:0.75rem; color:' + (tpl.is_active ? '#16a34a' : '#dc2626') + ';">' +
              (tpl.is_active ? 'Active' : 'Inactive') +
            '</span>' +
            '<button class="btn btn-secondary btn-small btn-toggle-active" data-id="' + tpl.id + '" data-active="' + tpl.is_active + '">' +
              (tpl.is_active ? 'Deactivate' : 'Activate') +
            '</button>' +
            '<button class="btn btn-small btn-delete-template" data-id="' + tpl.id + '" data-name="' + escapeHtml(tpl.name) + '" data-path="' + escapeHtml(tpl.svg_path || '') + '" style="background:#dc2626;color:#fff;">' +
              'Delete' +
            '</button>' +
          '</div>' +
        '</div>';
      }).join('');

      // Bulk activate/deactivate handlers
      var activateAllBtn = document.getElementById('btn-activate-all');
      var deactivateAllBtn = document.getElementById('btn-deactivate-all');
      if (activateAllBtn) {
        activateAllBtn.onclick = async function () {
          if (!confirm('Activate ALL ' + templates.length + ' templates?')) return;
          this.disabled = true;
          this.textContent = 'Activating...';
          var ids = templates.map(function (t) { return t.id; });
          var res = await sb.from('templates').update({ is_active: true }).in('id', ids);
          if (res.error) alert('Failed: ' + res.error.message);
          loadTemplateList();
        };
      }
      if (deactivateAllBtn) {
        deactivateAllBtn.onclick = async function () {
          if (!confirm('Deactivate ALL ' + templates.length + ' templates?')) return;
          this.disabled = true;
          this.textContent = 'Deactivating...';
          var ids = templates.map(function (t) { return t.id; });
          var res = await sb.from('templates').update({ is_active: false }).in('id', ids);
          if (res.error) alert('Failed: ' + res.error.message);
          loadTemplateList();
        };
      }



      // Toggle active handlers
      listDiv.querySelectorAll('.btn-toggle-active').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var id = this.dataset.id;
          var currentlyActive = this.dataset.active === 'true';
          var updateResult = await sb.from('templates')
            .update({ is_active: !currentlyActive })
            .eq('id', id);
          if (updateResult.error) {
            alert('Failed to update: ' + updateResult.error.message);
          } else {
            loadTemplateList();
          }
        });
      });

      // Click to edit handlers
      listDiv.querySelectorAll('.tpl-name-hover').forEach(function (el) {
        el.addEventListener('click', function (e) {
          var tplId = this.dataset.tplId;
          if (tplId) openTemplateEdit(tplId);
        });
      });

      // Hover preview handlers
      var previewTooltip = null;
      listDiv.querySelectorAll('.tpl-name-hover').forEach(function (el) {
        el.addEventListener('mouseenter', async function (e) {
          var svgUrl = this.dataset.svgUrl;
          if (!svgUrl) return;

          // Create tooltip
          previewTooltip = document.createElement('div');
          previewTooltip.style.cssText = 'position:fixed;z-index:9999;background:#fff;border:1px solid #d4d4d4;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.15);padding:8px;width:300px;pointer-events:none;';
          document.body.appendChild(previewTooltip);

          // Position to the right of the element name
          var rect = this.getBoundingClientRect();
          var tooltipLeft = rect.right + 12;
          var tooltipTop = rect.top - 40;
          // If too far right, show below instead
          if (tooltipLeft + 310 > window.innerWidth) {
            tooltipLeft = rect.left;
            tooltipTop = rect.bottom + 8;
          }
          // Keep within viewport vertically
          if (tooltipTop < 8) tooltipTop = 8;
          previewTooltip.style.left = tooltipLeft + 'px';
          previewTooltip.style.top = tooltipTop + 'px';

          try {
            var svgString = await SvgRenderer.fetchSvg(svgUrl);
            var cleaned = SvgRenderer.cleanSvgString(svgString);

            // Run through autoFit to generate border effects (wavy, stitch, etc.)
            var bwMatch = cleaned.match(/<rect[^>]*width=["']([\d.]+)["']/);
            var bw = bwMatch ? parseFloat(bwMatch[1]) : 1000;
            var fsMatch = cleaned.match(/font-size=["']([\d.]+)["']/);
            var fs = fsMatch ? parseFloat(fsMatch[1]) : 128;
            try {
              cleaned = await SvgRenderer.autoFitTextInString(cleaned, 0, bw, fs, 1);
            } catch (fitErr) { /* fallback to raw SVG */ }

            if (previewTooltip && previewTooltip.parentNode) {
              var img = SvgRenderer.createSvgImage(cleaned);
              img.style.width = '260px';
              img.style.maxHeight = '200px';
              img.style.overflow = 'hidden';
              previewTooltip.appendChild(img);
            }
          } catch (err) {
            if (previewTooltip && previewTooltip.parentNode) {
              previewTooltip.innerHTML = '<span style="color:#888;font-size:0.8rem;">Preview failed</span>';
            }
          }
        });
        el.addEventListener('mouseleave', function () {
          if (previewTooltip && previewTooltip.parentNode) {
            previewTooltip.parentNode.removeChild(previewTooltip);
            previewTooltip = null;
          }
        });
      });

      // Delete handlers
      listDiv.querySelectorAll('.btn-delete-template').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var id = this.dataset.id;
          var name = this.dataset.name;
          var svgPath = this.dataset.path;

          if (!confirm('Delete "' + name + '"? This cannot be undone.')) return;

          try {
            // 1. Delete text zones
            await sb.from('text_zones').delete().eq('template_id', id);

            // 2. Delete template row
            var delResult = await sb.from('templates').delete().eq('id', id);
            if (delResult.error) throw new Error(delResult.error.message);

            // 3. Delete SVG from storage
            if (svgPath) {
              await sb.storage.from('templates').remove([svgPath]);
            }

            loadTemplateList();
          } catch (err) {
            alert('Delete failed: ' + err.message);
            console.error(err);
          }
        });
      });
    } catch (err) {
      listDiv.innerHTML = '<p style="color:#dc2626;">Failed to load templates.</p>';
      console.error(err);
    }
  }

  // ---- Template Edit ----
  var editingTemplateId = null;

  // Back to list button
  document.addEventListener('DOMContentLoaded', function () {
    var backBtn = document.getElementById('btn-back-to-list');
    if (backBtn) {
      backBtn.addEventListener('click', function () {
        document.getElementById('template-edit-section').style.display = 'none';
        document.getElementById('template-list-section').style.display = 'block';
        document.getElementById('parse-results').style.display = 'none';
        editingTemplateId = null;
      });
    }

    var updateBtn = document.getElementById('btn-update-template');
    if (updateBtn) {
      updateBtn.addEventListener('click', handleUpdateTemplate);
    }

    // Build edit color palette
    buildEditColorPalette();
  });

  function buildEditColorPalette() {
    var palette = document.getElementById('edit-color-palette');
    if (!palette) return;
    PALETTE_COLORS.forEach(function (color) {
      var swatch = document.createElement('div');
      swatch.className = 'color-swatch';
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

  async function openTemplateEdit(templateId) {
    editingTemplateId = templateId;

    try {
      // Fetch template + text zones
      var tplResult = await sb.from('templates')
        .select('*')
        .eq('id', templateId)
        .single();
      if (tplResult.error) throw tplResult.error;
      var tpl = tplResult.data;

      var zonesResult = await sb.from('text_zones')
        .select('*')
        .eq('template_id', templateId)
        .order('sort_order', { ascending: true });
      var zones = (zonesResult.data || []);

      // Show edit section, hide list
      document.getElementById('template-list-section').style.display = 'none';
      document.getElementById('parse-results').style.display = 'none';
      document.getElementById('template-edit-section').style.display = 'block';

      // Fill name
      document.getElementById('edit-tpl-name').value = tpl.name;
      document.getElementById('edit-tpl-name-display').textContent = tpl.name;

      // Fill shape & object
      document.getElementById('edit-tpl-shape').value = tpl.shape || 'rectangle';
      document.getElementById('edit-tpl-object').value = tpl.object_type || 'stamp';

      // Fill colors
      document.querySelectorAll('#edit-color-palette .color-swatch').forEach(function (el) {
        el.classList.remove('selected');
        if (tpl.colors && tpl.colors.indexOf(el.dataset.color) !== -1) {
          el.classList.add('selected');
        }
      });

      // Preview
      var previewDiv = document.getElementById('edit-svg-preview');
      previewDiv.innerHTML = '<p style="color:#888;">Loading preview...</p>';
      if (tpl.svg_path) {
        try {
          var publicUrl = sb.storage.from('templates').getPublicUrl(tpl.svg_path).data.publicUrl;
          var svgString = await SvgRenderer.fetchSvg(publicUrl);
          var cleaned = SvgRenderer.cleanSvgString(svgString);

          // Run through autoFit to generate border effects
          var bwMatch = cleaned.match(/<rect[^>]*width=["']([\d.]+)["']/);
          var bw = bwMatch ? parseFloat(bwMatch[1]) : 1000;
          var fsMatch = cleaned.match(/font-size=["']([\d.]+)["']/);
          var fs = fsMatch ? parseFloat(fsMatch[1]) : 128;
          try {
            cleaned = await SvgRenderer.autoFitTextInString(cleaned, 0, bw, fs, 1);
          } catch (fitErr) { /* fallback to raw SVG */ }

          previewDiv.innerHTML = '';
          var imgWrap = document.createElement('div');
          imgWrap.style.cssText = 'max-width:400px;max-height:180px;margin:0 auto;overflow:hidden;';
          var img = SvgRenderer.createSvgImage(cleaned);
          img.style.width = '100%';
          img.style.height = 'auto';
          imgWrap.appendChild(img);
          previewDiv.appendChild(imgWrap);

          // Show auto-detected colors in edit view
          var detectedColors = SvgRenderer.detectColors(cleaned);
          if (detectedColors.length > 0) {
            var colorInfo = detectedColors.map(function (dc) {
              return '<span style="display:inline-flex;align-items:center;gap:4px;margin-right:8px;">' +
                '<span style="width:14px;height:14px;border-radius:3px;display:inline-block;background:' + dc.color + ';border:1px solid #ccc;"></span>' +
                '<span style="font-size:0.8rem;">' + dc.color + ' (' + dc.roles.join(', ') + ')</span>' +
              '</span>';
            }).join('');
            var infoDiv = document.createElement('div');
            infoDiv.style.cssText = 'margin-top:0.75rem;padding:0.5rem;background:#f0f9ff;border-radius:6px;';
            infoDiv.innerHTML = '<span style="font-size:0.8rem;color:#555;font-weight:600;">Auto-detected from SVG: </span>' + colorInfo;
            previewDiv.appendChild(infoDiv);

            // If no colors saved in DB yet, auto-select from detected
            if (!tpl.colors || tpl.colors.length === 0) {
              detectedColors.forEach(function (dc) {
                var swatch = document.querySelector('#edit-color-palette .color-swatch[data-color="' + dc.color + '"]');
                if (swatch) swatch.classList.add('selected');
              });
            }
          }
        } catch (e) {
          previewDiv.innerHTML = '<p style="color:#dc2626;">Preview failed: ' + e.message + '</p>';
        }
      }

      // Text zones
      var layersDiv = document.getElementById('edit-detected-layers');
      if (zones.length === 0) {
        layersDiv.innerHTML = '<p style="color:#888;">No text zones saved for this template.</p>';
      } else {
        layersDiv.innerHTML = zones.map(function (z, i) {
          return '<div class="profile-section" style="padding:1rem; margin-bottom:0.75rem;">' +
            '<div style="font-size:0.8rem; color:#888; margin-bottom:0.75rem;">' +
              'Font: ' + (z.font_family || '?') + ' | Size: ' + (z.font_size || '?') + 'px | ' +
              'Color: ' + (z.font_color || '?') + ' | Stroke: ' + (z.stroke || 'none') + ' (' + (z.stroke_width || 0) + 'px)' +
            '</div>' +
            '<div class="form-row">' +
              '<div class="form-group">' +
                '<label class="form-label">Label</label>' +
                '<input class="form-input edit-zone-label" value="' + escapeHtml(z.label || '') + '" data-zone-id="' + z.id + '">' +
              '</div>' +
              '<div class="form-group">' +
                '<label class="form-label">Max Width (px)</label>' +
                '<input class="form-input edit-zone-maxwidth" type="number" value="' + (z.bounding_width || 0) + '" data-zone-id="' + z.id + '">' +
              '</div>' +
            '</div>' +
            '<label style="font-size:0.85rem; color:#555; cursor:pointer;">' +
              '<input type="checkbox" class="edit-zone-editable" data-zone-id="' + z.id + '"' + (z.is_editable ? ' checked' : '') + '> ' +
              'Editable by users' +
            '</label>' +
          '</div>';
        }).join('');
      }

    } catch (err) {
      alert('Failed to load template: ' + err.message);
      console.error(err);
    }
  }

  async function handleUpdateTemplate() {
    if (!editingTemplateId) return;

    var updateBtn = document.getElementById('btn-update-template');
    updateBtn.disabled = true;
    updateBtn.textContent = 'Updating...';

    try {
      var name = document.getElementById('edit-tpl-name').value.trim();
      var shape = document.getElementById('edit-tpl-shape').value;
      var objectType = document.getElementById('edit-tpl-object').value;
      var colors = [];
      document.querySelectorAll('#edit-color-palette .color-swatch.selected').forEach(function (el) {
        colors.push(el.dataset.color);
      });

      // Update template row
      var updateResult = await sb.from('templates')
        .update({ name: name, shape: shape, object_type: objectType, colors: colors })
        .eq('id', editingTemplateId);
      if (updateResult.error) throw new Error(updateResult.error.message);

      // Update each text zone
      var zoneLabels = document.querySelectorAll('.edit-zone-label');
      for (var i = 0; i < zoneLabels.length; i++) {
        var zoneId = zoneLabels[i].dataset.zoneId;
        var label = zoneLabels[i].value;
        var maxWidthInput = document.querySelector('.edit-zone-maxwidth[data-zone-id="' + zoneId + '"]');
        var editableInput = document.querySelector('.edit-zone-editable[data-zone-id="' + zoneId + '"]');

        var zoneUpdate = {
          label: label,
          bounding_width: maxWidthInput ? parseFloat(maxWidthInput.value) : null,
          is_editable: editableInput ? editableInput.checked : true
        };

        var zResult = await sb.from('text_zones').update(zoneUpdate).eq('id', zoneId);
        if (zResult.error) console.warn('Zone update failed:', zResult.error.message);
      }

      alert('Template updated!');
      document.getElementById('edit-tpl-name-display').textContent = name;

    } catch (err) {
      alert('Update failed: ' + err.message);
      console.error(err);
    } finally {
      updateBtn.disabled = false;
      updateBtn.textContent = 'Update Template';
    }
  }

  // Make functions available globally
  window.loadTemplateList = loadTemplateList;
  window.openTemplateEdit = openTemplateEdit;

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // =============================================
  // TEXTURES MANAGEMENT
  // =============================================

  // Known texture files (since we can't list directory client-side)
  var KNOWN_TEXTURES = [
    { name: 'Grungy Texture 2', file: 'grungy_texture_2.svg' },
    { name: 'Grungy Texture 3 Light', file: 'grungy_texture_3_light.svg' }
  ];

  // Init texture form
  document.addEventListener('DOMContentLoaded', function () {
    var textureForm = document.getElementById('form-upload-texture');
    if (textureForm) {
      textureForm.addEventListener('submit', handleTextureUpload);
    }
  });

  // Load existing textures
  async function loadTextureList() {
    var listDiv = document.getElementById('texture-list');
    if (!listDiv) return;

    listDiv.innerHTML = '<p style="color:#888;">Loading textures...</p>';

    var html = '';
    for (var i = 0; i < KNOWN_TEXTURES.length; i++) {
      var tex = KNOWN_TEXTURES[i];
      var url = '/textures/' + tex.file;

      // Check if texture exists by trying to fetch it
      try {
        var response = await fetch(url, { method: 'HEAD' });
        if (!response.ok) continue;

        html += '<div class="texture-card" style="display:inline-block; width:200px; margin:0.5rem; vertical-align:top; border:1px solid #e5e5e5; border-radius:8px; overflow:hidden; background:#fff;">' +
          '<div style="background:#333; padding:1rem; height:150px; display:flex; align-items:center; justify-content:center;">' +
            '<img src="' + url + '" style="max-width:100%; max-height:100%; filter:invert(1);" alt="' + escapeHtml(tex.name) + '">' +
          '</div>' +
          '<div style="padding:0.75rem;">' +
            '<div style="font-weight:600; font-size:0.9rem; margin-bottom:0.25rem;">' + escapeHtml(tex.name) + '</div>' +
            '<div style="font-size:0.75rem; color:#888;">' + tex.file + '</div>' +
          '</div>' +
        '</div>';
      } catch (e) {
        console.warn('Texture not found:', url);
      }
    }

    if (!html) {
      listDiv.innerHTML = '<p style="color:#888;">No textures found in /textures/ folder.</p>';
    } else {
      listDiv.innerHTML = html;
    }
  }

  // Handle texture upload (preview only - actual save requires server)
  async function handleTextureUpload(e) {
    e.preventDefault();

    var fileInput = document.getElementById('texture-svg');
    var nameInput = document.getElementById('texture-name');

    var file = fileInput.files[0];
    if (!file) return;

    var name = nameInput.value.trim();
    if (!name) {
      alert('Please enter a texture name.');
      return;
    }

    try {
      var svgString = await file.text();

      // Show preview
      var previewSection = document.getElementById('texture-preview-section');
      var previewDiv = document.getElementById('texture-preview');

      previewSection.style.display = 'block';
      previewDiv.innerHTML = '';

      var img = document.createElement('img');
      var blob = new Blob([svgString], { type: 'image/svg+xml' });
      img.src = URL.createObjectURL(blob);
      img.style.width = '100%';
      img.style.filter = 'invert(1)'; // Show white texture on dark background
      previewDiv.appendChild(img);

      // Generate filename
      var filename = name.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '.svg';

      // Instructions for manual save
      var infoDiv = document.createElement('div');
      infoDiv.style.cssText = 'margin-top:1rem; padding:1rem; background:#fef3c7; border-radius:6px; font-size:0.85rem;';
      infoDiv.innerHTML = '<strong>To add this texture:</strong><br>' +
        '1. Save the SVG file as: <code style="background:#fff;padding:2px 6px;border-radius:3px;">/public/textures/' + filename + '</code><br>' +
        '2. Add to KNOWN_TEXTURES in admin-templates.js<br>' +
        '3. Refresh this page';
      previewDiv.appendChild(infoDiv);

      // Download button
      var downloadBtn = document.createElement('button');
      downloadBtn.className = 'btn btn-primary';
      downloadBtn.style.marginTop = '1rem';
      downloadBtn.textContent = 'Download SVG';
      downloadBtn.addEventListener('click', function () {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
      });
      previewDiv.appendChild(downloadBtn);

    } catch (err) {
      console.error('Texture preview error:', err);
      alert('Failed to preview texture: ' + err.message);
    }
  }

  window.loadTextureList = loadTextureList;
})();
