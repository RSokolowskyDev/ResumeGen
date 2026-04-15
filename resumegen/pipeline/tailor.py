import time
import httpx
from pipeline.model import generate as local_generate


# ── API provider configs (sync calls, tailor runs in thread pool) ──

TAILOR_PROVIDER_CONFIGS = {
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

GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"]


def _call_gemini_sync(prompt: str, system: str, key: str) -> str | None:
    body = {
        "contents": [{"parts": [{"text": (system + "\n\n" + prompt) if system else prompt}]}],
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": 512}
    }
    for model in GEMINI_MODELS:
        try:
            url = (
                f"https://generativelanguage.googleapis.com"
                f"/v1beta/models/{model}:generateContent?key={key}"
            )
            resp = httpx.post(url, json=body, timeout=30)
            if resp.status_code == 200:
                return resp.json()["candidates"][0]["content"]["parts"][0]["text"]
            elif resp.status_code in (503, 429, 404):
                continue
        except Exception as e:
            print(f"[Tailor] Gemini {model} error: {e}")
            continue
    return None


def _call_openai_compatible_sync(
    prompt: str, system: str, key: str, provider: str
) -> str | None:
    cfg = TAILOR_PROVIDER_CONFIGS[provider]
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    body = {
        "model": cfg["model"],
        "messages": messages,
        "temperature": 0.3,
        "max_tokens": 512,
    }
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json"
    }
    try:
        resp = httpx.post(cfg["url"], json=body, headers=headers, timeout=30)
        if resp.status_code == 200:
            return resp.json()["choices"][0]["message"]["content"]
        else:
            print(f"[Tailor] {provider} returned {resp.status_code}")
            return None
    except Exception as e:
        print(f"[Tailor] {provider} error: {e}")
        return None


def _call_claude_sync(prompt: str, system: str, key: str) -> str | None:
    messages = [{"role": "user", "content": prompt}]
    body = {
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 512,
        "messages": messages,
    }
    if system:
        body["system"] = system
    headers = {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
    }
    try:
        resp = httpx.post(
            "https://api.anthropic.com/v1/messages",
            json=body, headers=headers, timeout=30
        )
        if resp.status_code == 200:
            return resp.json()["content"][0]["text"]
        else:
            print(f"[Tailor] Claude returned {resp.status_code}")
            return None
    except Exception as e:
        print(f"[Tailor] Claude error: {e}")
        return None


def smart_generate(
    prompt: str,
    system: str,
    keys: dict,
    max_new_tokens: int = 256,
) -> str:
    """
    Try healthy API providers first (one call = one turn in the shared
    rotation). Falls back to local Qwen model if all providers fail or
    no keys are set.
    """
    # Import health tracking from jd_parser so both share the same state
    from pipeline.jd_parser import (
        _healthy_providers, _record_success, _record_fail
    )

    healthy = _healthy_providers(keys)

    for provider in healthy:
        t = time.time()
        result = None
        try:
            if provider == "gemini":
                result = _call_gemini_sync(prompt, system, keys["gemini"])
            elif provider == "claude":
                result = _call_claude_sync(prompt, system, keys["claude"])
            else:
                result = _call_openai_compatible_sync(
                    prompt, system, keys[provider], provider
                )
        except Exception as e:
            print(f"[Tailor] {provider} exception: {e}")

        if result and result.strip():
            _record_success(provider)
            print(f"[Tailor] Used {provider} ({time.time()-t:.1f}s)")
            return _strip_markdown(result.strip())
        else:
            print(f"[Tailor] {provider} returned empty, trying next...")
            _record_fail(provider)

    # All providers failed or no keys — use local model
    print("[Tailor] Using local model")
    return local_generate(
        prompt,
        system=system,
        max_new_tokens=max_new_tokens,
        temperature=0.3
    )


def _strip_markdown(text: str) -> str:
    import re
    # Strip local model <think> blocks
    text = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL)
    # Strip Gemini-style thinking preamble: if response starts with a
    # reasoning paragraph before the first bullet, drop everything before it
    first_bullet = re.search(r'(?m)^[-•*]', text)
    if first_bullet and first_bullet.start() > 0:
        preamble = text[:first_bullet.start()]
        # Only strip if preamble looks like internal reasoning, not content
        reasoning_signals = [
            r'this is not', r'i will', r"i'll", r'rewriting',
            r'the role', r'the position', r'based on', r'as requested',
        ]
        if any(re.search(p, preamble.lower()) for p in reasoning_signals):
            text = text[first_bullet.start():]
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    text = re.sub(r'\*(.+?)\*', r'\1', text)
    text = re.sub(r'^#{1,6}\s+', '', text, flags=re.MULTILINE)
    return text.strip()


