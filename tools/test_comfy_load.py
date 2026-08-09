import sys, types, importlib.util, os
import numpy as np

# Reproduce ComfyUI's load_custom_node: it loads the package's __init__.py via
# spec_from_file_location + exec_module and does NOT add the node directory to
# sys.path. So __init__.py must import its sibling render_bridge in a way that
# works as a package (relative), while the other tools/*.py tests still import
# render_bridge as a top-level module (repo root on sys.path). This test guards
# the ComfyUI side: it must NOT put the repo root on sys.path.
assert os.path.abspath(os.path.join(os.path.dirname(__file__), "..")) not in [
    os.path.abspath(p) for p in sys.path
], "this test must run with the repo root OFF sys.path (that's the ComfyUI condition)"

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

# Load __init__.py exactly as ComfyUI does (package name, __init__.py path).
INIT = os.path.join(os.path.dirname(__file__), "..", "__init__.py")
name = "custom_nodes_x_Sphere_Light_Render_ComfyUI"
spec = importlib.util.spec_from_file_location(name, INIT)
mod = importlib.util.module_from_spec(spec)
sys.modules[name] = mod
spec.loader.exec_module(mod)   # must not raise ModuleNotFoundError: render_bridge

got = set(mod.NODE_CLASS_MAPPINGS)
want = {"SphereLightManualNode",
        "SphereLightSunCityNode", "SphereLightSunCoordsNode",
        "SphereLightPhotoExifNode"}
assert want == got, f"node set mismatch under ComfyUI-style load: {want ^ got}"

print("test_comfy_load: OK")
