// ── MODEL CONFIG ──────────────────────────────────────────────────────────────
// WebLLM model — runs via WebGPU, no ONNX, OpenAI-compatible API
// See full list: https://github.com/mlc-ai/web-llm/blob/main/src/config.ts
const WEBLLM_MODEL = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';
const WEBLLM_CDN   = 'https://esm.run/@mlc-ai/web-llm';

// ── MODEL STATE ───────────────────────────────────────────────────────────────
let engine = null;   // WebLLM MLCEngine instance

// ── DOM REFS ──────────────────────────────────────────────────────────────────
const dom = {
    modelDot:            document.getElementById('model-dot'),
    modelStatusText:     document.getElementById('model-status-text'),
    modelProgressBar:    document.getElementById('model-progress-bar'),
    modelProgressFill:   document.getElementById('model-progress-fill'),
    modelLoading:        document.getElementById('model-loading'),
    mlLabel:             document.getElementById('ml-label'),
    mlBarFill:           document.getElementById('ml-bar-fill'),
    mlPct:               document.getElementById('ml-pct'),
    mlFile:              document.getElementById('ml-file'),
    masterInput:         document.getElementById('master-resume-input'),
    jobDescInput:        document.getElementById('job-desc-input'),
    generateBtn:         document.getElementById('generate-btn'),
    resetBtn:            document.getElementById('reset-btn'),
    pdfBtn:              document.getElementById('pdf-btn'),
    statusMessages:      document.getElementById('status-messages'),
    genProgressBar:      document.getElementById('gen-progress-bar'),
    genProgressFill:     document.getElementById('gen-progress-fill'),
    atsPanel:            document.getElementById('ats-panel'),
    atsScoreNum:         document.getElementById('ats-score-num'),
    atsBarFill:          document.getElementById('ats-bar-fill'),
    atsBarLabel:         document.getElementById('ats-bar-label'),
    atsCounts:           document.getElementById('ats-counts'),
    atsMissingRequired:  document.getElementById('ats-missing-required'),
    atsMissingRequiredList: document.getElementById('ats-missing-required-list'),
    atsMissingPreferred: document.getElementById('ats-missing-preferred'),
    atsMissingPreferredList: document.getElementById('ats-missing-preferred-list'),
    atsSections:         document.getElementById('ats-sections'),
    resumeOutput:        document.getElementById('resume-output'),
    fileMaster:          document.getElementById('file-master'),
    fileJob:             document.getElementById('file-job'),
    printTarget:         document.getElementById('print-target'),
    resumeTpl:           document.getElementById('resume-tpl'),
    webgpuNotice:        document.getElementById('webgpu-notice'),
};

let isGenerating = false;

// ── MODEL LOADING ─────────────────────────────────────────────────────────────

async function checkWebGPU() {
    if (!navigator.gpu) return false;
    try { return !!(await navigator.gpu.requestAdapter()); }
    catch { return false; }
}

// Slow heartbeat tick: when no real progress events fire, inch the bar
// forward so users see activity instead of a frozen bar.
let _heartbeatTimer = null;
let _currentPct = 0;

function startHeartbeat() {
    stopHeartbeat();
    _heartbeatTimer = setInterval(() => {
        // Slow crawl: never exceeds 89% unless real progress pushes past
        if (_currentPct < 89) {
            _currentPct = Math.min(_currentPct + 0.4, 89);
            _applyPct(_currentPct, null);
        }
    }, 400);
}

