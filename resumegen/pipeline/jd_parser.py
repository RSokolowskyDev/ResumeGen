import re
import time
import httpx
from typing import Optional

# Health tracking — in memory, resets on restart
_health = {
    "gemini":     {"fails": 0, "last_fail": 0.0},
    "groq":       {"fails": 0, "last_fail": 0.0},
    "cerebras":   {"fails": 0, "last_fail": 0.0},
    "openrouter": {"fails": 0, "last_fail": 0.0},
    "claude":     {"fails": 0, "last_fail": 0.0},
}

PRIORITY = ["gemini", "groq", "cerebras", "openrouter", "claude"]
COOLDOWN = 60
MAX_FAILS = 2

GEMINI_MODELS = [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
]

PROVIDER_CONFIGS = {
    "groq": {
        "url": "https://api.groq.com/openai/v1/chat/completions",
        "model": "llama-3.3-70b-versatile",
    },
    "cerebras": {
        "url": "https://api.cerebras.ai/v1/chat/completions",
        "model": "llama3.3-70b",
    },
    "openrouter": {
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "model": "meta-llama/llama-3.3-70b-instruct",
    },
}

JD_EXTRACTION_PROMPT = """
Extract key information from this job description.
Return in exactly this format using these exact section
headers. Nothing else — no explanation, no preamble,
no trailing text.

## Role
job title only

## Company
company name only

## Seniority
one of: entry / mid / senior / lead / staff / principal

## Required
skill one, skill two, skill three, skill four

## Preferred
skill one, skill two, skill three

## Responsibilities
one responsibility per line as plain text
another responsibility as plain text

Job description:
{text}
"""


def pretrim(raw_text: str) -> str:
    SKIP_PHRASES = [
        "equal opportunity", "we are an",
        "benefits include", "401k",
        "health insurance", "dental", "vision",
        "pto", "our story", "about us",
        "we were founded", "our mission",
        "salary range", "compensation",
        "background check", "authorized to work",
        "drug test", "affirmative action",
        "disabilities", "veteran"
    ]
    lines = raw_text.split('\n')
    kept = [
        l for l in lines
        if not any(p in l.lower() for p in SKIP_PHRASES)
    ]
    return '\n'.join(kept)[:3000]


def _healthy_providers(keys: dict) -> list:
    now = time.time()
    result = []
    for name in PRIORITY:
        if not keys.get(name):
            continue
        h = _health[name]
        if h["fails"] >= MAX_FAILS:
            elapsed = now - h["last_fail"]
            if elapsed < COOLDOWN:
                remaining = int(COOLDOWN - elapsed)
                print(f"[JD] Skipping {name} (cooldown {remaining}s)")
                continue
            else:
                h["fails"] = 0
        result.append(name)
    return result


def _record_fail(provider: str):
    _health[provider]["fails"] += 1
    _health[provider]["last_fail"] = time.time()


def _record_success(provider: str):
    _health[provider]["fails"] = 0


def get_health_status(keys: dict) -> dict:
    now = time.time()
    status = {}
    healthy = _healthy_providers(keys)
    next_provider = healthy[0] if healthy else "python"
    for name in PRIORITY:
        h = _health[name]
        has_key = bool(keys.get(name))
        in_cooldown = (
            h["fails"] >= MAX_FAILS
            and (now - h["last_fail"]) < COOLDOWN
        )
        cooldown_remaining = max(0, int(
            COOLDOWN - (now - h["last_fail"])
        )) if in_cooldown else 0
        status[name] = {
            "has_key": has_key,
            "fails": h["fails"],
            "in_cooldown": in_cooldown,
            "cooldown_remaining": cooldown_remaining,
            "is_next": name == next_provider,
        }
    status["python"] = {
        "has_key": True,
        "fails": 0,
        "in_cooldown": False,
        "cooldown_remaining": 0,
        "is_next": next_provider == "python",
    }
    return status


