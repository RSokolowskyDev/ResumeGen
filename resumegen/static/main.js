// ── Last generated tailored data (for live section reorder) ──
let lastTailored = null;
let lastJdRole    = '';
let lastJdCompany = '';

// ── Persist textarea content ──
const TEXTAREA_KEYS = {
  'master-resume-input': 'resumegen_master_resume',
  'job-desc-input':      'resumegen_job_desc',
};

function persistTextareas() {
  Object.entries(TEXTAREA_KEYS).forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => {
        localStorage.setItem(key, el.value);
      });
    }
  });
}

function restoreTextareas() {
  Object.entries(TEXTAREA_KEYS).forEach(([id, key]) => {
    const el  = document.getElementById(id);
    const val = localStorage.getItem(key);
    if (el && val) el.value = val;
  });
}

// ── Storage keys ──
const STORAGE = {
  gemini:     'resumegen_gemini_api_key',
  groq:       'resumegen_groq_api_key',
  cerebras:   'resumegen_cerebras_api_key',
  openrouter: 'resumegen_openrouter_api_key',
  claude:     'resumegen_claude_api_key',
};

const PROVIDERS = ['gemini', 'groq', 'cerebras', 'openrouter', 'claude'];

// ── Progress steps config ──
const STEPS = [
  { step: 'parsing_resume',    label: 'Parsing resume' },
  { step: 'parsing_jd',        label: 'Analyzing job description' },
  { step: 'matching',          label: 'Selecting skills' },
  { step: 'tailoring_summary', label: 'Writing summary' },
  { step: 'tailoring_job',     label: 'Tailoring experience' },
  { step: 'scoring',           label: 'Scoring ATS' },
  { step: 'rendering',         label: 'Assembling resume' },
];

// ── Modal management ──
let modalHealthInterval = null;

function showModal() {
  document.getElementById('settings-overlay').classList.remove('hidden');
  loadKeysIntoModal();
  startModalHealthPolling();
}

function hideModal() {
  document.getElementById('settings-overlay').classList.add('hidden');
  stopModalHealthPolling();
}

function loadKeysIntoModal() {
  PROVIDERS.forEach(provider => {
    const input = document.getElementById(`key-${provider}`);
    if (input) {
      input.value = localStorage.getItem(STORAGE[provider]) || '';
    }
  });
}

function saveKeysFromModal() {
  PROVIDERS.forEach(provider => {
    const input = document.getElementById(`key-${provider}`);
    if (input) {
      const val = input.value.trim();
      if (val) {
        localStorage.setItem(STORAGE[provider], val);
      } else {
        localStorage.removeItem(STORAGE[provider]);
      }
    }
  });
}

function checkAnyKeySet() {
  return PROVIDERS.some(p => localStorage.getItem(STORAGE[p]));
}

// ── Modal health polling ──
async function fetchProviderHealth() {
  try {
    const keys = buildKeysPayload();
    const res = await fetch('/provider-health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(keys)
    });
    const data = await res.json();
    updateModalProviderStatus(data.providers);
  } catch (e) {
    console.warn('Provider health fetch failed:', e);
  }
}

function updateModalProviderStatus(providers) {
  let nextProvider = 'Python fallback';

  PROVIDERS.forEach(name => {
    const statusEl = document.getElementById(`status-${name}`);
    if (!statusEl) return;
    const dot = statusEl.querySelector('.provider-dot');
    const label = statusEl.querySelector('.provider-label');
    const info = providers[name];
    if (!info) return;

    if (!info.has_key) {
      dot.className = 'provider-dot grey';
      label.textContent = 'No key';
    } else if (info.in_cooldown) {
      dot.className = 'provider-dot amber';
      label.textContent = `Cooling down · ${info.cooldown_remaining}s`;
    } else {
      dot.className = 'provider-dot green';
      label.textContent = 'Ready';
    }

    if (info.is_next && info.has_key && !info.in_cooldown) {
      nextProvider = name.charAt(0).toUpperCase() + name.slice(1);
    }
  });

  // Python status
  const pyInfo = providers['python'];
  if (pyInfo && pyInfo.is_next) {
    nextProvider = 'Python fallback';
  }

  document.getElementById('next-provider-name').textContent = nextProvider;

  // No keys warning
  const warning = document.getElementById('no-keys-warning');
  if (warning) {
    warning.style.display = checkAnyKeySet() ? 'none' : 'block';
  }
}

function startModalHealthPolling() {
  fetchProviderHealth();
  modalHealthInterval = setInterval(fetchProviderHealth, 2000);
}

function stopModalHealthPolling() {
  if (modalHealthInterval) {
    clearInterval(modalHealthInterval);
    modalHealthInterval = null;
  }
}

