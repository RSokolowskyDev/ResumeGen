"""
inference_engine.py — Semantic Skill Mapping

Sits between jd_parser (step 1) and tailor (step 3).
Takes the parsed JD and the master resume, asks an LLM to find
"Semantic Proxies" for every required skill that does NOT have a
direct keyword match in the resume, and returns a bridge_map that
tailor.py injects into its bullet-rewriting prompts.

Pipeline order:
    1. jd_parser.parse_jd()          → jd_json
    2. inference_engine.generate_bridge_map()  → bridge_map
    3. tailor.tailor_job(…, bridge_map=…)      → tailored bullets
"""

import json
import re
import time
import httpx

# ── Reuse health tracking from jd_parser so every module
#    shares the same provider rotation and cooldown state. ──
from pipeline.jd_parser import (
    _healthy_providers,
    _record_success,
    _record_fail,
    GEMINI_MODELS,
    PROVIDER_CONFIGS,
)


# ────────────────────────────────────────────────────────────
# System prompt — tells the LLM exactly what we want back
# ────────────────────────────────────────────────────────────

BRIDGE_SYSTEM = (
    "You are a career strategist. Bridge the gap between JD skills and the resume. "
    "Find 'Semantic Proxies' for JD skills lacking direct matches. "
    "Use 'Context' or 'Inference Tags' to justify proxies. "
    "Return ONLY JSON: {'m': [{'t': 'JD Term', 's': 'Resume Source', 'j': 'Reason (<12 words)'}]}"
)


# ────────────────────────────────────────────────────────────
# Public API
# ────────────────────────────────────────────────────────────

async def generate_bridge_map(
    jd_json: dict,
    master_resume_json: dict,
    keys: dict,
) -> dict:
    """
    Compare JD required skills against the master resume and return a
    bridge_map of semantic proxies for skills that lack a direct match.

    Parameters
    ----------
    jd_json : dict
        Output of ``jd_parser.parse_jd()``.  Must contain ``"required"``
        (list of skill strings) and optionally ``"preferred"``.
    master_resume_json : dict
        Parsed master resume.  Each job in ``"experience"`` may include
        ``"context"`` (str) and ``"inference_tags"`` (list[str]) alongside
        the standard ``"title"``, ``"company"``, ``"bullets"`` fields.
    keys : dict
        Provider API keys (same shape as everywhere else in the app).

    Returns
    -------
    dict
        ``{"mappings": [{"jd_term": …, "resume_source": …, "justification": …}, …]}``
        Returns an empty mappings list if all providers fail.
    """
    required = jd_json.get("required", [])
    preferred = jd_json.get("preferred", [])
    if not required:
        print("[Inference] No required skills in JD — skipping bridge map")
        return {"mappings": []}

    # ── Build a compact representation of the resume for the prompt ──
    resume_snapshot = []
    for job in master_resume_json.get("experience", []):
        entry = {
            "title": job.get("title", ""),
            "company": job.get("company", ""),
            "bullets": job.get("bullets", []),
        }
        # Include context and inference tags when available
        # (these come from the high-density JSON resume format)
        if job.get("context"):
            entry["context"] = job["context"]
        if job.get("inference_tags"):
            entry["inference_tags"] = job["inference_tags"]
        resume_snapshot.append(entry)

    # Also include skills section if present
    skills_section = master_resume_json.get("skills", {})

    user_prompt = (
        "JD REQ:\n"
        f"{json.dumps(required)}\n\n"
        "JD PREF:\n"
        f"{json.dumps(preferred)}\n\n"
        "RESUME:\n"
        f"{json.dumps(resume_snapshot)}\n\n"
        "SKILLS:\n"
        f"{json.dumps(skills_section)}\n\n"
        "Return mapping JSON."
    )

    # ── Try each healthy provider in priority order ──
    healthy = _healthy_providers(keys)

    for provider in healthy:
        t = time.time()
        try:
            raw = None
            if provider == "gemini":
                raw = await _call_gemini(
                    user_prompt, BRIDGE_SYSTEM, keys["gemini"]
                )
            elif provider == "claude":
                raw = await _call_claude(
                    user_prompt, BRIDGE_SYSTEM, keys["claude"]
                )
            else:
                raw = await _call_openai_compatible(
                    user_prompt, BRIDGE_SYSTEM, keys[provider], provider
                )

            if not raw:
                print(f"[Inference] {provider} returned empty")
                _record_fail(provider)
                continue

            bridge_map = _parse_json_response(raw)
            if bridge_map is not None:
                _record_success(provider)
                n = len(bridge_map.get("m", []))
                print(
                    f"[Inference] Bridge map via {provider} — "
                    f"{n} mappings — {time.time()-t:.1f}s"
                )
                return bridge_map
            else:
                print(f"[Inference] {provider} returned invalid JSON")
                _record_fail(provider)

        except Exception as e:
            print(f"[Inference] {provider} failed: {e}")
            _record_fail(provider)

    print("[Inference] All providers failed — returning empty bridge map")
    return {"mappings": []}


