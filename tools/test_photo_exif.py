import sys, types, importlib.util, os, tempfile
import numpy as np

# Same fake-torch shim as test_comfy_load.py: enough for from_numpy().unsqueeze().
faketorch = types.ModuleType("torch")
class FT:
    def __init__(self, a): self.a = a
    def unsqueeze(self, d): return FT(np.expand_dims(self.a, d))
    @property
    def shape(self): return self.a.shape
faketorch.from_numpy = lambda a: FT(a)
sys.modules["torch"] = faketorch

# Stub folder_paths around a temp input directory holding one real image.
from PIL import Image
tmp = tempfile.mkdtemp()
Image.new("RGB", (32, 16), (10, 20, 30)).save(os.path.join(tmp, "photo.png"))

fakefp = types.ModuleType("folder_paths")
fakefp.get_input_directory = lambda: tmp
fakefp.filter_files_content_types = lambda files, kinds: files
fakefp.get_annotated_filepath = lambda name: os.path.join(tmp, name)
fakefp.exists_annotated_filepath = lambda name: os.path.exists(os.path.join(tmp, name))
sys.modules["folder_paths"] = fakefp

INIT = os.path.join(os.path.dirname(__file__), "..", "__init__.py")
spec = importlib.util.spec_from_file_location("sphere_light_photo_test", INIT)
mod = importlib.util.module_from_spec(spec)
sys.modules["sphere_light_photo_test"] = mod
spec.loader.exec_module(mod)

cls = mod.NODE_CLASS_MAPPINGS["SphereLightPhotoExifNode"]

# The upload combo lists the input directory.
files = cls.INPUT_TYPES()["required"]["image"][0]
assert "photo.png" in files, files

# execute(): loads the file as a (1,H,W,3) float tensor and passes the nine
# EXIF-derived widget values straight through (heading LAST — it mirrors the
# Sun nodes' input order so parallel wires don't cross).
out = cls().execute("photo.png", 48.8582, 2.2945, "Paris, Île-de-France",
                    2023, 6, 21, 14, 30, 214.5)
assert out[0].shape == (1, 16, 32, 3), out[0].shape
assert out[1:] == (48.8582, 2.2945, "Paris, Île-de-France", 2023, 6, 21, 14, 30, 214.5)
assert cls.RETURN_NAMES[-1] == "heading", cls.RETURN_NAMES

# The widget names the browser fills must exactly match the Sun nodes' input
# names — that name equality is what makes graph-driving work.
req = cls.INPUT_TYPES()["required"]
for name in ("latitude", "longitude", "city", "heading",
             "year", "month", "day", "hour", "minute"):
    assert name in req, f"missing widget: {name}"
assert list(req)[-1] == "heading", list(req)

assert cls.VALIDATE_INPUTS("photo.png") is True
assert cls.VALIDATE_INPUTS("missing.png") != True

# IS_CHANGED: stable across calls, changes with file content.
h1 = cls.IS_CHANGED("photo.png")
assert isinstance(h1, str) and h1 == cls.IS_CHANGED("photo.png")
Image.new("RGB", (32, 16), (99, 99, 99)).save(os.path.join(tmp, "photo.png"))
assert cls.IS_CHANGED("photo.png") != h1

print("test_photo_exif: OK")