// ── Show/hide key toggle ──
function wireKeyToggles() {
  document.querySelectorAll('.key-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const input = document.getElementById(targetId);
      if (!input) return;
      if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = 'Hide';
      } else {
        input.type = 'password';
        btn.textContent = 'Show';
      }
    });
  });
}

// ── Model health polling ──
async function pollModelHealth() {
  try {
    const res = await fetch('/health');
    const data = await res.json();
    updateModelStatus(data.model_status);
    if (!data.model_ready) {
      setTimeout(pollModelHealth, 2000);
    }
  } catch (e) {
    updateModelStatus('error');
    setTimeout(pollModelHealth, 5000);
  }
}

function updateModelStatus(status) {
  const dot  = document.getElementById('model-dot');
  const text = document.getElementById('model-status-text');
  const btn  = document.getElementById('generate-btn');

  const states = {
    ready:   { cls: 'ready',   txt: 'Ready · Qwen3 1.7B',        enabled: true  },
    loading: { cls: 'loading', txt: 'Loading model...',           enabled: false },
    error:   { cls: 'error',   txt: 'Model error — restart app.py', enabled: false },
  };

  const s = states[status] || states.loading;
  dot.className = 'status-dot ' + s.cls;
  text.textContent = s.txt;
  btn.disabled = !s.enabled;
}

// ── Terminal ──
function termLog(message, level = 'info') {
  const body = document.getElementById('terminal-body');
  if (!body) return;

  const now = new Date();
  const time = now.toTimeString().slice(0, 8);

  const line = document.createElement('div');
  line.className = `terminal-line ${level}`;
  line.innerHTML =
    `<span class="terminal-time">${time}</span>` +
    `<span class="terminal-msg">${message}</span>`;

  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

document.getElementById('terminal-clear')
  .addEventListener('click', () => {
    document.getElementById('terminal-body').innerHTML = '';
  });

// ── Progress ──
function updateProgress(message, pct, step) {
  const fill = document.getElementById('gen-progress-fill');
  if (fill) fill.style.width = Math.min(pct, 100) + '%';

  const steps = document.querySelectorAll('.progress-step');
  let found = false;
  steps.forEach(el => {
    if (el.dataset.step === step) {
      el.className = 'progress-step active';
      found = true;
    } else if (!found) {
      el.className = 'progress-step done';
    } else {
      el.className = 'progress-step';
    }
  });

  // Update tailoring mini progress bar
  if (step === 'tailoring_job') {
    const m = message.match(/(\d+)\s+of\s+(\d+)/i);
    if (m) {
      const cur = parseInt(m[1]);
      const tot = parseInt(m[2]);
      const barPct = Math.round((cur / tot) * 100);
      const bar  = document.getElementById('tailor-job-bar');
      const text = document.getElementById('tailor-job-text');
      const jobFill = document.getElementById('tailor-job-fill');
      if (bar)     bar.style.display = 'inline-flex';
      if (text)    text.textContent  = `${cur}/${tot}`;
      if (jobFill) jobFill.style.width = barPct + '%';
    }
  }
}

function resetProgress() {
  document.querySelectorAll('.progress-step').forEach(el => {
    el.className = 'progress-step';
  });
  const fill = document.getElementById('gen-progress-fill');
  if (fill) fill.style.width = '0%';

  // Reset tailoring mini bar
  const bar     = document.getElementById('tailor-job-bar');
  const text    = document.getElementById('tailor-job-text');
  const jobFill = document.getElementById('tailor-job-fill');
  if (bar)     bar.style.display  = 'none';
  if (text)    text.textContent   = '';
  if (jobFill) jobFill.style.width = '0%';
}

// ── Build keys payload from localStorage ──
function buildKeysPayload() {
  return {
    gemini_key:     localStorage.getItem(STORAGE.gemini)     || '',
    groq_key:       localStorage.getItem(STORAGE.groq)       || '',
    cerebras_key:   localStorage.getItem(STORAGE.cerebras)   || '',
    openrouter_key: localStorage.getItem(STORAGE.openrouter) || '',
    claude_key:     localStorage.getItem(STORAGE.claude)     || '',
  };
}

// ── Section order drag and drop — VERTICAL ──
let dragSrc = null;

function initDragDrop() {
  const list = document.getElementById('section-order-list');

  function refreshListeners() {
    list.querySelectorAll('.section-chip').forEach(chip => {
      chip.removeEventListener('dragstart', onDragStart);
      chip.removeEventListener('dragend',   onDragEnd);
      chip.removeEventListener('dragover',  onDragOver);
      chip.removeEventListener('drop',      onDrop);
      chip.addEventListener('dragstart', onDragStart);
      chip.addEventListener('dragend',   onDragEnd);
      chip.addEventListener('dragover',  onDragOver);
      chip.addEventListener('drop',      onDrop);
    });
  }

  function onDragStart(e) {
    dragSrc = this;
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  }

  function onDragEnd() {
    this.classList.remove('dragging');
    list.querySelectorAll('.section-chip').forEach(c => c.classList.remove('drag-over'));
  }

  function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (this !== dragSrc) {
      list.querySelectorAll('.section-chip').forEach(c => c.classList.remove('drag-over'));
      this.classList.add('drag-over');
    }
  }

  function onDrop(e) {
    e.preventDefault();
    if (dragSrc && this !== dragSrc) {
      const chips = [...list.querySelectorAll('.section-chip')];
      const si = chips.indexOf(dragSrc);
      const ti = chips.indexOf(this);
      if (si < ti) {
        this.after(dragSrc);
      } else {
        this.before(dragSrc);
      }
      rerenderResume();
    }
    this.classList.remove('drag-over');
    refreshListeners();
  }

  refreshListeners();
}

