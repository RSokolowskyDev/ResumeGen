import re
from jinja2 import Environment, FileSystemLoader


def sanitize_str(s: str) -> str:
    if not s:
        return ""
    s = re.sub(r'\[cite_start\]', '', s, flags=re.I)
    s = re.sub(r'\[cite:\s*[\d,\s]+\]', '', s, flags=re.I)
    s = re.sub(r'\[cite_end\]', '', s, flags=re.I)
    s = re.sub(r'\*\*(.+?)\*\*', r'\1', s)
    s = re.sub(r'\*(.+?)\*', r'\1', s)
    s = re.sub(r'^#{1,6}\s+', '', s, flags=re.M)
    return s.strip()


def sanitize_dict(obj):
    if isinstance(obj, str):
        return sanitize_str(obj)
    elif isinstance(obj, list):
        return [sanitize_dict(i) for i in obj]
    elif isinstance(obj, dict):
        return {k: sanitize_dict(v) for k, v in obj.items()}
    return obj


def render_resume(tailored: dict, section_order: list) -> str:
    env = Environment(
        loader=FileSystemLoader('templates'),
        autoescape=True
    )
    template = env.get_template('resume.html')
    clean = sanitize_dict(tailored)

    full_html = template.render(
        contact=clean.get('contact', {}),
        summary=clean.get('summary', ''),
        experience=clean.get('experience', []),
        skills=clean.get('skills', []),
        education=clean.get('education', []),
        certifications=clean.get('certifications', []),
        section_order=section_order
    )

    body_match = re.search(
        r'<body[^>]*>(.*?)</body>',
        full_html,
        re.DOTALL
    )
    if body_match:
        return body_match.group(1).strip()
    return full_html
