from fastapi import FastAPI, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
import uvicorn, webbrowser, threading
import asyncio, json, subprocess, sys, time

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:2222",
        "http://127.0.0.1:2222"
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount(
    "/static",
    StaticFiles(directory="static"),
    name="static"
)

# Global state
MODEL_READY = False
MODEL_STATUS = "loading"


# Request models
class GenerateRequest(BaseModel):
    master_resume: str
    job_description: str
    section_order: List[str] = [
        "summary", "skills", "experience", "education", "certifications"
    ]
    gemini_key: Optional[str] = ""
    groq_key: Optional[str] = ""
    cerebras_key: Optional[str] = ""
    openrouter_key: Optional[str] = ""
    claude_key: Optional[str] = ""


class ValidateKeysRequest(BaseModel):
    gemini_key: Optional[str] = ""
    groq_key: Optional[str] = ""
    cerebras_key: Optional[str] = ""
    openrouter_key: Optional[str] = ""
    claude_key: Optional[str] = ""


# Helper to build keys dict from request
def build_keys(req) -> dict:
    return {
        "gemini": req.gemini_key or "",
        "groq": req.groq_key or "",
        "cerebras": req.cerebras_key or "",
        "openrouter": req.openrouter_key or "",
        "claude": req.claude_key or "",
    }


# SSE helper
def sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


# Endpoints
@app.get("/")
async def root():
    with open("static/index.html", "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model_ready": MODEL_READY,
        "model_status": MODEL_STATUS,
        "model_name": "Qwen3-1.7B"
    }


@app.post("/provider-health")
async def provider_health(req: ValidateKeysRequest):
    from pipeline.jd_parser import get_health_status
    keys = build_keys(req)
    status = get_health_status(keys)
    return {"providers": status}


@app.post("/validate-keys")
async def validate_keys(req: ValidateKeysRequest):
    keys = build_keys(req)
    results = {}

    # Validate Gemini key
    if keys.get("gemini"):
        try:
            import httpx
            test_body = {
                "contents": [{"parts": [{"text": "Say OK"}]}],
                "generationConfig": {"maxOutputTokens": 5}
            }
            url = (
                "https://generativelanguage.googleapis.com"
                "/v1beta/models/gemini-2.5-flash"
                f":generateContent?key={keys['gemini']}"
            )
            async with httpx.AsyncClient() as client:
                resp = await client.post(url, json=test_body, timeout=10)
            results["gemini"] = (resp.status_code == 200)
        except Exception:
            results["gemini"] = False
    else:
        results["gemini"] = None

    # Validate OpenAI-compatible providers
    for provider, cfg in {
        "groq": {
            "url": "https://api.groq.com/openai/v1/chat/completions",
            "model": "llama-3.3-70b-versatile"
        },
        "cerebras": {
            "url": "https://api.cerebras.ai/v1/chat/completions",
            "model": "llama-3.3-70b"
        },
        "openrouter": {
            "url": "https://openrouter.ai/api/v1/chat/completions",
            "model": "meta-llama/llama-3.3-70b-instruct"
        },
    }.items():
        if keys.get(provider):
            try:
                import httpx
                test_body = {
                    "model": cfg["model"],
                    "messages": [{"role": "user", "content": "Say OK"}],
                    "max_tokens": 5
                }
                headers = {
                    "Authorization": f"Bearer {keys[provider]}",
                    "Content-Type": "application/json"
                }
                async with httpx.AsyncClient() as c:
                    resp = await c.post(
                        cfg["url"], json=test_body,
                        headers=headers, timeout=10
                    )
                results[provider] = (resp.status_code == 200)
            except Exception:
                results[provider] = False
        else:
            results[provider] = None

    # Validate Claude key
    if keys.get("claude"):
        try:
            import httpx
            test_body = {
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 5,
                "messages": [{"role": "user", "content": "Say OK"}]
            }
            headers = {
                "x-api-key": keys["claude"],
                "anthropic-version": "2023-06-01",
                "content-type": "application/json"
            }
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    "https://api.anthropic.com/v1/messages",
                    json=test_body, headers=headers, timeout=10
                )
            results["claude"] = (resp.status_code == 200)
        except Exception:
            results["claude"] = False
    else:
        results["claude"] = None

    return {"results": results}


