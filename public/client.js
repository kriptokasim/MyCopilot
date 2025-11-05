// Client-side app with streaming, per-hunk preview/apply, and history/undo
let editor = null;
let currentPath = null;
let currentContent = '';
let currentView = 'editor'; // 'editor'|'preview'|'sheet'
let streamEventSource = null;

async function apiList(rel = '.') {
  const res = await fetch('/api/list?path=' + encodeURIComponent(rel));
  return res.json();
}
async function apiRead(path) {
  const res = await fetch('/api/read?path=' + encodeURIComponent(path));
  return res.json();
}
async function apiSave(path, content) {
  const res = await fetch('/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content })
  });
  return res.json();
}
async function apiCreate(path, isDirectory = false) {
  const res = await fetch('/api/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, isDirectory })
  });
  return res.json();
}
async function apiDelete(path) {
  const res = await fetch('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path })
  });
  return res.json();
}
async function apiAssistantPreview(message, provider = 'openai', model) {
  const res = await fetch('/assistant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, provider, model })
  });
  return res.json();
}
async function apiAssistantApply(actions, commitMessage) {
  const res = await fetch('/assistant/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actions, commitMessage })
  });
  return res.json();
}
async function apiStreamAssistant(message, provider = 'openai', model) {
  // returns an EventSource URL; we build query params
  const params = new URLSearchParams({ message, provider });
  if (model) params.set('model', model);
  const url = `/assistant/stream?${params.toString()}`;
  return url;
}

async function apiGitLog(limit = 50) {
  const res = await fetch('/git/log?limit=' + encodeURIComponent(limit));
  return res.json();
}
async function apiGitRevert(hash) {
  const res = await fetch('/git/revert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash })
  });
  return res.json();
}

// UI helpers
function addMessage(who, text, renderMarkdown = false) {
  const messages = document.getElementById('messages');
  const el = document.createElement('div');
  el.className = 'message ' + (who === 'user' ? 'user' : (who === 'assistant' ? 'assistant' : 'system'));
  if (renderMarkdown) {
    const html = marked.parse(text);
    el.innerHTML = html;
    attachCopyButtonsToContainer(el);
    el.querySelectorAll('pre code').forEach((block) => {
      hljs.highlightElement(block);
    });
  } else {
    el.textContent = text;
  }
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
  return el;
}

function attachCopyButtonsToContainer(container) {
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.title = 'Copy code';
    btn.addEventListener('click', async (e) => {
      try {
        const code = pre.querySelector('code');
        const text = code ? code.innerText : pre.innerText;
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = 'Copy'), 1500);
      } catch (err) {
        btn.textContent = 'Fail';
        setTimeout(() => (btn.textContent = 'Copy'), 1500);
      }
    });
    pre.style.position = 'relative';
    pre.appendChild(btn);
  });
}

// build file tree UI
async function refreshTree() {
  const root = await apiList('.');
  const list = document.getElementById('fileList');
  list.innerHTML = '';
  for (const it of root.items) {
    const el = document.createElement('div');
    el.className = 'file-item';
    el.textContent = (it.isDirectory ? '📁 ' : '📄 ') + it.name;
    el.onclick = () => onSelectFile(it.path, it.isDirectory);
    list.appendChild(el);
  }
}

function isMarkdown(path) {
  return /\.mdx?$/.test(path);
}
function isCSV(path) {
  return /\.csv$/.test(path);
}

// load file into appropriate view
async function onSelectFile(rel, isDir) {
  if (isDir) {
    const dir = await apiList(rel);
    const list = document.getElementById('fileList');
    list.innerHTML = '';
    const parent = document.createElement('div');
    parent.className = 'file-item';
    parent.textContent = '↩️ .. (up)';
    parent.onclick = () => refreshTree();
    list.appendChild(parent);
    for (const it of dir.items) {
      const el = document.createElement('div');
      el.className = 'file-item';
      el.textContent = (it.isDirectory ? '📁 ' : '📄 ') + it.name;
      el.onclick = () => onSelectFile(it.path, it.isDirectory);
      list.appendChild(el);
    }
    return;
  }
  const data = await apiRead(rel);
  if (!data || data.error) {
    alert('Failed to open: ' + (data?.error || 'unknown'));
    return;
  }
  currentPath = rel;
  currentContent = data.content;
  document.getElementById('currentPath').textContent = rel;

  if (isMarkdown(rel)) {
    showView('preview');
    renderMarkdownPreview(data.content);
  } else if (isCSV(rel)) {
    showView('sheet');
    renderSheet(data.content);
  } else {
    showView('editor');
    editor.setValue(data.content);
  }
}

