// ── CLAUDE API RESUME GENERATOR ───────────────────────────────────────────────
// All parsing / rendering / ATS logic is identical to main.js.
// AI tailoring is done via a single Claude API call instead of a local model.
// ─────────────────────────────────────────────────────────────────────────────

const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const STORAGE_KEY  = 'resumegen_claude_api_key';

// ── DOM REFS ──────────────────────────────────────────────────────────────────
const dom = {
    modelDot:               document.getElementById('model-dot'),
    modelStatusText:        document.getElementById('model-status-text'),
    masterInput:            document.getElementById('master-resume-input'),
    jobDescInput:           document.getElementById('job-desc-input'),
    generateBtn:            document.getElementById('generate-btn'),
    resetBtn:               document.getElementById('reset-btn'),
    pdfBtn:                 document.getElementById('pdf-btn'),
    statusMessages:         document.getElementById('status-messages'),
    genProgressBar:         document.getElementById('gen-progress-bar'),
    genProgressFill:        document.getElementById('gen-progress-fill'),
    atsPanel:               document.getElementById('ats-panel'),
    atsScoreNum:            document.getElementById('ats-score-num'),
    atsBarFill:             document.getElementById('ats-bar-fill'),
    atsBarLabel:            document.getElementById('ats-bar-label'),
    atsCounts:              document.getElementById('ats-counts'),
    atsMissingRequired:     document.getElementById('ats-missing-required'),
    atsMissingRequiredList: document.getElementById('ats-missing-required-list'),
    atsMissingPreferred:    document.getElementById('ats-missing-preferred'),
    atsMissingPreferredList:document.getElementById('ats-missing-preferred-list'),
    atsSections:            document.getElementById('ats-sections'),
    resumeOutput:           document.getElementById('resume-output'),
    fileJob:                document.getElementById('file-job'),
    printTarget:            document.getElementById('print-target'),
    resumeTpl:              document.getElementById('resume-tpl'),
    apiKeyInput:            document.getElementById('api-key-input'),
    apiKeySave:             document.getElementById('api-key-save'),
    apiKeyPanel:            document.getElementById('api-key-panel'),
};

let isGenerating = false;
let session = null; // { keywords, jobDescText, atsResult, count }

// ── TRANSFORMATION PROMPT + MODAL ─────────────────────────────────────────────

const TRANSFORMATION_PROMPT = `You are a Career Data Architect. Convert the resume below into a "Sentinel Master Database" — a single comprehensive record of everything in my career. This database will be used by an AI to generate highly targeted resumes for specific job descriptions later. Capture more than you think is needed.

STRICT FORMAT RULES (the parser depends on these exactly):
• Section headers must be exactly: # CONTACT, # SUMMARY, # EXPERIENCE, # SKILLS, # EDUCATION
• Use ' — ' (space, em-dash, space) as the separator between all fields
• Every experience bullet must start with a strong action verb
• Preserve ALL numbers, percentages, dollar amounts, and metrics exactly as written
• Include EVERY job, every bullet, every skill — nothing omitted
• Output plain text only — no markdown asterisks, no bold, no tables

═══════════════════════════════════════════════
FORMAT REFERENCE (fill with your real data):
═══════════════════════════════════════════════

# CONTACT
Full Name
email@example.com — (555) 000-0000 — City, State
LinkedIn: linkedin.com/in/username
GitHub: github.com/username
Portfolio: yoursite.com

# SUMMARY
[Write 4-6 sentences covering: total years of experience, all core domains you work across, your top 5-6 technical strengths, the types of teams/company sizes you've worked in, and one differentiator that makes you stand out. This will be cut down to 2 sentences per job application — be exhaustive here.]

# EXPERIENCE
[Every position, reverse chronological. Use this exact structure for each:]

Company Name — City, State
Job Title — Month Year — Month Year
• [Action verb] + [what you did] + [scale/scope] + [tools/methods] + [quantified outcome]
• [Include every bullet point, even minor ones — coverage matters]
• [Add team size, budget, or user count wherever you know it]
• [If a result isn't quantified, describe the impact in concrete terms]

[Repeat for every position including internships, part-time, freelance, contract]

# SKILLS
[Group by category — be exhaustive, include everything you've touched professionally]
Languages: Python, JavaScript, TypeScript, SQL, Java, ...
Frameworks & Libraries: React, Node.js, FastAPI, Django, ...
Cloud & DevOps: AWS, GCP, Docker, Kubernetes, CI/CD, ...
Databases: PostgreSQL, MySQL, MongoDB, Redis, ...
Tools & Platforms: Git, Jira, Figma, Linux, ...
Certifications: AWS Solutions Architect — Amazon — 2023, ...
Methodologies: Agile, Scrum, TDD, REST API design, ...
Soft Skills: Cross-functional leadership, stakeholder communication, ...

# EDUCATION
[Each degree on its own block:]
Degree Type — Major — University Name — Graduation Year
GPA: X.X — Dean's List — Magna Cum Laude (include if notable)
Relevant Coursework: Course 1, Course 2, Course 3
Honors & Awards: [any academic recognition]

[Include bootcamps, online certificates, continuing education if relevant]

═══════════════════════════════════════════════
Now convert my resume using the format above:
[PASTE YOUR FULL RESUME BELOW THIS LINE]
═══════════════════════════════════════════════`;

