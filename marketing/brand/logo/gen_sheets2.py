#!/usr/bin/env python3
"""Round 2: charred-log-with-terminal-end sheets, seeded with the reference image."""
import os, base64, concurrent.futures as cf, pathlib, traceback

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "sheets"; OUT.mkdir(exist_ok=True)
PROMPT = (HERE / "SHEET_PROMPT2.md").read_text()
REF = HERE / "sheets" / "_ref_log.png"

for envp in ["/Users/tycenj/Desktop/Q Projects/Marketing/_shared/tools/genai/.env",
             "/Users/tycenj/Desktop/Q Projects/Marketing/_shared/tools/genai/grok/.env"]:
    p = pathlib.Path(envp)
    if p.exists():
        for line in p.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1); os.environ.setdefault(k, v.strip().strip('"').strip("'"))

def gen_google_ref(model_id, out):
    """nano-banana-pro / gemini image: send ref image + prompt (img2img-ish)."""
    from google import genai
    from google.genai.types import GenerateContentConfig, Modality, ImageConfig, Part
    c = genai.Client(api_key=os.environ["GOOGLE_API_KEY"])
    ref_bytes = REF.read_bytes()
    parts = [Part.from_bytes(data=ref_bytes, mime_type="image/png"),
             Part(text="Use this as the base log shape/style reference.\n\n" + PROMPT)]
    r = c.models.generate_content(model=model_id, contents=parts,
        config=GenerateContentConfig(response_modalities=[Modality.TEXT, Modality.IMAGE],
                                     image_config=ImageConfig(aspect_ratio="4:3")))
    for part in r.candidates[0].content.parts:
        if getattr(part, "inline_data", None) and part.inline_data.data:
            out.write_bytes(part.inline_data.data); return str(out)
    raise RuntimeError("no image in google response")

def gen_imagen(model_id, out):
    from google import genai
    c = genai.Client(api_key=os.environ["GOOGLE_API_KEY"])
    r = c.models.generate_images(model=model_id, prompt=PROMPT,
        config={"number_of_images": 1, "aspect_ratio": "4:3"})
    out.write_bytes(r.generated_images[0].image.image_bytes); return str(out)

def gen_grok(out):
    import xai_sdk
    c = xai_sdk.Client(api_key=os.environ["XAI_API_KEY"])
    # grok image is text->image; attach intent in prompt (no img2img on this model)
    r = c.image.sample(prompt=PROMPT, model="grok-2-image", image_format="base64", aspect_ratio="4:3")
    b64 = r.image.base64 if hasattr(getattr(r, "image", None), "base64") else getattr(r, "base64", None)
    out.write_bytes(base64.b64decode(b64)); return str(out)

JOBS = [
    ("google-nano-banana-pro-ref", lambda: gen_google_ref("gemini-3-pro-image-preview", OUT/"r2_nano-banana-pro.png")),
    ("google-nano-banana-flash-ref", lambda: gen_google_ref("gemini-2.5-flash-image-preview", OUT/"r2_nano-flash.png")),
    ("google-imagen4-ultra", lambda: gen_imagen("imagen-4.0-ultra-generate-001", OUT/"r2_imagen4-ultra.png")),
    ("grok-2-image", lambda: gen_grok(OUT/"r2_grok.png")),
]

def run(n, f):
    try: return (n, "ok", f())
    except Exception as e: return (n, "FAIL", f"{type(e).__name__}: {str(e)[:160]}")

if __name__ == "__main__":
    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        for fut in cf.as_completed({ex.submit(run, n, f): n for n, f in JOBS}):
            n, s, i = fut.result(); print(f"[{s}] {n}: {i}")
