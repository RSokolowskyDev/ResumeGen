// ══════════════════════════════════════════════════════════════════
//  ResumeGen · main.js
//  Supports Groq (primary) and Gemini (fallback) APIs.
//
//  ARCHITECTURE NOTES:
//  1. parseResume()  → structured JS object from raw text
//  2. sanitize()     → strips [cite_start], [cite:N], markdown junk
//  3. callAI()       → sends to Groq or Gemini, returns raw string
//  4. parseAIJson()  → robust JSON extraction with fallback repair
//  5. validateData() → ensures required fields survive AI mutations
//  6. renderResume() → fills HTML template from validated data
// ══════════════════════════════════════════════════════════════════

const GROQ_MODEL_LARGE = 'llama-3.3-70b-versatile';
const GROQ_MODEL_SMALL = 'llama-3.1-8b-instant';
const STORAGE_KEY_GROQ = 'resumegen_groq_api_key';
const STORAGE_KEY_GEM  = 'resumegen_gemini_api_key';
const STORAGE_KEY_MODEL= 'resumegen_model_pref';

// ── DOM REFS ──────────────────────────────────────────────────────
const dom = {
    modelDot:                document.getElementById('model-dot'),
    modelStatusText:         document.getElementById('model-status-text'),
    apiKeyInput:             document.getElementById('api-key-input'),
    apiKeySave:              document.getElementById('api-key-save'),
    geminiKeyInput:          document.getElementById('gemini-key-input'),
    geminiKeySave:           document.getElementById('gemini-key-save'),
    modelSelect:             document.getElementById('model-select'),
    apiKeyPanel:             document.getElementById('api-key-panel'),
    masterInput:             document.getElementById('master-resume-input'),
    jobDescInput:            document.getElementById('job-desc-input'),
    generateBtn:             document.getElementById('generate-btn'),
    resetBtn:                document.getElementById('reset-btn'),
    pdfBtn:                  document.getElementById('pdf-btn'),
    statusMessages:          document.getElementById('status-messages'),
    genProgressBar:          document.getElementById('gen-progress-bar'),
    genProgressFill:         document.getElementById('gen-progress-fill'),
    atsPanel:                document.getElementById('ats-panel'),
    atsScoreNum:             document.getElementById('ats-score-num'),
    atsBarFill:              document.getElementById('ats-bar-fill'),
    atsBarLabel:             document.getElementById('ats-bar-label'),
    atsCounts:               document.getElementById('ats-counts'),
    atsMissingRequired:      document.getElementById('ats-missing-required'),
    atsMissingRequiredList:  document.getElementById('ats-missing-required-list'),
    atsMissingPreferred:     document.getElementById('ats-missing-preferred'),
    atsMissingPreferredList: document.getElementById('ats-missing-preferred-list'),
    atsSections:             document.getElementById('ats-sections'),
    resumeOutput:            document.getElementById('resume-output'),
    fileJob:                 document.getElementById('file-job'),
    fileMaster:              document.getElementById('file-master'),
    buildStatus:             document.getElementById('build-status'),
    printTarget:             document.getElementById('print-target'),
    resumeTpl:               document.getElementById('resume-tpl'),
    sectionOrderPanel:       document.getElementById('section-order-panel'),
    sectionOrderList:        document.getElementById('section-order-list'),
};

let isGenerating = false;
let session = null;

// ══════════════════════════════════════════════════════════════════
//  SECTION 1 — API KEY MANAGEMENT
// ══════════════════════════════════════════════════════════════════

const getGroqKey  = () => localStorage.getItem(STORAGE_KEY_GROQ) || '';
const getGemKey   = () => localStorage.getItem(STORAGE_KEY_GEM)  || '';
const getModelPref= () => localStorage.getItem(STORAGE_KEY_MODEL) || dom.modelSelect.value || 'auto';

function setGroqKey(k)  { localStorage.setItem(STORAGE_KEY_GROQ,  k.trim()); updateApiKeyStatus(); }
function setGemKey(k)   { localStorage.setItem(STORAGE_KEY_GEM,   k.trim()); updateApiKeyStatus(); }
function setModelPref(v){ localStorage.setItem(STORAGE_KEY_MODEL, v); }

function updateApiKeyStatus() {
    const groq = getGroqKey();
    const gem  = getGemKey();
    const hasKey = !!(groq || gem);
    dom.modelDot.className = hasKey ? 'status-dot ready' : 'status-dot loading';
    dom.modelStatusText.textContent = hasKey
        ? `Ready · ${[groq && 'Groq', gem && 'Gemini'].filter(Boolean).join(' + ')}`
        : 'Enter at least one API key to activate';
    dom.generateBtn.disabled = !hasKey;
    dom.apiKeyPanel.classList.toggle('key-saved', hasKey);
}

// ══════════════════════════════════════════════════════════════════
//  SECTION 2 — SANITIZATION  ← FIX FOR FAILURE 1 & 3
//  Strips all citation artifacts and markdown formatting that
//  pollute the resume text before it ever reaches the AI or DOM.
// ══════════════════════════════════════════════════════════════════