function showView(view) {
  currentView = view;
  document.getElementById('editor').style.display = view === 'editor' ? '' : 'none';
  document.getElementById('preview').style.display = view === 'preview' ? '' : 'none';
  document.getElementById('sheet').style.display = view === 'sheet' ? '' : 'none';
  document.getElementById('viewEditorBtn').classList.toggle('active', view === 'editor');
  document.getElementById('viewPreviewBtn').classList.toggle('active', view === 'preview');
  document.getElementById('viewSheetBtn').classList.toggle('active', view === 'sheet');
}

// Save file (editor or sheet)
document.getElementById('saveBtn').addEventListener('click', async () => {
  if (!currentPath) {
    alert('No file opened. Create a file first or open one from the tree.');
    return;
  }
  let content;
  if (currentView === 'editor') {
    content = editor.getValue();
  } else if (currentView === 'preview') {
    content = currentContent;
  } else if (currentView === 'sheet') {
    content = serializeSheetToCSV();
  }
  const r = await apiSave(currentPath, content);
  if (r.ok) {
    addMessage('system', `Saved ${currentPath}`);
    currentContent = content;
    refreshTree();
  } else {
    alert('Save failed: ' + (r.error || 'unknown'));
  }
});

// Create file
document.getElementById('newBtn').addEventListener('click', async () => {
  const path = prompt('New file path (e.g. src/newfile.js):');
  if (!path) return;
  const r = await apiCreate(path, false);
  if (r.ok) {
    addMessage('system', `Created ${path}`);
    refreshTree();
  } else {
    alert('Create failed: ' + (r.error || 'unknown'));
  }
});

// Delete file
document.getElementById('delBtn').addEventListener('click', async () => {
  const path = prompt('File path to delete (e.g. src/foo.js):');
  if (!path) return;
  if (!confirm(`Delete ${path}? This is permanent.`)) return;
  const r = await apiDelete(path);
  if (r.ok) {
    addMessage('system', `Deleted ${path}`);
    if (currentPath === path) {
      editor.setValue('');
      currentPath = null;
      document.getElementById('currentPath').textContent = '';
    }
    refreshTree();
  } else {
    alert('Delete failed: ' + (r.error || 'unknown'));
  }
});

