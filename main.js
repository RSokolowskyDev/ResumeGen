// ── GROQ CONFIG ───────────────────────────────────────────────────────────────
const GROQ_MODEL   = 'llama-3.3-70b-versatile';
const STORAGE_KEY  = 'resumegen_groq_api_key';

// ── DOM REFS ──────────────────────────────────────────────────────────────────
const dom = {
    modelDot:               document.getElementById('model-dot'),
    modelStatusText:        document.getElementById('model-status-text'),
    apiKeyInput:            document.getElementById('api-key-input'),
    apiKeySave:             document.getElementById('api-key-save'),
    apiKeyPanel:            document.getElementById('api-key-panel'),
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
};

let isGenerating = false;
let session = null; // { keywords, jobDescText, atsResult, count }

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
        dom.modelStatusText.textContent = 'Groq · Llama 3.3 70B · Ready';
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

// ── GROQ API CALL ─────────────────────────────────────────────────────────────

async function tailorWithGroq(resumeData, keywords, jobDescText, atsResult = null) {
    const kwStr  = keywords.all.slice(0, 15).join(', ');
    const jobCtx = jobDescText.slice(0, 2000);
    const jobList = resumeData.experience.map((j, i) => `${i + 1}. ${j.role}${j.company ? ' at ' + j.company : ''}`).join('\n');

    // Build bullet list — include placeholder lines for jobs with no bullets
    // so the LLM knows to generate content for every job
    let bullNum = 0;
    const bullLines = [];
    resumeData.experience.forEach(job => {
        const ctx = `${job.role}${job.company ? ' at ' + job.company : ''}`;
        if (job.bullets.length > 0) {
            job.bullets.forEach(b => { bullNum++; bullLines.push(`${bullNum}. [${ctx}] ${b}`); });
        } else {
            bullLines.push(`-- [${ctx}] (no existing bullets — generate 2–3 strong power statement bullets)`);
        }
    });
    const bullStr = bullLines.join('\n');

    const userMessage =
`You are an elite resume writer. Tailor this resume specifically for the role below.

JOB POSTING:
${jobCtx}

KEY SKILLS THIS ROLE REQUIRES: ${kwStr}

GOLDEN RULES — FOLLOW EXACTLY:
- NO PERIODS: Do not end any bullet or summary sentence with a period
- NO "I" OR "ME": Summary must be written without first-person pronouns ("Software Engineering student with..." not "I am...")
- SUMMARY: Exactly 3 lines. Line 1 = who the candidate is + most relevant strength for THIS role. Line 2 = top 3 technical strengths (mirror job posting vocabulary). Line 3 = key soft skill or value they bring. No clichés like "results-driven" or "passionate about"
- BULLETS: Strong action verb first (Spearheaded, Managed, Analyzed, etc). ≤22 words. Follow: [Action Verb] + [Quantifiable Task] + [Specific Result/Impact]. Preserve all numbers/metrics exactly. Do NOT invent facts
- BULLET COUNT: 3–5 bullets for highly relevant jobs, exactly 2 for less relevant. EVERY job must have bullets — generate new ones for any job marked "(no existing bullets)"
- Output ONLY the structured result below, nothing else
${atsResult && atsResult.missingRequired.length ? `
KEYWORD GAP (previous score: ${atsResult.overall}%) — Naturally weave these MISSING required keywords into the output without inventing facts: ${atsResult.missingRequired.join(', ')}${atsResult.missingPreferred.length ? `\nAlso try to include: ${atsResult.missingPreferred.slice(0, 8).join(', ')}` : ''}` : ''}

ALL JOBS (generate bullets for every one):
${jobList}

OUTPUT FORMAT:
SUMMARY: <3-line summary — no periods, no I/Me>
BULLETS:
1. [Job Title at Company] <bullet — no period at end>
2. [Job Title at Company] <bullet — no period at end>
(label every bullet with its job; generate fresh bullets for any job marked "no existing bullets")

${resumeData.summary ? `CURRENT SUMMARY:\n${resumeData.summary}\n` : ''}BULLETS TO REWRITE:
${bullStr}`;

    const apiKey = getApiKey();
    if (!apiKey) throw new Error('No Groq API key set');

    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type':  'application/json',
        },
        body: JSON.stringify({
            model:       GROQ_MODEL,
            max_tokens:  2048,
            temperature: 0.2,
            messages:    [{ role: 'user', content: userMessage }],
        }),
    });

    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Groq API ${resp.status}: ${body}`);
    }

    const data = await resp.json();
    const raw  = data.choices?.[0]?.message?.content || '';
    console.log('[Groq] raw output:', raw.slice(0, 300));

    // Parse summary — strip trailing periods and first-person starts
    const sumMatch = raw.match(/SUMMARY:\s*(.+?)(?=\nBULLETS?|\n\n|$)/is);
    if (sumMatch) {
        let s = sumMatch[1].trim()
            .replace(/\.\s*$/, '')                          // strip trailing period
            .replace(/^I\s+(am|have|bring|offer)\b/i, ''); // strip leading "I am/have..."
        if (s.length > 20) resumeData.summary = s;
    }

    // Parse bullets — save backups first so a bad parse can't lose content
    const bulletBackups = new Map(resumeData.experience.map(j => [j, [...j.bullets]]));
    resumeData.experience.forEach(j => j.bullets = []);

    const bullSection = raw.match(/BULLETS?:\s*([\s\S]+)/i)?.[1] || raw;
    const lines = bullSection.split('\n')
        .map(l => l.trim())
        .filter(l => /^\d+[.)]\s+\S/.test(l));

    lines.forEach(line => {
        const tagMatch = line.match(/^\d+[.)]\s+\[(.+?)\]\s+(.*)/);
        if (!tagMatch) return;
        const [, ctx, text] = tagMatch;
        const job = resumeData.experience.find(j =>
            ctx.toLowerCase().includes(j.role.toLowerCase()) ||
            ctx.toLowerCase().includes((j.company || '').toLowerCase())
        );
        if (job && text.trim().length > 10) {
            // Strip trailing period from each bullet
            job.bullets.push(text.trim().replace(/\.\s*$/, ''));
        }
    });

    // Safety net: if any job ended up with 0 bullets, restore from backup
    resumeData.experience.forEach(j => {
        if (j.bullets.length === 0) {
            const backup = bulletBackups.get(j);
            if (backup && backup.length > 0) j.bullets = backup;
        }
    });
}

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
        job.bullets.forEach((b, bi) => bulletRefs.push({ ji, bi, text: b, ctx: `${job.role} at ${job.company}` }))
    );

    const parts = [];
    if (resumeData.summary) {
        parts.push(`SUMMARY:\n${resumeData.summary}`);
    }
    if (bulletRefs.length) {
        parts.push(`BULLETS:\n${bulletRefs.map((b, i) => `${i + 1}. [${b.ctx}] ${b.text}`).join('\n')}`);
    }
    if (!parts.length) return;

    const prompt =
        `You are a resume writer. Select and rewrite only the most relevant bullets for a role requiring: ${kwStr}.\n\n` +
        `Rules:\n` +
        `- SUMMARY: 2 sentences, professional, include relevant keywords.\n` +
        `- BULLETS: action verb start, ≤22 words each, keep all numbers/metrics. Include [Company] context tag.\n` +
        `- Output ONLY the rewritten content in this exact format:\n` +
        `SUMMARY: <rewritten summary>\n` +
        `BULLETS:\n1. [Company Name] <bullet>\n2. [Company Name] <bullet>\n...\n\n` +
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

    // Parse bullets — clear existing then map by context
    const bullSection = raw.match(/BULLETS?:\s*([\s\S]+)/i)?.[1] || raw;
    const lines = bullSection.split('\n')
        .map(l => l.trim())
        .filter(l => /^\d+[.)]\s+\S/.test(l));

    resumeData.experience.forEach(j => j.bullets = []);
    lines.forEach(line => {
        const match = line.match(/^\d+[.)]\s+\[(.*?)\]\s+(.*)/);
        if (!match) return;
        const [_, context, text] = match;
        const job = resumeData.experience.find(j => `${j.role} at ${j.company}`.includes(context) || context.includes(j.company));
        if (job && text.length > 10) job.bullets.push(text.trim());
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
        const hasDash    = /[—–\-]/.test(line);

        if (dm) {
            // Line contains a date range → this is the role line
            if (cur) jobs.push(cur);
            const withoutDate = line.replace(DATE_RANGE_RE, '').trim();
            // Role may be "Role — Company" or just "Role"
            const parts = withoutDate.split(/\s+[—–\-]\s+|\s*[—–]\s*/).map(s => s.trim()).filter(Boolean);
            cur = {
                role:     parts[0] || '',
                company:  pendingCo ? pendingCo.name : (parts[1] || ''),
                location: pendingCo ? pendingCo.loc  : (parts[2] || ''),
                dates:    dm[0].trim(),
                bullets:  [],
            };
            pendingCo = null;
        } else if (hasDash && !isBullet && !cur?.bullets?.length) {
            // Company — Location header (no date, no bullets yet) → store for next role line
            const dashIdx = line.search(/[—–\-]/);
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
    // Matches "Expected May 2028", "May 2028", "Expected 2028", etc.
    const EXPECTED_DATE_RE = /\b(?:Expected\s+)?(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\b|\bExpected\s+\d{4}\b/i;
    const degs = []; let cur = null;
    for (const rawLine of lines) {
        const line = rawLine.trim(); if (!line) continue;
        const dm = line.match(DATE_RANGE_RE) || line.match(EXPECTED_DATE_RE) || line.match(/\b(19|20)\d{2}\b/);
        if (dm) {
            if (cur && (cur.school || cur.degree)) degs.push(cur);
            const dateStr = dm[0];
            // Remove the date and any trailing dash, then split by em-dash to get school + degree
            const withoutDate = line.replace(dateStr, '').replace(/\s*[—–\-]\s*$/, '').trim();
            const parts = withoutDate.split(/\s*[—–]\s*/).map(s => s.trim()).filter(Boolean);
            // Detect whether the first part is a school name or a degree word
            const firstIsDegree = parts[0] && /^(bachelor|master|associate|doctor|phd|bs|ms|ba|ma|mba)\b/i.test(parts[0]);
            cur = {
                school: firstIsDegree ? (parts[1] || '') : (parts[0] || ''),
                degree: firstIsDegree ? (parts[0] || '') : (parts[1] || ''),
                dates:  dateStr,
            };
        } else if (cur) {
            if (!cur.school) cur.school = line; else if (!cur.degree) cur.degree = line;
        } else { cur = { school: line, degree: '', dates: '' }; }
    }
    if (cur && (cur.school || cur.degree)) degs.push(cur);
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
    // Engineering & dev
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
    // Cloud & infra
    'cloud computing','cloud infrastructure','aws','google cloud','azure',
    'kubernetes','docker','containerization','infrastructure as code','terraform',
    'serverless','lambda','ec2','s3','rds','devops','site reliability','sre',
    // Data & analytics
    'sql','nosql','postgresql','mysql','mongodb','redis','elasticsearch',
    'data warehouse','data lake','etl','spark','hadoop','airflow','dbt',
    'tableau','power bi','looker','google analytics','a/b testing',
    // Business & ops
    'project management','program management','cross-functional','stakeholder management',
    'customer success','customer experience','account management','relationship management',
    'digital marketing','social media','content marketing','seo','sem','paid media',
    'salesforce','crm','erp','jira','confluence','slack',
    // Finance & compliance
    'financial analysis','financial modeling','budget management','p&l',
    'risk management','compliance','regulatory','audit','kyc','aml','cip',
    // People
    'team leadership','people management','performance management','talent acquisition',
    'change management','strategic planning','executive communication',
];

function extractKeywords(jobDesc) {
    const lc = jobDesc.toLowerCase();
    const freq = {};
    for (const w of lc.replace(/[^a-z0-9+#.\-\s]/g, ' ').split(/\s+/)) {
        if (w.length > 2 && !STOP_WORDS.has(w)) freq[w] = (freq[w] || 0) + 1;
    }
    // Detect multi-word phrases first (they take priority over constituent words)
    const detectedPhrases = TECH_PHRASES.filter(p => lc.includes(p));
    const phraseWords = new Set(detectedPhrases.flatMap(p => p.split(' ')));

    // Take top 40 single words, excluding words already covered by a phrase
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
        // Scan all occurrences for the strongest signal
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
    const d = document.createElement('div'); d.className = 'r-exp-item';
    const hdr = document.createElement('div'); hdr.className = 'r-exp-header';
    const role = document.createElement('span'); role.className = 'r-exp-role'; role.textContent = job.role || '';
    const dates = document.createElement('span'); dates.className = 'r-exp-dates'; dates.textContent = job.dates || '';
    hdr.append(role, dates);
    d.appendChild(hdr);

    if (job.company || job.location) {
        const sub = document.createElement('div'); sub.className = 'r-exp-subheader';
        const co = document.createElement('span'); co.className = 'r-exp-company'; co.textContent = job.company || '';
        const loc = document.createElement('span'); loc.className = 'r-exp-location'; loc.textContent = job.location || '';
        sub.append(co, loc);
        d.appendChild(sub);
    }

    if (job.bullets?.length) {
        const ul = document.createElement('ul'); ul.className = 'r-bullets';
        job.bullets.forEach(b => { const li = document.createElement('li'); li.textContent = b; ul.appendChild(li); });
        d.appendChild(ul);
    }
    return d;
}

function buildEduItem(edu) {
    const d = document.createElement('div'); d.className = 'r-edu-item';
    // Row 1: School name (bold, left) | Dates (right)
    const hdr = document.createElement('div'); hdr.className = 'r-edu-header';
    const sch = document.createElement('span'); sch.className = 'r-edu-degree'; sch.textContent = edu.school || edu.degree || '';
    const dates = document.createElement('span'); dates.className = 'r-edu-dates'; dates.textContent = edu.dates || '';
    hdr.append(sch, dates);
    d.appendChild(hdr);
    // Row 2: Degree name (smaller, below) — only if both fields are present
    if (edu.degree && edu.school) {
        const deg = document.createElement('div'); deg.className = 'r-edu-school'; deg.textContent = edu.degree;
        d.appendChild(deg);
    }
    return d;
}

// ── ATS SCORER ────────────────────────────────────────────────────────────────

// Soft-match: checks exact + common plural/singular/verb variants
function kwMatch(kw, text) {
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${esc}\\b`, 'i').test(text)) return true;
    // Strip trailing 's'/'es'/'ing'/'ed'/'er' and retry
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

    // Weight: required = 2x, preferred = 1x (mirrors most ATS weighted scoring)
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
        missingRequired: reqMiss,   // full list — used by iteration 2
        missingPreferred: prefMiss, // full list
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
    if (!apiKey)      { alert('Enter and save your Groq API key first.'); return; }
    if (!masterText)  { alert('Please paste your master resume first.'); return; }
    if (!jobDescText) { alert('Please paste the job description first.'); return; }

    isGenerating = true;
    dom.generateBtn.disabled = true;
    dom.generateBtn.classList.add('generating');
    dom.generateBtn.textContent = 'Generating…';
    dom.pdfBtn.disabled = true;
    dom.atsPanel.classList.remove('visible');

    // Cache keywords per job description — re-extract only if job desc changed
    if (!session || session.jobDescText !== jobDescText) {
        session = { keywords: null, jobDescText, atsResult: null, resumeData: null, count: 0 };
    }
    const isRefinement = session.count > 0 && session.atsResult && session.resumeData;
    initProgress(isRefinement ? 4 : 8);

    try {
        if (!session.keywords) {
            log('Analyzing job description…');
            session.keywords = extractKeywords(jobDescText);
        }
        const { keywords } = session;

        // Use stored tailored data on refinements; parse fresh on first run
        const resumeData = isRefinement
            ? session.resumeData
            : (log('Parsing master resume…'), parseResume(masterText));

        if (isRefinement) {
            // Subsequent clicks — single targeted pass on already-tailored data
            log(`Refining (score was ${session.atsResult.overall}%) — targeting gaps…`);
            await tailorWithGroq(resumeData, keywords, jobDescText, session.atsResult);
        } else {
            // First time — 2 automatic passes
            log('Pass 1 · Initial tailoring…');
            await tailorWithGroq(resumeData, keywords, jobDescText, null);

            log('Pass 1 · Scoring…');
            const pass1 = scoreATS(resumeData, keywords);
            log(`Pass 1 score: ${pass1.overall}% — running pass 2…`);

            log('Pass 2 · Targeting keyword gaps…');
            await tailorWithGroq(resumeData, keywords, jobDescText, pass1);
        }

        log('Reordering skills by relevance…');
        resumeData.skills = reorderSkills(resumeData.skills, keywords.all);

        log('Rendering resume…');
        renderResume(resumeData);

        log('Scoring ATS match…');
        const atsResult = scoreATS(resumeData, keywords);
        renderATS(atsResult);
        session.atsResult = atsResult;
        session.resumeData = resumeData;
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
        dom.generateBtn.textContent = session?.count > 0 ? 'Refine Resume' : 'Generate Tailored Resume';
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
    session = null;
    dom.generateBtn.textContent = 'Generate Tailored Resume';
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
dom.fileJob.addEventListener('change',   () => handleFileUpload(dom.fileJob,    dom.jobDescInput));
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleGenerate(); });
document.getElementById('download-template-btn').addEventListener('click', handleDownloadTemplate);

dom.resetBtn.disabled = false;

dom.apiKeySave.addEventListener('click', () => {
    const val = dom.apiKeyInput.value.trim();
    if (val) setApiKey(val);
});
dom.apiKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') dom.apiKeySave.click(); });

// ── INIT ──────────────────────────────────────────────────────────────────────

updateApiKeyStatus();