# ── Helpers ──

def compress_bullets(bullets: list) -> list:
    FILLER = [
        "utilized ", "leveraged ",
        "assisted with ", "helped to ",
        "was responsible for ",
        "worked on ", "was involved in ",
        "responsible for ", "supported ",
        "participated in ", "contributed to "
    ]
    result = []
    for bullet in bullets:
        b = bullet.strip()
        for filler in FILLER:
            if b.lower().startswith(filler):
                b = b[len(filler):].strip()
                b = b[0].upper() + b[1:] if b else b
                break
        words = b.split()
        result.append(' '.join(words[:20]))
    return result


def parse_bullets(response: str, original: list, limit: int = 4) -> list:
    SKIP_STARTS = [
        'here', 'rewritten', 'note', 'below',
        'sure', 'of course', 'the following',
        'these are', 'i have', "i've", 'i will',
        'i need', 'i should', 'i can', 'i am',
        'this is', 'this role', 'this job',
        'the role', 'the job', 'the position',
        'let me', 'okay', 'alright', 'great',
    ]
    # Gemini internal reasoning patterns — whole-line filters
    REASONING_PATTERNS = [
        r'this is not',
        r'these are bullets',
        r'i will rewrite',
        r'i\'ll rewrite',
        r'rewriting (for|these|the)',
        r'for the (role|position|job)',
        r'based on (the|your|this)',
        r'as (requested|instructed|asked)',
        r'here are (the|your|\d)',
    ]
    lines = []
    for l in response.strip().split('\n'):
        l = l.strip().lstrip('-•*·123456789.) ').strip()
        if not l or len(l) < 8:
            continue
        l_low = l.lower()
        if any(l_low.startswith(s) for s in SKIP_STARTS):
            continue
        if ':' in l[:15]:
            continue
        import re
        if any(re.search(p, l_low) for p in REASONING_PATTERNS):
            continue
        lines.append(l)

    # Fallback to originals if LLM failed
    if not lines:
        return original[:limit]
    
    # Do NOT pad missing bullets with original unrewritten ones anymore.
    # The master resume is huge, so we only want the condensed tailored ones.
    return lines[:limit]


def calc_years(job: dict) -> int:
    from pipeline.parser import parse_date
    from datetime import datetime
    dt = parse_date(job.get('start_date', ''))
    if not dt:
        return 3
    delta = datetime.now() - dt
    return max(1, int(delta.days / 365.25))


# ── Incremental helpers (called one at a time from app.py) ──

def tailor_summary(
    master: dict,
    jd: dict,
    selected_jobs: list,
    selected_skills: list,
    keys: dict = None,
    bridge_map: dict = None,
) -> str:
    """Generate just the summary. Returns the summary string."""
    if keys is None:
        keys = {}

    role   = jd.get('role', 'this role')
    years  = calc_years(selected_jobs[0]) if selected_jobs else 3

    SUMMARY_SYSTEM = (
        "You are a professional resume writer. "
        "Write concise impactful resume content. "
        "Return only plain text. "
        "Never use formatting characters such as "
        "asterisks, pound signs, dashes, or bullet points. "
        "Never start a sentence with I. "
        "Return only the requested content, "
        "no explanation, no preamble, no sign-off."
    )

    summary_prompt = (
        f"Write a 2-3 sentence professional summary "
        f"for a {role} position.\n"
        f"Plain text only. No labels, no headers, "
        f"no formatting characters, no explanation.\n\n"
        f"Candidate: {master['contact'].get('name', '')}\n"
        f"Current role: "
        f"{selected_jobs[0].get('title', '') if selected_jobs else ''}\n"
        f"Years experience: {years}\n"
        f"Top skills: {', '.join(selected_skills[:6])}\n"
        f"Keywords to include naturally: "
        f"{', '.join(jd.get('required', [])[:6])}\n"
        f"Reference summary: {master.get('summary', '')}\n\n"
        f"Return only the summary paragraph, nothing else."
    )

    t = time.time()
    response = smart_generate(
        summary_prompt, system=SUMMARY_SYSTEM,
        keys=keys, max_new_tokens=150,
    )
    summary = response.strip()
    if not summary or len(summary.split()) < 15:
        summary = master.get('summary', '')
    print(f"[Tailor] Summary — {len(summary.split())} words — {time.time()-t:.1f}s")
    return summary


