import os
import sys
import re
import json
import time
import shutil
import fnmatch
import datetime
import subprocess
from pathlib import Path

# ── CONFIGURATION ────────────────────────────────────────────────────────────
GEMINI_MODEL        = "gemini-3-flash-preview"
SCREENSHOTS_DIR     = "screenshots"
SENT_SCREENSHOTS_DIR = "screenshots/sent"
MAX_RETRIES         = 3
RETRY_CAP           = 120
MAX_FILE_BYTES      = 300 * 1024  # 300KB
INCLUDE_EXTENSIONS  = {".js", ".html", ".css", ".json", ".md", ".py", ".ts"}
ALWAYS_EXCLUDE      = {".git", "node_modules", "__pycache__", "dist", ".env",
                       "sentinel.py", "CLAUDE.md", "screenshots"}
IMAGE_EXTENSIONS    = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

API_KEY = os.environ.get("GEMINI_API_KEY", "")
if not API_KEY:
    print("ERROR: GEMINI_API_KEY environment variable is not set.")
    print()
    print("To set it, run this in PowerShell:")
    print('  [System.Environment]::SetEnvironmentVariable("GEMINI_API_KEY", "your-key-here", "User")')
    print()
    print("Then restart your terminal and run sentinel.py again.")
    sys.exit(1)

try:
    from google import genai
    from google.genai import types as genai_types
except ImportError:
    print("ERROR: google-genai SDK not installed.")
    print("Run: pip install google-genai")
    sys.exit(1)

# ── IGNORE PATTERNS ───────────────────────────────────────────────────────────
def load_ignore_patterns():
    patterns = []
    ignore_file = Path(".sentinel_ignore")
    if ignore_file.exists():
        for line in ignore_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                patterns.append(line)
    return patterns

def is_ignored(rel_path_str, patterns):
    parts = Path(rel_path_str).parts
    for pattern in patterns:
        if fnmatch.fnmatch(rel_path_str, pattern):
            return True
        if fnmatch.fnmatch(rel_path_str, f"**/{pattern}"):
            return True
        for part in parts:
            if fnmatch.fnmatch(part, pattern):
                return True
    return False

def is_always_excluded(rel_path_str):
    parts = Path(rel_path_str).parts
    for part in parts:
        if part in ALWAYS_EXCLUDE:
            return True
    return False

