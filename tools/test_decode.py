import sys, types, importlib.util, os, base64, io
import numpy as np
from PIL import Image

# Stub torch so __init__.py imports without the real dependency.
faketorch = types.ModuleType("torch")
class FT:
    def __init__(self, a): self.a = a
    def unsqueeze(self, d): return FT(np.expand_dims(self.a, d))
    @property
    def shape(self): return self.a.shape
faketorch.from_numpy = lambda a: FT(a)
sys.modules["torch"] = faketorch

# __init__.py imports folder_paths (a ComfyUI module) for the photo node;
# stub the four functions it uses so the load works outside ComfyUI.
fakefp = types.ModuleType("folder_paths")
fakefp.get_input_directory = lambda: os.path.dirname(__file__)
fakefp.filter_files_content_types = lambda files, kinds: files
fakefp.get_annotated_filepath = lambda name: name
fakefp.exists_annotated_filepath = lambda name: os.path.exists(name)
sys.modules["folder_paths"] = fakefp

NODE = os.path.join(os.path.dirname(__file__), "..", "__init__.py")
spec = importlib.util.spec_from_file_location("slnode", NODE)
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)

# Empty input -> gray fallback, correct shape.
t = mod.decode_render_b64("")
assert tuple(t.shape) == (1, 1024, 1024, 3), t.shape

# A tiny red PNG data-URI decodes to the target size.
buf = io.BytesIO()
Image.new("RGB", (4, 4), (255, 0, 0)).save(buf, format="PNG")
uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
t2 = mod.decode_render_b64(uri)
assert tuple(t2.shape) == (1, 1024, 1024, 3), t2.shape

# The browser only ever renders 512x512; anything over MAX_IMAGE_SIDE (2048)
# is a decompression bomb, not a legitimate render -> gray fallback, not decoded.
buf = io.BytesIO()
Image.new("RGB", (3000, 10), (255, 0, 0)).save(buf, format="PNG")
uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
t3 = mod.decode_render_b64(uri)
px = t3.a[0, 0, 0]
assert abs(float(px[0]) - 138 / 255) < 1e-3, f"expected gray fallback, got pixel {px}"

print("test_decode: OK")