def tailor_job(
    job: dict,
    jd: dict,
    keys: dict = None,
    bridge_map: dict = None,
) -> dict:
    """Tailor bullets for a single job. Returns the job dict with new bullets."""
    if keys is None:
        keys = {}

    role   = jd.get('role', 'this role')
    kw_str = ', '.join(jd.get('required', [])[:5])

    is_current = job.get('is_current', False)
    tense      = "present tense" if is_current else "past tense"
    tense_ex   = ("e.g. 'Manages', 'Builds'" if is_current
                  else "e.g. 'Managed', 'Built', 'Increased'")

    # Build bridge context string if a bridge_map was provided
    from pipeline.inference_engine import format_bridge_context
    bridge_text = format_bridge_context(bridge_map) if bridge_map else ""

    bridge_instruction = ""
    if bridge_text:
        bridge_instruction = (
            "Use the provided Semantic Bridge Map to translate the "
            "user's past experiences into the terminology of the new "
            "industry while preserving all original metrics. "
        )

    BULLET_SYSTEM = (
        "You are a professional resume writer. "
        "Rewrite resume bullets using the Google XYZ framework. "
        "Each bullet: [action verb] [result] [metric] [method]. "
        "Use varied strong action verbs — never repeat the same verb twice. "
        f"All bullets MUST be in {tense} ({tense_ex}). "
        "Preserve ALL real metrics and numbers from the original exactly. "
        "Never invent metrics not in the original. "
        "You may infer reasonable industry-standard context "
        "(e.g. a bank follows federal regulations, a sales role has quotas) "
        "but never introduce specific tools, software, platforms, or "
        "technologies not explicitly named in the original bullets. "
        f"{bridge_instruction}"
        "Return one bullet per line as plain text. "
        "Never use formatting characters such as "
        "asterisks, pound signs, hyphens, or numbers. "
        "Never add dashes before bullets. "
        "Return only the bullets, nothing else. "
        "No explanation, no preamble, no sign-off, "
        "no labels, no blank lines between bullets."
    )

    compressed      = compress_bullets(job.get('bullets', []))
    compressed_text = '\n'.join(compressed)

    bridge_block = f"\n\n{bridge_text}" if bridge_text else ""

    target_count = 4 if is_current else 3

    bullet_prompt = (
        f"Select the {target_count} most relevant resume bullets from below and rewrite them for a "
        f"{role} role using the XYZ framework.\n"
        f"Each bullet: [action verb] [result] [metric] [method].\n"
        f"Preserve all numbers and metrics exactly as given.\n"
        f"Never invent metrics. Never add specific tools or technologies not in the originals.\n"
        f"Industry-standard context for the role/company type is allowed.\n"
        f"ALL bullets must use {tense} ({tense_ex}). Maximum 25 words per bullet.\n"
        f"Naturally emphasize these keywords "
        f"where relevant: {kw_str}\n\n"
        f"Role: {job.get('title', '')} "
        f"at {job.get('company', '')}\n\n"
        f"Original bullets "
        f"(contain real metrics to preserve):\n"
        f"{compressed_text}"
        f"{bridge_block}\n\n"
        f"Return only the rewritten bullets, "
        f"one per line, nothing else."
    )

    max_tokens = max(128, len(job.get('bullets', [])) * 50)

    t = time.time()
    response = smart_generate(
        bullet_prompt, system=BULLET_SYSTEM,
        keys=keys, max_new_tokens=max_tokens,
    )
    tailored_bullets = parse_bullets(response, job.get('bullets', []), limit=target_count)
    print(
        f"[Tailor] {job.get('title', '')} at "
        f"{job.get('company', '')} — "
        f"{len(tailored_bullets)} bullets — "
        f"{time.time()-t:.1f}s"
    )

    return {
        "company":    job.get("company", ""),
        "title":      job.get("title", ""),
        "location":   job.get("location", ""),
        "start_date": job.get("start_date", ""),
        "end_date":   job.get("end_date", ""),
        "is_current": job.get("is_current", False),
        "bullets":    tailored_bullets
    }


# ── Main tailor function (kept for compatibility) ──