def parse_provider_response(text: str) -> dict:
    def extract(section: str) -> str:
        pattern = rf'## {section}\n(.*?)(?=\n## |\Z)'
        m = re.search(pattern, text, re.DOTALL | re.IGNORECASE)
        return m.group(1).strip() if m else ""

    def to_list(s: str) -> list:
        return [x.strip() for x in s.split(',') if x.strip()]

    def to_lines(s: str) -> list:
        return [l.strip() for l in s.split('\n') if l.strip()]

    return {
        "role": extract("Role"),
        "company": extract("Company"),
        "seniority": extract("Seniority") or "mid",
        "required": to_list(extract("Required")),
        "preferred": to_list(extract("Preferred")),
        "responsibilities": to_lines(extract("Responsibilities")),
    }


async def call_gemini(text: str, key: str) -> dict | None:
    prompt = JD_EXTRACTION_PROMPT.format(text=text)
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 512
        }
    }
    for model in GEMINI_MODELS:
        try:
            url = (
                "https://generativelanguage.googleapis.com"
                f"/v1beta/models/{model}"
                f":generateContent?key={key}"
            )
            async with httpx.AsyncClient() as client:
                resp = await client.post(url, json=body, timeout=30)
            if resp.status_code == 200:
                data = resp.json()
                content = (
                    data["candidates"][0]["content"]["parts"][0]["text"]
                )
                print(f"[JD] Gemini model: {model}")
                result = parse_provider_response(content)
                result["raw_text"] = text
                return result
            elif resp.status_code in (503, 429, 404):
                print(
                    f"[JD] {model} returned {resp.status_code}, "
                    f"trying next Gemini model..."
                )
                continue
        except Exception as e:
            print(f"[JD] {model} error: {e}")
            continue
    return None


async def call_openai_compatible(
    text: str, key: str, provider: str
) -> dict | None:
    cfg = PROVIDER_CONFIGS[provider]
    prompt = JD_EXTRACTION_PROMPT.format(text=text)
    body = {
        "model": cfg["model"],
        "messages": [
            {
                "role": "system",
                "content": "You are a job description parser. Follow the format exactly."
            },
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.1,
        "max_tokens": 512,
    }
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json"
    }
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                cfg["url"], json=body, headers=headers, timeout=30
            )
        if resp.status_code == 200:
            content = resp.json()["choices"][0]["message"]["content"]
            result = parse_provider_response(content)
            result["raw_text"] = text
            return result
        else:
            print(f"[JD] {provider} returned {resp.status_code}")
            return None
    except Exception as e:
        print(f"[JD] {provider} error: {e}")
        return None


async def call_claude(text: str, key: str) -> dict | None:
    prompt = JD_EXTRACTION_PROMPT.format(text=text)
    body = {
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 512,
        "messages": [{"role": "user", "content": prompt}]
    }
    headers = {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
    }
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://api.anthropic.com/v1/messages",
                json=body, headers=headers, timeout=30
            )
        if resp.status_code == 200:
            content = resp.json()["content"][0]["text"]
            result = parse_provider_response(content)
            result["raw_text"] = text
            return result
        else:
            print(f"[JD] Claude returned {resp.status_code}")
            return None
    except Exception as e:
        print(f"[JD] Claude error: {e}")
        return None


