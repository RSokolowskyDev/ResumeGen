"""
NLP utilities for keyword extraction and skill inference.
Uses spaCy md (word vectors) + NLTK WordNet for semantic matching.
"""
import re

# ── Domain implications: things no library will know ──────────
# If resume contains any value in the list, the key skill is implied.
# Keep this SHORT — only for genuine domain-knowledge implications
# that word similarity can't capture.
DOMAIN_IMPLICATIONS = {
    "MS Windows":      ["excel", "outlook", "word", "ms office", "microsoft office",
                        "sharepoint", "powerpoint", "pc", "desktop", "windows"],
    "Microsoft Office":["excel", "word", "outlook", "powerpoint", "ms office",
                        "microsoft office", "office suite"],
    "CRM":             ["salesforce", "hubspot", "zoho", "pipedrive", "crm"],
    "Bilingual":       ["bilingual", "spanish", "english and spanish",
                        "spanish and english"],
}

# ── Soft skill signals from bullet text ────────────────────────
BULLET_SKILL_SIGNALS = {
    "Customer Service":    r"customer|client|member|patron|guest|service",
    "Communication":       r"communicat|present|bilingual|report|brief|pitch",
    "Leadership":          r"\bled\b|lead|manag|supervis|direct|oversee|head",
    "Team Collaboration":  r"\bteam\b|collaborat|cross.functional|partner",
    "Training & Coaching": r"train|coach|onboard|mentor|taught|instruct",
    "Data Analysis":       r"analyz|analys|data|metrics|reporting|trend|statistic",
    "Sales":               r"\bsold\b|sales|revenue|conver|lead generation|quota",
    "CRM":                 r"salesforce|crm|hubspot|zoho|pipedrive",
    "Compliance":          r"complian|audit|regulat|kyc|aml|cip|federal|policy",
    "Documentation":       r"document|record|log|report|maintain.*record|track",
    "Quality Assurance":   r"quality|accuracy|audit|inspect|qa\b|qc\b|standard",
    "Problem Solving":     r"resolv|troubleshoot|diagnos|debug|fix|identif.*issue",
    "Project Management":  r"project|timeline|deadline|coordinat|schedul|deliverable",
    "Bilingual":           r"bilingual|spanish|english.*spanish|spanish.*english",
    "Safety Awareness":    r"safety|hazard|osha|ppe|protective|incident",
    "Process Improvement": r"improv|streamlin|optimiz|efficienc|reduc.*time|automat",
    "Customer Retention":  r"retent|loyalt|churn|renew|satisf",
    "Financial Acumen":    r"budget|financ|revenue|cost|p&l|forecast|reconcil",
    "Technical Support":   r"technical support|help.?desk|ticket|it support|troubleshoot",
    "Inventory Management":r"inventor|stock|supply|warehouse|asset",
    "Scheduling":          r"schedul|calendar|appointment|dispatch",
}

# Hard skills — infer only if JD also mentions them
HARD_SKILL_SIGNALS = {
    "Microsoft Excel":  r"excel|spreadsheet",
    "Microsoft Office": r"microsoft office|ms office|word.*excel|office suite",
    "Salesforce":       r"salesforce",
    "Python":           r"\bpython\b",
    "SQL":              r"\bsql\b|database query",
    "AWS":              r"\baws\b|amazon web services",
    "JavaScript":       r"\bjavascript\b|\bjs\b",
    "Google Analytics": r"google analytics",
    "QuickBooks":       r"quickbooks",
    "Adobe":            r"\badobe\b|photoshop|illustrator|indesign",
    "AutoCAD":          r"autocad|cad design",
    "Bilingual Spanish":r"bilingual|spanish",
    "MS Windows":       r"excel|outlook|word|ms office|microsoft office|"
                        r"sharepoint|teams|powerpoint|\bpc\b|desktop|windows",
}

# JD section anchors
JD_SKILL_ANCHORS = [
    r'key competencies?', r'skills?.{0,20}:',
    r'qualifications?', r'requirements?',
    r'what you.{0,10}bring', r'what we.{0,10}need',
    r'you have', r'you will have',
    r'experience with', r'proficient in', r'knowledge of',
]

# Noise patterns to filter from extracted keywords
NOISE_PATTERNS = [
    r'^\d+\s*(lb|lbs|pound|kg)',
    r'^(stand|sit|walk|climb|kneel|crawl|stoop|reach|lift|carry|balance)',
    r'^(ability to|must be able|required to)',
    r'^(race|color|sex|gender|religion|national origin|disability|veteran)',
    r'^(equal opportunity|eeo|eeoc|affirmative)',
    r'^(drug|background check|authorized)',
    r'^[a-z]$',
    r'^\d+$',
    r'\bnbsp\b',
    r'^(and|or|the|a|an|in|on|at|to|for|of|with|by)$',
]

