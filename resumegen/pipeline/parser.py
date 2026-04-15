import re
from datetime import datetime


def sanitize(text: str) -> str:
    text = re.sub(r'\[cite_start\]', '', text, flags=re.I)
    text = re.sub(r'\[cite:\s*[\d,\s]+\]', '', text, flags=re.I)
    text = re.sub(r'\[cite_end\]', '', text, flags=re.I)
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    text = re.sub(r'\*(.+?)\*', r'\1', text)
    text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'\n{3,}', '\n\n', text)
    lines = [l.strip() for l in text.split('\n')]
    return '\n'.join(lines)


def parse_date(date_str: str) -> datetime | None:
    for fmt in ["%B %Y", "%b %Y", "%m/%Y", "%Y"]:
        try:
            return datetime.strptime(date_str.strip(), fmt)
        except ValueError:
            continue
    return None


def calc_years_ago(end_date_str: str, is_current: bool) -> float:
    if is_current:
        return 0.0
    dt = parse_date(end_date_str)
    if not dt:
        return 99.0
    delta = datetime.now() - dt
    return round(delta.days / 365.25, 1)


def parse_resume(text: str) -> dict:
    result = {
        "contact": {
            "name": "", "email": "", "phone": "",
            "location": "", "linkedin": "",
            "github": "", "portfolio": ""
        },
        "summary": "",
        "experience": [],
        "skills": {},
        "education": [],
        "certifications": []
    }

    try:
        # Detect sections before sanitizing so # headers are preserved
        section_pattern = re.compile(
            r'^#\s+([A-Z][A-Z\s]+)$',
            re.MULTILINE
        )
        matches = list(section_pattern.finditer(text))

        sections = {}
        for i, match in enumerate(matches):
            name = match.group(1).strip()
            start = match.end()
            end = (matches[i+1].start()
                   if i+1 < len(matches)
                   else len(text))
            sections[name] = sanitize(text[start:end].strip())

        if "CONTACT" in sections:
            for line in sections["CONTACT"].split('\n'):
                if ':' not in line:
                    continue
                key, _, val = line.partition(':')
                key = key.strip().lower()
                val = val.strip()
                if key == 'name':
                    result['contact']['name'] = val
                elif key == 'email':
                    result['contact']['email'] = val
                elif key == 'phone':
                    result['contact']['phone'] = val
                elif key == 'location':
                    result['contact']['location'] = val
                elif key == 'linkedin':
                    result['contact']['linkedin'] = val
                elif key == 'github':
                    result['contact']['github'] = val
                elif key == 'portfolio':
                    result['contact']['portfolio'] = val

        if "SUMMARY" in sections:
            result['summary'] = sections["SUMMARY"].strip()

        if "EXPERIENCE" in sections:
            result['experience'] = parse_experience(sections["EXPERIENCE"])

        if "SKILLS" in sections:
            result['skills'] = parse_skills(sections["SKILLS"])

        if "EDUCATION" in sections:
            result['education'] = parse_education(sections["EDUCATION"])

        if "CERTIFICATIONS" in sections:
            result['certifications'] = parse_certs(sections["CERTIFICATIONS"])

    except Exception as e:
        print(f"[Parser] Warning: {e}")

    return result


