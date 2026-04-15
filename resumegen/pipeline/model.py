from transformers import AutoModelForCausalLM, AutoTokenizer
import torch
import re
import time

MODEL_NAME = "Qwen/Qwen3-1.7B"

print(f"[Model] Loading {MODEL_NAME}...")
print("[Model] First run downloads ~1GB.")
print("[Model] Subsequent runs load from disk cache.")

tokenizer = AutoTokenizer.from_pretrained(
    MODEL_NAME,
    trust_remote_code=True
)

model = AutoModelForCausalLM.from_pretrained(
    MODEL_NAME,
    dtype=torch.float32,
    device_map="cpu",
    trust_remote_code=True,
    attn_implementation="eager"
)
model.eval()
print("[Model] Loaded successfully.")


def generate(
    prompt: str,
    system: str = "",
    max_new_tokens: int = 256,
    temperature: float = 0.3,
) -> str:
    messages = []
    if system:
        messages.append({
            "role": "system",
            "content": system
        })
    messages.append({
        "role": "user",
        "content": prompt
    })

    text = tokenizer.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=False
    )

    inputs = tokenizer([text], return_tensors="pt")

    with torch.no_grad():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            temperature=temperature,
            do_sample=temperature > 0,
            pad_token_id=tokenizer.eos_token_id,
            repetition_penalty=1.1
        )

    new_tokens = output_ids[0][
        inputs['input_ids'].shape[1]:
    ]
    response = tokenizer.decode(
        new_tokens,
        skip_special_tokens=True
    )

    # Safety net: strip thinking blocks
    response = re.sub(
        r'<think>.*?</think>',
        '',
        response,
        flags=re.DOTALL
    ).strip()

    # Strip markdown formatting characters defensively
    response = re.sub(r'\*\*(.+?)\*\*', r'\1', response)
    response = re.sub(r'\*(.+?)\*', r'\1', response)
    response = re.sub(
        r'^#{1,6}\s+', '',
        response,
        flags=re.MULTILINE
    )

    # Strip input echo if model repeats prompt
    if len(prompt) > 50:
        prompt_start = prompt[:50].lower()
        if response.lower().startswith(prompt_start):
            response = response[len(prompt):].strip()

    return response.strip()


def warmup():
    print("[Model] Running warmup call...")
    t = time.time()
    generate(
        "Say the word ready.",
        system="You are a helpful assistant.",
        max_new_tokens=5
    )
    print(f"[Model] Warmed up in {time.time()-t:.1f}s.")