function stopHeartbeat() {
    if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

function _applyPct(pct, file) {
    dom.mlBarFill.style.width = `${pct}%`;
    dom.mlPct.textContent     = pct >= 100 ? 'Ready!' : `${Math.round(pct)}%`;
    if (file !== null) dom.mlFile.textContent = file;
    dom.modelProgressBar.classList.add('visible');
    dom.modelProgressFill.style.width = `${pct}%`;
}

function makeProgressHandler(label) {
    const fileProg = {};
    return function(info) {
        let pct  = null;
        let file = (info.file || info.name || '').split('/').pop();

        if (info.status === 'progress_total' && typeof info.progress === 'number') {
            pct = Math.round(info.progress);
        } else if ((info.status === 'downloading' || info.status === 'progress') && info.total > 0) {
            const key = info.file || info.name || 'chunk';
            fileProg[key] = { loaded: info.loaded || 0, total: info.total };
            const tl = Object.values(fileProg).reduce((s, f) => s + f.loaded, 0);
            const tt = Object.values(fileProg).reduce((s, f) => s + f.total,  0);
            pct = tt > 0 ? Math.round((tl / tt) * 100) : 0;
        } else if (info.status === 'loading' || info.status === 'initiate') {
            pct  = Math.max(_currentPct, 90);
            file = file || 'Loading into memory…';
        } else if (info.status === 'done' || info.status === 'ready') {
            pct  = 100;
            file = 'Ready!';
        }

        if (pct !== null) {
            _currentPct = pct;
            dom.modelLoading.classList.add('visible');
            dom.mlLabel.textContent = label;
            _applyPct(pct, file);
        }
    };
}

function showLoadingBar(label) {
    _currentPct = 0;
    dom.modelLoading.classList.add('visible');
    dom.mlLabel.textContent  = label;
    dom.mlFile.textContent   = 'Connecting…';
    dom.mlPct.textContent    = '0%';
    dom.mlBarFill.style.width = '0%';
    startHeartbeat();
}

function hideLoadingBar() {
    stopHeartbeat();
    // Flash "Ready!" briefly before hiding
    _currentPct = 100;
    _applyPct(100, 'Ready!');
    dom.mlPct.textContent = 'Ready!';
    dom.modelLoading.classList.add('ready');
    setTimeout(() => {
        dom.modelLoading.classList.remove('visible');
        dom.modelLoading.classList.remove('ready');
        dom.modelProgressBar.classList.remove('visible');
    }, 2000);
}

function setModelStatus(type, text) {
    dom.modelDot.className = `status-dot ${type}`;
    dom.modelStatusText.textContent = text;
}

async function loadModel() {
    const hasWebGPU = await checkWebGPU();
    if (!hasWebGPU) {
        setModelStatus('error', 'WebGPU not supported — try Chrome 113+');
        dom.webgpuNotice.style.display = 'flex';
        dom.generateBtn.disabled = false;
        dom.resetBtn.disabled    = false;
        return;
    }

    showLoadingBar('Qwen2.5-1.5B · WebGPU');
    setModelStatus('loading', 'Loading WebLLM…');

    try {
        const webllm = await import(WEBLLM_CDN);

        engine = await webllm.CreateMLCEngine(WEBLLM_MODEL, {
            initProgressCallback: (report) => {
                // report.progress is 0–1, report.text is a human-readable status
                const pct  = Math.round(report.progress * 100);
                const file = report.text || '';
                _currentPct = pct;
                dom.modelLoading.classList.add('visible');
                dom.mlLabel.textContent = 'Qwen2.5-1.5B · WebGPU';
                _applyPct(pct, file);
                setModelStatus('loading', file.slice(0, 60) || 'Loading…');
            },
        });

        hideLoadingBar();
        setModelStatus('webgpu', 'Qwen2.5-1.5B ready · WebGPU ⚡');
    } catch (err) {
        console.error('WebLLM failed:', err);
        hideLoadingBar();
        setModelStatus('error', 'AI unavailable — formatting only');
    }

    dom.generateBtn.disabled = false;
    dom.resetBtn.disabled    = false;
}

/**
 * SENTINEL TRANSFORMATION PROMPT (Use this in Gemini/GPT-4 to prepare your data):
 *
 * "Act as a Data Architect. Convert my resume into the 'Sentinel Optimized Database' format.
 * Rules:
 * 1. Use '# SECTION_NAME' for headers (CONTACT, SUMMARY, EXPERIENCE, SKILLS, EDUCATION).
 * 2. For Experience, use exactly: 'Company — Location' on one line, then 'Role — Dates' on the next.
 * 3. Use ' — ' (em-dash with spaces) as the separator.
 * 4. Keep every bullet point under 25 words.
 * 5. Output raw text only."
 */

// ── AI GENERATION ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = 'You are a resume writer. Output ONLY the rewritten text, nothing else. No explanations, no quotes, no labels.';

async function generate(userPrompt, maxTokens = 1200) {
    if (!engine) return null;
    try {
        console.log('[WebLLM] Generating…', userPrompt.slice(0, 80));
        const reply = await engine.chat.completions.create({
            messages: [
                { role: 'system',  content: SYSTEM_PROMPT },
                { role: 'user',    content: userPrompt },
            ],
            max_tokens:         maxTokens,
            temperature:        0.2,
            repetition_penalty: 1.1,
        });
        const out = cleanOutput(reply.choices[0]?.message?.content || '');
        console.log('[WebLLM] Output:', out.slice(0, 120));
        return out;
    } catch (err) {
        console.warn('Generate error (keeping original):', err.message);
        return null;
    }
}

function cleanOutput(raw) {
    return raw
        .replace(/^["']|["']$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Single batched call — tailor summary + all bullets in one shot
async function tailorAll(resumeData, keywords) {
    const kwStr = keywords.all.slice(0, 10).join(', ');

    // Collect all bullets with back-references
    const bulletRefs = [];
    resumeData.experience.forEach((job, ji) =>
        job.bullets.forEach((b, bi) => bulletRefs.push({ ji, bi, text: b }))
    );

    const parts = [];
    if (resumeData.summary) {
        parts.push(`SUMMARY:\n${resumeData.summary}`);
    }
    if (bulletRefs.length) {
        parts.push(`BULLETS:\n${bulletRefs.map((b, i) => `${i + 1}. ${b.text}`).join('\n')}`);
    }
    if (!parts.length) return;

    const prompt =
        `You are a resume writer. Rewrite the content below for a role requiring: ${kwStr}.\n\n` +
        `Rules:\n` +
        `- SUMMARY: 2 sentences, professional, include relevant keywords.\n` +
        `- BULLETS: action verb start, ≤22 words each, keep all numbers/metrics.\n` +
        `- Output ONLY the rewritten content in this exact format:\n` +
        `SUMMARY: <rewritten summary>\n` +
        `BULLETS:\n1. <bullet>\n2. <bullet>\n...\n\n` +
        parts.join('\n\n') + '\n\nRewritten:';

    const maxTok = 80 + bulletRefs.length * 55;
    const raw = await generate(prompt, Math.min(maxTok, 1200));
    if (!raw) return;

    // Parse summary
    const sumMatch = raw.match(/SUMMARY:\s*(.+?)(?=\nBULLETS|\n\n|$)/is);
    if (sumMatch) {
        const s = sumMatch[1].trim();
        if (s.length > 20) resumeData.summary = s;
    }

    // Parse bullets
    const bullSection = raw.match(/BULLETS?:\s*([\s\S]+)/i)?.[1] || raw;
    const lines = bullSection.split('\n')
        .map(l => l.trim())
        .filter(l => /^\d+[.)]\s+\S/.test(l));

    lines.forEach((line, i) => {
        const ref = bulletRefs[i];
        if (!ref) return;
        const text = line.replace(/^\d+[.)]\s+/, '').trim();
        if (text.length > 10 && text.length < 300) {
            resumeData.experience[ref.ji].bullets[ref.bi] = text;
        }
    });
}

// ── FILE PARSING ──────────────────────────────────────────────────────────────

async function parseFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'pdf')  return await parsePDF(file);
    if (ext === 'docx') return await parseDOCX(file);
    if (ext === 'doc')  return await parseDocLegacy(file);
    if (ext === 'rtf')  return await parseRTF(file);
    return await file.text();
}