function getSectionOrder() {
  return [...document.querySelectorAll('.section-chip')].map(c => c.dataset.section);
}

// ── File upload ──
function wireUploads() {
  const pairs = [
    ['file-master', 'master-resume-input'],
    ['file-job',    'job-desc-input'],
  ];

  pairs.forEach(([inputId, textareaId]) => {
    document.getElementById(inputId).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('file', file);
      try {
        termLog(`Uploading ${file.name}...`, 'info');
        const res = await fetch('/upload', { method: 'POST', body: formData });
        const data = await res.json();
        document.getElementById(textareaId).value = data.text;
        termLog(`Uploaded ${file.name} successfully`, 'success');
      } catch (err) {
        termLog(`Upload failed: ${err.message}`, 'error');
      }
      e.target.value = '';
    });
  });
}

// ── Generate ──
document.getElementById('generate-btn').addEventListener('click', generate);

async function generate() {
  const master = document.getElementById('master-resume-input').value.trim();
  const jd     = document.getElementById('job-desc-input').value.trim();

  if (!master) {
    termLog('Please paste your master resume.', 'warn');
    return;
  }
  if (!jd) {
    termLog('Please paste a job description.', 'warn');
    return;
  }

  setGenerating(true);
  resetProgress();
  termLog('Starting resume generation...', 'info');

  const payload = {
    master_resume:   master,
    job_description: jd,
    section_order:   getSectionOrder(),
    ...buildKeysPayload()
  };

  try {
    const response = await fetch('/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          handleEvent(event);
        } catch (e) { continue; }
      }
    }
  } catch (err) {
    termLog(`Connection failed: ${err.message}`, 'error');
    setGenerating(false);
  }
}

function handleEvent(event) {
  if (event.type === 'progress') {
    updateProgress(event.message, event.pct, event.step);
  } else if (event.type === 'log') {
    termLog(event.message, event.level || 'info');
  } else if (event.type === 'complete') {
    lastTailored  = event.tailored ?? null;
    lastJdRole    = event.jd_role    ?? '';
    lastJdCompany = event.jd_company ?? '';
    renderResume(event.html);
    renderATS(event.ats);
    updateProgress('Done', 100, 'rendering');
    termLog(
      `Done — ${event.selected_jobs} jobs, ${event.selected_skills} skills`,
      'success'
    );
    setGenerating(false);
    enableOutputButtons();
  } else if (event.type === 'error') {
    termLog(event.message, 'error');
    setGenerating(false);
  }
}

// ── Resume rendering ──
function renderResume(html) {
  document.getElementById('resume-output').innerHTML = html;
}

async function rerenderResume() {
  if (!lastTailored) return;
  try {
    const res = await fetch('/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tailored: lastTailored,
        section_order: getSectionOrder()
      })
    });
    const data = await res.json();
    renderResume(data.html);
  } catch (e) {
    console.warn('Re-render failed:', e);
  }
}

// ── ATS panel ──
function renderATS(ats) {
  if (!ats) return;

  document.getElementById('ats-score-num').textContent = Math.round(ats.score) + '%';

  const fill = document.getElementById('ats-bar-fill');
  if (fill) fill.style.width = ats.score + '%';

  const label = document.getElementById('ats-bar-label');
  if (label) label.textContent = `${ats.matched_keywords} of ${ats.total_keywords} keywords matched`;

  const counts = document.getElementById('ats-counts');
  if (counts) counts.textContent = `${ats.matched_required.length} required · ${ats.matched_preferred.length} preferred`;

  renderMissingKeywords('ats-missing-required',  'ats-missing-required-list',  ats.missing_required);
  renderMissingKeywords('ats-missing-preferred', 'ats-missing-preferred-list', ats.missing_preferred);
}

function renderMissingKeywords(panelId, listId, keywords) {
  const panel = document.getElementById(panelId);
  const list  = document.getElementById(listId);
  if (!panel || !list) return;
  if (!keywords || keywords.length === 0) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  list.innerHTML = keywords.map(k => `<span class="ats-keyword">${k}</span>`).join('');
}