PREFIX_STRIP = {
    'ability to', 'years of', 'experience in', 'knowledge of',
    'proficient in', 'familiar with', 'work with', 'working with',
    'experience with', 'including', 'such as',
}

# ── Singletons ─────────────────────────────────────────────────
_nlp_md   = None
_nlp_sm   = None
_stop     = None


def _get_nlp_md():
    global _nlp_md
    if _nlp_md is None:
        try:
            import spacy
            _nlp_md = spacy.load("en_core_web_md")
        except Exception:
            _nlp_md = _get_nlp_sm()
    return _nlp_md


def _get_nlp_sm():
    global _nlp_sm
    if _nlp_sm is None:
        try:
            import spacy
            _nlp_sm = spacy.load("en_core_web_sm")
        except Exception:
            _nlp_sm = None
    return _nlp_sm


def _get_stopwords():
    global _stop
    if _stop is None:
        try:
            from nltk.corpus import stopwords
            _stop = set(stopwords.words('english'))
        except Exception:
            _stop = {
                'a','an','the','and','or','but','in','on','at','to','for',
                'of','with','by','from','is','are','was','were','be','been',
                'being','have','has','had','do','does','did','will','would',
                'could','should','may','might','shall','can','need','this',
                'that','these','those','we','our','you','your','they',
                'their','it','its','as','such',
            }
    return _stop


# ── WordNet synonym expansion ──────────────────────────────────

def _wordnet_synonyms(word: str, pos=None) -> set[str]:
    """Return synonyms + related lemmas from WordNet for a word."""
    try:
        from nltk.corpus import wordnet as wn
        synsets = wn.synsets(word, pos=pos) if pos else wn.synsets(word)
        result = set()
        for syn in synsets[:4]:  # cap to avoid noise
            for lemma in syn.lemmas():
                name = lemma.name().replace('_', ' ').lower()
                result.add(name)
                # Also add antonym-free derivationally related forms
                for related in lemma.derivationally_related_forms():
                    result.add(related.name().replace('_', ' ').lower())
        return result
    except Exception:
        return set()


def expand_keyword(kw: str) -> set[str]:
    """
    Return kw + all WordNet synonyms/related forms for each word in kw.
    Multi-word phrases: expand each content word separately.
    """
    stop = _get_stopwords()
    words = kw.lower().split()
    expanded = {kw.lower()}

    for w in words:
        if w in stop or len(w) < 3:
            continue
        syns = _wordnet_synonyms(w)
        expanded.update(syns)
        # Add compound expansions: replace the word in the phrase
        for syn in syns:
            if ' ' not in syn:
                new_phrase = kw.lower().replace(w, syn)
                expanded.add(new_phrase)

    return expanded


# ── spaCy vector similarity ────────────────────────────────────

def _vec_similarity(a: str, b: str) -> float:
    """Cosine similarity between two phrases using spaCy md vectors."""
    nlp = _get_nlp_md()
    if nlp is None:
        return 0.0
    try:
        da = nlp(a)
        db = nlp(b)
        if not da.has_vector or not db.has_vector:
            return 0.0
        return da.similarity(db)
    except Exception:
        return 0.0


# ── Main semantic match ────────────────────────────────────────

def semantic_keyword_match(kw: str, resume_text: str,
                            sim_threshold: float = 0.82) -> bool:
    """
    Return True if kw matches resume_text via:
    1. Direct substring / word match
    2. WordNet synonym expansion
    3. spaCy vector similarity against resume phrases
    4. Domain implication table (last resort for things libraries can't know)
    """
    kl  = kw.lower().strip()
    rt  = resume_text.lower()

    # 1. Direct match
    if re.search(rf'\b{re.escape(kl)}\b', rt):
        return True

    # 2. WordNet expansion — check if any synonym appears in resume
    expanded = expand_keyword(kl)
    for variant in expanded:
        if len(variant) > 2 and re.search(rf'\b{re.escape(variant)}\b', rt):
            return True

    # 3. spaCy vector similarity against resume noun phrases
    nlp = _get_nlp_md()
    if nlp and len(kl) > 3:
        doc = nlp(rt[:2000])
        kw_doc = nlp(kl)
        if kw_doc.has_vector:
            for chunk in doc.noun_chunks:
                if chunk.has_vector:
                    sim = kw_doc.similarity(chunk)
                    if sim >= sim_threshold:
                        return True

    # 4. Domain implications
    for implied_kw, signals in DOMAIN_IMPLICATIONS.items():
        if kl == implied_kw.lower() or implied_kw.lower() in kl:
            if any(re.search(rf'\b{re.escape(s)}\b', rt) for s in signals):
                return True

    return False


# ── Keyword extraction from JD ────────────────────────────────