def format_bridge_context(bridge_map: dict) -> str:
    """
    Render the bridge_map into a plain-text block that can be injected
    directly into tailor.py prompts.

    Returns an empty string when there are no mappings so the prompt
    stays clean.
    """
    mappings = bridge_map.get("m", [])
    if not mappings:
        return ""

    lines = [
        "SEMANTIC BRIDGE MAP — use these translations to rewrite bullets "
        "in the terminology of the target role while preserving all "
        "original metrics:"
    ]
    for m in mappings:
        # Fallback to old keys just in case, but use compact keys primarily
        term = m.get('t', m.get('jd_term', ''))
        source = m.get('s', m.get('resume_source', ''))
        just = m.get('j', m.get('justification', ''))
        
        if term and source:
            lines.append(f"  • \"{term}\" ← maps to \"{source}\" ({just})")
    
    return "\n".join(lines)


# ────────────────────────────────────────────────────────────
# Provider calls  (async, same pattern as jd_parser.py)
# ────────────────────────────────────────────────────────────

async def _call_gemini(
    prompt: str, system: str, key: str
) -> str | None:
    """Try each Gemini model in GEMINI_MODELS order."""
    body = {
        "contents": [
            {"parts": [{"text": f"{system}\n\n{prompt}"}]}
        ],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 2048,
            "responseMimeType": "application/json",
        },
    }
    for model in GEMINI_MODELS:
        try:
            url = (
                "https://generativelanguage.googleapis.com"
                f"/v1beta/models/{model}"
                f":generateContent?key={key}"
            )
            async with httpx.AsyncClient() as client:
                resp = await client.post(url, json=body, timeout=45)
            if resp.status_code == 200:
                data = resp.json()
                text = (
                    data["candidates"][0]["content"]["parts"][0]["text"]
                )
                print(f"[Inference] Gemini model: {model}")
                return text
            elif resp.status_code in (503, 429, 404):
                print(
                    f"[Inference] {model} returned {resp.status_code}, "
                    f"trying next model..."
                )
                continue
        except Exception as e:
            print(f"[Inference] {model} error: {e}")
            continue
    return None


async def _call_openai_compatible(
    prompt: str, system: str, key: str, provider: str
) -> str | None:
    cfg = PROVIDER_CONFIGS[provider]
    
    # Cerebras model name might be slightly different than groq/openrouter
    model_id = "llama3.3-70b" if provider == "cerebras" else cfg["model"]
    
    body = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.1,
        "max_tokens": 2048,
        "response_format": {"type": "json_object"},
    }
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                cfg["url"], json=body, headers=headers, timeout=45
            )
        if resp.status_code == 200:
            return resp.json()["choices"][0]["message"]["content"]
        else:
            print(f"[Inference] {provider} returned {resp.status_code}")
            return None
    except Exception as e:
        print(f"[Inference] {provider} error: {e}")
        return None


async def _call_claude(
    prompt: str, system: str, key: str
) -> str | None:
    body = {
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 2048,
        "system": system,
        "messages": [{"role": "user", "content": prompt}],
    }
    headers = {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://api.anthropic.com/v1/messages",
                json=body, headers=headers, timeout=45,
            )
        if resp.status_code == 200:
            return resp.json()["content"][0]["text"]
        else:
            print(f"[Inference] Claude returned {resp.status_code}")
            return None
    except Exception as e:
        print(f"[Inference] Claude error: {e}")
        return None


# ────────────────────────────────────────────────────────────
# JSON parsing helper
# ────────────────────────────────────────────────────────────

def _parse_json_response(raw: str) -> dict | None:
    """
    Extract valid JSON from an LLM response, handling markdown fences,
    preamble text, and <think> blocks.
    """
    text = raw.strip()

    # Strip <think> blocks (local models)
    text = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL)

    # Strip markdown code fences
    if "```json" in text:
        text = text.split("```json", 1)[1].split("```", 1)[0].strip()
    elif "```" in text:
        text = text.split("```", 1)[1].split("```", 1)[0].strip()

    # Try direct parse
    try:
        obj = json.loads(text)
        if isinstance(obj, dict) and ("m" in obj or "mappings" in obj):
            return obj
    except json.JSONDecodeError:
        pass

    # Last resort: find the first { … } block
    match = re.search(r'\{.*\}', text, re.DOTALL)
    if match:
        try:
            obj = json.loads(match.group())
            if isinstance(obj, dict) and ("m" in obj or "mappings" in obj):
                return obj
        except json.JSONDecodeError:
            pass

    print(f"[Inference] DEBUG: Invalid JSON raw string: {text[:200]}...")
    return None