// ── PDF export ──
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function getPDFFilename() {
  const nameEl = document.querySelector('#resume-output .r-name');
  const parts  = [];

  if (nameEl && nameEl.textContent.trim())
    parts.push(slugify(nameEl.textContent.trim()));

  if (lastJdRole)    parts.push(slugify(lastJdRole));
  if (lastJdCompany) parts.push(slugify(lastJdCompany));

  if (parts.length === 0) return 'resume.pdf';
  return parts.join('_') + '.pdf';
}

document.getElementById('pdf-btn').addEventListener('click', async () => {
  const output   = document.getElementById('resume-output');
  const filename = getPDFFilename();
  const btn      = document.getElementById('pdf-btn');
  const original = btn.textContent;
  const fitBox   = document.getElementById('fit-to-page-cb');
  const fitToPage= fitBox ? fitBox.checked : false;

  btn.textContent = 'Generating PDF...';
  btn.disabled    = true;
  termLog(`Exporting PDF: ${filename}...`, 'info');

  let originalFontSize = '';
  if (fitToPage) {
    originalFontSize = output.style.fontSize;
    let currentPt = 10.5;
    // A standard A4 page at 96 DPI is ~1122 pixels. Using 1118 as a safety margin.
    while (output.scrollHeight > 1118 && currentPt > 6.0) {
      currentPt -= 0.1;
      output.style.fontSize = currentPt + 'pt';
    }
    if (currentPt < 10.5) {
      termLog(`Scaled text to ${currentPt.toFixed(1)}pt to fit one page`, 'info');
    }
  }

  const opt = {
    margin:      [0, 0, 0, 0],
    filename:    filename,
    image:       { type: 'jpeg', quality: 0.98 },
    html2canvas: {
      scale: 1.95,
      useCORS: true,
      letterRendering: true,
      logging: false
    },
    jsPDF: {
      unit: 'mm',
      format: 'a4',
      orientation: 'portrait',
      compress: true
    },
    pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
  };

  try {
    await html2pdf().set(opt).from(output).save();
    termLog(`PDF exported: ${filename}`, 'success');
  } catch (err) {
    termLog(`PDF export failed: ${err.message}`, 'error');
  } finally {
    if (fitToPage) {
      output.style.fontSize = originalFontSize;
    }
    btn.textContent = original;
    btn.disabled    = false;
  }
});

// ── Reset ──
document.getElementById('reset-btn').addEventListener('click', () => {
  lastTailored = null;
  document.getElementById('resume-output').innerHTML = `
    <div class="resume-placeholder">
      <div class="placeholder-icon">📄</div>
      <p>Your tailored resume will appear here</p>
      <small>Paste your resume and job description, then click Generate</small>
    </div>`;
  resetProgress();
  document.getElementById('ats-score-num').textContent = '—';
  const fill = document.getElementById('ats-bar-fill');
  if (fill) fill.style.width = '0%';
  const label = document.getElementById('ats-bar-label');
  if (label) label.textContent = 'Keyword match';
  const counts = document.getElementById('ats-counts');
  if (counts) counts.textContent = '';
  document.getElementById('ats-missing-required').style.display  = 'none';
  document.getElementById('ats-missing-preferred').style.display = 'none';
  document.getElementById('pdf-btn').disabled   = true;
  document.getElementById('reset-btn').disabled = true;
  termLog('Reset.', 'info');
});

// ── UI state helpers ──
function setGenerating(on) {
  const btn = document.getElementById('generate-btn');
  btn.disabled    = on;
  btn.textContent = on ? 'Generating...' : 'Generate Tailored Resume';
}

function enableOutputButtons() {
  document.getElementById('pdf-btn').disabled   = false;
  document.getElementById('reset-btn').disabled = false;
}

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {

  restoreTextareas();
  persistTextareas();

  // Wire modal open/close
  document.getElementById('settings-btn').addEventListener('click', showModal);
  document.getElementById('modal-close').addEventListener('click', hideModal);
  document.getElementById('modal-save').addEventListener('click', () => {
    saveKeysFromModal();
    hideModal();
    termLog('API keys saved.', 'success');
  });

  // Close modal on overlay click
  document.getElementById('settings-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'settings-overlay') {
      saveKeysFromModal();
      hideModal();
    }
  });

  // Wire key show/hide toggles
  wireKeyToggles();

  // Wire file uploads
  wireUploads();

  // Init drag and drop
  initDragDrop();

  // Start model health polling
  pollModelHealth();

  // Log startup
  termLog('ResumeGen started.', 'info');
  termLog('Waiting for model to load...', 'info');

  // Show modal on first visit if no keys set (after 800ms so page renders first)
  setTimeout(() => {
    if (!checkAnyKeySet()) {
      showModal();
    }
  }, 800);

});
