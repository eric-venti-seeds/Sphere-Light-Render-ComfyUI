import sys, types, importlib.util, os
import numpy as np

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

# Manual node: only rotation/elevation/intensity/render_b64; no heading/location.
man = mod.SphereLightManualNode.INPUT_TYPES()["required"]
for k in ["rotation", "elevation", "intensity", "render_b64"]:
    assert k in man, f"manual missing {k}"
for k in ["heading", "location", "latitude", "longitude", "sun_mode", "location_mode"]:
    assert k not in man, f"manual should not declare {k}"

# Sun (City): date/time + intensity + heading + city + render_b64; no location/latlon.
# ("heading" and "city" are native serialization anchors that the compass/search
# DOM overlays seed from and write into; see js/nodes.js.)
city = mod.SphereLightSunCityNode.INPUT_TYPES()["required"]
for k in ["intensity", "city", "year", "month", "day", "hour", "minute", "heading", "render_b64"]:
    assert k in city, f"city missing {k}"
for k in ["location", "latitude", "longitude"]:
    assert k not in city, f"city should not declare {k}"

# Sun (Coords): lat/lon (native) + date/time + intensity + heading + render_b64; no city.
coord = mod.SphereLightSunCoordsNode.INPUT_TYPES()["required"]
for k in ["intensity", "latitude", "longitude", "year", "month", "day", "hour", "minute", "heading", "render_b64"]:
    assert k in coord, f"coords missing {k}"
for k in ["city", "location"]:
    assert k not in coord, f"coords should not declare {k}"

# Registration + display names.
for cls in ["SphereLightManualNode", "SphereLightSunCityNode", "SphereLightSunCoordsNode"]:
    assert cls in mod.NODE_CLASS_MAPPINGS, f"{cls} not registered"
assert mod.NODE_DISPLAY_NAME_MAPPINGS["SphereLightManualNode"] == "🔆 Sphere Light — Manual"
assert mod.NODE_DISPLAY_NAME_MAPPINGS["SphereLightSunCityNode"] == "🔆 Sphere Light — Sun (City)"
assert mod.NODE_DISPLAY_NAME_MAPPINGS["SphereLightSunCoordsNode"] == "🔆 Sphere Light — Sun (Coordinates)"

# execute() returns a (1,1024,1024,3) tensor for each (empty render_b64 -> gray).
(t,) = mod.SphereLightManualNode().execute(0.0, 45.0, 1.5, "")
assert tuple(t.shape) == (1, 1024, 1024, 3), t.shape
(t,) = mod.SphereLightSunCityNode().execute(1.5, "Austin, TX", 2025, 6, 21, 12, 0, 0.0, "")
assert tuple(t.shape) == (1, 1024, 1024, 3), t.shape
(t,) = mod.SphereLightSunCoordsNode().execute(1.5, 30.27, -97.74, 2025, 6, 21, 12, 0, 0.0, "")
assert tuple(t.shape) == (1, 1024, 1024, 3), t.shape

print("test_new_nodes: OK")