const handleDownloadTemplate = () => {
    const printTarget = document.getElementById('print-target');
    printTarget.innerHTML = `
        <div class="resume-page" style="font-family: 'Georgia', serif;">
            <h1 class="r-name" style="margin-bottom: 4px; font-size: 18pt;">Sentinel Master Database</h1>
            <p style="margin: 0 0 18px 0; font-size: 10pt; color: #555; font-style: italic;">
                Step 1 of 2 — Use this prompt in Claude, ChatGPT, or any AI to build your career database.
                Paste the result into the Master Resume field in ResumeGen. The AI will then specialize it per job.
            </p>
            <hr style="border: none; border-top: 2px solid #1a1a2e; margin-bottom: 18px;">
            <div class="r-section">
                <h2 class="r-section-title" style="font-size: 11pt; letter-spacing: 0.1em;">PROMPT — COPY EVERYTHING BELOW INTO YOUR AI</h2>
                <div style="white-space: pre-wrap; margin-top: 14px; font-family: 'Courier New', monospace; font-size: 9pt; line-height: 1.6; background: #f8f8f8; padding: 14px; border-left: 3px solid #1a1a2e;">${TRANSFORMATION_PROMPT}</div>
            </div>
        </div>`;
    window.print();
    printTarget.innerHTML = '';
};

// ── API KEY MANAGEMENT ────────────────────────────────────────────────────────

function getApiKey() { return localStorage.getItem(STORAGE_KEY) || ''; }

function setApiKey(key) {
    localStorage.setItem(STORAGE_KEY, key.trim());
    updateApiKeyStatus();
}

function updateApiKeyStatus() {
    const key = getApiKey();
    if (key) {
        dom.modelDot.className = 'status-dot ready';
        dom.modelStatusText.textContent = 'Claude Haiku · API ready';
        dom.generateBtn.disabled = false;
        dom.apiKeyPanel.classList.add('key-saved');
        dom.apiKeyInput.value = '';
        dom.apiKeyInput.placeholder = 'API key saved ✓';
    } else {
        dom.modelDot.className = 'status-dot error';
        dom.modelStatusText.textContent = 'Enter API key to activate';
        dom.generateBtn.disabled = true;
        dom.apiKeyPanel.classList.remove('key-saved');
    }
}

// ── CLAUDE API CALL ───────────────────────────────────────────────────────────