@app.post("/generate")
async def generate_endpoint(req: GenerateRequest):

    async def event_stream():
        global MODEL_READY, MODEL_STATUS

        if not MODEL_READY:
            yield sse({
                "type": "error",
                "message": "Model still loading. Please wait and try again."
            })
            return

        keys = build_keys(req)

        try:
            from pipeline import (
                parser as p,
                jd_parser as jdp,
                matcher as m,
                tailor as t,
                scorer as s,
                renderer as r
            )
            from pipeline.inference_engine import generate_bridge_map

            yield sse({"type": "log", "level": "info",
                       "message": "Starting generation..."})

            yield sse({"type": "progress", "step": "parsing_resume",
                       "message": "Parsing your master resume...", "pct": 8})
            yield sse({"type": "log", "level": "info",
                       "message": "Parsing master resume..."})

            master = p.parse_resume(req.master_resume)

            exp_count = len(master.get('experience', []))
            skill_count = sum(
                len(v) for v in master.get('skills', {}).values()
            )
            yield sse({"type": "log", "level": "success",
                       "message": (f"Resume parsed — {exp_count} jobs, "
                                   f"{skill_count} skills found")})

            yield sse({"type": "progress", "step": "parsing_jd",
                       "message": "Analyzing job description...", "pct": 20})
            yield sse({"type": "log", "level": "info",
                       "message": "Analyzing job description..."})

            jd = await jdp.parse_jd(req.job_description, keys=keys)

            yield sse({"type": "log", "level": "success",
                       "message": (f"JD parsed — "
                                   f"{len(jd.get('required', []))} required keywords, "
                                   f"{len(jd.get('preferred', []))} preferred")})

            yield sse({"type": "progress", "step": "matching",
                       "message": "Selecting best jobs and skills...", "pct": 34})
            yield sse({"type": "log", "level": "info",
                       "message": "Matching skills and jobs..."})

            selected_jobs = m.select_jobs(master.get('experience', []), jd)
            selected_skills = m.select_skills(
                master.get('skills', {}), jd,
                experience=master.get('experience', [])
            )

            yield sse({"type": "log", "level": "success",
                       "message": (f"Selected {len(selected_jobs)} jobs, "
                                   f"{len(selected_skills)} skills")})

            # ── Semantic Inference (bridge map) ──
            yield sse({"type": "progress", "step": "inference",
                       "message": "Building semantic bridge map...", "pct": 42})
            yield sse({"type": "log", "level": "info",
                       "message": "Running semantic skill inference..."})

            bridge_map = await generate_bridge_map(jd, master, keys=keys)
            n_mappings = len(bridge_map.get("mappings", []))

            if n_mappings > 0:
                yield sse({"type": "log", "level": "success",
                           "message": f"Bridge map ready — {n_mappings} semantic proxies found"})
            else:
                yield sse({"type": "log", "level": "info",
                           "message": "No skill gaps detected — direct matches sufficient"})

            yield sse({"type": "progress", "step": "tailoring_summary",
                       "message": "Writing your summary...", "pct": 48})
            yield sse({"type": "log", "level": "info",
                       "message": "Writing summary..."})

            loop = asyncio.get_event_loop()
            summary = await loop.run_in_executor(
                None, lambda: t.tailor_summary(
                    master, jd, bridge_map=bridge_map,
                    selected_jobs=selected_jobs,
                    selected_skills=selected_skills, keys=keys
                )
            )
            yield sse({"type": "log", "level": "success",
                       "message": f"Summary written — {len(summary.split())} words"})

            total_jobs = len(selected_jobs)
            tailored_experience = []

            for i, job in enumerate(selected_jobs):
                pct = 54 + int((i / max(total_jobs, 1)) * 26)
                yield sse({"type": "progress", "step": "tailoring_job",
                           "message": f"Tailoring job {i+1} of {total_jobs}...",
                           "pct": pct})
                yield sse({"type": "log", "level": "info",
                           "message": (f"Rewriting bullets: "
                                       f"{job.get('title', '')} "
                                       f"at {job.get('company', '')}...")})

                job_copy = job  # capture for lambda
                tailored_job = await loop.run_in_executor(
                    None, lambda j=job_copy: t.tailor_job(
                        j, jd, keys=keys, bridge_map=bridge_map
                    )
                )
                tailored_experience.append(tailored_job)

                done_pct = 54 + int(((i + 1) / max(total_jobs, 1)) * 26)
                yield sse({"type": "progress", "step": "tailoring_job",
                           "message": f"Tailoring job {i+1} of {total_jobs}...",
                           "pct": done_pct})
                yield sse({"type": "log", "level": "success",
                           "message": (f"Done: {job.get('title', '')} at "
                                       f"{job.get('company', '')} — "
                                       f"{len(tailored_job['bullets'])} bullets")})

            tailored = {
                "contact":        master["contact"],
                "summary":        summary,
                "experience":     tailored_experience,
                "skills":         selected_skills,
                "education":      master.get("education", []),
                "certifications": master.get("certifications", [])
            }

            yield sse({"type": "log", "level": "success",
                       "message": f"Tailoring complete — {total_jobs} jobs rewritten"})

            yield sse({"type": "progress", "step": "scoring",
                       "message": "Scoring ATS match...", "pct": 84})
            yield sse({"type": "log", "level": "info",
                       "message": "Calculating ATS score..."})

            ats = s.score_ats(tailored, jd)

            yield sse({"type": "log", "level": "success",
                       "message": (f"ATS score: {ats['score']}% — "
                                   f"{ats['matched_keywords']} of "
                                   f"{ats['total_keywords']} keywords matched")})

            yield sse({"type": "progress", "step": "rendering",
                       "message": "Assembling your resume...", "pct": 93})
            yield sse({"type": "log", "level": "info",
                       "message": "Assembling resume HTML..."})

            html_out = r.render_resume(tailored, req.section_order)

            yield sse({"type": "log", "level": "success",
                       "message": "Resume ready"})

            yield sse({
                "type": "complete",
                "html": html_out,
                "ats": ats,
                "tailored": tailored,
                "selected_jobs": len(selected_jobs),
                "selected_skills": len(selected_skills),
                "jd_role": jd.get("role", ""),
                "jd_company": jd.get("company", ""),
            })

        except Exception as e:
            import traceback
            traceback.print_exc()
            yield sse({"type": "log", "level": "error",
                       "message": f"Error: {str(e)}"})
            yield sse({"type": "error",
                       "message": f"Generation failed: {str(e)}"})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no"
        }
    )