async function parsePDF(file) {
    if (!window.pdfjsLib) throw new Error('PDF.js not loaded');
    pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const content = await (await pdf.getPage(i)).getTextContent();
        let prevY = null, line = '';
        const lines = [];
        for (const item of content.items) {
            if (prevY !== null && Math.abs(item.transform[5] - prevY) > 5) { lines.push(line.trim()); line = ''; }
            line += item.str;
            prevY = item.transform[5];
        }
        if (line.trim()) lines.push(line.trim());
        pages.push(lines.join('\n'));
    }
    return pages.join('\n\n');
}

async function parseDOCX(file) {
    if (!window.mammoth) throw new Error('mammoth.js not loaded');
    return (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
}

async function parseDocLegacy(file) {
    return (await file.text())
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
        .replace(/ {3,}/g, '\n').trim();
}

async function parseRTF(file) {
    return (await file.text())
        .replace(/\{\\[^}]+\}/g, '').replace(/\\[a-z]+\-?\d*\s?/gi, '')
        .replace(/[{}\\]/g, ' ').replace(/\s{2,}/g, '\n').trim();
}

// ── RESUME PARSER ─────────────────────────────────────────────────────────────

const SECTION_HEADERS = {
    contact:    /^(contact|personal info?|contact info?)\s*[:\-]?\s*$/i,
    summary:    /^(summary|professional summary|objective|profile|about me?)\s*[:\-]?\s*$/i,
    experience: /^(experience|work experience|employment(?: history)?|work history|professional experience|career history)\s*[:\-]?\s*$/i,
    skills:     /^(skills?|technical skills?|core competenc(?:y|ies)|technologies|tools?|expertise)\s*[:\-]?\s*$/i,
    education:  /^(education|academic(?:s| background)?|qualifications?|degrees?)\s*[:\-]?\s*$/i,
};