async function tailorWithClaude(resumeData, keywords, jobDescText, atsResult = null) {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('No API key set');

    // Collect all bullets with back-references
    const bulletRefs = [];
    resumeData.experience.forEach((job, ji) =>
        job.bullets.forEach((b, bi) =>
            bulletRefs.push({ ji, bi, text: b, ctx: `${job.role}${job.company ? ' at ' + job.company : ''}` })
        )
    );

    const kwStr    = keywords.all.slice(0, 15).join(', ');
    const bullStr  = bulletRefs.map((b, i) => `${i + 1}. [${b.ctx}] ${b.text}`).join('\n');
    const jobList  = resumeData.experience.map((j, i) => `${i + 1}. ${j.role} at ${j.company}`).join('\n');
    // Send the first 2000 chars of the job description for full context
    const jobCtx   = jobDescText.slice(0, 2000);

    const userMessage =
`You are an elite resume writer. Your goal is to make this resume feel written specifically for this exact role — not just keyword-matched, but genuinely aligned in language, priorities, and framing.

JOB POSTING:
${jobCtx}

KEY SKILLS THIS ROLE REQUIRES: ${kwStr}

RULES:
- SUMMARY: Exactly 2 sentences. Open with the candidate's most relevant strength for THIS role. Mirror the job posting's vocabulary and priorities. No generic phrases like "results-driven" or "passionate about".
- BULLETS: Start with an action verb. ≤22 words. Preserve all numbers/metrics exactly. Reframe each bullet to emphasize what THIS employer cares about. Do NOT invent facts or add new metrics.
- BULLET COUNT: For each job, decide how relevant it is to this role. Write 3-5 bullets for highly relevant jobs, exactly 2 bullets for less relevant jobs. Never write more than 5 or fewer than 2 for any job.
- Output ONLY the structured result below, nothing else.
${atsResult && atsResult.missingRequired.length ? `
IMPORTANT — KEYWORD GAP: The previous version scored ${atsResult.overall}%. These required keywords are MISSING — naturally weave as many as possible into the summary and bullets without forcing or inventing facts: ${atsResult.missingRequired.join(', ')}${atsResult.missingPreferred.length ? `\nAlso try to include these preferred keywords: ${atsResult.missingPreferred.slice(0, 8).join(', ')}` : ''}` : ''}

JOBS IN THIS RESUME:
${jobList}

OUTPUT FORMAT:
SUMMARY: <rewritten summary>
BULLETS:
1. [Job Title at Company] <rewritten bullet>
2. [Job Title at Company] <rewritten bullet>
(group bullets by job, 3-5 for relevant jobs, 2 for less relevant — label every bullet with its job)

${resumeData.summary ? `CURRENT SUMMARY:\n${resumeData.summary}\n` : ''}BULLETS TO REWRITE:
${bullStr}`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key':                            apiKey,
            'anthropic-version':                    '2023-06-01',
            'content-type':                         'application/json',
            'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
            model:      CLAUDE_MODEL,
            max_tokens: 2048,
            messages:   [{ role: 'user', content: userMessage }],
        }),
    });

    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Claude API ${resp.status}: ${body}`);
    }

    const data = await resp.json();
    const raw  = data.content?.[0]?.text || '';
    console.log('[Claude] raw output:', raw.slice(0, 300));

    // Parse summary
    const sumMatch = raw.match(/SUMMARY:\s*(.+?)(?=\nBULLETS?|\n\n|$)/is);
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
        const text = line.replace(/^\d+[.)]\s+(?:\[.*?\]\s*)?/, '').trim();
        if (text.length > 10) {
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
    const joined = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const next = lines[i + 1]?.trim() || '';
        if (!line) { joined.push(''); continue; }
        if (next && /[—–]/.test(next) && !next.match(DATE_RANGE_RE) && !line.match(DATE_RANGE_RE)) {
            joined.push(line + ' ' + next); i++; continue;
        }
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
        const dm        = line.match(DATE_RANGE_RE);
        const isBullet  = /^[•\-\*]\s+|^\d+\.\s+/.test(line);
        const hasEmDash = /[—–]/.test(line);

        if (dm) {
            if (cur) jobs.push(cur);
            const withoutDate = line.replace(DATE_RANGE_RE, '').trim();
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
            const dashIdx = line.search(/[—–]/);
            pendingCo = { name: line.slice(0, dashIdx).trim(), loc: line.slice(dashIdx + 1).trim() };
        } else if (isBullet) {
            if (cur) cur.bullets.push(line.replace(/^[•\-\*\d]+\.?\s+/, '').trim());
        } else if (cur) {
            if (!cur.company && line.length < 60 && !line.match(/[.!?]$/)) {
                cur.company = line;
            } else if (line.length > 15) {
                cur.bullets.push(line);
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
        skills.push(...val.split(/[,|;•]/).map(s => s.trim()).filter(s => s.length > 0 && s.length < 50));
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
    'including','related','relevant','across','multiple','various','ensure','support',
    'responsible','responsibilities','duties','qualifications','skills','knowledge',
    'demonstrated','proven','hands','day','basis','part','least','three','five','two',
]);

const REQUIRED_SIGNALS = /\b(required|must have|must-have|mandatory|minimum|essential|necessary|require|requires)\b/i;
const PREFERRED_SIGNALS = /\b(preferred|nice to have|bonus|plus|ideally|desirable|optional|advantage|advantageous|beneficial)\b/i;

const TECH_PHRASES = [
    'machine learning','deep learning','natural language processing','computer vision',
    'large language model','large language models','generative ai','artificial intelligence',
    'data pipeline','data analysis','data science','data engineering','data visualization',
    'business intelligence','business analysis','product management','product development',
    'software development','software engineering','full stack','full-stack','front end','back end',
    'frontend','backend','mobile development','web development','api development',
    'ci/cd','continuous integration','continuous deployment','continuous delivery',
    'rest api','restful api','graphql','microservices','event driven','message queue',
    'test driven development','unit testing','integration testing','end to end testing',
    'agile','scrum','kanban','sprint','version control','code review',
    'object oriented','functional programming','system design','distributed systems',
    'cloud computing','cloud infrastructure','aws','google cloud','azure',
    'kubernetes','docker','containerization','infrastructure as code','terraform',
    'serverless','lambda','ec2','s3','rds','devops','site reliability','sre',
    'sql','nosql','postgresql','mysql','mongodb','redis','elasticsearch',
    'data warehouse','data lake','etl','spark','hadoop','airflow','dbt',
    'tableau','power bi','looker','google analytics','a/b testing',
    'project management','program management','cross-functional','stakeholder management',
    'customer success','customer experience','account management','relationship management',
    'digital marketing','social media','content marketing','seo','sem','paid media',
    'salesforce','crm','erp','jira','confluence','slack',
    'financial analysis','financial modeling','budget management','p&l',
    'risk management','compliance','regulatory','audit','kyc','aml','cip',
    'team leadership','people management','performance management','talent acquisition',
    'change management','strategic planning','executive communication',
];

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
        else if (isPreferred) preferred.push(kw);
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
    const d    = document.createElement('div'); d.className = 'r-exp-item';
    const hdr  = document.createElement('div'); hdr.className = 'r-exp-header';
    const role = document.createElement('span'); role.className = 'r-exp-role'; role.textContent = job.role || '';
    const dates= document.createElement('span'); dates.className = 'r-exp-dates'; dates.textContent = job.dates || '';
    hdr.append(role, dates);
    const sub  = document.createElement('div'); sub.className = 'r-exp-subheader';
    const co   = document.createElement('span'); co.className = 'r-exp-company'; co.textContent = job.company || '';
    const loc  = document.createElement('span'); loc.className = 'r-exp-location'; loc.textContent = job.location || '';
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
    const d   = document.createElement('div'); d.className = 'r-edu-item';
    const hdr = document.createElement('div'); hdr.className = 'r-edu-header';
    const deg = document.createElement('span'); deg.className = 'r-edu-degree'; deg.textContent = edu.degree || '';
    const dates=document.createElement('span'); dates.className = 'r-edu-dates'; dates.textContent = edu.dates || '';
    hdr.append(deg, dates);
    const sch = document.createElement('div'); sch.className = 'r-edu-school'; sch.textContent = edu.school || '';
    d.append(hdr, sch);
    return d;
}

// ── ATS SCORER ────────────────────────────────────────────────────────────────

function kwMatch(kw, text) {
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${esc}\\b`, 'i').test(text)) return true;
    const stem = kw.replace(/(?:ing|ed|er|es|s)$/i, '');
    if (stem.length > 3 && stem !== kw) {
        return new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text);
    }
    return false;
}