function sanitize(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        // Remove [cite_start] artifacts
        .replace(/\[cite_start\]/gi, '')
        // Remove [cite: 1, 2, 3] artifacts (any number format)
        .replace(/\[cite:\s*[\d,\s]+\]/gi, '')
        // Remove [cite_end] if present
        .replace(/\[cite_end\]/gi, '')
        // Remove markdown bold/italic
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        // Remove markdown heading markers
        .replace(/^#{1,6}\s*/gm, '')
        // Collapse multiple spaces/newlines
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Sanitize every string value recursively in an object
function sanitizeData(obj) {
    if (typeof obj === 'string') return sanitize(obj);
    if (Array.isArray(obj)) return obj.map(sanitizeData);
    if (obj && typeof obj === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(obj)) out[k] = sanitizeData(v);
        return out;
    }
    return obj;
}

// ══════════════════════════════════════════════════════════════════
//  SECTION 3 — AI ENGINE
// ══════════════════════════════════════════════════════════════════

async function callAI(prompt, preferSmall = false) {
    const pref    = getModelPref();
    const groqKey = getGroqKey();
    const gemKey  = getGemKey();

    const resolveTarget = () => {
        if (pref === 'auto') {
            return groqKey
                ? { api: 'groq',   id: preferSmall ? GROQ_MODEL_SMALL : GROQ_MODEL_LARGE }
                : { api: 'gemini', id: 'gemini-2.5-flash' };
        }
        if (pref.startsWith('gemini')) return { api: 'gemini', id: pref };
        return { api: 'groq', id: pref };
    };

    const callGroq = async (modelId) => {
        if (!groqKey) throw new Error('No Groq API key saved.');
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: modelId,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.15,
                max_tokens: 4096,
            }),
        });
        if (!r.ok) {
            const e = await r.json().catch(() => ({}));
            throw new Error(`Groq ${r.status}: ${e.error?.message || r.statusText}`);
        }
        const d = await r.json();
        return d.choices?.[0]?.message?.content || '';
    };

    const callGemini = async (modelId) => {
        if (!gemKey) throw new Error('No Gemini API key saved.');
        const r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${gemKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.15, maxOutputTokens: 8192 },
                }),
            }
        );
        if (!r.ok) {
            const e = await r.json().catch(() => ({}));
            throw new Error(`Gemini ${r.status}: ${e.error?.message || r.statusText}`);
        }
        const d = await r.json();
        const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error('Empty response from Gemini.');
        return text;
    };

    const target = resolveTarget();
    try {
        return target.api === 'groq' ? await callGroq(target.id) : await callGemini(target.id);
    } catch (err) {
        // Auto-fallback: if Groq hit rate limit, try Gemini
        if (pref === 'auto' && target.api === 'groq' && gemKey &&
            (err.message.includes('429') || err.message.toLowerCase().includes('limit'))) {
            log('Groq rate limited — falling back to Gemini…');
            return await callGemini('gemini-2.5-flash');
        }
        throw err;
    }
}

// ══════════════════════════════════════════════════════════════════
//  SECTION 4 — ROBUST JSON EXTRACTION  ← FIX FOR FAILURE 2
//  The old extractJSON() just grabbed first { to last }.
//  This version tries multiple strategies before giving up.
// ══════════════════════════════════════════════════════════════════

function parseAIJson(raw) {
    if (!raw || typeof raw !== 'string') return null;

    console.log('[parseAIJson] Raw AI response (first 500 chars):', raw.slice(0, 500));

    // Strategy 1: Strip ALL markdown code fences (Gemini loves these)
    let text = raw
        .replace(/^[\s\S]*?```(?:json)?[\s]*/i, '')  // strip everything before and including ```json
        .replace(/```[\s\S]*$/i, '')                   // strip ``` and everything after
        .trim();

    // If stripping fences left nothing useful, fall back to raw
    if (!text.includes('{')) text = raw.trim();

    // Strategy 2: Direct parse
    try { return JSON.parse(text); } catch (_) {}

    // Strategy 3: Find outermost { … } with proper brace counting
    const start = text.indexOf('{');
    if (start !== -1) {
        let depth = 0, inStr = false, escape = false, end = -1;
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (escape)             { escape = false; continue; }
            if (ch === '\\' && inStr) { escape = true; continue; }
            if (ch === '"')         { inStr = !inStr; continue; }
            if (inStr)              continue;
            if (ch === '{')         depth++;
            else if (ch === '}')    { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end !== -1) {
            const slice = text.slice(start, end + 1);

            // Strategy 4: Direct parse of slice
            try { return JSON.parse(slice); } catch (_) {}

            // Strategy 5: Clean control characters
            try {
                const cleaned = slice.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ');
                return JSON.parse(cleaned);
            } catch (_) {}

            // Strategy 6: Fix unescaped newlines inside JSON strings (common Gemini bug)
            try {
                const fixed = slice.replace(/("(?:[^"\\]|\\.)*")|[\n\r\t]/g,
                    (m, str) => str ? str : ' ');
                return JSON.parse(fixed);
            } catch (_) {}

            // Strategy 7: Aggressive cleanup — remove all literal newlines inside strings
            try {
                const aggressive = slice
                    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
                    .replace(/,\s*}/g, '}')    // trailing commas
                    .replace(/,\s*]/g, ']');   // trailing commas in arrays
                return JSON.parse(aggressive);
            } catch (_) {}
        }
    }

    console.error('[parseAIJson] All strategies failed. Full response:', raw);
    return null;
}

// ══════════════════════════════════════════════════════════════════
//  SECTION 5 — DATA VALIDATION  ← FIX FOR FAILURE 2 (continued)
//  After merging AI output, ensure nothing critical is missing.
// ══════════════════════════════════════════════════════════════════

function validateAndMerge(masterData, aiOutput) {
    if (!aiOutput || typeof aiOutput !== 'object') return masterData;

    const merged = { ...masterData };

    // Summary — must be a non-empty string
    if (typeof aiOutput.summary === 'string' && aiOutput.summary.trim()) {
        merged.summary = sanitize(aiOutput.summary);
    }

    // Experience — must be an array of objects with role+company
    if (Array.isArray(aiOutput.experience) && aiOutput.experience.length > 0) {
        const valid = aiOutput.experience.filter(j =>
            j && typeof j === 'object' && (j.role || j.company)
        );
        if (valid.length > 0) {
            merged.experience = valid.map(j => ({
                role:     sanitize(j.role     || ''),
                company:  sanitize(j.company  || ''),
                location: sanitize(j.location || ''),
                dates:    sanitize(j.dates    || ''),
                bullets:  Array.isArray(j.bullets)
                    ? j.bullets.map(b => sanitize(String(b))).filter(Boolean)
                    : [],
            }));
        }
    }

    // Skills — must be array of strings
    if (Array.isArray(aiOutput.skills) && aiOutput.skills.length > 0) {
        merged.skills = [...new Set(
            aiOutput.skills.map(s => sanitize(String(s))).filter(s => s.length > 0 && s.length < 60)
        )];
    }

    // Education — accept if valid
    if (Array.isArray(aiOutput.education) && aiOutput.education.length > 0) {
        const valid = aiOutput.education.filter(e => e && (e.school || e.degree));
        if (valid.length > 0) {
            merged.education = valid.map(e => ({
                degree:  sanitize(e.degree  || ''),
                major:   sanitize(e.major   || ''),
                school:  sanitize(e.school  || ''),
                dates:   sanitize(e.dates   || ''),
                details: Array.isArray(e.details)
                    ? e.details.map(d => sanitize(String(d))).filter(Boolean)
                    : [],
            }));
        }
    }

    // Certifications
    if (Array.isArray(aiOutput.certifications)) {
        merged.certifications = aiOutput.certifications
            .filter(c => c && c.name)
            .map(c => ({
                name:   sanitize(c.name   || ''),
                issuer: sanitize(c.issuer || ''),
                year:   sanitize(c.year   || ''),
            }));
    }

    // ALWAYS restore original contact — AI must never overwrite it
    merged.contact = masterData.contact;

    return merged;
}