// Chat send -> preview flow + streaming
document.getElementById('sendBtn').addEventListener('click', async () => {
  const ta = document.getElementById('chatInput');
  const message = ta.value.trim();
  if (!message) return;
  addMessage('user', message);
  ta.value = '';
  const provider = document.getElementById('providerSelect').value;
  const streamEnabled = document.getElementById('streamToggle').checked;

  // Start streaming assistant_text if enabled
  let assistantEl = null;
  if (streamEnabled) {
    const streamUrl = await apiStreamAssistant(message, provider);
    assistantEl = addMessage('assistant', '', false);
    startStream(streamUrl, assistantEl);
  } else {
    addMessage('system', 'Streaming disabled for this request.');
  }

  addMessage('system', 'Sending to model for preview...');
  try {
    const resp = await apiAssistantPreview(message, provider);
    // remove the 'Sending' system message
    const sysMessages = Array.from(document.querySelectorAll('.message')).filter(n => n.textContent === 'Sending to model...');
    sysMessages.forEach(n => n.remove());
    if (resp.error) {
      addMessage('assistant', 'Error: ' + resp.error);
      return;
    }
    // If streaming was disabled, show assistant_text now
    if (!streamEnabled) {
      const renderMD = /```/.test(resp.assistant_text || resp.raw_model_text || '');
      addMessage('assistant', resp.assistant_text || resp.raw_model_text || 'No response', renderMD);
    } else {
      // When streaming, replace assistantEl content with assistant_text at end (if available)
      if (assistantEl && resp.assistant_text) {
        // append a system message with the final assistant_text if it's not already included
      }
    }

    if (resp.actions && resp.actions.length) {
      // show preview modal with diffs and per-hunk checkboxes
      showPreviewModal(resp);
    } else {
      refreshTree();
    }
  } catch (err) {
    addMessage('assistant', 'Request failed: ' + err.message);
  }
});

function startStream(url, elementToUpdate) {
  if (streamEventSource) {
    try { streamEventSource.close(); } catch {}
    streamEventSource = null;
  }
  const es = new EventSource(url);
  streamEventSource = es;
  let accumulated = '';
  es.onmessage = (ev) => {
    const data = ev.data.replace(/\\n/g, '\n');
    accumulated += data;
    elementToUpdate.textContent = accumulated;
  };
  es.addEventListener('error', (e) => {
    elementToUpdate.textContent += '\n\n[stream error]';
    try { es.close(); } catch {}
  });
  es.addEventListener('done', () => {
    try { es.close(); } catch {}
  });
}

// ---------- Preview modal with per-hunk selection ----------
function showPreviewModal(resp) {
  const modal = document.getElementById('previewModal');
  const list = document.getElementById('previewList');
  list.innerHTML = '';
  resp.diffs.forEach((d, idx) => {
    const item = document.createElement('div');
    item.className = 'preview-item';
    const header = document.createElement('header');
    const title = document.createElement('div');
    title.innerHTML = `<strong>${d.action.action}</strong> <span style="opacity:0.8"> ${d.action.path}</span>`;
    const controls = document.createElement('div');
    controls.className = 'controls';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.id = `preview_chk_${idx}`;
    const label = document.createElement('label');
    label.htmlFor = checkbox.id;
    label.textContent = 'Apply';
    controls.appendChild(checkbox);
    controls.appendChild(label);
    header.appendChild(title);
    header.appendChild(controls);
    item.appendChild(header);

    if (!d.ok) {
      const err = document.createElement('div');
      err.textContent = 'Error building diff: ' + (d.error || 'unknown');
      item.appendChild(err);
      list.appendChild(item);
      return;
    }

    // For each hunk, create a small panel with a checkbox
    if (Array.isArray(d.hunks) && d.hunks.length) {
      d.hunks.forEach((h, hidx) => {
        const hEl = document.createElement('div');
        hEl.className = 'hunk';
        const hHeader = document.createElement('div');
        hHeader.style.display = 'flex';
        hHeader.style.justifyContent = 'space-between';
        hHeader.style.alignItems = 'center';
        hHeader.innerHTML = `<span style="font-family: ui-monospace, monospace">${h.header}</span>`;
        const hControls = document.createElement('div');
        const hchk = document.createElement('input');
        hchk.type = 'checkbox';
        hchk.checked = true;
        hchk.id = `hunk_chk_${idx}_${hidx}`;
        const hLabel = document.createElement('label');
        hLabel.htmlFor = hchk.id;
        hLabel.textContent = 'Apply hunk';
        hControls.appendChild(hchk);
        hControls.appendChild(hLabel);
        hHeader.appendChild(hControls);
        hEl.appendChild(hHeader);
        const pre = document.createElement('pre');
        pre.textContent = h.hunkText;
        hEl.appendChild(pre);
        item.appendChild(hEl);
      });
    } else {
      const diffWrap = document.createElement('div');
      diffWrap.className = 'diff';
      diffWrap.textContent = d.diff;
      item.appendChild(diffWrap);
    }

    // store original diff on the DOM for later (used by apply)
    item.dataset.originalDiff = d.diff;
    list.appendChild(item);
  });

  document.getElementById('applyBtn').onclick = async () => {
    const selectedActions = [];
    resp.diffs.forEach((d, idx) => {
      const chk = document.getElementById(`preview_chk_${idx}`);
      if (!chk || !chk.checked) return;
      const actionCopy = JSON.parse(JSON.stringify(d.action));
      // collect selected hunks for this action
      const selectedHunks = [];
      if (Array.isArray(d.hunks) && d.hunks.length) {
        d.hunks.forEach((h, hidx) => {
          const hchk = document.getElementById(`hunk_chk_${idx}_${hidx}`);
          if (hchk && hchk.checked) selectedHunks.push(h.hunkText);
        });
      }
      if (selectedHunks.length) {
        actionCopy.selectedHunks = selectedHunks;
        actionCopy.originalDiff = d.diff;
      }
      selectedActions.push(actionCopy);
    });

    if (!selectedActions.length) {
      if (!confirm('No actions selected. Close preview?')) return;
      hidePreviewModal();
      return;
    }
    const commitMessage = document.getElementById('commitMsg').value || 'Assistant applied changes';
    const applyResp = await apiAssistantApply(selectedActions, commitMessage);
    if (applyResp.error) {
      addMessage('assistant', 'Apply failed: ' + applyResp.error);
    } else {
      addMessage('assistant', 'Applied actions. Git result: ' + JSON.stringify(applyResp.gitResult));
      const changed = Object.keys(applyResp.changedFiles || {});
      if (changed.length) {
        await onSelectFile(changed[0], false);
      }
      refreshTree();
    }
    hidePreviewModal();
  };

  document.getElementById('cancelPreviewBtn').onclick = () => {
    hidePreviewModal();
  };

  modal.style.display = '';
}

function hidePreviewModal() {
  const modal = document.getElementById('previewModal');
  modal.style.display = 'none';
  document.getElementById('previewList').innerHTML = '';
  document.getElementById('commitMsg').value = '';
}

// Attach copy buttons on preview or assistant outputs globally after render
function renderMarkdownPreview(md) {
  const preview = document.getElementById('preview');
  const html = marked.parse(md);
  preview.innerHTML = html;
  attachCopyButtonsToContainer(preview);
  preview.querySelectorAll('pre code').forEach((block) => {
    hljs.highlightElement(block);
  });
}

// ---------- Sheet view (CSV) ----------
function parseCSV(text) {
  const rows = [];
  let cur = [];
  let curCell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const nxt = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && nxt === '"') {
        curCell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        curCell += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        cur.push(curCell);
        curCell = '';
      } else if (ch === '\n') {
        cur.push(curCell);
        rows.push(cur);
        cur = [];
        curCell = '';
      } else if (ch === '\r') {
      } else {
        curCell += ch;
      }
    }
  }
  if (curCell !== '' || cur.length > 0) {
    cur.push(curCell);
    rows.push(cur);
  }
  return rows;
}
function renderSheet(text) {
  const rows = parseCSV(text);
  const wrap = document.getElementById('sheetTableWrap');
  wrap.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'sheet-table';
  for (let r = 0; r < rows.length; r++) {
    const tr = document.createElement('tr');
    const cols = rows[r];
    for (let c = 0; c < cols.length; c++) {
      const td = document.createElement(r === 0 ? 'th' : 'td');
      td.contentEditable = r === 0 ? false : true;
      td.innerText = cols[c] ?? '';
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  wrap.appendChild(table);
}
function serializeSheetToCSV() {
  const wrap = document.getElementById('sheetTableWrap');
  const table = wrap.querySelector('table');
  if (!table) return '';
  const lines = [];
  for (const tr of Array.from(table.rows)) {
    const vals = [];
    for (const td of Array.from(tr.cells)) {
      let v = td.innerText.replace(/\r?\n/g, ' ');
      if (v.includes(',') || v.includes('"') || v.includes('\n')) v = `"${v.replace(/"/g, '""')}"`;
      vals.push(v);
    }
    lines.push(vals.join(','));
  }
  return lines.join('\n');
}
document.getElementById('sheetSaveBtn').addEventListener('click', async () => {
  if (!currentPath) return alert('Open a sheet file first.');
  const csv = serializeSheetToCSV();
  const r = await apiSave(currentPath, csv);
  if (r.ok) {
    addMessage('system', `Saved sheet ${currentPath}`);
    currentContent = csv;
    refreshTree();
  } else {
    alert('Save failed: ' + (r.error || 'unknown'));
  }
});
document.getElementById('sheetReparseBtn').addEventListener('click', () => {
  if (!currentContent) return;
  renderSheet(currentContent);
});

