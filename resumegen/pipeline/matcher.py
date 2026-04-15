from rapidfuzz import fuzz

# Soft skills inferred from JD keyword triggers (no resume match required)
SOFT_SKILL_TRIGGERS = {
    "communication":      "Communication",
    "oral communication": "Oral Communication",
    "written communication": "Written Communication",
    "leadership":         "Leadership",
    "team":               "Teamwork",
    "collaboration":      "Collaboration",
    "detail":             "Detail-Oriented",
    "problem.solv":       "Problem Solving",
    "critical think":     "Critical Thinking",
    "time management":    "Time Management",
    "organization":       "Organization",
    "multitask":          "Multitasking",
    "coaching":           "Coaching",
    "training":           "Training",
    "customer service":   "Customer Service",
    "safety":             "Safety Awareness",
    "quality assurance":  "Quality Assurance",
    "documentation":      "Documentation",
    "analytical":         "Analytical Thinking",
    "adaptab":            "Adaptability",
    "initiative":         "Initiative",
    "self.motivated":     "Self-Motivated",
}

ROLE_IMPLIED_SKILLS = {
    "software engineer": [
        "Git", "REST API", "Agile", "Linux", "Docker"],
    "data analyst": [
        "Excel", "SQL", "Data Visualization", "Python"],
    "data scientist": [
        "Python", "SQL", "Statistics", "Machine Learning"],
    "it support": [
        "TCP/IP", "DNS", "DHCP", "Active Directory",
        "Windows", "Troubleshooting"],
    "devops": [
        "Linux", "Docker", "CI/CD", "Git", "Kubernetes"],
    "project manager": [
        "Agile", "Scrum", "Jira", "Excel", "Stakeholder"],
    "marketing": [
        "Google Analytics", "Excel", "CRM", "SEO"],
    "sales": [
        "CRM", "Salesforce", "Excel", "Communication"],
    "customer service": [
        "CRM", "Communication", "Excel", "Empathy"],
    "network engineer": [
        "TCP/IP", "DNS", "DHCP", "Cisco", "Firewall"],
    "security analyst": [
        "SIEM", "Firewall", "Vulnerability", "Compliance"],
}


def select_jobs(experience: list, jd: dict) -> list:
    if not experience:
        return []

    scored = []
    for job in experience:
        job_text = (
            job.get('title', '') + ' '
            + ' '.join(job.get('bullets', []))
        ).lower()
        score = 0

        # Use only original LLM keywords for job scoring (not NLP-expanded list)
        core_required = jd.get('core_required', jd.get('required', []))
        for kw in core_required:
            if fuzz.partial_ratio(kw.lower(), job_text) > 75:
                score += 3
        for kw in jd.get('preferred', []):
            if fuzz.partial_ratio(kw.lower(), job_text) > 75:
                score += 1

        if job.get('is_current'):
            score += 5
        years = job.get('years_ago', 99)
        if years < 2:
            score += 3
        elif years < 4:
            score += 1

        scored.append((job, score))

    current = [
        (j, s) for j, s in scored if j.get('is_current')
    ]
    others = sorted(
        [(j, s) for j, s in scored if not j.get('is_current')],
        key=lambda x: x[1],
        reverse=True
    )

    selected = []
    if current:
        selected.append(current[0][0])
    for job, score in others[:3]:
        if len(selected) >= 4:
            break
        selected.append(job)

    if len(others) >= 3 and len(selected) == 4:
        pass
    elif len(others) >= 3:
        third_score = others[2][1]
        if (len(others) > 3
                and others[3][1] >= third_score * 0.85):
            if len(selected) < 4:
                selected.append(others[3][0])

    from pipeline.parser import parse_date
    from datetime import datetime

    def sort_key(job):
        dt = parse_date(job.get('start_date', ''))
        return dt if dt else datetime.min

    selected.sort(key=sort_key, reverse=True)

    print(f"[Matcher] {len(selected)} jobs selected")
    return selected


def select_skills(skills_dict: dict, jd: dict,
                  experience: list = None) -> list:
    from pipeline.nlp_utils import (
        infer_skills_from_bullets, score_skill_against_jd
    )

    all_skills = []
    for category_skills in skills_dict.values():
        all_skills.extend(category_skills)

    jd_text     = jd.get('raw_text', '')
    jd_keywords = jd.get('nlp_keywords', []) + jd.get('required', []) + jd.get('preferred', [])

    # ── 1. Score hard skills from resume ────────────────────
    role = jd.get('role', '').lower()
    implied = []
    best_match = 0
    for role_key, role_skills in ROLE_IMPLIED_SKILLS.items():
        s = fuzz.ratio(role, role_key)
        if s > best_match:
            best_match = s
            if s > 70:
                implied = role_skills

    scored = []
    for skill in all_skills:
        sl = skill.lower()
        score = score_skill_against_jd(skill, jd_keywords, jd_text)

        # Boost for implied role skills
        for imp in implied:
            if fuzz.ratio(sl, imp.lower()) > 80:
                score += 3

        scored.append((skill, score))

    scored.sort(key=lambda x: x[1], reverse=True)
    hard_skills = [s for s, sc in scored if sc > 0][:10]

    # ── 2. Infer skills from experience bullets ──────────────
    bullets_text = ""
    if experience:
        for job in experience:
            bullets_text += " ".join(job.get('bullets', [])) + " "
            bullets_text += job.get('title', '') + " "

    inferred = infer_skills_from_bullets(bullets_text, jd_text)

    # ── 3. Merge: hard skills first, then inferred (no dupes) ─
    existing_lower = {s.lower() for s in hard_skills}
    combined = list(hard_skills)
    inferred_added = 0
    for skill in inferred:
        if skill.lower() not in existing_lower and inferred_added < 4:
            combined.append(skill)
            existing_lower.add(skill.lower())
            inferred_added += 1

    # ── 4. If still under 8, pad with unscored resume skills ──
    if len(combined) < 8:
        unscored = [s for s, sc in scored if sc == 0]
        for s in unscored:
            if len(combined) >= 8:
                break
            if s.lower() not in existing_lower:
                combined.append(s)
                existing_lower.add(s.lower())

    _STOPWORDS = {
        'a', 'an', 'the', 'and', 'or', 'of', 'in', 'for',
        'to', 'with', 'by', 'on', 'at', 'as', 'is', 'be',
    }

    def _trim_skill(s: str) -> str:
        words = s.strip().split()
        if len(words) <= 3:
            return s
        # Try 3 words; if it ends on a stopword, use 4 instead
        three = words[:3]
        if three[-1].lower() in _STOPWORDS:
            return ' '.join(words[:4])
        return ' '.join(three)

    seen2 = set()
    final = []
    for s in combined:
        s = _trim_skill(s)
        sl = s.lower()
        if sl not in seen2:
            seen2.add(sl)
            final.append(s)

    print(f"[Matcher] {len(final)} skills "
          f"({len(hard_skills)} resume, {inferred_added} inferred)")
    return final[:14]