// ══════════════════════════════════════════════════════════════════
//  SECTION 6 — AI TAILORING
// ══════════════════════════════════════════════════════════════════

async function tailorResume(masterData, keywords, jobDesc, atsResult = null) {
    const isPass2  = !!atsResult;
    const missing  = isPass2
        ? [...atsResult.missingRequired, ...atsResult.missingPreferred.slice(0, 5)].join(', ')
        : keywords.required.slice(0, 15).join(', ');

    const prompt = `You are an expert executive resume writer. Tailor the candidate's Master Database for the Job Description below.

MASTER DATABASE (source of truth — use ALL jobs, education, and certifications):
${JSON.stringify({experience: masterData.experience, skills: masterData.skills, education: masterData.education, certifications: masterData.certifications})}

JOB DESCRIPTION:
${jobDesc}

${isPass2 ? `IMPROVEMENT NOTE: The previous draft was missing these keywords — naturally weave them in: ${missing}` : `PRIORITY KEYWORDS TO INCLUDE: ${missing}`}

STRICT RULES:
1. You may omit roles with zero relevance to the job description, but never merge roles. Always keep at least 3-4 entries. Never omit the most recent role.
2. Do NOT invent experience, tools, or metrics not present in the Master Database.
3. Use past-tense action verbs only (Managed, Led, Built — NOT Manage, Lead, Build).
4. No markdown formatting anywhere — no **bold**, no *italic*, no bullet symbols. Plain text strings only.
5. No first-person pronouns.
6. CRITICAL: Each experience entry must keep its exact original company name and role title from the Master Database. Do NOT swap, rename, or reassign companies or roles between entries.
7. Return ONLY the raw JSON object. No code fences, no \`\`\`json, no explanation before or after. Start your response with { and end with }.

JSON SCHEMA (return exactly this structure):
{
  "summary": "3 sentence professional summary",
  "experience": [
    { "role": "Job Title", "company": "Company Name", "location": "City, ST", "dates": "Month YYYY - Month YYYY", "bullets": ["bullet 1", "bullet 2"] }
  ],
  "skills": ["Skill A", "Skill B"],
  "education": [
    { "degree": "Bachelor of Science", "major": "Software Engineering", "school": "Ensign College", "dates": "2028", "details": ["GPA: 3.9", "Relevant coursework..."] }
  ],
  "certifications": [
    { "name": "Cert Name", "issuer": "Issuing Body", "year": "2024" }
  ]
}`;

    const raw    = await callAI(prompt);
    const parsed = parseAIJson(raw);

    if (!parsed) {
        throw new Error('AI returned invalid JSON. Try again or switch models.');
    }

    return validateAndMerge(masterData, parsed);
}

// ══════════════════════════════════════════════════════════════════
//  SECTION 7 — AUTO-STRUCTURE MASTER DATABASE
// ══════════════════════════════════════════════════════════════════

const STRUCTURE_PROMPT = `You are a Career Data Architect. Convert the raw resume text below into a structured Master Database that an AI will use to tailor applications per job.

STRICT FORMAT — output plain text only, no markdown, no bold, no asterisks:

# CONTACT
Full Name
email@example.com - (555) 000-0000 - City, ST
LinkedIn: linkedin.com/in/handle
GitHub: github.com/handle
Portfolio: yoursite.com

# SUMMARY
Comprehensive 4-6 sentence summary.

# EXPERIENCE
Company Name
City, ST
Month YYYY - Month YYYY
Job Title Month YYYY - Month YYYY
- Action verb + quantified result
- Action verb + quantified result

# SKILLS
Languages: Skill 1, Skill 2
Frameworks: Skill 3, Skill 4

# EDUCATION
Degree - Major - School - Year
GPA: X.X - Coursework: Course 1, Course 2

# CERTIFICATIONS
Certification Name - Issuing Body - Year

RAW RESUME TO CONVERT:
`;

async function handleBuildMasterDatabase() {
    const rawText = dom.masterInput.value.trim();
    if (!rawText) return;
    // Skip if already structured
    if (rawText.includes('# CONTACT') && rawText.includes('# EXPERIENCE')) return;

    const key = getGroqKey() || getGemKey();
    if (!key) return;

    dom.buildStatus.style.display = 'inline-block';
    try {
        const raw = await callAI(STRUCTURE_PROMPT + rawText, true);
        const result = sanitize(raw);
        if (result.includes('# CONTACT') && result.includes('# EXPERIENCE')) {
            dom.masterInput.value = result;
        }
    } catch (err) {
        console.error('Auto-structuring failed:', err);
    } finally {
        dom.buildStatus.style.display = 'none';
    }
}

// ══════════════════════════════════════════════════════════════════
//  SECTION 8 — RESUME PARSER
//  Converts raw structured text → JS object
// ══════════════════════════════════════════════════════════════════

const DATE_RE = /(\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|\d{4})\s*[-–—to]+\s*(\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|\d{4}|Present|Current|Now)/i;