// View toggle buttons
document.getElementById('viewEditorBtn').addEventListener('click', () => showView('editor'));
document.getElementById('viewPreviewBtn').addEventListener('click', () => showView('preview'));
document.getElementById('viewSheetBtn').addEventListener('click', () => showView('sheet'));

// History modal
document.getElementById('historyBtn').addEventListener('click', async () => {
  const modal = document.getElementById('historyModal');
  const list = document.getElementById('historyList');
  list.innerHTML = '';
  const r = await apiGitLog(100);
  if (!r.ok) {
    list.textContent = 'Failed to load history: ' + (r.error || 'unknown');
  } else {
    r.logs.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'preview-item';
      const header = document.createElement('div');
      header.style.display = 'flex';
      header.style.justifyContent = 'space-between';
      header.innerHTML = `<div><strong>${entry.subject}</strong><div style="opacity:0.8;font-size:12px">${entry.hash} — ${entry.author} — ${entry.date}</div></div>`;
      const controls = document.createElement('div');
      const revertBtn = document.createElement('button');
      revertBtn.className = 'btn small';
      revertBtn.textContent = 'Revert';
      revertBtn.onclick = async () => {
        if (!confirm(`Revert this commit?\n${entry.subject}\n${entry.hash}`)) return;
        const rr = await apiGitRevert(entry.hash);
        if (rr.ok) {
          addMessage('system', `Reverted ${entry.hash}`);
          refreshTree();
        } else {
          addMessage('system', `Revert failed: ${rr.error}`);
        }
      };
      controls.appendChild(revertBtn);
      header.appendChild(controls);
      item.appendChild(header);
      list.appendChild(item);
    });
  }
  modal.style.display = '';
});
document.getElementById('closeHistoryBtn').addEventListener('click', () => {
  document.getElementById('historyModal').style.display = 'none';
});

// Init Monaco editor
require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.38.0/min/vs' }});
require(['vs/editor/editor.main'], function () {
  editor = monaco.editor.create(document.getElementById('editor'), {
    value: '',
    language: 'javascript',
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: false }
  });
  refreshTree();
});