const DATE_RANGE_RE = /(\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|\d{4})\s*[-–—to]+\s*(\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|\d{4}|Present|Current|Now)/i;

function parseResume(raw) {
    const lines = raw.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/^#+\s*/, '').trimEnd());
    const sec = { contact: [], summary: [], experience: [], skills: [], education: [] };
    let cur = 'contact';
    for (const line of lines) {
        const t = line.trim();
        let hit = false;
        for (const [k, re] of Object.entries(SECTION_HEADERS)) { if (re.test(t)) { cur = k; hit = true; break; } }
        if (!hit) sec[cur].push(line);
    }
    return {
        contact:    parseContact(sec.contact),
        summary:    sec.summary.map(l => l.trim()).filter(Boolean).join(' '),
        experience: parseExperience(sec.experience),
        skills:     parseSkills(sec.skills),
        education:  parseEducation(sec.education),
    };
}

function parseContact(lines) {
    const text = lines.join(' ');
    const rawName = lines.find(l => l.trim())?.trim() || '';
    // Strip common "master resume" database title suffixes
    const name = rawName
        .replace(/\s*[-–—]\s*(MASTER\s+RESUME(\s+DATABASE)?|RESUME\s+DATABASE|DATABASE)\s*$/i, '')
        .replace(/\s*[-–—]\s*COMPREHENSIVE.*$/i, '')
        .trim();
    return {
        name,
        email:    text.match(/[\w.+\-]+@[\w.\-]+\.[a-z]{2,}/i)?.[0] || '',
        phone:    text.match(/(\+?1?\s?[\-.]?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/)?.[0]?.trim() || '',
        linkedin: (() => { const m = text.match(/(?:linkedin\.com\/in\/|linkedin:\s*)([\w\-]+)/i); return m ? `linkedin.com/in/${m[1]}` : ''; })(),
        location: text.match(/\b([A-Z][a-z]+(?: [A-Z][a-z]+)*,\s*[A-Z]{2})\b/)?.[1] || '',
    };
}

function parseExperience(lines) {
    // Pre-join lines that are split by PDF column extraction.
    // Handles cases like: "The Church of Jesus Christ of Latter-day" + "Saints — Chicago, IL"
    // and: "CarMax — South" + "Jordan, UT"
    const joined = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const next = lines[i + 1]?.trim() || '';
        if (!line) { joined.push(''); continue; }
        // Next line has em-dash but no date → cur is a continuation of a company name
        if (next && /[—–]/.test(next) && !next.match(DATE_RANGE_RE) && !line.match(DATE_RANGE_RE)) {
            joined.push(line + ' ' + next); i++; continue;
        }
        // Cur has em-dash but no state code, next looks like "City, ST" continuation
        if (/[—–]/.test(line) && !line.match(/,\s*[A-Z]{2}\b/) && !line.match(DATE_RANGE_RE)
            && next && /^[A-Z][a-z]/.test(next) && next.match(/,\s*[A-Z]{2}\b/)) {
            joined.push(line + ' ' + next); i++; continue;
        }
        joined.push(line);
    }

    const jobs = []; let cur = null; let pendingCo = null;
    for (const rawLine of joined) {
        const line = rawLine.trim();
        if (!line) continue;
        const dm         = line.match(DATE_RANGE_RE);
        const isBullet   = /^[•\-\*]\s+|^\d+\.\s+/.test(line);
        const hasEmDash  = /[—–]/.test(line);

        if (dm) {
            // Line contains a date range → this is the role line
            if (cur) jobs.push(cur);
            const withoutDate = line.replace(DATE_RANGE_RE, '').trim();
            // Role may be "Role — Company" or just "Role"
            const parts = withoutDate.split(/\s*[—–]\s*/).map(s => s.trim()).filter(Boolean);
            cur = {
                role:     parts[0] || '',
                company:  pendingCo ? pendingCo.name : (parts[1] || ''),
                location: pendingCo ? pendingCo.loc  : (parts[2] || ''),
                dates:    dm[0].trim(),
                bullets:  [],
            };
            pendingCo = null;
        } else if (hasEmDash && !isBullet && !cur?.bullets?.length) {
            // Company — Location header (no date, no bullets yet) → store for next role line
            const dashIdx = line.search(/[—–]/);
            pendingCo = { name: line.slice(0, dashIdx).trim(), loc: line.slice(dashIdx + 1).trim() };
        } else if (isBullet) {
            if (cur) cur.bullets.push(line.replace(/^[•\-\*\d]+\.?\s+/, '').trim());
        } else if (cur) {
            // Non-bulleted text after a role line → treat as implicit bullet (description paragraph)
            if (!cur.company && line.length < 60 && !line.match(/[.!?]$/)) {
                cur.company = line; // short, no terminal punctuation → probably company name
            } else if (line.length > 15) {
                cur.bullets.push(line); // descriptive sentence → implicit bullet
            }
        }
    }
    if (cur) jobs.push(cur);
    return jobs;
}