class RenderRequest(BaseModel):
    tailored: dict
    section_order: List[str] = [
        "summary", "skills", "experience", "education"
    ]


@app.post("/render")
async def render_endpoint(req: RenderRequest):
    from pipeline.renderer import render_resume
    html = render_resume(req.tailored, req.section_order)
    return {"html": html}


@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    filename = file.filename.lower()
    content = await file.read()
    text = ""

    if filename.endswith(('.txt', '.md')):
        text = content.decode('utf-8', errors='replace')

    elif filename.endswith('.pdf'):
        try:
            import PyPDF2
            import io
            reader = PyPDF2.PdfReader(io.BytesIO(content))
            text = '\n'.join(
                page.extract_text() or ''
                for page in reader.pages
            )
        except Exception as e:
            print(f"[Upload] PDF error: {e}")
            text = content.decode('utf-8', errors='replace')

    elif filename.endswith('.docx'):
        try:
            import docx
            import io
            doc = docx.Document(io.BytesIO(content))
            text = '\n'.join(para.text for para in doc.paragraphs)
        except Exception as e:
            print(f"[Upload] DOCX error: {e}")
            text = content.decode('utf-8', errors='replace')

    else:
        text = content.decode('utf-8', errors='replace')

    return {"text": text.strip()}


# Startup helpers
def download_spacy():
    try:
        import spacy
        spacy.load("en_core_web_sm")
        print("[Setup] spaCy model found.")
    except OSError:
        print("[Setup] Downloading spaCy model...")
        subprocess.run(
            [sys.executable, "-m", "spacy", "download", "en_core_web_sm"],
            capture_output=True
        )
        print("[Setup] spaCy model ready.")


def load_model_and_warmup():
    global MODEL_READY, MODEL_STATUS
    try:
        import pipeline.model as mdl
        mdl.warmup()
        MODEL_READY = True
        MODEL_STATUS = "ready"
        print("[ResumeGen] Model ready.")
        print("[ResumeGen] Open http://localhost:2222")
    except Exception as e:
        MODEL_STATUS = "error"
        print(f"[Model] Failed to load: {e}")
        import traceback
        traceback.print_exc()


def open_browser():
    time.sleep(2.5)
    webbrowser.open("http://localhost:2222")


if __name__ == "__main__":
    print("=" * 44)
    print("  ResumeGen · Local AI Resume Tailor")
    print("=" * 44)
    print()

    download_spacy()

    threading.Thread(target=load_model_and_warmup, daemon=True).start()
    threading.Thread(target=open_browser, daemon=True).start()

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=2222,
        log_level="warning"
    )