def parse_experience(text: str) -> list:
    jobs = []
    current_job = None
    current_bullet = None

    lines = text.split('\n')
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue

        date_pattern = re.compile(
            r'(\w+\s+\d{4}|\d{4})\s*[-–]\s*'
            r'(\w+\s+\d{4}|\d{4}|[Pp]resent)'
        )

        is_header = '|' in line and not line.startswith('-')

        if is_header:
            if current_bullet and current_job:
                current_job['bullets'].append(current_bullet.strip())
                current_bullet = None
            if current_job:
                jobs.append(current_job)
            parts = [p.strip() for p in line.split('|')]
            current_job = {
                "company": parts[0] if parts else "",
                "title": parts[1] if len(parts) > 1 else "",
                "location": parts[2] if len(parts) > 2 else "",
                "start_date": "",
                "end_date": "",
                "is_current": False,
                "years_ago": 99.0,
                "bullets": []
            }

        elif date_pattern.search(line) and current_job and not line.startswith('-'):
            dm = date_pattern.search(line)
            current_job['start_date'] = dm.group(1)
            end = dm.group(2)
            current_job['is_current'] = (end.lower() == 'present')
            current_job['end_date'] = end
            current_job['years_ago'] = calc_years_ago(
                end, current_job['is_current']
            )

        elif line.startswith('- ') and current_job:
            if current_bullet:
                current_job['bullets'].append(current_bullet.strip())
            current_bullet = line[2:].strip()

        elif (current_bullet is not None
              and current_job is not None
              and not is_header
              and not date_pattern.search(line)):
            current_bullet += ' ' + line.strip()

        i += 1

    if current_bullet and current_job:
        current_job['bullets'].append(current_bullet.strip())
    if current_job:
        jobs.append(current_job)

    return jobs


def _is_valid_skill(s: str) -> bool:
    """Return False for entries that are sentences/durations, not skill names."""
    s = s.strip()
    if not s or len(s) < 2:
        return False
    # Reject if starts with a number (e.g. "2 years as FIRST")
    if re.match(r'^\d', s):
        return False
    # Reject if contains sentence-like patterns
    if re.search(r'\b(year|month|as a|as an|i have|worked|experience in)\b',
                 s, re.IGNORECASE):
        return False
    # Reject overly long entries (sentences, not skill names)
    if len(s.split()) > 5:
        return False
    return True


def parse_skills(text: str) -> dict:
    skills = {}
    for line in text.split('\n'):
        line = line.strip()
        if not line or ':' not in line:
            continue
        category, _, items = line.partition(':')
        skill_list = [
            s.strip()
            for s in items.split(',')
            if _is_valid_skill(s.strip())
        ]
        if skill_list:
            skills[category.strip()] = skill_list
    return skills


def _join_wrapped_pipes(text: str) -> list:
    """Join lines where a header is split across lines (line ends with |)."""
    raw = [l.strip() for l in text.split('\n')]
    joined = []
    i = 0
    while i < len(raw):
        line = raw[i]
        while line.endswith('|') and i + 1 < len(raw):
            i += 1
            line = line + ' ' + raw[i]
        joined.append(line)
        i += 1
    return joined


def parse_education(text: str) -> list:
    edu_list = []
    current = None
    date_pattern = re.compile(
        r'(\w+\s+\d{4}|\d{4})\s*[-–]\s*'
        r'(\w+\s+\d{4}|\d{4}|[Pp]resent)'
    )
    for line in _join_wrapped_pipes(text):
        line = line.strip()
        if not line:
            continue
        if '|' in line and not line.startswith('-'):
            if current:
                edu_list.append(current)
            parts = [p.strip() for p in line.split('|')]
            current = {
                "degree": parts[0] if parts else "",
                "institution": (parts[1] if len(parts) > 1 else ""),
                "location": (parts[2] if len(parts) > 2 else ""),
                "start_date": "",
                "end_date": "",
                "details": []
            }
        elif (date_pattern.search(line)
              and current
              and not line.startswith('-')):
            dm = date_pattern.search(line)
            current['start_date'] = dm.group(1)
            current['end_date'] = dm.group(2)
        elif line.startswith('- ') and current:
            current['details'].append(line[2:].strip())
    if current:
        edu_list.append(current)
    return edu_list


def parse_certs(text: str) -> list:
    certs = []
    lines = [l for l in _join_wrapped_pipes(text) if l.strip()]
    i = 0
    while i < len(lines):
        line = lines[i]
        if '|' in line:
            parts = [p.strip() for p in line.split('|')]
            date = ""
            if i + 1 < len(lines):
                next_line = lines[i+1]
                if '|' not in next_line:
                    date = next_line
                    i += 1
            certs.append({
                "name": parts[0] if parts else "",
                "issuer": (parts[1] if len(parts) > 1 else ""),
                "date": date
            })
        i += 1
    return certs