function parseSkills(lines) {
    const skills = [];
    for (const line of lines) {
        const t = line.trim(); if (!t) continue;
        const val = t.includes(':') ? t.split(':').slice(1).join(':') : t;
        skills.push(...val.split(/[,|;]/).map(s => s.trim()).filter(s => s.length > 0 && s.length < 50));
    }
    return [...new Set(skills)];
}

function parseEducation(lines) {
    const degs = []; let cur = null;
    for (const rawLine of lines) {
        const line = rawLine.trim(); if (!line) continue;
        const dm = line.match(DATE_RANGE_RE) || line.match(/\b(19|20)\d{2}\b/);
        if (dm) {
            if (cur && cur.degree) degs.push(cur);
            const parts = line.replace(DATE_RANGE_RE, '').replace(/\b(19|20)\d{2}\b/, '').trim().split(/[|,]/).map(s => s.trim()).filter(Boolean);
            cur = { degree: parts[0] || '', school: parts[1] || '', dates: dm[0] };
        } else if (cur) {
            if (!cur.degree) cur.degree = line; else if (!cur.school) cur.school = line;
        } else { cur = { degree: line, school: '', dates: '' }; }
    }
    if (cur && cur.degree) degs.push(cur);
    return degs;
}

// ── KEYWORD EXTRACTION ────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
    'the','a','an','and','or','is','are','was','were','be','been','being','will','would',
    'have','has','had','do','does','did','with','for','to','of','in','on','at','by','from',
    'as','this','that','these','those','we','our','you','your','they','their','it','its',
    'not','but','what','which','who','how','when','where','all','any','each','both','few',
    'more','most','other','some','such','than','then','so','if','about','into','through',
    'during','until','after','before','while','can','may','should','must','shall','need',
    'also','just','very','well','work','working','experience','years','year','ability',
    'strong','excellent','good','required','preferred','plus','bonus','nice','able','team',
    'teams','role','position','candidate','company','business','looking','seeking','join',
    'help','build','make','use','used','using','new','within','per','etc','job','tasks',
]);

const REQUIRED_SIGNALS = /\b(required|must have|mandatory|minimum|essential|necessary)\b/i;
const PREFERRED_SIGNALS = /\b(preferred|nice to have|bonus|plus|ideally|desirable|optional)\b/i;
const TECH_PHRASES = ['machine learning','deep learning','natural language processing','computer vision','data pipeline','data analysis','data science','data engineering','ci/cd','continuous integration','continuous deployment','rest api','restful api','graphql','microservices','agile scrum','agile methodology','project management','cross-functional','version control','cloud computing','object oriented','test driven development','software development'];