def tailor_resume(
    master: dict,
    jd: dict,
    selected_jobs: list,
    selected_skills: list,
    keys: dict = None,
    bridge_map: dict = None,
) -> dict:
    if keys is None:
        keys = {}

    role   = jd.get('role', 'this role')
    kw_str = ', '.join(jd.get('required', [])[:5])
    years  = calc_years(selected_jobs[0]) if selected_jobs else 3

    SUMMARY_SYSTEM = (
        "You are a professional resume writer. "
        "Write concise impactful resume content. "
        "Return only plain text. "
        "Never use formatting characters such as "
        "asterisks, pound signs, dashes, or bullet points. "
        "Never start a sentence with I. "
        "Return only the requested content, "
        "no explanation, no preamble, no sign-off."
    )

    summary_prompt = (
        f"Write a 2-3 sentence professional summary "
        f"for a {role} position.\n"
        f"Plain text only. No labels, no headers, "
        f"no formatting characters, no explanation.\n\n"
        f"Candidate: {master['contact'].get('name', '')}\n"
        f"Current role: "
        f"{selected_jobs[0].get('title', '') if selected_jobs else ''}\n"
        f"Years experience: {years}\n"
        f"Top skills: {', '.join(selected_skills[:6])}\n"
        f"Keywords to include naturally: "
        f"{', '.join(jd.get('required', [])[:6])}\n"
        f"Reference summary: {master.get('summary', '')}\n\n"
        f"Return only the summary paragraph, nothing else."
    )

    t = time.time()
    summary_response = smart_generate(
        summary_prompt,
        system=SUMMARY_SYSTEM,
        keys=keys,
        max_new_tokens=150,
    )
    summary = summary_response.strip()
    if not summary or len(summary.split()) < 15:
        summary = master.get('summary', '')
    print(
        f"[Tailor] Summary — "
        f"{len(summary.split())} words — "
        f"{time.time()-t:.1f}s"
    )

    from pipeline.inference_engine import format_bridge_context
    bridge_text = format_bridge_context(bridge_map) if bridge_map else ""

    bridge_instruction = ""
    if bridge_text:
        bridge_instruction = (
            "Use the provided Semantic Bridge Map to translate the "
            "user's past experiences into the terminology of the new "
            "industry while preserving all original metrics. "
        )

    BULLET_SYSTEM = (
        "You are a professional resume writer. "
        "Rewrite resume bullets using the Google XYZ framework. "
        "Each bullet: [action verb] [result] [metric] [method]. "
        "Use varied strong action verbs — never repeat the same verb twice. "
        "Preserve ALL real metrics and numbers from the original exactly. "
        "Never invent metrics not in the original. "
        f"{bridge_instruction}"
        "Return one bullet per line as plain text. "
        "Never use formatting characters such as "
        "asterisks, pound signs, hyphens, or numbers. "
        "Never add dashes before bullets. "
        "Return only the bullets, nothing else. "
        "No explanation, no preamble, no sign-off, "
        "no labels, no blank lines between bullets."
    )

    tailored_experience = []
    for job in selected_jobs:
        compressed      = compress_bullets(job.get('bullets', []))
        compressed_text = '\n'.join(compressed)
        tense = "present tense" if job.get('is_current') else "past tense"

        bridge_block = f"\n\n{bridge_text}" if bridge_text else ""

        bullet_prompt = (
            f"Rewrite these resume bullets for a "
            f"{role} role using the XYZ framework.\n"
            f"Each bullet: [action verb] [result] [metric] [method].\n"
            f"Preserve all numbers and metrics exactly as given.\n"
            f"Never invent metrics.\n"
            f"Use {tense}. Maximum 25 words per bullet.\n"
            f"Naturally emphasize these keywords "
            f"where relevant: {kw_str}\n\n"
            f"Role: {job.get('title', '')} "
            f"at {job.get('company', '')}\n\n"
            f"Original bullets "
            f"(contain real metrics to preserve):\n"
            f"{compressed_text}"
            f"{bridge_block}\n\n"
            f"Return only the rewritten bullets, "
            f"one per line, nothing else."
        )

        max_tokens = max(128, len(job.get('bullets', [])) * 50)

        t = time.time()
        response = smart_generate(
            bullet_prompt,
            system=BULLET_SYSTEM,
            keys=keys,
            max_new_tokens=max_tokens,
        )
        tailored_bullets = parse_bullets(
            response, job.get('bullets', [])
        )
        print(
            f"[Tailor] {job.get('title', '')} at "
            f"{job.get('company', '')} — "
            f"{len(tailored_bullets)} bullets — "
            f"{time.time()-t:.1f}s"
        )

        tailored_experience.append({
            "company":    job.get("company", ""),
            "title":      job.get("title", ""),
            "location":   job.get("location", ""),
            "start_date": job.get("start_date", ""),
            "end_date":   job.get("end_date", ""),
            "is_current": job.get("is_current", False),
            "bullets":    tailored_bullets
        })

    return {
        "contact":        master["contact"],
        "summary":        summary,
        "experience":     tailored_experience,
        "skills":         selected_skills,
        "education":      master.get("education", []),
        "certifications": master.get("certifications", [])
    }