# ── REPO SNAPSHOT ─────────────────────────────────────────────────────────────
def build_snapshot():
    repo_root = Path(".")
    repo_name = repo_root.resolve().name
    timestamp = datetime.datetime.utcnow().isoformat() + "Z"
    ignore_patterns = load_ignore_patterns()

    file_blocks = []
    for path in sorted(repo_root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(repo_root)
        rel_str = str(rel).replace("\\", "/")

        if is_always_excluded(rel_str):
            continue
        if is_ignored(rel_str, ignore_patterns):
            continue
        if path.suffix not in INCLUDE_EXTENSIONS:
            continue
        if path.stat().st_size > MAX_FILE_BYTES:
            continue

        try:
            content = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue

        lines = content.count("\n") + 1
        file_blocks.append(
            f'<file path="{rel_str}" lines="{lines}">\n{content}\n</file>'
        )

    snapshot = (
        f'<codebase repo="{repo_name}" snapshot="{timestamp}">\n'
        + "\n".join(file_blocks)
        + "\n</codebase>"
    )
    return snapshot, len(file_blocks)

# ── GEMINI CALL ───────────────────────────────────────────────────────────────
def call_gemini(chat, message, images=None):
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            if images:
                parts = [genai_types.Part.from_text(text=message)]
                for img_data, mime_type in images:
                    parts.append(
                        genai_types.Part.from_bytes(data=img_data, mime_type=mime_type)
                    )
                response = chat.send_message(parts)
            else:
                response = chat.send_message(message)
            return response.text
        except Exception as e:
            err = str(e)
            if "429" in err:
                retry_match = re.search(r"(\d+)\s*second", err, re.IGNORECASE)
                wait = int(retry_match.group(1)) if retry_match else 30
                wait = min(wait + 5, RETRY_CAP)
                if attempt < MAX_RETRIES:
                    print(f"  Rate limited. Retrying in {wait}s (attempt {attempt}/{MAX_RETRIES})...")
                    time.sleep(wait)
                    continue
            print(f"\nGemini error: {err}")
            choice = input("Retry? (y/n): ").strip().lower()
            if choice == "y":
                attempt -= 1
                continue
            return None
    return None

# ── CLAUDE CALL ───────────────────────────────────────────────────────────────
def call_claude(prompt, allowed_tools, retries=1):
    for attempt in range(retries + 1):
        try:
            result = subprocess.run(
                ["claude", "-p", prompt,
                 "--allowedTools", allowed_tools,
                 "--output-format", "json"],
                capture_output=True, text=True, encoding="utf-8"
            )
            if result.returncode != 0:
                print(f"\nClaude exited with code {result.returncode}")
                if result.stderr:
                    print(result.stderr[:500])
                if attempt < retries:
                    choice = input("Retry? (y/n): ").strip().lower()
                    if choice == "y":
                        continue
                return None

            raw = result.stdout.strip()
            try:
                data = json.loads(raw)
                # claude --output-format json returns {"result": "...", ...}
                text = data.get("result") or data.get("text") or data.get("content") or ""
                if isinstance(text, list):
                    # content blocks
                    text = " ".join(
                        block.get("text", "") for block in text
                        if isinstance(block, dict) and block.get("type") == "text"
                    )
                return text.strip()
            except json.JSONDecodeError:
                # Fallback: return raw stdout
                return raw
        except FileNotFoundError:
            print("ERROR: 'claude' command not found. Is Claude Code CLI installed?")
            return None
        except Exception as e:
            print(f"Claude call error: {e}")
            return None
    return None

# ── SCREENSHOTS ───────────────────────────────────────────────────────────────
def collect_screenshots():
    folder = Path(SCREENSHOTS_DIR)
    folder.mkdir(exist_ok=True)
    images = []
    for f in sorted(folder.iterdir()):
        if f.is_file() and f.suffix.lower() in IMAGE_EXTENSIONS:
            data = f.read_bytes()
            ext = f.suffix.lower()
            mime_map = {
                ".png": "image/png", ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg", ".webp": "image/webp",
                ".gif": "image/gif"
            }
            images.append((data, mime_map.get(ext, "image/png"), f.name))
    return images

def archive_screenshots():
    folder = Path(SCREENSHOTS_DIR)
    sent = Path(SENT_SCREENSHOTS_DIR)
    sent.mkdir(parents=True, exist_ok=True)
    ts = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%S")
    for f in list(folder.iterdir()):
        if f.is_file() and f.suffix.lower() in IMAGE_EXTENSIONS:
            dest = sent / f"{ts}_{f.name}"
            shutil.move(str(f), str(dest))

# ── DIFF COMPRESSION ──────────────────────────────────────────────────────────
def compress_diff(diff_text):
    files_changed = []
    additions = 0
    removals = 0
    mutations = []

    current_file = None
    for line in diff_text.splitlines():
        if line.startswith("+++ "):
            name = line[4:].strip()
            if name.startswith("b/"):
                name = name[2:]
            current_file = name
            if name not in files_changed:
                files_changed.append(name)
        elif line.startswith("--- "):
            name = line[4:].strip()
            if name.startswith("a/"):
                name = name[2:]
            if name != "/dev/null" and name not in files_changed:
                files_changed.append(name)
        elif line.startswith("+") and not line.startswith("+++"):
            additions += 1
            if len(mutations) < 100:
                mutations.append({"file": current_file, "op": "add", "content": line[1:].rstrip()})
        elif line.startswith("-") and not line.startswith("---"):
            removals += 1
            if len(mutations) < 100:
                mutations.append({"file": current_file, "op": "remove", "content": line[1:].rstrip()})

    return {
        "files_changed": files_changed,
        "additions": additions,
        "removals": removals,
        "mutations": mutations
    }

# ── MAIN ──────────────────────────────────────────────────────────────────────
def main():
    print()
    print("=" * 42)
    print("  SENTINEL -- Project Orchestrator")
    print("=" * 42)
    print()

    # Verify Claude CLI
    try:
        v = subprocess.run(["claude", "--version"], capture_output=True, text=True)
        if v.returncode != 0:
            raise RuntimeError("non-zero exit")
    except Exception:
        print("ERROR: Claude Code CLI not found or not working.")
        print("Install it from: https://claude.ai/code")
        sys.exit(1)

    # Ensure screenshots dir exists
    Path(SCREENSHOTS_DIR).mkdir(exist_ok=True)
    Path(SENT_SCREENSHOTS_DIR).mkdir(parents=True, exist_ok=True)

    print("Scanning repository...")
    snapshot, file_count = build_snapshot()
    print(f"  {file_count} files indexed.")
    print()

    # Create Gemini client and chat
    client = genai.Client(api_key=API_KEY)
    chat = client.chats.create(model=GEMINI_MODEL)

    # Send initial context
    init_message = (
        "You are the Architect for Project Sentinel. You have deep expertise in "
        "JavaScript, HTML, and CSS. You will help plan and verify coding "
        "tasks on this repository.\n\n"
        "Here is the complete codebase. Study it thoroughly — you will not receive "
        "it again this session. All future messages will reference this code by file "
        "path and line number.\n\n"
        f"{snapshot}\n\n"
        "When you are ready, respond with only:\n"
        "READY — [N] files indexed"
    )

    print("Sending codebase to Gemini...")
    ready_response = call_gemini(chat, init_message)
    if not ready_response:
        print("ERROR: Failed to initialize Gemini session.")
        sys.exit(1)

    print(f"Gemini ready. {ready_response.strip()}")
    print("Type a task to begin. Use -s flag to attach screenshots.")
    print("-" * 50)
    print()

    # ── TASK LOOP ────────────────────────────────────────────────────────────
    while True:
        # STEP 0 — Accept input
        try:
            raw_input = input("sentinel > ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nSession ended.")
            break

        if not raw_input:
            continue
        if raw_input.lower() in ("exit", "quit"):
            print("Session ended.")
            break

        # Parse -s flag
        use_screenshots = False
        task = raw_input
        if raw_input.startswith("-s "):
            use_screenshots = True
            task = raw_input[3:].strip()
        elif raw_input == "-s":
            use_screenshots = True
            task = ""

        if not task:
            task = input("Task description: ").strip()
            if not task:
                continue

        print()

        # STEP 1 — Collect screenshots
        screenshot_parts = []
        if use_screenshots:
            images = collect_screenshots()
            if not images:
                print("  No screenshots found in screenshots/ folder.")
                input("  Add images there, then press Enter to continue...")
                images = collect_screenshots()

            if images:
                screenshot_parts = [(data, mime) for data, mime, _ in images]
                print(f"  Attaching {len(screenshot_parts)} screenshot(s) to this task.")
                print()

        # STEP 2 — Gemini plans
        print("Gemini planning...")
        screenshot_note = ""
        if screenshot_parts:
            screenshot_note = (
                f"\nI have attached {len(screenshot_parts)} screenshot(s) showing "
                "the current state of the app for visual context.\n"
            )

        plan_prompt = (
            f"TASK: {task}\n"
            f"{screenshot_note}\n"
            "Produce a structured implementation plan using EXACTLY this format — no exceptions:\n\n"
            "PLAN\n"
            "────\n"
            "Intent: [one sentence summary of what will change]\n\n"
            "Change 1:\n"
            "  File: [exact relative file path]\n"
            "  Location: [function name or line range e.g. lines 45-67]\n"
            "  What: [what needs to change and why, 2-3 sentences max]\n"
            "  Code:\n"
            "```[language]\n"
            "  [exact code to add or replace — not pseudocode]\n"
            "```\n\n"
            "Change 2:\n"
            "  [same structure]\n\n"
            "Risk: [any dependencies, side effects, or things Claude should be careful about]\n\n"
            "If the task is already implemented, respond:\n"
            "ALREADY_DONE: [explanation]\n\n"
            "If the task is unclear or impossible given the codebase:\n"
            "BLOCKED: [explanation]"
        )

        plan_response = call_gemini(chat, plan_prompt, images=screenshot_parts if screenshot_parts else None)
        if not plan_response:
            print("  Gemini did not respond. Skipping task.")
            print()
            continue

        upper = plan_response.upper()
        if upper.strip().startswith("ALREADY_DONE"):
            print(f"\n{plan_response}\n")
            continue
        if upper.strip().startswith("BLOCKED"):
            print(f"\n{plan_response}\n")
            continue

        active_plan = plan_response
        print(f"\n{active_plan}\n")

        # STEP 3 — Claude reviews the plan
        print("Claude reviewing plan...")
        review_prompt = (
            "SENTINEL — PLAN REVIEW MODE\n\n"
            "You are reviewing a plan before any code is written.\n"
            "Do not implement anything. Do not read any files.\n"
            "Your only job is to assess whether this plan is correct and complete "
            "given your knowledge of this codebase.\n\n"
            f"PLAN TO REVIEW:\n{active_plan}\n\n"
            "Respond using EXACTLY this format:\n\n"
            "REVIEW\n"
            "──────\n"
            "Verdict: APPROVED / CONCERNS / BLOCKED\n\n"
            "[If APPROVED]:\n"
            "Confirmed: [one sentence — why this plan is solid]\n\n"
            "[If CONCERNS]:\n"
            "Issue 1: [specific concern with file/function reference]\n"
            "Issue 2: [if any]\n"
            "Suggestion: [what Gemini should reconsider]\n\n"
            "[If BLOCKED]:\n"
            "Blocker: [what makes this plan impossible to execute]"
        )

        review_response = call_claude(review_prompt, "Read")
        if review_response:
            print(f"\n{review_response}\n")
        else:
            print("  Claude review unavailable. Proceeding with plan as-is.")
            review_response = "REVIEW\n──────\nVerdict: APPROVED\nConfirmed: Review unavailable, proceeding."

        # STEP 4 — Handle verdict
        review_upper = (review_response or "").upper()
        verdict = "APPROVED"
        if "VERDICT: CONCERNS" in review_upper:
            verdict = "CONCERNS"
        elif "VERDICT: BLOCKED" in review_upper:
            verdict = "BLOCKED"

        if verdict in ("CONCERNS", "BLOCKED"):
            print("Sending Claude's review to Gemini for revision...")
            revision_prompt = (
                f"Claude reviewed your plan and raised the following:\n{review_response}\n\n"
                "Please revise the plan addressing these concerns, or explain why the original "
                "plan is still correct.\nUse the same PLAN format as before."
            )
            revised = call_gemini(chat, revision_prompt)
            if revised:
                active_plan = revised
                print(f"Gemini revised the plan.\n\n{active_plan}\n")
            else:
                print("  Gemini did not revise. Proceeding with original plan.")

        # STEP 5 — User approval
        print("-" * 50)
        print(f"\nActive plan:\n{active_plan}\n")
        print("-" * 50)
        choice = input("Proceed with these changes? (y/n/skip): ").strip().lower()
        print()

        if choice == "skip":
            continue
        if choice != "y":
            print("Task cancelled.\n")
            continue

        # STEP 6 — Claude executes
        print("Claude is implementing...")
        exec_prompt = (
            "SENTINEL — EXECUTION MODE\n\n"
            "ZERO EXPLORATION MODE IS ACTIVE.\n"
            "Rules:\n"
            "- Do NOT use Read on any file not explicitly listed below\n"
            "- Do NOT use Glob, Grep, or any search tool\n"
            "- Do NOT explore the repository\n"
            "- Trust the plan completely\n"
            "- Implement exactly what is specified, nothing more\n\n"
            f"PLAN TO IMPLEMENT:\n{active_plan}\n\n"
            "When complete, output only:\n"
            "DONE: [comma separated list of files you modified]"
        )

        exec_response = call_claude(exec_prompt, "Edit,Write,Bash")
        if exec_response:
            # Extract DONE line
            done_match = re.search(r"DONE:\s*(.+)", exec_response, re.IGNORECASE)
            if done_match:
                print(f"Done. Files modified: {done_match.group(1).strip()}\n")
            else:
                print("Done. (No file list returned)\n")
        else:
            print("  Claude did not complete execution. Skipping commit.\n")
            continue

        # STEP 7 — Capture and compress diff
        try:
            diff_result = subprocess.run(
                ["git", "diff", "HEAD"], capture_output=True, text=True, encoding="utf-8"
            )
            diff_text = diff_result.stdout
        except Exception as e:
            print(f"  git diff failed: {e}")
            diff_text = ""

        if not diff_text.strip():
            print("  Warning: No changes detected in git diff.")
            cont = input("  Continue anyway? (y/n): ").strip().lower()
            if cont != "y":
                print()
                continue

        compressed = compress_diff(diff_text)
        diff_summary = json.dumps(compressed, indent=2)

        # STEP 8 — Gemini verifies
        print("Gemini verifying...")
        verify_prompt = (
            "Claude has completed the implementation. Here is what actually changed:\n\n"
            f"{diff_summary}\n\n"
            "Verify this against the original plan intent.\n\n"
            "Respond with EXACTLY one of:\n\n"
            "PASS\n"
            "Confirmed: [what was correctly implemented]\n\n"
            "ACTION\n"
            "Issue: [specific problem]\n"
            "Fix: [exact file, location, and what needs to change]\n\n"
            "MANUAL\n"
            "Reason: [why human intervention is needed]"
        )

        verify_response = call_gemini(chat, verify_prompt)
        if not verify_response:
            print("  Gemini verification unavailable. Not committing.\n")
            continue

        verify_upper = verify_response.upper().strip()

        if verify_upper.startswith("PASS"):
            print(f"\n{verify_response}\n")
            # Commit
            try:
                short_task = task[:60]
                subprocess.run(["git", "add", "-A"], check=True)
                subprocess.run(
                    ["git", "commit", "-m", f"sentinel: {short_task}"],
                    check=True
                )
                subprocess.run(["git", "push"], check=True)
                print("Committed and pushed. Task complete.\n")
            except subprocess.CalledProcessError as e:
                print(f"  Git commit failed: {e}\n")

            if use_screenshots and screenshot_parts:
                archive_screenshots()

        elif verify_upper.startswith("ACTION"):
            print(f"\n{verify_response}\n")
            retry = input("Auto-retry? (y/n): ").strip().lower()
            if retry == "y":
                # Append fix to active plan and go back to execution
                fix_match = re.search(r"Fix:\s*(.+?)(?=\n[A-Z]|\Z)", verify_response, re.DOTALL | re.IGNORECASE)
                fix_text = fix_match.group(1).strip() if fix_match else verify_response
                active_plan = active_plan + f"\n\nADDITIONAL FIX REQUIRED:\n{fix_text}"

                print("Re-running Claude with fix appended...")
                exec_prompt2 = (
                    "SENTINEL — EXECUTION MODE\n\n"
                    "ZERO EXPLORATION MODE IS ACTIVE.\n"
                    "Rules:\n"
                    "- Do NOT use Read on any file not explicitly listed below\n"
                    "- Do NOT use Glob, Grep, or any search tool\n"
                    "- Do NOT explore the repository\n"
                    "- Trust the plan completely\n"
                    "- Implement exactly what is specified, nothing more\n\n"
                    f"PLAN TO IMPLEMENT:\n{active_plan}\n\n"
                    "When complete, output only:\n"
                    "DONE: [comma separated list of files you modified]"
                )
                exec_response2 = call_claude(exec_prompt2, "Edit,Write,Bash")
                if exec_response2:
                    done_match2 = re.search(r"DONE:\s*(.+)", exec_response2, re.IGNORECASE)
                    if done_match2:
                        print(f"Retry done. Files modified: {done_match2.group(1).strip()}\n")
                    else:
                        print(f"Retry done. Response: {exec_response2[:200]}\n")
                else:
                    print("  Retry failed.\n")
                    continue

                # Ask user to verify edits before re-running Gemini
                print("-" * 50)
                confirm = input("Review the edits in your editor. Do they look correct? (y/n): ").strip().lower()
                print()
                if confirm != "y":
                    print("Skipping commit. Fix manually and restart sentinel.\n")
                    continue

                # Re-capture diff and re-run Gemini verification
                try:
                    diff_result2 = subprocess.run(
                        ["git", "diff", "HEAD"], capture_output=True, text=True, encoding="utf-8"
                    )
                    diff_text2 = diff_result2.stdout
                except Exception as e:
                    print(f"  git diff failed: {e}")
                    diff_text2 = ""

                if not diff_text2.strip():
                    print("  Warning: No changes detected in git diff.")
                    cont2 = input("  Continue anyway? (y/n): ").strip().lower()
                    if cont2 != "y":
                        print()
                        continue

                compressed2 = compress_diff(diff_text2)
                diff_summary2 = json.dumps(compressed2, indent=2)

                print("Gemini re-verifying...")
                verify_prompt2 = (
                    "Claude has completed the retry implementation. Here is what actually changed:\n\n"
                    f"{diff_summary2}\n\n"
                    "Verify this against the original plan intent.\n\n"
                    "Respond with EXACTLY one of:\n\n"
                    "PASS\n"
                    "Confirmed: [what was correctly implemented]\n\n"
                    "ACTION\n"
                    "Issue: [specific problem]\n"
                    "Fix: [exact file, location, and what needs to change]\n\n"
                    "MANUAL\n"
                    "Reason: [why human intervention is needed]"
                )

                verify_response2 = call_gemini(chat, verify_prompt2)
                if not verify_response2:
                    print("  Gemini re-verification unavailable. Not committing.\n")
                    continue

                print(f"\n{verify_response2}\n")
                verify_upper2 = verify_response2.upper().strip()

                if verify_upper2.startswith("PASS"):
                    try:
                        short_task = task[:60]
                        subprocess.run(["git", "add", "-A"], check=True)
                        subprocess.run(
                            ["git", "commit", "-m", f"sentinel: {short_task}"],
                            check=True
                        )
                        subprocess.run(["git", "push"], check=True)
                        print("Committed and pushed. Task complete.\n")
                    except subprocess.CalledProcessError as e:
                        print(f"  Git commit failed: {e}\n")

                    if use_screenshots and screenshot_parts:
                        archive_screenshots()
                else:
                    print("Gemini still not satisfied. Fix manually and restart sentinel.\n")
            else:
                print("Skipping commit.\n")

        elif verify_upper.startswith("MANUAL"):
            print()
            print("=" * 42)
            print("  MANUAL INTERVENTION REQUIRED")
            print("=" * 42)
            print()
            print(verify_response)
            print()
            print("Fix the issue manually, then restart sentinel.")
            break

        else:
            print(f"\nGemini response:\n{verify_response}\n")

if __name__ == "__main__":
    main()