function extractKeywords(jobDesc) {
    const lc = jobDesc.toLowerCase();
    const freq = {};
    for (const w of lc.replace(/[^a-z0-9+#.\-\s]/g, ' ').split(/\s+/)) {
        if (w.length > 2 && !STOP_WORDS.has(w)) freq[w] = (freq[w] || 0) + 1;
    }
    const detected = TECH_PHRASES.filter(p => lc.includes(p));
    const topWords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([w]) => w);
    const all = [...new Set([...topWords, ...detected])];
    const required = [], preferred = [];
    for (const kw of all) {
        const i = lc.indexOf(kw); if (i === -1) continue;
        const win = lc.slice(Math.max(0, i - 200), Math.min(lc.length, i + 200));
        if (PREFERRED_SIGNALS.test(win)) preferred.push(kw);
        else if (REQUIRED_SIGNALS.test(win) || (freq[kw] || 0) >= 3) required.push(kw);
        else ((freq[kw] || 0) >= 2 ? required : preferred).push(kw);
    }
    return { required, preferred, all: [...new Set([...required, ...preferred])] };
}

function reorderSkills(skills, keywords) {
    const kwSet = new Set(keywords.map(k => k.toLowerCase()));
    const matched   = skills.filter(s => kwSet.has(s.toLowerCase()) || keywords.some(kw => s.toLowerCase().includes(kw) || kw.includes(s.toLowerCase())));
    const unmatched = skills.filter(s => !matched.includes(s));
    return [...matched, ...unmatched];
}

// ── TEMPLATE RENDERER ─────────────────────────────────────────────────────────

function renderResume(data) {
    const page = dom.resumeTpl.content.cloneNode(true).querySelector('.resume-page');
    const fill = (slot, val) => { const el = page.querySelector(`[data-slot="${slot}"]`); if (el) el.textContent = val || ''; };

    fill('name', data.contact.name || 'Your Name');
    fill('email', data.contact.email);
    fill('phone', data.contact.phone);
    fill('location', data.contact.location);
    fill('linkedin', data.contact.linkedin);
    fill('summary', data.summary);

    for (const f of ['phone', 'location', 'linkedin']) {
        if (!data.contact[f]) {
            page.querySelector(`[data-hide-if-empty="${f}"]`)?.style.setProperty('display', 'none');
            page.querySelector(`[data-slot="${f}"]`)?.style.setProperty('display', 'none');
        }
    }

    if (!data.summary) page.querySelector('[data-hide-if-empty="summary"]')?.remove();

    const expCont = page.querySelector('[data-repeat="experience"]');
    if (expCont) {
        if (!data.experience.length) expCont.closest('.r-section')?.remove();
        else data.experience.forEach(j => expCont.appendChild(buildExpItem(j)));
    }

    const skillsSlot = page.querySelector('[data-slot="skills"]');
    if (skillsSlot) {
        if (!data.skills.length) skillsSlot.closest('.r-section')?.remove();
        else data.skills.forEach(s => {
            const tag = document.createElement('span');
            tag.className = 'r-skill-tag'; tag.textContent = s;
            skillsSlot.appendChild(tag);
        });
    }

    const eduCont = page.querySelector('[data-repeat="education"]');
    if (eduCont) {
        if (!data.education.length) eduCont.closest('.r-section')?.remove();
        else data.education.forEach(e => eduCont.appendChild(buildEduItem(e)));
    }

    dom.resumeOutput.innerHTML = '';
    dom.resumeOutput.appendChild(page);
}

function buildExpItem(job) {
    const d = document.createElement('div'); d.className = 'r-exp-item';
    const hdr = document.createElement('div'); hdr.className = 'r-exp-header';
    const role = document.createElement('span'); role.className = 'r-exp-role'; role.textContent = job.role || '';
    const dates = document.createElement('span'); dates.className = 'r-exp-dates'; dates.textContent = job.dates || '';
    hdr.append(role, dates);
    const sub = document.createElement('div'); sub.className = 'r-exp-subheader';
    const co = document.createElement('span'); co.className = 'r-exp-company'; co.textContent = job.company || '';
    const loc = document.createElement('span'); loc.className = 'r-exp-location'; loc.textContent = job.location || '';
    sub.append(co, loc);
    d.append(hdr, sub);
    if (job.bullets?.length) {
        const ul = document.createElement('ul'); ul.className = 'r-bullets';
        job.bullets.forEach(b => { const li = document.createElement('li'); li.textContent = b; ul.appendChild(li); });
        d.appendChild(ul);
    }
    return d;
}

function buildEduItem(edu) {
    const d = document.createElement('div'); d.className = 'r-edu-item';
    const hdr = document.createElement('div'); hdr.className = 'r-edu-header';
    const deg = document.createElement('span'); deg.className = 'r-edu-degree'; deg.textContent = edu.degree || '';
    const dates = document.createElement('span'); dates.className = 'r-edu-dates'; dates.textContent = edu.dates || '';
    hdr.append(deg, dates);
    const sch = document.createElement('div'); sch.className = 'r-edu-school'; sch.textContent = edu.school || '';
    d.append(hdr, sch);
    return d;
}

// ── ATS SCORER ────────────────────────────────────────────────────────────────

function scoreATS(resumeData, keywords) {
    const sections = {
        summary:    resumeData.summary,
        experience: resumeData.experience.map(j => [j.role, j.company, ...j.bullets].join(' ')).join(' '),
        skills:     resumeData.skills.join(' '),
    };
    const allText = Object.values(sections).join(' ').toLowerCase();
    const has = (kw, t) => new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(t);

    const reqHit  = keywords.required.filter(kw => has(kw, allText));
    const reqMiss = keywords.required.filter(kw => !has(kw, allText));
    const prefHit = keywords.preferred.filter(kw => has(kw, allText));
    const prefMiss = keywords.preferred.filter(kw => !has(kw, allText));

    const tw = keywords.required.length * 2 + keywords.preferred.length;
    const mw = reqHit.length * 2 + prefHit.length;
    const overall = tw > 0 ? Math.round((mw / tw) * 100) : 0;

    const sectionScores = {};
    const all = [...keywords.required, ...keywords.preferred];
    for (const [n, t] of Object.entries(sections)) {
        const hit = all.filter(kw => has(kw, t.toLowerCase()));
        sectionScores[n] = all.length > 0 ? Math.round((hit.length / all.length) * 100) : 0;
    }

    return { overall, sectionScores, requiredMatched: reqHit.length, requiredTotal: keywords.required.length, preferredMatched: prefHit.length, preferredTotal: keywords.preferred.length, missingRequired: reqMiss.slice(0, 8), missingPreferred: prefMiss.slice(0, 8) };
}

function renderATS(r) {
    const grade = r.overall >= 70 ? 'high' : r.overall >= 45 ? 'mid' : 'low';
    dom.atsScoreNum.textContent = `${r.overall}%`;
    dom.atsScoreNum.className   = `ats-score-num ${grade}`;
    dom.atsBarFill.style.width  = `${r.overall}%`;
    dom.atsBarFill.className    = `ats-bar-fill ${grade}`;

    dom.atsCounts.innerHTML = `
        <div class="ats-count-row required"><span class="icon">✔</span> Required: ${r.requiredMatched}/${r.requiredTotal} matched</div>
        <div class="ats-count-row preferred"><span class="icon">◆</span> Preferred: ${r.preferredMatched}/${r.preferredTotal} matched</div>`;

    dom.atsMissingRequired.style.display = r.missingRequired.length ? 'flex' : 'none';
    dom.atsMissingRequiredList.innerHTML = r.missingRequired.map(kw => `<span class="kw-tag required">${kw}</span>`).join('');
    dom.atsMissingPreferred.style.display = r.missingPreferred.length ? 'flex' : 'none';
    dom.atsMissingPreferredList.innerHTML = r.missingPreferred.map(kw => `<span class="kw-tag preferred">${kw}</span>`).join('');

    dom.atsSections.innerHTML = Object.entries(r.sectionScores).map(([n, p]) => `
        <div class="ats-section-row">
            <span class="ats-section-name">${n[0].toUpperCase() + n.slice(1)}</span>
            <div class="ats-mini-bar"><div class="ats-mini-fill" style="width:${p}%"></div></div>
            <span class="ats-section-pct">${p}%</span>
        </div>`).join('');

    dom.atsPanel.classList.add('visible');
}

// ── STATUS LOG ────────────────────────────────────────────────────────────────

let totalSteps = 0, completedSteps = 0;

function initProgress(steps) {
    totalSteps = steps; completedSteps = 0;
    dom.statusMessages.innerHTML = '';
    dom.genProgressBar.classList.add('visible');
    dom.genProgressFill.style.width = '0%';
}

function log(message, status = 'active') {
    dom.statusMessages.querySelector('.active')?.classList.replace('active', 'done');
    const line = document.createElement('div');
    line.className = `status-line ${status}`;
    line.textContent = message;
    dom.statusMessages.appendChild(line);
    dom.statusMessages.scrollTop = dom.statusMessages.scrollHeight;
    completedSteps++;
    dom.genProgressFill.style.width = `${Math.min(Math.round((completedSteps / totalSteps) * 100), 95)}%`;
}

function finishProgress() {
    dom.statusMessages.querySelector('.active')?.classList.replace('active', 'done');
    dom.genProgressFill.style.width = '100%';
    setTimeout(() => dom.genProgressBar.classList.remove('visible'), 900);
}

// ── MAIN ORCHESTRATOR ─────────────────────────────────────────────────────────

async function handleGenerate() {
    if (isGenerating) return;
    const masterText  = dom.masterInput.value.trim();
    const jobDescText = dom.jobDescInput.value.trim();
    if (!masterText)  { alert('Please paste your master resume first.'); return; }
    if (!jobDescText) { alert('Please paste the job description first.'); return; }

    isGenerating = true;
    dom.generateBtn.disabled = true;
    dom.generateBtn.classList.add('generating');
    dom.generateBtn.textContent = 'Generating…';
    dom.pdfBtn.disabled = true;
    dom.atsPanel.classList.remove('visible');

    const hasAI = !!engine;
    initProgress(hasAI ? 6 : 5);

    try {
        log('Parsing master resume…');
        const resumeData = parseResume(masterText);

        log('Analyzing job description…');
        const keywords = extractKeywords(jobDescText);

        if (hasAI) {
            log('Tailoring resume with AI (one batch call)…');
            await tailorAll(resumeData, keywords);
        } else {
            log('No AI — using keyword reordering only…');
        }

        log('Reordering skills by relevance…');
        resumeData.skills = reorderSkills(resumeData.skills, keywords.all);

        log('Rendering resume…');
        renderResume(resumeData);

        log('Scoring ATS match…');
        renderATS(scoreATS(resumeData, keywords));

        finishProgress();
        log('Done — your tailored resume is ready!', 'done');
        dom.pdfBtn.disabled = false;

    } catch (err) {
        console.error(err);
        log(`Error: ${err.message}`);
        finishProgress();
    } finally {
        isGenerating = false;
        dom.generateBtn.disabled = false;
        dom.generateBtn.classList.remove('generating');
        dom.generateBtn.textContent = 'Generate Tailored Resume';
    }
}

// ── PRINT ─────────────────────────────────────────────────────────────────────

function printResume() {
    const page = dom.resumeOutput.querySelector('.resume-page');
    if (!page) { alert('Generate a resume first.'); return; }
    dom.printTarget.innerHTML = page.outerHTML;
    window.addEventListener('afterprint', () => { dom.printTarget.innerHTML = ''; }, { once: true });
    window.print();
}

function handleReset() {
    dom.masterInput.value = '';
    dom.jobDescInput.value = '';
    dom.statusMessages.innerHTML = '';
    dom.genProgressBar.classList.remove('visible');
    dom.atsPanel.classList.remove('visible');
    dom.pdfBtn.disabled = true;
    dom.resumeOutput.innerHTML = `
        <div class="resume-placeholder">
            <div class="placeholder-icon">📄</div>
            <p>Your tailored resume will appear here</p>
            <small>Paste your resume + job description, then click Generate</small>
        </div>`;
}

async function handleFileUpload(inputEl, targetTextarea) {
    const file = inputEl.files[0];
    if (!file) return;
    const origPlaceholder = targetTextarea.placeholder;
    targetTextarea.placeholder = `Parsing ${file.name}…`;
    try {
        targetTextarea.value = await parseFile(file);
    } catch (err) {
        alert(`Could not parse ${file.name}: ${err.message}\n\nTry pasting the text instead.`);
    }
    targetTextarea.placeholder = origPlaceholder;
    inputEl.value = '';
}

// ── EVENT LISTENERS (registered immediately on script parse) ──────────────────

dom.generateBtn.addEventListener('click', handleGenerate);
dom.resetBtn.addEventListener('click', handleReset);
dom.pdfBtn.addEventListener('click', printResume);
dom.fileMaster.addEventListener('change', () => handleFileUpload(dom.fileMaster, dom.masterInput));
dom.fileJob.addEventListener('change',   () => handleFileUpload(dom.fileJob,    dom.jobDescInput));
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleGenerate(); });

// Generate is enabled immediately so the user can test parsing/ATS without AI
dom.generateBtn.disabled = false;
dom.resetBtn.disabled    = false;

// ── INIT: load AI in background ───────────────────────────────────────────────

loadModel();
