'use strict';
/**
 * 自定义下拉组件（替代原生 <select>）
 * - 菜单用 position:fixed 挂在 body 顶层（z-index 9999），不会被容器裁剪或遮挡
 * - 自动翻转：下方空间不足时向上展开
 * - 支持搜索过滤、分组标题、选中勾选态
 * - 点击外部 / Esc 关闭
 */

(function () {
  let openMenu = null;

  function closeOpenMenu() {
    if (!openMenu) return;
    if (typeof openMenu._cleanup === 'function') {
      try { openMenu._cleanup(); } catch (e) { /* ignore */ }
    }
    openMenu.remove();
    openMenu = null;
  }

  /**
   * 创建并弹出菜单
   * @param {HTMLElement} trigger 触发元素（用于定位）
   * @param {Array} groups [{label, items:[{value,label,sub}]}] 或 [{value,label,sub}]
   * @param {object} opts {selected, onSelect, searchable, width}
   */
  function openSelect(trigger, groups, opts = {}) {
    closeOpenMenu();
    const flatItems = [];
    const menu = document.createElement('div');
    menu.className = 'oc-menu' + (opts.menuClass ? ' ' + opts.menuClass : '');

    // 宽度：脱离触发器容器，但始终留在视口内；fitWidth 时按内容自适应（渲染后实测收窄）
    const tw = trigger.getBoundingClientRect().width;
    const maxViewport = Math.max(220, window.innerWidth - 16);
    menu.style.width = opts.fitWidth ? 'max-content' : Math.min(Math.max(opts.width || tw, 220), maxViewport) + 'px';

    // 搜索框
    let search = null;
    if (opts.searchable) {
      search = document.createElement('input');
      search.className = 'oc-menu-search';
      search.placeholder = opts.searchPlaceholder || '搜索…';
      search.type = 'search';
      search.autocomplete = 'off';
      search.spellcheck = false;
      menu.appendChild(search);
      search.addEventListener('input', () => render(search.value.trim().toLowerCase()));
      search.addEventListener('click', (e) => e.stopPropagation());
    }

    // 筛选标签（如按供应商筛选模型）
    let activeChip = '';
    const chipKey = opts.chipKey || 'providerId';
    const chipSearchText = () => (search ? search.value.trim().toLowerCase() : '');
    if (opts.chips && opts.chips.length) {
      const bar = document.createElement('div');
      bar.className = 'oc-menu-chips';
      const syncChips = () => {
        if (chipAllBtn) chipAllBtn.classList.toggle('active', activeChip === '');
        bar.querySelectorAll('.oc-menu-chip[data-chip]').forEach((b) => {
          b.classList.toggle('active', b.dataset.chip === activeChip);
        });
      };
      const chipAllBtn = document.createElement('button');
      chipAllBtn.type = 'button';
      chipAllBtn.className = 'oc-menu-chip active';
      chipAllBtn.textContent = opts.chipsAllLabel || '全部';
      chipAllBtn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
      chipAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        activeChip = '';
        syncChips();
        render(chipSearchText());
      });
      bar.appendChild(chipAllBtn);
      opts.chips.forEach((chip) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'oc-menu-chip';
        b.dataset.chip = String(chip.value);
        b.innerHTML = (chip.icon && window.OC.logoImg ? OC.logoImg(chip.icon, 'chip-logo') : '')
          + '<span class="chip-label">' + escapeHtml(chip.label) + '</span>';
        b.title = chip.label;
        b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          activeChip = activeChip === String(chip.value) ? '' : String(chip.value);
          syncChips();
          render(chipSearchText());
        });
        bar.appendChild(b);
      });
      menu.appendChild(bar);
    }

    const list = document.createElement('div');
    list.className = 'oc-menu-list';
    menu.appendChild(list);

    const hasGroup = Array.isArray(groups) && groups.length > 0 && groups[0] && groups[0].label !== undefined && Array.isArray(groups[0].items);

    function render(filter = '') {
      list.innerHTML = '';
      const source = hasGroup ? groups : [{ label: '', items: groups }];
      let shown = 0;
      source.forEach((g) => {
        const items = (g.items || []).filter((it) => {
          if (activeChip && String(it[chipKey] || '') !== String(activeChip)) return false;
          return !filter || (it.label || '').toLowerCase().includes(filter) || (it.search || '').toLowerCase().includes(filter);
        });
        if (!items.length) return;
        if (g.label) {
          const title = document.createElement('div');
          title.className = 'oc-menu-title';
          title.textContent = g.label;
          list.appendChild(title);
        }
        items.forEach((it) => {
          const row = document.createElement('div');
          row.className = 'oc-menu-item' + (it.value === opts.selected ? ' active' : '');
          row.dataset.value = String(it.value);
          const healthName = it.health === 'ok' ? 'healthOk' : (it.health === 'bad' ? 'healthBad' : (it.health === 'idle' ? 'healthIdle' : ''));
          row.innerHTML = (it.icon && window.OC.logoImg ? OC.logoImg(it.icon, 'item-logo') : '')
            + '<span class="item-label">' + escapeHtml(it.label) + '</span>'
            + (it.sub ? '<span class="item-sub">' + escapeHtml(it.sub) + '</span>' : '')
            + '<span class="check">' + window.OC.icon('check', 14) + '</span>'
            + (healthName ? '<span class="oc-menu-health ' + it.health + '" title="' + escapeHtml(it.healthTitle || '') + '">' + window.OC.icon(healthName, 12) + '</span>' : '')
            + (opts.onPin ? '<button type="button" class="oc-menu-pin' + (it.value === opts.pinned ? ' active' : '') + '" data-pin="' + escapeHtml(String(it.value)) + '" title="' + (it.value === opts.pinned ? '取消置顶' : '置顶，新建对话使用此模型') + '">' + window.OC.icon('pinMark', 15) + '</button>' : '');
          const pinBtn = row.querySelector('.oc-menu-pin');
          if (pinBtn) pinBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (opts.onPin) opts.onPin(it.value, it);
          });
          row.addEventListener('mousedown', (e) => {
            if (e.target.closest('.oc-menu-pin')) return;
            e.preventDefault(); // 防止输入框失焦导致菜单先关
            e.stopPropagation();
            closeOpenMenu();
            if (opts.onSelect) opts.onSelect(it.value, it);
          });
          row.addEventListener('click', (e) => {
            e.stopPropagation();
          });
          list.appendChild(row);
          shown++;
        });
      });
      if (!shown) {
        const empty = document.createElement('div');
        empty.className = 'oc-menu-item';
        empty.style.cursor = 'default';
        empty.style.color = 'var(--text-tertiary)';
        empty.textContent = '无匹配项';
        list.appendChild(empty);
      }
    }

    render();
    document.body.appendChild(menu);

    // fitWidth：以最宽一行的自然宽度为准，超出视口才收窄
    if (opts.fitWidth) {
      menu.style.width = Math.max(220, Math.min(menu.offsetWidth, maxViewport)) + 'px';
    }

    // 定位：默认向下，空间不足向上翻转
    const tr = trigger.getBoundingClientRect();
    const mh = Math.min(menu.offsetHeight, 320);
    const gap = 6;
    let top;
    if (tr.bottom + mh + gap > window.innerHeight && tr.top - mh - gap > 0) {
      top = tr.top - mh - gap;
    } else {
      top = tr.bottom + gap;
    }
    let left = tr.left;
    if (left + menu.offsetWidth > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - menu.offsetWidth - 8);
    }
    menu.style.top = Math.max(8, Math.round(top)) + 'px';
    menu.style.left = Math.round(left) + 'px';

    openMenu = menu;

    // 搜索自动聚焦
    const sq = menu.querySelector('.oc-menu-search');
    if (sq) setTimeout(() => sq.focus(), 30);

    // 关闭处理
    const onDoc = (e) => {
      if (!menu.contains(e.target) && e.target !== trigger) closeOpenMenu();
    };
    const onKey = (e) => { if (e.key === 'Escape') { closeOpenMenu(); } };
    const onScroll = (e) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (menu.contains(e.target) || path.indexOf(menu) >= 0) return;
      closeOpenMenu();
    };
    const onResize = () => closeOpenMenu();
    const stopInside = (e) => e.stopPropagation();
    menu.addEventListener('wheel', stopInside, { passive: true, capture: true });
    menu.addEventListener('touchmove', stopInside, { passive: true, capture: true });

    menu._cleanup = () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };

    setTimeout(() => {
      // 冒泡阶段监听：菜单项的 mousedown/click 通过 stopPropagation 阻止关闭
      document.addEventListener('mousedown', onDoc);
      document.addEventListener('keydown', onKey);
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onResize);
    }, 0);

    return menu;
  }

  function modelTableHtml(rowsHtml) {
    return '<table class="model-table">'
      + '<thead><tr>'
      + '<th class="col-check"></th>'
      + '<th class="col-id">模型 ID</th>'
      + '<th class="col-name">显示名称</th>'
      + '</tr></thead><tbody>'
      + rowsHtml
      + '</tbody></table>';
  }

  function modelNameCell(m, editable) {
    if (editable) {
      return '<input class="mname" type="text" data-mid="' + escapeHtml(m.id) + '" value="'
        + escapeHtml(m.name || m.id) + '" placeholder="前台显示名称" autocomplete="off" spellcheck="false">';
    }
    return '<span class="mname-static">' + escapeHtml(m.name || m.id)
      + (m.enabled ? '<em>已启用</em>' : '') + '</span>';
  }

  function modelRowHtml(m, opts) {
    opts = opts || {};
    const checked = opts.checked ? ' checked' : '';
    const attr = opts.stale ? 'data-stale' : 'data-mid';
    const cls = 'model-row' + (opts.stale ? ' is-stale' : '');
    return '<tr class="' + cls + '">'
      + '<td class="col-check"><input type="checkbox" ' + attr + '="' + escapeHtml(m.id) + '"' + checked + '></td>'
      + '<td class="col-id"><span class="mid">' + escapeHtml(m.id) + '</span></td>'
      + '<td class="col-name">' + modelNameCell(m, !opts.stale) + '</td>'
      + '</tr>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /**
   * 供应商模型清单:拉取全量后手动勾选启用。
   * cfg: { listId, queryId, allId, countId, addId }
   */
  function bindModelChecklist(cfg) {
    const listEl = document.getElementById(cfg.listId);
    if (!listEl) return null;
    const qEl = cfg.queryId ? document.getElementById(cfg.queryId) : null;
    const allEl = cfg.allId ? document.getElementById(cfg.allId) : null;
    const countEl = cfg.countId ? document.getElementById(cfg.countId) : null;
    const addBtn = cfg.addId ? document.getElementById(cfg.addId) : null;

    let catalog = [];
    const selected = new Set();

    function upsertCatalog(models, opts) {
      const selectNew = !!(opts && opts.selectNew);
      const updateName = !!(opts && opts.updateName);
      const syncEnabled = !!(opts && opts.syncEnabled);
      (models || []).forEach((m) => {
        const id = String((m && (m.id || m.name)) || '').trim();
        if (!id) return;
        const incoming = String((m && m.name) || '').trim();
        const found = catalog.find((x) => x.id === id);
        if (found) {
          if (updateName && incoming) found.name = incoming;
          else if (incoming && (!found.name || found.name === found.id)) found.name = incoming;
        } else {
          catalog.push({ id, name: incoming || id });
          if (selectNew) selected.add(id);
        }
        if (syncEnabled) {
          if (m && m.enabled) selected.add(id);
          else selected.delete(id);
        }
      });
      catalog.sort((a, b) => a.id.localeCompare(b.id));
    }

    function addToCatalog(models, selectNew) {
      upsertCatalog(models, { selectNew: !!selectNew });
    }

    function query() {
      return qEl ? qEl.value.trim().toLowerCase() : '';
    }

    function visible() {
      const q = query();
      if (!q) return catalog.slice();
      return catalog.filter((m) =>
        m.id.toLowerCase().includes(q) || String(m.name || '').toLowerCase().includes(q)
      );
    }

    function updateMeta() {
      if (countEl) {
        countEl.textContent = catalog.length
          ? ('已启用 ' + selected.size + ' / ' + catalog.length)
          : '未获取模型';
      }
      if (allEl) {
        const vis = visible();
        const n = vis.filter((m) => selected.has(m.id)).length;
        allEl.checked = vis.length > 0 && n === vis.length;
        allEl.indeterminate = n > 0 && n < vis.length;
      }
    }

    function render() {
      if (!catalog.length) {
        listEl.innerHTML = '<div class="model-check-empty">点击「获取列表」从上游拉取，或在上方输入模型 ID 后添加</div>';
        updateMeta();
        return;
      }
      const vis = visible();
      if (!vis.length) {
        listEl.innerHTML = '<div class="model-check-empty">没有匹配的模型</div>';
        updateMeta();
        return;
      }
      listEl.innerHTML = modelTableHtml(vis.map((m) =>
        modelRowHtml(m, { checked: selected.has(m.id) })
      ).join(''));
      updateMeta();
    }

    listEl.addEventListener('change', (e) => {
      const inp = e.target && e.target.closest ? e.target.closest('input[type="checkbox"][data-mid]') : null;
      if (!inp) return;
      if (inp.checked) selected.add(inp.dataset.mid);
      else selected.delete(inp.dataset.mid);
      updateMeta();
    });

    listEl.addEventListener('input', (e) => {
      const nameInp = e.target && e.target.closest ? e.target.closest('input.mname') : null;
      if (!nameInp) return;
      const item = catalog.find((x) => x.id === nameInp.dataset.mid);
      if (item) item.name = nameInp.value.trim() || item.id;
    });

    listEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target && e.target.classList && e.target.classList.contains('mname')) {
        e.preventDefault();
        e.target.blur();
      }
    });

    if (allEl) {
      allEl.addEventListener('change', () => {
        visible().forEach((m) => {
          if (allEl.checked) selected.add(m.id);
          else selected.delete(m.id);
        });
        render();
      });
    }

    function addManual() {
      const id = qEl ? qEl.value.trim() : '';
      if (!id) return false;
      addToCatalog([{ id, name: id }], true);
      if (qEl) qEl.value = '';
      render();
      return true;
    }

    if (qEl) {
      qEl.addEventListener('input', render);
      qEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addManual();
        }
      });
    }
    if (addBtn) addBtn.addEventListener('click', addManual);

    render();

    return {
      setFromFetch(models) {
        addToCatalog(models, false);
        render();
      },
      applyFetched(models, staleIds) {
        upsertCatalog(models, { updateName: true, syncEnabled: true });
        const drop = new Set((staleIds || []).map((id) => String(id || '').trim()).filter(Boolean));
        if (drop.size) {
          catalog = catalog.filter((m) => !drop.has(m.id));
          drop.forEach((id) => selected.delete(id));
        }
        render();
      },
      setEnabled(models) {
        catalog = [];
        selected.clear();
        addToCatalog(models, true);
        render();
      },
      getCatalog() {
        return catalog.map((m) => ({
          id: m.id,
          name: m.name || m.id,
          enabled: selected.has(m.id),
        }));
      },
      getEnabled() {
        return catalog
          .filter((m) => selected.has(m.id))
          .map((m) => ({ id: m.id, name: m.name || m.id }));
      },
      setEnabledIds(ids) {
        const keep = new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean));
        selected.clear();
        catalog.forEach((m) => {
          if (keep.has(m.id)) selected.add(m.id);
        });
        render();
      },
      reset() {
        catalog = [];
        selected.clear();
        if (qEl) qEl.value = '';
        if (allEl) {
          allEl.checked = false;
          allEl.indeterminate = false;
        }
        render();
      },
    };
  }

  /**
   * 获取模型后的弹窗：勾选启用，并修改前台显示名称。
   * opts: { existing:[{id,name,enabled}], onApply(items), title }
   */
  function openFetchedModelsModal(models, opts) {
    opts = opts || {};
    const existingMap = new Map();
    (opts.existing || []).forEach((m) => {
      const id = String((m && m.id) || '').trim();
      if (id) existingMap.set(id, m);
    });
    const items = [];
    (models || []).forEach((m) => {
      const id = String((m && (m.id || m.name)) || '').trim();
      if (!id || items.some((x) => x.id === id)) return;
      const prev = existingMap.get(id);
      const upstream = String((m && m.name) || '').trim();
      items.push({
        id,
        name: (prev && prev.name) || upstream || id,
        enabled: !!(prev && prev.enabled),
      });
    });
    items.sort((a, b) => a.id.localeCompare(b.id));
    const liveIds = new Set(items.map((m) => m.id));
    const stale = [];
    existingMap.forEach((prev, id) => {
      if (liveIds.has(id)) return;
      stale.push({
        id,
        name: String((prev && prev.name) || '').trim() || id,
        enabled: !!(prev && prev.enabled),
        remove: true,
      });
    });
    stale.sort((a, b) => a.id.localeCompare(b.id));
    if (!items.length && !stale.length) return null;

    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML =
      '<div class="modal modal-lg model-fetch-modal" role="dialog" aria-modal="true">'
      + '<div class="modal-header"><h3>' + escapeHtml(opts.title || '获取到的模型') + '</h3>'
      + '<button class="icon-btn" type="button" data-act="close" aria-label="关闭">'
      + (window.OC && window.OC.icon ? window.OC.icon('close', 16) : '×')
      + '</button></div>'
      + '<div class="modal-body">'
      + '<p class="confirm-message">共获取 ' + items.length + ' 个模型。勾选要启用的，并修改前台显示名称。</p>'
      + '<div class="model-fetch-toolbar">'
      + '<label class="model-fetch-search">'
      + (window.OC && window.OC.icon ? window.OC.icon('search', 14) : '')
      + '<input type="search" data-role="q" placeholder="搜索模型 ID 或显示名称" autocomplete="off" spellcheck="false">'
      + '</label>'
      + '<label class="model-check-all"><input type="checkbox" data-act="all"> 全选当前列表</label>'
      + '<span class="muted small" data-role="count"></span>'
      + '</div>'
      + '<div class="model-fetch-list" data-role="list"></div>'
      + (stale.length
        ? '<div class="model-stale-block">'
          + '<div class="model-stale-head">'
          + '<div class="model-stale-title">已失效模型 <span class="muted small">' + stale.length + '</span></div>'
          + '<label class="model-check-all"><input type="checkbox" data-act="stale-all" checked> 全选清除</label>'
          + '</div>'
          + '<p class="model-stale-hint">这些模型这次没有出现在上游列表里，勾选后会从本地目录移除。</p>'
          + '<div class="model-fetch-list model-stale-list" data-role="stale"></div>'
          + '</div>'
        : '')
      + '</div>'
      + '<div class="modal-footer">'
      + '<button class="btn" type="button" data-act="cancel">取消</button>'
      + '<button class="btn primary" type="button" data-act="ok">应用到列表</button>'
      + '</div></div>';
    document.body.appendChild(mask);

    const qEl = mask.querySelector('[data-role="q"]');
    const listEl = mask.querySelector('[data-role="list"]');
    const staleEl = mask.querySelector('[data-role="stale"]');
    const countEl = mask.querySelector('[data-role="count"]');
    const allEl = mask.querySelector('[data-act="all"]');
    const staleAllEl = mask.querySelector('[data-act="stale-all"]');
    let filter = '';

    function visible() {
      const q = filter;
      if (!q) return items.slice();
      return items.filter((m) =>
        m.id.toLowerCase().includes(q) || String(m.name || '').toLowerCase().includes(q)
      );
    }

    function render() {
      const vis = visible();
      const n = vis.filter((m) => m.enabled).length;
      if (countEl) countEl.textContent = '已选 ' + items.filter((m) => m.enabled).length + ' / ' + items.length;
      if (allEl) {
        allEl.checked = vis.length > 0 && n === vis.length;
        allEl.indeterminate = n > 0 && n < vis.length;
      }
      if (!vis.length) {
        listEl.innerHTML = '<div class="model-check-empty">' + (items.length ? '没有匹配的模型' : '这次上游没有返回模型') + '</div>';
      } else {
        listEl.innerHTML = modelTableHtml(vis.map((m) =>
          modelRowHtml(m, { checked: m.enabled })
        ).join(''));
      }
      renderStale();
    }

    function renderStale() {
      if (!staleEl) return;
      const n = stale.filter((m) => m.remove).length;
      if (staleAllEl) {
        staleAllEl.checked = stale.length > 0 && n === stale.length;
        staleAllEl.indeterminate = n > 0 && n < stale.length;
      }
      staleEl.innerHTML = modelTableHtml(stale.map((m) =>
        modelRowHtml(m, { checked: m.remove, stale: true })
      ).join(''));
    }

    function itemById(id) {
      return items.find((x) => x.id === id);
    }

    function updateMetaOnly() {
      const vis = visible();
      const n = vis.filter((m) => m.enabled).length;
      if (countEl) countEl.textContent = '已选 ' + items.filter((m) => m.enabled).length + ' / ' + items.length;
      if (allEl) {
        allEl.checked = vis.length > 0 && n === vis.length;
        allEl.indeterminate = n > 0 && n < vis.length;
      }
    }

    listEl.addEventListener('change', (e) => {
      const inp = e.target && e.target.closest ? e.target.closest('input[type="checkbox"][data-mid]') : null;
      if (!inp) return;
      const item = itemById(inp.dataset.mid);
      if (item) item.enabled = !!inp.checked;
      updateMetaOnly();
    });
    if (staleEl) {
      staleEl.addEventListener('change', (e) => {
        const inp = e.target && e.target.closest ? e.target.closest('input[type="checkbox"][data-stale]') : null;
        if (!inp) return;
        const item = stale.find((x) => x.id === inp.dataset.stale);
        if (item) item.remove = !!inp.checked;
        renderStale();
      });
    }
    listEl.addEventListener('input', (e) => {
      const nameInp = e.target && e.target.closest ? e.target.closest('input.mname') : null;
      if (!nameInp) return;
      const item = itemById(nameInp.dataset.mid);
      if (item) item.name = nameInp.value;
    });
    listEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target && e.target.classList && e.target.classList.contains('mname')) {
        e.preventDefault();
        e.target.blur();
      }
    });
    if (qEl) {
      qEl.addEventListener('input', () => {
        filter = qEl.value.trim().toLowerCase();
        render();
      });
    }
    if (allEl) {
      allEl.addEventListener('change', () => {
        visible().forEach((m) => { m.enabled = !!allEl.checked; });
        render();
      });
    }
    if (staleAllEl) {
      staleAllEl.addEventListener('change', () => {
        stale.forEach((m) => { m.remove = !!staleAllEl.checked; });
        renderStale();
      });
    }

    const close = (apply) => {
      if (apply && typeof opts.onApply === 'function') {
        opts.onApply(
          items.map((m) => ({
            id: m.id,
            name: String(m.name || '').trim() || m.id,
            enabled: !!m.enabled,
          })),
          stale.filter((m) => m.remove).map((m) => m.id)
        );
      }
      if (window.OCUI && window.OCUI.closeModal) window.OCUI.closeModal(mask);
      else mask.remove();
      setTimeout(() => { if (mask.parentNode) mask.remove(); }, 360);
    };

    mask.addEventListener('click', (e) => {
      if (e.target === mask || e.target.closest('[data-act="close"]') || e.target.closest('[data-act="cancel"]')) {
        close(false);
        return;
      }
      if (e.target.closest('[data-act="ok"]')) close(true);
    });

    render();
    if (window.OCUI && window.OCUI.openModal) window.OCUI.openModal(mask);
    else mask.classList.add('show');
    if (qEl) setTimeout(() => qEl.focus(), 80);
    return mask;
  }

  function bindAppTips() {
    if (document.documentElement.dataset.ocTipsBound === '1') return;
    document.documentElement.dataset.ocTipsBound = '1';
    let tip = null;
    let hideTimer = 0;
    const TIP_DELAY = 420;

    function ensureTip() {
      if (tip) return tip;
      tip = document.createElement('div');
      tip.className = 'oc-tip';
      tip.setAttribute('role', 'tooltip');
      document.body.appendChild(tip);
      return tip;
    }

    function hideTip() {
      clearTimeout(hideTimer);
      hideTimer = 0;
      if (tip) tip.classList.remove('show');
    }

    function showTip(el) {
      const text = (el.getAttribute('data-tip') || el.getAttribute('aria-label') || '').trim();
      if (!text) return;
      const box = ensureTip();
      box.textContent = text;
      box.classList.add('show');
      const r = el.getBoundingClientRect();
      const tw = box.offsetWidth;
      const th = box.offsetHeight;
      let left = r.left + (r.width - tw) / 2;
      let top = r.top - th - 8;
      if (top < 8) top = r.bottom + 8;
      left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
      box.style.left = Math.round(left) + 'px';
      box.style.top = Math.round(top) + 'px';
    }

    function tipTarget(el) {
      if (!el || !el.closest) return null;
      return el.closest('[data-tip]');
    }

    function onEnter(e) {
      const el = tipTarget(e.target);
      if (!el) return;
      if (el.hasAttribute('title')) el.removeAttribute('title');
      hideTip();
      hideTimer = window.setTimeout(() => showTip(el), TIP_DELAY);
    }
    function onLeave(e) {
      const from = tipTarget(e.target);
      const to = tipTarget(e.relatedTarget);
      if (from && from !== to) hideTip();
    }

    document.addEventListener('pointerover', onEnter);
    document.addEventListener('mouseover', onEnter);
    document.addEventListener('pointerout', onLeave);
    document.addEventListener('mouseout', onLeave);
    document.addEventListener('pointerdown', hideTip, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
    window.addEventListener('scroll', hideTip, true);
    window.addEventListener('resize', hideTip);
  }

  function restyleNativeTitles(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('[title]').forEach((el) => {
      const text = (el.getAttribute('title') || '').trim();
      if (!text) { el.removeAttribute('title'); return; }
      if (!el.getAttribute('data-tip')) el.setAttribute('data-tip', text);
      el.removeAttribute('title');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      restyleNativeTitles(document);
      bindAppTips();
    });
  } else {
    restyleNativeTitles(document);
    bindAppTips();
  }

  const titleObserver = new MutationObserver((recs) => {
    recs.forEach((rec) => {
      rec.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        if (n.hasAttribute && n.hasAttribute('title')) restyleNativeTitles(n);
        else if (n.querySelectorAll) restyleNativeTitles(n);
      });
    });
  });
  titleObserver.observe(document.documentElement, { childList: true, subtree: true });

  // 暴露全局
  window.OC = window.OC || {};
  window.OC.openSelect = openSelect;
  window.OC.closeSelect = closeOpenMenu;
  window.OC.bindModelChecklist = bindModelChecklist;
  window.OC.openFetchedModelsModal = openFetchedModelsModal;
  window.OC.restyleNativeTitles = restyleNativeTitles;
})();