def parse_python_fallback(pre_trimmed: str) -> dict:
    try:
        import spacy
        nlp = spacy.load("en_core_web_sm")
    except Exception:
        return {
            "role": "", "company": "",
            "seniority": "mid",
            "required": [], "preferred": [],
            "responsibilities": [],
            "raw_text": pre_trimmed
        }

    doc = nlp(pre_trimmed[:2000])

    REQUIRED_ANCHORS = [
        r'required qualifications?',
        r'requirements?:',
        r'must.have',
        r"what you'?ll? bring",
        r'minimum qualifications?',
        r'basic qualifications?',
        r'what we need',
    ]
    PREFERRED_ANCHORS = [
        r'preferred qualifications?',
        r'nice.to.have',
        r'bonus points?',
        r'ideally',
        r'desired qualifications?',
        r"what'?s? a plus",
    ]
    RESP_ANCHORS = [
        r'responsibilities:',
        r"what you'?ll? do",
        r'you will:',
        r'your role:',
        r'day.to.day',
        r'duties:',
        r'in this role',
    ]

    def extract_section(text, anchors):
        for anchor in anchors:
            m = re.search(anchor, text, re.IGNORECASE)
            if not m:
                continue
            after = text[m.end():]
            lines = after.split('\n')
            items = []
            for line in lines:
                line = line.strip()
                if not line:
                    break
                if re.match(r'^[A-Z][A-Z\s]{3,}:?$', line):
                    break
                clean = re.sub(r'^[-•*\d.)\s]+', '', line).strip()
                if clean:
                    items.append(clean)
            if items:
                return items
        return []

    required = extract_section(pre_trimmed, REQUIRED_ANCHORS)
    preferred = extract_section(pre_trimmed, PREFERRED_ANCHORS)
    responsibilities = extract_section(pre_trimmed, RESP_ANCHORS)

    role = ""
    role_pattern = re.compile(
        r'(senior|junior|lead|staff|principal)?\s*'
        r'[A-Z][a-z]+ (?:Engineer|Developer|Analyst|'
        r'Manager|Designer|Scientist|Specialist|'
        r'Coordinator|Director|Representative|'
        r'Technician|Consultant)',
        re.IGNORECASE
    )
    rm = role_pattern.search(pre_trimmed[:500])
    if rm:
        role = rm.group(0).strip()

    company = ""
    for ent in doc.ents:
        if ent.label_ == "ORG":
            company = ent.text
            break

    seniority = "mid"
    for level in ["principal", "staff", "lead", "senior", "director", "junior", "entry"]:
        if level in pre_trimmed.lower():
            seniority = level
            break

    if not required:
        chunks = [
            chunk.text for chunk in doc.noun_chunks
            if 2 < len(chunk.text) < 40
            and not chunk.root.is_stop
        ]
        seen = set()
        for c in chunks:
            cl = c.lower()
            if cl not in seen:
                seen.add(cl)
                required.append(c)
            if len(required) >= 20:
                break

    return {
        "role": role,
        "company": company,
        "seniority": seniority,
        "required": required,
        "preferred": preferred,
        "responsibilities": responsibilities,
        "raw_text": pre_trimmed
    }


async def parse_jd(raw_text: str, keys: dict = None) -> dict:
    if keys is None:
        keys = {}

    pre_trimmed = pretrim(raw_text)
    healthy = _healthy_providers(keys)

    for provider in healthy:
        try:
            if provider == "gemini":
                result = await call_gemini(pre_trimmed, keys["gemini"])
            elif provider == "claude":
                result = await call_claude(pre_trimmed, keys["claude"])
            else:
                result = await call_openai_compatible(
                    pre_trimmed, keys[provider], provider
                )

            if result and result.get("required"):
                _record_success(provider)
                from pipeline.nlp_utils import enrich_jd
                result = enrich_jd(result)
                print(f"[JD] Parsed via {provider}")
                print(
                    f"[JD] {len(result['required'])} required, "
                    f"{len(result['preferred'])} preferred keywords"
                )
                return result
            else:
                print(f"[JD] {provider} returned empty result")
                _record_fail(provider)

        except Exception as e:
            print(f"[JD] {provider} failed: {e}")
            _record_fail(provider)

    print("[JD] All providers failed or no keys set")
    print("[JD] Using Python fallback")
    result = parse_python_fallback(pre_trimmed)
    from pipeline.nlp_utils import enrich_jd
    result = enrich_jd(result)
    print(f"[JD] Python extracted {len(result['required'])} keywords")
    return result
