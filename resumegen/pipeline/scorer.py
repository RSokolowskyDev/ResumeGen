import re


def score_ats(tailored: dict, jd: dict) -> dict:
    parts = [
        tailored.get('summary', ''),
        ' '.join(tailored.get('skills', []))
    ]
    for job in tailored.get('experience', []):
        parts.append(job.get('title', ''))
        parts.append(job.get('company', ''))
        parts.extend(job.get('bullets', []))
    for edu in tailored.get('education', []):
        parts.append(edu.get('degree', ''))
        parts.append(edu.get('institution', ''))
        parts.extend(edu.get('details', []))
    for cert in tailored.get('certifications', []):
        parts.append(cert.get('name', ''))
        parts.append(cert.get('issuer', ''))
    resume_text = ' '.join(parts)

    def stem(w: str) -> str:
        for suffix in ['ing', 'ed', 'er', 'es', 's']:
            if w.endswith(suffix) and len(w) > len(suffix) + 2:
                return w[:-len(suffix)]
        return w

    def keyword_matches(kw: str, text: str) -> bool:
        kw = kw.strip()
        if not kw:
            return False
        # 1. Direct word boundary match
        if re.search(rf'\b{re.escape(kw)}\b', text, re.IGNORECASE):
            return True
        # 2. Substring for longer phrases
        if len(kw) > 3 and kw.lower() in text.lower():
            return True
        # 3. Stemmed match
        kw_stem = stem(kw.lower())
        for word in text.lower().split():
            if stem(word) == kw_stem:
                return True
        # 4. Semantic match via WordNet + spaCy vectors + domain implications
        try:
            from pipeline.nlp_utils import semantic_keyword_match
            if semantic_keyword_match(kw, text, sim_threshold=0.82):
                return True
        except Exception:
            pass
        return False

    # Score against core LLM-parsed keywords only, not NLP-expanded noise
    score_required  = jd.get('core_required', jd.get('required', []))
    score_preferred = jd.get('preferred', [])

    matched_req,  missing_req  = [], []
    matched_pref, missing_pref = [], []

    for kw in score_required:
        (matched_req if keyword_matches(kw, resume_text) else missing_req).append(kw)

    for kw in score_preferred:
        (matched_pref if keyword_matches(kw, resume_text) else missing_pref).append(kw)

    total_weight   = len(score_required) * 2 + len(score_preferred)
    matched_weight = len(matched_req)    * 2 + len(matched_pref)
    score = (matched_weight / total_weight * 100) if total_weight > 0 else 0.0

    return {
        "score":             round(score, 1),
        "matched_required":  matched_req,
        "missing_required":  missing_req,
        "matched_preferred": matched_pref,
        "missing_preferred": missing_pref,
        "total_keywords":    len(score_required) + len(score_preferred),
        "matched_keywords":  len(matched_req) + len(matched_pref),
    }