function parseResume(rawText) {
    // Sanitize the raw text first — removes [cite_start] etc. before parsing
    const text = sanitize(rawText);

    const sections = {
        contact: [], summary: [], experience: [],
        skills: [], education: [], certifications: [],
    };
    let cur = null;

    const HEADERS = [
        { key: 'contact',        re: /^#?\s*CONTACT/i },
        { key: 'summary',        re: /^#?\s*SUMMARY/i },
        { key: 'experience',     re: /^#?\s*EXPERIENCE/i },
        { key: 'skills',         re: /^#?\s*SKILLS/i },
        { key: 'education',      re: /^#?\s*EDUCATION/i },
        { key: 'certifications', re: /^#?\s*CERTIFICATIONS?/i },
    ];

    for (const line of text.split('\n')) {
        const l = line.trim();
        if (!l) continue;
        let isHeader = false;
        for (const h of HEADERS) {
            if (h.re.test(l)) { cur = h.key; isHeader = true; break; }
        }
        if (!isHeader && cur) sections[cur].push(l);
    }

    return {
        contact:        parseContact(sections.contact),
        summary:        sections.summary.join(' ').trim(),
        experience:     parseExperience(sections.experience),
        skills:         parseSkills(sections.skills),
        education:      parseEducation(sections.education),
        certifications: parseCertifications(sections.certifications),
    };
}

function parseContact(lines) {
    const text = lines.join(' ');
    const rawName = lines.find(l => l.trim())?.trim() || '';
    const name = rawName
        .replace(/\s*[-–—]\s*(MASTER\s+RESUME(\s+DATABASE)?|RESUME\s+DATABASE|DATABASE)\s*$/i, '')
        .replace(/\s*[-–—]\s*COMPREHENSIVE.*$/i, '')
        .trim();

    // Extract GitHub
    const ghMatch = text.match(/(?:github\.com\/)([\w\-]+)/i);
    // Extract Portfolio (any URL that isn't linkedin or github)
    const portMatch = text.match(/(?:portfolio|site|web):\s*([\w.\-\/]+)/i) ||
                      text.match(/([\w\-]+\.(?:io|dev|com|me)(?:\/[\w\-]+)*)/i);

    return {
        name,
        email:     text.match(/[\w.+\-]+@[\w.\-]+\.[a-z]{2,}/i)?.[0] || '',
        phone:     text.match(/(\+?1?\s?[\-.]?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/)?.[0]?.trim() || '',
        linkedin:  (() => { const m = text.match(/(?:linkedin\.com\/in\/|linkedin:\s*)([\w\-]+)/i); return m ? `linkedin.com/in/${m[1]}` : ''; })(),
        github:    ghMatch ? `github.com/${ghMatch[1]}` : '',
        portfolio: portMatch ? portMatch[1] : '',
        location:  text.match(/\b([A-Z][a-z]+(?: [A-Z][a-z]+)*,\s*[A-Z]{2})\b/)?.[1] || '',
    };
}

function parseExperience(lines) {
    const jobs = [];
    let cur = null;
    let pendingCompany  = null;
    let pendingLocation = null;
    let pendingDate     = null;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const dateMatch = line.match(DATE_RE);
        const isBullet  = /^[•\-\*▪]\s+/.test(line);

        if (isBullet) {
            if (cur) cur.bullets.push(sanitize(line.replace(/^[•\-\*▪]\s+/, '')));
            continue;
        }

        if (dateMatch) {
            // Line contains a date range → start new job entry
            const withoutDate = line.replace(DATE_RE, '').replace(/[-–—]\s*$/, '').trim();
            if (cur) jobs.push(cur);
            cur = {
                role:     withoutDate || '',
                company:  pendingCompany  || '',
                location: pendingLocation || '',
                dates:    dateMatch[0].trim(),
                bullets:  [],
            };
            pendingCompany  = null;
            pendingLocation = null;
            pendingDate     = null;
            continue;
        }

        // Line with a location pattern (City, ST) → treat as company line
        const locMatch = line.match(/^(.+?),\s+([A-Z]{2})$/);
        if (locMatch && !cur?.bullets?.length) {
            if (pendingCompany) {
                // We already have a company — this might be location on own line
                pendingLocation = line;
            } else {
                pendingCompany  = locMatch[1].trim();
                pendingLocation = locMatch[2];
            }
            continue;
        }

        // Plain text line — could be company name or stray content
        if (cur) {
            // If no company yet, assign it
            if (!cur.company && line.length < 80) {
                cur.company = line;
            } else if (line.length > 10) {
                // Treat as a non-bulleted bullet (paragraph style)
                cur.bullets.push(sanitize(line));
            }
        } else if (!pendingCompany && line.length < 80) {
            pendingCompany = line;
        }
    }

    if (cur) jobs.push(cur);
    return jobs.filter(j => j.role || j.company);
}

function parseSkills(lines) {
    const skills = [];
    for (const line of lines) {
        const t = line.trim(); if (!t) continue;
        const val = t.includes(':') ? t.split(':').slice(1).join(':') : t;
        skills.push(
            ...val.split(/[,|;•]/)
                .map(s => sanitize(s).trim())
                .filter(s => s.length > 0 && s.length < 60)
        );
    }
    return [...new Set(skills)];
}

function parseEducation(lines) {
    const results = [];
    for (const line of lines) {
        const t = line.trim(); if (!t) continue;
        const parts = t.split(/\s*[-–—]\s*/);
        results.push({
            degree:  sanitize(parts[0] || ''),
            major:   sanitize(parts[1] || ''),
            school:  sanitize(parts[2] || ''),
            dates:   sanitize(parts[3] || ''),
            details: parts.slice(4).map(s => sanitize(s)).filter(Boolean),
        });
    }
    return results;
}

function parseCertifications(lines) {
    return lines
        .map(line => {
            const parts = line.split(/\s*[-–—]\s*/);
            return {
                name:   sanitize(parts[0] || ''),
                issuer: sanitize(parts[1] || ''),
                year:   sanitize(parts[2] || ''),
            };
        })
        .filter(c => c.name);
}

// ══════════════════════════════════════════════════════════════════
//  SECTION 9 — PAST TENSE CORRECTION
// ══════════════════════════════════════════════════════════════════

const PAST_TENSE_MAP = {
    'Manage':'Managed','Lead':'Led','Guide':'Guided','Build':'Built',
    'Develop':'Developed','Create':'Created','Teach':'Taught','Support':'Supported',
    'Resolve':'Resolved','Analyze':'Analyzed','Utilize':'Utilized','Improve':'Improved',
    'Maintain':'Maintained','Ensure':'Ensured','Coordinate':'Coordinated',
    'Collaborate':'Collaborated','Conduct':'Conducted','Direct':'Directed',
    'Implement':'Implemented','Increase':'Increased','Deliver':'Delivered',
    'Design':'Designed','Drive':'Drove','Execute':'Executed','Oversee':'Oversaw',
    'Provide':'Provided','Train':'Trained','Write':'Wrote','Deploy':'Deployed',
};

function ensurePastTense(text) {
    const firstWord = text.match(/^([A-Z][a-z]+)/)?.[1];
    if (!firstWord) return text;
    if (PAST_TENSE_MAP[firstWord]) {
        return text.replace(firstWord, PAST_TENSE_MAP[firstWord]);
    }
    // Handle -ing forms: Managing → Managed
    const ingMatch = text.match(/^([A-Z][a-z]+)ing\b/);
    if (ingMatch) {
        const root = ingMatch[1];
        const past = PAST_TENSE_MAP[root];
        if (past) return text.replace(ingMatch[0], past);
    }
    return text;
}

// ══════════════════════════════════════════════════════════════════
//  SECTION 10 — KEYWORD EXTRACTION & ATS
// ══════════════════════════════════════════════════════════════════

const STOP_WORDS = new Set([
    'the','a','an','and','or','is','are','was','were','be','been','being',
    'will','would','have','has','had','do','does','did','with','for','to',
    'of','in','on','at','by','from','as','this','that','these','those','we',
    'our','you','your','they','their','it','its','not','but','what','which',
    'who','how','when','where','all','any','each','both','few','more','most',
    'other','some','such','than','then','so','if','about','into','through',
    'during','until','after','before','while','can','may','should','must',
    'shall','need','also','just','very','well','work','working','experience',
    'years','year','ability','strong','excellent','good','required','preferred',
    'plus','bonus','nice','able','team','teams','role','position','candidate',
    'company','business','looking','seeking','join','help','make','use','used',
    'using','new','within','per','etc','job','tasks','including','related',
    'relevant','across','multiple','various','ensure','support','responsible',
    'responsibilities','duties','qualifications','skills','knowledge',
    'demonstrated','proven','hands','day','basis','part','least','two','three',
    'five','environment','opportunities','opportunity','following','required',
]);

const TECH_PHRASES = [
    'machine learning','deep learning','natural language processing',
    'large language model','generative ai','artificial intelligence',
    'data pipeline','data analysis','data science','data engineering',
    'business intelligence','software development','software engineering',
    'full stack','full-stack','frontend','backend','web development',
    'api development','ci/cd','continuous integration','continuous deployment',
    'test driven development','agile','scrum','version control',
    'cloud computing','aws','google cloud','azure','kubernetes','docker',
    'infrastructure as code','terraform','devops','site reliability',
    'sql','nosql','postgresql','mysql','mongodb','redis','elasticsearch',
    'data warehouse','etl','tableau','power bi','google analytics',
    'project management','cross-functional','stakeholder management',
    'customer success','account management','digital marketing',
    'salesforce','crm','erp','jira','confluence','risk management',
    'compliance','regulatory','kyc','aml','cip','kyc compliance',
    'microsoft 365','google workspace','microsoft entra','azure ad',
    'active directory','mdm','endpoint management','powershell','bash',
    'windows','macos','tcp/ip','dhcp','dns','vpn','smtp','tcp ip',
    'network troubleshooting','tier 1','help desk','it support',
    'managed services','msp','vmware','hyper-v','unifi','meraki',
    'rest api','restful api','graphql','microservices',
    'object oriented','functional programming','system design',
    'financial analysis','financial modeling','budget management',
    'team leadership','people management','change management',
    'strategic planning','bilingual','spanish','english',
    'cad','fusion 360','onshape','3d printing','autocad',
    'react','node.js','python','javascript','typescript','fastapi',
    'django','tensorflow','pytorch','playwright',
];

const REQUIRED_SIGNALS = /\b(required|must have|must-have|mandatory|minimum|essential|necessary|require|requires)\b/i;
const PREFERRED_SIGNALS = /\b(preferred|nice to have|bonus|plus|ideally|desirable|optional|advantage|advantageous|beneficial)\b/i;

function extractKeywords(jobDesc) {
    const lc = jobDesc.toLowerCase();
    const freq = {};
    for (const w of lc.replace(/[^a-z0-9+#.\-\s]/g, ' ').split(/\s+/)) {
        if (w.length > 2 && !STOP_WORDS.has(w)) freq[w] = (freq[w] || 0) + 1;
    }

    const detectedPhrases = TECH_PHRASES.filter(p => lc.includes(p));
    const phraseWords = new Set(detectedPhrases.flatMap(p => p.split(' ')));
    const topWords = Object.entries(freq)
        .filter(([w]) => !phraseWords.has(w))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40)
        .map(([w]) => w);

    const all = [...new Set([...detectedPhrases, ...topWords])];
    const required = [], preferred = [];

    for (const kw of all) {
        let idx = lc.indexOf(kw);
        if (idx === -1) continue;
        let isRequired = false, isPreferred = false;
        while (idx !== -1) {
            const win = lc.slice(Math.max(0, idx - 400), Math.min(lc.length, idx + 400));
            if (REQUIRED_SIGNALS.test(win)) { isRequired = true; break; }
            if (PREFERRED_SIGNALS.test(win)) isPreferred = true;
            idx = lc.indexOf(kw, idx + 1);
        }
        if (isRequired || (freq[kw] || 0) >= 3) required.push(kw);
        else if (isPreferred || (freq[kw] || 0) >= 2) preferred.push(kw);
        else preferred.push(kw);
    }

    return { required, preferred, all: [...new Set([...required, ...preferred])] };
}

function reorderSkills(skills, requiredKeywords) {
    const kwSet = new Set(requiredKeywords.map(k => k.toLowerCase()));
    const matched   = skills.filter(s => kwSet.has(s.toLowerCase()) || requiredKeywords.some(kw => s.toLowerCase().includes(kw.toLowerCase()) || kw.toLowerCase().includes(s.toLowerCase())));
    const unmatched = skills.filter(s => !matched.includes(s));
    return [...matched, ...unmatched];
}

function kwMatch(kw, text) {
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${esc}\\b`, 'i').test(text)) return true;
    if (kw.length > 3 && text.toLowerCase().includes(kw.toLowerCase())) return true;
    const stem = kw.replace(/(?:ing|ed|er|es|s)$/i, '');
    if (stem.length > 3 && stem !== kw) {
        return new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text);
    }
    return false;
}

function scoreATS(data, keywords) {
    const textBlocks = {
        summary:    data.summary || '',
        experience: data.experience.map(j => [j.role, j.company, ...j.bullets].join(' ')).join(' '),
        skills:     data.skills.join(' '),
    };
    const allText = Object.values(textBlocks).join(' ').toLowerCase();

    const reqHit  = keywords.required.filter(kw => kwMatch(kw, allText));
    const reqMiss = keywords.required.filter(kw => !kwMatch(kw, allText));
    const prefHit = keywords.preferred.filter(kw => kwMatch(kw, allText));
    const prefMiss= keywords.preferred.filter(kw => !kwMatch(kw, allText));

    const tw = keywords.required.length * 2 + keywords.preferred.length;
    const mw = reqHit.length * 2 + prefHit.length;
    const overall = tw > 0 ? Math.round((mw / tw) * 100) : 0;

    const allKws = [...keywords.required, ...keywords.preferred];
    const sectionScores = {};
    for (const [name, t] of Object.entries(textBlocks)) {
        const hit = allKws.filter(kw => kwMatch(kw, t.toLowerCase()));
        sectionScores[name] = allKws.length > 0 ? Math.round((hit.length / allKws.length) * 100) : 0;
    }

    return {
        overall, sectionScores,
        requiredMatched: reqHit.length, requiredTotal: keywords.required.length,
        preferredMatched: prefHit.length, preferredTotal: keywords.preferred.length,
        missingRequired: reqMiss,
        missingPreferred: prefMiss,
    };
}

// ══════════════════════════════════════════════════════════════════
//  SECTION 11 — TEMPLATE RENDERER
// ══════════════════════════════════════════════════════════════════

function renderResume(data) {
    const page = dom.resumeTpl.content.cloneNode(true).querySelector('.resume-page');

    const fill = (slot, val) => {
        const el = page.querySelector(`[data-slot="${slot}"]`);
        if (!el) return;
        // Sanitize one more time at render for safety
        const safe = sanitize(String(val || ''));
        if (el.tagName === 'A') {
            el.textContent = safe;
            // Add https:// if it looks like a URL and doesn't have a protocol
            if (safe && !safe.startsWith('http')) el.href = 'https://' + safe;
            else if (safe) el.href = safe;
        } else {
            el.textContent = safe;
        }
    };

    fill('name',      data.contact.name  || 'Your Name');
    fill('email',     data.contact.email);
    fill('phone',     data.contact.phone);
    fill('location',  data.contact.location);
    fill('linkedin',  data.contact.linkedin);
    fill('github',    data.contact.github);
    fill('portfolio', data.contact.portfolio);

    // Hide separators for empty optional fields
    for (const field of ['phone', 'location', 'linkedin', 'github', 'portfolio']) {
        if (!data.contact[field]) {
            page.querySelector(`[data-hide-if-empty="${field}"]`)?.remove();
            page.querySelector(`[data-slot="${field}"]`)?.remove();
        }
    }

    fill('summary', data.summary);
    if (!data.summary) page.querySelector('[data-hide-if-empty="summary"]')?.remove();

    // Respect section order from drag chips
    const orderChips  = Array.from(dom.sectionOrderList.querySelectorAll('.section-chip'));
    const desiredOrder = orderChips.map(c => c.dataset.section);
    const header = page.querySelector('.r-header');
    desiredOrder.forEach(secName => {
        const secEl = page.querySelector(`[data-section="${secName}"]`);
        if (secEl) page.appendChild(secEl);
    });

    // Experience
    const expCont = page.querySelector('[data-repeat="experience"]');
    if (expCont) {
        if (!data.experience.length) {
            expCont.closest('[data-section="experience"]')?.remove();
        } else {
            data.experience.forEach(j => expCont.appendChild(buildExpItem(j)));
        }
    }

    // Skills
    const skillsSlot = page.querySelector('[data-slot="skills"]');
    if (skillsSlot) {
        if (!data.skills.length) {
            skillsSlot.closest('[data-section="skills"]')?.remove();
        } else {
            const unique = [...new Set(data.skills)];
            unique.forEach(s => {
                const tag = document.createElement('span');
                tag.className = 'r-skill-tag';
                // Smart title case: preserve acronyms (AWS, CRM, SQL etc.)
                tag.textContent = s.split(' ').map(w => {
                    if (/^[A-Z0-9+#.]{2,}$/.test(w)) return w; // all-caps = acronym
                    return w.charAt(0).toUpperCase() + w.slice(1);
                }).join(' ');
                skillsSlot.appendChild(tag);
            });
        }
    }

    // Education + Certifications
    const eduCont = page.querySelector('[data-repeat="education"]');
    if (eduCont) {
        const hasEdu  = data.education?.length > 0;
        const hasCert = data.certifications?.length > 0;
        if (!hasEdu && !hasCert) {
            eduCont.closest('[data-section="education"]')?.remove();
        } else {
            if (hasEdu) data.education.forEach(e => eduCont.appendChild(buildEduItem(e)));
            if (hasCert) {
                const certHdr = document.createElement('div');
                certHdr.style.cssText = 'font-weight:700;font-size:8pt;text-transform:uppercase;letter-spacing:2px;color:#7c3aed;border-bottom:1.5px solid #e4d9fd;padding-bottom:2px;margin:10px 0 6px 0;';
                certHdr.textContent = 'Certifications';
                eduCont.appendChild(certHdr);
                data.certifications.forEach(c => eduCont.appendChild(buildCertItem(c)));
            }
        }
    }

    dom.resumeOutput.innerHTML = '';
    dom.resumeOutput.appendChild(page);
}

function buildExpItem(job) {
    const d = document.createElement('div');
    d.className = 'r-exp-item';

    const hdr = document.createElement('div'); hdr.className = 'r-exp-header';
    const role = document.createElement('span'); role.className = 'r-exp-role';
    role.textContent = sanitize(job.role || '');
    const dates = document.createElement('span'); dates.className = 'r-exp-dates';
    dates.textContent = sanitize(job.dates || '');
    hdr.append(role, dates);
    d.appendChild(hdr);

    if (job.company || job.location) {
        const sub = document.createElement('div'); sub.className = 'r-exp-subheader';
        const co = document.createElement('span'); co.className = 'r-exp-company';
        co.textContent = sanitize(job.company || '');
        const loc = document.createElement('span'); loc.className = 'r-exp-location';
        loc.textContent = sanitize(job.location || '');
        sub.append(co, loc);
        d.appendChild(sub);
    }

    if (job.bullets?.length) {
        const ul = document.createElement('ul'); ul.className = 'r-bullets';
        job.bullets.forEach(b => {
            const safe = ensurePastTense(sanitize(String(b)));
            if (!safe) return;
            const li = document.createElement('li');
            li.textContent = safe;
            ul.appendChild(li);
        });
        d.appendChild(ul);
    }
    return d;
}

function buildEduItem(edu) {
    const d = document.createElement('div'); d.className = 'r-edu-item';
    const hdr = document.createElement('div'); hdr.className = 'r-edu-header';
    const deg = document.createElement('span'); deg.className = 'r-edu-degree';
    deg.textContent = [sanitize(edu.degree), sanitize(edu.major)].filter(Boolean).join(' — ');
    const dates = document.createElement('span'); dates.className = 'r-edu-dates';
    dates.textContent = sanitize(edu.dates || '');
    hdr.append(deg, dates);
    d.appendChild(hdr);
    const sch = document.createElement('div'); sch.className = 'r-edu-school';
    sch.textContent = sanitize(edu.school || '');
    d.appendChild(sch);
    if (edu.details?.length) {
        const det = document.createElement('div'); det.className = 'r-edu-details';
        det.textContent = edu.details.map(s => sanitize(s)).join(' · ');
        d.appendChild(det);
    }
    return d;
}

function buildCertItem(cert) {
    const d = document.createElement('div'); d.className = 'r-cert-item';
    const left = document.createElement('span');
    const name = document.createElement('span'); name.className = 'r-cert-name';
    name.textContent = sanitize(cert.name || '');
    const issuer = document.createElement('span'); issuer.className = 'r-cert-issuer';
    if (cert.issuer) issuer.textContent = ' — ' + sanitize(cert.issuer);
    left.append(name, issuer);
    const right = document.createElement('span'); right.className = 'r-cert-year';
    right.textContent = sanitize(cert.year || '');
    d.append(left, right);
    return d;
}

// ══════════════════════════════════════════════════════════════════
//  SECTION 12 — ATS RENDER
// ══════════════════════════════════════════════════════════════════

function renderATS(r) {
    const grade = r.overall >= 70 ? 'high' : r.overall >= 45 ? 'mid' : 'low';
    dom.atsScoreNum.textContent = `${r.overall}%`;
    dom.atsScoreNum.className   = `ats-score-num ${grade}`;
    dom.atsBarFill.style.width  = `${r.overall}%`;
    dom.atsBarFill.className    = `ats-bar-fill ${grade}`;
    dom.atsBarLabel.textContent = 'Keyword match';

    dom.atsCounts.innerHTML = `
        <div class="ats-count-row required"><span class="icon">✔</span> Required: ${r.requiredMatched}/${r.requiredTotal} matched</div>
        <div class="ats-count-row preferred"><span class="icon">◆</span> Preferred: ${r.preferredMatched}/${r.preferredTotal} matched</div>`;

    dom.atsMissingRequired.style.display = r.missingRequired.length ? 'flex' : 'none';
    dom.atsMissingRequiredList.innerHTML = r.missingRequired.slice(0, 12).map(kw => `<span class="kw-tag required">${kw}</span>`).join('');
    dom.atsMissingPreferred.style.display = r.missingPreferred.length ? 'flex' : 'none';
    dom.atsMissingPreferredList.innerHTML = r.missingPreferred.slice(0, 12).map(kw => `<span class="kw-tag preferred">${kw}</span>`).join('');

    dom.atsSections.innerHTML = Object.entries(r.sectionScores).map(([n, p]) => `
        <div class="ats-section-row">
            <span class="ats-section-name">${n[0].toUpperCase() + n.slice(1)}</span>
            <div class="ats-mini-bar"><div class="ats-mini-fill" style="width:${p}%"></div></div>
            <span class="ats-section-pct">${p}%</span>
        </div>`).join('');

    dom.atsPanel.classList.add('visible');
}

function handleResumeEdit() {
    if (!session?.keywords) return;
    const text = dom.resumeOutput.innerText;
    const result = scoreATS(
        { summary: text, experience: [], skills: [] },
        session.keywords
    );
    renderATS({ ...result, sectionScores: {} });
}

// ══════════════════════════════════════════════════════════════════
//  SECTION 13 — PROGRESS LOG
// ══════════════════════════════════════════════════════════════════

let totalSteps = 0, completedSteps = 0;

function initProgress(steps) {
    totalSteps = steps; completedSteps = 0;
    dom.statusMessages.innerHTML = '';
    dom.genProgressBar.classList.add('visible');
    dom.genProgressFill.style.width = '0%';
}

function log(msg, status = 'active') {
    dom.statusMessages.querySelector('.active')?.classList.replace('active', 'done');
    const line = document.createElement('div');
    line.className = `status-line ${status}`;
    line.textContent = msg;
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

// ══════════════════════════════════════════════════════════════════
//  SECTION 14 — MAIN ORCHESTRATOR
// ══════════════════════════════════════════════════════════════════

async function handleGenerate() {
    if (isGenerating) return;

    const masterText  = dom.masterInput.value.trim();
    const jobDescText = dom.jobDescInput.value.trim();

    if (!masterText)  { alert('Please paste your master resume first.'); return; }
    if (!jobDescText) { alert('Please paste the job description first.'); return; }
    if (!getGroqKey() && !getGemKey()) { alert('Please save at least one API key first.'); return; }

    isGenerating = true;
    dom.generateBtn.disabled = true;
    dom.generateBtn.classList.add('generating');
    dom.generateBtn.textContent = 'Generating…';
    dom.pdfBtn.disabled = true;
    dom.atsPanel.classList.remove('visible');

    try {
        // Parse and validate master resume
        const masterData = parseResume(masterText);

        if (!masterData.contact.name) {
            throw new Error('Could not read your name from the resume. Make sure the "# CONTACT" section is present and your name is the first line.');
        }
        if (!masterData.experience.length) {
            throw new Error('No experience entries found. Make sure the "# EXPERIENCE" section is present with job dates.');
        }

        // Keywords — reuse if same job description
        if (!session || session.jobDescText !== jobDescText) {
            log('Analyzing job description…');
            const keywords = extractKeywords(jobDescText);
            session = { keywords, jobDescText, atsResult: null, resumeData: null, count: 0 };
        }
        const { keywords } = session;
        const isRefinement = session.count > 0 && !!session.atsResult;

        initProgress(isRefinement ? 4 : 5);
        session.count++;

        let tailored;

        if (isRefinement) {
            log(`Refinement pass — targeting ${session.atsResult.missingRequired.length} missing keywords…`);
            tailored = await tailorResume(masterData, keywords, jobDescText, session.atsResult);
        } else {
            log('Tailoring resume…');
            tailored = await tailorResume(masterData, keywords, jobDescText, null);
        }

        log('Reordering skills by relevance…');
        tailored.skills = reorderSkills(tailored.skills, keywords.required);

        log('Rendering resume…');
        renderResume(tailored);

        const atsResult = scoreATS(tailored, keywords);
        renderATS(atsResult);

        session.atsResult  = atsResult;
        session.resumeData = tailored;

        finishProgress();
        log(`Done · ${atsResult.overall}% ATS match${session.count > 1 ? ` (pass ${session.count})` : ''}`, 'done');
        dom.pdfBtn.disabled = false;

    } catch (err) {
        console.error('[ResumeGen Error]', err);
        log(`Error: ${err.message}`);
        finishProgress();
    } finally {
        isGenerating = false;
        dom.generateBtn.disabled = false;
        dom.generateBtn.classList.remove('generating');
        dom.generateBtn.textContent = session?.count > 0 ? 'Refine Resume' : 'Generate Tailored Resume';
    }
}

// ══════════════════════════════════════════════════════════════════
//  SECTION 15 — UTILITY HANDLERS
// ══════════════════════════════════════════════════════════════════

function printResume() {
    const page = dom.resumeOutput.querySelector('.resume-page');
    if (!page) { alert('Generate a resume first.'); return; }
    dom.printTarget.innerHTML = page.outerHTML;
    window.addEventListener('afterprint', () => { dom.printTarget.innerHTML = ''; }, { once: true });
    window.print();
}

function handleReset() {
    session = null;
    dom.generateBtn.textContent = 'Generate Tailored Resume';
    dom.masterInput.value = '';
    dom.jobDescInput.value = '';
    dom.statusMessages.innerHTML = '';
    dom.genProgressBar.classList.remove('visible');
    dom.atsPanel.classList.remove('visible');
    dom.pdfBtn.disabled = true;
    dom.generateBtn.disabled = !getGroqKey() && !getGemKey();
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
    const orig = targetTextarea.placeholder;
    targetTextarea.placeholder = `Parsing ${file.name}…`;
    try {
        targetTextarea.value = await parseFile(file);
        if (targetTextarea === dom.masterInput) {
            setTimeout(() => handleBuildMasterDatabase(), 200);
        }
    } catch (err) {
        alert(`Could not parse ${file.name}: ${err.message}\n\nTry pasting the text instead.`);
    }
    targetTextarea.placeholder = orig;
    inputEl.value = '';
}

// ── FILE PARSING ──────────────────────────────────────────────────

async function parseFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'pdf')  return parsePDF(file);
    if (ext === 'docx') return parseDOCX(file);
    if (ext === 'doc')  return parseDocLegacy(file);
    if (ext === 'rtf')  return parseRTF(file);
    return file.text();
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

// ── DRAG & DROP SECTION REORDER ───────────────────────────────────

function initDragAndDrop() {
    const list = dom.sectionOrderList;
    let dragging = null;

    list.addEventListener('dragstart', e => {
        dragging = e.target;
        e.target.classList.add('dragging');
    });
    list.addEventListener('dragend', e => {
        e.target.classList.remove('dragging');
        dragging = null;
        if (session?.resumeData) renderResume(session.resumeData);
    });
    list.addEventListener('dragover', e => {
        e.preventDefault();
        const target = e.target.closest('.section-chip');
        if (target && target !== dragging) {
            const mid = target.getBoundingClientRect().left + target.getBoundingClientRect().width / 2;
            list.insertBefore(dragging, e.clientX < mid ? target : target.nextElementSibling);
        }
    });
}

// ── DEBOUNCE ──────────────────────────────────────────────────────

function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ══════════════════════════════════════════════════════════════════
//  SECTION 16 — BOOT
// ══════════════════════════════════════════════════════════════════

// Restore saved model preference
const savedModel = localStorage.getItem(STORAGE_KEY_MODEL);
if (savedModel) dom.modelSelect.value = savedModel;

initDragAndDrop();

dom.generateBtn.addEventListener('click', handleGenerate);
dom.resetBtn.addEventListener('click', handleReset);
dom.pdfBtn.addEventListener('click', printResume);
dom.fileJob.addEventListener('change',   () => handleFileUpload(dom.fileJob,    dom.jobDescInput));
dom.fileMaster.addEventListener('change',() => handleFileUpload(dom.fileMaster, dom.masterInput));
dom.masterInput.addEventListener('input', debounce(() => handleBuildMasterDatabase(), 2000));
dom.resumeOutput.addEventListener('input', debounce(() => handleResumeEdit(), 500));
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleGenerate(); });

dom.apiKeySave.addEventListener('click', () => setGroqKey(dom.apiKeyInput.value));
dom.geminiKeySave.addEventListener('click', () => setGemKey(dom.geminiKeyInput.value));
dom.apiKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') dom.apiKeySave.click(); });
dom.geminiKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') dom.geminiKeySave.click(); });
dom.modelSelect.addEventListener('change', () => setModelPref(dom.modelSelect.value));

dom.resetBtn.disabled = false;
updateApiKeyStatus();