def extract_jd_keywords(jd_text: str) -> list[str]:
    """Pull skill/keyword phrases from raw JD text."""
    stop = _get_stopwords()
    nlp  = _get_nlp_sm()
    keywords = []

    # 1. Lines after section anchors
    for anchor in JD_SKILL_ANCHORS:
        m = re.search(anchor, jd_text, re.IGNORECASE)
        if not m:
            continue
        block = jd_text[m.end():m.end() + 600]
        for line in block.split('\n'):
            clean = re.sub(r'^[-•*\d.)\s]+', '', line).strip()
            if 3 < len(clean) < 60:
                keywords.append(clean)

    # 2. spaCy noun chunks
    if nlp:
        doc = nlp(jd_text[:3000])
        for chunk in doc.noun_chunks:
            text = chunk.text.strip()
            words = [w for w in text.split() if w.lower() not in stop]
            if 1 <= len(words) <= 4 and len(text) > 3:
                keywords.append(text)
        for ent in doc.ents:
            if ent.label_ in ("ORG", "PRODUCT", "GPE", "WORK_OF_ART"):
                if 2 < len(ent.text) < 40:
                    keywords.append(ent.text)

    # 3. NLTK bigrams
    try:
        import nltk
        from nltk import word_tokenize, pos_tag

        skill_lines = []
        in_section = False
        for line in jd_text.split('\n'):
            low = line.lower()
            if any(re.search(a, low) for a in JD_SKILL_ANCHORS):
                in_section = True
            if in_section:
                skill_lines.append(line)
            if len(skill_lines) > 40:
                break

        block  = ' '.join(skill_lines)
        tokens = word_tokenize(block.lower())
        tagged = pos_tag(tokens)
        for (w1, t1), (w2, t2) in zip(tagged, tagged[1:]):
            if ((t1.startswith('NN') and t2.startswith('NN')) or
                    (t1.startswith('JJ') and t2.startswith('NN'))):
                phrase = f"{w1} {w2}"
                if w1 not in stop and w2 not in stop and len(phrase) > 5:
                    keywords.append(phrase)
    except Exception:
        pass

    # Deduplicate and filter noise
    seen   = set()
    result = []
    for kw in keywords:
        kw  = kw.strip().strip('.,;:()')
        low = kw.lower()
        if not low or len(kw) < 3 or len(kw) > 50 or low in seen:
            continue
        if any(re.search(p, low) for p in NOISE_PATTERNS):
            continue
        for prefix in PREFIX_STRIP:
            if low.startswith(prefix + ' '):
                kw  = kw[len(prefix):].strip()
                low = kw.lower()
                break
        if low and len(kw) >= 3 and low not in seen:
            seen.add(low)
            result.append(kw)

    print(f"[NLP] Extracted {len(result)} JD keywords")
    return result


# ── Skill inference from bullets ──────────────────────────────

def infer_skills_from_bullets(bullets_text: str, jd_text: str) -> list[str]:
    """
    Scan resume bullets for implied skills.
    Soft skills: infer freely. Hard skills: only if JD also mentions them.
    """
    bt  = bullets_text.lower()
    jdt = jd_text.lower()
    inferred = []

    for label, pattern in BULLET_SKILL_SIGNALS.items():
        if re.search(pattern, bt):
            inferred.append(label)

    for label, pattern in HARD_SKILL_SIGNALS.items():
        if re.search(pattern, bt) and re.search(pattern, jdt):
            inferred.append(label)

    return inferred


# ── Skill scoring against JD ──────────────────────────────────

def score_skill_against_jd(skill: str, jd_keywords: list[str],
                            jd_text: str) -> int:
    """Score a skill against JD keywords using fuzzy + semantic matching."""
    from rapidfuzz import fuzz
    skill_low = skill.lower()
    score = 0

    for kw in jd_keywords:
        r = fuzz.partial_ratio(skill_low, kw.lower())
        if r > 85:
            score += 8
        elif r > 70:
            score += 4

    if skill_low in jd_text.lower():
        score += 5

    # Semantic boost
    if semantic_keyword_match(skill, jd_text, sim_threshold=0.85):
        score += 6

    return score


# ── JD enrichment ─────────────────────────────────────────────

def truncate_skill(skill: str, max_words: int = 4) -> str:
    words = skill.strip().split()
    return ' '.join(words[:max_words])


def enrich_jd(parsed: dict) -> dict:
    """Augment parsed JD with NLP keywords. Preserves core_required."""
    raw = parsed.get('raw_text', '')
    if not raw:
        return parsed

    parsed['core_required'] = list(parsed.get('required', []))

    nlp_kws = extract_jd_keywords(raw)
    parsed['nlp_keywords'] = nlp_kws

    existing    = {k.lower() for k in parsed.get('required', [])}
    new_required = list(parsed.get('required', []))
    for kw in nlp_kws:
        if kw.lower() not in existing and len(kw.split()) <= 3:
            existing.add(kw.lower())
            new_required.append(kw)

    parsed['required'] = new_required
    return parsed