function scoreATS(resumeData, keywords) {
    const sections = {
        summary:    resumeData.summary || '',
        experience: resumeData.experience.map(j => [j.role, j.company, ...j.bullets].join(' ')).join(' '),
        skills:     resumeData.skills.join(' '),
    };
    const allText = Object.values(sections).join(' ').toLowerCase();

    const reqHit  = keywords.required.filter(kw => kwMatch(kw, allText));
    const reqMiss = keywords.required.filter(kw => !kwMatch(kw, allText));
    const prefHit = keywords.preferred.filter(kw => kwMatch(kw, allText));
    const prefMiss = keywords.preferred.filter(kw => !kwMatch(kw, allText));

    const tw = keywords.required.length * 2 + keywords.preferred.length;
    const mw = reqHit.length * 2 + prefHit.length;
    const overall = tw > 0 ? Math.round((mw / tw) * 100) : 0;

    const sectionScores = {};
    const all = [...keywords.required, ...keywords.preferred];
    for (const [n, t] of Object.entries(sections)) {
        const hit = all.filter(kw => kwMatch(kw, t.toLowerCase()));
        sectionScores[n] = all.length > 0 ? Math.round((hit.length / all.length) * 100) : 0;
    }

    return {
        overall, sectionScores,
        requiredMatched: reqHit.length, requiredTotal: keywords.required.length,
        preferredMatched: prefHit.length, preferredTotal: keywords.preferred.length,
        missingRequired: reqMiss,
        missingPreferred: prefMiss,
    };
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
    const apiKey      = getApiKey();
    const masterText  = dom.masterInput.value.trim();
    const jobDescText = dom.jobDescInput.value.trim();

    if (!apiKey)      { alert('Enter and save your Claude API key first.'); return; }
    if (!masterText)  { alert('Please paste your master resume first.'); return; }
    if (!jobDescText) { alert('Please paste the job description first.'); return; }

    isGenerating = true;
    dom.generateBtn.disabled = true;
    dom.generateBtn.classList.add('generating');
    dom.generateBtn.textContent = 'Generating…';
    dom.pdfBtn.disabled = true;
    dom.atsPanel.classList.remove('visible');

    if (!session || session.jobDescText !== jobDescText) {
        session = { keywords: null, jobDescText, atsResult: null, count: 0 };
    }
    const isRefinement = session.count > 0 && session.atsResult;
    initProgress(isRefinement ? 5 : 8);

    try {
        log('Parsing master resume…');
        const resumeData = parseResume(masterText);

        if (!session.keywords) {
            log('Analyzing job description…');
            session.keywords = extractKeywords(jobDescText);
        }
        const { keywords } = session;

        if (isRefinement) {
            log(`Refining (score was ${session.atsResult.overall}%) — targeting gaps…`);
            await tailorWithClaude(resumeData, keywords, jobDescText, session.atsResult);
        } else {
            log('Pass 1 · Initial tailoring…');
            await tailorWithClaude(resumeData, keywords, jobDescText, null);

            log('Pass 1 · Scoring…');
            const pass1 = scoreATS(resumeData, keywords);
            log(`Pass 1 score: ${pass1.overall}% — running pass 2…`);

            log('Pass 2 · Targeting keyword gaps…');
            await tailorWithClaude(resumeData, keywords, jobDescText, pass1);
        }

        log('Reordering skills by relevance…');
        resumeData.skills = reorderSkills(resumeData.skills, keywords.all);

        log('Rendering resume…');
        renderResume(resumeData);

        log('Scoring ATS match…');
        const atsResult = scoreATS(resumeData, keywords);
        renderATS(atsResult);
        session.atsResult = atsResult;
        session.count++;

        finishProgress();
        log(`Done — ${atsResult.overall}% ATS match${session.count > 1 ? ` (iteration ${session.count})` : ''}`, 'done');
        dom.pdfBtn.disabled = false;

    } catch (err) {
        console.error(err);
        log(`Error: ${err.message}`);
        finishProgress();
    } finally {
        isGenerating = false;
        dom.generateBtn.disabled = false;
        dom.generateBtn.classList.remove('generating');
        dom.generateBtn.textContent = session?.count > 0 ? 'Refine Resume' : 'Generate with Claude';
    }
}

