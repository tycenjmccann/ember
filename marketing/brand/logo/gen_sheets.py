#!/usr/bin/env python3
"""Generate 12-up simplified-logo concept sheets across image-model families."""
import os, sys, base64, concurrent.futures as cf, pathlib, traceback

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "sheets"; OUT.mkdir(exist_ok=True)
PROMPT = (HERE / "SHEET_PROMPT.md").read_text()

# load keys from the marketing genai .env files (main + grok)
for envp in ["/Users/tycenj/Desktop/Q Projects/Marketing/_shared/tools/genai/.env",
             "/Users/tycenj/Desktop/Q Projects/Marketing/_shared/tools/genai/grok/.env"]:
    ENV = pathlib.Path(envp)
    if ENV.exists():
        for line in ENV.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1); os.environ.setdefault(k, v.strip().strip('"').strip("'"))

def save_b64(b64, path):
    path.write_bytes(base64.b64decode(b64)); return str(path)

def gen_google(model_alias, model_id, out):
    from google import genai
    from google.genai.types import GenerateContentConfig, Modality, ImageConfig
    c = genai.Client(api_key=os.environ["GOOGLE_API_KEY"])
    if "imagen" in model_id:
        r = c.models.generate_images(model=model_id, prompt=PROMPT,
            config={"number_of_images": 1, "aspect_ratio": "4:3"})
        img = r.generated_images[0].image.image_bytes
        out.write_bytes(img); return str(out)
    r = c.models.generate_content(model=model_id, contents=PROMPT,
        config=GenerateContentConfig(response_modalities=[Modality.TEXT, Modality.IMAGE],
                                     image_config=ImageConfig(aspect_ratio="4:3")))
    for part in r.candidates[0].content.parts:
        if getattr(part, "inline_data", None) and part.inline_data.data:
            out.write_bytes(part.inline_data.data); return str(out)
    raise RuntimeError("no image in google response")

def gen_grok(out):
    import xai_sdk
    c = xai_sdk.Client(api_key=os.environ["XAI_API_KEY"])
    r = c.image.sample(prompt=PROMPT, model="grok-2-image", image_format="base64", aspect_ratio="4:3")
    b64 = getattr(r, "base64", None) or getattr(r, "image", None)
    if hasattr(r, "image") and hasattr(r.image, "base64"): b64 = r.image.base64
    return save_b64(b64, out)

JOBS = [
    ("google-nano-banana-pro", lambda: gen_google("pro", "gemini-3-pro-image-preview", OUT/"sheet_nano-banana-pro.png")),
    ("google-imagen4-ultra",   lambda: gen_google("imagen4-ultra", "imagen-4.0-ultra-generate-001", OUT/"sheet_imagen4-ultra.png")),
    ("google-imagen4",         lambda: gen_google("imagen4", "imagen-4.0-generate-001", OUT/"sheet_imagen4.png")),
    ("grok-2-image",           lambda: gen_grok(OUT/"sheet_grok.png")),
]

def run(name, fn):
    try:
        p = fn(); return (name, "ok", p)
    except Exception as e:
        return (name, "FAIL", f"{type(e).__name__}: {e}\n{traceback.format_exc()[-500:]}")

if __name__ == "__main__":
    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(run, n, f): n for n, f in JOBS}
        for fut in cf.as_completed(futs):
            n, status, info = fut.result()
            print(f"[{status}] {n}: {info}")