// ── PRINT / RESET / FILE UPLOAD ───────────────────────────────────────────────

function printResume() {
    const page = dom.resumeOutput.querySelector('.resume-page');
    if (!page) { alert('Generate a resume first.'); return; }
    dom.printTarget.innerHTML = page.outerHTML;
    window.addEventListener('afterprint', () => { dom.printTarget.innerHTML = ''; }, { once: true });
    window.print();
}

function handleReset() {
    session = null;
    dom.generateBtn.textContent = 'Generate with Claude';
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
    const orig = targetTextarea.placeholder;
    targetTextarea.placeholder = `Parsing ${file.name}…`;
    try {
        targetTextarea.value = await parseFile(file);
    } catch (err) {
        alert(`Could not parse ${file.name}: ${err.message}\n\nTry pasting the text instead.`);
    }
    targetTextarea.placeholder = orig;
    inputEl.value = '';
}

// ── EVENT LISTENERS ───────────────────────────────────────────────────────────

dom.apiKeySave.addEventListener('click', () => {
    const val = dom.apiKeyInput.value.trim();
    if (val) setApiKey(val);
});
dom.apiKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') dom.apiKeySave.click(); });

dom.generateBtn.addEventListener('click', handleGenerate);
dom.resetBtn.addEventListener('click', handleReset);
dom.pdfBtn.addEventListener('click', printResume);
dom.fileJob.addEventListener('change',   () => handleFileUpload(dom.fileJob,    dom.jobDescInput));
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleGenerate(); });
document.getElementById('download-template-btn').addEventListener('click', handleDownloadTemplate);

dom.resetBtn.disabled = false;

// Init: check for saved key
updateApiKeyStatus();
